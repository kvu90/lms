import { LegacyExamPapersRedirect } from '../components/legacy-bank-redirects';

// Lớp tương thích (chuẩn đường dẫn #221 + chốt tên "exams" tối
// 25/10/2026): path cũ /exam-papers chuyển hướng thay thế sang /exams.
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';

export default LegacyExamPapersRedirect;
