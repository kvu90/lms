import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/**
 * Hợp đồng API của LỚP HỌC HẠNG NHẤT (issue #184, CLASS-0): lớp được tạo
 * TRƯỚC, khoá học nằm bên trong lớp; danh sách học sinh thuộc về lớp
 * (roster ≡ thành viên backing cohort) và tự vật chất hoá xuống mọi
 * khoá của lớp qua enrol instance cohort. Tạo lớp chỉ bắt buộc TÊN
 * (khuôn Azota); học phí theo lớp thuộc lát CLASS-3, không có ở đây.
 */
export const CLASS_ON_LEAVE_MODES = ['suspend', 'unenrol'] as const;
export const CLASS_STATUSES = ['active', 'archived'] as const;

/** Hình dạng một lớp ở bề mặt API. `joinCode` là bí mật: chỉ chủ lớp / người có quyền quản roster mới nhận giá trị thật, còn lại nhận `null`. */
export const classSchema = z.object({
  id: uuidIdSchema,
  tenantId: uuidIdSchema,
  name: z.string(),
  code: z.string().nullable(),
  schoolYear: z.string().nullable(),
  ownerId: uuidIdSchema,
  cohortId: uuidIdSchema,
  allowSelfReport: z.boolean(),
  joinCode: z.string().nullable(),
  /** Tự duyệt tự báo danh: true = học sinh xin vào qua mã là vào thẳng roster kể cả khi lớp đã có học sinh (mặc định false — xem luật tự báo danh ở hợp đồng join bên dưới). */
  joinAutoApprove: z.boolean(),
  onLeave: z.enum(CLASS_ON_LEAVE_MODES),
  status: z.enum(CLASS_STATUSES),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClassView = z.infer<typeof classSchema>;

/**
 * Tạo lớp — chỉ `name` bắt buộc. `ownerId` chỉ dùng khi người tạo có
 * `tenant:manage` tại tenant (admin trung tâm/platform tạo lớp hộ giáo
 * viên); mặc định chủ lớp là chính người tạo.
 */
export const createClassSchema = z.strictObject({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(80).optional(),
  schoolYear: z.string().min(1).max(40).optional(),
  description: z.string().max(2000).optional(),
  ownerId: uuidIdSchema.optional(),
});
export type CreateClass = z.infer<typeof createClassSchema>;

/** Sửa lớp: thông tin hiển thị + công tắc tự báo danh + chế độ khi rời lớp; `rotateJoinCode: true` sinh mã tham gia mới (mã cũ mất hiệu lực ngay). */
export const updateClassSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(80).nullable().optional(),
  schoolYear: z.string().min(1).max(40).nullable().optional(),
  description: z.string().max(2000).optional(),
  allowSelfReport: z.boolean().optional(),
  joinAutoApprove: z.boolean().optional(),
  onLeave: z.enum(CLASS_ON_LEAVE_MODES).optional(),
  rotateJoinCode: z.boolean().optional(),
});
export type UpdateClass = z.infer<typeof updateClassSchema>;

/**
 * Một dòng roster của lớp (≡ một dòng cohort_members của backing
 * cohort) kèm thông tin hiển thị của tài khoản — bề mặt GV (CLASS-1)
 * cần tên/định danh để quản danh sách, không tra cứu thêm từng người.
 */
export const classRosterMemberSchema = z.object({
  userId: uuidIdSchema,
  timeAdded: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  username: z.string(),
  email: z.string(),
});
export type ClassRosterMember = z.infer<typeof classRosterMemberSchema>;

/** Thêm một học sinh vào roster của lớp — ghi danh cấp lớp, tự đồng bộ xuống mọi khoá trong lớp. */
export const addClassRosterMemberSchema = z.strictObject({
  userId: uuidIdSchema,
});
export type AddClassRosterMember = z.infer<typeof addClassRosterMemberSchema>;

// ---------------------------------------------------------------------------
// CLASS-1 (issue #184): bề mặt giáo viên — nạp roster theo định danh,
// import Excel, phân quyền đồng GV tại context lớp, tự báo danh.
// ---------------------------------------------------------------------------

/**
 * Định danh một học sinh khi GV nạp roster bằng tay / qua file Excel
 * (mẫu Azota: Họ tên | SĐT | Email | Ngày sinh). Khớp tài khoản theo
 * EMAIL trước, không có email thì theo SĐT (= username); không khớp thì
 * hệ tạo tài khoản mới với mật khẩu tạm (buộc đổi ở lần đăng nhập đầu).
 * Phải có ít nhất một trong hai định danh email/SĐT — thiếu cả hai là lỗi
 * nghiệp vụ `class.roster_identity_missing` ở tầng service. `dateOfBirth`
 * chỉ là cột thông tin của file mẫu: hệ hiện không có trường ngày sinh
 * trên tài khoản nên giá trị này không được lưu (ghi rõ để không ai hiểu
 * nhầm là đã lưu).
 */
export const rosterStudentIdentitySchema = z.strictObject({
  fullName: z.string().min(1).max(200),
  email: z.string().max(200).optional(),
  phone: z.string().max(30).optional(),
  dateOfBirth: z.string().max(20).optional(),
});
export type RosterStudentIdentity = z.infer<typeof rosterStudentIdentitySchema>;

/**
 * Kết quả nạp MỘT học sinh theo định danh: `matched` = khớp tài khoản có
 * sẵn, `created` = vừa tạo tài khoản mới (kèm mật khẩu tạm — chỉ trả
 * đúng lần này), `already_member` = tài khoản đã ở trong lớp từ trước.
 */
export const addRosterStudentResultSchema = z.object({
  userId: uuidIdSchema,
  username: z.string(),
  email: z.string(),
  fullName: z.string(),
  outcome: z.enum(['matched', 'created', 'already_member']),
  temporaryPassword: z.string().nullable(),
});
export type AddRosterStudentResult = z.infer<typeof addRosterStudentResultSchema>;

