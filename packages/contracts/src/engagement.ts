import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/** Communication & Engagement contracts — shared shapes between api, worker-facing payloads and web. */

/* ---- Messaging ---- */

export const messageSchema = z.object({
  id: uuidIdSchema,
  conversationid: uuidIdSchema,
  useridfrom: uuidIdSchema,
  subject: z.string(),
  fullmessage: z.string(),
  timecreated: z.string(),
});
export type LmsMessage = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  id: uuidIdSchema,
  type: z.number().int(), // 1 individual, 2 group
  name: z.string().nullable(),
  members: z.array(uuidIdSchema),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const notificationSchema = z.object({
  id: uuidIdSchema,
  useridto: uuidIdSchema,
  subject: z.string(),
  fullmessage: z.string(),
  eventtype: z.string(),
  timeread: z.string().nullable(),
  timecreated: z.string(),
});
export type LmsNotification = z.infer<typeof notificationSchema>;

export const messagePreferenceSchema = z.object({
  provider: z.string(),
  channel: z.string(),
  loggedin: z.boolean(),
  loggedoff: z.boolean(),
});
export type MessagePreference = z.infer<typeof messagePreferenceSchema>;

/* ---- Calendar ---- */

export const CALENDAR_EVENT_TYPES = ['site', 'category', 'course', 'group', 'user'] as const;
export const calendarEventSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  eventtype: z.enum(CALENDAR_EVENT_TYPES),
  timestart: z.string(),
  timeduration: z.number().int(),
  repeatid: uuidIdSchema,
  isexception: z.boolean(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/* ---- Badges ---- */

export const badgeSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  type: z.number().int(), // 1 site, 2 course
  status: z.number().int(), // 0 inactive, 1 active, 2 retired, 3 archived, 4 disabled
});
export type Badge = z.infer<typeof badgeSchema>;

export const issuedBadgeSchema = z.object({
  id: uuidIdSchema,
  badgeid: uuidIdSchema,
  userid: uuidIdSchema,
  uniquehash: z.string(),
  dateissued: z.string(),
  dateexpire: z.string().nullable(),
  revoked: z.boolean(),
});
export type IssuedBadge = z.infer<typeof issuedBadgeSchema>;

/* ---- Competencies ---- */

export const PLAN_STATUSES = [0, 1, 2, 3, 4] as const; // draft, active, waitingforreview, inreview, complete
export const learningPlanSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  userid: uuidIdSchema,
  templateid: uuidIdSchema.nullable(),
  status: z.number().int(),
});
export type LearningPlan = z.infer<typeof learningPlanSchema>;

export const userCompetencySchema = z.object({
  id: uuidIdSchema,
  userid: uuidIdSchema,
  competencyid: uuidIdSchema,
  grade: z.number().int().nullable(),
  proficiency: z.boolean().nullable(),
  status: z.number().int(), // review: 0 none, 1 waiting, 2 inreview
});
export type UserCompetency = z.infer<typeof userCompetencySchema>;

/* ---- Social ---- */

export const tagSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  ordering: z.number().int(),
});
export type Tag = z.infer<typeof tagSchema>;

export const commentSchema = z.object({
  id: uuidIdSchema,
  userid: uuidIdSchema,
  content: z.string(),
  contextid: uuidIdSchema,
});
export type LmsComment = z.infer<typeof commentSchema>;

