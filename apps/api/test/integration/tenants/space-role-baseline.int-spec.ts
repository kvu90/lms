import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  installSpaceRoleBaseline,
  runSpaceProvision,
} from '../../../src/modules/tenants/space-provision-runner';
import { deriveCentreSecretEnvVar } from '../../../src/modules/tenants/centre-provision';
import { FleetRegistryWriter } from '../../../src/modules/fleet/fleet-registry-writer';
import { AccessRepository } from '../../../src/modules/access/access.repository';
import { ContextsService } from '../../../src/modules/access/contexts.service';
import { RolesService } from '../../../src/modules/access/roles.service';
import { PlanLimitsService } from '../../../src/modules/access/plan-limits.service';
import { RoleSeparationService } from '../../../src/modules/access/role-separation.service';
import { OutboxService } from '../../../src/infra/events/outbox.service';
import { relations } from '../../../src/db/relations';
import { DEFAULT_ROLES } from '../../../src/modules/access/domain/capabilities';

/**
 * Ca tích hợp của BƯỚC CÀI BỘ VAI MẶC ĐỊNH CHO TRUNG TÂM KHO RIÊNG
 * (cơ chế chuyển tiếp của chương trình tenant, issue #587): cấp
 * phát một trung tâm mới trên cụm Postgres thật thì kho đích phải
 * có đủ bộ vai mặc định hiện hành kèm đúng ma trận năng lực tại
 * context hệ thống như kho chung được gieo; lệnh cài riêng cho
 * trung tâm đã cấp phát phải lấp được một kho đang trống vai và
 * chạy lại phải là no-op tuyệt đối (không tạo trùng, không ghi đè
 * thay đổi cục bộ của trung tâm).
 *
 * Phía "kho chung được gieo" được dựng bằng ĐÚNG closure sản xuất:
 * một database trắng chạy migration nghiệp vụ hiện hành rồi gọi
 * `RolesService.seedDefaults` — cùng hàm mà `SeedService` của ứng
 * dụng gọi khi khởi động — trên handle của chính database đó. Mọi
 * đối chiếu là trực tiếp hai phía (cùng câu đọc trên kho tham
 * chiếu và kho trung tâm), không chép kỳ vọng cứng vào ca test.
 *
 * Mọi tên đều mang hậu tố ngẫu nhiên theo lượt chạy: chạy lại spec
 * trên cùng cụm không va chạm, và không tái dùng tên database cũ
 * (tránh khoá cache siteadmins cũ trong Redis theo tên database).
 * Cụm test lấy từ `DATABASE_URL` đã được Vitest phân giải (biến
 * `LMS_TEST_DATABASE_URL` ghi đè khi chạy ngoài CI).
 */
const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const CP_DATABASE = `lms_test_cp_td7_${RUN_SUFFIX}`;
const SHARED_DATABASE = `lms_test_shared_td7_${RUN_SUFFIX}`;
const SLUG_A = `trung-tam-td7-a-${RUN_SUFFIX}`;
const SLUG_B = `trung-tam-td7-b-${RUN_SUFFIX}`;
const ADMIN_EMAIL_A = `admin-td7-a-${RUN_SUFFIX}@example.com`;
const ADMIN_EMAIL_B = `admin-td7-b-${RUN_SUFFIX}@example.com`;
const DB_PASSWORD = 'Centre#Td7!Pass';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/** Dựng URL kết nối tới một database trên cùng cụm với database test. */
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
    const sqlText = readFileSync(filePath, 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  });
}

/** Áp bộ migration riêng của control plane từ rỗng (đọc chính các file SQL đã sinh trong repo). */
async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
  const outDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'control-plane');
  const folders = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'));
  }
}

/** Env chạy lệnh cấp phát: sổ control plane riêng + cụm test + mật khẩu role do ca test cấp. */
function provisionEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONTROL_PLANE_DATABASE_URL: clusterUrl(CP_DATABASE),
    DATABASE_URL: clusterUrl('postgres'),
    SPACE_PROVISION_DB_PASSWORD: DB_PASSWORD,
    ...extra,
  };
}

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'centre');

/** Hình chụp đường cơ sở vai của một kho: tập vai, tập định nghĩa năng lực, và ma trận tại context hệ thống dạng dòng chuẩn hoá. */
type RoleBaselineSnapshot = {
  roles: string[];
  capabilities: string[];
  matrix: string[];
};

