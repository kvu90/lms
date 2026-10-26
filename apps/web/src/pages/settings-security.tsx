import { SessionsCard, TwoFactorCard } from '../components/profile-cards';
import { SettingsShell } from '../components/settings-shell';

/**
 * Mục BẢO MẬT & ĐĂNG NHẬP của khu Cài đặt (`/settings/security`,
 * issue #288): chứa hai thẻ tự chứa chuyển nguyên trạng từ trang Hồ
 * sơ cũ — xác thực hai lớp TOTP (`TwoFactorCard`) và phiên đăng nhập
 * (`SessionsCard`). Đây là mục đầu của khu Cài đặt và là đích
 * redirect của `/settings`, đúng mẫu các site lớn vào thẳng mục bảo
 * mật đầu tiên.
 *
 * Trang này không có luồng dữ liệu riêng: mỗi thẻ tự nạp dữ liệu và
 * tự xử lý đột biến (xem `components/profile-cards.tsx`). Khối đổi
 * mật khẩu KHÔNG nằm ở lát này — Lão gia chốt để lát riêng.
 */
export function SettingsSecurityPage() {
  return (
    <SettingsShell>
      <TwoFactorCard />
      <SessionsCard />
    </SettingsShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default SettingsSecurityPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('settingsSecurity');
}
