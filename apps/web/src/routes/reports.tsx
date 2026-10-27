/** Route module: trang reports nền tảng ở module riêng pages/platform-reports.tsx (tách từ platform.tsx — F-10 của #133). */
export { ReportsPage as default } from '../pages/platform-reports';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { platformKeyMeta } from '../lib/route-meta';
export function meta() {
  return platformKeyMeta('reportsTitle');
}

// clientLoader (F-01, rà soát #133): prefetch danh sách báo cáo vào QueryClient singleton.
export { reportsPageClientLoader as clientLoader } from '../lib/platform-data';
