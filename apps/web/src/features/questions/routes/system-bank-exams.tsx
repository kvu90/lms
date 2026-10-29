import { QuestionsPage } from '../components/questions';

// Route Ngân hàng đề — tab Hệ thống (/system-bank/exams — chuẩn
// đường dẫn #221, lát R1).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('navMyPapers');
}

export default function SystemBankPapersRoute() {
  return <QuestionsPage area="system-exams" />;
}

// clientLoader (F-01 đợt 1, rà soát #133): prefetch cụm ngân hàng vào QueryClient singleton.
export { questionsPageClientLoader as clientLoader } from '../queries/questions';
