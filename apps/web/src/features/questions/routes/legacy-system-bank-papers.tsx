import { LegacySystemBankPapersRedirect } from '../components/legacy-bank-redirects';

// Lớp tương thích: path /system-bank/papers (dạng trung gian trong
// lát R1) chuyển hướng thay thế sang /system-bank/exams — tên tài
// nguyên chốt là "exams" (quyết định tối 25/10/2026).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';

export default LegacySystemBankPapersRedirect;
