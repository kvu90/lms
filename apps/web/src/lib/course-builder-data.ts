import { queryOptions, useQuery } from '@tanstack/react-query';
import type {
  Course, CourseContent, CourseGroup, CourseGrouping, GradeItem,
} from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu trang xây dựng khoá học (F-01 đợt 1, rà soát #133):
 * gói dữ liệu builder tải song song đúng nhịp reload() thủ công trước
 * đây — mỗi endpoint có bắt lỗi riêng (lỗi thì null/rỗng, không sập
 * cả trang). Options dùng chung cho hook của trang và clientLoader
 * của route module (prefetch cùng khoá).
 */

/** Hình dạng GET /courses/:id/completion/criteria mà trang builder tiêu thụ. */
export interface BuilderCriteriaView {
  method: number;
  criteria: { id: string; criteriaType: string; moduleInstance: string | null; date: string | null }[];
}

/** Gói dữ liệu trang builder: thông tin khoá, nội dung, các mục điểm, tiêu chí hoàn thành, nhóm và grouping. */
export interface CourseBuilderData {
  course: Course | null;
  content: CourseContent | null;
  gradeItems: GradeItem[];
  criteria: BuilderCriteriaView | null;
  groups: CourseGroup[];
  groupings: CourseGrouping[];
}

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

async function fetchCourseBuilder(courseId: string): Promise<CourseBuilderData> {
  const [course, content, gradeItems, criteria, groups, groupings] = await Promise.all([
    probe<Course>(`/api/v1/courses/${courseId}`),
    probe<CourseContent>(`/api/v1/courses/${courseId}/content`),
    probe<GradeItem[]>(`/api/v1/courses/${courseId}/grade-items`),
    probe<BuilderCriteriaView>(`/api/v1/courses/${courseId}/completion/criteria`),
    probe<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`),
    probe<CourseGrouping[]>(`/api/v1/courses/${courseId}/groupings`),
  ]);
  return {
    course,
    content,
    gradeItems: gradeItems ?? [],
    criteria,
    groups: groups ?? [],
    groupings: groupings ?? [],
  };
}

export function courseBuilderQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseBuilder(courseId),
    queryFn: () => fetchCourseBuilder(courseId),
  });
}

/** Đọc gói builder; chỉ tải khi `enabled` (người xem có quyền xây dựng khoá). */
export function useCourseBuilder(courseId: string, enabled: boolean) {
  return useQuery({ ...courseBuilderQueryOptions(courseId), enabled });
}

export function coursesListQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.courses,
    queryFn: async () => (await probe<Course[]>('/api/v1/courses')) ?? [],
  });
}

/** Danh sách toàn bộ khoá học (khoá nguồn dùng lại nội dung ở trang builder); lỗi tải → rỗng như trước. */
export function useCoursesList() {
  return useQuery(coursesListQueryOptions());
}

export function courseContentQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseContent(courseId),
    queryFn: () => probe<CourseContent>(`/api/v1/courses/${courseId}/content`),
  });
}

/** Nội dung của khoá nguồn đang chọn để dùng lại; chưa chọn thì query tắt. */
export function useCourseContent(courseId: string) {
  return useQuery({
    ...courseContentQueryOptions(courseId),
    enabled: !!courseId,
  });
}
