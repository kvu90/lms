import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/** Platform Services contracts — shapes shared between api and web. */

/* ---- Search ---- */
export const searchDocumentSchema = z.object({
  id: uuidIdSchema,
  area: z.enum(['courses', 'users', 'contentbank', 'blog']),
  itemId: uuidIdSchema,
  contextId: uuidIdSchema,
  title: z.string(),
  content: z.string(),
});
export type SearchDocument = z.infer<typeof searchDocumentSchema>;

/* ---- Web Services ---- */
export const externalServiceSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  shortName: z.string(),
  enabled: z.boolean(),
  functions: z.array(z.string()),
});
export type ExternalService = z.infer<typeof externalServiceSchema>;

export const externalTokenCreatedSchema = z.object({
  /** Token thô chỉ xuất hiện đúng một lần trong response tạo token. */
  token: z.string().length(64),
  id: uuidIdSchema,
  userId: uuidIdSchema,
  serviceId: uuidIdSchema,
});
export type ExternalTokenCreated = z.infer<typeof externalTokenCreatedSchema>;

/* ---- Backup ---- */
export const BACKUP_FORMAT_VERSION = 1;
/** Phạm vi sao lưu: `course` gắn với một khoá học; `site` là sao lưu mức hệ thống (không gắn khoá, courseId = null). */
export const BACKUP_SCOPES = ['course', 'site'] as const;
export const backupJobSchema = z.object({
  id: uuidIdSchema,
  type: z.enum(['backup', 'restore']),
  scope: z.enum(BACKUP_SCOPES),
  courseId: uuidIdSchema.nullable(),
  targetCourseId: uuidIdSchema.nullable(),
  mode: z.enum(['new', 'merge', 'replace']),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  anonymize: z.boolean(),
});
export type BackupJob = z.infer<typeof backupJobSchema>;

export const backupIdMappingSchema = z.object({
  id: uuidIdSchema,
  jobId: uuidIdSchema,
  itemType: z.string(),
  oldId: uuidIdSchema,
  newId: uuidIdSchema,
}).refine((m) => m.newId !== m.oldId, { message: 'restore must remap ids, never keep the original id' });
export type BackupIdMapping = z.infer<typeof backupIdMappingSchema>;

/* ---- Analytics ---- */
export const insightSchema = z.object({
  id: uuidIdSchema,
  modelId: uuidIdSchema,
  userId: uuidIdSchema,
  recipientId: uuidIdSchema,
  contextId: uuidIdSchema,
  courseId: uuidIdSchema,
  heading: z.string(),
});
export type Insight = z.infer<typeof insightSchema>;

/* ---- Reports ---- */
export const REPORT_DATASOURCES = ['enrolments', 'grades', 'completion'] as const;
export const reportSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  dataSource: z.enum(REPORT_DATASOURCES),
  columns: z.array(z.string()),
  createdBy: uuidIdSchema,
});
export type Report = z.infer<typeof reportSchema>;

/* ---- Content Bank / Kho học liệu (CB-1) ---- */
/** Loại học liệu: đúng 5 nhóm của Điều 7 TT 09/2021 (bài giảng đa phương tiện gồm cả video). */
export const contentBankResourceTypeSchema = z.enum(['multimedia_lecture', 'lab_guide', 'simulation', 'question_set', 'reference']);
export type ContentBankResourceType = z.infer<typeof contentBankResourceTypeSchema>;
export const contentBankScopeSchema = z.enum(['personal', 'org', 'school']);
export type ContentBankScope = z.infer<typeof contentBankScopeSchema>;
export const contentBankReviewStatusSchema = z.enum(['draft', 'pending', 'approved', 'rejected']);
export type ContentBankReviewStatus = z.infer<typeof contentBankReviewStatusSchema>;
/** Cấp học độc lập với khối lớp (liên thông trục môn × cấp của kho quốc gia). */
export const contentBankLevelSchema = z.enum(['primary', 'lower_secondary', 'upper_secondary', 'multi']);
export type ContentBankLevel = z.infer<typeof contentBankLevelSchema>;
/** Nguồn gốc học liệu (CB1-B1): tự soạn | sưu tầm/trích dẫn | dẫn xuất từ học liệu trong kho. */
export const contentBankSourceKindSchema = z.enum(['self', 'cited', 'derived']);
export type ContentBankSourceKind = z.infer<typeof contentBankSourceKindSchema>;
export const contentBankTargetAudienceSchema = z.enum(['students', 'teachers', 'both']);
export type ContentBankTargetAudience = z.infer<typeof contentBankTargetAudienceSchema>;
/** Vị trí dùng trong bài theo khung kế hoạch bài dạy CV 5512. */
export const contentBankLessonPositionSchema = z.enum(['opening', 'new_knowledge', 'practice', 'application']);
export type ContentBankLessonPosition = z.infer<typeof contentBankLessonPositionSchema>;
/** Checklist duyệt theo tiêu chí thể lệ bài giảng điện tử của Bộ (CB1-B3). */
export const contentBankReviewChecklistSchema = z.object({
  contentAccurate: z.boolean(),
  sourceClear: z.boolean(),
  pedagogyAesthetics: z.boolean(),
  mobileReady: z.boolean(),
});
export type ContentBankReviewChecklist = z.infer<typeof contentBankReviewChecklistSchema>;

