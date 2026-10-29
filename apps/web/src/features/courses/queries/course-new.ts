import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryClient } from '#lib/query-client';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import { createClass, fetchClasses } from '#features/classes/api/classes';
import type { ClassView } from '#features/classes/types/classes';
import {
  applyCurriculumFrame,
  createCourse,
  duplicateCourse,
  fetchWizardCategoryTree,
  fetchWizardCourseList,
  fetchWizardCourseTemplates,
} from '../api/course-new';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu TanStack Query cho wizard tạo khoá học (F-01 của rà
 * soát #133): các danh sách nền của wizard (cây danh mục, khoá hiện
 * có, khoá mẫu, lớp của giáo viên) đọc qua khoá của nhà máy
 * `queryKeys`; thao tác tạo/nhân bản khoá và nạp khung qua
 * `useMutation`. `clientLoader` của route nạp trước các danh sách nền.
 * Lời gọi API thuần nằm ở tầng `api/` của feature; danh sách lớp đọc
 * qua tầng api của feature classes.
 */

/** Tuỳ chọn truy vấn cây danh mục khoá (GET /courses/categories/tree). */
export function courseCategoryTreeQueryOptions() {
  return queryOptions({
    queryKey: sharedQueryKeys.categoryTree,
    queryFn: () => fetchWizardCategoryTree(),
  });
}

/** Hook đọc cây danh mục cho wizard. */
export function useCourseCategoryTree() {
  return useQuery(courseCategoryTreeQueryOptions());
}

/** Tuỳ chọn truy vấn danh sách khoá hiện có (GET /courses) — nguồn cho đường nhân bản. */
export function courseListQueryOptions() {
  return queryOptions({
    queryKey: sharedQueryKeys.courses,
    queryFn: () => fetchWizardCourseList(),
  });
}

/** Hook đọc danh sách khoá hiện có cho wizard. */
export function useCourseList() {
  return useQuery(courseListQueryOptions());
}

/** Tuỳ chọn truy vấn danh sách khoá mẫu tổ/trường (GET /courses/templates). */
export function courseTemplatesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.courseTemplates,
    queryFn: () => fetchWizardCourseTemplates(),
  });
}

/** Hook đọc danh sách khoá mẫu cho wizard. */
export function useCourseTemplates() {
  return useQuery(courseTemplatesQueryOptions());
}

/** Tuỳ chọn truy vấn danh sách lớp của giáo viên (GET /classes qua tầng classes). */
export function wizardClassesQueryOptions() {
  return queryOptions({
    queryKey: sharedQueryKeys.classes,
    queryFn: async (): Promise<ClassView[]> => {
      try {
        return await fetchClasses();
      } catch {
        return [];
      }
    },
  });
}

/** Hook đọc danh sách lớp cho bước lớp của wizard. */
export function useWizardClasses() {
  return useQuery(wizardClassesQueryOptions());
}

/**
 * Đột biến tạo khoá học mới (POST /courses) cho đường khoá trắng và
 * đường khung chương trình — thành công thì làm mới danh sách khoá
 * để các bề mặt danh sách thấy ngay khoá vừa tạo.
 */
export function useCreateCourse() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => createCourse(body),
    onSuccess: () => void client.invalidateQueries({ queryKey: sharedQueryKeys.courses }),
  });
}

/**
 * Đột biến nhân bản khoá (POST /courses/:id/copy) cho đường nhân
 * bản và đường khoá mẫu — bản sao là nháp, không chứa người học/bài
 * làm; thành công thì làm mới danh sách khoá như tạo mới.
 */
export function useDuplicateCourse() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { fromId: string; body: Record<string, unknown> }) => duplicateCourse(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: sharedQueryKeys.courses }),
  });
}

/**
 * Đột biến nạp khung chương trình vào khoá vừa tạo (POST
 * /courses/:id/curriculum-frame): khoá đã tồn tại trước khi nạp khung
 * nên lỗi nạp khung không huỷ khoá — trang báo rõ và vẫn vào builder
 * như bản thủ công.
 */
export function useApplyCurriculumFrame() {
  return useMutation({
    mutationFn: (input: { courseId: string; curriculumId: string; nodeIds: string[] }) =>
      applyCurriculumFrame(input),
  });
}

/**
 * Đột biến tạo lớp nội tuyến ở bước lớp (qua tầng api của feature
 * classes) khi giáo viên chưa có lớp nào — thành công thì làm mới
 * danh sách lớp để bước lớp thấy ngay lớp vừa tạo.
 */
export function useCreateClassForWizard() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => createClass(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: sharedQueryKeys.classes }),
  });
}

/** clientLoader (F-01, #133): nạp trước các danh sách nền đúng khoá wizard sẽ đọc. */
export async function courseNewPageClientLoader() {
  await Promise.all([
    queryClient.prefetchQuery(courseCategoryTreeQueryOptions()),
    queryClient.prefetchQuery(courseListQueryOptions()),
    queryClient.prefetchQuery(courseTemplatesQueryOptions()),
    queryClient.prefetchQuery(wizardClassesQueryOptions()),
  ]);
  return null;
}
