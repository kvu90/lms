import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Course, CourseCategoryTreeNode } from '@lms/contracts';
import { apiJson } from './api';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu của trang danh sách khoá học (F-01 của rà soát #133):
 * cây danh mục và danh sách khoá dùng ĐÚNG các khoá dùng chung với
 * dashboard và PermissionsProvider (categoryTree, courses) để không
 * tải trùng; tiến độ học của chính người dùng theo khoá qua khoá
 * factory courseMyProgress — lỗi từng khoá thì percent null và trang
 * không hiện số nào, như bản thủ công. Thao tác ghi danh mục là đột
 * biến, làm mới cả cây danh mục lẫn danh sách khoá dùng chung.
 */

/** Tuỳ chọn truy vấn cây danh mục khoá (GET /courses/categories/tree) — khoá dùng chung với dashboard. */
export function categoryTreeQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.categoryTree,
    queryFn: () => apiJson<CourseCategoryTreeNode[]>('/api/v1/courses/categories/tree'),
  });
}

/** Tuỳ chọn truy vấn danh sách toàn bộ khoá học (GET /courses) — khoá dùng chung với PermissionsProvider. */
export function coursesListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.courses,
    queryFn: () => apiJson<Course[]>('/api/v1/courses'),
  });
}

/** Tuỳ chọn truy vấn % tiến độ học của chính người dùng cho một khoá (GET /courses/:id/progress/me); lỗi → percent null. */
export function courseMyProgressQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseMyProgress(courseId),
    queryFn: async () => {
      try {
        return await apiJson<{ percent: number | null }>(`/api/v1/courses/${courseId}/progress/me`);
      } catch {
        return { percent: null };
      }
    },
  });
}

/** Làm mới sau đột biến danh mục: cây danh mục + danh sách khoá dùng chung. */
function invalidateCatalog(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: queryKeys.categoryTree });
  void client.invalidateQueries({ queryKey: queryKeys.courses });
}

/**
 * Đột biến tạo danh mục (POST /courses/categories): `parent` chỉ gửi
 * khi chọn một danh mục cha thật — ở cấp cao nhất thì bỏ qua hẳn
 * trường này thay vì gửi giá trị không phải UUID.
 */
export function useCreateCourseCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; parent?: string }) =>
      apiJson('/api/v1/courses/categories', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidateCatalog(client),
  });
}

/** Đột biến đổi tên danh mục (PATCH /courses/categories/:id). */
export function useRenameCourseCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, name }: { categoryId: string; name: string }) =>
      apiJson(`/api/v1/courses/categories/${categoryId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => invalidateCatalog(client),
  });
}

/** Đột biến xoá danh mục (DELETE /courses/categories/:id) — lỗi phía server do trang hiển thị thân thiện. */
export function useDeleteCourseCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: string) =>
      apiJson(`/api/v1/courses/categories/${categoryId}`, { method: 'DELETE' }),
    onSuccess: () => invalidateCatalog(client),
  });
}

/**
 * Nạp trước cho route danh sách khoá học: cây danh mục + danh sách
 * khoá (đúng hai khoá dùng chung trang sẽ đọc).
 */
export async function coursesPageClientLoader() {
  await Promise.allSettled([
    queryClient.ensureQueryData(categoryTreeQueryOptions()),
    queryClient.ensureQueryData(coursesListQueryOptions()),
  ]);
  return null;
}
