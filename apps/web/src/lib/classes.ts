import type {
  AddRosterStudentResult,
  ClassJoinPreview,
  ClassJoinRequest,
  ClassListItem,
  ClassOverview,
  ClassPublicView,
  ClassRosterImportReport,
  ClassRosterMember,
  ClassStaffRole,
  ClassStaffView,
  ClassSuspendedMember,
  ClassView,
  Course,
  JoinClassResult,
  RosterStudentIdentity,
} from '@lms/contracts';
import { apiFetch, apiJson } from '#lib/api';

/**
 * Đường gọi API lớp học (CLASS-1, issue #184) — web chỉ trình bày +
 * dẫn luồng; mọi gác quyền và luật vòng đời nằm ở API module classes.
 * Kiểu dữ liệu lấy thẳng từ @lms/contracts để không lệch hợp đồng.
 */
export type {
  AddRosterStudentResult,
  ClassJoinPreview,
  ClassJoinRequest,
  ClassListItem,
  ClassOverview,
  ClassPublicView,
  ClassRosterImportReport,
  ClassRosterMember,
  ClassStaffRole,
  ClassStaffView,
  ClassSuspendedMember,
  ClassView,
  JoinClassResult,
  RosterStudentIdentity,
};

/** Ba vai lớp theo thứ tự hiển thị ở bề mặt phân quyền (giao bài / chấm bài / quản roster). */
export const CLASS_STAFF_ROLE_ORDER: ClassStaffRole[] = ['classassigner', 'classgrader', 'classrostermanager'];

/**
 * Danh sách lớp của người gọi (GET /classes): mỗi dòng kèm bốn cờ
 * khả năng do server suy cho đúng người gọi (`canCreate` /
 * `canUpdate` / `canDelete` / `canManageRoster`) — trang danh sách
 * lớp vẽ nút "Tạo lớp" và các hành động của từng dòng thuần theo
 * các cờ này; quyền thật vẫn gác ở API.
 */
export function fetchClasses(): Promise<ClassListItem[]> {
  return apiJson<ClassListItem[]>('/api/v1/classes');
}

export function fetchClass(classId: string): Promise<ClassView> {
  return apiJson<ClassView>(`/api/v1/classes/${classId}`);
}

/**
 * Gói tổng quan cho DASHBOARD THEO LỚP (CLASS-2): server suy quan hệ
 * của người gọi với lớp (chủ lớp / đồng GV / học sinh) và lọc sẵn danh
 * sách khoá theo vai — học sinh chỉ nhận các khoá mình đang ghi danh
 * ACTIVE trong lớp. Trang chi tiết lớp dựng mọi khối hiển thị theo gói
 * này; quyền thật vẫn gác ở từng endpoint phía API.
 *
 * @param classId - Id của lớp cần xem tổng quan.
 * @returns Gói tổng quan khớp `classOverviewSchema` của contracts.
 */
export function fetchClassOverview(classId: string): Promise<ClassOverview> {
  return apiJson<ClassOverview>(`/api/v1/classes/${classId}/overview`);
}

/**
 * Mở (ensure) CHAT CẤP LỚP phía messaging (lát MSG-T2): server cấp
 * phát lười conversation riêng của lớp và trả id của nó — trang lớp
 * chỉ điều hướng sang trang Tin nhắn mở đúng conversation đó. Gác
 * quyền (chỉ người thuộc lớp mở được) nằm ở API messaging.
 *
 * @param classId - Id của lớp cần mở chat.
 * @returns Id của conversation cấp lớp (tạo mới ở lần mở đầu hoặc
 *   conversation đã có của lớp).
 * @throws Khi API trả lỗi (ví dụ 404 với người ngoài lớp) — phía
 *   gọi hiển thị thông báo mở chat thất bại.
 */
export function ensureClassConversation(classId: string): Promise<{ id: string }> {
  return apiJson<{ id: string }>(`/api/v1/messages/classes/${classId}/conversation`);
}

export function createClass(input: { name: string; code?: string; schoolYear?: string; description?: string }): Promise<ClassView> {
  return apiJson<ClassView>('/api/v1/classes', { method: 'POST', body: JSON.stringify(input) });
}

