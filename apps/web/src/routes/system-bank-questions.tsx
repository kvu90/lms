import { QuestionsPage } from '../pages/questions';

// Route Ngân hàng câu hỏi — tab Hệ thống (/system-bank/questions —
// chuẩn đường dẫn #221, lát R1).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navQuestions');
}

export default function SystemBankQuestionsRoute() {
  return <QuestionsPage area="system-questions" />;
}

// clientLoader (F-01 đợt 1, rà soát #133): prefetch cụm ngân hàng vào QueryClient singleton.
export { questionsPageClientLoader as clientLoader } from "../lib/questions-data";
