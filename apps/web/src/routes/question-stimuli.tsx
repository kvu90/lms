import { QuestionsPage } from '../pages/questions';

// Route Ngữ liệu của tôi (/questions/stimuli — chuẩn đường dẫn #221,
// lát R1): cùng module trang ngân hàng, phục vụ đúng khu vực ngữ liệu.
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Ngữ liệu');
}

export default function QuestionStimuliRoute() {
  return <QuestionsPage area="stimuli" />;
}

// clientLoader (F-01 đợt 1, rà soát #133): prefetch cụm ngân hàng vào QueryClient singleton.
export { questionsPageClientLoader as clientLoader } from "../lib/questions-data";
