import { z } from 'zod';
import { uuidIdSchema } from './ids.js';
import { courseSectionFrameSchema, courseSectionTextbookFrameSchema } from './curriculum.js';

/** Course & Enrolment contracts — the single shape source between api and web. */

export const GROUPMODE = { NOGROUPS: 0, SEPARATEGROUPS: 1, VISIBLEGROUPS: 2 } as const;
export const ENROL_STATUS = { ACTIVE: 0, SUSPENDED: 1, WITHDRAWN: 2 } as const;
export const COMPLETION_STATE = { INCOMPLETE: 0, COMPLETE: 1, COMPLETE_PASS: 2, COMPLETE_FAIL: 3 } as const;

export const courseCategorySchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  idNumber: z.string().nullable(),
  description: z.string(),
  parent: uuidIdSchema.nullable(),
  sortOrder: z.number().int(),
  path: z.string(),
  depth: z.number().int(),
  visible: z.boolean(),
});
export type CourseCategory = z.infer<typeof courseCategorySchema>;

export interface CourseCategoryTreeNode extends CourseCategory {
  children: CourseCategoryTreeNode[];
}
export const courseCategoryTreeNodeSchema: z.ZodType<CourseCategoryTreeNode> = courseCategorySchema.extend({
  children: z.lazy(() => z.array(courseCategoryTreeNodeSchema)),
});
/** The /categories/tree response: an array of root nodes. */
export const courseCategoryTreeSchema = z.array(courseCategoryTreeNodeSchema);

export const courseSchema = z.object({
  id: uuidIdSchema,
  category: uuidIdSchema,
  fullName: z.string(),
  shortName: z.string(),
  idNumber: z.string(),
  summary: z.string(),
  format: z.string(),
  visible: z.boolean(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  groupMode: z.number().int(),
  /** Ép chế độ nhóm của khoá lên mọi activity (Moodle `groupmodeforce`); mặc định false cho payload cũ chưa mang trường này. */
  groupModeForce: z.boolean().default(false),
  enableCompletion: z.boolean(),
  /** Môn chương trình GDPT 2018 của khoá (K0a); mặc định null cho payload cũ. */
  subjectId: uuidIdSchema.nullable().default(null),
  /** Khối lớp (1–12) của khoá theo chương trình (K0a); mặc định null cho payload cũ. */
  grade: z.number().int().nullable().default(null),
  /** Khoá mẫu tổ/trường (K1): không phải khoá dạy thật — chỉ hiện ở danh sách mẫu của wizard tạo khoá, không hiện ở danh sách khoá thường; mặc định false cho payload cũ. */
  isTemplate: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});
export type Course = z.infer<typeof courseSchema>;

/**
 * Trạng thái mở của section/module (K1): suy từ `visible` + `openAt` phía
 * server — `draft` = đang ẩn (visible=false), `scheduled` = đã mở nhưng
 * chờ tới ngày mở (openAt ở tương lai), `open` = đang mở cho học viên.
 */
export const courseItemStatusSchema = z.enum(['draft', 'open', 'scheduled']);
export type CourseItemStatus = z.infer<typeof courseItemStatusSchema>;

export const availabilityResultSchema = z.object({
  available: z.boolean(),
  visible: z.boolean(),
  failedDescriptions: z.array(z.string()),
});
export type AvailabilityResult = z.infer<typeof availabilityResultSchema>;

export const courseModuleSchema = z.object({
  id: uuidIdSchema,
  course: uuidIdSchema,
  section: uuidIdSchema,
  component: z.string(),
  instanceId: uuidIdSchema,
  name: z.string(),
  visible: z.boolean(),
  groupMode: z.number().int(),
  availability: z.unknown().nullable(),
  completion: z.number().int(),
  completionView: z.boolean(),
  /** Cờ hoàn thành thủ công của module (hàng ở tầng API luôn mang trường này — cột NOT NULL ở bảng course_modules); đi kèm `completionUseGrade` quyết định cách tính trạng thái tự động. */
  completionManual: z.boolean(),
  /** Thứ tự hiển thị tường minh trong section (K1 — kéo–thả đổi thứ tự); mặc định 0 cho payload cũ. */
  sortOrder: z.number().int().default(0),
  /** Ngày mở theo lịch (K1): null = mở ngay khi visible; mặc định null cho payload cũ. */
  openAt: z.string().nullable().default(null),
  /** Trạng thái mở do server suy (K1); vắng mặt ở payload cũ. */
  status: courseItemStatusSchema.optional(),
  contextId: uuidIdSchema.optional(),
  availabilityResult: availabilityResultSchema.optional(),
});
export type CourseModule = z.infer<typeof courseModuleSchema>;

export const courseSectionSchema = z.object({
  id: uuidIdSchema,
  course: uuidIdSchema,
  section: z.number().int(),
  name: z.string().nullable(),
  summary: z.string(),
  visible: z.boolean(),
  availability: z.unknown().nullable(),
  /** Ngày mở theo lịch của section (K1); mặc định null cho payload cũ. */
  openAt: z.string().nullable().default(null),
  /** Trạng thái mở do server suy (K1); vắng mặt ở payload cũ. */
  status: courseItemStatusSchema.optional(),
  availabilityResult: availabilityResultSchema.optional(),
  /** Neo khung chương trình đã nạp (K0a) — null khi section không xuất phát từ khung. */
  frame: courseSectionFrameSchema.nullable().optional(),
  /** Neo khung SGK đã nạp (K0b) — null khi section không xuất phát từ khung SGK; một section chỉ mang một loại neo. */
  textbookFrame: courseSectionTextbookFrameSchema.nullable().optional(),
  modules: z.array(courseModuleSchema),
});
export type CourseSection = z.infer<typeof courseSectionSchema>;

export const courseContentSchema = z.object({
  course: courseSchema,
  contextId: uuidIdSchema,
  customFields: z.array(z.object({ shortName: z.string(), value: z.string().nullable() })),
  sections: z.array(courseSectionSchema),
});
export type CourseContent = z.infer<typeof courseContentSchema>;

export const courseGroupSchema = z.object({
  id: uuidIdSchema,
  courseId: uuidIdSchema,
  name: z.string(),
  idNumber: z.string(),
  description: z.string(),
  /** Khoá ghi danh của nhóm (group enrolment key) — chỉ người có quyền quản lý nhóm mới thấy giá trị thật; người khác nhận `null`. */
  enrolmentKey: z.string().nullable().optional(),
});
export type CourseGroup = z.infer<typeof courseGroupSchema>;

export const cohortSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  idNumber: z.string(),
  description: z.string(),
  contextId: uuidIdSchema,
  visible: z.boolean(),
});
export type Cohort = z.infer<typeof cohortSchema>;

