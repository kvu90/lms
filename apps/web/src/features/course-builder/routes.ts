import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature course-builder: trình dựng nội dung khoá.
 */
export default [
  route('courses/:id/builder', 'routes/course-builder.tsx'),
] satisfies RouteConfig;
