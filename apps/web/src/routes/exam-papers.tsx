import { QuestionsPage } from '../pages/questions';

// Route danh sách Đề của tôi (/exam-papers — chuẩn đường dẫn #221,
// lát R1): trước đây khu vực này núp trong trang /questions dưới dạng
// collapse ?bank=my-papers; nay là trang riêng theo path của chính
// tài nguyên đề. Tạo/sửa vẫn ở /exam-papers/new và
// /exam-papers/:paperId/edit như cũ.
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Đề của tôi');
}

export default function ExamPapersRoute() {
  return <QuestionsPage area="my-papers" />;
}
