/**
 * Helper THUẦN cho việc cấp phát database kho ngân hàng hệ thống (issue
 * #585): tách phần suy luận (đọc đích từ URL, dựng câu SQL) khỏi phần
 * thực thi (script `system-bank-setup.ts`) để kiểm chứng bằng unit test
 * không cần database thật. Theo mẫu `control-plane-provision.ts` của
 * issue #580.
 *
 * Mô hình cấp phát: kho ngân hàng có database RIÊNG trên cùng cụm
 * Postgres với kho nghiệp vụ và role kết nối RIÊNG chỉ có quyền trên
 * database đó. URL `SYSTEM_BANK_DATABASE_URL` là nguồn sự thật duy nhất
 * về đích cấp phát (tên database = path, role = username, mật khẩu =
 * password) — script không nhận thêm tham số nào khác ngoài URL quản
 * trị của cụm (dựng từ `DATABASE_URL` của kho nghiệp vụ, trỏ về
 * database `postgres`).
 *
 * Cô lập kết nối của role ngân hàng:
 * - Database ngân hàng: thu hồi CONNECT của PUBLIC, chỉ cấp cho role
 *   ngân hàng — mọi role khác không kết nối được vào database này.
 * - Role ngân hàng KHÔNG được cấp CONNECT vào bất kỳ database nghiệp vụ
 *   nào: database nghiệp vụ đã bị khoá chiều ngược bởi
 *   `control-plane-setup` (issue #580) và `runtime-roles-setup` (issue
 *   #586) trong cùng chuỗi migrate — PUBLIC bị thu hồi CONNECT ở đó và
 *   chỉ các role nghiệp vụ mới được cấp lại, nên role ngân hàng (không
 *   nằm trong danh sách cấp) bị từ chối ngay ở bước mở kết nối vào kho
 *   nghiệp vụ. Script này không tự khoá lại phía nghiệp vụ để tránh
 *   hai nơi cùng sở hữu một thao tác khoá.
 * - Role tạo ra không có CREATEDB/CREATEROLE/SUPERUSER (mặc định của
 *   CREATE ROLE khi không khai cờ): dịch vụ đọc câu hỏi không có quyền
 *   tạo database, sửa gói dịch vụ hay đọc dữ kiện của trung tâm.
 */

/** Đích cấp phát suy ra từ URL kết nối của kho ngân hàng. */
export type SystemBankTarget = {
  /** Tên database đích (path của URL). */
  database: string;
  /** Tên role kết nối riêng của kho ngân hàng (username của URL). */
  role: string;
  /** Mật khẩu của role (chỉ dùng khi dựng câu lệnh, không bao giờ ghi log). */
  rolePassword: string;
};

/**
 * Đọc đích cấp phát từ URL của kho ngân hàng.
 * @throws Error khi URL thiếu tên database hoặc thiếu username — cấu
 * hình sai phải lộ ngay ở bước cấp phát, không chạy tiếp nửa vời.
 */
export function parseSystemBankTarget(systemBankUrl: string): SystemBankTarget {
  const parsed = new URL(systemBankUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const role = decodeURIComponent(parsed.username);
  if (!database) throw new Error('SYSTEM_BANK_DATABASE_URL must name a database in its path');
  if (!role) throw new Error('SYSTEM_BANK_DATABASE_URL must carry the connection role as username');
  return { database, role, rolePassword: decodeURIComponent(parsed.password) };
}

/** Bọc một định danh Postgres trong dấu nháy kép, thoát nháy kép bên trong theo đúng cú pháp SQL. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Dựng một literal chuỗi SQL an toàn (thoát nháy đơn) cho các giá trị cấu hình do operator cấp. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Các câu lệnh đảm bảo role đích tồn tại và mật khẩu khớp URL hiện
 * hành: chưa có thì tạo (LOGIN, không thừa hưởng quyền nào khác —
 * không CREATEDB/CREATEROLE/SUPERUSER), đã có thì đồng bộ lại mật khẩu.
 * Chạy lặp an toàn.
 */
export function buildEnsureRoleStatements(target: SystemBankTarget, roleExists: boolean): string[] {
  const role = quoteIdentifier(target.role);
  const rolePasswordLiteral = quoteLiteral(target.rolePassword);
  if (!roleExists) {
    return [`CREATE ROLE ${role} LOGIN PASSWORD ${rolePasswordLiteral}`];
  }
  return [`ALTER ROLE ${role} WITH LOGIN PASSWORD ${rolePasswordLiteral}`];
}

/**
 * Các câu lệnh đảm bảo database đích tồn tại và thuộc sở hữu của
 * role kho ngân hàng. `CREATE DATABASE` không chạy được trong
 * transaction — script thực thi phải chạy từng câu ngoài transaction.
 */
export function buildEnsureDatabaseStatements(target: SystemBankTarget, databaseExists: boolean): string[] {
  if (databaseExists) return [];
  return [`CREATE DATABASE ${quoteIdentifier(target.database)} OWNER ${quoteIdentifier(target.role)}`];
}

/**
 * Các câu lệnh khoá quyền kết nối của database kho ngân hàng: thu
 * hồi quyền kết nối mặc định của PUBLIC rồi chỉ cấp cho role của
 * kho ngân hàng — mọi role khác (gồm các role của kho nghiệp vụ)
 * không kết nối được vào database này. Chạy lặp an toàn.
 */
export function buildRestrictConnectStatements(target: SystemBankTarget): string[] {
  const database = quoteIdentifier(target.database);
  const role = quoteIdentifier(target.role);
  return [
    `REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${database} TO ${role}`,
  ];
}