export const ratingAggregateSchema = z.object({
  count: z.number().int(),
  average: z.number(),
  sum: z.number(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});
export type RatingAggregate = z.infer<typeof ratingAggregateSchema>;

export const blogPostSchema = z.object({
  id: uuidIdSchema,
  userid: uuidIdSchema,
  subject: z.string(),
  content: z.string(),
  publishstate: z.enum(['draft', 'site']),
});
export type BlogPost = z.infer<typeof blogPostSchema>;

export const noteSchema = z.object({
  id: uuidIdSchema,
  userid: uuidIdSchema, // subject user
  courseid: uuidIdSchema,
  createdby: uuidIdSchema,
  content: z.string(),
  publishstate: z.enum(['draft', 'public', 'site']),
});
export type Note = z.infer<typeof noteSchema>;

/* ---- Request payload schemas (Zod — nguồn sự thật duy nhất; xem ADR Zod-only) ---- */

/** Payload tạo cuộc hội thoại: type 1 = cá nhân, 2 = nhóm. */
export const createConversationSchema = z.strictObject({
  type: z.number().int().optional(),
  memberIds: z.array(uuidIdSchema),
  name: z.string().optional(),
});
export type CreateConversation = z.infer<typeof createConversationSchema>;

/** Payload tạo conversation gắn với một course group (component core_group). */
export const createGroupConversationSchema = z.strictObject({
  groupId: uuidIdSchema,
  name: z.string().optional(),
});
export type CreateGroupConversation = z.infer<typeof createGroupConversationSchema>;

/** Payload gửi tin nhắn vào một cuộc hội thoại. */
export const sendMessageSchema = z.strictObject({
  text: z.string().min(1),
  subject: z.string().optional(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

/** Payload đặt tuỳ chọn kênh nhận cho một message provider. */
export const setMessagePreferenceSchema = z.strictObject({
  provider: z.string().min(1),
  channel: z.enum(['popup', 'email', 'push']),
  state: z.enum(['loggedin', 'loggedoff']),
  enabled: z.boolean(),
});
export type SetMessagePreference = z.infer<typeof setMessagePreferenceSchema>;

/** Payload phát thông báo hệ thống tới một người dùng. */
export const notifyUserSchema = z.strictObject({
  userId: uuidIdSchema,
  provider: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  contextUrl: z.string().optional(),
});
export type NotifyUser = z.infer<typeof notifyUserSchema>;

/** Quy tắc lặp của sự kiện lịch (chỉ nhận các tần suất hệ thống hỗ trợ). */
export const calendarRepeatSchema = z.strictObject({
  freq: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'daily', 'weekly', 'monthly']),
  count: z.number().int().optional(),
  until: z.string().optional(),
});
export type CalendarRepeat = z.infer<typeof calendarRepeatSchema>;

/** Payload tạo sự kiện lịch theo loại phạm vi (site/category/course/group/user). */
export const createCalendarEventSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  eventtype: z.enum(['site', 'category', 'course', 'group', 'user']),
  courseid: uuidIdSchema.optional(),
  groupid: uuidIdSchema.optional(),
  categoryid: uuidIdSchema.optional(),
  timestart: z.string(),
  timeduration: z.number().int().optional(),
  location: z.string().optional(),
  repeat: calendarRepeatSchema.optional(),
});
export type CreateCalendarEvent = z.infer<typeof createCalendarEventSchema>;

/** Payload tạo ngoại lệ (exception) cho một sự kiện lặp. */
export const createCalendarExceptionSchema = z.strictObject({
  name: z.string().optional(),
  timestart: z.string(),
  description: z.string().optional(),
});
export type CreateCalendarException = z.infer<typeof createCalendarExceptionSchema>;

/** Payload tạo đăng ký lịch ngoài (subscription) từ URL hoặc dữ liệu ICS. */
export const createCalendarSubscriptionSchema = z.strictObject({
  name: z.string().min(1),
  url: z.string().optional(),
  icsdata: z.string().optional(),
  eventtype: z.enum(['site', 'category', 'course', 'group', 'user']).optional(),
  courseid: uuidIdSchema.optional(),
  categoryid: uuidIdSchema.optional(),
  pollinterval: z.number().int().optional(),
});
export type CreateCalendarSubscription = z.infer<typeof createCalendarSubscriptionSchema>;

/** Payload đặt nhắc nhở trước sự kiện (số phút). */
export const calendarRemindSchema = z.strictObject({
  minutesBefore: z.number().int(),
});
export type CalendarRemind = z.infer<typeof calendarRemindSchema>;

