import { LegacyExamPaperEditRedirect } from '../components/legacy-bank-redirects';

// Lớp tương thích: path cũ /exam-papers/:paperId/edit chuyển hướng
// thay thế sang /exams/:paperId/edit, giữ nguyên định danh đề.
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';

export default LegacyExamPaperEditRedirect;
