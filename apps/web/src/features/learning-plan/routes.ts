import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature learning-plan: trang kế hoạch học tập.
 */
export default [
  route('learning-plan', 'routes/learning-plan.tsx'),
] satisfies RouteConfig;
