import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/** Contract Dịch vụ nền tảng — các shape dùng chung giữa api và web. */

/* ---- Search ---- */
export const searchDocumentSchema = z.object({
  id: uuidIdSchema,
  area: z.enum(['courses', 'users', 'contentbank']),
  itemId: uuidIdSchema,
  contextId: uuidIdSchema,
  title: z.string(),
  content: z.string(),
});
export type SearchDocument = z.infer<typeof searchDocumentSchema>;

/* ---- Dịch vụ web ---- */
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
  /**
   * Vòng đời payment: `needs_review` là trạng thái chờ người xử lý khi
   * tiền về nhưng không khớp đủ 3 điều kiện đối soát của issue #189
   * (đúng mã thanh toán + đúng số tiền + đúng tài khoản nhận) — thiếu
   * trạng thái này, mọi bề mặt parse qua schema sẽ từ chối payment
   * đang chờ đối soát dù DB và API đều mang trạng thái đó hợp lệ.
   */
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded', 'needs_review']),
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

/* ---- Nhật ký sự kiện (logstore) ---- */

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

/** Payload tạo tài khoản thanh toán. `config` giữ cấu hình gateway (với SePay:
 * bankBin/bankCode, bankAccountNumber, sepayApiKey, sepayBankAccountXid…) —
 * giá trị nhạy cảm trong config KHÔNG bao giờ được trả nguyên qua API đọc
 * (che ở tầng service, tiêu chí 6.4.5 của issue #189). */
export const createPaymentAccountSchema = z.strictObject({
  name: z.string().min(1),
  gateway: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
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

/** Trạng thái vòng đời của một dòng hoàn (lát 3, issue #189):
 * `requested` (đã tạo, chờ duyệt cấp 2) → `approved` (đã duyệt, chờ
 * xác nhận chi) → `settled` (lệnh chi đã xác nhận); `requested` hoặc
 * `approved` → `rejected` (từ chối). Đảo quyền lợi của khoản thu gốc
 * chỉ xảy ra tại mốc `settled` khi cộng dồn đã `settled` đạt 100%. */
export const paymentRefundStatusSchema = z.enum(['requested', 'approved', 'settled', 'rejected']);
export type PaymentRefundStatus = z.infer<typeof paymentRefundStatusSchema>;

/** Payload tạo YÊU CẦU hoàn tiền (lát 3, issue #189 — thay hình thức
 * hoàn một bước trước đây): tạo một dòng hoàn ở đầu vòng đời của nó,
 * payment gốc không đổi trạng thái cho tới khi dòng hoàn được xác
 * nhận chi và cộng dồn đạt 100%. `reason` là BẮT BUỘC (vết kiểm toán
 * của khoản chi). `externalTransactionId` là mã lệnh chi DỰ KIẾN mà
 * chủ tiền sẽ dùng khi chuyển khoản ra — đây là khoá để hệ thống tự
 * đối khớp sự kiện `debit` của SePay về sau; có thể bổ sung ở bước
 * xác nhận chi nếu lúc tạo chưa biết. Cấp duyệt (một cấp hay hai cấp)
 * do hệ thống quyết từ số tiền + ngưỡng cấu hình + luật hoàn đủ,
 * client không chọn. */
export const createRefundSchema = z.strictObject({
  amount: z.number().int().min(1),
  reason: z.string().trim().min(1).max(500),
  externalTransactionId: z.string().trim().min(1).max(128).optional(),
});
export type CreateRefund = z.infer<typeof createRefundSchema>;

/** Payload từ chối một yêu cầu hoàn: lý do từ chối là bắt buộc (vết
 * kiểm toán), dòng hoàn chuyển `rejected` và giải phóng phần ngân sách
 * hoàn đã giữ chỗ (dòng `rejected` không tính vào cổng cộng dồn). */
export const rejectRefundSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});
export type RejectRefund = z.infer<typeof rejectRefundSchema>;

/** Payload xác nhận chi cho một dòng hoàn đã duyệt: gắn mã lệnh chi
 * thực tế của lệnh chuyển khoản ra. Nếu dòng hoàn đã ghi mã lệnh chi
 * dự kiến lúc tạo thì payload có thể vắng — khi cả hai cùng có, hai mã
 * phải trùng nhau. Xác nhận chi là mốc `settled`: nếu lần xác nhận này
 * làm cộng dồn đã chi đạt 100% khoản thu, quyền lợi bị đảo tại đây. */
export const settleRefundSchema = z.strictObject({
  externalTransactionId: z.string().trim().min(1).max(128).optional(),
});
export type SettleRefund = z.infer<typeof settleRefundSchema>;

/** Một dòng hoàn ở dạng API: trọn vết kiểm toán của vòng đời — người
 * tạo + lý do, cấp duyệt áp dụng + ngưỡng hiệu lực tại thời điểm tạo,
 * người duyệt/từ chối kèm mốc thời gian, và xác nhận chi (người xác
 * nhận tay hoặc sự kiện `debit` đã khớp). Mốc thời gian là chuỗi ISO;
 * trường null nghĩa là mốc đó chưa xảy ra. `entitlementReversed` cho
 * biết dòng hoàn này có phải là dòng làm cộng dồn đạt 100% và đã đảo
 * quyền lợi hay không (null khi chưa tới mốc `settled`). */
