import { type RouteConfig, relative } from '@react-router/dev/routes';

const { prefix, route } = relative(import.meta.dirname);

/**
 * Khu route của feature settings — Khu Cài đặt cá nhân (issue #288):
 * gốc chuyển hướng về mục đầu (Bảo mật); ba mục có path riêng, điều
 * hướng bằng menu trái trong khung settings-shell — không dùng
 * query định danh khu vực.
 */
export default prefix('settings', [
  route('', 'routes/settings-index.tsx'),
  route('security', 'routes/settings-security.tsx'),
  route('linked-accounts', 'routes/settings-linked-accounts.tsx'),
  route('notifications', 'routes/settings-notifications.tsx'),
]) satisfies RouteConfig;
