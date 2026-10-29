import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature progress-report: báo cáo tiến độ của khoá.
 */
export default [
  route('courses/:id/progress', 'routes/progress-report.tsx'),
] satisfies RouteConfig;
