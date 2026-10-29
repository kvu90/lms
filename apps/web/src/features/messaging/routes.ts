import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature messaging: trang Tin nhắn.
 */
export default [
  route('messages', 'routes/messages.tsx'),
] satisfies RouteConfig;
