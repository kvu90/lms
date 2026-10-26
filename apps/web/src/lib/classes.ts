import type {
  AddRosterStudentResult,
  ClassJoinPreview,
  ClassJoinRequest,
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

export function fetchClasses(): Promise<ClassView[]> {
  return apiJson<ClassView[]>('/api/v1/classes');
}

export function fetchClass(classId: string): Promise<ClassView> {
  return apiJson<ClassView>(`/api/v1/classes/${classId}`);
}

export function createClass(input: { name: string; code?: string; schoolYear?: string; description?: string }): Promise<ClassView> {
  return apiJson<ClassView>('/api/v1/classes', { method: 'POST', body: JSON.stringify(input) });
}

export function updateClass(
  classId: string,
  input: { name?: string; code?: string | null; schoolYear?: string | null; description?: string; allowSelfReport?: boolean; joinAutoApprove?: boolean; onLeave?: 'suspend' | 'unenrol'; rotateJoinCode?: boolean },
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