/** Payload tạo huy hiệu (badge): type 1 = site, 2 = course. */
export const createBadgeSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.number().int().optional(),
  courseid: uuidIdSchema.optional(),
  issuername: z.string().optional(),
  issuerurl: z.string().optional(),
  issuercontact: z.string().optional(),
  expiredate: z.string().optional(),
  expireperiod: z.number().int().optional(),
  version: z.string().optional(),
});
export type CreateBadge = z.infer<typeof createBadgeSchema>;

/** Payload sửa huy hiệu (mọi trường đều tuỳ chọn). */
export const updateBadgeSchema = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  issuername: z.string().optional(),
  expireperiod: z.number().int().optional(),
});
export type UpdateBadge = z.infer<typeof updateBadgeSchema>;

/** Payload đổi trạng thái vòng đời của huy hiệu. */
export const setBadgeStatusSchema = z.strictObject({
  status: z.number().int(),
});
export type SetBadgeStatus = z.infer<typeof setBadgeStatusSchema>;

/**
 * Tham số của từng loại lá tiêu chí cấp huy hiệu (discriminated theo
 * `criteriatype` ở schema lá bên dưới):
 * - `coursecompletion`: `{ courseId, byDate? }` — hoàn thành khoá học; khi có
 *   `byDate` (ISO datetime) thì thời điểm hoàn thành phải ≤ ngày đó mới tính
 *   (Moodle: tham số by-date của tiêu chí hoàn thành khoá học).
 * - `activitycompletion`: `{ cmId }` — hoàn thành hoạt động.
 * - `competency`: `{ competencyId }` — đạt proficiency của năng lực.
 * - `badge`: `{ badgeId }` — đã được cấp huy hiệu khác.
 * - `manual`: `{ roleId? }` — cấp tay bởi người giữ vai trò (tuỳ chọn).
 * - `cohort`: `{ cohortId }` hoặc `{ cohortIds }` — thuộc cohort chỉ định
 *   (dạng mảng: phải thuộc TẤT CẢ cohort liệt kê).
 * - `profile`: `{ field, value? }` — trường hồ sơ chuẩn (firstname, lastname,
 *   email, username…) hoặc custom field theo shortname đạt điều kiện: có
 *   `value` thì giá trị phải bằng đúng; không có `value` thì trường phải
 *   được điền (khác rỗng).
 */
export const badgeCriteriaParamsSchema = z.union([
  z.strictObject({ courseId: uuidIdSchema, byDate: z.iso.datetime({ offset: true }).optional() }),
  z.strictObject({ cmId: uuidIdSchema }),
  z.strictObject({ competencyId: uuidIdSchema }),
  z.strictObject({ badgeId: uuidIdSchema }),
  z.strictObject({ roleId: uuidIdSchema.optional() }),
  z.strictObject({ cohortId: uuidIdSchema }),
  z.strictObject({ cohortIds: z.array(uuidIdSchema).min(1) }),
  z.strictObject({ field: z.string().min(1), value: z.string().optional() }),
]);
export type BadgeCriteriaParams = z.infer<typeof badgeCriteriaParamsSchema>;

/** Các loại lá tiêu chí huy hiệu được hỗ trợ (khớp LEAF_TYPES phía API). */
export const badgeCriteriaLeafTypes = [
  'coursecompletion', 'activitycompletion', 'competency', 'badge', 'manual', 'cohort', 'profile',
] as const;

/** Một lá tiêu chí cấp huy hiệu: loại tiêu chí + bộ tham số riêng của loại đó. */
export const badgeCriteriaLeafSchema = z.strictObject({
  criteriatype: z.enum(badgeCriteriaLeafTypes),
  params: badgeCriteriaParamsSchema.optional(),
  description: z.string().optional(),
});
export type BadgeCriteriaLeaf = z.infer<typeof badgeCriteriaLeafSchema>;