/**
 * Grouping (nhóm các nhóm) trong một khoá học như API trả về — hàng của
 * bảng `groupings` phía groups module. Mốc thời gian để tuỳ chọn vì tầng
 * API trả thẳng hàng cơ sở dữ liệu và các bản ghi cũ có thể thiếu chúng
 * khi serialize.
 */
export const courseGroupingSchema = z.object({
  id: uuidIdSchema,
  courseId: uuidIdSchema,
  name: z.string(),
  idNumber: z.string(),
  description: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type CourseGrouping = z.infer<typeof courseGroupingSchema>;

export const enrolInstanceSchema = z.object({
  id: uuidIdSchema,
  courseId: uuidIdSchema,
  enrol: z.string(),
  status: z.number().int(),
  name: z.string().nullable(),
  roleId: uuidIdSchema.nullable(),
  customInt1: uuidIdSchema.nullable(),
  customInt2: uuidIdSchema.nullable(),
  customText1: z.string(),
  /** Phí ghi danh của instance fee: số nguyên theo đơn vị tiền nhỏ nhất (0 = miễn phí); hàng ở tầng API luôn mang trường này (cột NOT NULL ở bảng enrol). */
  cost: z.number().int(),
  /** Mã tiền tệ ISO của phí ghi danh (`''` khi instance không thu phí); hàng ở tầng API luôn mang trường này. */
  currency: z.string(),
  /** Khoá ghi danh (enrolment key) của instance self — chỉ staff có capability quản lý enrol mới thấy giá trị thật; người khác nhận `null`. */
  enrolmentKey: z.string().nullable().optional(),
  sendWelcomeMessage: z.boolean().optional(),
  welcomeMessage: z.string().nullable().optional(),
});
export type EnrolInstance = z.infer<typeof enrolInstanceSchema>;

export const userEnrolmentSchema = z.object({
  id: uuidIdSchema,
  enrolId: uuidIdSchema,
  userId: uuidIdSchema,
  status: z.number().int(),
  timeStart: z.string(),
  timeEnd: z.string().nullable(),
  enrolMethod: z.string().optional(),
});
export type UserEnrolment = z.infer<typeof userEnrolmentSchema>;

export const courseCompletionSchema = z.object({
  id: uuidIdSchema,
  userId: uuidIdSchema,
  course: uuidIdSchema,
  status: z.string(),
  timeCompleted: z.string().nullable(),
});
export type CourseCompletion = z.infer<typeof courseCompletionSchema>;

/** Availability tree JSON (Moodle core_availability shape): ops & | !& !| with showc/show at the root. */
export const availabilityOps = ['&', '|', '!&', '!|'] as const;

/* ---- Request payload schemas (Zod — nguồn sự thật duy nhất; xem ADR Zod-only) ---- */

/** Payload tạo danh mục khoá học. */
export const createCourseCategorySchema = z.strictObject({
  name: z.string().min(1),
  idNumber: z.string().optional(),
  description: z.string().optional(),
  parent: uuidIdSchema.optional(),
  visible: z.boolean().optional(),
});
export type CreateCourseCategory = z.infer<typeof createCourseCategorySchema>;

/** Payload sửa danh mục khoá học (mọi trường đều tuỳ chọn). */
export const updateCourseCategorySchema = createCourseCategorySchema.partial();
export type UpdateCourseCategory = z.infer<typeof updateCourseCategorySchema>;

/** Payload tạo khoá học. */
export const createCourseSchema = z.strictObject({
  fullName: z.string().min(1),
  shortName: z.string().min(1),
  category: uuidIdSchema,
  idNumber: z.string().optional(),
  summary: z.string().optional(),
  format: z.string().optional(),
  visible: z.boolean().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  groupMode: z.number().int().optional(),
  groupModeForce: z.boolean().optional(),
  /** Môn × khối theo chương trình GDPT 2018 (K0a) — căn cứ chọn khung khi nạp khung vào khoá. */
  subjectId: uuidIdSchema.nullable().optional(),
  grade: z.number().int().min(1).max(12).nullable().optional(),
  formatOptions: z.record(z.string(), z.string()).optional(),
  customFields: z.record(z.string(), z.string()).optional(),
});
export type CreateCourse = z.infer<typeof createCourseSchema>;

/** Payload sửa khoá học; ngày bắt đầu/kết thúc nhận `null` để xoá mốc thời gian. */
export const updateCourseSchema = z.strictObject({
  fullName: z.string().optional(),
  shortName: z.string().optional(),
  category: uuidIdSchema.optional(),
  idNumber: z.string().optional(),
  summary: z.string().optional(),
  format: z.string().optional(),
  visible: z.boolean().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  groupMode: z.number().int().optional(),
  groupModeForce: z.boolean().optional(),
  /** Môn × khối theo chương trình GDPT 2018 (K0a); đặt null để gỡ neo môn/khối khỏi khoá. */
  subjectId: uuidIdSchema.nullable().optional(),
  grade: z.number().int().min(1).max(12).nullable().optional(),
  /** Đánh dấu khoá là khoá mẫu tổ/trường (K1) hoặc gỡ đánh dấu. */
  isTemplate: z.boolean().optional(),
  formatOptions: z.record(z.string(), z.string()).optional(),
  customFields: z.record(z.string(), z.string()).optional(),
});
export type UpdateCourse = z.infer<typeof updateCourseSchema>;

/** Payload tạo section trong khoá học; `availability` là cây điều kiện thô (validate sâu ở tầng availability); `openAt` là ngày mở theo lịch riêng (K1). */
export const createCourseSectionSchema = z.strictObject({
  name: z.string().optional(),
  summary: z.string().optional(),
  visible: z.boolean().optional(),
  availability: z.unknown().optional(),
  openAt: z.string().nullable().optional(),
});
export type CreateCourseSection = z.infer<typeof createCourseSectionSchema>;

/** Payload sửa section (mọi trường đều tuỳ chọn). */
export const updateCourseSectionSchema = createCourseSectionSchema.partial();
export type UpdateCourseSection = z.infer<typeof updateCourseSectionSchema>;

/** Payload tạo course module trong một section. */
export const createCourseModuleSchema = z.strictObject({
  sectionId: uuidIdSchema,
  component: z.string().min(1),
  instanceId: uuidIdSchema.optional(),
  name: z.string().optional(),
  visible: z.boolean().optional(),
  groupMode: z.number().int().optional(),
  availability: z.unknown().optional(),
  completion: z.number().int().optional(),
  completionView: z.boolean().optional(),
  completionUseGrade: z.boolean().optional(),
  completionManual: z.boolean().optional(),
  completionExpected: z.string().optional(),
  /** Ngày mở theo lịch riêng của module (K1). */
  openAt: z.string().nullable().optional(),
});
export type CreateCourseModule = z.infer<typeof createCourseModuleSchema>;

/** Payload sửa course module; `completionExpected`/`openAt` nhận `null` để xoá mốc thời gian. */
export const updateCourseModuleSchema = z.strictObject({
  name: z.string().optional(),
  visible: z.boolean().optional(),
  groupMode: z.number().int().optional(),
  availability: z.unknown().optional(),
  completion: z.number().int().optional(),
  completionView: z.boolean().optional(),
  completionUseGrade: z.boolean().optional(),
  completionManual: z.boolean().optional(),
  completionExpected: z.string().nullable().optional(),
  openAt: z.string().nullable().optional(),
  sectionId: uuidIdSchema.optional(),
});
export type UpdateCourseModule = z.infer<typeof updateCourseModuleSchema>;

/**
 * Các loại nội dung giáo viên chọn từ menu trong Builder Outline (K1) —
 * thay cho ô gõ chuỗi `component` tự do. `createsInstance` cho biết loại
 * có vòng đời instance riêng (hiện chỉ quiz) nên builder phải tạo qua API
 * của module sở hữu thay vì tạo course module trần.
 */
export const COURSE_CONTENT_TYPES = [
  { component: 'mod_page', createsInstance: false },
  { component: 'mod_resource', createsInstance: false },
  { component: 'mod_quiz', createsInstance: true },
] as const;
export type CourseContentType = (typeof COURSE_CONTENT_TYPES)[number]['component'];

/** Payload nhân bản khoá học (K1 — đường 3 của wizard / nhân bản từ mẫu): bản sao luôn ở trạng thái nháp; `startDate` mới làm mốc lùi toàn bộ hạn trong khoá theo delta so với ngày bắt đầu của khoá nguồn. */
export const duplicateCourseSchema = z.strictObject({
  fullName: z.string().min(1),
  shortName: z.string().min(1),
  category: uuidIdSchema.optional(),
  startDate: z.string().optional(),
});
export type DuplicateCourse = z.infer<typeof duplicateCourseSchema>;

/** Payload đổi thứ tự section (K1): danh sách id section theo thứ tự hiển thị mới — phải đủ mọi section của khoá. */
export const reorderCourseSectionsSchema = z.strictObject({
  sectionIds: z.array(uuidIdSchema).min(1),
});
export type ReorderCourseSections = z.infer<typeof reorderCourseSectionsSchema>;

/** Payload đổi thứ tự module trong một section (K1): danh sách id module theo thứ tự mới — phải đủ mọi module của section. */
export const reorderCourseModulesSchema = z.strictObject({
  moduleIds: z.array(uuidIdSchema).min(1),
});
export type ReorderCourseModules = z.infer<typeof reorderCourseModulesSchema>;

/** Payload "Dùng lại từ khoá khác" (K1): chép các section nguyên vẹn và/hoặc các module lẻ từ khoá nguồn vào khoá đích (nối cuối outline). */
export const copyCourseContentSchema = z.strictObject({
  sourceCourseId: uuidIdSchema,
  sectionIds: z.array(uuidIdSchema).optional(),
  moduleIds: z.array(uuidIdSchema).optional(),
});
export type CopyCourseContent = z.infer<typeof copyCourseContentSchema>;

/** Payload tạo nhóm (group) trong khoá học; `enrolmentKey` là khoá ghi danh riêng của nhóm (group enrolment key của enrol_self). */
export const createGroupSchema = z.strictObject({
  name: z.string().min(1),
  idNumber: z.string().optional(),
  description: z.string().optional(),
  enrolmentKey: z.string().min(1).optional(),
});
export type CreateGroup = z.infer<typeof createGroupSchema>;

/** Payload sửa nhóm (mọi trường đều tuỳ chọn); `enrolmentKey: null` để xoá khoá ghi danh của nhóm. */
export const updateGroupSchema = z.strictObject({
  name: z.string().min(1).optional(),
  idNumber: z.string().optional(),
  description: z.string().optional(),
  enrolmentKey: z.string().min(1).nullable().optional(),
});
export type UpdateGroup = z.infer<typeof updateGroupSchema>;

/** Payload thêm thành viên vào nhóm/cohort. */
export const groupMemberSchema = z.strictObject({
  userId: uuidIdSchema,
});
export type GroupMember = z.infer<typeof groupMemberSchema>;

/** Payload tạo grouping (nhóm các nhóm). */
export const createGroupingSchema = z.strictObject({
  name: z.string().min(1),
  idNumber: z.string().optional(),
  description: z.string().optional(),
});
export type CreateGrouping = z.infer<typeof createGroupingSchema>;

/** Payload gắn một nhóm vào grouping. */
export const groupingGroupSchema = z.strictObject({
  groupId: uuidIdSchema,
});
export type GroupingGroup = z.infer<typeof groupingGroupSchema>;

/** Payload tạo cohort. */
export const createCohortSchema = z.strictObject({
  name: z.string().min(1),
  idNumber: z.string().optional(),
  description: z.string().optional(),
  categoryId: uuidIdSchema.optional(),
  visible: z.boolean().optional(),
});
export type CreateCohort = z.infer<typeof createCohortSchema>;

/** Payload sửa cohort (mọi trường đều tuỳ chọn). */
export const updateCohortSchema = z.strictObject({
  name: z.string().optional(),
  idNumber: z.string().optional(),
  description: z.string().optional(),
  visible: z.boolean().optional(),
});
export type UpdateCohort = z.infer<typeof updateCohortSchema>;

/** Payload tạo enrol instance; với ghi danh có phí, `cost` là số nguyên đơn vị tiền nhỏ nhất kèm `currency` và `paymentAccountId`. `enrolmentKey` là khoá ghi danh của instance self; `sendWelcomeMessage`/`welcomeMessage` cấu hình tin nhắn chào mừng (mặc định theo phương thức: self bật, manual tắt). */
export const createEnrolInstanceSchema = z.strictObject({
  method: z.string(),
  name: z.string().optional(),
  roleShortname: z.string().optional(),
  status: z.number().int().optional(),
  enrolPeriod: z.number().int().optional(),
  cohortId: uuidIdSchema.optional(),
  groupId: uuidIdSchema.optional(),
  onCohortLeave: z.enum(['suspend', 'unenrol']).optional(),
  cost: z.number().int().optional(),
  currency: z.string().optional(),
  paymentAccountId: uuidIdSchema.optional(),
  enrolmentKey: z.string().min(1).optional(),
  sendWelcomeMessage: z.boolean().optional(),
  welcomeMessage: z.string().optional(),
});
export type CreateEnrolInstance = z.infer<typeof createEnrolInstanceSchema>;

/** Payload sửa enrol instance (mọi trường đều tuỳ chọn); `enrolmentKey: null`/`welcomeMessage: null` để xoá giá trị đã đặt, `roleShortname` đổi role sẽ gán lại role cho người đã ghi danh qua instance. */
export const updateEnrolInstanceSchema = z.strictObject({
  name: z.string().optional(),
  status: z.number().int().optional(),
  enrolPeriod: z.number().int().optional(),
  onCohortLeave: z.enum(['suspend', 'unenrol']).optional(),
  groupId: uuidIdSchema.optional(),
  roleShortname: z.string().optional(),
  enrolmentKey: z.string().min(1).nullable().optional(),
  sendWelcomeMessage: z.boolean().optional(),
  welcomeMessage: z.string().nullable().optional(),
});
export type UpdateEnrolInstance = z.infer<typeof updateEnrolInstanceSchema>;

/** Payload tự ghi danh qua instance self; `enrolmentKey` bắt buộc khi instance (hoặc một nhóm của khoá) có đặt khoá. */
export const selfEnrolSchema = z.strictObject({
  enrolmentKey: z.string().optional(),
});
export type SelfEnrol = z.infer<typeof selfEnrolSchema>;

/** Payload ghi danh một người dùng qua enrol instance. */
export const enrolUserSchema = z.strictObject({
  userId: uuidIdSchema,
  timeStart: z.string().optional(),
  timeEnd: z.string().optional(),
});
export type EnrolUser = z.infer<typeof enrolUserSchema>;
