import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import { fetchCourseGradeData } from '#hooks/use-courses-grade-data';
import {
  createGradeItem,
  deleteGradeItem,
  fetchGradeItemHistory,
  setGradeItemPublished,
  setGradePostingPolicy,
  submitGrade,
  updateGradeItem,
} from '../api/course-grade';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu của trang bảng điểm (F-01 của rà soát #133).
 * Lời gọi API thuần nằm ở tầng `api/` của feature; fetcher điểm
 * dùng chung và hook đa khoá nằm ở `src/hooks/use-courses-grade-data.ts`;
 * khoá lịch sử điểm riêng của grades nằm ở `keys.ts` cùng tầng này,
 * riêng khoá dữ liệu điểm `courseAccess` là khoá dùng chung ở
 * factory tập trung.
 */

/**
 * Tải lười dữ liệu điểm của MỘT khoá tại bề mặt tiêu thụ (F-02, rà soát
 * #133): PermissionsProvider KHÔNG còn tải háo hức dữ liệu này cho mọi
 * khoá khi nạp app nữa — chỉ bề mặt nào thật sự hiển thị điểm của khoá
 * (trang grades, khối dashboard) mới gọi hook này, và chỉ cho khoá nó
 * cần. `courseId` rỗng/null thì query tắt.
 */
export function useCourseGradeData(courseId: string | null | undefined) {
  return useQuery({
    queryKey: sharedQueryKeys.courseAccess(courseId ?? ''),
    queryFn: () => fetchCourseGradeData(courseId as string),
    enabled: !!courseId,
  });
}

// --- Đột biến + lịch sử điểm của trang bảng điểm (F-01 của rà soát #133) -------
//
// Mọi thao tác ghi điểm/mục điểm đều làm mới đúng khoá dùng chung
// `courseAccess(courseId)` — cùng nhịp "nạp lại dữ liệu điểm" của bản
// thủ công. Lịch sử điểm là đọc theo yêu cầu (người dùng nhập cặp
// mục/người rồi bấm xem): trang gọi fetchQuery với tuỳ chọn dưới đây
// để vẫn qua bộ nhớ đệm + dedupe của TanStack mà giữ nguyên nhịp
// xoá-kết-quả-cũ/hiện-lỗi của bản thủ công.

/** Tuỳ chọn truy vấn lịch sử điểm của một học viên trên một mục điểm. */
export function gradeItemHistoryQueryOptions(itemId: string, userId: string) {
  return queryOptions({
    queryKey: queryKeys.gradeItemHistory(itemId, userId),
    queryFn: () => fetchGradeItemHistory(itemId, userId),
  });
}

/** Dựng một đột biến điểm dùng chung: thành công thì làm mới khoá dữ liệu điểm của khoá. */
function useGradeMutation<TVars>(
  courseId: string,
  mutationFn: (vars: TVars) => Promise<unknown>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: sharedQueryKeys.courseAccess(courseId) }),
  });
}

/** Đột biến nhập/sửa điểm một bài cho một học sinh (POST /grade-items/:itemId/grades). */
export function useSubmitGrade(courseId: string) {
  return useGradeMutation(
    courseId,
    (vars: { gradeItemId: string; userId: string; rawGrade: number | null; feedback?: string }) =>
      submitGrade(vars),
  );
}

/** Đột biến tạo mục điểm nhập tay mới cho khoá (POST /courses/:id/grade-items). */
export function useCreateGradeItem(courseId: string) {
  return useGradeMutation(courseId, (vars: { itemName: string; gradeMax: number }) =>
    createGradeItem(courseId, vars),
  );
}

/** Đột biến lưu sửa tên/thang điểm của một mục (PATCH /grade-items/:id). */
export function useUpdateGradeItem(courseId: string) {
  return useGradeMutation(courseId, (vars: { itemId: string; itemName: string; gradeMax: number }) =>
    updateGradeItem(vars),
  );
}

/** Đột biến xoá một mục điểm và mọi điểm của nó (DELETE /grade-items/:id). */
export function useDeleteGradeItem(courseId: string) {
  return useGradeMutation(courseId, (itemId: string) => deleteGradeItem(itemId));
}

/** Đột biến đặt chính sách công bố của một bài (PUT /grade-items/:id/posting-policy). */
export function useSetGradePostingPolicy(courseId: string) {
  return useGradeMutation(courseId, (vars: { itemId: string; policy: 'auto' | 'manual' }) =>
    setGradePostingPolicy(vars),
  );
}

/** Đột biến công bố/thu hồi công bố điểm của một bài (POST .../publish | .../unpublish). */
export function useSetGradeItemPublished(courseId: string) {
  return useGradeMutation(courseId, (vars: { itemId: string; published: boolean }) =>
    setGradeItemPublished(vars),
  );
}