/** Payload đặt bộ tiêu chí cấp huy hiệu: method 1 = TẤT CẢ (ALL), 2 = BẤT KỲ (ANY). */
export const setBadgeCriteriaSchema = z.strictObject({
  method: z.number().int(),
  criteria: z.array(badgeCriteriaLeafSchema),
});
export type SetBadgeCriteria = z.infer<typeof setBadgeCriteriaSchema>;

/** Payload mang một userId (cấp tay / đánh giá huy hiệu cho một người dùng). */
export const badgeUserSchema = z.strictObject({
  userId: uuidIdSchema,
});
export type BadgeUser = z.infer<typeof badgeUserSchema>;

/** Thang đánh giá của một competency framework: danh sách mức + các mức được coi là đạt (proficient). */
export const competencyScaleSchema = z.strictObject({
  values: z.array(z.string()),
  proficient: z.array(z.number().int()),
});
export type CompetencyScale = z.infer<typeof competencyScaleSchema>;

/** Payload tạo competency framework kèm thang đánh giá. */
export const createCompetencyFrameworkSchema = z.strictObject({
  shortname: z.string().min(1),
  idnumber: z.string().optional(),
  description: z.string().optional(),
  scale: competencyScaleSchema,
  visible: z.boolean().optional(),
});
export type CreateCompetencyFramework = z.infer<typeof createCompetencyFrameworkSchema>;

/** Payload tạo competency trong một framework. */
export const createCompetencySchema = z.strictObject({
  shortname: z.string().min(1),
  idnumber: z.string().optional(),
  description: z.string().optional(),
  parentId: uuidIdSchema.optional(),
});
export type CreateCompetency = z.infer<typeof createCompetencySchema>;

/** Payload liên kết competency với một course module kèm kết quả áp dụng (rule outcome). */
export const linkCompetencySchema = z.strictObject({
  competencyId: uuidIdSchema,
  ruleoutcome: z.string(),
});
export type LinkCompetency = z.infer<typeof linkCompetencySchema>;

/** Payload tạo mẫu kế hoạch học tập (learning plan template). */
export const createLearningPlanTemplateSchema = z.strictObject({
  shortname: z.string().min(1),
  description: z.string().optional(),
  duedate: z.string().optional(),
});
export type CreateLearningPlanTemplate = z.infer<typeof createLearningPlanTemplateSchema>;

/** Payload gắn một competency vào template. */
export const addTemplateCompetencySchema = z.strictObject({
  competencyId: uuidIdSchema,
});
export type AddTemplateCompetency = z.infer<typeof addTemplateCompetencySchema>;

/** Payload gắn một cohort vào template (sinh plan cho cả cohort ở tầng nghiệp vụ). */
export const addTemplateCohortSchema = z.strictObject({
  cohortId: uuidIdSchema,
});
export type AddTemplateCohort = z.infer<typeof addTemplateCohortSchema>;

/** Payload tạo kế hoạch học tập (từ template hoặc tự do). */
export const createLearningPlanSchema = z.strictObject({
  userId: uuidIdSchema.optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  templateId: uuidIdSchema.optional(),
});
export type CreateLearningPlan = z.infer<typeof createLearningPlanSchema>;

/** Payload nộp bằng chứng (evidence) cho một competency. */
export const addCompetencyEvidenceSchema = z.strictObject({
  userId: uuidIdSchema,
  competencyId: uuidIdSchema,
  planId: uuidIdSchema.optional(),
  courseId: uuidIdSchema.optional(),
  description: z.string().min(1),
  url: z.string().optional(),
  grade: z.number().int().optional(),
  note: z.string().optional(),
  sendForReview: z.boolean().optional(),
});
export type AddCompetencyEvidence = z.infer<typeof addCompetencyEvidenceSchema>;

