import { Navigate } from 'react-router';

/**
 * Route gốc của khu Cài đặt (`/settings`, issue #288): không có nội
 * dung riêng — chuyển hướng THAY THẾ (replace, không để lại mục lịch
 * sử thừa) tới mục đầu tiên của khu là Bảo mật, đúng cách các site
 * lớn mở thẳng mục đầu khi người dùng vào gốc khu cài đặt.
 */
export function SettingsIndexPage() {
  return <Navigate to="/settings/security" replace />;
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default SettingsIndexPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navSettings');
}
