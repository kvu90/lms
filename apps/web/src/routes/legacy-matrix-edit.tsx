import { LegacyMatrixEditRedirect } from '../components/legacy-bank-redirects';

// Lớp tương thích (chuẩn đường dẫn #221, mục 3.5): path cũ
// /questions/matrices/:matrixId/edit chuyển hướng thay thế sang
// /matrices/:matrixId/edit, giữ nguyên định danh ma trận.
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';

export default LegacyMatrixEditRedirect;
