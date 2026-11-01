import type { ConfigService } from '@nestjs/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenants } from '@lms/db';
import { spaceRegistry } from '@lms/db/control-plane';
import { relations } from '../../../src/db/relations';
import { SpaceRoutingError } from '../../../src/db/routing/space-connection-resolver';
import { SpaceDatabaseService, type SpaceDatabase } from '../../../src/db/routing/space-database.service';
import { emitSpaceRegistryChanged } from '../../../src/db/routing/space-routing-events';
import { tenantAls } from '../../../src/db/tenant-als';
import { TenantAwarePool } from '../../../src/db/tenant-pool';

/**
 * Ca tích hợp của KHUNG ĐỊNH TUYẾN THEO TRUNG TÂM PHÍA WORKER
 * (issue #581): bản sao của khung ở tiến trình worker phải mở được
 * phiên theo trung tâm cho tác vụ nền trên CÙNG một sổ đăng ký và
 * cùng một luật phân giải với phía API.
 *
 * Môi trường của ca tự cấp phát trên cùng cụm với database test
 * của worker, toàn bộ bằng TÊN MỚI của riêng đợt này: một database
 * control plane (`lms_test_cp_581w`) với role riêng và một kho
 * riêng (`lms_test_centre_w_581`) có đúng một role ứng dụng riêng
 * (CONNECT của PUBLIC bị thu hồi, baseline nghiệp vụ áp bằng
 * chính role chủ kho). Worker chưa có kết nối control plane dùng
 * chung nên service của worker tự giữ pool đọc sổ từ biến
 * `CONTROL_PLANE_DATABASE_URL` — ca này dựng service trực tiếp
 * trên biến đó, không khởi động toàn bộ module worker.
 *
 * Vòng sửa của PR (theo phán quyết điều phối trên PR) thêm hai ca
 * hồi quy cho bản sao phía worker, dựng đúng hình hai ca phía
 * API: (1) sổ đổi role/bí mật của kho sau khi pool đã tạo thì lần
 * lấy handle kế tiếp kết nối bằng role mới — cần một role thứ hai
 * của kho (`lms_centre_w2_581_app`, có CONNECT vào kho) làm đích
 * đổi sổ; (2) trung tâm kho riêng đã chuẩn bị mà pool bị đóng vì
 * nhàn rỗi thì truy vấn qua handle định tuyến trong ngữ cảnh còn
 * mang slug bị từ chối (fail-closed) — ca này dựng một service
 * thứ hai với ngưỡng nhàn rỗi 600 mili giây để không phải chờ
 * ngưỡng mặc định.
 *
 * Shim `uuidv7()` chỉ áp khi server PostgreSQL dưới 18 (môi trường
 * chạy local bằng PG16): PG18 — bản ở CI và production — có sẵn
 * hàm này, shim sẽ che mất hàm gốc nên tuyệt đối không áp ở đó.
 */
const CP_DATABASE = 'lms_test_cp_581w';
const CP_ROLE = 'lms_cp_test_581w';
const CP_PASSWORD = 'cp-test-581w';
const CENTRE_DATABASE = 'lms_test_centre_w_581';
const CENTRE_ROLE = 'lms_centre_w_581_app';
const CENTRE_PASSWORD = 'centre-w-581';
const CENTRE_SLUG = 'trung-tam-w-581';
const SHARED_SLUG = 'trang-chinh';
const CENTRE_TENANT_ID = '01958100-0000-7000-8000-0000000000d4';
/** Role thứ hai của kho riêng phía worker — đích đổi sổ của ca hồi quy xoay role/bí mật sau khi pool đã tạo. */
const CENTRE2_ROLE = 'lms_centre_w2_581_app';
const CENTRE2_PASSWORD = 'centre-w2-581';
/** Id dòng ghi hợp lệ qua phiên của ca bị-thu-hồi (ghi vào kho riêng), phân biệt với dòng ghi qua handle định tuyến phải bị từ chối. */
const SESSION_ROW_ID = '01958100-0000-7000-8000-0000000000e6';
/** Id của dòng ghi mà ca bị-thu-hồi cố ý ghi qua handle định tuyến sau khi pool đã đóng: dòng này không được phép xuất hiện ở bất kỳ kho nào. */
const REVOKED_MARKER_ID = '01958100-0000-7000-8000-0000000000f7';

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/** Dựng URL kết nối tới một database trên cùng cụm với database test của worker. */
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
async function applySqlFile(connectionString: string, filePath: string): Promise<void> {
  await withClient(connectionString, async (client) => {
    const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(version.rows[0]!.server_version_num) < 180000) {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query(UUIDV7_SHIM);
    }
    const sql = readFileSync(filePath, 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  });
}