/** Đọc hình chụp đường cơ sở vai của một kho qua kết nối của chính kho đó (ngữ cảnh platform để qua RLS). */
async function readRoleBaseline(connectionString: string): Promise<RoleBaselineSnapshot> {
  return withClient(connectionString, async (client) => {
    await client.query(`SELECT set_config('app.platform', 'on', false)`);
    const roles = await client.query<{ short_name: string }>('SELECT short_name FROM role ORDER BY short_name');
    const capabilities = await client.query<{ name: string }>('SELECT name FROM capabilities ORDER BY name');
    const matrix = await client.query<{ line: string }>(
      `SELECT r.short_name || '|' || rc.capability || '|' || rc.permission AS line
       FROM role_capabilities rc
       JOIN role r ON r.id = rc.role_id
       JOIN context c ON c.id = rc.context_id
       WHERE c.context_level = 10 AND c.instance_id IS NULL
       ORDER BY line`,
    );
    return {
      roles: roles.rows.map((row) => row.short_name),
      capabilities: capabilities.rows.map((row) => row.name),
      matrix: matrix.rows.map((row) => row.line),
    };
  });
}

/** Đếm số dòng của ba bảng làm nên đường cơ sở vai trong một kho. */
async function countRoleBaselineRows(connectionString: string): Promise<{ roles: number; roleCapabilities: number; capabilities: number }> {
  return withClient(connectionString, async (client) => {
    await client.query(`SELECT set_config('app.platform', 'on', false)`);
    const roles = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM role');
    const roleCapabilities = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM role_capabilities');
    const capabilities = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM capabilities');
    return {
      roles: Number(roles.rows[0]!.c),
      roleCapabilities: Number(roleCapabilities.rows[0]!.c),
      capabilities: Number(capabilities.rows[0]!.c),
    };
  });
}

/**
 * Gieo kho tham chiếu bằng đúng closure sản xuất của kho chung:
 * dựng bộ service của module access trên handle của kho rồi gọi
 * `RolesService.seedDefaults` — cùng hàm `SeedService` gọi lúc
 * khởi động ứng dụng.
 */
async function seedSharedStoreDefaults(connectionString: string): Promise<void> {
  await withClient(connectionString, async (client) => {
    await client.query(`SELECT set_config('app.platform', 'on', false)`);
    const db = drizzle({ client, relations });
    const accessRepository = new AccessRepository(db);
    const rolesService = new RolesService(
      accessRepository,
      new ContextsService(accessRepository),
      new OutboxService(db),
      new PlanLimitsService(db),
      new RoleSeparationService(db),
    );
    await rolesService.seedDefaults();
  });
}

/** Dựng kho tham chiếu: database trắng + migration nghiệp vụ hiện hành + đường gieo mặc định của kho chung. */
async function buildReferenceStore(): Promise<void> {
  await withClient(clusterUrl('postgres'), async (admin) => {
    await admin.query(`CREATE DATABASE ${quoted(SHARED_DATABASE)}`);
  });
  const pool = new Pool({ connectionString: clusterUrl(SHARED_DATABASE) });
  try {
    const version = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(version.rows[0]!.server_version_num) < 180000) {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await pool.query(UUIDV7_SHIM);
    }
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await pool.end();
  }
  await seedSharedStoreDefaults(clusterUrl(SHARED_DATABASE));
}

