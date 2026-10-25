import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/** Một học sinh trong báo cáo tiến độ (GET /courses/:id/progress/report). */
export interface ProgressReportStudent {
  userId: string;
  username: string;
  fullName: string;
  completed: number;
  total: number;
  percent: number | null;
  lastAccessAt: string | null;
  states: Record<string, number>;
}

/** Báo cáo tiến độ cho giáo viên: ma trận lớp × mục + tổng theo mục/HS. */
export interface ProgressReport {
  courseId: string;
  items: { cmId: string; name: string; component: string; completedCount: number; totalStudents: number; percent: number | null }[];
  students: ProgressReportStudent[];
}

/** Một nhóm (lớp) của khoá — tuỳ chọn của bộ lọc báo cáo. */
export interface CourseGroup {
  id: string;
  name: string;
}

/** Tải một endpoint phụ độc lập: lỗi thì trả null (giữ nguyên ngữ nghĩa probe của trang). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Tầng dữ liệu trang báo cáo tiến độ (F-01 đợt 1, rà soát #133):
 * options dùng chung cho hook của trang và clientLoader của route
 * module. Báo cáo lỗi tải → null (trang hiểu là không có quyền), giữ
 * nguyên ngữ nghĩa probe thủ công trước đây.
 */
export function progressReportQueryOptions(courseId: string, groupId: string) {
  return queryOptions({
    queryKey: queryKeys.courseProgressReport(courseId, groupId),
    queryFn: () =>
      probe<ProgressReport>(`/api/v1/courses/${courseId}/progress/report${groupId ? `?groupId=${groupId}` : ''}`),
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
    queryKey: queryKeys.courseGroups(courseId),
    queryFn: () => probe<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`),
  });
}

/** Đọc danh sách nhóm của khoá; lỗi → danh sách rỗng. */
export function useCourseGroups(courseId: string | undefined) {
  return useQuery({
    ...courseGroupsQueryOptions(courseId ?? ''),
    enabled: !!courseId,
  });
}
