import { QuestionsPage } from '../components/questions';

// Route danh sách Ngân hàng đề (/exams — chuẩn đường dẫn #221,
// lát R1): trước đây khu vực này núp trong trang /questions dưới dạng
// collapse ?bank=my-papers; nay là trang riêng theo path của chính
// tài nguyên đề — tên tài nguyên là "exams" (quyết định tối
// 25/10/2026, bỏ hậu tố "papers"). Tạo/sửa ở /exams/new và
// /exams/:paperId/edit; path cũ /exam-papers* có lớp tương thích
// chuyển hướng (routes/legacy-exam-papers*.tsx).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('navMyPapers');
}

export default function ExamsRoute() {
  return <QuestionsPage area="my-exams" />;
}

// clientLoader (F-01 đợt 1, rà soát #133): prefetch cụm ngân hàng vào QueryClient singleton.
export { questionsPageClientLoader as clientLoader } from '../queries/questions';
