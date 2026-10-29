import { type RouteConfig, relative } from '@react-router/dev/routes';

const { prefix, route } = relative(import.meta.dirname);

/**
 * Khu route của feature classes — Lớp học (CLASS-1, issue #184):
 * danh sách/tạo màn riêng, tự báo danh, chi tiết lớp (roster) và
 * sửa lớp — 'new'/'join' khai trước ':id' để không bị nuốt; trang
 * công khai mua gói học phí của lớp (CLASS-3, issue #184) là route
 * ':id/public'.
 */
export default prefix('classes', [
  route('', 'routes/classes.tsx'),
  route('new', 'routes/class-new.tsx'),
  route('join', 'routes/class-join.tsx'),
  route(':id', 'routes/class-detail.tsx'),
  route(':id/edit', 'routes/class-edit.tsx'),
  route(':id/public', 'routes/class-public.tsx'),
]) satisfies RouteConfig;
