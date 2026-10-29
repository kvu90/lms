import type {
  GuardianDigestFrequency, GuardianDigestPreferenceView, GuardianStudentOverviewView, GuardianStudentResultsView,
} from '@lms/contracts';
import { apiJson } from '#lib/api';
import type { CreateGuardianLinkDraft, GuardianLinkView, GuardianMyStudentEntry } from '../types/guardians';

/**
 * Tầng gọi API thuần của bề mặt phụ huynh thuộc feature guardians:
 * chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React
 * Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions, đột biến và clientLoader. Tách từ module phẳng
 * `src/lib/guardian-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

/**
 * Đọc các con đang liên kết giám hộ với chính người dùng (GET /guardian-links/mine/students).
 *
 * @returns Danh sách liên kết con.
 */
export function fetchGuardianMyStudents() {
  return apiJson<GuardianMyStudentEntry[]>('/api/v1/guardian-links/mine/students');
}

/**
 * Đọc tổng quan phụ huynh cho một con (GET /guardian/students/:id/overview).
 *
 * @param studentId - Định danh con.
 * @returns Tổng quan của con.
 */
export function fetchGuardianOverview(studentId: string) {
  return apiJson<GuardianStudentOverviewView>(`/api/v1/guardian/students/${studentId}/overview`);
}

/**
 * Đọc kết quả đã công bố của một con (GET /guardian/students/:id/results).
 *
 * @param studentId - Định danh con.
 * @returns Kết quả của con.
 */
export function fetchGuardianResults(studentId: string) {
  return apiJson<GuardianStudentResultsView>(`/api/v1/guardian/students/${studentId}/results`);
}

/**
 * Đọc tuỳ chọn tần suất digest của phụ huynh cho một con (GET /guardian/students/:id/digest-preference).
 *
 * @param studentId - Định danh con.
 * @returns Tuỳ chọn digest hiện tại.
 */
export function fetchGuardianDigestPreference(studentId: string) {
  return apiJson<GuardianDigestPreferenceView>(`/api/v1/guardian/students/${studentId}/digest-preference`);
}

/**
 * Đặt tần suất digest cho một con (PUT /guardian/students/:id/digest-preference).
 *
 * @param studentId - Định danh con.
 * @param frequency - Tần suất mới.
 * @returns Tuỳ chọn digest sau khi lưu.
 */
export function updateGuardianDigestPreference(studentId: string, frequency: GuardianDigestFrequency) {
  return apiJson<GuardianDigestPreferenceView>(
    `/api/v1/guardian/students/${studentId}/digest-preference`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frequency }) },
  );
}

/**
 * Đọc danh sách liên kết cho bề mặt quản lý (GET /guardian-links không bộ lọc).
 *
 * @returns Danh sách liên kết của tenant hiệu lực.
 */
export function fetchGuardianLinks() {
  return apiJson<GuardianLinkView[]>('/api/v1/guardian-links');
}

/**
 * Tạo liên kết giám hộ (POST /guardian-links).
 *
 * @param draft - Thân tạo liên kết.
 * @returns Liên kết vừa tạo.
 */
export function createGuardianLink(draft: CreateGuardianLinkDraft) {
  return apiJson<GuardianLinkView>('/api/v1/guardian-links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
}

/**
 * Thu hồi liên kết giám hộ (DELETE /guardian-links/:linkId) — thu hồi mềm phía API.
 *
 * @param linkId - Định danh liên kết.
 * @returns Liên kết sau khi thu hồi.
 */
export function revokeGuardianLink(linkId: string) {
  return apiJson<GuardianLinkView>(`/api/v1/guardian-links/${linkId}`, { method: 'DELETE' });
}
