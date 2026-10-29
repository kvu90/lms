import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature player: bề mặt học/xem nội dung của học viên.
 */
export default [
  route('courses/:id/learn/:cmId', 'routes/player.tsx'),
] satisfies RouteConfig;
