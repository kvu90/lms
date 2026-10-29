/**
 * Kiểu dữ liệu của trang báo cáo tiến độ thuộc feature
 * progress-report. Tách từ module dữ liệu phẳng
 * `src/lib/progress-report-data.ts` khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500): kiểu nằm ở tầng types/, lời gọi
 * API thuần ở tầng api/, tuỳ chọn truy vấn và hook ở tầng queries/.
 */

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
