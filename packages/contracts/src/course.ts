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
