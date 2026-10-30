import type { ConfigService } from '@nestjs/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenants } from '@lms/db';
import { spaceRegistry } from '@lms/db/control-plane';
import type { Database } from '../../../src/db/database';
import { relations } from '../../../src/db/relations';
import { SpaceRoutingError } from '../../../src/db/routing/space-connection-resolver';
import { emitSpaceRegistryChanged } from '../../../src/db/routing/space-routing-events';
import { SpaceDatabaseService } from '../../../src/db/routing/space-database.service';
import { TenantAwarePool } from '../../../src/db/tenant-pool';
import { ControlPlaneConnection } from '../../../src/modules/control-plane/control-plane.connection';
import { tenantAls } from '../../../src/modules/tenants/tenant-als';

/**
 * Ca tích hợp của KHUNG ĐỊNH TUYẾN KẾT NỐI THEO TRUNG TÂM (issue
 * #581): bộ phân giải đích đọc sổ đăng ký thật, trình quản lý pool
 * theo database và handle định tuyến mà nhà cung cấp kết nối của
 * API phơi cho mọi điểm inject.
 *
 * Môi trường của ca tự cấp phát trên cùng cụm với database nghiệp
 * vụ test, toàn bộ bằng TÊN MỚI của riêng đợt này: một database
 * control plane (`lms_test_cp_581`) với role riêng, HAI database
 * kho riêng (`lms_test_centre_a_581`, `lms_test_centre_b_581`) —
 * mỗi kho có ĐÚNG MỘT role ứng dụng riêng, CONNECT của PUBLIC bị
 * thu hồi và chỉ cấp lại cho role của kho đó, baseline nghiệp vụ
 * được áp vào từng kho bằng chính role chủ kho như đường triển
 * khai thật. Hai dòng đăng ký kho riêng trong sổ trỏ bí mật qua
 * biến môi trường mà chuỗi kết nối của chúng cố ý trỏ về database
 * mặc định `postgres` — đích cuối phải do SỔ chốt (databaseName),
 * không do chuỗi bí mật. Dòng đăng ký thứ ba giữ Trang chính ở chế
 * độ kho chung, trỏ về chính database nghiệp vụ test.
 *
 * Các ca khoá đúng năm tiêu chí nghiệm thu của issue: cùng một
 * thao tác nghiệp vụ dưới ngữ cảnh hai trung tâm ghi/đọc ở hai kho
 * khác nhau (kiểm chứng trực tiếp trong từng kho); kết nối vào kho
 * của trung tâm dùng đúng role của kho đó, role của kho kia bị từ
 * chối ngay ở bước mở kết nối; pool của kho không còn traffic bị
 * đóng và tổng kết nối không vượt trần cấu hình; trung tâm ở kho
 * chung giữ nguyên hành vi hiện tại (đúng handle kho chung); đệm
 * phân giải mất hiệu lực ngay khi sổ đổi và có sự kiện phát ra.
 *
 * Vòng sửa của PR (theo phán quyết điều phối trên PR) thêm hai ca
 * hồi quy cho hai khuyết tật định tuyến đã được phân xử xác nhận:
 * (1) trung tâm kho riêng ĐÃ chuẩn bị mà pool bị đóng vì nhàn rỗi
 * thì truy vấn qua handle định tuyến trong ngữ cảnh còn mang slug
 * phải bị từ chối (fail-closed), không được rơi im lặng về kho
 * chung — ca dựng đúng hình: chuẩn bị, ép pool đóng, rồi vẫn giữ
 * ngữ cảnh cũ mà truy vấn/ghi; (2) sổ đổi role/bí mật của một kho
 * SAU khi pool đã tạo thì lần lấy handle kế tiếp phải kết nối
 * bằng role mới — ca cần thêm một role thứ hai của kho A
 * (`lms_centre_a2_581_app`, có CONNECT vào kho A như một role của
 * kho thật được cấp phát) để làm đích đổi sổ.
 *
 * Shim `uuidv7()` chỉ áp khi server PostgreSQL dưới 18 (môi trường
 * chạy local bằng PG16): PG18 — bản ở CI và production — có sẵn
 * hàm này, shim sẽ che mất hàm gốc nên tuyệt đối không áp ở đó.
 */
