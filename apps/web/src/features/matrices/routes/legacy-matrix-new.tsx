import { LegacyMatrixNewRedirect } from '#features/questions/components/legacy-bank-redirects';

// Lớp tương thích (chuẩn đường dẫn #221, mục 3.5): path cũ
// /questions/matrices/new chuyển hướng thay thế sang /matrices/new.
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';

export default LegacyMatrixNewRedirect;