/** Payload chấm mức đạt cho competency của một người dùng. */
export const gradeUserCompetencySchema = z.strictObject({
  userId: uuidIdSchema,
  competencyId: uuidIdSchema,
  planId: uuidIdSchema.optional(),
  courseId: uuidIdSchema.optional(),
  grade: z.number().int(),
  note: z.string().optional(),
});
export type GradeUserCompetency = z.infer<typeof gradeUserCompetencySchema>;

/** Payload quyết định khi duyệt (review) competency: mức đạt + ghi chú. */
export const competencyReviewDecisionSchema = z.strictObject({
  grade: z.number().int().optional(),
  note: z.string().optional(),
});
export type CompetencyReviewDecision = z.infer<typeof competencyReviewDecisionSchema>;

/** Payload chỉ mang ghi chú (dùng cho các thao tác duyệt/chuyển trạng thái kèm nhận xét). */
export const competencyNoteSchema = z.strictObject({
  note: z.string().optional(),
});
export type CompetencyNote = z.infer<typeof competencyNoteSchema>;

/** Payload chỉ mang một giá trị số (dùng cho thao tác đặt giá trị đơn lẻ). */
export const numericValueSchema = z.strictObject({
  value: z.number().optional(),
});
export type NumericValue = z.infer<typeof numericValueSchema>;

/**
 * Kết quả áp dụng khi rule của competency cha thỏa (Moodle `competency.ruleoutcome`):
 * `complete` = cha tự đạt proficiency, `attach-evidence` = chỉ ghi evidence, `nothing` = không làm gì.
 */
export const competencyRuleOutcomeSchema = z.enum(['complete', 'attach-evidence', 'nothing']);
export type CompetencyRuleOutcome = z.infer<typeof competencyRuleOutcomeSchema>;

/** Một dòng điểm của rule points: competency con đóng góp `points` điểm khi đạt proficiency; `required` = bắt buộc đạt. */
export const competencyRulePointsEntrySchema = z.strictObject({
  competencyId: uuidIdSchema,
  points: z.number().int().min(0),
  required: z.boolean(),
});
export type CompetencyRulePointsEntry = z.infer<typeof competencyRulePointsEntrySchema>;

/**
 * Payload đặt rule points cho một competency cha (Moodle `competency_rule_points`):
 * cha thỏa rule khi mọi con `required` đều đạt proficiency VÀ tổng điểm các con đã đạt
 * >= `pointsRequired`. Tính hợp lệ sâu (con phải là con trực tiếp, không trùng, tổng điểm
 * phải với tới ngưỡng) do tầng nghiệp vụ kiểm tra.
 */
export const setCompetencyRuleSchema = z.strictObject({
  outcome: competencyRuleOutcomeSchema,
  pointsRequired: z.number().int().min(1),
  entries: z.array(competencyRulePointsEntrySchema).min(1),
});
export type SetCompetencyRule = z.infer<typeof setCompetencyRuleSchema>;

/** Một dòng điểm của rule points trong tài liệu export: tham chiếu con bằng `competencyKey` nội bộ của file. */
export const frameworkExportRuleEntrySchema = z.strictObject({
  competencyKey: z.string().min(1),
  points: z.number().int().min(0),
  required: z.boolean(),
});
export type FrameworkExportRuleEntry = z.infer<typeof frameworkExportRuleEntrySchema>;

/** Rule points của một competency trong tài liệu export framework. */
export const frameworkExportRuleSchema = z.strictObject({
  outcome: competencyRuleOutcomeSchema,
  pointsRequired: z.number().int().min(1),
  entries: z.array(frameworkExportRuleEntrySchema).min(1),
});
export type FrameworkExportRule = z.infer<typeof frameworkExportRuleSchema>;