export function updateClass(
  classId: string,
  input: {
    name?: string; code?: string | null; schoolYear?: string | null; description?: string;
    allowSelfReport?: boolean; joinAutoApprove?: boolean; onLeave?: 'suspend' | 'unenrol'; rotateJoinCode?: boolean;
    /** CLASS-3: đặt/đổi học phí gói lớp (`feeCost` null/0 = tắt thu qua hệ; `feePaymentAccountId` null = tài khoản mặc định của tenant). */
    feeCost?: number | null; feeCurrency?: string; feePaymentAccountId?: string | null;
  },
): Promise<ClassView> {
  return apiJson<ClassView>(`/api/v1/classes/${classId}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function archiveClass(classId: string): Promise<ClassView> {
  return apiJson<ClassView>(`/api/v1/classes/${classId}/archive`, { method: 'POST', body: JSON.stringify({}) });
}

export function deleteClass(classId: string): Promise<{ deleted: boolean }> {
  return apiJson<{ deleted: boolean }>(`/api/v1/classes/${classId}`, { method: 'DELETE' });
}

export function fetchClassCourses(classId: string): Promise<Course[]> {
  return apiJson<Course[]>(`/api/v1/classes/${classId}/courses`);
}

/**
 * Roster của lớp (GET /classes/:id/roster): trường liên hệ (email,
 * username) chỉ đầy đủ khi người gọi có quyền quản roster của lớp —
 * server làm rỗng hai trường này với các vai xem lớp còn lại, trang
 * chi tiết chỉ tải roster cho vai được quản trị nên hiển thị không
 * đổi.
 */
export function fetchRoster(classId: string): Promise<ClassRosterMember[]> {
  return apiJson<ClassRosterMember[]>(`/api/v1/classes/${classId}/roster`);
}

export function addRosterMember(classId: string, userId: string): Promise<{ added: boolean }> {
  return apiJson<{ added: boolean }>(`/api/v1/classes/${classId}/roster`, { method: 'POST', body: JSON.stringify({ userId }) });
}

export function removeRosterMember(classId: string, userId: string): Promise<{ removed: boolean }> {
  return apiJson<{ removed: boolean }>(`/api/v1/classes/${classId}/roster/${userId}`, { method: 'DELETE' });
}

export function addRosterStudentByIdentity(classId: string, input: RosterStudentIdentity): Promise<AddRosterStudentResult> {
  return apiJson<AddRosterStudentResult>(`/api/v1/classes/${classId}/roster/identity`, { method: 'POST', body: JSON.stringify(input) });
}

export function importRosterRows(classId: string, rows: RosterStudentIdentity[]): Promise<ClassRosterImportReport> {
  return apiJson<ClassRosterImportReport>(`/api/v1/classes/${classId}/roster/import`, { method: 'POST', body: JSON.stringify({ rows }) });
}

export function fetchSuspendedMembers(classId: string): Promise<ClassSuspendedMember[]> {
  return apiJson<ClassSuspendedMember[]>(`/api/v1/classes/${classId}/roster/suspended`);
}

export function fetchClassStaff(classId: string): Promise<ClassStaffView> {
  return apiJson<ClassStaffView>(`/api/v1/classes/${classId}/staff`);
}

export function setClassStaffRoles(classId: string, input: { userId?: string; email?: string; roles: ClassStaffRole[] }): Promise<ClassStaffView> {
  return apiJson<ClassStaffView>(`/api/v1/classes/${classId}/staff`, { method: 'POST', body: JSON.stringify(input) });
}

export function fetchJoinRequests(classId: string): Promise<ClassJoinRequest[]> {
  return apiJson<ClassJoinRequest[]>(`/api/v1/classes/${classId}/join-requests`);
}

export function decideJoinRequest(classId: string, requestId: string, approve: boolean): Promise<ClassJoinRequest> {
  return apiJson<ClassJoinRequest>(`/api/v1/classes/${classId}/join-requests/${requestId}/${approve ? 'approve' : 'reject'}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function previewJoinClass(code: string): Promise<ClassJoinPreview> {
  return apiJson<ClassJoinPreview>(`/api/v1/classes/join-preview?code=${encodeURIComponent(code)}`);
}

export function joinClassByCode(joinCode: string): Promise<JoinClassResult> {
  return apiJson<JoinClassResult>('/api/v1/classes/join', { method: 'POST', body: JSON.stringify({ joinCode }) });
}

/** Nạp roster trực tiếp từ file Excel (multipart): server đọc sheet đầu tiên và trả báo cáo từng dòng. */
export async function importRosterFile(classId: string, file: File): Promise<ClassRosterImportReport> {
  const form = new FormData();
  form.set('file', file);
  const res = await apiFetch(`/api/v1/classes/${classId}/roster/import-file`, { method: 'POST', body: form });
  if (!res.ok) throw new Error('import failed');
  return (await res.json()) as ClassRosterImportReport;
}

/** Tải file mẫu roster .xlsx (endpoint đòi đăng nhập nên fetch kèm token rồi tải blob — cùng khuôn tải ICS ở trang Lịch). */
export async function downloadRosterTemplate(): Promise<void> {
  const res = await apiFetch('/api/v1/classes/roster-template');
  if (!res.ok) throw new Error('template download failed');
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = 'mau-danh-sach-hoc-sinh.xlsx';
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

/** Tên hiển thị "Họ Tên" của một dòng người dùng; rơi về username khi thiếu tên. */
export function personName(p: { firstName: string; lastName: string; username: string }): string {
  const full = `${p.lastName} ${p.firstName}`.trim();
  return full || p.username;
}

// ---------------------------------------------------------------------------
// CLASS-3 (issue #184): học phí theo lớp — gói công khai + bắt đầu thanh
// toán gói lớp. Web chỉ trình bày và dẫn luồng; luật tiền nằm ở API.
// ---------------------------------------------------------------------------

/**
 * Gói công khai của lớp (GET /classes/:id/public): thông tin lớp + gói
 * học phí cho người CHƯA ghi danh, kèm cờ `isMember`/`canPurchase` do
 * server suy cho đúng người gọi — trang mua gói dựng hiển thị thuần
 * theo gói này (đã là thành viên thì không hiện nút mua).
 *
 * @param classId - Id của lớp cần xem gói.
 * @returns Gói khớp `classPublicViewSchema` của contracts.
 */
export function fetchClassPublic(classId: string): Promise<ClassPublicView> {
  return apiJson<ClassPublicView>(`/api/v1/classes/${classId}/public`);
}

/**
 * Hình dạng payment gói lớp ở bề mặt web (PaymentView của API): trang
 * mua gói cần trạng thái, mã thanh toán nhúng trong nội dung chuyển
 * khoản và chuỗi payload VietQR để tự render mã QR (cùng khuôn trang
 * khoá học với payment `enrol_fee`).
 */
export interface ClassFeePaymentView {
  id: string;
  amount: number;
  currency: string;
  status: string;
  component: string;
  itemId: string | null;
  paymentCode: string | null;
  vietqrPayload: string | null;
}

/**
 * Bắt đầu thanh toán gói lớp (POST /payments/class-fee/:classId): tạo
 * payment `class_fee` ở trạng thái chờ. TUYỆT ĐỐI không ghi danh tại
 * đây — ghi danh cấp lớp chỉ kích hoạt khi payment `succeeded` qua đối
 * soát SePay/webhook ở phía API.
 *
 * @param classId - Id của lớp được mua gói.
 * @returns Payment vừa tạo (kèm payload VietQR khi tài khoản nhận là SePay).
 */
export function createClassFeePayment(classId: string): Promise<ClassFeePaymentView> {
  return apiJson<ClassFeePaymentView>(`/api/v1/payments/class-fee/${classId}`, { method: 'POST', body: JSON.stringify({}) });
}

/**
 * Đọc lại một payment của chính người dùng (GET /payments/:id) — trang
 * mua gói poll trạng thái này sau khi hiện QR để biết đối soát đã khớp
 * (succeeded) hay còn chờ.
 *
 * @param paymentId - Id của payment cần đọc trạng thái.
 */
export function fetchPayment(paymentId: string): Promise<ClassFeePaymentView> {
  return apiJson<ClassFeePaymentView>(`/api/v1/payments/${paymentId}`);
}
