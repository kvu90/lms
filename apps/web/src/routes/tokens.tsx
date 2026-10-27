/** Route module: trang tokens nền tảng ở module riêng pages/platform-tokens.tsx (tách từ platform.tsx — F-10 của #133). */
export { TokensPage as default } from '../pages/platform-tokens';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { platformKeyMeta } from '../lib/route-meta';
export function meta() {
  return platformKeyMeta('tokensTitle');
}
