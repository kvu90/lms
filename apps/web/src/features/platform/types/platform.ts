/**
 * Kiểu dữ liệu hiển thị của cụm trang nền tảng thuộc feature
 * platform (giữ nguyên hình dạng các trang vẫn tiêu thụ). Tách
 * từ module phẳng `src/lib/platform-data.ts` khi tổ chức lại
 * apps/web theo mô hình features/ (issue #500): kiểu nằm ở tầng
 * types/, lời gọi API thuần ở tầng api/, options/hook và
 * clientLoader ở tầng queries/.
 */

/** Một insight phân tích (trang insights): chỉ insight server đã lọc theo capability mới tới client. */
export interface InsightView {
  id: string;
  userId: string;
  heading: string;
  courseId: string;
}

/** Một yêu cầu quyền riêng tư (trang privacy). */
export interface PrivacyRequestView {
  id: string;
  userId: string;
  type: string;
  status: string;
}

/** Một việc sao lưu/khôi phục (trang backup). */
export interface BackupJob {
  id: string;
  type: string;
  courseId: string;
  targetCourseId: string | null;
  mode: string;
  status: string;
}

/** Một bước trong việc sao lưu (trang backup). */
export interface BackupStep {
  id: string;
  name: string;
  status: string;
}

/** Một dịch vụ webservice (trang tokens). */
export interface ServiceView {
  id: string;
  name: string;
  shortName: string;
  enabled: boolean;
  functions: string[];
}

/** Một token tích hợp (trang tokens). */
export interface TokenView {
  id: string;
  userId: string;
  serviceId: string;
  revoked: boolean;
}

/** Một báo cáo tự dựng (trang reports). */
export interface ReportView {
  id: string;
  name: string;
  dataSource: string;
  columns: string[];
}
