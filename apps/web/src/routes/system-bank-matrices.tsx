import { QuestionsPage } from '../pages/questions';

// Route Ngân hàng ma trận — tab Hệ thống (/system-bank/matrices —
// chuẩn đường dẫn #221, lát R1).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navMyMatrices');
}

export default function SystemBankMatricesRoute() {
  return <QuestionsPage area="system-matrices" />;
}
