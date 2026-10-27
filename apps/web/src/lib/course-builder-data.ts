import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Course, CourseContent, CourseGroup, CourseGrouping, GradeItem,
} from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu trang xây dựng khoá học (F-01 đợt 1, rà soát #133):
 * gói dữ liệu builder tải song song đúng nhịp reload() thủ công trước
 * đây — mỗi endpoint có bắt lỗi riêng (lỗi thì null/rỗng, không sập
 * cả trang). Options dùng chung cho hook của trang và clientLoader
 * của route module (prefetch cùng khoá).
 */

/** Hình dạng GET /courses/:id/completion/criteria mà trang builder tiêu thụ. */
export interface BuilderCriteriaView {
  method: number;
  criteria: { id: string; criteriaType: string; moduleInstance: string | null; date: string | null }[];
}

/** Gói dữ liệu trang builder: thông tin khoá, nội dung, các mục điểm, tiêu chí hoàn thành, nhóm và grouping. */
export interface CourseBuilderData {
  course: Course | null;
  content: CourseContent | null;
  gradeItems: GradeItem[];
  criteria: BuilderCriteriaView | null;
  groups: CourseGroup[];
  groupings: CourseGrouping[];
}

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

async function fetchCourseBuilder(courseId: string): Promise<CourseBuilderData> {
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

export function coursesListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.courses,
    queryFn: async () => (await probe<Course[]>('/api/v1/courses')) ?? [],
  });
}

/** Danh sách toàn bộ khoá học (khoá nguồn dùng lại nội dung ở trang builder); lỗi tải → rỗng như trước. */
export function useCoursesList() {
  return useQuery(coursesListQueryOptions());
}

export function courseContentQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseContent(courseId),
    queryFn: () => probe<CourseContent>(`/api/v1/courses/${courseId}/content`),
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

/** Thân ghi dùng chung của builder: trang tự dựng đúng hình dạng API của từng thao tác. */
export type BuilderBody = Record<string, unknown>;

/** Đột biến lưu thông tin khoá (PATCH /courses/:id) — làm mới thêm danh sách khoá + chi tiết khoá vì tên/hiển thị đổi. */
export function useSaveBuilderCourse(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BuilderBody) =>
      apiJson(`/api/v1/courses/${courseId}`, { method: 'PATCH', body: JSON.stringify(body) }),
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
  return useBuilderMutation(courseId, (body: BuilderBody) =>
    apiJson(`/api/v1/courses/${courseId}/sections`, { method: 'POST', body: JSON.stringify(body) }),
  );
}

/** Đột biến lưu section (PATCH /courses/:id/sections/:sectionId) — dùng cho cả tên/trạng thái mở lẫn điều kiện availability. */
export function useSaveBuilderSection(courseId: string) {
  return useBuilderMutation(courseId, (vars: { sectionId: string; body: BuilderBody }) =>
    apiJson(`/api/v1/courses/${courseId}/sections/${vars.sectionId}`, {
      method: 'PATCH',
      body: JSON.stringify(vars.body),
    }),
  );
}

