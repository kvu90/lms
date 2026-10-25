export { AdminOutcomeNewPage as default } from '../components/admin-curriculum/outcome-pages';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Tạo chuẩn đầu ra');
}
