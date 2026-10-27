/** Route module: trang tìm kiếm nền tảng ở module riêng pages/platform-search.tsx (tách từ platform.tsx — F-10 của #133). */
export { SearchPage as default } from '../pages/platform-search';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { platformKeyMeta } from '../lib/route-meta';
export function meta() {
  return platformKeyMeta('searchTitle');
}
