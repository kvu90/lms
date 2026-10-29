import type { Course, CourseCategoryTreeNode } from '@lms/contracts';
import { apiJson } from '#lib/api';

/**
 * Tầng gọi API thuần của danh sách khoá học thuộc feature courses:
 * chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React Query.
 * Tầng `queries/` của feature bọc các hàm này thành queryOptions,
 * đột biến và clientLoader. Tách từ module dữ liệu phẳng
 * `src/lib/courses-data.ts` khi tổ chức lại apps/web theo mô hình
 * features/ (issue #500).
 */

/**
 * Đọc cây danh mục khoá (GET /courses/categories/tree).
 *
 * @returns Cây danh mục khoá.
 */
export function fetchCourseCategoryTree() {
  return apiJson<CourseCategoryTreeNode[]>('/api/v1/courses/categories/tree');
}

/**
 * Đọc danh sách toàn bộ khoá học (GET /courses).
 *
 * @returns Danh sách khoá học.
 */
export function fetchCourses() {
  return apiJson<Course[]>('/api/v1/courses');
}

/**
 * Đọc % tiến độ học của chính người dùng cho một khoá
 * (GET /courses/:id/progress/me).
 *
 * @param courseId - Định danh khoá.
 * @returns Phần trăm tiến độ (null khi server không tính được).
 */
export function fetchCourseMyProgress(courseId: string) {
  return apiJson<{ percent: number | null }>(`/api/v1/courses/${courseId}/progress/me`);
}

/**
 * Tạo danh mục khoá (POST /courses/categories).
 *
 * @param body - Tên danh mục và danh mục cha (khi có).
 * @returns Đáp ứng của API.
 */
export function createCourseCategory(body: { name: string; parent?: string }) {
  return apiJson('/api/v1/courses/categories', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Đổi tên danh mục khoá (PATCH /courses/categories/:id).
 *
 * @param input - Định danh danh mục và tên mới.
 * @returns Đáp ứng của API.
 */
export function renameCourseCategory(input: { categoryId: string; name: string }) {
  return apiJson(`/api/v1/courses/categories/${input.categoryId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: input.name }),
  });
}

/**
 * Xoá danh mục khoá (DELETE /courses/categories/:id).
 *
 * @param categoryId - Định danh danh mục.
 * @returns Đáp ứng của API.
 */
export function deleteCourseCategory(categoryId: string) {
  return apiJson(`/api/v1/courses/categories/${categoryId}`, { method: 'DELETE' });
}