export const contentBankContentSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  contentType: z.string(),
  contextId: uuidIdSchema,
  creatorId: uuidIdSchema,
  visibility: z.enum(['draft', 'public']),
  fileId: uuidIdSchema.nullable(),
  resourceType: contentBankResourceTypeSchema,
  scope: contentBankScopeSchema,
  spaceId: uuidIdSchema.nullable(),
  subjectId: uuidIdSchema.nullable(),
  grade: z.number().int().min(1).max(12).nullable(),
  level: contentBankLevelSchema.nullable(),
  curriculumNodeId: uuidIdSchema.nullable(),
  outcomeIds: z.array(uuidIdSchema).nullable(),
  questionCategoryId: uuidIdSchema.nullable(),
  externalUrl: z.string().nullable(),
  description: z.string().nullable(),
  keywords: z.array(z.string()).nullable(),
  targetAudience: contentBankTargetAudienceSchema.nullable(),
  lessonPosition: contentBankLessonPositionSchema.nullable(),
  techFormat: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  language: z.string(),
  originalAuthor: z.string().nullable(),
  sourceKind: contentBankSourceKindSchema.nullable(),
  sourceCitation: z.string().nullable(),
  license: z.string().nullable(),
  derivedFromId: uuidIdSchema.nullable(),
  reviewStatus: contentBankReviewStatusSchema,
  reviewedBy: uuidIdSchema.nullable(),
  reviewNote: z.string().nullable(),
  reviewChecklist: contentBankReviewChecklistSchema.nullable(),
});
export type ContentBankContent = z.infer<typeof contentBankContentSchema>;

/** Một không gian của Kho học liệu: cá nhân, một tổ chuyên môn (cohort), hoặc toàn trường. */
export const contentBankSpaceSchema = z.object({
  scope: contentBankScopeSchema,
  spaceId: uuidIdSchema.nullable(),
  name: z.string(),
  canReview: z.boolean(),
});
export type ContentBankSpace = z.infer<typeof contentBankSpaceSchema>;

/* ---- Payments ---- */
export const paymentSchema = z.object({
  id: uuidIdSchema,
  accountId: uuidIdSchema,
  userId: uuidIdSchema,
  /** Số tiền nguyên ở đơn vị nhỏ nhất — không bao giờ là float. */
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']),
  gateway: z.string(),
});
export type Payment = z.infer<typeof paymentSchema>;

/* ---- Privacy ---- */
export const privacyRequestSchema = z.object({
  id: uuidIdSchema,
  userId: uuidIdSchema,
  type: z.enum(['export', 'delete']),
  status: z.enum(['pending', 'approved', 'rejected', 'completed', 'failed']),
});
export type PrivacyRequest = z.infer<typeof privacyRequestSchema>;

/* ---- Request payload schemas (Zod — nguồn sự thật duy nhất cho validation ở
 * API qua Standard Schema và cho form phía React; xem ADR về Zod-only) ---- */

/** Payload lập chỉ mục một item của một search area đã đăng ký. */
export const searchIndexItemSchema = z.strictObject({
  area: z.string().min(1),
  itemId: uuidIdSchema,
});
export type SearchIndexItem = z.infer<typeof searchIndexItemSchema>;

/** Payload tạo external service. */
export const createExternalServiceSchema = z.strictObject({
  name: z.string().min(1),
  shortName: z.string().min(1),
  enabled: z.boolean().optional(),
  functions: z.array(z.string()).optional(),
});
export type CreateExternalService = z.infer<typeof createExternalServiceSchema>;

/** Payload bật/tắt external service. */
export const setExternalServiceEnabledSchema = z.strictObject({ enabled: z.boolean() });
export type SetExternalServiceEnabled = z.infer<typeof setExternalServiceEnabledSchema>;

/** Payload tạo external token cho một user trong một service. */
export const createExternalTokenSchema = z.strictObject({
  userId: uuidIdSchema,
  serviceId: uuidIdSchema,
  validUntil: z.string().optional(),
  ipRestriction: z.string().optional(),
});
export type CreateExternalToken = z.infer<typeof createExternalTokenSchema>;

