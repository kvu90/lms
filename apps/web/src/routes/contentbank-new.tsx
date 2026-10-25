/** Route module mỏng: màn tạo học liệu riêng của Kho học liệu (CB-1, §9). */
export { ContentBankEditPage as default } from '../pages/content-bank-edit';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { platformKeyMeta } from '../lib/route-meta';
export function meta() {
  return platformKeyMeta('libraryFormTitleNew');
}
