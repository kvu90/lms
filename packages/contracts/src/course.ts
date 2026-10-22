import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/** Course & Enrolment contracts — the single shape source between api and web. */

export const GROUPMODE = { NOGROUPS: 0, SEPARATEGROUPS: 1, VISIBLEGROUPS: 2 } as const;
export const ENROL_STATUS = { ACTIVE: 0, SUSPENDED: 1, WITHDRAWN: 2 } as const;
export const COMPLETION_STATE = { INCOMPLETE: 0, COMPLETE: 1, COMPLETE_PASS: 2, COMPLETE_FAIL: 3 } as const;

export const courseCategorySchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  idnumber: z.string().nullable(),
  description: z.string(),
  parent: uuidIdSchema.nullable(),
  sortorder: z.number().int(),
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
  fullname: z.string(),
  shortname: z.string(),
  idnumber: z.string(),
  summary: z.string(),
  format: z.string(),
  visible: z.boolean(),
  startdate: z.string().nullable(),
  enddate: z.string().nullable(),
  groupmode: z.number().int(),
  enablecompletion: z.boolean(),
});
export type Course = z.infer<typeof courseSchema>;

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
  instanceid: uuidIdSchema,
  name: z.string(),
  visible: z.boolean(),
  groupmode: z.number().int(),
  availability: z.unknown().nullable(),
  completion: z.number().int(),
  completionview: z.boolean(),
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
  availabilityResult: availabilityResultSchema.optional(),
  modules: z.array(courseModuleSchema),
});
export type CourseSection = z.infer<typeof courseSectionSchema>;

export const courseContentSchema = z.object({
  course: courseSchema,
  contextId: uuidIdSchema,
  customFields: z.array(z.object({ shortname: z.string(), value: z.string().nullable() })),
  sections: z.array(courseSectionSchema),
});
export type CourseContent = z.infer<typeof courseContentSchema>;

export const courseGroupSchema = z.object({
  id: uuidIdSchema,
  courseid: uuidIdSchema,
  name: z.string(),
  idnumber: z.string(),
  description: z.string(),
  /** Khoá ghi danh của nhóm (group enrolment key) — chỉ người có quyền quản lý nhóm mới thấy giá trị thật; người khác nhận `null`. */
  enrolmentkey: z.string().nullable().optional(),
});
export type CourseGroup = z.infer<typeof courseGroupSchema>;

export const cohortSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  idnumber: z.string(),
  description: z.string(),
  contextid: uuidIdSchema,
  visible: z.boolean(),
});
export type Cohort = z.infer<typeof cohortSchema>;

export const enrolInstanceSchema = z.object({
  id: uuidIdSchema,
  courseid: uuidIdSchema,
  enrol: z.string(),
  status: z.number().int(),
  name: z.string().nullable(),
  roleid: uuidIdSchema.nullable(),
  customint1: uuidIdSchema.nullable(),
  customint2: uuidIdSchema.nullable(),
  customtext1: z.string(),
  /** Khoá ghi danh (enrolment key) của instance self — chỉ staff có capability quản lý enrol mới thấy giá trị thật; người khác nhận `null`. */
  enrolmentkey: z.string().nullable().optional(),
  sendwelcomemessage: z.boolean().optional(),
  welcomemessage: z.string().nullable().optional(),
});
export type EnrolInstance = z.infer<typeof enrolInstanceSchema>;

export const userEnrolmentSchema = z.object({
  id: uuidIdSchema,
  enrolid: uuidIdSchema,
  userid: uuidIdSchema,
  status: z.number().int(),
  timestart: z.string(),
  timeend: z.string().nullable(),
  enrolMethod: z.string().optional(),
});
export type UserEnrolment = z.infer<typeof userEnrolmentSchema>;

export const courseCompletionSchema = z.object({
  id: uuidIdSchema,
  userid: uuidIdSchema,
  course: uuidIdSchema,
  status: z.string(),
  timecompleted: z.string().nullable(),
});
export type CourseCompletion = z.infer<typeof courseCompletionSchema>;

/** Availability tree JSON (Moodle core_availability shape): ops & | !& !| with showc/show at the root. */
export const availabilityOps = ['&', '|', '!&', '!|'] as const;

/* ---- Request payload schemas (Zod — nguồn sự thật duy nhất; xem ADR Zod-only) ---- */

/** Payload tạo danh mục khoá học. */
export const createCourseCategorySchema = z.strictObject({
  name: z.string().min(1),
  idnumber: z.string().optional(),
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
  fullname: z.string().min(1),
  shortname: z.string().min(1),
  category: uuidIdSchema,
  idnumber: z.string().optional(),
  summary: z.string().optional(),
  format: z.string().optional(),
  visible: z.boolean().optional(),
  startdate: z.string().optional(),
  enddate: z.string().optional(),
  groupmode: z.number().int().optional(),
  formatOptions: z.record(z.string(), z.string()).optional(),
  customFields: z.record(z.string(), z.string()).optional(),
});
export type CreateCourse = z.infer<typeof createCourseSchema>;

