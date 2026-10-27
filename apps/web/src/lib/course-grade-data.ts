import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { CourseActivityGrid, MyActivityGrades } from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Dữ liệu điểm hiển thị của một khoá (không quyết định phân loại quyền):
 * lưới điểm theo bài toàn lớp + điểm theo bài của chính người dùng.
 */
export interface CourseGradeData {
  /** Lưới điểm theo bài toàn lớp (dữ liệu cho khối giảng dạy; null nếu không tải được). */
  report: CourseActivityGrid | null;
  /** Điểm theo từng bài của chính người dùng trong khoá (null nếu không truy cập được). */
  gradebook: MyActivityGrades | null;
}

/** Tải một tài nguyên đọc: trả dữ liệu khi gọi được, null khi bị từ chối/lỗi. */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Hai lượt dò dữ liệu điểm của một khoá, chạy song song trong một query
 * (khoá TanStack `courseAccess`). Mỗi endpoint lỗi độc lập thì phần đó
 * null, không sập cả query. Đây là fetcher DÙNG CHUNG của mọi bề mặt cần
 * dữ liệu điểm theo khoá (dashboard, trang grades) — các bề mặt đọc qua
 * đúng một khoá nên dedupe/cache dùng chung (F-02/F-03, rà soát #133).
 */
export async function fetchCourseGradeData(courseId: string): Promise<CourseGradeData> {
  const [report, gradebook] = await Promise.all([
    probe<CourseActivityGrid>(`/api/v1/courses/${courseId}/gradebook/report`),
    probe<MyActivityGrades>(`/api/v1/courses/${courseId}/gradebook`),
  ]);
  return { report, gradebook };
}

/**
 * Tải lười dữ liệu điểm của MỘT khoá tại bề mặt tiêu thụ (F-02, rà soát
 * #133): PermissionsProvider KHÔNG còn tải háo hức dữ liệu này cho mọi
 * khoá khi nạp app nữa — chỉ bề mặt nào thật sự hiển thị điểm của khoá
 * (trang grades, khối dashboard) mới gọi hook này, và chỉ cho khoá nó
 * cần. `courseId` rỗng/null thì query tắt.
 */
export function useCourseGradeData(courseId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.courseAccess(courseId ?? ''),
    queryFn: () => fetchCourseGradeData(courseId as string),
    enabled: !!courseId,
  });
}

/**
 * Tải lười dữ liệu điểm cho NHIỀU khoá tại bề mặt tiêu thụ (khối giảng
 * dạy/học viên của dashboard cần đủ mọi khoá mình thuộc về): một query
 * theo khoá qua `useQueries`, trả Map theo courseId. Khoá nào đang tải
 * hoặc lỗi thì phần tử vắng mặt trong Map (bề mặt tự suy biến về null).
 */
export function useCoursesGradeData(courseIds: string[]) {
  const queries = useQueries({
    queries: courseIds.map((courseId) => ({
      queryKey: queryKeys.courseAccess(courseId),
      queryFn: () => fetchCourseGradeData(courseId),
    })),
  });
  return useMemo(() => {
    const map = new Map<string, CourseGradeData>();
    courseIds.forEach((courseId, i) => {
      const data = queries[i]?.data;
      if (data) map.set(courseId, data);
    });
    return map;
    // queries là mảng kết quả theo đúng thứ tự courseIds; phụ thuộc vào
    // chữ ký dữ liệu của từng query để Map dựng lại khi có khoá tải xong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseIds.join(','), queries.map((q) => (q.data ? 1 : 0)).join('')]);
}
