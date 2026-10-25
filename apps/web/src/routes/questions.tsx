import { appKeyMeta } from '../lib/route-meta';

/**
 * Route module mỏng cho trang Ngân hàng câu hỏi: bọc module trang
 * (pages/questions.tsx) để gắn biên lỗi + meta theo route (cụm khung
 * SSR #146, từ rà soát #133) mà không sửa file trang — cùng khuôn các
 * route module mỏng khác trong thư mục này.
 */
export { default } from '../pages/questions';
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';

export function meta() {
  return appKeyMeta('navQuestions');
}