export const paymentRefundSchema = z.object({
  id: uuidIdSchema,
  paymentId: uuidIdSchema,
  amount: z.number().int(),
  currency: z.string(),
  reason: z.string(),
  externalTransactionId: z.string().nullable(),
  status: paymentRefundStatusSchema,
  createdBy: uuidIdSchema.nullable(),
  approvalLevel: z.number().int().nullable(),
  approvalThreshold: z.number().int().nullable(),
  approvedBy: uuidIdSchema.nullable(),
  approvedAt: z.string().nullable(),
  rejectedBy: uuidIdSchema.nullable(),
  rejectedAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  settledBy: uuidIdSchema.nullable(),
  settledEventId: uuidIdSchema.nullable(),
  settledAt: z.string().nullable(),
  entitlementReversed: z.boolean().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PaymentRefund = z.infer<typeof paymentRefundSchema>;

/** Quyết định xử lý tay một khoản chờ trong hàng đợi `needs_review`:
 * `matched` = khớp tay về `succeeded` (kích hoạt quyền lợi trực tiếp
 * trước nhịp lật trạng thái và phát cùng outbox `payment_succeeded`
 * như đường khớp tự động); `rejected` = bác bỏ, khoản thu chuyển
 * `failed`. */
export const paymentReviewDecisionSchema = z.enum(['matched', 'rejected']);
export type PaymentReviewDecision = z.infer<typeof paymentReviewDecisionSchema>;

/** Payload xử lý tay hàng đợi `needs_review`: lý do là bắt buộc cho cả
 * hai quyết định (mọi xử lý tay đều là xác nhận tiền thật và phải có
 * người chịu trách nhiệm kèm lý do). */
export const resolvePaymentReviewSchema = z.strictObject({
  decision: paymentReviewDecisionSchema,
  reason: z.string().trim().min(1).max(500),
});
export type ResolvePaymentReview = z.infer<typeof resolvePaymentReviewSchema>;

/** Mã điều kiện lệch của một khoản chờ trong hàng đợi `needs_review`,
 * suy từ đối chiếu sự kiện provider với khoản thu tại thời điểm xem:
 * `amount_mismatch` (sai số tiền), `account_mismatch` (sai tài khoản
 * nhận), `expired` (tiền về sau hạn thanh toán), `unknown_code` (sự
 * kiện tiền vào không gắn được với khoản thu nào), `unmatched_debit`
 * (sự kiện tiền ra không khớp được dòng hoàn chờ xác nhận nào). */
export const paymentReviewMismatchSchema = z.enum([
  'amount_mismatch', 'account_mismatch', 'expired', 'unknown_code', 'unmatched_debit',
]);
export type PaymentReviewMismatch = z.infer<typeof paymentReviewMismatchSchema>;

/** Một mục của hàng đợi `needs_review`: hoặc một KHOẢN THU đang chờ
 * (kèm sự kiện provider liên quan gần nhất làm ngữ cảnh đối soát),
 * hoặc một SỰ KIỆN provider mồ côi không gắn được với khoản thu nào.
 * `ageHours` là tuổi của khoản chờ; `overdue` đánh dấu quá hạn theo
 * khoá cấu hình `payments/reviewtargethours` của tenant chủ tiền —
 * chỉ để cảnh báo, hệ thống không tự xử lý khoản quá hạn. */
export const paymentReviewQueueItemSchema = z.object({
  kind: z.enum(['payment', 'event']),
  tenantId: uuidIdSchema,
  payment: z.object({
    id: uuidIdSchema,
    paymentCode: z.string().nullable(),
    amount: z.number().int(),
    currency: z.string(),
    component: z.string(),
    userId: uuidIdSchema,
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
  }).nullable(),
  event: z.object({
    id: uuidIdSchema,
    externalTransactionId: z.string(),
    direction: z.enum(['credit', 'debit']),
    amount: z.number().int(),
    extractedCode: z.string().nullable(),
    receivedAt: z.string(),
  }).nullable(),
  mismatches: z.array(paymentReviewMismatchSchema),
  ageHours: z.number(),
  overdue: z.boolean(),
});
export type PaymentReviewQueueItem = z.infer<typeof paymentReviewQueueItemSchema>;

/** Loại gói bán qua pipeline thanh toán (lát 2, issue #189): gói trung
 * tâm (`tenant_plan` — bên hưởng là một tenant) và gói giáo viên
 * (`teacher_plan` — bên hưởng là một người dùng giáo viên). Giá của mỗi
 * gói KHÔNG nằm trong code: giá hiệu lực đọc từ cấu hình hệ thống
 * (component `payments`, khoá `tenantplanprice` / `teacherplanprice`)
 * tại thời điểm tạo khoản thu. */
export const planComponentSchema = z.enum(['tenant_plan', 'teacher_plan']);
export type PlanComponent = z.infer<typeof planComponentSchema>;

/** Payload mua/nâng gói: bên gọi chỉ chọn LOẠI gói — số tiền luôn do
 * hệ thống quyết từ cấu hình giá tại thời điểm giao dịch, không nhận
 * amount từ client. `couponCode` là trường tuỳ chọn: mã coupon giảm
 * giá do quản trị platform tạo (xem `createCouponSchema`); khi có mã,
 * hệ thống kiểm tra coupon và trừ mức giảm vào giá cấu hình TRƯỚC khi
 * tạo khoản thu — client vẫn không gửi được bất kỳ con số nào. */
export const purchasePlanSchema = z.strictObject({
  component: planComponentSchema,
  couponCode: z.string().trim().min(1).max(64).optional(),
});
export type PurchasePlan = z.infer<typeof purchasePlanSchema>;

/** Loại giảm của coupon: theo phần trăm giá gói đang cấu hình
 * (`percent`) hoặc số tiền cố định theo đơn vị tiền nhỏ nhất
 * (`fixed`). */
export const couponDiscountTypeSchema = z.enum(['percent', 'fixed']);
export type CouponDiscountType = z.infer<typeof couponDiscountTypeSchema>;

/** Phạm vi gói mà coupon áp dụng được: một loại gói hoặc cả hai. */
export const couponAppliesToSchema = z.enum(['tenant_plan', 'teacher_plan', 'all']);
export type CouponAppliesTo = z.infer<typeof couponAppliesToSchema>;

/** Payload tạo coupon (bề mặt quản trị platform): mọi mức giảm là dữ
 * liệu do quản trị tạo qua payload này — không có mã hay mức giảm nào
 * ghim trong code. Ràng buộc hình dạng bám đặc tả coupon của issue
 * #189: phần trăm hợp lệ 1–99 (kiểm tra chéo theo `discountType` bằng
 * superRefine dưới đây); số tiền cố định là số nguyên dương; cửa sổ
 * hiệu lực và giới hạn lượt dùng cho phép vắng (không giới hạn phía
 * đó / không giới hạn lượt). Tầng service kiểm tra lại các ràng buộc
 * này trên trạng thái gộp cuối cùng khi cập nhật (payload cập nhật
 * cho phép thiếu trường). */
export const createCouponSchema = z.strictObject({
  code: z.string().trim().min(1).max(64),
  discountType: couponDiscountTypeSchema,
  discountValue: z.number().int().min(1).max(99_999_999),
  appliesTo: couponAppliesToSchema.default('all'),
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional(),
  isActive: z.boolean().default(true),
}).superRefine((input, ctx) => {
  if (input.discountType === 'percent' && input.discountValue > 99) {
    ctx.addIssue({
      code: 'custom',
      path: ['discountValue'],
      message: 'Percent discount value must be between 1 and 99',
    });
  }
  if (input.startsAt && input.endsAt && new Date(input.startsAt).getTime() >= new Date(input.endsAt).getTime()) {
    ctx.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'Coupon endsAt must be after startsAt',
    });
  }
});
export type CreateCoupon = z.infer<typeof createCouponSchema>;

