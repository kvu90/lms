import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  GuardianDigestFrequency, GuardianDigestPreferenceView, GuardianStudentOverviewView, GuardianStudentResultsView,
} from '@lms/contracts';
import { apiJson } from './api';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu TanStack Query cho bề mặt phụ huynh (F-01 của rà soát
 * #133): trang guardian trước đây khai báo `queryFn`/`mutationFn` nội
 * tuyến ngay trong component bằng `apiJson` thủ công; nay mọi lần đọc
 * đi qua options của module này với khoá lấy từ nhà máy `queryKeys`
 * (các khoá guardian đã có sẵn từ lát PH-1/PH-2), đột biến duy nhất
 * (đặt tần suất digest của chính phụ huynh) invalidate đúng khoá tuỳ
 * chọn của con đó, và `clientLoader` của hai route guardian prefetch
 * đúng các khoá component sẽ đọc — dữ liệu tải một lần, dùng chung
 * cache. Hành vi hiển thị của trang không đổi: trang vẫn là bề mặt
 * chỉ-xem dữ liệu của con, ngoại lệ duy nhất là cài đặt digest của
 * chính phụ huynh.
 */

/** Một liên kết con của phụ huynh (GET /guardian-links/mine/students). */
export interface GuardianMyStudentEntry {
  student: { id: string; firstName: string; lastName: string; username: string };
}

/** Tuỳ chọn truy vấn các con đang liên kết giám hộ với chính người dùng (GET /guardian-links/mine/students). */
export function guardianMyStudentsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.guardianMyStudents,
    queryFn: () => apiJson<GuardianMyStudentEntry[]>('/api/v1/guardian-links/mine/students'),
  });
}

/** Tuỳ chọn truy vấn tổng quan phụ huynh cho một con (GET /guardian/students/:id/overview). */
export function guardianOverviewQueryOptions(studentId: string) {
  return queryOptions({
    queryKey: queryKeys.guardianOverview(studentId),
    queryFn: () => apiJson<GuardianStudentOverviewView>(`/api/v1/guardian/students/${studentId}/overview`),
  });
}

/** Tuỳ chọn truy vấn kết quả đã công bố của một con (GET /guardian/students/:id/results). */
export function guardianResultsQueryOptions(studentId: string) {
  return queryOptions({
    queryKey: queryKeys.guardianResults(studentId),
    queryFn: () => apiJson<GuardianStudentResultsView>(`/api/v1/guardian/students/${studentId}/results`),
  });
}

/** Tuỳ chọn truy vấn tuỳ chọn tần suất digest của phụ huynh cho một con (GET /guardian/students/:id/digest-preference). */
export function guardianDigestPreferenceQueryOptions(studentId: string) {
  return queryOptions({
    queryKey: queryKeys.guardianDigestPreference(studentId),
    queryFn: () => apiJson<GuardianDigestPreferenceView>(`/api/v1/guardian/students/${studentId}/digest-preference`),
  });
}

/**
 * Đột biến đặt tần suất digest cho một con (PUT
 * /guardian/students/:id/digest-preference): thành công thì invalidate
 * đúng khoá tuỳ chọn của con đó để khối cài đặt đọc lại giá trị vừa
 * lưu — đúng hành vi bản nội tuyến trước đây.
 */
export function useUpdateGuardianDigestPreference(studentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (frequency: GuardianDigestFrequency) => apiJson<GuardianDigestPreferenceView>(
      `/api/v1/guardian/students/${studentId}/digest-preference`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frequency }) },
    ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.guardianDigestPreference(studentId) });
    },
  });
}

/**
 * clientLoader của route gốc `/guardian` (F-01, rà soát #133): nạp
 * trước danh sách con vào QueryClient singleton (đúng khoá trang sẽ
 * đọc); biết con đầu tiên thì nạp trước luôn tổng quan + kết quả +
 * tuỳ chọn digest của con đó — đúng bộ dữ liệu trang hiển thị ngay
 * khi vào gốc. Nạp danh sách con hỏng thì bỏ qua (component tự đọc
 * lại và tự hiện trạng thái lỗi như trước).
 */
export async function guardianPageClientLoader() {
  const students = await queryClient.ensureQueryData(guardianMyStudentsQueryOptions()).catch(() => null);
  const firstStudentId = students?.[0]?.student.id;
  if (firstStudentId) {
    await Promise.all([
      queryClient.prefetchQuery(guardianOverviewQueryOptions(firstStudentId)),
      queryClient.prefetchQuery(guardianResultsQueryOptions(firstStudentId)),
      queryClient.prefetchQuery(guardianDigestPreferenceQueryOptions(firstStudentId)),
    ]);
  }
  return null;
}

/**
 * clientLoader của route `/guardian/students/:studentId` (F-01, rà
 * soát #133): nạp trước danh sách con (trang vẫn cần để phán quyết
 * liên kết + chuyển hướng thay thế) và bộ dữ liệu của đúng con trên
 * path vào QueryClient singleton, đúng các khoá trang sẽ đọc.
 */
export async function guardianStudentPageClientLoader(studentId: string) {
  await Promise.all([
    queryClient.prefetchQuery(guardianMyStudentsQueryOptions()),
    queryClient.prefetchQuery(guardianOverviewQueryOptions(studentId)),
    queryClient.prefetchQuery(guardianResultsQueryOptions(studentId)),
    queryClient.prefetchQuery(guardianDigestPreferenceQueryOptions(studentId)),
  ]);
  return null;
}
