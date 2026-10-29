import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature badges: trang huy hiệu.
 */
export default [
  route('badges', 'routes/badges.tsx'),
] satisfies RouteConfig;
