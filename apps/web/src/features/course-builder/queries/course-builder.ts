import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '#lib/query-keys';
import {
  applyBookFrame,
  applyCurriculumFrame,
  createBuilderAssignment,
  createBuilderExamPin,
  createBuilderModule,
  createBuilderSection,
  deleteBuilderModule,
  deleteBuilderSection,
  duplicateBuilderModule,
  duplicateBuilderSection,
  fetchBuilderCourseList,
  fetchCourseBuilder,
  fetchCourseContent,
  importBuilderContent,
  recalculateBuilderCompletion,
  reorderBuilderModules,
  reorderBuilderSections,
  saveBuilderCourse,
  saveBuilderCriteria,
  saveBuilderModule,
  saveBuilderSection,
  updateCourseFrameInfo,
} from '../api/course-builder';
import type { BuilderBody } from '../types/course-builder';

/**
 * Tầng dữ liệu trang xây dựng khoá học (F-01 đợt 1, rà soát #133):
 * gói dữ liệu builder tải song song đúng nhịp reload() thủ công trước
 * đây — mỗi endpoint có bắt lỗi riêng (lỗi thì null/rỗng, không sập
 * cả trang). Options dùng chung cho hook của trang và clientLoader
 * của route module (prefetch cùng khoá).
 * Lời gọi API thuần nằm ở tầng `api/` của feature. Mọi khoá truy vấn
 * của trang này (courseBuilder, courseContent, courses,
 * courseDetail) đều là khoá dùng chung với các feature khác nên ở
 * lại factory tập trung `src/lib/query-keys.ts`.
 */

/**
 * Tuỳ chọn truy vấn gói dữ liệu builder của khoá.
 *
 * @param courseId - Định danh khoá.
 * @returns Tuỳ chọn truy vấn gói builder.
 */
export function courseBuilderQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseBuilder(courseId),
    queryFn: () => fetchCourseBuilder(courseId),
  });
}

/** Đọc gói builder; chỉ tải khi `enabled` (người xem có quyền xây dựng khoá). */
export function useCourseBuilder(courseId: string, enabled: boolean) {
  return useQuery({ ...courseBuilderQueryOptions(courseId), enabled });
}

/**
 * Tuỳ chọn truy vấn danh sách toàn bộ khoá học cho trang builder.
 *
 * @returns Tuỳ chọn truy vấn danh sách khoá.
 */
export function coursesListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.courses,
    queryFn: () => fetchBuilderCourseList(),
  });
}

/** Danh sách toàn bộ khoá học (khoá nguồn dùng lại nội dung ở trang builder); lỗi tải → rỗng như trước. */
export function useCoursesList() {
  return useQuery(coursesListQueryOptions());
}

/**
 * Tuỳ chọn truy vấn nội dung của khoá nguồn đang chọn để dùng lại.
 *
 * @param courseId - Định danh khoá nguồn.
 * @returns Tuỳ chọn truy vấn nội dung khoá.
 */
export function courseContentQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseContent(courseId),
    queryFn: () => fetchCourseContent(courseId),
  });
}

/** Nội dung của khoá nguồn đang chọn để dùng lại; chưa chọn thì query tắt. */
export function useCourseContent(courseId: string) {
  return useQuery({
    ...courseContentQueryOptions(courseId),
    enabled: !!courseId,
  });
}

// --- Đột biến xây dựng khoá (F-01 của rà soát #133) -----------------------------
//
// Mọi thao tác ghi của trang builder đều làm mới gói builder (và
// outline riêng) sau khi thành công — đúng nhịp reload() thủ công
// trước đây: gói mới về thì effect khởi tạo form của trang chạy lại
// theo dữ liệu server.

/** Dựng một đột biến builder dùng chung: thành công thì làm mới gói builder + outline của khoá. */
function useBuilderMutation<TVars, TData>(courseId: string, mutationFn: (vars: TVars) => Promise<TData>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.courseBuilder(courseId) });
      void client.invalidateQueries({ queryKey: queryKeys.courseContent(courseId) });
    },
  });
}

/** Đột biến lưu thông tin khoá (PATCH /courses/:id) — làm mới thêm danh sách khoá + chi tiết khoá vì tên/hiển thị đổi. */
export function useSaveBuilderCourse(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BuilderBody) => saveBuilderCourse(courseId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.courseBuilder(courseId) });
      void client.invalidateQueries({ queryKey: queryKeys.courseContent(courseId) });
      void client.invalidateQueries({ queryKey: queryKeys.courses });
      void client.invalidateQueries({ queryKey: queryKeys.courseDetail(courseId) });
    },
  });
}

/** Đột biến tạo section (POST /courses/:id/sections). */
export function useCreateBuilderSection(courseId: string) {
  return useBuilderMutation(courseId, (body: BuilderBody) => createBuilderSection(courseId, body));
}

/** Đột biến lưu section (PATCH /courses/:id/sections/:sectionId) — dùng cho cả tên/trạng thái mở lẫn điều kiện availability. */
export function useSaveBuilderSection(courseId: string) {
  return useBuilderMutation(courseId, (vars: { sectionId: string; body: BuilderBody }) =>
    saveBuilderSection(courseId, vars),
  );
}

