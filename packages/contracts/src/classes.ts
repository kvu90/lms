import { z } from 'zod';
import { courseSchema } from './course.js';
import { uuidIdSchema } from './ids.js';

/**
 * Hợp đồng API của LỚP HỌC HẠNG NHẤT (issue #184, CLASS-0): lớp được tạo
 * TRƯỚC, khoá học nằm bên trong lớp; danh sách học sinh thuộc về lớp
 * (roster ≡ thành viên backing cohort) và tự vật chất hoá xuống mọi
 * khoá của lớp qua enrol instance cohort. Tạo lớp chỉ bắt buộc TÊN
 * (khuôn Azota). CLASS-3 bổ sung học phí theo lớp (`fee*` trên hình
 * dạng lớp + gói công khai để mua gói lớp ở cuối file): payment mang
 * `component = 'class_fee'`, `item_id = classes.id` qua seam thanh
 * toán sẵn có — hợp đồng payment nằm ở `platform.ts`, ở đây chỉ có
 * cấu hình học phí trên lớp và bề mặt công khai của gói lớp.
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
  /**
   * Học phí gói lớp (CLASS-3): số nguyên đơn vị nhỏ nhất (cùng bất biến
   * tiền tệ của payments — không float). `null` hoặc 0 nghĩa là lớp
   * KHÔNG thu học phí qua hệ thống: giá trị này chính là công tắc thu
   * phí, không có cờ bật/tắt riêng.
   */
  feeCost: z.number().int().nullable(),
  /** Đơn vị tiền của học phí gói lớp (mặc định `VND` — thanh toán nội địa VietQR/SePay theo sổ quyết định mục E). */
  feeCurrency: z.string(),
  /**
   * Tài khoản nhận học phí chỉ định riêng cho lớp; `null` = rơi về tài
   * khoản mặc định của tenant sở hữu lớp (lớp của trung tâm → tài khoản
   * của chính trung tâm; lớp của GV tự do ở trang chính → tài khoản
   * platform). Chỉ là định danh tài khoản — cấu hình nhạy cảm của tài
   * khoản vẫn bị che ở bề mặt payments.
   */
  feePaymentAccountId: uuidIdSchema.nullable(),
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

/**
 * Sửa lớp: thông tin hiển thị + công tắc tự báo danh + chế độ khi rời
 * lớp; `rotateJoinCode: true` sinh mã tham gia mới (mã cũ mất hiệu lực
 * ngay). CLASS-3: cùng PATCH này đặt/đổi HỌC PHÍ gói lớp — gác bằng
 * capability `class:update` tại context lớp (chủ lớp giữ sẵn qua vai
 * editingteacher), không chế capability riêng cho học phí.
 * `feeCost: null` hoặc 0 = tắt thu học phí qua hệ thống.
 * `feePaymentAccountId: null` = gỡ chỉ định riêng, rơi về tài khoản mặc
 * định của tenant; tính hợp lệ của tài khoản (tồn tại + đúng tenant)
 * được kiểm ở lúc TẠO payment, cùng khuôn `enrol_fee`.
 */
export const updateClassSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(80).nullable().optional(),
  schoolYear: z.string().min(1).max(40).nullable().optional(),
  description: z.string().max(2000).optional(),
  allowSelfReport: z.boolean().optional(),
  joinAutoApprove: z.boolean().optional(),
  onLeave: z.enum(CLASS_ON_LEAVE_MODES).optional(),
  rotateJoinCode: z.boolean().optional(),
  feeCost: z.number().int().min(0).nullable().optional(),
  feeCurrency: z.string().min(3).max(3).optional(),
  feePaymentAccountId: uuidIdSchema.nullable().optional(),
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

