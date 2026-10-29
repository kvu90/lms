import { Navigate, useLocation } from 'react-router';
import { appKeyMeta } from '#lib/route-meta';
import { QuestionsPage } from '../components/questions';
import { legacyQuestionsTarget } from '../components/legacy-bank-redirects';

/**
 * Route module cho trang Câu hỏi của tôi (/questions): bọc module
 * trang (pages/questions.tsx) để gắn biên lỗi + meta theo route (cụm
 * khung SSR #146, từ rà soát #133), đồng thời là LỚP TƯƠNG THÍCH cho
 * URL cũ dạng ?bank=...&section=... (chuẩn đường dẫn #221, mục 3.5):
 * link cũ khớp thì chuyển hướng thay thế sang path mới của đúng khu
 * vực đó, không render trang tại URL cũ.
 */
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';

export function meta() {
  return appKeyMeta('navQuestions');
}

export default function QuestionsRoute() {
  const location = useLocation();
  const target = legacyQuestionsTarget(location.search);
  if (target) return <Navigate to={target} replace />;
  return <QuestionsPage area="my-questions" />;
}

// clientLoader (F-01 đợt 1, rà soát #133): prefetch cụm ngân hàng vào QueryClient singleton.
export { questionsPageClientLoader as clientLoader } from '../queries/questions';
