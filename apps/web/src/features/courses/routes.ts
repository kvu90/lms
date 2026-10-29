import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature courses: danh sách khoá, tạo khoá, trang khoá và trang quản trị khoá. Các khu con của /courses/:id thuộc feature riêng (course-builder, player, progress-report, grades, quizzes, assignments) khai ở config của chính feature đó.
 */
export default [
  route('courses', 'routes/courses.tsx'),
  route('courses/new', 'routes/course-new.tsx'),
  route('courses/:id', 'routes/course.tsx'),
  route('courses/:id/admin', 'routes/course-admin.tsx'),
] satisfies RouteConfig;
