/**
 * Script cấp phát database KHO NGÂN HÀNG HỆ THỐNG (issue #585) — chạy ở
 * bước migrate của stack triển khai (xem `compose.yaml`, service
 * `migrate`), TRƯỚC khi chạy bộ migration của kho ngân hàng:
 *
 * 1. Đọc đích cấp phát từ `SYSTEM_BANK_DATABASE_URL` (tên database,
 *    role kết nối riêng, mật khẩu) — xem `system-bank-provision.ts`.
 * 2. Kết nối tới database `postgres` của cụm bằng quyền quản trị:
 *    lấy từ `DATABASE_ADMIN_URL` khi mô hình role đã tách (issue
 *    #586), dự phòng `DATABASE_URL` (chỉ đổi tên database đích
 *    trong URL, giữ nguyên thông tin quản trị của cụm).
 * 3. Đảm bảo role tồn tại (mật khẩu đồng bộ theo URL), database tồn
 *    tại thuộc sở hữu của role đó, và quyền kết nối vào database
 *    kho ngân hàng chỉ thuộc về role đó (thu hồi PUBLIC).
 *
 * Mọi bước đều idempotent: chạy lại ở mỗi lần stack khởi động là an
 * toàn và không đổi dữ kiện. Script KHÔNG tạo bảng — bảng do bộ
 * migration riêng của kho ngân hàng tạo (`drizzle-system-bank`).
 * Chưa cấu hình `SYSTEM_BANK_DATABASE_URL` thì bỏ qua lặng lẽ
 * (thoát 0) để các môi trường chưa dùng kho ngân hàng không gãy —
 * chuỗi migrate trong compose.yaml cũng chỉ chạy bước này và bước
 * migration kho ngân hàng khi biến đã đặt.
 *
 * Mật khẩu chỉ đi từ biến môi trường vào câu lệnh SQL qua kết nối
 * quản trị nội bộ; script không in URL hay mật khẩu ra log.
 */
import { Client } from 'pg';
import {
  buildEnsureDatabaseStatements,
  buildEnsureRoleStatements,
  buildRestrictConnectStatements,
  parseSystemBankTarget,
  quoteIdentifier,
} from './system-bank-provision';

async function main(): Promise<void> {
  const systemBankUrl = process.env.SYSTEM_BANK_DATABASE_URL;
  if (!systemBankUrl) {
    console.log('system-bank-setup: SYSTEM_BANK_DATABASE_URL is not set — skipping provisioning.');
    return;
  }
  const businessUrl = process.env.DATABASE_URL;
  if (!businessUrl) throw new Error('DATABASE_URL is required to derive the cluster admin connection');
  // Kết nối quản trị của cụm: ưu tiên `DATABASE_ADMIN_URL` khi mô
  // hình role đã tách (issue #586); chưa tách thì `DATABASE_URL` vẫn
  // là kết nối quản trị như trước.
  const adminSourceUrl = process.env.DATABASE_ADMIN_URL ?? businessUrl;

  const target = parseSystemBankTarget(systemBankUrl);
  const adminUrl = new URL(adminSourceUrl);
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
      `system-bank-setup: database ${quoteIdentifier(target.database)} and role ${quoteIdentifier(target.role)} are ready.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('system-bank-setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
