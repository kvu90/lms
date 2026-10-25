import { QuestionsPage } from '../pages/questions';

// Route Ngân hàng hệ thống — Đề (/system-bank/papers — chuẩn đường
// dẫn #221, lát R1).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Đề hệ thống');
}

export default function SystemBankPapersRoute() {
  return <QuestionsPage area="system-papers" />;
}
