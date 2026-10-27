/** Route module: trang privacy nền tảng ở module riêng pages/platform-privacy.tsx (tách từ platform.tsx — F-10 của #133). */
export { PrivacyPage as default } from '../pages/platform-privacy';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { platformKeyMeta } from '../lib/route-meta';
export function meta() {
  return platformKeyMeta('privacyTitle');
}
