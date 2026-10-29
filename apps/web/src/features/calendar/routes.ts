import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature calendar: trang lịch.
 */
export default [
  route('calendar', 'routes/calendar.tsx'),
] satisfies RouteConfig;
