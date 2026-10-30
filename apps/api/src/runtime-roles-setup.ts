/**
 * Script cấp phát ROLE RUNTIME và ROLE MIGRATION của kho nghiệp vụ
 * (issue #586) — chạy ở bước migrate của stack triển khai (xem
 * `compose.yaml`, service `migrate`), TRƯỚC bước áp migration:
 *
 * 1. Đọc đích từ `MIGRATION_DATABASE_URL` (role migration + database
 *    nghiệp vụ) và `RUNTIME_DATABASE_URL` (role runtime + cùng
 *    database) — hai URL phải trỏ cùng một database và hai role
 *    phải khác nhau, lệch là cấu hình sai và dừng ngay.
 * 2. Kết nối quản trị của cụm lấy từ `DATABASE_ADMIN_URL` (dự phòng
 *    `DATABASE_URL` cho các môi trường chưa tách biến): đảm bảo hai
 *    role tồn tại ở tư thế tối thiểu, database thuộc sở hữu của
 *    role migration, và quyền kết nối vào database chỉ thuộc hai
 *    role đó (thu hồi PUBLIC).
 * 3. Kết nối quản trị vào CHÍNH database nghiệp vụ: chuyển từng
 *    đối tượng đang thuộc sở hữu của role quản trị (di sản của
 *    thời migration chạy bằng role quản trị) sang role migration
 *    theo liệt kê từng lớp đối tượng (xem
 *    `buildOwnershipTransferQuery` trong `runtime-roles.ts` — cơ
 *    chế `REASSIGN OWNED` không dùng được với superuser gốc), rồi
 *    cấp cho role runtime bộ quyền dữ liệu tối thiểu kèm quyền mặc
 *    định cho đối tượng migration tạo về sau.
 *
 * Mọi bước đều idempotent: chạy lại ở mỗi lần stack khởi động là an
 * toàn. Chưa cấu hình `MIGRATION_DATABASE_URL` hoặc
 * `RUNTIME_DATABASE_URL` thì bỏ qua lặng lẽ (thoát 0) để các môi
 * trường chưa tách role (CI kiểm chứng, chạy local bằng một URL
 * duy nhất) không gãy — đúng khuôn của `control-plane-setup.ts`.
 *
 * Mật khẩu chỉ đi từ biến môi trường vào câu lệnh SQL qua kết nối
 * quản trị nội bộ; script không in URL hay mật khẩu ra log.
 */
import { Client } from 'pg';
import { quoteIdentifier } from './control-plane-provision';
import {
  buildEnsureRoleStatements,
  buildOwnershipTransferQuery,
  buildRoleConnectStatements,
  buildRuntimeGrantStatements,
  buildTransferDatabaseOwnerStatement,
  parseRoleEndpoint,
  type RoleEndpoint,
} from './runtime-roles';

/** Dựng URL kết nối quản trị tới một database cụ thể trên cùng cụm (giữ nguyên thông tin quản trị, chỉ đổi đích). */
function retargetAdminUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Role sở hữu một database theo danh mục của cụm; undefined khi database không tồn tại. */
async function databaseOwner(client: Client, database: string): Promise<string | undefined> {
  const result = await client.query<{ owner: string }>(
    `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`,
    [database],
  );
  return result.rows[0]?.owner;
}

/** Một role đã tồn tại trên cụm hay chưa. */
async function roleExists(client: Client, role: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Thực thi toàn bộ bước cấp phát role. Trả về `skipped: true` khi
 * môi trường chưa cấu hình tách role (không phải lỗi).
 * @throws Error khi hai URL đích lệch database, hai role trùng nhau,
 * database đích không tồn tại, hoặc thiếu URL quản trị — cấu hình
 * sai phải chặn bước migrate, không để stack chạy bằng nửa mô hình.
 */
export async function runRuntimeRolesSetup(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ skipped: boolean }> {
  const migrationUrl = env.MIGRATION_DATABASE_URL;
  const runtimeUrl = env.RUNTIME_DATABASE_URL;
  if (!migrationUrl || !runtimeUrl) {
    console.log('runtime-roles-setup: MIGRATION_DATABASE_URL/RUNTIME_DATABASE_URL are not set — skipping role provisioning.');
    return { skipped: true };
  }
  const adminUrl = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL (or DATABASE_URL) is required to reach the cluster admin connection');

  const migrator = parseRoleEndpoint(migrationUrl, 'MIGRATION_DATABASE_URL');
  const runtime = parseRoleEndpoint(runtimeUrl, 'RUNTIME_DATABASE_URL');
  if (migrator.database !== runtime.database) {
    throw new Error(
      `MIGRATION_DATABASE_URL and RUNTIME_DATABASE_URL must name the same database (got ${migrator.database} vs ${runtime.database})`,
    );
  }
  if (migrator.role === runtime.role) {
    throw new Error('MIGRATION_DATABASE_URL and RUNTIME_DATABASE_URL must carry two different roles');
  }
  const adminRole = decodeURIComponent(new URL(adminUrl).username);

  const admin = new Client({ connectionString: retargetAdminUrl(adminUrl, 'postgres') });
  await admin.connect();
  try {
    const owner = await databaseOwner(admin, migrator.database);
    if (owner === undefined) {
      throw new Error(`business database ${quoteIdentifier(migrator.database)} does not exist on this cluster`);
    }
    for (const endpoint of [migrator, runtime] as RoleEndpoint[]) {
      for (const statement of buildEnsureRoleStatements(endpoint, await roleExists(admin, endpoint.role))) {
        await admin.query(statement);
      }
    }
    if (owner !== migrator.role) {
      await admin.query(buildTransferDatabaseOwnerStatement(migrator));
    }
    for (const statement of buildRoleConnectStatements(migrator.database, migrator.role, runtime.role)) {
      await admin.query(statement);
    }
  } finally {
    await admin.end();
  }

  // Bước trong database: chuyển sở hữu đối tượng + cấp quyền dữ
  // liệu. Việc chuyển chủ chỉ chạy khi role quản trị khác role
  // migration (bằng nhau thì đối tượng đã đúng chủ).
  const inside = new Client({ connectionString: retargetAdminUrl(adminUrl, migrator.database) });
  await inside.connect();
  try {
    if (adminRole !== migrator.role) {
      const transfers = await inside.query<{ statement: string }>(
        buildOwnershipTransferQuery(adminRole, migrator.role),
      );
      for (const row of transfers.rows) {
        await inside.query(row.statement);
      }
    }
    for (const statement of buildRuntimeGrantStatements(migrator.role, runtime.role)) {
      await inside.query(statement);
    }
  } finally {
    await inside.end();
  }
  console.log(
    `runtime-roles-setup: database ${quoteIdentifier(migrator.database)} is owned by ${quoteIdentifier(migrator.role)}; runtime role ${quoteIdentifier(runtime.role)} holds data-only grants.`,
  );
  return { skipped: false };
}

if (require.main === module) {
  runRuntimeRolesSetup().catch((err: unknown) => {
    console.error('runtime-roles-setup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
