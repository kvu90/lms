/**
 * Helper THUẦN cho việc cấp phát database control plane (issue #580):
 * tách phần suy luận (đọc đích từ URL, dựng câu SQL) khỏi phần thực
 * thi (script `control-plane-setup.ts`) để kiểm chứng bằng unit test
 * không cần database thật.
 *
 * Mô hình cấp phát: control plane có database RIÊNG trên cùng cụm
 * Postgres với kho nghiệp vụ và role kết nối RIÊNG chỉ có quyền trên
 * database đó. URL `CONTROL_PLANE_DATABASE_URL` là nguồn sự thật duy
 * nhất về đích cấp phát (tên database = path, role = username, mật
 * khẩu = password) — script không nhận thêm tham số nào khác ngoài
 * URL quản trị của cụm (dựng từ `DATABASE_URL` của kho nghiệp vụ,
 * trỏ về database `postgres`).
 */

/** Đích cấp phát suy ra từ URL kết nối của control plane. */
export type ControlPlaneTarget = {
  /** Tên database đích (path của URL). */
  database: string;
  /** Tên role kết nối riêng của control plane (username của URL). */
  role: string;
  /** Mật khẩu của role (chỉ dùng khi dựng câu lệnh, không bao giờ ghi log). */
  rolePassword: string;
};

/**
 * Đọc đích cấp phát từ URL của control plane.
 * @throws Error khi URL thiếu tên database hoặc thiếu username — cấu
 * hình sai phải lộ ngay ở bước cấp phát, không chạy tiếp nửa vời.
 */
export function parseControlPlaneTarget(controlPlaneUrl: string): ControlPlaneTarget {
  const parsed = new URL(controlPlaneUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const role = decodeURIComponent(parsed.username);
  if (!database) throw new Error('CONTROL_PLANE_DATABASE_URL must name a database in its path');
  if (!role) throw new Error('CONTROL_PLANE_DATABASE_URL must carry the connection role as username');
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
 * hành: chưa có thì tạo (LOGIN, không thừa hưởng quyền nào khác),
 * đã có thì đồng bộ lại mật khẩu. Chạy lặp an toàn.
 */
export function buildEnsureRoleStatements(target: ControlPlaneTarget, roleExists: boolean): string[] {
  const role = quoteIdentifier(target.role);
  const rolePasswordLiteral = quoteLiteral(target.rolePassword);
  if (!roleExists) {
    return [`CREATE ROLE ${role} LOGIN PASSWORD ${rolePasswordLiteral}`];
  }
  return [`ALTER ROLE ${role} WITH LOGIN PASSWORD ${rolePasswordLiteral}`];
}

/**
 * Các câu lệnh đảm bảo database đích tồn tại và thuộc sở hữu của
 * role control plane. `CREATE DATABASE` không chạy được trong
 * transaction — script thực thi phải chạy từng câu ngoài transaction.
 */
export function buildEnsureDatabaseStatements(target: ControlPlaneTarget, databaseExists: boolean): string[] {
  if (databaseExists) return [];
  return [`CREATE DATABASE ${quoteIdentifier(target.database)} OWNER ${quoteIdentifier(target.role)}`];
}

/**
 * Các câu lệnh khoá quyền kết nối của database control plane: thu
 * hồi quyền kết nối mặc định của PUBLIC rồi chỉ cấp cho role của
 * control plane — mọi role khác (gồm các role của kho nghiệp vụ)
 * không kết nối được vào database này. Chạy lặp an toàn.
 */
export function buildRestrictConnectStatements(target: ControlPlaneTarget): string[] {
  const database = quoteIdentifier(target.database);
  const role = quoteIdentifier(target.role);
  return [
    `REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${database} TO ${role}`,
  ];
}
