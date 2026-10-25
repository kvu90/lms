import LegacyQuizRedirect from '../pages/legacy-quiz-redirect';

// Lớp tương thích sau gộp Đề (#226): path cũ /courses/:id/quizzes/*
// chuyển hướng thay thế sang /courses/:id/exams/*. Mỗi route một file
// riêng vì React Router suy id route từ đường dẫn file.
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';

export default LegacyQuizRedirect;
