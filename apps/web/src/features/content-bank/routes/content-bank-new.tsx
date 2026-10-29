/**
 * Route module mỏng: màn tạo học liệu riêng của Kho học liệu (CB-1, §9).
 * Trang tạo và trang sửa là cùng một component `ContentBankEditPage`
 * (chế độ suy từ việc có id trên đường dẫn hay không) nên module này
 * dùng lại module màn sửa và chỉ giữ tiêu đề riêng của màn tạo —
 * nhập hai wrapper vào một file sẽ phải nhân đôi toàn bộ trang
 * (ghi nhận ở PR của issue #500).
 */
export { default } from './content-bank-edit';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { platformKeyMeta } from '#lib/route-meta';
export function meta() {
  return platformKeyMeta('libraryFormTitleNew');
}
