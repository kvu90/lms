/**
 * Route module cho path theo từng học sinh của khu vực phụ huynh
 * (chuẩn đường dẫn #221, lát R2): dùng chung trang guardian với
 * route gốc — con đang xem do tham số :studentId của path quyết
 * định. Phải là module riêng vì cấu hình route không cho hai path
 * dùng chung một route module (id route suy ra từ file).
 */
export { GuardianPage as default } from '../pages/guardian';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { guardianKeyMeta } from '../lib/route-meta';
export function meta() {
  return guardianKeyMeta('title');
}
