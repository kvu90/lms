import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature curriculum: trang xem bảng chương trình GDPT theo mẫu Bộ cho GIÁO VIÊN (issue #161, lát T2) — chỉ xem, đọc qua ngữ cảnh khoá giáo viên dạy.
 */
export default [
  route('curriculum', 'routes/teacher-curriculum.tsx'),
] satisfies RouteConfig;