/** Payload sửa khoá học; ngày bắt đầu/kết thúc nhận `null` để xoá mốc thời gian. */
export const updateCourseSchema = z.strictObject({
  fullname: z.string().optional(),
  shortname: z.string().optional(),
  category: uuidIdSchema.optional(),
  idnumber: z.string().optional(),
  summary: z.string().optional(),
  format: z.string().optional(),
  visible: z.boolean().optional(),
  startdate: z.string().nullable().optional(),
  enddate: z.string().nullable().optional(),
  groupmode: z.number().int().optional(),
  formatOptions: z.record(z.string(), z.string()).optional(),
  customFields: z.record(z.string(), z.string()).optional(),
});
export type UpdateCourse = z.infer<typeof updateCourseSchema>;

/** Payload tạo section trong khoá học; `availability` là cây điều kiện thô (validate sâu ở tầng availability). */
export const createCourseSectionSchema = z.strictObject({
  name: z.string().optional(),
  summary: z.string().optional(),
  visible: z.boolean().optional(),
  availability: z.unknown().optional(),
});
export type CreateCourseSection = z.infer<typeof createCourseSectionSchema>;

/** Payload sửa section (mọi trường đều tuỳ chọn). */
export const updateCourseSectionSchema = createCourseSectionSchema.partial();
export type UpdateCourseSection = z.infer<typeof updateCourseSectionSchema>;

/** Payload tạo course module trong một section. */
export const createCourseModuleSchema = z.strictObject({
  sectionId: uuidIdSchema,
  component: z.string().min(1),
  instanceid: uuidIdSchema.optional(),
  name: z.string().optional(),
  visible: z.boolean().optional(),
  groupmode: z.number().int().optional(),
  availability: z.unknown().optional(),
  completion: z.number().int().optional(),
  completionview: z.boolean().optional(),
  completionusegrade: z.boolean().optional(),
  completionmanual: z.boolean().optional(),
  completionexpected: z.string().optional(),
});
export type CreateCourseModule = z.infer<typeof createCourseModuleSchema>;

/** Payload sửa course module; `completionexpected` nhận `null` để xoá mốc dự kiến hoàn thành. */
export const updateCourseModuleSchema = z.strictObject({
  name: z.string().optional(),
  visible: z.boolean().optional(),
  groupmode: z.number().int().optional(),
  availability: z.unknown().optional(),
  completion: z.number().int().optional(),
  completionview: z.boolean().optional(),
  completionusegrade: z.boolean().optional(),
  completionmanual: z.boolean().optional(),
  completionexpected: z.string().nullable().optional(),
  sectionId: uuidIdSchema.optional(),
});
export type UpdateCourseModule = z.infer<typeof updateCourseModuleSchema>;

/** Payload tạo nhóm (group) trong khoá học; `enrolmentKey` là khoá ghi danh riêng của nhóm (group enrolment key của enrol_self). */
export const createGroupSchema = z.strictObject({
  name: z.string().min(1),
  idnumber: z.string().optional(),
  description: z.string().optional(),
  enrolmentKey: z.string().min(1).optional(),
});
export type CreateGroup = z.infer<typeof createGroupSchema>;

/** Payload sửa nhóm (mọi trường đều tuỳ chọn); `enrolmentKey: null` để xoá khoá ghi danh của nhóm. */
export const updateGroupSchema = z.strictObject({
  name: z.string().min(1).optional(),
  idnumber: z.string().optional(),
  description: z.string().optional(),
  enrolmentKey: z.string().min(1).nullable().optional(),
});
export type UpdateGroup = z.infer<typeof updateGroupSchema>;

/** Payload thêm thành viên vào nhóm/cohort. */
export const groupMemberSchema = z.strictObject({
  userid: uuidIdSchema,
});
export type GroupMember = z.infer<typeof groupMemberSchema>;

/** Payload tạo grouping (nhóm các nhóm). */
export const createGroupingSchema = z.strictObject({
  name: z.string().min(1),
  idnumber: z.string().optional(),
  description: z.string().optional(),
});
export type CreateGrouping = z.infer<typeof createGroupingSchema>;

/** Payload gắn một nhóm vào grouping. */
export const groupingGroupSchema = z.strictObject({
  groupid: uuidIdSchema,
});
export type GroupingGroup = z.infer<typeof groupingGroupSchema>;

/** Payload tạo cohort. */
export const createCohortSchema = z.strictObject({
  name: z.string().min(1),
  idnumber: z.string().optional(),
  description: z.string().optional(),
  categoryId: uuidIdSchema.optional(),
  visible: z.boolean().optional(),
});
export type CreateCohort = z.infer<typeof createCohortSchema>;

/** Payload sửa cohort (mọi trường đều tuỳ chọn). */
export const updateCohortSchema = z.strictObject({
  name: z.string().optional(),
  idnumber: z.string().optional(),
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
  enrolperiod: z.number().int().optional(),
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
  enrolperiod: z.number().int().optional(),
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
  userid: uuidIdSchema,
  timestart: z.string().optional(),
  timeend: z.string().optional(),
});
export type EnrolUser = z.infer<typeof enrolUserSchema>;
