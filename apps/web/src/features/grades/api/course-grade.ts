import { apiJson } from '#lib/api';
import type { GradeHistoryView } from '../types/course-grade';

/**
 * Tầng gọi API thuần của trang bảng điểm thuộc feature grades:
 * chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React
 * Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/course-grade-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500). Fetcher điểm dùng chung nhiều bề
 * mặt nằm ở `src/hooks/use-courses-grade-data.ts`.
 */

/**
 * Đọc lịch sử điểm của một học viên trên một mục điểm
 * (GET /grade-items/:itemId/users/:userId/history).
 *
 * @param itemId - Định danh mục điểm.
 * @param userId - Định danh học viên.
 * @returns Danh sách dòng lịch sử điểm.
 */
export function fetchGradeItemHistory(itemId: string, userId: string) {
  return apiJson<GradeHistoryView[]>(`/api/v1/grade-items/${itemId}/users/${userId}/history`);
}

/**
 * Nhập/sửa điểm một bài cho một học sinh (POST /grade-items/:itemId/grades).
 *
 * @param vars - Mục điểm, học sinh, điểm và phản hồi (khi có).
 * @returns Đáp ứng của API.
 */
export function submitGrade(vars: {
  gradeItemId: string;
  userId: string;
  rawGrade: number | null;
  feedback?: string;
}) {
  return apiJson(`/api/v1/grade-items/${vars.gradeItemId}/grades`, {
    method: 'POST',
    body: JSON.stringify({
      userId: vars.userId,
      rawGrade: vars.rawGrade,
      ...(vars.feedback ? { feedback: vars.feedback } : {}),
    }),
  });
}

/**
 * Tạo mục điểm nhập tay mới cho khoá (POST /courses/:id/grade-items).
 *
 * @param courseId - Định danh khoá.
 * @param vars - Tên mục và thang điểm.
 * @returns Đáp ứng của API.
 */
export function createGradeItem(courseId: string, vars: { itemName: string; gradeMax: number }) {
  return apiJson(`/api/v1/courses/${courseId}/grade-items`, {
    method: 'POST',
    body: JSON.stringify(vars),
  });
}

/**
 * Lưu sửa tên/thang điểm của một mục (PATCH /grade-items/:id).
 *
 * @param vars - Định danh mục, tên và thang điểm mới.
 * @returns Đáp ứng của API.
 */
export function updateGradeItem(vars: { itemId: string; itemName: string; gradeMax: number }) {
  return apiJson(`/api/v1/grade-items/${vars.itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ itemName: vars.itemName, gradeMax: vars.gradeMax }),
  });
}

/**
 * Xoá một mục điểm và mọi điểm của nó (DELETE /grade-items/:id).
 *
 * @param itemId - Định danh mục điểm.
 * @returns Đáp ứng của API.
 */
export function deleteGradeItem(itemId: string) {
  return apiJson(`/api/v1/grade-items/${itemId}`, { method: 'DELETE' });
}

/**
 * Đặt chính sách công bố của một bài (PUT /grade-items/:id/posting-policy).
 *
 * @param vars - Định danh mục và chính sách.
 * @returns Đáp ứng của API.
 */
export function setGradePostingPolicy(vars: { itemId: string; policy: 'auto' | 'manual' }) {
  return apiJson(`/api/v1/grade-items/${vars.itemId}/posting-policy`, {
    method: 'PUT',
    body: JSON.stringify({ policy: vars.policy }),
  });
}

/**
 * Công bố/thu hồi công bố điểm của một bài (POST .../publish | .../unpublish).
 *
 * @param vars - Định danh mục và trạng thái công bố muốn đặt.
 * @returns Đáp ứng của API.
 */
export function setGradeItemPublished(vars: { itemId: string; published: boolean }) {
  return apiJson(`/api/v1/grade-items/${vars.itemId}/${vars.published ? 'publish' : 'unpublish'}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
