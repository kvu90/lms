import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Course, CourseCategoryTreeNode } from '@lms/contracts';
import { apiJson } from './api';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';
import { createClass, fetchClasses, type ClassView } from './classes';

/**
 * Tầng dữ liệu TanStack Query cho wizard tạo khoá học (F-01 của rà
 * soát #133): các danh sách nền của wizard (cây danh mục, khoá hiện
 * có, khoá mẫu, lớp của giáo viên) đọc qua khoá của nhà máy
 * `queryKeys`; thao tác tạo/nhân bản khoá và nạp khung qua
 * `useMutation`. `clientLoader` của route nạp trước các danh sách nền.
 *
 * Các danh sách nền giữ đúng nhịp thủ công trước đây: tải hỏng thì
 * coi như danh sách rỗng (bắt lỗi ngay trong queryFn) — wizard không
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

/** Tuỳ chọn truy vấn cây danh mục khoá (GET /courses/categories/tree). */
export function courseCategoryTreeQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.categoryTree,
    queryFn: () => probeList<CourseCategoryTreeNode>('/api/v1/courses/categories/tree'),
  });
}

/** Hook đọc cây danh mục cho wizard. */
export function useCourseCategoryTree() {
  return useQuery(courseCategoryTreeQueryOptions());
}

/** Tuỳ chọn truy vấn danh sách khoá hiện có (GET /courses) — nguồn cho đường nhân bản. */
export function courseListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.courses,
    queryFn: () => probeList<Course>('/api/v1/courses'),
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
    queryFn: () => probeList<Course>('/api/v1/courses/templates'),
  });
}

/** Hook đọc danh sách khoá mẫu cho wizard. */
export function useCourseTemplates() {
  return useQuery(courseTemplatesQueryOptions());
}

/** Tuỳ chọn truy vấn danh sách lớp của giáo viên (GET /classes qua tầng classes). */
export function wizardClassesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.classes,
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
    mutationFn: (body: Record<string, unknown>) =>
      apiJson<Course>('/api/v1/courses', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.courses }),
  });
}

/**
 * Đột biến nhân bản khoá (POST /courses/:id/duplicate) cho đường nhân
 * bản và đường khoá mẫu — bản sao là nháp, không chứa người học/bài
 * làm; thành công thì làm mới danh sách khoá như tạo mới.
 */
export function useDuplicateCourse() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ fromId, body }: { fromId: string; body: Record<string, unknown> }) =>
      apiJson<Course>(`/api/v1/courses/${fromId}/duplicate`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.courses }),
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
    mutationFn: ({ courseId, curriculumId, nodeIds }: { courseId: string; curriculumId: string; nodeIds: string[] }) =>
      apiJson(`/api/v1/courses/${courseId}/curriculum-frame`, {
        method: 'POST',
        body: JSON.stringify({ curriculumId, nodeIds }),
      }),
  });
}

/**
 * Đột biến tạo lớp nội tuyến ở bước lớp (qua tầng `lib/classes.ts`)
 * khi giáo viên chưa có lớp nào — thành công thì làm mới danh sách
 * lớp để bước lớp thấy ngay lớp vừa tạo.
 */
export function useCreateClassForWizard() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => createClass(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.classes }),
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
