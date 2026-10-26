import { QuestionsPage } from '../pages/questions';

// Route danh sách Ngân hàng ma trận (/matrices — chuẩn đường dẫn #221,
// lát R1): ma trận là khu vực nghiệp vụ riêng, tách khỏi cây
// /questions. Tạo/sửa ở /matrices/new và /matrices/:matrixId/edit.
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navMyMatrices');
}

export default function MatricesRoute() {
  return <QuestionsPage area="my-matrices" />;
}

// clientLoader (F-01 đợt 1, rà soát #133): prefetch cụm ngân hàng vào QueryClient singleton.
export { questionsPageClientLoader as clientLoader } from "../lib/questions-data";
