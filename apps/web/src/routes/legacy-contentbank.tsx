import { LegacyContentBankRedirect } from '../components/legacy-bank-redirects';

// Lớp tương thích (chuẩn đường dẫn #221, lát R3): path cũ viết dính
// /contentbank chuyển hướng thay thế sang /content-bank.
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';

export default LegacyContentBankRedirect;
