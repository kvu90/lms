import { SystemBankIndexRedirect } from '../components/legacy-bank-redirects';

// Gốc Ngân hàng hệ thống (/system-bank — chuẩn đường dẫn #221):
// không có trang riêng, tự chuyển hướng tới Câu hỏi hệ thống.
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Ngân hàng hệ thống');
}

export default SystemBankIndexRedirect;
