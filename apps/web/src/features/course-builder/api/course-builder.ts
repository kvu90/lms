import type { Course, CourseContent, CourseGroup, CourseGrouping, GradeItem } from '@lms/contracts';
import { apiJson } from '#lib/api';
import type { BuilderBody, BuilderCriteriaView, CourseBuilderData } from '../types/course-builder';

/**
 * Tầng gọi API thuần của trang xây dựng khoá học thuộc feature
 * course-builder: chỉ chứa các hàm gọi HTTP và gói tải tổng hợp
 * của trang, không phụ thuộc React hay React Query. Tầng
 * `queries/` của feature bọc các hàm này thành queryOptions, hook
 * và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/course-builder-data.ts` khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500).
 */

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Tải gói dữ liệu trang builder: tải song song đúng nhịp reload()
 * thủ công trước đây — mỗi endpoint có bắt lỗi riêng (lỗi thì
 * null/rỗng, không sập cả trang).
 *
 * @param courseId - Định danh khoá.
 * @returns Gói dữ liệu trang builder.
 */
export async function fetchCourseBuilder(courseId: string): Promise<CourseBuilderData> {
  const [course, content, gradeItems, criteria, groups, groupings] = await Promise.all([
    probe<Course>(`/api/v1/courses/${courseId}`),
    probe<CourseContent>(`/api/v1/courses/${courseId}/content`),
    probe<GradeItem[]>(`/api/v1/courses/${courseId}/grade-items`),
    probe<BuilderCriteriaView>(`/api/v1/courses/${courseId}/completion/criteria`),
    probe<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`),
    probe<CourseGrouping[]>(`/api/v1/courses/${courseId}/groupings`),
  ]);
  return {
    course,
    content,
    gradeItems: gradeItems ?? [],
    criteria,
    groups: groups ?? [],
    groupings: groupings ?? [],
  };
}

/**
 * Đọc danh sách toàn bộ khoá học (khoá nguồn dùng lại nội dung ở
 * trang builder); lỗi tải → rỗng như trước.
 *
 * @returns Danh sách khoá hoặc rỗng khi lỗi.
 */
export async function fetchBuilderCourseList() {
  return (await probe<Course[]>('/api/v1/courses')) ?? [];
}

/**
 * Đọc nội dung của khoá nguồn đang chọn để dùng lại; lỗi → null.
 *
 * @param courseId - Định danh khoá nguồn.
 * @returns Nội dung khoá hoặc null.
 */
export function fetchCourseContent(courseId: string) {
  return probe<CourseContent>(`/api/v1/courses/${courseId}/content`);
}

/**
 * Lưu thông tin khoá (PATCH /courses/:id).
 *
 * @param courseId - Định danh khoá.
 * @param body - Thân ghi do trang dựng.
 * @returns Đáp ứng của API.
 */
export function saveBuilderCourse(courseId: string, body: BuilderBody) {
  return apiJson(`/api/v1/courses/${courseId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/**
 * Tạo section (POST /courses/:id/sections).
 *
 * @param courseId - Định danh khoá.
 * @param body - Thân tạo section.
 * @returns Đáp ứng của API.
 */
export function createBuilderSection(courseId: string, body: BuilderBody) {
  return apiJson(`/api/v1/courses/${courseId}/sections`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Lưu section (PATCH /courses/:id/sections/:sectionId) — dùng cho
 * cả tên/trạng thái mở lẫn điều kiện availability.
 *
 * @param courseId - Định danh khoá.
 * @param vars - Định danh section và thân ghi.
 * @returns Đáp ứng của API.
 */
export function saveBuilderSection(
  courseId: string,
  vars: { sectionId: string; body: BuilderBody },
) {
  return apiJson(`/api/v1/courses/${courseId}/sections/${vars.sectionId}`, {
    method: 'PATCH',
    body: JSON.stringify(vars.body),
  });
}

/**
 * Xoá section (DELETE /courses/:id/sections/:sectionId).
 *
 * @param courseId - Định danh khoá.
 * @param sectionId - Định danh section.
 * @returns Đáp ứng của API.
 */
export function deleteBuilderSection(courseId: string, sectionId: string) {
  return apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}`, { method: 'DELETE' });
}

/**
 * Nhân bản section (POST /courses/:id/sections/:sectionId/copy).
 *
 * @param courseId - Định danh khoá.
 * @param sectionId - Định danh section.
 * @returns Đáp ứng của API.
 */
export function duplicateBuilderSection(courseId: string, sectionId: string) {
  return apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}/copy`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Đổi thứ tự section (POST /courses/:id/reorder-sections, gửi đủ
 * mọi section theo thứ tự mới).
 *
 * @param courseId - Định danh khoá.
 * @param sectionIds - Thứ tự section mới.
 * @returns Đáp ứng của API.
 */
export function reorderBuilderSections(courseId: string, sectionIds: string[]) {
  return apiJson(`/api/v1/courses/${courseId}/reorder-sections`, {
    method: 'POST',
    body: JSON.stringify({ sectionIds }),
  });
}

/**
 * Đổi thứ tự module trong một section (POST
 * /courses/:id/sections/:sectionId/reorder-modules).
 *
 * @param courseId - Định danh khoá.
 * @param vars - Định danh section và thứ tự module mới.
 * @returns Đáp ứng của API.
 */
export function reorderBuilderModules(
  courseId: string,
  vars: { sectionId: string; moduleIds: string[] },
) {
  return apiJson(`/api/v1/courses/${courseId}/sections/${vars.sectionId}/reorder-modules`, {
    method: 'POST',
    body: JSON.stringify({ moduleIds: vars.moduleIds }),
  });
}

/**
 * Tạo đề + ghim vào khoá (POST /courses/:id/exam-pins dạng newExam).
 *
 * @param courseId - Định danh khoá.
 * @param vars - Section đích và tên đề.
 * @returns Id lần ghim để điều hướng.
 */
export function createBuilderExamPin(
  courseId: string,
  vars: { sectionId: string; name: string },
) {
  return apiJson<{ id: string }>(`/api/v1/courses/${courseId}/exam-pins`, {
    method: 'POST',
    body: JSON.stringify({ sectionId: vars.sectionId, newExam: { name: vars.name } }),
  });
}

/**
 * Tạo bài tập trong khoá (POST /courses/:id/assignments).
 *
 * @param courseId - Định danh khoá.
 * @param vars - Section đích và tên bài tập.
 * @returns Id bài tập để điều hướng.
 */
export function createBuilderAssignment(
  courseId: string,
  vars: { sectionId: string; name: string },
) {
  return apiJson<{ id: string }>(`/api/v1/courses/${courseId}/assignments`, {
    method: 'POST',
    body: JSON.stringify({ sectionId: vars.sectionId, name: vars.name }),
  });
}

/**
 * Thêm module nội dung vào section (POST /courses/:id/modules).
 *
 * @param courseId - Định danh khoá.
 * @param body - Thân tạo module.
 * @returns Đáp ứng của API.
 */
export function createBuilderModule(courseId: string, body: BuilderBody) {
  return apiJson(`/api/v1/courses/${courseId}/modules`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Lưu module (PATCH /courses/:id/modules/:cmId) — dùng cho cả
 * tên/trạng thái mở lẫn availability.
 *
 * @param courseId - Định danh khoá.
 * @param vars - Định danh module và thân ghi.
 * @returns Đáp ứng của API.
 */
export function saveBuilderModule(courseId: string, vars: { cmId: string; body: BuilderBody }) {
  return apiJson(`/api/v1/courses/${courseId}/modules/${vars.cmId}`, {
    method: 'PATCH',
    body: JSON.stringify(vars.body),
  });
}

/**
 * Xoá module (DELETE /courses/:id/modules/:cmId).
 *
 * @param courseId - Định danh khoá.
 * @param cmId - Định danh module.
 * @returns Đáp ứng của API.
 */
export function deleteBuilderModule(courseId: string, cmId: string) {
  return apiJson(`/api/v1/courses/${courseId}/modules/${cmId}`, { method: 'DELETE' });
}

/**
 * Nhân bản module (POST /courses/:id/modules/:cmId/copy).
 *
 * @param courseId - Định danh khoá.
 * @param cmId - Định danh module.
 * @returns Đáp ứng của API.
 */
export function duplicateBuilderModule(courseId: string, cmId: string) {
  return apiJson(`/api/v1/courses/${courseId}/modules/${cmId}/copy`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Dùng lại nội dung từ khoá khác (POST /courses/:id/import-content
 * với các section/module đã tích chọn).
 *
 * @param courseId - Định danh khoá đích.
 * @param body - Thân chọn nội dung.
 * @returns Đáp ứng của API.
 */
export function importBuilderContent(courseId: string, body: BuilderBody) {
  return apiJson(`/api/v1/courses/${courseId}/import-content`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Lưu tiêu chí hoàn thành của khoá (PUT /courses/:id/completion/criteria).
 *
 * @param courseId - Định danh khoá.
 * @param body - Thân tiêu chí.
 * @returns Đáp ứng của API.
 */
export function saveBuilderCriteria(courseId: string, body: BuilderBody) {
  return apiJson(`/api/v1/courses/${courseId}/completion/criteria`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * Tính lại hoàn thành cho toàn khoá (POST /courses/:id/completion/recalculate).
 *
 * @param courseId - Định danh khoá.
 * @returns Đáp ứng của API.
 */
export function recalculateBuilderCompletion(courseId: string) {
  return apiJson(`/api/v1/courses/${courseId}/completion/recalculate`, { method: 'POST' });
}

/**
 * Lưu môn/khối của khoá (PATCH /courses/:id với subjectId + grade)
 * — panel "Thêm từ khung" của trình xây dựng khoá.
 *
 * @param input - Khoá, môn và khối muốn đặt.
 * @returns Đáp ứng của API.
 */
export function updateCourseFrameInfo(input: {
  courseId: string;
  subjectId: string | null;
  grade: number | null;
}) {
  return apiJson(`/api/v1/courses/${input.courseId}`, {
    method: 'PATCH',
    body: JSON.stringify({ subjectId: input.subjectId, grade: input.grade }),
  });
}

/**
 * Nạp các đơn vị khung chương trình đã chọn vào khoá (POST
 * /courses/:id/curriculum-frame) — panel "Thêm từ khung".
 *
 * @param input - Khoá đích, khung, các node đã chọn và vị trí chèn (khi có).
 * @returns Các section đã tạo.
 */
export function applyCurriculumFrame(input: {
  courseId: string;
  curriculumId: string;
  nodeIds: string[];
  insertAtSection?: number;
}) {
  return apiJson<{ sections: unknown[] }>(`/api/v1/courses/${input.courseId}/curriculum-frame`, {
    method: 'POST',
    body: JSON.stringify({
      curriculumId: input.curriculumId,
      nodeIds: input.nodeIds,
      ...(input.insertAtSection !== undefined ? { insertAtSection: input.insertAtSection } : {}),
    }),
  });
}

/**
 * Nạp các chủ đề SGK đã chọn vào khoá (POST /courses/:id/book-frame)
 * — panel "Thêm từ khung".
 *
 * @param input - Khoá đích, sách, các node chương đã chọn và vị trí chèn (khi có).
 * @returns Các section đã tạo.
 */
export function applyBookFrame(input: {
  courseId: string;
  bookId: string;
  chapterNodeIds: string[];
  insertAtSection?: number;
}) {
  return apiJson<{ sections: unknown[] }>(`/api/v1/courses/${input.courseId}/book-frame`, {
    method: 'POST',
    body: JSON.stringify({
      bookId: input.bookId,
      chapterNodeIds: input.chapterNodeIds,
      ...(input.insertAtSection !== undefined ? { insertAtSection: input.insertAtSection } : {}),
    }),
  });
}
