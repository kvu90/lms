import type { Course, CourseCategoryTreeNode } from '@lms/contracts';
import { apiJson } from '#lib/api';

/**
 * Tầng gọi API thuần của wizard tạo khoá học thuộc feature courses:
 * chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React Query.
 * Tầng `queries/` của feature bọc các hàm này thành queryOptions,
 * hook, đột biến và clientLoader. Tách từ module dữ liệu phẳng
 * `src/lib/course-new-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 *
 * Các danh sách nền giữ đúng nhịp thủ công trước đây: tải hỏng thì
 * coi như danh sách rỗng (bắt lỗi ngay ở tầng này) — wizard không
 * có bề mặt lỗi riêng cho dữ liệu nền, giáo viên vẫn đi tiếp các
 * đường tạo khoá không cần danh sách đó.
 */

/** Tải một danh sách nền của wizard: lỗi thì trả danh sách rỗng như bản thủ công. */
async function probeList<T>(path: string): Promise<T[]> {
  try {
    return await apiJson<T[]>(path);
  } catch {
    return [];
  }
}

/**
 * Đọc cây danh mục khoá cho wizard (GET /courses/categories/tree);
 * lỗi tải → danh sách rỗng.
 *
 * @returns Cây danh mục hoặc danh sách rỗng khi lỗi.
 */
export function fetchWizardCategoryTree() {
  return probeList<CourseCategoryTreeNode>('/api/v1/courses/categories/tree');
}

/**
 * Đọc danh sách khoá hiện có cho wizard (GET /courses) — nguồn cho
 * đường nhân bản; lỗi tải → danh sách rỗng.
 *
 * @returns Danh sách khoá hoặc danh sách rỗng khi lỗi.
 */
export function fetchWizardCourseList() {
  return probeList<Course>('/api/v1/courses');
}

/**
 * Đọc danh sách khoá mẫu tổ/trường cho wizard (GET /courses/templates);
 * lỗi tải → danh sách rỗng.
 *
 * @returns Danh sách khoá mẫu hoặc danh sách rỗng khi lỗi.
 */
export function fetchWizardCourseTemplates() {
  return probeList<Course>('/api/v1/courses/templates');
}

/**
 * Tạo khoá học mới (POST /courses) cho đường khoá trắng và đường
 * khung chương trình.
 *
 * @param body - Thân tạo khoá do wizard dựng.
 * @returns Khoá vừa tạo.
 */
export function createCourse(body: Record<string, unknown>) {
  return apiJson<Course>('/api/v1/courses', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Nhân bản khoá (POST /courses/:id/copy) cho đường nhân bản và
 * đường khoá mẫu — bản sao là nháp, không chứa người học/bài làm.
 *
 * @param input - Khoá nguồn và thân nhân bản.
 * @returns Khoá bản sao vừa tạo.
 */
export function duplicateCourse(input: { fromId: string; body: Record<string, unknown> }) {
  return apiJson<Course>(`/api/v1/courses/${input.fromId}/copy`, {
    method: 'POST',
    body: JSON.stringify(input.body),
  });
}

/**
 * Nạp khung chương trình vào khoá vừa tạo (POST
 * /courses/:id/curriculum-frame).
 *
 * @param input - Khoá đích, khung và các node đã chọn.
 * @returns Đáp ứng của API.
 */
export function applyCurriculumFrame(input: {
  courseId: string;
  curriculumId: string;
  nodeIds: string[];
}) {
  return apiJson(`/api/v1/courses/${input.courseId}/curriculum-frame`, {
    method: 'POST',
    body: JSON.stringify({ curriculumId: input.curriculumId, nodeIds: input.nodeIds }),
  });
}
