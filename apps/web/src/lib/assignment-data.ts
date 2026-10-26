import { queryOptions, useQuery } from '@tanstack/react-query';
import type { AssignmentForUserView } from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu trang Bài tập (F-01 đợt 1, rà soát #133): chi tiết bài
 * tập theo đúng quyền người xem (API đã phân giải cờ canSubmit/
 * canGrade/canManage trong cùng đáp ứng). Options dùng chung cho hook
 * của trang và clientLoader của route module (prefetch cùng khoá).
 */
export function assignmentQueryOptions(assignmentId: string) {
  return queryOptions({
    queryKey: queryKeys.assignmentDetail(assignmentId),
    queryFn: () => apiJson<AssignmentForUserView>(`/api/v1/assignments/${assignmentId}`),
  });
}

/** Đọc chi tiết bài tập; `assignmentId` trống thì query tắt. */
export function useAssignment(assignmentId: string | undefined) {
  return useQuery({
    ...assignmentQueryOptions(assignmentId ?? ''),
    enabled: !!assignmentId,
  });
}
