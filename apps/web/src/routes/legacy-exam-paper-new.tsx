import { LegacyExamPaperNewRedirect } from '../components/legacy-bank-redirects';

// Lớp tương thích: path cũ /exam-papers/new chuyển hướng thay thế
// sang /exams/new, giữ query prefill (vd ?bank=).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';

export default LegacyExamPaperNewRedirect;
