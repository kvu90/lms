import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature grades: bảng điểm của khoá.
 */
export default [
  route('courses/:id/grades', 'routes/grades.tsx'),
] satisfies RouteConfig;