/** Payload gọi một external function qua envelope thống nhất. */
export const callExternalFunctionSchema = z.strictObject({
  token: z.string().min(1),
  functionName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type CallExternalFunction = z.infer<typeof callExternalFunctionSchema>;

/**
 * Payload tạo backup job. Phạm vi mặc định là `course` và bắt buộc có
 * `courseId`; phạm vi `site` (sao lưu mức hệ thống: category câu hỏi mức
 * site, ngân hàng câu hỏi mức site, badge mức site, sự kiện/subscription
 * mức site) thì KHÔNG được gắn khoá học.
 */
export const createBackupSchema = z.strictObject({
  courseId: uuidIdSchema.optional(),
  scope: z.enum(BACKUP_SCOPES).optional(),
  anonymize: z.boolean().optional(),
}).superRefine((v, ctx) => {
  const scope = v.scope ?? 'course';
  if (scope === 'course' && !v.courseId) {
    ctx.addIssue({ code: 'custom', path: ['courseId'], message: 'A course backup requires courseId' });
  }
  if (scope === 'site' && v.courseId) {
    ctx.addIssue({ code: 'custom', path: ['courseId'], message: 'A site backup must not carry a courseId' });
  }
});
export type CreateBackup = z.infer<typeof createBackupSchema>;

/** Payload restore: ba chế độ tường minh, target bắt buộc với merge/replace ở tầng service. */
export const restoreCourseSchema = z.strictObject({
  backupJobId: uuidIdSchema,
  mode: z.enum(['new', 'merge', 'replace']),
  targetCourseId: uuidIdSchema.optional(),
});
export type RestoreCourse = z.infer<typeof restoreCourseSchema>;

/** Payload chạy một model phân tích cho một khoá. */
export const runAnalyticsModelSchema = z.strictObject({ courseId: uuidIdSchema });
export type RunAnalyticsModel = z.infer<typeof runAnalyticsModelSchema>;

/** Payload tạo báo cáo: dataSource là entity đã đăng ký, columns/filters là cấu hình (không nới quyền). */
export const createReportSchema = z.strictObject({
  name: z.string().min(1),
  dataSource: z.enum(['enrolments', 'grades', 'completion']),
  columns: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  audienceUserIds: z.array(uuidIdSchema).optional(),
  audienceRoles: z.array(z.string()).optional(),
});
export type CreateReport = z.infer<typeof createReportSchema>;

/** Payload đặt lịch chạy báo cáo. */
export const createReportScheduleSchema = z.strictObject({ cron: z.string().optional() });
export type CreateReportSchedule = z.infer<typeof createReportScheduleSchema>;

/* ---- Event log (logstore) ---- */

/**
 * Bộ lọc truy vấn nhật ký sự kiện (báo cáo "ai đã làm gì"): `userId` là
 * người thực hiện (actor), `relatedUserId` là người bị tác động; `from`/`to`
 * là mốc thời gian ISO của sự kiện. Phân trang theo chuẩn chung của repo.
 */
export const listEventLogsQuerySchema = z.strictObject({
  userId: uuidIdSchema.optional(),
  relatedUserId: uuidIdSchema.optional(),
  courseId: uuidIdSchema.optional(),
  contextId: uuidIdSchema.optional(),
  component: z.string().min(1).optional(),
  eventType: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
});
export type ListEventLogsQuery = z.infer<typeof listEventLogsQuerySchema>;

/**
 * Payload tạo học liệu Kho học liệu (CB-1). `contextId` không còn bắt buộc:
 * server tự suy theo `scope` (personal → context của tác giả, org/school →
 * context hệ thống); chỉ truyền khi cần bám hành vi cũ. Metadata chương
 * trình (môn/khối/node/YCCĐ) bắt buộc khi gửi duyệt scope org/school —
 * server kiểm ở bước submit.
 */
export const createContentBankContentSchema = z.strictObject({
  name: z.string().min(1),
  contextId: uuidIdSchema.optional(),
  contentType: z.string().optional(),
  visibility: z.enum(['draft', 'public']).optional(),
  fileId: uuidIdSchema.optional(),
  resourceType: contentBankResourceTypeSchema.optional(),
  scope: contentBankScopeSchema.optional(),
  spaceId: uuidIdSchema.optional(),
  subjectId: uuidIdSchema.optional(),
  grade: z.number().int().min(1).max(12).optional(),
  level: contentBankLevelSchema.optional(),
  curriculumNodeId: uuidIdSchema.optional(),
  outcomeIds: z.array(uuidIdSchema).optional(),
  questionCategoryId: uuidIdSchema.optional(),
  externalUrl: z.string().url().optional(),
  description: z.string().max(5000).optional(),
  keywords: z.array(z.string().min(1).max(100)).max(20).optional(),
  targetAudience: contentBankTargetAudienceSchema.optional(),
  lessonPosition: contentBankLessonPositionSchema.optional(),
  techFormat: z.string().max(50).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  language: z.string().max(10).optional(),
  originalAuthor: z.string().max(300).optional(),
  sourceKind: contentBankSourceKindSchema.optional(),
  sourceCitation: z.string().max(2000).optional(),
  license: z.string().max(300).optional(),
  derivedFromId: uuidIdSchema.optional(),
});
export type CreateContentBankContent = z.infer<typeof createContentBankContentSchema>;

/** Payload sửa học liệu Content Bank. */
export const updateContentBankContentSchema = createContentBankContentSchema
  .omit({ contextId: true })
  .partial()
  .extend({ fileId: uuidIdSchema.optional() });
export type UpdateContentBankContent = z.infer<typeof updateContentBankContentSchema>;

/**
 * Payload duyệt học liệu (tổ trưởng/quản trị): quyết định + ghi chú +
 * checklist tiêu chí Bộ (CB1-B3). Service ép: từ chối thì ghi chú (lý do)
 * là BẮT BUỘC; phê duyệt thì checklist phải đủ 4 tiêu chí đạt.
 */
export const reviewContentBankContentSchema = z.strictObject({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(1000).optional(),
  checklist: contentBankReviewChecklistSchema.optional(),
});
export type ReviewContentBankContent = z.infer<typeof reviewContentBankContentSchema>;

/** Payload cắm học liệu vào khoá ("Thêm từ kho"): tạo module tài nguyên bằng bản sao file. */
export const insertContentBankContentSchema = z.strictObject({
  courseId: uuidIdSchema,
  sectionId: uuidIdSchema,
});
export type InsertContentBankContent = z.infer<typeof insertContentBankContentSchema>;

/** Payload upload file cho một nội dung (nội dung file dạng base64 qua JSON để giữ envelope thống nhất). */
export const uploadContentBankFileSchema = z.strictObject({
  fileName: z.string().min(1),
  contentBase64: z.string(),
  mimeType: z.string().optional(),
});
export type UploadContentBankFile = z.infer<typeof uploadContentBankFileSchema>;

/** Payload tạo tài khoản thanh toán. */
export const createPaymentAccountSchema = z.strictObject({
  name: z.string().min(1),
  gateway: z.string().optional(),
});
export type CreatePaymentAccount = z.infer<typeof createPaymentAccountSchema>;

/** Payload tạo thanh toán: amount là số nguyên đơn vị nhỏ nhất (không float). */
export const createPaymentSchema = z.strictObject({
  accountId: uuidIdSchema,
  amount: z.number().int().min(1),
  currency: z.string().min(3),
  component: z.string().optional(),
  itemId: uuidIdSchema.optional(),
});
export type CreatePayment = z.infer<typeof createPaymentSchema>;

/** Payload webhook từ gateway: xử lý idempotent theo externalTransactionId. */
export const paymentWebhookSchema = z.strictObject({
  gateway: z.string().min(1),
  externalTransactionId: z.string().min(1),
  paymentId: uuidIdSchema,
  status: z.string().min(1),
});
export type PaymentWebhook = z.infer<typeof paymentWebhookSchema>;

/** Payload hoàn tiền: tạo giao dịch bù trừ riêng, payment gốc bất biến. */
export const createRefundSchema = z.strictObject({
  amount: z.number().int().min(1),
  reason: z.string().optional(),
  externalTransactionId: z.string().optional(),
});
export type CreateRefund = z.infer<typeof createRefundSchema>;

/** Payload người dùng tự gửi yêu cầu privacy cho chính mình. */
export const createPrivacyRequestSchema = z.strictObject({
  type: z.enum(['export', 'delete']),
});
export type CreatePrivacyRequest = z.infer<typeof createPrivacyRequestSchema>;

/** Payload phê duyệt/từ chối yêu cầu privacy. */
export const decidePrivacyRequestSchema = z.strictObject({
  decision: z.enum(['approved', 'rejected']),
});
export type DecidePrivacyRequest = z.infer<typeof decidePrivacyRequestSchema>;

/** Payload metadata đi kèm upload file (dạng nền — phía server ép kiểu số vì multipart/form-data luôn là chuỗi). */
export const uploadFileMetaSchema = z.strictObject({
  contextId: uuidIdSchema,
  component: z.string(),
  fileArea: z.string(),
  itemId: uuidIdSchema.optional(),
  filePath: z.string().optional(),
});
export type UploadFileMeta = z.infer<typeof uploadFileMetaSchema>;
