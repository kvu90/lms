/**
 * Script cấp phát database CONTROL PLANE (issue #580) — chạy ở bước
 * migrate của stack triển khai (xem `compose.yaml`, service
 * `migrate`), TRƯỚC khi chạy bộ migration của control plane:
 *
 * 1. Đọc đích cấp phát từ `CONTROL_PLANE_DATABASE_URL` (tên database,
 *    role kết nối riêng, mật khẩu) — xem `control-plane-provision.ts`.
 * 2. Kết nối tới database `postgres` của cụm bằng quyền quản trị lấy
 *    từ `DATABASE_URL` của kho nghiệp vụ (chỉ đổi tên database đích
 *    trong URL, giữ nguyên thông tin quản trị của cụm).
 * 3. Đảm bảo role tồn tại (mật khẩu đồng bộ theo URL), database tồn
 *    tại thuộc sở hữu của role đó, và quyền kết nối vào database
 *    control plane chỉ thuộc về role đó (thu hồi PUBLIC).
 *
 * Mọi bước đều idempotent: chạy lại ở mỗi lần stack khởi động là an
 * toàn và không đổi dữ kiện. Script KHÔNG tạo bảng — bảng do bộ
 * migration riêng của control plane tạo (`drizzle-control-plane`).
 * Chưa cấu hình `CONTROL_PLANE_DATABASE_URL` thì bỏ qua lặng lẽ
 * (thoát 0) để các môi trường chưa dùng control plane không gãy.
 *
 * Mật khẩu chỉ đi từ biến môi trường vào câu lệnh SQL qua kết nối
 * quản trị nội bộ; script không in URL hay mật khẩu ra log.
 */
import { Client } from 'pg';
import {
  buildEnsureDatabaseStatements,
  buildEnsureRoleStatements,
  buildRestrictConnectStatements,
  parseControlPlaneTarget,
  quoteIdentifier,
} from './control-plane-provision';

async function main(): Promise<void> {
  const controlPlaneUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!controlPlaneUrl) {
    console.log('control-plane-setup: CONTROL_PLANE_DATABASE_URL is not set — skipping provisioning.');
    return;
  }
  const businessUrl = process.env.DATABASE_URL;
  if (!businessUrl) throw new Error('DATABASE_URL is required to reach the cluster admin connection');

  const target = parseControlPlaneTarget(controlPlaneUrl);
  const adminUrl = new URL(businessUrl);
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const roleResult = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [target.role]);
    for (const statement of buildEnsureRoleStatements(target, (roleResult.rowCount ?? 0) > 0)) {
      await client.query(statement);
    }
    const databaseResult = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target.database]);
    for (const statement of buildEnsureDatabaseStatements(target, (databaseResult.rowCount ?? 0) > 0)) {
      // CREATE DATABASE không chạy trong transaction — các câu ở đây
      // được thực thi tuần tự ngoài transaction, đúng yêu cầu đó.
      await client.query(statement);
    }
    for (const statement of buildRestrictConnectStatements(target)) {
      await client.query(statement);
    }
    console.log(
      `control-plane-setup: database ${quoteIdentifier(target.database)} and role ${quoteIdentifier(target.role)} are ready.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('control-plane-setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
