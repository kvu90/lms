import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature assignments: chi tiết bài tập của khoá.
 */
export default [
  route('courses/:id/assignments/:assignmentId', 'routes/assignment.tsx'),
] satisfies RouteConfig;
