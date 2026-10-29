/** Route module mỏng: trang dùng câu hỏi nằm chung file questions.tsx. */
export { QuestionUsagePage as default } from '../components/usage-page';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { titleMeta } from '#lib/route-meta';
export function meta() {
  return titleMeta('Mức sử dụng câu hỏi');
}
