import { QuestionsPage } from '../pages/questions';

// Route Ngân hàng hệ thống — Ma trận (/system-bank/matrices —
// chuẩn đường dẫn #221, lát R1).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Ma trận hệ thống');
}

export default function SystemBankMatricesRoute() {
  return <QuestionsPage area="system-matrices" />;
}

// clientLoader (F-01 đợt 1, rà soát #133): prefetch cụm ngân hàng vào QueryClient singleton.
export { questionsPageClientLoader as clientLoader } from "../lib/questions-data";
