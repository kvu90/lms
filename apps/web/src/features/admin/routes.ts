import { type RouteConfig, relative } from '@react-router/dev/routes';

const { prefix, route } = relative(import.meta.dirname);

/**
 * Khu route của feature admin: quản trị người dùng, tenant, vai
 * trò và cấu hình site.
 */
export default [
  ...prefix('admin', [
    route('users', 'routes/admin-users.tsx'),
    route('users/new', 'routes/admin-user-new.tsx'),
    route('users/:userId/edit', 'routes/admin-user-edit.tsx'),
    route('tenants', 'routes/admin-tenants.tsx'),
    route('roles', 'routes/admin-roles.tsx'),
  ]),
] satisfies RouteConfig;

/** Trang cấu hình site của khu quản trị — khai riêng để file gộp ở tầng app giữ đúng thứ tự gốc quanh route liên kết giám hộ của feature guardians. */
export const siteConfigRoutes = [
  route('admin/site-config', 'routes/admin-site-config.tsx'),
] satisfies RouteConfig;
