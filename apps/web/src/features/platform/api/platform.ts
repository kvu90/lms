import { apiJson } from '#lib/api';
import type {
  BackupJob,
  BackupStep,
  InsightView,
  PrivacyRequestView,
  ReportView,
  ServiceView,
  TokenView,
} from '../types/platform';

/**
 * Tầng gọi API thuần của cụm trang nền tảng thuộc feature
 * platform: chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay
 * React Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions, đột biến và clientLoader. Tách từ module phẳng
 * `src/lib/platform-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

// ---------------------------------------------------------------------
// Insights: insight phân tích đã lọc theo capability của người dùng.
// ---------------------------------------------------------------------

/**
 * Đọc insight của tôi (GET /analytics/insights/me).
 *
 * @returns Danh sách insight.
 */
export function fetchMyInsights() {
  return apiJson<InsightView[]>('/api/v1/analytics/insights/me');
}

// ---------------------------------------------------------------------
// Privacy: người dùng tự gửi yêu cầu export/delete cho chính mình;
// phía quản trị thấy mọi yêu cầu và duyệt/từ chối.
// ---------------------------------------------------------------------

/**
 * Đọc danh sách yêu cầu riêng tư (GET /privacy/requests).
 *
 * @returns Danh sách yêu cầu.
 */
export function fetchPrivacyRequests() {
  return apiJson<PrivacyRequestView[]>('/api/v1/privacy/requests');
}

/**
 * Gửi yêu cầu riêng tư mới (POST /privacy/requests).
 *
 * @param type - Loại yêu cầu: export hoặc delete.
 * @returns Yêu cầu vừa tạo.
 */
export function createPrivacyRequest(type: 'export' | 'delete') {
  return apiJson<PrivacyRequestView>('/api/v1/privacy/requests', {
    method: 'POST',
    body: JSON.stringify({ type }),
  });
}

/**
 * Duyệt/từ chối một yêu cầu (POST /privacy/requests/:id/decide).
 *
 * @param id - Định danh yêu cầu.
 * @param decision - Quyết định: approved hoặc rejected.
 * @returns Yêu cầu sau khi quyết định.
 */
export function decidePrivacyRequest(id: string, decision: 'approved' | 'rejected') {
  return apiJson<PrivacyRequestView>(`/api/v1/privacy/requests/${id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
}

// ---------------------------------------------------------------------
// Backup: tạo việc sao lưu, xem các bước, khôi phục sang khoá mới.
// ---------------------------------------------------------------------

/**
 * Đọc danh sách việc sao lưu (GET /backup/jobs).
 *
 * @returns Danh sách việc.
 */
export function fetchBackupJobs() {
  return apiJson<BackupJob[]>('/api/v1/backup/jobs');
}

/**
 * Đọc các bước của một việc (GET /backup/jobs/:id/steps).
 *
 * @param jobId - Định danh việc.
 * @returns Danh sách bước.
 */
export function fetchBackupSteps(jobId: string) {
  return apiJson<BackupStep[]>(`/api/v1/backup/jobs/${jobId}/steps`);
}

/**
 * Tạo việc sao lưu cho một khoá (POST /backup/jobs).
 *
 * @param courseId - Định danh khoá.
 * @returns Việc vừa tạo.
 */
export function createBackupJob(courseId: string) {
  return apiJson<BackupJob>('/api/v1/backup/jobs', {
    method: 'POST',
    body: JSON.stringify({ courseId }),
  });
}

/**
 * Khôi phục một việc sao lưu thành khoá mới (POST /backup/restore, mode 'new').
 *
 * @param jobId - Định danh việc sao lưu.
 * @returns Việc khôi phục.
 */
export function restoreBackup(jobId: string) {
  return apiJson<BackupJob>('/api/v1/backup/restore', {
    method: 'POST',
    body: JSON.stringify({ backupJobId: jobId, mode: 'new' }),
  });
}

// ---------------------------------------------------------------------
// Tokens: dịch vụ webservice và token tích hợp; token thô chỉ hiện
// một lần ngay khi tạo.
// ---------------------------------------------------------------------

/**
 * Đọc danh sách dịch vụ webservice (GET /webservice/services).
 *
 * @returns Danh sách dịch vụ.
 */
export function fetchWebserviceServices() {
  return apiJson<ServiceView[]>('/api/v1/webservice/services');
}

/**
 * Đọc danh sách token (GET /webservice/tokens).
 *
 * @returns Danh sách token.
 */
export function fetchWebserviceTokens() {
  return apiJson<TokenView[]>('/api/v1/webservice/tokens');
}

/**
 * Tạo dịch vụ webservice (POST /webservice/services).
 *
 * @param input - Tên, tên ngắn và danh sách hàm của dịch vụ.
 * @returns Dịch vụ vừa tạo.
 */
export function createWebserviceService(input: { name: string; shortName: string; functions: string[] }) {
  return apiJson<ServiceView>('/api/v1/webservice/services', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Tạo token cho chính người dùng (POST /webservice/tokens): trước hết
 * lấy hồ sơ của tôi (GET /users/me) để gắn token đúng chủ, giữ nguyên
 * hai bước như bản thủ công.
 *
 * @param serviceId - Định danh dịch vụ.
 * @returns Token thô (chỉ hiện một lần ngay khi tạo).
 */
export async function createWebserviceToken(serviceId: string) {
  const me = await apiJson<{ id: string }>('/api/v1/users/me');
  return apiJson<{ token: string }>('/api/v1/webservice/tokens', {
    method: 'POST',
    body: JSON.stringify({ userId: me.id, serviceId }),
  });
}

/**
 * Thu hồi một token (POST /webservice/tokens/:id/revoke).
 *
 * @param tokenId - Định danh token.
 * @returns Token sau khi thu hồi.
 */
export function revokeWebserviceToken(tokenId: string) {
  return apiJson<TokenView>(`/api/v1/webservice/tokens/${tokenId}/revoke`, {
    method: 'POST',
    body: '{}',
  });
}

// ---------------------------------------------------------------------
// Reports: dựng báo cáo tối thiểu — chọn nguồn/cột, xem kết quả chạy,
// đặt lịch chạy hằng ngày.
// ---------------------------------------------------------------------

/**
 * Đọc danh sách báo cáo (GET /reports).
 *
 * @returns Danh sách báo cáo.
 */
export function fetchPlatformReports() {
  return apiJson<ReportView[]>('/api/v1/reports');
}

/**
 * Đọc kết quả chạy một báo cáo (GET /reports/:id/run).
 *
 * @param reportId - Định danh báo cáo.
 * @returns Các hàng kết quả.
 */
export function fetchReportRun(reportId: string) {
  return apiJson<{ rows: Record<string, unknown>[] }>(`/api/v1/reports/${reportId}/run`);
}

/**
 * Tạo báo cáo (POST /reports) với bộ cột mặc định của trang.
 *
 * @param input - Tên và nguồn dữ liệu.
 * @returns Báo cáo vừa tạo.
 */
export function createReport(input: { name: string; dataSource: string }) {
  return apiJson<ReportView>('/api/v1/reports', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      dataSource: input.dataSource,
      columns: ['userId', 'courseId', 'status'],
      filters: {},
    }),
  });
}

/**
 * Đặt lịch chạy hằng ngày cho một báo cáo (POST /reports/:id/schedules).
 *
 * @param id - Định danh báo cáo.
 * @returns Đáp ứng của API.
 */
export function scheduleReport(id: string) {
  return apiJson(`/api/v1/reports/${id}/schedules`, {
    method: 'POST',
    body: JSON.stringify({ cron: 'daily' }),
  });
}
