import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiJson } from './api';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu TanStack Query cho cụm trang nền tảng (F-01 của rà soát
 * #133): insights, privacy, backup, tokens (webservice) và reports.
 * Năm trang này trước đây tự fetch bằng `useEffect` + `apiJson` thủ công;
 * nay mọi lần đọc đi qua khoá của nhà máy `queryKeys` ở module này, đột
 * biến qua `useMutation` và làm mới đúng cụm khoá của trang mình, để
 * `clientLoader` của từng route prefetch đúng khoá component sẽ đọc —
 * dữ liệu tải một lần, dùng chung cache, không còn vòng chờ tải lại.
 *
 * Hai hành vi hiển thị được giữ nguyên từ bản thủ công:
 *   - Nút "Thử lại" của từng trang: khi bấm, trang quay về trạng thái
 *     đang tải (khung xương) và ẩn thông báo lỗi cho tới khi lần tải lại
 *     kết thúc — component suy ra từ `isPending`/`isError`/`isFetching`
 *     thay vì hai biến trạng thái tự quản như trước.
 *   - Danh sách bước của một việc sao lưu và kết quả chạy một báo cáo là
 *     dữ liệu theo lựa chọn hiện tại của người dùng: query giữ lại dữ
 *     liệu lần chọn trước trong lúc tải lần chọn mới (`keepPreviousData`)
 *     đúng như bản thủ công chỉ thay dữ liệu khi lần tải mới xong.
 */

// ---------------------------------------------------------------------
// Kiểu dữ liệu hiển thị (giữ nguyên hình dạng các trang vẫn tiêu thụ).
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Insights: insight phân tích đã lọc theo capability của người dùng.
// ---------------------------------------------------------------------

/** Tuỳ chọn truy vấn insight của tôi (GET /analytics/insights/me). */
export function myInsightsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.myInsights,
    queryFn: () => apiJson<InsightView[]>('/api/v1/analytics/insights/me'),
  });
}

/** Hook đọc insight của tôi cho trang insights. */
export function useMyInsights() {
  return useQuery(myInsightsQueryOptions());
}

/** clientLoader (F-01, #133): nạp trước insight của tôi đúng khoá trang insights sẽ đọc. */
export async function insightsPageClientLoader() {
  await queryClient.prefetchQuery(myInsightsQueryOptions());
  return null;
}

// ---------------------------------------------------------------------
// Privacy: người dùng tự gửi yêu cầu export/delete cho chính mình;
// phía quản trị thấy mọi yêu cầu và duyệt/từ chối.
// ---------------------------------------------------------------------

/** Tuỳ chọn truy vấn danh sách yêu cầu riêng tư (GET /privacy/requests). */
export function privacyRequestsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.privacyRequests,
    queryFn: () => apiJson<PrivacyRequestView[]>('/api/v1/privacy/requests'),
  });
}

/** Hook đọc danh sách yêu cầu riêng tư cho trang privacy. */
export function usePrivacyRequests() {
  return useQuery(privacyRequestsQueryOptions());
}

/**
 * Đột biến gửi yêu cầu riêng tư mới (POST /privacy/requests) — thành
 * công thì làm mới danh sách để yêu cầu vừa gửi hiện ngay ở trạng thái
 * chờ duyệt, đúng hành vi tải lại của bản thủ công. Đáp ứng tạo mới được
 * trả về để trang hiện dòng xác nhận kèm id/loại/trạng thái như trước.
 */
export function useCreatePrivacyRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (type: 'export' | 'delete') =>
      apiJson<PrivacyRequestView>('/api/v1/privacy/requests', {
        method: 'POST',
        body: JSON.stringify({ type }),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.privacyRequests }),
  });
}

/**
 * Đột biến duyệt/từ chối một yêu cầu (POST /privacy/requests/:id/decide)
 * — thành công thì làm mới danh sách để trạng thái mới hiện ngay.
 */