/** Đặt lại bộ vai lớp của một đồng GV (mảng rỗng = thu hồi cả 3 vai). Chỉ người có `class:share` mới gọi được; chủ lớp không bị sửa qua đường này. Đồng GV được định danh bằng userId hoặc bằng EMAIL tài khoản (GV không biết userId của đồng nghiệp). */
export const setClassStaffRolesSchema = z.strictObject({
  userId: uuidIdSchema.optional(),
  email: z.string().min(3).max(200).optional(),
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

// ---------------------------------------------------------------------------
// CLASS-2 (issue #184): dashboard theo lớp — gói tổng quan MỘT lớp cho
// đúng vai của người gọi.
// ---------------------------------------------------------------------------

/**
 * Quan hệ của người gọi với lớp, do server suy từ dữ kiện thật (chủ lớp
 * / vai tại context lớp / thành viên roster) — web dùng để dựng dashboard
 * đúng vai, quyền thật vẫn gác ở từng endpoint phía API:
 *  - `owner`: chủ lớp — thấy mọi khoá của lớp + toàn bộ khối quản trị;
 *  - `staff`: đồng GV giữ một trong 3 vai lớp (hoặc người có quyền xem
 *    lớp ở mức quản trị như quản trị tenant) — thấy mọi khoá của lớp,
 *    khối quản trị hiện theo từng cờ khả năng đi kèm;
 *  - `member`: học sinh thuộc roster — `courses` CHỈ gồm các khoá mình
 *    đang ghi danh ACTIVE trong lớp (đình chỉ ở một khoá thì khoá đó
 *    biến mất khỏi danh sách này), không có khối quản trị nào.
 */
export const CLASS_VIEWER_ROLES = ['owner', 'staff', 'member'] as const;
export const classViewerRoleSchema = z.enum(CLASS_VIEWER_ROLES);
export type ClassViewerRole = z.infer<typeof classViewerRoleSchema>;

/**
 * Gói tổng quan của dashboard lớp (`GET /classes/:id/overview`): thông
 * tin lớp + quan hệ của người gọi + số học sinh của roster + danh sách
 * khoá ĐÃ LỌC THEO VAI ở phía server (member chỉ nhận khoá mình đang
 * học). Dashboard là bề mặt tổng quan/điều hướng thuần — gói này
 * KHÔNG mang bất kỳ dữ kiện điểm nào (mô hình điểm chốt 23:49
 * 25/10/2026: điểm chỉ theo từng bài, không có tổng hợp theo lớp/khoá).
 */
export const classOverviewSchema = z.object({
  class: classSchema,
  viewerRole: classViewerRoleSchema,
  /** Người gọi có quyền quản roster của lớp này (chủ lớp hoặc vai `classrostermanager`). */
  canManageRoster: z.boolean(),
  /** Người gọi có quyền phân vai tại lớp này (chủ lớp hoặc `class:share`). */
  canShare: z.boolean(),
  /** Số học sinh hiện thuộc roster của lớp (nguồn sự thật của ghi danh cấp lớp). */
  rosterCount: z.number().int().nonnegative(),
  courses: z.array(courseSchema),
});
export type ClassOverview = z.infer<typeof classOverviewSchema>;

// ---------------------------------------------------------------------------
// CLASS-3 (issue #184): học phí theo lớp — bề mặt công khai của gói lớp
// để người CHƯA ghi danh xem và bắt đầu thanh toán.
// ---------------------------------------------------------------------------

/**
 * Gói công khai của một lớp (`GET /classes/:id/public`) — bề mặt cho
 * người dùng đã đăng nhập trong tenant nhưng CHƯA thuộc lớp: xem thông
 * tin lớp + gói học phí để quyết định mua. Khác `classSchema` ở chỗ
 * gói này KHÔNG mang dữ kiện nội bộ (cohort, mã tham gia, tài khoản
 * nhận tiền) — chỉ những gì người mua cần biết, cộng hai cờ do server
 * suy cho đúng người gọi:
 *  - `isMember`: người gọi đã thuộc roster (đang ACTIVE ở lớp);
 *  - `canPurchase`: được bắt đầu thanh toán NGAY — lớp đang hoạt động,
 *    có bật thu học phí (`feeEnabled`) và người gọi chưa là thành viên.
 *    Người đã ghi danh ACTIVE không bị mời mua lại: `canPurchase`
 *    luôn false với họ và bề mặt web hiện trạng thái đã ghi danh thay
 *    cho nút mua.
 * `feeEnabled` suy từ `feeCost` (null/0 = không thu qua hệ) để web
 * không tự diễn giải lại công tắc học phí.
 */
export const classPublicViewSchema = z.object({
  classId: uuidIdSchema,
  name: z.string(),
  code: z.string().nullable(),
  schoolYear: z.string().nullable(),
  description: z.string(),
  ownerName: z.string(),
  status: z.enum(CLASS_STATUSES),
  feeCost: z.number().int().nullable(),
  feeCurrency: z.string(),
  feeEnabled: z.boolean(),
  isMember: z.boolean(),
  canPurchase: z.boolean(),
});
export type ClassPublicView = z.infer<typeof classPublicViewSchema>;