const CP_DATABASE = 'lms_test_cp_581';
const CP_ROLE = 'lms_cp_test_581';
const CP_PASSWORD = 'cp-test-581';
const CENTRE_A_DATABASE = 'lms_test_centre_a_581';
const CENTRE_A_ROLE = 'lms_centre_a_581_app';
const CENTRE_A_PASSWORD = 'centre-a-581';
const CENTRE_B_DATABASE = 'lms_test_centre_b_581';
const CENTRE_B_ROLE = 'lms_centre_b_581_app';
const CENTRE_B_PASSWORD = 'centre-b-581';
const CENTRE_A_SLUG = 'trung-tam-a-581';
const CENTRE_B_SLUG = 'trung-tam-b-581';
const SHARED_SLUG = 'trang-chinh';
const TENANT_A_ID = '01958100-0000-7000-8000-0000000000a1';
const TENANT_B_ID = '01958100-0000-7000-8000-0000000000b2';
const SHARED_TENANT_ID = '01958100-0000-7000-8000-0000000000c3';
/** Role thứ hai của kho A — đích đổi sổ của ca hồi quy xoay role/bí mật sau khi pool đã tạo. */
const CENTRE_A2_ROLE = 'lms_centre_a2_581_app';
const CENTRE_A2_PASSWORD = 'centre-a2-581';
/** Id của dòng ghi mà ca hồi quy bị-thu-hồi cố ý ghi qua handle định tuyến: dòng này không được phép xuất hiện ở bất kỳ kho nào. */
const REVOKED_MARKER_ID = '01958100-0000-7000-8000-0000000000f6';
/** Trần kết nối mỗi pool kho riêng trong ca này — nhỏ để ca trần kiểm được bằng số kết nối thật. */
const POOL_MAX = 2;
/** Ngưỡng nhàn rỗi trong ca này — nhỏ để ca đóng pool không phải chờ theo mặc định 60 giây. */
const POOL_IDLE_TIMEOUT_MS = 600;

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/** Dựng URL kết nối tới một database trên cùng cụm với database nghiệp vụ test. */
function clusterUrl(database: string, username?: string, secret?: string): string {
  const base = new URL(process.env.DATABASE_URL!);
  base.pathname = `/${database}`;
  if (username) base.username = username;
  if (secret) base.password = secret;
  return base.toString();
}

/** Bọc một định danh Postgres trong dấu nháy kép cho các câu lệnh quản trị của ca test. */
function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Áp một file migration SQL (tách theo dấu phân đoạn của Drizzle) lên một database qua kết nối cho trước. */
async function applySqlFile(connectionString: string, filePath: string, withUuidShim: boolean): Promise<void> {
  await withClient(connectionString, async (client) => {
    if (withUuidShim) {
      const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
      if (Number(version.rows[0]!.server_version_num) < 180000) {
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query(UUIDV7_SHIM);
      }
    }
    const sql = readFileSync(filePath, 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  });
}

/** Áp bộ migration riêng của control plane từ rỗng (đọc chính các file SQL đã sinh trong repo). */
async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
  const outDir = join(__dirname, '..', '..', '..', 'drizzle-control-plane');
  const folders = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'), true);
  }
}

/** Áp baseline nghiệp vụ vào một kho riêng bằng kết nối của chính role chủ kho đó. */
async function applyBusinessBaseline(connectionString: string): Promise<void> {
  const baseline = join(__dirname, '..', '..', '..', 'drizzle', '20261025163710_baseline', 'migration.sql');
  await applySqlFile(connectionString, baseline, true);
}

