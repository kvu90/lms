import { Navigate, useLocation } from 'react-router';

/**
 * Chuyển hướng route cũ sau gộp Đề (#226): /courses/:id/quizzes/:pinId
 * → /courses/:id/exams/:pinId (giữ nguyên hậu tố results/paper) và
 * /exam-papers/* → /exams/*. Giữ tối thiểu 2 chu kỳ phát hành cho
 * bookmark/thông báo đời cũ.
 */
export default function LegacyQuizRedirect() {
  const { pathname, search } = useLocation();
  const next = pathname
    .replace('/quizzes/', '/exams/')
    .replace('/exam-papers/', '/exams/')
    .replace('/exam-papers', '/exams');
  return <Navigate to={`${next}${search}`} replace />;
}
