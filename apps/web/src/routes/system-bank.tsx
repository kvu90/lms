import { SystemBankIndexRedirect } from '../components/legacy-bank-redirects';

// Gốc khu hệ thống (/system-bank — chuẩn đường dẫn #221):
// không có trang riêng, tự chuyển hướng tới Ngân hàng câu hỏi —
// tab Hệ thống.
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navQuestions');
}

export default SystemBankIndexRedirect;