/** Import roster từ Excel (web đọc file rồi gửi các dòng đã chuẩn hoá; API cũng nhận cùng khuôn này cho đường multipart). */
export const importClassRosterSchema = z.strictObject({
  rows: z.array(rosterStudentIdentitySchema).min(1).max(500),
});
export type ImportClassRoster = z.infer<typeof importClassRosterSchema>;

/** Báo cáo import theo TỪNG dòng: dòng lỗi không chặn các dòng khác; GV sửa đúng dòng báo lỗi rồi nạp lại riêng dòng đó. */
export const classRosterImportReportSchema = z.object({
  total: z.number().int(),
  added: z.number().int(),
  created: z.number().int(),
  alreadyMembers: z.number().int(),
  failed: z.number().int(),
  results: z.array(
    z.object({
      /** Số thứ tự dòng trong danh sách gửi lên, đếm từ 1 (web cộng thêm dòng tiêu đề của file khi hiển thị). */
      row: z.number().int(),
      fullName: z.string(),
      status: z.enum(['added_matched', 'added_created', 'already_member', 'error']),
      userId: uuidIdSchema.nullable(),
      username: z.string().nullable(),
      temporaryPassword: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
});
export type ClassRosterImportReport = z.infer<typeof classRosterImportReportSchema>;

/** Ba vai hệ thống gán tại context lớp cho đồng GV — đúng 3 quyền kiểu Azota (giao bài / chấm bài / quản roster). */
export const CLASS_STAFF_ROLES = ['classassigner', 'classgrader', 'classrostermanager'] as const;
export const classStaffRoleSchema = z.enum(CLASS_STAFF_ROLES);
export type ClassStaffRole = z.infer<typeof classStaffRoleSchema>;

/** Một người có vai trò tại lớp: chủ lớp (isOwner, vai editingteacher) hoặc đồng GV giữ một/vài vai trong 3 vai lớp. */
export const classStaffMemberSchema = z.object({
  userId: uuidIdSchema,
  firstName: z.string(),
  lastName: z.string(),
  username: z.string(),
  email: z.string(),
  isOwner: z.boolean(),
  roles: z.array(classStaffRoleSchema),
});
export type ClassStaffMember = z.infer<typeof classStaffMemberSchema>;

/** Bề mặt phân quyền của một lớp + hai cờ khả năng của CHÍNH người gọi để web dẫn luồng (quyền thật vẫn gác ở API). */
export const classStaffViewSchema = z.object({
  staff: z.array(classStaffMemberSchema),
  canShare: z.boolean(),
  canManageRoster: z.boolean(),
});
export type ClassStaffView = z.infer<typeof classStaffViewSchema>;

/** Đặt lại bộ vai lớp của một đồng GV (mảng rỗng = thu hồi cả 3 vai). Chỉ người có `class:share` mới gọi được; chủ lớp không bị sửa qua đường này. */
export const setClassStaffRolesSchema = z.strictObject({
  userId: uuidIdSchema,
  roles: z.array(classStaffRoleSchema).max(3),
});
export type SetClassStaffRoles = z.infer<typeof setClassStaffRolesSchema>;

/**
 * Tự báo danh bằng mã tham gia (join_code). Luật chốt cứng (hồ sơ mục
 * 7.1): lớp TRỐNG (roster chưa có ai) thì vào thẳng; lớp đã có học sinh
 * thì vào HÀNG CHỜ duyệt, trừ khi chủ lớp bật `joinAutoApprove`. Mã chỉ
 * có hiệu lực khi lớp đang bật `allowSelfReport` và chưa lưu trữ.
 */
export const joinClassByCodeSchema = z.strictObject({
  joinCode: z.string().min(4).max(40),
});
export type JoinClassByCode = z.infer<typeof joinClassByCodeSchema>;

/** Thông tin tối thiểu để học sinh xác nhận đúng lớp trước khi xin vào — mã tham gia chính là bí mật, người giữ mã được xem tên lớp. */
export const classJoinPreviewSchema = z.object({
  classId: uuidIdSchema,
  name: z.string(),
  schoolYear: z.string().nullable(),
  ownerName: z.string(),
});
export type ClassJoinPreview = z.infer<typeof classJoinPreviewSchema>;

export const joinClassResultSchema = z.object({
  outcome: z.enum(['joined', 'pending', 'already_member']),
  class: z.object({
    id: uuidIdSchema,
    name: z.string(),
    schoolYear: z.string().nullable(),
  }),
});
export type JoinClassResult = z.infer<typeof joinClassResultSchema>;

/** Một yêu cầu tự báo danh trong hàng chờ duyệt của lớp. */
export const classJoinRequestSchema = z.object({
  id: uuidIdSchema,
  classId: uuidIdSchema,
  userId: uuidIdSchema,
  firstName: z.string(),
  lastName: z.string(),
  username: z.string(),
  email: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type ClassJoinRequest = z.infer<typeof classJoinRequestSchema>;

/**
 * Một học sinh ĐÃ ĐÌNH CHỈ khỏi lớp: đã gỡ khỏi roster với chế độ rời
 * lớp `suspend` nên ghi danh ở các khoá của lớp đang SUSPENDED (giữ
 * điểm/bài làm); thêm lại vào roster là kích hoạt lại đúng các dòng ghi
 * danh cũ.
 */
export const classSuspendedMemberSchema = z.object({
  userId: uuidIdSchema,
  firstName: z.string(),
  lastName: z.string(),
  username: z.string(),
  email: z.string(),
});
export type ClassSuspendedMember = z.infer<typeof classSuspendedMemberSchema>;