/** ConfigService giả chỉ mang đúng các khoá mà khung định tuyến và kết nối control plane đọc. */
function fakeConfig(values: Record<string, unknown>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** Đếm kết nối đang mở vào một database của một role trên cụm (qua pg_stat_activity ở database quản trị). */
async function countConnections(database: string, role: string): Promise<number> {
  return withClient(clusterUrl('postgres'), async (admin) => {
    const result = await admin.query<{ count: string }>(
      'SELECT count(*) FROM pg_stat_activity WHERE datname = $1 AND usename = $2',
      [database, role],
    );
    return Number(result.rows[0]!.count);
  });
}

describe('Khung định tuyến kết nối theo trung tâm (integration)', () => {
  let service: SpaceDatabaseService;
  let controlPlane: ControlPlaneConnection;
  let sharedPool: TenantAwarePool;
  let sharedDb: Database;
  let businessDatabase: string;
  let businessRole: string;

  beforeAll(async () => {
    const businessUrl = new URL(process.env.DATABASE_URL!);
    businessDatabase = decodeURIComponent(businessUrl.pathname.replace(/^\//, ''));
    businessRole = decodeURIComponent(businessUrl.username);

    // Cấp phát control plane + hai kho riêng trên cụm test, đúng
    // các bước script cấp phát làm ở môi trường triển khai: role
    // riêng cho từng kho, kho thuộc role của nó, CONNECT của
    // PUBLIC bị thu hồi và chỉ cấp lại cho đúng role đó.
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_A_DATABASE, CENTRE_B_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_A_ROLE, CENTRE_B_ROLE, CENTRE_A2_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
      await admin.query(`CREATE ROLE ${CP_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE_A_ROLE} LOGIN PASSWORD '${CENTRE_A_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE_B_ROLE} LOGIN PASSWORD '${CENTRE_B_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE_A2_ROLE} LOGIN PASSWORD '${CENTRE_A2_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${CP_DATABASE} OWNER ${CP_ROLE}`);
      await admin.query(`CREATE DATABASE ${CENTRE_A_DATABASE} OWNER ${CENTRE_A_ROLE}`);
      await admin.query(`CREATE DATABASE ${CENTRE_B_DATABASE} OWNER ${CENTRE_B_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CP_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CP_DATABASE} TO ${CP_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CENTRE_A_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_A_DATABASE} TO ${CENTRE_A_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CENTRE_B_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_B_DATABASE} TO ${CENTRE_B_ROLE}`);
      // Role thứ hai của kho A được cấp CONNECT vào kho A như một
      // role của kho thật: ca hồi quy đổi sổ sẽ trỏ sổ sang role
      // này và kết nối thật phải chạy được bằng chính nó.
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_A_DATABASE} TO ${CENTRE_A2_ROLE}`);
    });

    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD));
    await applyBusinessBaseline(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD));
    await applyBusinessBaseline(clusterUrl(CENTRE_B_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD));

    // Chuỗi bí mật của hai kho riêng cố ý trỏ về database mặc
    // định `postgres`: khung định tuyến phải chốt đích theo
    // databaseName trong sổ, không theo tên database trong chuỗi.
    process.env.SPACE_TEST_A_581_URL = clusterUrl('postgres', CENTRE_A_ROLE, CENTRE_A_PASSWORD);
    process.env.SPACE_TEST_B_581_URL = clusterUrl('postgres', CENTRE_B_ROLE, CENTRE_B_PASSWORD);
    process.env.SPACE_TEST_A2_581_URL = clusterUrl('postgres', CENTRE_A2_ROLE, CENTRE_A2_PASSWORD);

    controlPlane = new ControlPlaneConnection(
      fakeConfig({
        CONTROL_PLANE_DATABASE_URL: clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD),
        DATABASE_SSL: false,
      }),
    );
    if (!controlPlane.db) throw new Error('Control plane chưa được cấu hình trong ca kiểm chứng');
    await controlPlane.db.insert(spaceRegistry).values([
      {
        slug: CENTRE_A_SLUG,
        name: 'Trung tâm A 581',
        kind: 'center',
        status: 'active',
        databaseName: CENTRE_A_DATABASE,
        storageMode: 'dedicated',
        connectionRoleRef: CENTRE_A_ROLE,
        secretRef: 'env:SPACE_TEST_A_581_URL',
        schemaVersion: 'v1',
      },
      {
        slug: CENTRE_B_SLUG,
        name: 'Trung tâm B 581',
        kind: 'center',
        status: 'active',
        databaseName: CENTRE_B_DATABASE,
        storageMode: 'dedicated',
        connectionRoleRef: CENTRE_B_ROLE,
        secretRef: 'env:SPACE_TEST_B_581_URL',
        schemaVersion: 'v1',
      },
      {
        slug: SHARED_SLUG,
        name: 'Trang chính',
        kind: 'platform',
        status: 'active',
        databaseName: businessDatabase,
        storageMode: 'shared',
        connectionRoleRef: businessRole,
        secretRef: 'env:DATABASE_URL',
        schemaVersion: 'v1',
      },
    ]);

    service = new SpaceDatabaseService(
      fakeConfig({
        SPACE_DB_POOL_MAX: POOL_MAX,
        SPACE_DB_POOL_IDLE_TIMEOUT_MS: POOL_IDLE_TIMEOUT_MS,
        SPACE_ROUTING_CACHE_TTL_MS: 60_000,
        DATABASE_SSL: false,
      }),
      controlPlane,
    );
    sharedPool = new TenantAwarePool({ connectionString: process.env.DATABASE_URL! });
    sharedDb = drizzle({ client: sharedPool, relations });
    service.bindSharedDatabase(sharedDb);
  }, 180_000);

  afterAll(async () => {
    await service.onModuleDestroy();
    await sharedPool.end().catch(() => undefined);
    await controlPlane.onModuleDestroy();
    delete process.env.SPACE_TEST_A_581_URL;
    delete process.env.SPACE_TEST_B_581_URL;
    delete process.env.SPACE_TEST_A2_581_URL;
    // Dọn dòng kiểm chứng đã ghi vào kho chung để các ca khác dùng
    // chung database nghiệp vụ test không thấy dữ kiện lạ (dòng
    // đánh dấu của ca bị-thu-hồi về nguyên tắc không bao giờ được
    // ghi thành công, xoá kèm để dọn dẹp phòng hờ).
    await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query('DELETE FROM tenants WHERE id = ANY($1)', [[SHARED_TENANT_ID, REVOKED_MARKER_ID]]);
    }).catch(() => undefined);
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_A_DATABASE, CENTRE_B_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_A_ROLE, CENTRE_B_ROLE, CENTRE_A2_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
    });
  });

  it('cùng một thao tác ghi/đọc dưới ngữ cảnh hai trung tâm rơi vào hai kho khác nhau', async () => {
    // Cùng một thao tác nghiệp vụ (ghi một dòng tenant rồi đọc
    // lại) được mở qua phiên theo trung tâm của mỗi slug: mỗi
    // phiên phải ghi vào đúng kho riêng của trung tâm đó.
    await service.withSpaceDatabase(
      CENTRE_A_SLUG,
      async (db) => {
        await db.insert(tenants).values({ id: TENANT_A_ID, slug: CENTRE_A_SLUG, name: 'Trung tâm A 581', kind: 'center' });
        const rows = await db.select().from(tenants).where(eq(tenants.id, TENANT_A_ID));
        expect(rows).toHaveLength(1);
      },
      { tenantId: TENANT_A_ID },
    );
    await service.withSpaceDatabase(
      CENTRE_B_SLUG,
      async (db) => {
        await db.insert(tenants).values({ id: TENANT_B_ID, slug: CENTRE_B_SLUG, name: 'Trung tâm B 581', kind: 'center' });
        const rows = await db.select().from(tenants).where(eq(tenants.id, TENANT_B_ID));
        expect(rows).toHaveLength(1);
      },
      { tenantId: TENANT_B_ID },
    );

    // Kiểm chứng trực tiếp trong từng kho bằng kết nối của chính
    // role kho đó: kho A chỉ có dòng của A, kho B chỉ có dòng của B.
    // Kết nối kiểm chứng đặt cờ platform tường minh trước khi đọc
    // — đúng cách đường vận hành platform của hệ đọc xuyên tenant:
    // RLS của hệ fail-closed theo ngữ cảnh, một kết nối không ngữ
    // cảnh không thấy dòng nào (đó là hành vi đúng, không phải
    // bằng chứng dòng không tồn tại).
    const readTenantIdsDirectly = async (database: string, role: string, password: string): Promise<string[]> =>
      withClient(clusterUrl(database, role, password), async (client) => {
        await client.query("SELECT set_config('app.platform', 'on', false)");
        const result = await client.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
        return result.rows.map((row) => row.id);
      });
    expect(await readTenantIdsDirectly(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD)).toEqual([TENANT_A_ID]);
    expect(await readTenantIdsDirectly(CENTRE_B_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD)).toEqual([TENANT_B_ID]);
  });

  it('role của kho này bị từ chối ngay ở bước mở kết nối vào kho kia, cả hai chiều', async () => {
    for (const [database, role, password] of [
      [CENTRE_B_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD],
      [CENTRE_A_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD],
    ] as const) {
      const client = new Client({ connectionString: clusterUrl(database, role, password) });
      let connectError: unknown;
      try {
        await client.connect();
      } catch (err) {
        connectError = err;
      } finally {
        await client.end().catch(() => undefined);
      }
      expect(connectError).toBeInstanceOf(Error);
      expect((connectError as Error).message).toMatch(/permission denied for database/);
    }
    // Chiều hợp lệ vẫn mở được: role của kho A kết nối vào kho A.
    const database = await withClient(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), async (client) => {
      const result = await client.query<{ current_database: string }>('SELECT current_database()');
      return result.rows[0]!.current_database;
    });
    expect(database).toBe(CENTRE_A_DATABASE);
  });

  it('sổ vừa đổi trạng thái: đệm vẫn giữ kết quả cũ cho tới khi sự kiện vô hiệu hoá được phát, sau đó phân giải thấy ngay trạng thái mới', async () => {
    const before = await service.resolveTarget(CENTRE_A_SLUG);
    expect(before.status).toBe('active');
    // Đổi thẳng trên sổ (mô phỏng đường ghi của tầng quản trị sổ)
    // nhưng chưa phát sự kiện: phân giải vẫn trả kết quả đã đệm.
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      await client.query('UPDATE space_registry SET status = $1 WHERE slug = $2', ['suspended', CENTRE_A_SLUG]);
    });
    const cached = await service.resolveTarget(CENTRE_A_SLUG);
    expect(cached.status).toBe('active');
    // Sự kiện đổi sổ phát ra thì lần phân giải kế tiếp đọc sổ ngay,
    // không chờ hết TTL (TTL trong ca này là 60 giây).
    emitSpaceRegistryChanged(CENTRE_A_SLUG);
    const fresh = await service.resolveTarget(CENTRE_A_SLUG);
    expect(fresh.status).toBe('suspended');
    // Trả sổ về trạng thái active cho các ca sau.
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      await client.query('UPDATE space_registry SET status = $1 WHERE slug = $2', ['active', CENTRE_A_SLUG]);
    });
    emitSpaceRegistryChanged(CENTRE_A_SLUG);
  });

  it('pool của kho không còn traffic bị đóng sau ngưỡng nhàn rỗi, và lần dùng sau tạo lại pool hoạt động bình thường', async () => {
    // Traffic cuối vào kho A là ở ca ghi/đọc đầu tiên; chờ quá
    // ngưỡng nhàn rỗi cộng một chu kỳ quét (chu kỳ quét bằng nửa
    // ngưỡng, kẹp tối thiểu 1 giây) rồi đếm kết nối thật trên cụm.
    await new Promise((resolve) => setTimeout(resolve, POOL_IDLE_TIMEOUT_MS + 1_800));
    await expect(countConnections(CENTRE_A_DATABASE, CENTRE_A_ROLE)).resolves.toBe(0);
    // Đóng pool là trả ngân sách, không phải trạng thái cuối: mở
    // lại phiên của trung tâm A vẫn đọc được dòng đã ghi. Callback
    // ở đây cố ý trả THẲNG một truy vấn Drizzle (không tự bọc
    // async): khung phiên phải giữ ngữ cảnh cho cả kiểu viết này —
    // truy vấn là thenable, điểm await nằm ngoài `fn` mà GUC
    // tenant vẫn phải được gắn đúng khi kết nối checkout.
    const rows = await service.withSpaceDatabase(
      CENTRE_A_SLUG,
      (db) => db.select().from(tenants).where(eq(tenants.id, TENANT_A_ID)),
      { tenantId: TENANT_A_ID },
    );
    expect(rows).toHaveLength(1);
  });

  it('trung tâm kho riêng đã chuẩn bị mà pool bị đóng vì nhàn rỗi: truy vấn qua handle định tuyến trong ngữ cảnh còn mang slug bị từ chối thay vì rơi về kho chung', async () => {
    // Chuẩn bị trung tâm A rồi đối chứng: trong ngữ cảnh mang
    // slug của A, handle định tuyến phục vụ từ kho riêng của A.
    await service.getDatabaseForSpace(CENTRE_A_SLUG);
    const probeBefore = await tenantAls.run({ spaceSlug: CENTRE_A_SLUG, tenantId: TENANT_A_ID }, async () => {
      const result = (await service.routedDatabase.execute(sql`SELECT current_database() AS db`)) as unknown as {
        rows: { db: string }[];
      };
      return result.rows[0]!.db;
    });
    expect(probeBefore).toBe(CENTRE_A_DATABASE);

    // Ép pool của kho A bị vòng quét đóng vì nhàn rỗi (chờ quá
    // ngưỡng + một chu kỳ quét, xác nhận kết nối thật đã về 0 —
    // trạng thái đã-chuẩn-bị của slug bị khung thu hồi tại đây).
    await new Promise((resolve) => setTimeout(resolve, POOL_IDLE_TIMEOUT_MS + 1_800));
    await expect(countConnections(CENTRE_A_DATABASE, CENTRE_A_ROLE)).resolves.toBe(0);

    // Ngữ cảnh VẪN mang slug của A và không có lần chuẩn bị nào
    // mới: truy vấn qua handle định tuyến phải bị TỪ CHỐI
    // (fail-closed), tuyệt đối không rơi về kho chung.
    let readError: unknown;
    await tenantAls.run({ spaceSlug: CENTRE_A_SLUG, tenantId: TENANT_A_ID }, async () => {
      try {
        await service.routedDatabase.execute(sql`SELECT 1`);
      } catch (err) {
        readError = err;
      }
    });
    expect(readError).toBeInstanceOf(SpaceRoutingError);
    expect((readError as SpaceRoutingError).code).toBe('space_routing.prepared_revoked');

    // Một lệnh GHI trong cùng ngữ cảnh đó cũng bị từ chối, và
    // dòng ghi không xuất hiện ở kho chung (nơi nó sẽ rơi vào nếu
    // khung đổi đích im lặng).
    let writeError: unknown;
    await tenantAls.run({ spaceSlug: CENTRE_A_SLUG, tenantId: REVOKED_MARKER_ID }, async () => {
      try {
        await service.routedDatabase
          .insert(tenants)
          .values({ id: REVOKED_MARKER_ID, slug: 'dau-ghi-bi-thu-hoi-581', name: 'Dòng ghi ca thu hồi 581', kind: 'center' });
      } catch (err) {
        writeError = err;
      }
    });
    expect(writeError).toBeInstanceOf(SpaceRoutingError);
    const markerInShared = await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ id: string }>('SELECT id FROM tenants WHERE id = $1', [REVOKED_MARKER_ID]);
      return result.rows.map((row) => row.id);
    });
    expect(markerInShared).toEqual([]);

    // Đối chứng cuối: chuẩn bị lại thì đường định tuyến phục vụ
    // đúng kho riêng của A như trước — lỗi chỉ nằm ở khoảng giữa
    // thu hồi và chuẩn bị lại, và nó ồn ào chứ không im lặng.
    await service.getDatabaseForSpace(CENTRE_A_SLUG);
    const probeAfter = await tenantAls.run({ spaceSlug: CENTRE_A_SLUG, tenantId: TENANT_A_ID }, async () => {
      const result = (await service.routedDatabase.execute(sql`SELECT current_database() AS db`)) as unknown as {
        rows: { db: string }[];
      };
      return result.rows[0]!.db;
    });
    expect(probeAfter).toBe(CENTRE_A_DATABASE);
  });

  it('tổng kết nối mở vào một kho không vượt trần cấu hình khi nhiều phiên chạy đồng thời', async () => {
    const db = await service.getDatabaseForSpace(CENTRE_B_SLUG);
    // Bốn transaction mở đồng thời, mỗi transaction giữ kết nối
    // của mình cho tới khi cổng chung mở: pool chỉ được phép có
    // tối đa POOL_MAX kết nối thật trên cụm, các transaction thừa
    // phải chờ trong hàng đợi của pool.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transactions = Array.from({ length: 4 }, () =>
      tenantAls.run({ tenantId: TENANT_B_ID }, () =>
        db.transaction(async (tx) => {
          await tx.execute('SELECT 1');
          await gate;
        }),
      ),
    );
    // Chờ các transaction đầu giữ đủ kết nối rồi mới đếm.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const open = await countConnections(CENTRE_B_DATABASE, CENTRE_B_ROLE);
    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThanOrEqual(POOL_MAX);
    release();
    await Promise.all(transactions);
  });

  it('trung tâm ở chế độ kho chung dùng đúng handle kho chung và ghi/đọc trên kho chung như hiện tại', async () => {
    const db = await service.getDatabaseForSpace(SHARED_SLUG);
    expect(db).toBe(sharedDb);
    // Đường hiện tại không đổi: ngoài ngữ cảnh slug, handle định
    // tuyến uỷ thác về kho chung — ghi một dòng rồi đọc lại đều
    // trên database nghiệp vụ dùng chung.
    await tenantAls.run({ tenantId: SHARED_TENANT_ID }, async () => {
      await service.routedDatabase
        .insert(tenants)
        .values({ id: SHARED_TENANT_ID, slug: 'tenant-chung-581', name: 'Tenant kho chung 581', kind: 'center' });
      const rows = await service.routedDatabase.select().from(tenants).where(eq(tenants.id, SHARED_TENANT_ID));
      expect(rows).toHaveLength(1);
    });
    const inShared = await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ id: string }>('SELECT id FROM tenants WHERE id = $1', [SHARED_TENANT_ID]);
      return result.rows.map((row) => row.id);
    });
    expect(inShared).toEqual([SHARED_TENANT_ID]);
  });

  it('handle định tuyến uỷ thác về kho của trung tâm trong ngữ cảnh mang slug của trung tâm đó, và về kho chung ngoài ngữ cảnh', async () => {
    // Trung tâm A đã được chuẩn bị (các ca trước đã mở phiên của
    // nó): trong ngữ cảnh mang slug của A, điểm inject dùng chung
    // đọc thấy dòng của A trong kho riêng của A.
    await service.getDatabaseForSpace(CENTRE_A_SLUG);
    const routed = await tenantAls.run({ spaceSlug: CENTRE_A_SLUG, tenantId: TENANT_A_ID }, async () => {
      const rows = await service.routedDatabase.select().from(tenants);
      return rows.map((row) => row.id);
    });
    expect(routed).toEqual([TENANT_A_ID]);
    // Ngoài ngữ cảnh slug, cùng một điểm inject đọc ở kho chung:
    // dòng của A không có ở đó.
    const unrouted = await tenantAls.run({ tenantId: TENANT_A_ID }, async () => {
      const rows = await service.routedDatabase.select().from(tenants).where(eq(tenants.id, TENANT_A_ID));
      return rows;
    });
    expect(unrouted).toHaveLength(0);
  });

  it('sổ đổi role và bí mật của một kho sau khi pool đã tạo: lần lấy handle kế tiếp kết nối bằng role mới của sổ, pool cũ bị thay', async () => {
    // Đối chứng: handle hiện tại của trung tâm A kết nối bằng
    // role gốc của kho A.
    const dbBefore = await service.getDatabaseForSpace(CENTRE_A_SLUG);
    const userBefore = (await dbBefore.execute(sql`SELECT current_user AS u`)) as unknown as { rows: { u: string }[] };
    expect(userBefore.rows[0]!.u).toBe(CENTRE_A_ROLE);

    // Đổi danh tính kết nối trong sổ: role A -> role A2, bí mật
    // trỏ sang chuỗi của A2 (đúng các trường hợp đồng cập nhật
    // cho phép đổi), rồi phát sự kiện đổi sổ như tầng quản trị sổ
    // phát sau khi commit.
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      await client.query('UPDATE space_registry SET connection_role_ref = $1, secret_ref = $2 WHERE slug = $3', [
        CENTRE_A2_ROLE,
        'env:SPACE_TEST_A2_581_URL',
        CENTRE_A_SLUG,
      ]);
    });
    emitSpaceRegistryChanged(CENTRE_A_SLUG);

    // Bộ phân giải thấy danh tính mới ngay (đệm đã vô hiệu hoá):
    const target = await service.resolveTarget(CENTRE_A_SLUG);
    expect(target.connectionRole).toBe(CENTRE_A2_ROLE);

    // Lần lấy handle kế tiếp phải cho handle MỚI (pool cũ bị
    // thay) và kết nối thật chạy bằng role MỚI của sổ — không
    // được tiếp tục dùng pool cũ theo khoá tên database.
    const dbAfter = await service.getDatabaseForSpace(CENTRE_A_SLUG);
    expect(dbAfter).not.toBe(dbBefore);
    const userAfter = (await dbAfter.execute(sql`SELECT current_user AS u`)) as unknown as { rows: { u: string }[] };
    expect(userAfter.rows[0]!.u).toBe(CENTRE_A2_ROLE);

    // Trả sổ về role/bí mật gốc để trạng thái cuối của ca độc lập
    // với thứ tự chạy.
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      await client.query('UPDATE space_registry SET connection_role_ref = $1, secret_ref = $2 WHERE slug = $3', [
        CENTRE_A_ROLE,
        'env:SPACE_TEST_A_581_URL',
        CENTRE_A_SLUG,
      ]);
    });
    emitSpaceRegistryChanged(CENTRE_A_SLUG);
  });
});
