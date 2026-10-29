import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature exams: cây Đề — tên tài nguyên chốt là "exams" (quyết định tối 25/10/2026, bỏ hậu tố "papers"); cây cũ /exam-papers* giữ làm lớp tương thích chuyển hướng thay thế.
 */
export default [
  route('exams/new', 'routes/exam-paper-new.tsx'),
  route('exams/:paperId/edit', 'routes/exam-paper-edit.tsx'),
  route('exam-papers', 'routes/legacy-exam-papers.tsx'),
  route('exam-papers/new', 'routes/legacy-exam-paper-new.tsx'),
  route('exam-papers/:paperId/edit', 'routes/legacy-exam-paper-edit.tsx'),
] satisfies RouteConfig;
