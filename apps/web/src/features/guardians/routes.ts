import { type RouteConfig, relative } from '@react-router/dev/routes';

const { prefix, route } = relative(import.meta.dirname);

/**
 * Khu route của feature guardians: khu vực phụ huynh theo từng
 * con (chuẩn đường dẫn #221, lát R2 — đối tượng chính của khu vực
 * nằm trong path, không định danh bằng ?student=; link cũ dạng
 * /guardian?student=<id> được chính trang guardian chuyển hướng
 * thay thế sang path theo con) và trang quản lý liên kết giám hộ
 * dưới tiền tố /admin.
 */
export default prefix('guardian', [
  route('', 'routes/guardian.tsx'),
  route('students/:studentId', 'routes/guardian-student.tsx'),
]) satisfies RouteConfig;

/**
 * Quản lý liên kết giám hộ phụ huynh–học viên (gói kích hoạt phụ
 * huynh): trang chỉ dành cho người có capability guardian:manage
 * — mục điều hướng gác bằng cờ quyền phía web, mọi endpoint quản
 * lý tự gác lại ở API. Route này thuộc feature guardians nhưng
 * nằm dưới tiền tố /admin nên khai riêng để file gộp giữ đúng vị
 * trí gốc trong khối quản trị.
 */
export const adminGuardianLinksRoutes = [
  route('admin/guardian-links', 'routes/admin-guardian-links.tsx'),
] satisfies RouteConfig;
