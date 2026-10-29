import { useQueries } from '@tanstack/react-query';
import type { CourseActivityGrid, MyActivityGrades } from '@lms/contracts';
import { apiJson } from '#lib/api';
import { queryKeys } from '#lib/query-keys';

/**
 * Dữ kiện điểm theo khoá DÙNG CHUNG nhiều bề mặt (dashboard, trang
 * grades, loader của route trang chủ): fetcher và hook đa khoá nằm
 * ở tầng hooks dùng chung `src/hooks/` vì không thuộc riêng feature
 * nào — mọi bề mặt đọc qua đúng một khoá `courseAccess` nên
 * dedupe/cache dùng chung (F-02/F-03, rà soát #133). Trước đây nằm
 * trong module dữ liệu phẳng `src/lib/course-grade-data.ts`; tách
 * ra khi tổ chức lại apps/web theo mô hình features/ (issue #500).
 * Phần riêng của trang bảng điểm (lịch sử điểm, đột biến điểm) nằm
 * ở feature grades.
 */

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
  // Map dựng thẳng khi render từ dữ kiện hiện tại của các query:
  // bản cũ memo theo "chữ ký 0/1" (khoá có dữ kiện hay chưa) nên
  // refetch ra điểm mới mà chữ ký không đổi thì Map giữ điểm cũ.
  // Dựng Map rất rẻ so với dữ kiện đã nằm trong bộ nhớ nên không
  // cần memo.
  const map = new Map<string, CourseGradeData>();
  courseIds.forEach((courseId, i) => {
    const data = queries[i]?.data;
    if (data) map.set(courseId, data);
  });
  return map;
}