/** Một competency trong tài liệu export framework: `key` là khóa nội bộ của file (id nguồn), KHÔNG phải id sẽ dùng khi import. */
export const frameworkExportCompetencySchema = z.strictObject({
  key: z.string().min(1),
  shortname: z.string().min(1),
  idnumber: z.string(),
  description: z.string(),
  parentKey: z.string().min(1).nullable(),
  sortorder: z.number().int(),
  rule: frameworkExportRuleSchema.nullable(),
});
export type FrameworkExportCompetency = z.infer<typeof frameworkExportCompetencySchema>;

/**
 * Tài liệu export/import của một competency framework (định dạng của chính hệ thống):
 * cây competency + scale + taxonomies. Import luôn tạo framework MỚI với id mới toàn bộ;
 * `key`/`parentKey`/`competencyKey` chỉ để nối cấu trúc bên trong file.
 */
export const frameworkExportSchema = z.strictObject({
  format: z.literal('lms-competency-framework'),
  version: z.literal(1),
  framework: z.strictObject({
    shortname: z.string().min(1),
    idnumber: z.string(),
    description: z.string(),
    visible: z.boolean(),
    taxonomies: z.string(),
    scale: competencyScaleSchema,
  }),
  competencies: z.array(frameworkExportCompetencySchema),
});
export type FrameworkExport = z.infer<typeof frameworkExportSchema>;

/** Payload đặt toàn bộ thẻ (tags) cho một item. */
export const setItemTagsSchema = z.strictObject({
  component: z.string(),
  itemtype: z.string(),
  itemid: uuidIdSchema,
  contextid: uuidIdSchema,
  tags: z.array(z.string()),
});
export type SetItemTags = z.infer<typeof setItemTagsSchema>;

/** Payload thêm một thẻ cho một item. */
export const addItemTagSchema = z.strictObject({
  component: z.string(),
  itemtype: z.string(),
  itemid: uuidIdSchema,
  contextid: uuidIdSchema,
  tag: z.string().min(1),
});
export type AddItemTag = z.infer<typeof addItemTagSchema>;

/** Payload thêm bình luận vào một item trong một context. */
export const addCommentSchema = z.strictObject({
  contextid: uuidIdSchema,
  component: z.string(),
  commentarea: z.string(),
  itemid: uuidIdSchema,
  content: z.string().min(1),
});
export type AddComment = z.infer<typeof addCommentSchema>;

/** Payload chấm điểm (rating) cho một item theo một thang (scale). */
export const rateItemSchema = z.strictObject({
  contextid: uuidIdSchema,
  component: z.string(),
  ratingarea: z.string(),
  itemid: uuidIdSchema,
  scaleid: z.number().int(),
  rating: z.number().int(),
});
export type RateItem = z.infer<typeof rateItemSchema>;

/** Payload tạo bài blog: publishstate draft | site. */
export const createBlogPostSchema = z.strictObject({
  subject: z.string().min(1),
  summary: z.string().optional(),
  content: z.string(),
  publishstate: z.enum(['draft', 'site']).optional(),
});
export type CreateBlogPost = z.infer<typeof createBlogPostSchema>;

/** Payload sửa bài blog (mọi trường đều tuỳ chọn). */
export const updateBlogPostSchema = z.strictObject({
  subject: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  publishstate: z.enum(['draft', 'site']).optional(),
});
export type UpdateBlogPost = z.infer<typeof updateBlogPostSchema>;

/** Payload liên kết bài blog với một khoá học hoặc course module. */
export const associateBlogPostSchema = z.strictObject({
  assoctype: z.enum(['course', 'coursemodule']),
  associd: uuidIdSchema,
});
export type AssociateBlogPost = z.infer<typeof associateBlogPostSchema>;

/** Payload tạo ghi chú (note) về một người dùng: publishstate draft | public | site. */
export const createNoteSchema = z.strictObject({
  userid: uuidIdSchema,
  courseid: uuidIdSchema.optional(),
  content: z.string().min(1),
  publishstate: z.enum(['draft', 'public', 'site']).optional(),
  groupid: uuidIdSchema.optional(),
});
export type CreateNote = z.infer<typeof createNoteSchema>;