export function useDecidePrivacyRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      apiJson<PrivacyRequestView>(`/api/v1/privacy/requests/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.privacyRequests }),
  });
}

/** clientLoader (F-01, #133): nạp trước danh sách yêu cầu riêng tư đúng khoá trang privacy sẽ đọc. */
export async function privacyPageClientLoader() {
  await queryClient.prefetchQuery(privacyRequestsQueryOptions());
  return null;
}

// ---------------------------------------------------------------------
// Backup: tạo việc sao lưu, xem các bước, khôi phục sang khoá mới.
// ---------------------------------------------------------------------

/** Tuỳ chọn truy vấn danh sách việc sao lưu (GET /backup/jobs). */
export function backupJobsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.backupJobs,
    queryFn: () => apiJson<BackupJob[]>('/api/v1/backup/jobs'),
  });
}

/** Hook đọc danh sách việc sao lưu cho trang backup. */
export function useBackupJobs() {
  return useQuery(backupJobsQueryOptions());
}

/** Tuỳ chọn truy vấn các bước của một việc (GET /backup/jobs/:id/steps). */
export function backupStepsQueryOptions(jobId: string) {
  return queryOptions({
    queryKey: queryKeys.backupSteps(jobId),
    queryFn: () => apiJson<BackupStep[]>(`/api/v1/backup/jobs/${jobId}/steps`),
  });
}

/**
 * Hook đọc các bước của việc đang được chọn xem: chưa chọn việc nào thì
 * không gọi API (trang chỉ hiện bước sau khi người dùng bấm xem); đổi
 * việc thì giữ bước của việc trước trong lúc tải, như bản thủ công.
 */
export function useBackupSteps(selectedJobId: string | null) {
  return useQuery({
    ...backupStepsQueryOptions(selectedJobId ?? ''),
    enabled: selectedJobId !== null,
    placeholderData: keepPreviousData,
  });
}

/**
 * Đột biến tạo việc sao lưu cho một khoá (POST /backup/jobs) — thành
 * công thì làm mới danh sách việc để việc vừa tạo hiện ngay.
 */
export function useCreateBackupJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (courseId: string) =>
      apiJson<BackupJob>('/api/v1/backup/jobs', {
        method: 'POST',
        body: JSON.stringify({ courseId }),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.backupJobs }),
  });
}

/**
 * Đột biến khôi phục một việc sao lưu thành khoá mới (POST
 * /backup/restore, mode 'new') — thành công thì làm mới danh sách việc
 * để việc khôi phục hiện ngay.
 */
export function useRestoreBackup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiJson<BackupJob>('/api/v1/backup/restore', {
        method: 'POST',
        body: JSON.stringify({ backupJobId: jobId, mode: 'new' }),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.backupJobs }),
  });
}

/** clientLoader (F-01, #133): nạp trước danh sách việc sao lưu đúng khoá trang backup sẽ đọc. */
export async function backupPageClientLoader() {
  await queryClient.prefetchQuery(backupJobsQueryOptions());
  return null;
}

// ---------------------------------------------------------------------
// Tokens: dịch vụ webservice và token tích hợp; token thô chỉ hiện
// một lần ngay khi tạo.
// ---------------------------------------------------------------------

/** Tuỳ chọn truy vấn danh sách dịch vụ webservice (GET /webservice/services). */
export function webserviceServicesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.webserviceServices,
    queryFn: () => apiJson<ServiceView[]>('/api/v1/webservice/services'),
  });
}

/** Hook đọc danh sách dịch vụ webservice cho trang tokens. */
export function useWebserviceServices() {
  return useQuery(webserviceServicesQueryOptions());
}

/** Tuỳ chọn truy vấn danh sách token (GET /webservice/tokens). */
export function webserviceTokensQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.webserviceTokens,
    queryFn: () => apiJson<TokenView[]>('/api/v1/webservice/tokens'),
  });
}

/**
 * Hook đọc danh sách token cho trang tokens. Bản thủ công nuốt lỗi của
 * riêng danh sách token (coi như danh sách rỗng) trong khi lỗi danh sách
 * dịch vụ mới làm cả trang báo lỗi; trang giữ đúng phân biệt đó bằng
 * cách chỉ đọc `data` của query này (lỗi thì hiển thị rỗng).
 */
export function useWebserviceTokens() {
  return useQuery(webserviceTokensQueryOptions());
}

/**
 * Đột biến tạo dịch vụ webservice (POST /webservice/services) — thành
 * công thì làm mới cả hai danh sách của trang như lần tải lại thủ công.
 */
export function useCreateWebserviceService() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; shortName: string; functions: string[] }) =>
      apiJson<ServiceView>('/api/v1/webservice/services', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.webserviceServices });
      void client.invalidateQueries({ queryKey: queryKeys.webserviceTokens });
    },
  });
}

/**
 * Đột biến tạo token cho chính người dùng (POST /webservice/tokens):
 * trước hết lấy hồ sơ của tôi (GET /users/me) để gắn token đúng chủ,
 * giữ nguyên hai bước như bản thủ công. Đáp ứng mang token thô — trang
 * hiện nó đúng một lần ngay sau khi tạo.
 */
export function useCreateWebserviceToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (serviceId: string) => {
      const me = await apiJson<{ id: string }>('/api/v1/users/me');
      return apiJson<{ token: string }>('/api/v1/webservice/tokens', {
        method: 'POST',
        body: JSON.stringify({ userId: me.id, serviceId }),
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.webserviceServices });
      void client.invalidateQueries({ queryKey: queryKeys.webserviceTokens });
    },
  });
}

/**
 * Đột biến thu hồi một token (POST /webservice/tokens/:id/revoke) —
 * thành công thì làm mới cả hai danh sách của trang như bản thủ công.
 */
export function useRevokeWebserviceToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      apiJson<TokenView>(`/api/v1/webservice/tokens/${tokenId}/revoke`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.webserviceServices });
      void client.invalidateQueries({ queryKey: queryKeys.webserviceTokens });
    },
  });
}

/** clientLoader (F-01, #133): nạp trước cả hai danh sách đúng khoá trang tokens sẽ đọc. */
export async function tokensPageClientLoader() {
  await Promise.all([
    queryClient.prefetchQuery(webserviceServicesQueryOptions()),
    queryClient.prefetchQuery(webserviceTokensQueryOptions()),
  ]);
  return null;
}

// ---------------------------------------------------------------------
// Reports: dựng báo cáo tối thiểu — chọn nguồn/cột, xem kết quả chạy,
// đặt lịch chạy hằng ngày.
// ---------------------------------------------------------------------

/** Tuỳ chọn truy vấn danh sách báo cáo (GET /reports). */
export function platformReportsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.platformReports,
    queryFn: () => apiJson<ReportView[]>('/api/v1/reports'),
  });
}

/** Hook đọc danh sách báo cáo cho trang reports. */
export function usePlatformReports() {
  return useQuery(platformReportsQueryOptions());
}

/** Tuỳ chọn truy vấn kết quả chạy một báo cáo (GET /reports/:id/run). */
export function reportRunQueryOptions(reportId: string) {
  return queryOptions({
    queryKey: queryKeys.reportRun(reportId),
    queryFn: () => apiJson<{ rows: Record<string, unknown>[] }>(`/api/v1/reports/${reportId}/run`),
  });
}

/**
 * Hook đọc kết quả chạy của báo cáo đang được chọn chạy: chưa chọn thì
 * không gọi API; đổi báo cáo thì giữ kết quả lần chạy trước trong lúc
 * tải, đúng như bản thủ công chỉ thay hàng khi lần chạy mới xong.
 */
export function useReportRun(selectedReportId: string | null) {
  return useQuery({
    ...reportRunQueryOptions(selectedReportId ?? ''),
    enabled: selectedReportId !== null,
    placeholderData: keepPreviousData,
  });
}

/**
 * Đột biến tạo báo cáo (POST /reports) với bộ cột mặc định của trang —
 * thành công thì làm mới danh sách báo cáo để báo cáo vừa tạo hiện ngay.
 */
export function useCreateReport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; dataSource: string }) =>
      apiJson<ReportView>('/api/v1/reports', {
        method: 'POST',
        body: JSON.stringify({
          name: input.name,
          dataSource: input.dataSource,
          columns: ['userId', 'courseId', 'status'],
          filters: {},
        }),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.platformReports }),
  });
}

/**
 * Đột biến đặt lịch chạy hằng ngày cho một báo cáo (POST
 * /reports/:id/schedules). Bản thủ công không tải lại danh sách sau khi
 * đặt lịch nên đột biến này cố ý không làm mới khoá nào.
 */
export function useScheduleReport() {
  return useMutation({
    mutationFn: (id: string) =>
      apiJson(`/api/v1/reports/${id}/schedules`, {
        method: 'POST',
        body: JSON.stringify({ cron: 'daily' }),
      }),
  });
}

/** clientLoader (F-01, #133): nạp trước danh sách báo cáo đúng khoá trang reports sẽ đọc. */
export async function reportsPageClientLoader() {
  await queryClient.prefetchQuery(platformReportsQueryOptions());
  return null;
}