/** Đột biến xoá section (DELETE /courses/:id/sections/:sectionId). */
export function useDeleteBuilderSection(courseId: string) {
  return useBuilderMutation(courseId, (sectionId: string) =>
    deleteBuilderSection(courseId, sectionId),
  );
}

/** Đột biến nhân bản section (POST /courses/:id/sections/:sectionId/copy). */
export function useDuplicateBuilderSection(courseId: string) {
  return useBuilderMutation(courseId, (sectionId: string) =>
    duplicateBuilderSection(courseId, sectionId),
  );
}

/** Đột biến đổi thứ tự section (POST /courses/:id/reorder-sections, gửi đủ mọi section theo thứ tự mới). */
export function useReorderBuilderSections(courseId: string) {
  return useBuilderMutation(courseId, (sectionIds: string[]) =>
    reorderBuilderSections(courseId, sectionIds),
  );
}

/** Đột biến đổi thứ tự module trong một section (POST /courses/:id/sections/:sectionId/reorder-modules). */
export function useReorderBuilderModules(courseId: string) {
  return useBuilderMutation(courseId, (vars: { sectionId: string; moduleIds: string[] }) =>
    reorderBuilderModules(courseId, vars),
  );
}

/** Đột biến tạo đề + ghim vào khoá (POST /courses/:id/exam-pins dạng newExam) — trả về id lần ghim để điều hướng. */
export function useCreateBuilderExamPin(courseId: string) {
  return useBuilderMutation(courseId, (vars: { sectionId: string; name: string }) =>
    createBuilderExamPin(courseId, vars),
  );
}

/** Đột biến tạo bài tập trong khoá (POST /courses/:id/assignments) — trả về id bài tập để điều hướng. */
export function useCreateBuilderAssignment(courseId: string) {
  return useBuilderMutation(courseId, (vars: { sectionId: string; name: string }) =>
    createBuilderAssignment(courseId, vars),
  );
}

/** Đột biến thêm module nội dung vào section (POST /courses/:id/modules). */
export function useCreateBuilderModule(courseId: string) {
  return useBuilderMutation(courseId, (body: BuilderBody) => createBuilderModule(courseId, body));
}

/** Đột biến lưu module (PATCH /courses/:id/modules/:cmId) — dùng cho cả tên/trạng thái mở lẫn availability. */
export function useSaveBuilderModule(courseId: string) {
  return useBuilderMutation(courseId, (vars: { cmId: string; body: BuilderBody }) =>
    saveBuilderModule(courseId, vars),
  );
}

/** Đột biến xoá module (DELETE /courses/:id/modules/:cmId). */
export function useDeleteBuilderModule(courseId: string) {
  return useBuilderMutation(courseId, (cmId: string) => deleteBuilderModule(courseId, cmId));
}

/** Đột biến nhân bản module (POST /courses/:id/modules/:cmId/copy). */
export function useDuplicateBuilderModule(courseId: string) {
  return useBuilderMutation(courseId, (cmId: string) => duplicateBuilderModule(courseId, cmId));
}

/** Đột biến dùng lại nội dung từ khoá khác (POST /courses/:id/import-content với các section/module đã tích chọn). */
export function useImportBuilderContent(courseId: string) {
  return useBuilderMutation(courseId, (body: BuilderBody) => importBuilderContent(courseId, body));
}

/** Đột biến lưu tiêu chí hoàn thành của khoá (PUT /courses/:id/completion/criteria). */
export function useSaveBuilderCriteria(courseId: string) {
  return useBuilderMutation(courseId, (body: BuilderBody) => saveBuilderCriteria(courseId, body));
}

/** Đột biến tính lại hoàn thành cho toàn khoá (POST /courses/:id/completion/recalculate). */
export function useRecalculateBuilderCompletion(courseId: string) {
  return useBuilderMutation(courseId, () => recalculateBuilderCompletion(courseId));
}

/**
 * Panel "Thêm từ khung" của trình xây dựng khoá (F-01 của rà soát
 * #133 — phần còn lại): panel gắn môn × khối cho khoá rồi nạp các
 * đơn vị khung/SGK đã chọn thành section mới. Ba thao tác ghi dưới
 * đây là đột biến MỎNG (panel tự hiện thông báo và gọi onApplied để
 * trang chứa nạp lại cấu trúc như bản thủ công); phần đọc của panel
 * đã đi qua tầng TanStack của lib/curriculum.
 */

/** Đột biến lưu môn/khối của khoá (PATCH /courses/:id với subjectId + grade). */
export function useUpdateCourseFrameInfo() {
  return useMutation({
    mutationFn: (input: { courseId: string; subjectId: string | null; grade: number | null }) =>
      updateCourseFrameInfo(input),
  });
}

/** Đột biến nạp các đơn vị khung chương trình đã chọn vào khoá (POST /courses/:id/curriculum-frame). */
export function useApplyCurriculumFrame() {
  return useMutation({
    mutationFn: (input: {
      courseId: string;
      curriculumId: string;
      nodeIds: string[];
      insertAtSection?: number;
    }) => applyCurriculumFrame(input),
  });
}

/** Đột biến nạp các chủ đề SGK đã chọn vào khoá (POST /courses/:id/book-frame). */
export function useApplyBookFrame() {
  return useMutation({
    mutationFn: (input: {
      courseId: string;
      bookId: string;
      chapterNodeIds: string[];
      insertAtSection?: number;
    }) => applyBookFrame(input),
  });
}
