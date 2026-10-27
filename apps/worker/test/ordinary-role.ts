/**
 * Harness role DB thường dùng chung cho các spec worker đụng RLS/tenant
 * (issue #294 — tổng quát hoá ca hồi quy #292).
 *
 * Vấn đề nền: toàn bộ suite worker mặc định chạy bằng user `postgres`
 * superuser (xem env trong `vitest.config.ts`). Superuser có BYPASSRLS
 * nên mọi lỗi "quên gắn ngữ cảnh tenant" đều vô hình trong test, trong
 * khi production chạy bằng role ứng dụng không BYPASSRLS và RLS
 * fail-closed nuốt dữ liệu lặng lẽ — đúng lớp lỗi đã sinh ra issue
 * #292 (job đối soát ghi danh lớp đọc 0 lớp mà vẫn báo thành công).
 *
 * Harness này cho spec một đường dựng thống nhất:
 *
 *   1. Fixture vẫn nạp bằng kết nối quản trị (`DATABASE_URL` mặc định
 *      của suite, superuser) — đúng hình dạng đường seed production.
 *   2. Phần xử lý cần kiểm chứng chạy bằng kết nối đăng nhập role
 *      thường do {@link ensureOrdinaryRole} dựng: `NOSUPERUSER
 *      NOBYPASSRLS NOCREATEDB NOCREATEROLE`, chỉ có quyền trên schema
 *      `public` (USAGE + ALL trên bảng/sequence hiện hữu) — đúng quyền
 *      tối thiểu của role ứng dụng, không hơn.
 *   3. Spec luôn có ca chiều âm (ngoài ngữ cảnh tenant, role thường
 *      không thấy dữ liệu) để chứng minh harness thật sự chịu RLS —
 *      thiếu ca này thì việc chuyển role không có giá trị kiểm chứng.
 *
 * Bất biến:
 *   - Role là đối tượng cấp cụm Postgres: tạo phải idempotent, nhiều
 *     spec chạy nối tiếp/song song trên cùng cụm không được vỡ vì role
 *     đã tồn tại.
 *   - Grant chỉ chạy trên các bảng/sequence ĐÃ có tại thời điểm dựng;
 *     trong CI, bước migrate DB test từ trống chạy trước suite nên mọi
 *     bảng đã tồn tại khi harness chạy.
 *   - Harness không đổi URL quản trị và không đụng cách ly DB của
 *     suite (`lms_test_worker` riêng, tách khỏi `lms_test_api`).
 */
import { Client } from 'pg';

/** Tên role ứng dụng dùng chung cho mọi spec worker chạy dưới RLS. */
export const ORDINARY_ROLE = 'lms_worker_ordinary';

/** Mật khẩu của role thường — chỉ dùng trong môi trường test local/CI. */
export const ORDINARY_ROLE_PASSWORD = 'lms-worker-ordinary-test-password';

/**
 * Lấy URL kết nối quản trị của suite worker từ env.
 *
 * @returns URL trong `DATABASE_URL` (vitest config gán, mặc định trỏ
 *   `lms_test_worker` bằng superuser — chỉ dùng để nạp fixture và dựng
 *   role, không dùng để chạy phần xử lý cần kiểm chứng RLS).
 * @throws Error khi env chưa được đặt (suite chạy ngoài vitest config).
 */
export function adminDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL chưa được đặt cho suite worker');
  return url;
}

/**
 * Dựng role thường (idempotent) và cấp quyền tối thiểu trên schema
 * `public` của DB test.
 *
 * Flow: kết nối bằng URL quản trị → tạo role nếu chưa có (khối DO bắt
 * `duplicate_object`) → ALTER để bảo đảm thuộc tính role luôn đúng dù
 * role được tạo từ lượt chạy cũ → GRANT USAGE schema + ALL trên mọi
 * bảng/sequence hiện hữu cho role.
 *
 * @param adminUrl URL kết nối quản trị (superuser) của DB test.
 */
export async function ensureOrdinaryRole(adminUrl: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `DO $$ BEGIN CREATE ROLE ${ORDINARY_ROLE} LOGIN PASSWORD '${ORDINARY_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    );
    await admin.query(
      `ALTER ROLE ${ORDINARY_ROLE} WITH LOGIN PASSWORD '${ORDINARY_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ORDINARY_ROLE}`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ORDINARY_ROLE}`);
    await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ORDINARY_ROLE}`);
  } finally {
    await admin.end();
  }
}

/**
 * Sinh URL kết nối đăng nhập bằng role thường từ URL quản trị.
 *
 * Chỉ thay thông tin đăng nhập, giữ nguyên host/cổng/tên DB — kết nối
 * vẫn vào đúng DB test của suite, chỉ khác quyền của role.
 *
 * @param adminUrl URL kết nối quản trị của DB test.
 * @returns URL kết nối bằng {@link ORDINARY_ROLE}.
 */
export function ordinaryRoleUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = ORDINARY_ROLE;
  url.password = ORDINARY_ROLE_PASSWORD;
  return url.toString();
}
