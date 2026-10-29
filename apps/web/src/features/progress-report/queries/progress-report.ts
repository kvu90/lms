import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import { fetchProgressReport, fetchProgressReportGroups } from '../api/progress-report';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu trang báo cáo tiến độ (F-01 đợt 1, rà soát #133):
 * options dùng chung cho hook của trang và clientLoader của route
 * module. Báo cáo lỗi tải → null (trang hiểu là không có quyền), giữ
 * nguyên ngữ nghĩa probe thủ công trước đây.
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá báo cáo
 * riêng của feature nằm ở `keys.ts` cùng tầng này, riêng khoá danh
 * sách nhóm `courseGroups` là khoá dùng chung ở factory tập trung.
 */

/**
 * Tuỳ chọn truy vấn báo cáo tiến độ của khoá theo nhóm lọc.
 *
 * @param courseId - Định danh khoá.
 * @param groupId - Định danh nhóm lọc (rỗng = toàn khoá).
 * @returns Tuỳ chọn truy vấn báo cáo.
 */
export function progressReportQueryOptions(courseId: string, groupId: string) {
  return queryOptions({
    queryKey: queryKeys.courseProgressReport(courseId, groupId),
    queryFn: () => fetchProgressReport(courseId, groupId),
  });
}

/** Đọc báo cáo tiến độ; đổi nhóm lọc thì giữ dữ liệu cũ trong lúc tải bản mới (như luồng thủ công trước đây). */
export function useProgressReport(courseId: string | undefined, groupId: string) {
  return useQuery({
    ...progressReportQueryOptions(courseId ?? '', groupId),
    enabled: !!courseId,
    placeholderData: keepPreviousData,
  });
}

/** Options cho danh sách nhóm của khoá (bộ lọc của báo cáo). */
export function courseGroupsQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.courseGroups(courseId),
    queryFn: () => fetchProgressReportGroups(courseId),
  });
}

/** Đọc danh sách nhóm của khoá; lỗi → danh sách rỗng. */
export function useCourseGroups(courseId: string | undefined) {
  return useQuery({
    ...courseGroupsQueryOptions(courseId ?? ''),
    enabled: !!courseId,
  });
}
