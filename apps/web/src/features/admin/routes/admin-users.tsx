import { AdminUsersPage } from '../components/admin-users';
import { adminUsersPageClientLoader } from '../queries/admin-users';

/**
 * Route module của route danh sách người dùng `/admin/users`: giữ
 * phần khung framework của route (export mặc định, clientLoader,
 * ErrorBoundary và meta). Ba màn của cụm người dùng (danh sách,
 * tạo mới, sửa) nằm ở `../components/admin-users` — trước đây cả
 * hai phần chung một file trang `pages/admin-users.tsx`, tách ra
 * khi tổ chức lại apps/web theo mô hình features/ (issue #500).
 * Hai route con tạo/sửa là module riêng (`admin-user-new`,
 * `admin-user-edit`) nhập component tương ứng từ cùng file
 * components đó.
 */

/**
 * clientLoader (F-01, rà soát #133): nạp trước trang danh sách đầu
 * tiên (cỡ trang mặc định, không từ khoá) vào đúng khoá trang dùng.
 */
export async function clientLoader() {
  return adminUsersPageClientLoader();
}

/** Export mặc định cho route module React Router framework mode. */
export default AdminUsersPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('navUsers');
}
