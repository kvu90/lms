import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature notifications: trung tâm thông báo.
 */
export default [
  route('notifications', 'routes/notifications.tsx'),
] satisfies RouteConfig;
