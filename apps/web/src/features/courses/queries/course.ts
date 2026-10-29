import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createFeePayment,
  fetchCoursePage,
  fetchMyPayments,
  selfEnrolCourse,
  setManualCompletion,
} from '../api/course';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu trang khoá học (F-01 đợt 1, rà soát #133): options dùng
 * chung cho hook của trang và clientLoader của route module.
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá truy vấn
 * riêng của courses nằm ở `keys.ts` cùng tầng này.
 */

/**
 * Tuỳ chọn truy vấn gói dữ liệu trang khoá học.
 *
 * @param courseId - Định danh khoá.
 * @returns Tuỳ chọn truy vấn gói trang khoá học.
 */
export function coursePageQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.coursePage(courseId),
    queryFn: () => fetchCoursePage(courseId),
  });
}

/** Đọc gói dữ liệu trang khoá học; `courseId` trống thì query tắt. */
export function useCoursePage(courseId: string | undefined) {
  return useQuery({
    ...coursePageQueryOptions(courseId ?? ''),
    enabled: !!courseId,
  });
}

/** Options cho thanh toán của chính người dùng (query riêng để payFee chỉ làm mới đúng phần này). */
export function myPaymentsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.myPayments,
    queryFn: () => fetchMyPayments(),
  });
}

/** Đọc thanh toán của chính người dùng; lỗi → danh sách rỗng. */
export function useMyPayments() {
  const query = useQuery(myPaymentsQueryOptions());
  return { ...query, payments: query.data ?? [] };
}

/** Tự ghi danh qua instance self: xong thì invalidate gói trang để nạp lại trạng thái/nội dung. */
export function useSelfEnrol(courseId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => selfEnrolCourse(courseId, instanceId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.coursePage(courseId ?? '') }),
  });
}

/**
 * Tạo payment cho instance fee. Tuyệt đối không tự ghi danh ở đây: ghi
 * danh chỉ kích hoạt sau khi webhook xác nhận payment thành công. Thành
 * công thì invalidate query thanh toán của tôi để hiển thị trạng thái thật.
 */
export function usePayFee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => createFeePayment(instanceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.myPayments }),
  });
}

/** Đánh dấu hoàn thành thủ công cho một module: xong thì invalidate gói trang (completion nằm trong gói). */
export function useToggleManualCompletion(courseId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { cmId: string; userId: string; complete: boolean }) =>
      setManualCompletion(courseId, vars),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.coursePage(courseId ?? '') }),
  });
}
