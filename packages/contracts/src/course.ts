import { z } from 'zod';

/** Course & Enrolment contracts — the single shape source between api and web. */

export const GROUPMODE = { NOGROUPS: 0, SEPARATEGROUPS: 1, VISIBLEGROUPS: 2 } as const;
export const ENROL_STATUS = { ACTIVE: 0, SUSPENDED: 1, WITHDRAWN: 2 } as const;
export const COMPLETION_STATE = { INCOMPLETE: 0, COMPLETE: 1, COMPLETE_PASS: 2, COMPLETE_FAIL: 3 } as const;

export const courseCategorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  idnumber: z.string().nullable(),
  description: z.string(),
  parent: z.number().int(),
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
  id: z.number().int(),
  category: z.number().int(),
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
  id: z.number().int(),
  course: z.number().int(),
  section: z.number().int(),
  component: z.string(),
  instanceid: z.number().int(),
  name: z.string(),
  visible: z.boolean(),
  groupmode: z.number().int(),
  availability: z.unknown().nullable(),
  completion: z.number().int(),
  completionview: z.boolean(),
  contextId: z.number().int().optional(),
  availabilityResult: availabilityResultSchema.optional(),
});
export type CourseModule = z.infer<typeof courseModuleSchema>;

export const courseSectionSchema = z.object({
  id: z.number().int(),
  course: z.number().int(),
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
  contextId: z.number().int(),
  customFields: z.array(z.object({ shortname: z.string(), value: z.string().nullable() })),
  sections: z.array(courseSectionSchema),
});
export type CourseContent = z.infer<typeof courseContentSchema>;

export const courseGroupSchema = z.object({
  id: z.number().int(),
  courseid: z.number().int(),
  name: z.string(),
  idnumber: z.string(),
  description: z.string(),
});
export type CourseGroup = z.infer<typeof courseGroupSchema>;

export const cohortSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  idnumber: z.string(),
  description: z.string(),
  contextid: z.number().int(),
  visible: z.boolean(),
});
export type Cohort = z.infer<typeof cohortSchema>;

export const enrolInstanceSchema = z.object({
  id: z.number().int(),
  courseid: z.number().int(),
  enrol: z.string(),
  status: z.number().int(),
  name: z.string().nullable(),
  roleid: z.number().int().nullable(),
  customint1: z.number().int(),
  customint2: z.number().int(),
  customtext1: z.string(),
});
export type EnrolInstance = z.infer<typeof enrolInstanceSchema>;

export const userEnrolmentSchema = z.object({
  id: z.number().int(),
  enrolid: z.number().int(),
  userid: z.number().int(),
  status: z.number().int(),
  timestart: z.string(),
  timeend: z.string().nullable(),
  enrolMethod: z.string().optional(),
});
export type UserEnrolment = z.infer<typeof userEnrolmentSchema>;

export const courseCompletionSchema = z.object({
  id: z.number().int(),
  userid: z.number().int(),
  course: z.number().int(),
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
  parent: z.number().int().optional(),
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
  category: z.number().int(),
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
  category: z.number().int().optional(),
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
  sectionId: z.number().int(),
  component: z.string().min(1),
  instanceid: z.number().int().optional(),
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
  sectionId: z.number().int().optional(),
});
export type UpdateCourseModule = z.infer<typeof updateCourseModuleSchema>;

/** Payload tạo nhóm (group) trong khoá học. */
export const createGroupSchema = z.strictObject({
  name: z.string().min(1),
  idnumber: z.string().optional(),
  description: z.string().optional(),
});
export type CreateGroup = z.infer<typeof createGroupSchema>;

/** Payload sửa nhóm (mọi trường đều tuỳ chọn). */
export const updateGroupSchema = createGroupSchema.partial();
export type UpdateGroup = z.infer<typeof updateGroupSchema>;

/** Payload thêm thành viên vào nhóm/cohort. */
export const groupMemberSchema = z.strictObject({
  userid: z.number().int(),
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
  groupid: z.number().int(),
});
export type GroupingGroup = z.infer<typeof groupingGroupSchema>;

/** Payload tạo cohort. */
export const createCohortSchema = z.strictObject({
  name: z.string().min(1),
  idnumber: z.string().optional(),
  description: z.string().optional(),
  categoryId: z.number().int().optional(),
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

/** Payload tạo enrol instance; với ghi danh có phí, `cost` là số nguyên đơn vị tiền nhỏ nhất kèm `currency` và `paymentAccountId`. */
export const createEnrolInstanceSchema = z.strictObject({
  method: z.string(),
  name: z.string().optional(),
  roleShortname: z.string().optional(),
  status: z.number().int().optional(),
  enrolperiod: z.number().int().optional(),
  cohortId: z.number().int().optional(),
  groupId: z.number().int().optional(),
  onCohortLeave: z.enum(['suspend', 'unenrol']).optional(),
  cost: z.number().int().optional(),
  currency: z.string().optional(),
  paymentAccountId: z.number().int().optional(),
});
export type CreateEnrolInstance = z.infer<typeof createEnrolInstanceSchema>;

/** Payload sửa enrol instance (mọi trường đều tuỳ chọn). */
export const updateEnrolInstanceSchema = z.strictObject({
  name: z.string().optional(),
  status: z.number().int().optional(),
  enrolperiod: z.number().int().optional(),
  onCohortLeave: z.enum(['suspend', 'unenrol']).optional(),
  groupId: z.number().int().optional(),
});
export type UpdateEnrolInstance = z.infer<typeof updateEnrolInstanceSchema>;

/** Payload ghi danh một người dùng qua enrol instance. */
export const enrolUserSchema = z.strictObject({
  userid: z.number().int(),
  timestart: z.string().optional(),
  timeend: z.string().optional(),
});
export type EnrolUser = z.infer<typeof enrolUserSchema>;
