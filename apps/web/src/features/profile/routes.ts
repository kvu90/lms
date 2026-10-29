import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature profile: trang hồ sơ cá nhân.
 */
export default [
  route('profile', 'routes/profile.tsx'),
] satisfies RouteConfig;