/** Payload cập nhật coupon: mọi trường đều tuỳ chọn; ngừng sử dụng
 * coupon bằng cách đặt `isActive` thành false (không xoá cứng). Mã
 * coupon là định danh tra cứu khi áp dụng nên không sửa được qua
 * payload này. */
export const updateCouponSchema = z.strictObject({
  discountType: couponDiscountTypeSchema.optional(),
  discountValue: z.number().int().min(1).max(99_999_999).optional(),
  appliesTo: couponAppliesToSchema.optional(),
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCoupon = z.infer<typeof updateCouponSchema>;

/** Coupon ở dạng API trả về cho bề mặt quản trị: mã đã chuẩn hoá chữ
 * hoa; các mốc thời gian là chuỗi ISO; trường null nghĩa là không
 * giới hạn (cửa sổ hiệu lực / lượt dùng). */
export const couponSchema = z.object({
  id: uuidIdSchema,
  code: z.string(),
  discountType: couponDiscountTypeSchema,
  discountValue: z.number().int(),
  appliesTo: couponAppliesToSchema,
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  maxRedemptions: z.number().int().nullable(),
  isActive: z.boolean(),
  createdBy: uuidIdSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Coupon = z.infer<typeof couponSchema>;

/** Quyền lợi gói đã kích hoạt: cửa sổ hiệu lực [startsAt, expiresAt)
 * sinh từ một payment gói thành công; `userId` chỉ có ở `teacher_plan`
 * (gói trung tâm hưởng theo `tenantId`, userId = null). Hoàn đủ tiền
 * của payment sinh ra nó thì trạng thái chuyển `suspended`. */
export const planEntitlementSchema = z.object({
  id: uuidIdSchema,
  tenantId: uuidIdSchema,
  userId: uuidIdSchema.nullable(),
  component: planComponentSchema,
  paymentId: uuidIdSchema,
  startsAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(['active', 'suspended']),
  createdAt: z.string(),
});
export type PlanEntitlement = z.infer<typeof planEntitlementSchema>;

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
