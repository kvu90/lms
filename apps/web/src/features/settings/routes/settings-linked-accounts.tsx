import { LinkedAccountsCard } from '../components/profile-cards';
import { SettingsShell } from '../components/settings-shell';

/**
 * Mục TÀI KHOẢN LIÊN KẾT của khu Cài đặt (`/settings/linked-accounts`,
 * issue #288): thẻ liên kết OAuth (Google/Facebook) chuyển nguyên
 * trạng từ trang Hồ sơ cũ — ở các site lớn, liên kết bên thứ ba nằm ở
 * khu bảo mật/cài đặt chứ không nằm trong Hồ sơ. Thẻ tự chứa toàn bộ
 * luồng (liệt kê, liên kết thêm qua chuyển hướng tới nhà cung cấp, gỡ
 * liên kết kèm ràng buộc phương thức đăng nhập cuối cùng); trang này
 * chỉ đặt thẻ vào khung Cài đặt.
 */
export function SettingsLinkedAccountsPage() {
  return (
    <SettingsShell>
      <LinkedAccountsCard />
    </SettingsShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default SettingsLinkedAccountsPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('settingsLinkedAccounts');
}