describe('Khung định tuyến theo trung tâm phía worker (integration)', () => {
  let service: SpaceDatabaseService;
  let sharedPool: TenantAwarePool;
  let sharedDb: SpaceDatabase;

  beforeAll(async () => {
    const businessUrl = new URL(process.env.DATABASE_URL!);
    const businessDatabase = decodeURIComponent(businessUrl.pathname.replace(/^\//, ''));
    const businessRole = decodeURIComponent(businessUrl.username);

    // Cấp phát control plane + kho riêng trên cụm test bằng tên
    // mới, đúng khuôn phía API: role riêng từng kho, CONNECT của
    // PUBLIC bị thu hồi và chỉ cấp lại cho đúng role đó.
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_ROLE, CENTRE2_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
      await admin.query(`CREATE ROLE ${CP_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE_ROLE} LOGIN PASSWORD '${CENTRE_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE2_ROLE} LOGIN PASSWORD '${CENTRE2_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${CP_DATABASE} OWNER ${CP_ROLE}`);
      await admin.query(`CREATE DATABASE ${CENTRE_DATABASE} OWNER ${CENTRE_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CP_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CP_DATABASE} TO ${CP_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CENTRE_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_DATABASE} TO ${CENTRE_ROLE}`);
      // Role thứ hai của kho được cấp CONNECT vào kho như một
      // role của kho thật: ca hồi quy đổi sổ trỏ sổ sang role này.
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_DATABASE} TO ${CENTRE2_ROLE}`);
    });

    // Bộ migration control plane dùng chung của repo nằm ở phía
    // Carrier control plane (packages/db/migrations/control-plane) — worker đọc cùng các
    // file SQL đó, không có bộ migration riêng.
    const cpDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'control-plane');
    const folders = readdirSync(cpDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const folder of folders) {
      await applySqlFile(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), join(cpDir, folder, 'migration.sql'));
    }
    await applySqlFile(
      clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD),
      join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'centre', '20261025163710_baseline', 'migration.sql'),
    );

    // Gieo sổ đăng ký qua kết nối của chính role control plane:
    // một trung tâm ở kho riêng, Trang chính ở kho chung trỏ về
    // database test của worker.
    process.env.SPACE_TEST_W_581_URL = clusterUrl('postgres', CENTRE_ROLE, CENTRE_PASSWORD);
    process.env.SPACE_TEST_W2_581_URL = clusterUrl('postgres', CENTRE2_ROLE, CENTRE2_PASSWORD);
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      const drizzleDb = drizzle({ client });
      await drizzleDb.insert(spaceRegistry).values([
        {
          slug: CENTRE_SLUG,
          name: 'Trung tâm W 581',
          kind: 'center',
          status: 'active',
          databaseName: CENTRE_DATABASE,
          storageMode: 'dedicated',
          connectionRoleRef: CENTRE_ROLE,
          secretRef: 'env:SPACE_TEST_W_581_URL',
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
    });

    service = new SpaceDatabaseService({
      get: (key: string) =>
        ({
          CONTROL_PLANE_DATABASE_URL: clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD),
          SPACE_DB_POOL_MAX: 2,
          SPACE_DB_POOL_IDLE_TIMEOUT_MS: 60_000,
          SPACE_ROUTING_CACHE_TTL_MS: 60_000,
          DATABASE_SSL: false,
        })[key],
    } as unknown as ConfigService);
    sharedPool = new TenantAwarePool({ connectionString: process.env.DATABASE_URL! });
    sharedDb = drizzle({ client: sharedPool, relations });
    service.bindSharedDatabase(sharedDb);
  }, 180_000);

  afterAll(async () => {
    await service.onModuleDestroy();
    await sharedPool.end().catch(() => undefined);
    delete process.env.SPACE_TEST_W_581_URL;
    delete process.env.SPACE_TEST_W2_581_URL;
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_ROLE, CENTRE2_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
    });
  });

  it('phiên theo trung tâm của một tác vụ nền ghi và đọc trong đúng kho riêng của trung tâm', async () => {
    await service.withSpaceDatabase(
      CENTRE_SLUG,
      async (db) => {
        await db
          .insert(tenants)
          .values({ id: CENTRE_TENANT_ID, slug: CENTRE_SLUG, name: 'Trung tâm W 581', kind: 'center' });
        const rows = await db.select().from(tenants).where(eq(tenants.id, CENTRE_TENANT_ID));
        expect(rows).toHaveLength(1);
      },
      { tenantId: CENTRE_TENANT_ID },
    );
    // Kiểm chứng trực tiếp trong kho riêng bằng kết nối của chính
    // role kho đó, có đặt cờ platform như đường vận hành của hệ
    // (RLS fail-closed: kết nối không ngữ cảnh không thấy dòng).
    const direct = await withClient(clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD), async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
      return result.rows.map((row) => row.id);
    });
    expect(direct).toEqual([CENTRE_TENANT_ID]);
  });

  it('phiên theo trung tâm ở chế độ kho chung dùng đúng handle kho chung của worker', async () => {
    const db = await service.getDatabaseForSpace(SHARED_SLUG);
    expect(db).toBe(sharedDb);
    const viaSession = await service.withSpaceDatabase(SHARED_SLUG, (sessionDb) => Promise.resolve(sessionDb));
    expect(viaSession).toBe(sharedDb);
  });

  it('sổ đổi role và bí mật của kho sau khi pool đã tạo: lần lấy handle kế tiếp của worker kết nối bằng role mới của sổ, pool cũ bị thay', async () => {
    // Đối chứng: handle hiện tại của trung tâm kết nối bằng role
    // gốc của kho.
    const dbBefore = await service.getDatabaseForSpace(CENTRE_SLUG);
    const userBefore = (await dbBefore.execute(sql`SELECT current_user AS u`)) as unknown as { rows: { u: string }[] };
    expect(userBefore.rows[0]!.u).toBe(CENTRE_ROLE);

    // Đổi danh tính kết nối trong sổ (role + bí mật sang role thứ
    // hai của kho) và phát sự kiện đổi sổ như tầng quản trị phát
    // sau khi commit.
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      await client.query('UPDATE space_registry SET connection_role_ref = $1, secret_ref = $2 WHERE slug = $3', [
        CENTRE2_ROLE,
        'env:SPACE_TEST_W2_581_URL',
        CENTRE_SLUG,
      ]);
    });
    emitSpaceRegistryChanged(CENTRE_SLUG);
    const target = await service.resolveTarget(CENTRE_SLUG);
    expect(target.connectionRole).toBe(CENTRE2_ROLE);

    // Lần lấy handle kế tiếp: handle mới, kết nối thật bằng role
    // mới — không dùng lại pool cũ theo khoá tên database.
    const dbAfter = await service.getDatabaseForSpace(CENTRE_SLUG);
    expect(dbAfter).not.toBe(dbBefore);
    const userAfter = (await dbAfter.execute(sql`SELECT current_user AS u`)) as unknown as { rows: { u: string }[] };
    expect(userAfter.rows[0]!.u).toBe(CENTRE2_ROLE);

    // Trả sổ về role/bí mật gốc để trạng thái cuối độc lập với
    // thứ tự chạy.
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      await client.query('UPDATE space_registry SET connection_role_ref = $1, secret_ref = $2 WHERE slug = $3', [
        CENTRE_ROLE,
        'env:SPACE_TEST_W_581_URL',
        CENTRE_SLUG,
      ]);
    });
    emitSpaceRegistryChanged(CENTRE_SLUG);
  });

  it('trung tâm kho riêng đã chuẩn bị mà pool bị đóng vì nhàn rỗi: truy vấn qua handle định tuyến phía worker trong ngữ cảnh còn mang slug bị từ chối thay vì rơi về kho chung', async () => {
    // Service thứ hai với ngưỡng nhàn rỗi 600 mili giây (service
    // chính của ca dùng ngưỡng 60 giây): pool của service này bị
    // vòng quét đóng nhanh để ca dựng được đúng hình bị-thu-hồi.
    const shortIdleService = new SpaceDatabaseService({
      get: (key: string) =>
        ({
          CONTROL_PLANE_DATABASE_URL: clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD),
          SPACE_DB_POOL_MAX: 2,
          SPACE_DB_POOL_IDLE_TIMEOUT_MS: 600,
          SPACE_ROUTING_CACHE_TTL_MS: 60_000,
          DATABASE_SSL: false,
        })[key],
    } as unknown as ConfigService);
    shortIdleService.bindSharedDatabase(sharedDb);
    try {
      // Chuẩn bị bằng một phiên ghi hợp lệ vào kho riêng, rồi đối
      // chứng handle định tuyến phục vụ từ đúng kho riêng.
      await shortIdleService.withSpaceDatabase(
        CENTRE_SLUG,
        async (db) => {
          await db
            .insert(tenants)
            .values({ id: SESSION_ROW_ID, slug: 'trung-tam-w-thu-hoi-581', name: 'Trung tâm W ca thu hồi 581', kind: 'center' });
        },
        { tenantId: SESSION_ROW_ID },
      );
      const probeBefore = await tenantAls.run({ spaceSlug: CENTRE_SLUG, tenantId: SESSION_ROW_ID }, async () => {
        const result = (await shortIdleService.routedDatabase.execute(sql`SELECT current_database() AS db`)) as unknown as {
          rows: { db: string }[];
        };
        return result.rows[0]!.db;
      });
      expect(probeBefore).toBe(CENTRE_DATABASE);

      // Chờ quá ngưỡng nhàn rỗi + chu kỳ quét: pool của service
      // này bị đóng và trạng thái đã-chuẩn-bị bị thu hồi. Bằng
      // chứng pool đã đóng chính là hành vi ở bước sau — nếu pool
      // chưa đóng, truy vấn qua handle định tuyến vẫn chạy được.
      await new Promise((resolve) => setTimeout(resolve, 600 + 1_800));

      // Ngữ cảnh vẫn mang slug, không chuẩn bị lại: truy vấn qua
      // handle định tuyến phải bị từ chối (fail-closed).
      let readError: unknown;
      await tenantAls.run({ spaceSlug: CENTRE_SLUG, tenantId: SESSION_ROW_ID }, async () => {
        try {
          await shortIdleService.routedDatabase.execute(sql`SELECT 1`);
        } catch (err) {
          readError = err;
        }
      });
      expect(readError).toBeInstanceOf(SpaceRoutingError);
      expect((readError as SpaceRoutingError).code).toBe('space_routing.prepared_revoked');

      // Lệnh ghi trong cùng ngữ cảnh cũng bị từ chối và dòng ghi
      // không xuất hiện ở kho chung của worker.
      let writeError: unknown;
      await tenantAls.run({ spaceSlug: CENTRE_SLUG, tenantId: REVOKED_MARKER_ID }, async () => {
        try {
          await shortIdleService.routedDatabase
            .insert(tenants)
            .values({ id: REVOKED_MARKER_ID, slug: 'dau-ghi-w-thu-hoi-581', name: 'Dòng ghi ca thu hồi W 581', kind: 'center' });
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

      // Chuẩn bị lại thì đường định tuyến phục vụ đúng kho riêng
      // như trước.
      await shortIdleService.getDatabaseForSpace(CENTRE_SLUG);
      const probeAfter = await tenantAls.run({ spaceSlug: CENTRE_SLUG, tenantId: SESSION_ROW_ID }, async () => {
        const result = (await shortIdleService.routedDatabase.execute(sql`SELECT current_database() AS db`)) as unknown as {
          rows: { db: string }[];
        };
        return result.rows[0]!.db;
      });
      expect(probeAfter).toBe(CENTRE_DATABASE);
    } finally {
      await shortIdleService.onModuleDestroy();
    }
  });
});