/** Đột biến xoá section (DELETE /courses/:id/sections/:sectionId). */
export function useDeleteBuilderSection(courseId: string) {
  return useBuilderMutation(courseId, (sectionId: string) =>
    apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}`, { method: 'DELETE' }),
  );
}

/** Đột biến nhân bản section (POST /courses/:id/sections/:sectionId/copy). */
export function useDuplicateBuilderSection(courseId: string) {
  return useBuilderMutation(courseId, (sectionId: string) =>
    apiJson(`/api/v1/courses/${courseId}/sections/${sectionId}/copy`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  );
}

/** Đột biến đổi thứ tự section (POST /courses/:id/reorder-sections, gửi đủ mọi section theo thứ tự mới). */
export function useReorderBuilderSections(courseId: string) {
  return useBuilderMutation(courseId, (sectionIds: string[]) =>
    apiJson(`/api/v1/courses/${courseId}/reorder-sections`, {
      method: 'POST',
      body: JSON.stringify({ sectionIds }),
    }),
  );
}

/** Đột biến đổi thứ tự module trong một section (POST /courses/:id/sections/:sectionId/reorder-modules). */
export function useReorderBuilderModules(courseId: string) {
  return useBuilderMutation(courseId, (vars: { sectionId: string; moduleIds: string[] }) =>
    apiJson(`/api/v1/courses/${courseId}/sections/${vars.sectionId}/reorder-modules`, {
      method: 'POST',
      body: JSON.stringify({ moduleIds: vars.moduleIds }),
    }),
  );
}

/** Đột biến tạo đề + ghim vào khoá (POST /courses/:id/exam-pins dạng newExam) — trả về id lần ghim để điều hướng. */
export function useCreateBuilderExamPin(courseId: string) {
  return useBuilderMutation(courseId, (vars: { sectionId: string; name: string }) =>
    apiJson<{ id: string }>(`/api/v1/courses/${courseId}/exam-pins`, {
      method: 'POST',
      body: JSON.stringify({ sectionId: vars.sectionId, newExam: { name: vars.name } }),
    }),
  );
}

/** Đột biến tạo bài tập trong khoá (POST /courses/:id/assignments) — trả về id bài tập để điều hướng. */
export function useCreateBuilderAssignment(courseId: string) {
  return useBuilderMutation(courseId, (vars: { sectionId: string; name: string }) =>
    apiJson<{ id: string }>(`/api/v1/courses/${courseId}/assignments`, {
      method: 'POST',
      body: JSON.stringify({ sectionId: vars.sectionId, name: vars.name }),
    }),
  );
}

/** Đột biến thêm module nội dung vào section (POST /courses/:id/modules). */
export function useCreateBuilderModule(courseId: string) {
  return useBuilderMutation(courseId, (body: BuilderBody) =>
    apiJson(`/api/v1/courses/${courseId}/modules`, { method: 'POST', body: JSON.stringify(body) }),
  );
}

/** Đột biến lưu module (PATCH /courses/:id/modules/:cmId) — dùng cho cả tên/trạng thái mở lẫn availability. */
export function useSaveBuilderModule(courseId: string) {
  return useBuilderMutation(courseId, (vars: { cmId: string; body: BuilderBody }) =>
    apiJson(`/api/v1/courses/${courseId}/modules/${vars.cmId}`, {
      method: 'PATCH',
      body: JSON.stringify(vars.body),
    }),
  );
}

/** Đột biến xoá module (DELETE /courses/:id/modules/:cmId). */
export function useDeleteBuilderModule(courseId: string) {
  return useBuilderMutation(courseId, (cmId: string) =>
    apiJson(`/api/v1/courses/${courseId}/modules/${cmId}`, { method: 'DELETE' }),
  );
}

/** Đột biến nhân bản module (POST /courses/:id/modules/:cmId/copy). */
export function useDuplicateBuilderModule(courseId: string) {
  return useBuilderMutation(courseId, (cmId: string) =>
    apiJson(`/api/v1/courses/${courseId}/modules/${cmId}/copy`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  );
}

/** Đột biến dùng lại nội dung từ khoá khác (POST /courses/:id/import-content với các section/module đã tích chọn). */
export function useImportBuilderContent(courseId: string) {
  return useBuilderMutation(courseId, (body: BuilderBody) =>
    apiJson(`/api/v1/courses/${courseId}/import-content`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

/** Đột biến lưu tiêu chí hoàn thành của khoá (PUT /courses/:id/completion/criteria). */
export function useSaveBuilderCriteria(courseId: string) {
  return useBuilderMutation(courseId, (body: BuilderBody) =>
    apiJson(`/api/v1/courses/${courseId}/completion/criteria`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  );
}

/** Đột biến tính lại hoàn thành cho toàn khoá (POST /courses/:id/completion/recalculate). */
export function useRecalculateBuilderCompletion(courseId: string) {
  return useBuilderMutation(courseId, () =>
    apiJson(`/api/v1/courses/${courseId}/completion/recalculate`, { method: 'POST' }),
  );
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
    mutationFn: ({ courseId, subjectId, grade }: { courseId: string; subjectId: string | null; grade: number | null }) =>
      apiJson(`/api/v1/courses/${courseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ subjectId, grade }),
      }),
  });
}

/** Đột biến nạp các đơn vị khung chương trình đã chọn vào khoá (POST /courses/:id/curriculum-frame). */
export function useApplyCurriculumFrame() {
  return useMutation({
    mutationFn: ({
      courseId,
      curriculumId,
      nodeIds,
      insertAtSection,
    }: {
      courseId: string;
      curriculumId: string;
      nodeIds: string[];
      insertAtSection?: number;
    }) =>
      apiJson<{ sections: unknown[] }>(`/api/v1/courses/${courseId}/curriculum-frame`, {
        method: 'POST',
        body: JSON.stringify({
          curriculumId,
          nodeIds,
          ...(insertAtSection !== undefined ? { insertAtSection } : {}),
        }),
      }),
  });
}

/** Đột biến nạp các chủ đề SGK đã chọn vào khoá (POST /courses/:id/book-frame). */
export function useApplyBookFrame() {
  return useMutation({
    mutationFn: ({
      courseId,
      bookId,
      chapterNodeIds,
      insertAtSection,
    }: {
      courseId: string;
      bookId: string;
      chapterNodeIds: string[];
      insertAtSection?: number;
    }) =>
      apiJson<{ sections: unknown[] }>(`/api/v1/courses/${courseId}/book-frame`, {
        method: 'POST',
        body: JSON.stringify({
          bookId,
          chapterNodeIds,
          ...(insertAtSection !== undefined ? { insertAtSection } : {}),
        }),
      }),
  });
}
