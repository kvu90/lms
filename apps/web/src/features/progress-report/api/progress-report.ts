import { apiJson } from '#lib/api';
import type { CourseGroup, ProgressReport } from '../types/progress-report';

/**
 * Tầng gọi API thuần của trang báo cáo tiến độ thuộc feature
 * progress-report: chỉ chứa các hàm gọi HTTP, không phụ thuộc
 * React hay React Query. Tầng `queries/` của feature bọc các hàm
 * này thành queryOptions và hook. Tách từ module dữ liệu phẳng
 * `src/lib/progress-report-data.ts` khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500).
 */

/** Tải một endpoint phụ độc lập: lỗi thì trả null (giữ nguyên ngữ nghĩa probe của trang). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Đọc báo cáo tiến độ (GET /courses/:id/progress/report, lọc theo
 * nhóm khi có); lỗi tải → null (trang hiểu là không có quyền), giữ
 * nguyên ngữ nghĩa probe thủ công trước đây.
 *
 * @param courseId - Định danh khoá.
 * @param groupId - Định danh nhóm lọc (rỗng = toàn khoá).
 * @returns Báo cáo tiến độ hoặc null khi lỗi tải.
 */
export function fetchProgressReport(courseId: string, groupId: string) {
  return probe<ProgressReport>(
    `/api/v1/courses/${courseId}/progress/report${groupId ? `?groupId=${groupId}` : ''}`,
  );
}

/**
 * Đọc danh sách nhóm của khoá cho bộ lọc của báo cáo
 * (GET /courses/:id/groups); lỗi → null.
 *
 * @param courseId - Định danh khoá.
 * @returns Danh sách nhóm hoặc null khi lỗi tải.
 */
export function fetchProgressReportGroups(courseId: string) {
  return probe<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`);
}
