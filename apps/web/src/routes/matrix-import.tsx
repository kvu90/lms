import { curriculumSubjectsQueryOptions, matrixBanksQueryOptions } from '../lib/matrix-data';
import { queryClient } from '../lib/query-client';

/**
 * clientLoader (theo mẫu route ma trận): prefetch bank ma trận + danh
 * sách môn vào QueryClient singleton (đúng khoá factory) trước khi
 * component mount; component vẫn đọc bằng useQuery cùng khoá và tự
 * xử lý khi tải hỏng.
 */
export async function clientLoader() {
  await Promise.all([
    queryClient.prefetchQuery(matrixBanksQueryOptions()),
    queryClient.prefetchQuery(curriculumSubjectsQueryOptions()),
  ]);
  return null;
}

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Nhập ma trận từ file');
}
export { MatrixImportPage as default } from '../pages/matrix-import';