describe('Cài bộ vai mặc định cho trung tâm kho riêng (tích hợp)', () => {
  let writer: FleetRegistryWriter;
  let reference: RoleBaselineSnapshot;
  let provisionedA: Awaited<ReturnType<typeof runSpaceProvision>>;
  let provisionedB: Awaited<ReturnType<typeof runSpaceProvision>>;

  beforeAll(async () => {
    await withClient(clusterUrl('postgres'), async (admin) => {
      await admin.query(`CREATE DATABASE ${quoted(CP_DATABASE)}`);
    });
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE));
    await buildReferenceStore();
    reference = await readRoleBaseline(clusterUrl(SHARED_DATABASE));
    writer = new FleetRegistryWriter(provisionEnv());
    provisionedA = await runSpaceProvision({
      slug: SLUG_A,
      name: 'Trung tâm kiểm chứng TĐ7 A',
      adminEmail: ADMIN_EMAIL_A,
      databasePassword: DB_PASSWORD,
      actorId: ACTOR_ID,
      migrationsDir: MIGRATIONS_DIR,
      env: provisionEnv(),
      log: () => undefined,
    });
    provisionedB = await runSpaceProvision({
      slug: SLUG_B,
      name: 'Trung tâm kiểm chứng TĐ7 B',
      adminEmail: ADMIN_EMAIL_B,
      databasePassword: DB_PASSWORD,
      actorId: ACTOR_ID,
      migrationsDir: MIGRATIONS_DIR,
      env: provisionEnv(),
      log: () => undefined,
    });
  }, 600000);

  afterAll(async () => {
    if (writer) await writer.close();
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const provisioned of [provisionedA, provisionedB]) {
        if (provisioned) {
          await admin.query(`DROP DATABASE IF EXISTS ${quoted(provisioned.databaseName)} WITH (FORCE)`);
          await admin.query(`DROP ROLE IF EXISTS ${quoted(provisioned.connectionRole)}`);
        }
      }
      await admin.query(`DROP DATABASE IF EXISTS ${quoted(CP_DATABASE)} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${quoted(SHARED_DATABASE)} WITH (FORCE)`);
    });
  });

  it('cấp phát một kho riêng mới thì kho đích có đủ bộ vai mặc định, mỗi vai mang đúng tập năng lực như kho chung được gieo', async () => {
    // Kho tham chiếu tự nó phải mang đúng bộ vai mặc định theo định
    // nghĩa ở code — neo này giữ phép đối chiếu hai phía có nghĩa.
    expect(reference.roles).toEqual(DEFAULT_ROLES.map((definition) => definition.shortName).sort());
    expect(reference.matrix.length).toBeGreaterThan(0);

    expect(provisionedA.status).toBe('active');
    expect(provisionedA.steps).toContainEqual({ name: 'role-baseline', outcome: 'created' });

    const centreUrl = clusterUrl(provisionedA.databaseName, provisionedA.connectionRole, DB_PASSWORD);
    const installed = await readRoleBaseline(centreUrl);
    expect(installed).toEqual(reference);
  });

  it('đường gieo của kho chung giữ nguyên hành vi: chạy lại seedDefaults trên kho tham chiếu không đổi bộ vai đã gieo', async () => {
    await seedSharedStoreDefaults(clusterUrl(SHARED_DATABASE));
    const after = await readRoleBaseline(clusterUrl(SHARED_DATABASE));
    expect(after).toEqual(reference);
  });

  it('lệnh cài riêng cho trung tâm đã cấp phát lấp đủ một kho đang trống vai, và chạy lại thì không tạo trùng, không ghi đè thay đổi cục bộ', async () => {
    const centreUrlB = clusterUrl(provisionedB.databaseName, provisionedB.connectionRole, DB_PASSWORD);
    const envB = provisionEnv({ [deriveCentreSecretEnvVar(SLUG_B)]: centreUrlB });

    // Đưa kho B về trạng thái của một trung tâm cấp phát trước khi
    // pipeline có bước cài vai: xoá sạch đường cơ sở vai, giữ
    // nguyên mọi dữ kiện nền khác.
    await withClient(centreUrlB, async (client) => {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      await client.query('DELETE FROM role');
      await client.query('DELETE FROM capabilities');
    });
    expect(await countRoleBaselineRows(centreUrlB)).toEqual({ roles: 0, roleCapabilities: 0, capabilities: 0 });

    const installed = await installSpaceRoleBaseline({ slug: SLUG_B, env: envB, log: () => undefined });
    expect(installed.outcome).toBe('created');
    expect(await readRoleBaseline(centreUrlB)).toEqual(reference);

    // Thay đổi cục bộ của trung tâm sau khi cài: đổi giá trị một
    // dòng ma trận thành mốc nhận diện riêng và xoá hẳn một dòng
    // khác — lần chạy lại của lệnh cài không được động vào cả hai.
    const localMarker = 4242;
    await withClient(centreUrlB, async (client) => {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      const first = await client.query<{ id: string }>('SELECT id FROM role_capabilities ORDER BY id LIMIT 1');
      await client.query('UPDATE role_capabilities SET permission = $1 WHERE id = $2', [localMarker, first.rows[0]!.id]);
      const second = await client.query<{ id: string }>('SELECT id FROM role_capabilities WHERE permission <> $1 ORDER BY id LIMIT 1', [localMarker]);
      await client.query('DELETE FROM role_capabilities WHERE id = $1', [second.rows[0]!.id]);
    });
    const countsBefore = await countRoleBaselineRows(centreUrlB);

    const rerun = await installSpaceRoleBaseline({ slug: SLUG_B, env: envB, log: () => undefined });
    expect(rerun.outcome).toBe('reused');
    expect(await countRoleBaselineRows(centreUrlB)).toEqual(countsBefore);
    await withClient(centreUrlB, async (client) => {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      const marked = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM role_capabilities WHERE permission = $1', [localMarker]);
      expect(Number(marked.rows[0]!.c)).toBe(1);
    });
  });

  it('lệnh cài riêng trên trung tâm đã được pipeline cài sẵn bộ vai thì báo reused và không đổi gì', async () => {
    const centreUrlA = clusterUrl(provisionedA.databaseName, provisionedA.connectionRole, DB_PASSWORD);
    const envA = provisionEnv({ [deriveCentreSecretEnvVar(SLUG_A)]: centreUrlA });
    const countsBefore = await countRoleBaselineRows(centreUrlA);
    const result = await installSpaceRoleBaseline({ slug: SLUG_A, env: envA, log: () => undefined });
    expect(result.outcome).toBe('reused');
    expect(await countRoleBaselineRows(centreUrlA)).toEqual(countsBefore);
    expect(await readRoleBaseline(centreUrlA)).toEqual(reference);
  });

  it('lệnh cài riêng lấp đủ một kho mà lượt cài trước chết dở dang giữa đoạn ghi ma trận của vai cuối, và sau khi lấp đủ thì chạy lại là no-op', async () => {
    const centreUrlB = clusterUrl(provisionedB.databaseName, provisionedB.connectionRole, DB_PASSWORD);
    const envB = provisionEnv({ [deriveCentreSecretEnvVar(SLUG_B)]: centreUrlB });

    // Đưa kho B về một lượt cài trọn sạch do ca này tự dựng:
    // xoá đường cơ sở vai của các ca trước lẫn dấu mốc hoàn
    // tất (dòng config mang khoá `rolebaseline` của bước cài),
    // rồi cài lại bằng chính đường vận hành.
    await withClient(centreUrlB, async (client) => {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      await client.query('DELETE FROM role');
      await client.query('DELETE FROM capabilities');
      await client.query("DELETE FROM config WHERE key = 'rolebaseline'");
    });
    const installed = await installSpaceRoleBaseline({ slug: SLUG_B, env: envB, log: () => undefined });
    expect(installed.outcome).toBe('created');
    expect(await readRoleBaseline(centreUrlB)).toEqual(reference);

    // Dựng đúng trạng thái một lượt cài chết dở dang để lại.
    // Vai `user` được gieo cuối cùng nên dòng vai của nó đã có
    // nhưng ma trận tại context hệ thống mới ghi được một
    // phần — xoá 5 dòng của nó. Đồng thời dấu mốc hoàn tất
    // không tồn tại: dấu mốc chỉ ghi sau khi gieo trọn nên
    // lượt cài chết không bao giờ ghi được. Hai nửa này cùng
    // nhau mới là trạng thái chết dở dang thật; chính sự vắng
    // mặt của dấu mốc tách nó khỏi một kho đã cài trọn rồi bị
    // quản trị xoá dòng ma trận có chủ đích (ca trước).
    await withClient(centreUrlB, async (client) => {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      await client.query(
        `DELETE FROM role_capabilities WHERE id IN (
           SELECT rc.id FROM role_capabilities rc
           JOIN role r ON r.id = rc.role_id
           JOIN context c ON c.id = rc.context_id
           WHERE r.short_name = 'user' AND c.context_level = 10 AND c.instance_id IS NULL
           ORDER BY rc.capability LIMIT 5
         )`,
      );
      await client.query("DELETE FROM config WHERE key = 'rolebaseline'");
    });
    const partial = await readRoleBaseline(centreUrlB);
    expect(partial.roles).toEqual(reference.roles);
    expect(partial.matrix.length).toBe(reference.matrix.length - 5);

    // Chạy lại đường vận hành: phần ma trận thiếu phải được
    // lấp đủ tới mức khớp kho tham chiếu, không bị phán quyết
    // nhầm thành đã cài chỉ vì đủ dòng vai.
    const recovered = await installSpaceRoleBaseline({ slug: SLUG_B, env: envB, log: () => undefined });
    expect(recovered.outcome).toBe('created');
    expect(await readRoleBaseline(centreUrlB)).toEqual(reference);

    // Sau khi đã lấp đủ (dấu mốc hoàn tất đã ghi), chạy lại
    // là no-op tuyệt đối như mọi kho đã cài trọn.
    const countsBefore = await countRoleBaselineRows(centreUrlB);
    const rerun = await installSpaceRoleBaseline({ slug: SLUG_B, env: envB, log: () => undefined });
    expect(rerun.outcome).toBe('reused');
    expect(await countRoleBaselineRows(centreUrlB)).toEqual(countsBefore);
  });
});
