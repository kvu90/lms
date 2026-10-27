/** Route module: trang tokens nền tảng ở module riêng pages/platform-tokens.tsx (tách từ platform.tsx — F-10 của #133). */
export { TokensPage as default } from '../pages/platform-tokens';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { platformKeyMeta } from '../lib/route-meta';
export function meta() {
  return platformKeyMeta('tokensTitle');
}

// clientLoader (F-01, rà soát #133): prefetch danh sách dịch vụ + token vào QueryClient singleton.
export { tokensPageClientLoader as clientLoader } from '../lib/platform-data';
