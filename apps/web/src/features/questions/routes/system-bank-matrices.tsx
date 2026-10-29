import { QuestionsPage } from '../components/questions';

// Route Ngân hàng ma trận — tab Hệ thống (/system-bank/matrices —
// chuẩn đường dẫn #221, lát R1).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('navMyMatrices');
}

export default function SystemBankMatricesRoute() {
  return <QuestionsPage area="system-matrices" />;
}

// clientLoader (F-01 đợt 1, rà soát #133): prefetch cụm ngân hàng vào QueryClient singleton.
export { questionsPageClientLoader as clientLoader } from '../queries/questions';
