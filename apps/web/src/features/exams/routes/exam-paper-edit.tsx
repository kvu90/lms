export { ExamPaperEditPage as default } from './exam-paper-editor';

import { examPaperEditPageClientLoader } from '../queries/exam-paper';

/**
 * clientLoader (F-01, rà soát #133): prefetch chi tiết đề + các lần
 * ghim vào QueryClient singleton (đúng khoá factory) trước khi
 * component mount; component vẫn đọc bằng useQuery cùng khoá và tự
 * xử lý khi tải hỏng.
 */
export async function clientLoader({ params }: { params: Record<string, string | undefined> }) {
  if (params.paperId) {
    await examPaperEditPageClientLoader(params.paperId);
  }
  return null;
}

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { titleMeta } from '#lib/route-meta';
export function meta() {
  return titleMeta('Sửa đề');
}
