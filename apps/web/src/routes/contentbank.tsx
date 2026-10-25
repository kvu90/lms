/** Route module mỏng: trang Kho học liệu (CB-1) — danh sách theo không gian, lọc, duyệt, cắm vào khoá. */
export { ContentBankLibraryPage as default } from '../pages/content-bank';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { platformKeyMeta } from '../lib/route-meta';
export function meta() {
  return platformKeyMeta('libraryTitle');
}
