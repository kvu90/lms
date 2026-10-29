export { MatrixEditPage as default } from './question-matrix';

import { curriculumTreeQueryOptions, matrixAvailabilityQueryOptions, matrixDetailQueryOptions } from '../queries/matrix';
import { queryClient } from '#lib/query-client';

/**
 * clientLoader (F-01 đợt 1 + bổ sung clientLoader, rà soát #133):
 * prefetch chi tiết ma trận vào QueryClient singleton (đúng khoá
 * factory) rồi prefetch tiếp cây chương trình + khả dụng như nhịp
 * loadMatrix thủ công trước đây; component vẫn đọc bằng useQuery
 * cùng khoá và tự xử lý khi tải hỏng.
 */
export async function clientLoader({ params }: { params: Record<string, string | undefined> }) {
  if (params.matrixId) {
    const row = await queryClient
      .ensureQueryData(matrixDetailQueryOptions(params.matrixId))
      .catch(() => null);
    await Promise.all([
      row ? queryClient.prefetchQuery(curriculumTreeQueryOptions(row.curriculumId)) : Promise.resolve(),
      queryClient.prefetchQuery(matrixAvailabilityQueryOptions(params.matrixId)),
    ]);
  }
  return null;
}

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { titleMeta } from '#lib/route-meta';
export function meta() {
  return titleMeta('Sửa ma trận');
}
