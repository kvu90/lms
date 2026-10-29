import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryClient } from '#lib/query-client';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  createCourseCategory,
  deleteCourseCategory,
  fetchCourseCategoryTree,
  fetchCourseMyProgress,
  fetchCourses,
  renameCourseCategory,
} from '../api/courses';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu của trang danh sách khoá học (F-01 của rà soát #133):
 * cây danh mục và danh sách khoá dùng ĐÚNG các khoá dùng chung với
 * dashboard và PermissionsProvider (categoryTree, courses) để không
 * tải trùng; tiến độ học của chính người dùng theo khoá qua khoá
 * factory courseMyProgress — lỗi từng khoá thì percent null và trang
 * không hiện số nào, như bản thủ công. Thao tác ghi danh mục là đột
 * biến, làm mới cả cây danh mục lẫn danh sách khoá dùng chung.
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá riêng của
 * courses nằm ở `keys.ts` cùng tầng này, hai khoá dùng chung ở lại
 * factory tập trung `src/lib/query-keys.ts`.
 */

/** Tuỳ chọn truy vấn cây danh mục khoá (GET /courses/categories/tree) — khoá dùng chung với dashboard. */
export function categoryTreeQueryOptions() {
  return queryOptions({
    queryKey: sharedQueryKeys.categoryTree,
    queryFn: () => fetchCourseCategoryTree(),
  });
}

/** Tuỳ chọn truy vấn danh sách toàn bộ khoá học (GET /courses) — khoá dùng chung với PermissionsProvider. */
export function coursesListQueryOptions() {
  return queryOptions({
    queryKey: sharedQueryKeys.courses,
    queryFn: () => fetchCourses(),
  });
}

/** Tuỳ chọn truy vấn % tiến độ học của chính người dùng cho một khoá (GET /courses/:id/progress/me); lỗi → percent null. */
export function courseMyProgressQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseMyProgress(courseId),
    queryFn: async () => {
      try {
        return await fetchCourseMyProgress(courseId);
      } catch {
        return { percent: null };
      }
    },
  });
}

/** Làm mới sau đột biến danh mục: cây danh mục + danh sách khoá dùng chung. */
function invalidateCatalog(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: sharedQueryKeys.categoryTree });
  void client.invalidateQueries({ queryKey: sharedQueryKeys.courses });
}

/**
 * Đột biến tạo danh mục (POST /courses/categories): `parent` chỉ gửi
 * khi chọn một danh mục cha thật — ở cấp cao nhất thì bỏ qua hẳn
 * trường này thay vì gửi giá trị không phải UUID.
 */
export function useCreateCourseCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; parent?: string }) => createCourseCategory(body),
    onSuccess: () => invalidateCatalog(client),
  });
}

/** Đột biến đổi tên danh mục (PATCH /courses/categories/:id). */
export function useRenameCourseCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { categoryId: string; name: string }) => renameCourseCategory(input),
    onSuccess: () => invalidateCatalog(client),
  });
}

/** Đột biến xoá danh mục (DELETE /courses/categories/:id) — lỗi phía server do trang hiển thị thân thiện. */
export function useDeleteCourseCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: string) => deleteCourseCategory(categoryId),
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
