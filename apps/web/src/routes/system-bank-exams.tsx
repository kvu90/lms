import { QuestionsPage } from '../pages/questions';

// Route Ngân hàng đề — tab Hệ thống (/system-bank/exams — chuẩn
// đường dẫn #221, lát R1).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navMyPapers');
}

export default function SystemBankPapersRoute() {
  return <QuestionsPage area="system-exams" />;
}
