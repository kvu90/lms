import { z } from 'zod';

/** Platform Services contracts — shapes shared between api and web. */

/* ---- Search ---- */
export const searchDocumentSchema = z.object({
  id: z.number().int(),
  area: z.enum(['courses', 'users', 'contentbank', 'blog']),
  itemid: z.number().int(),
  contextid: z.number().int(),
  title: z.string(),
  content: z.string(),
});
export type SearchDocument = z.infer<typeof searchDocumentSchema>;

/* ---- Web Services ---- */
export const externalServiceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  shortname: z.string(),
  enabled: z.boolean(),
  functions: z.array(z.string()),
});
export type ExternalService = z.infer<typeof externalServiceSchema>;

export const externalTokenCreatedSchema = z.object({
  /** Token thô chỉ xuất hiện đúng một lần trong response tạo token. */
  token: z.string().length(64),
  id: z.number().int(),
  userid: z.number().int(),
  serviceid: z.number().int(),
});
export type ExternalTokenCreated = z.infer<typeof externalTokenCreatedSchema>;

/* ---- Backup ---- */
export const BACKUP_FORMAT_VERSION = 1;
export const backupJobSchema = z.object({
  id: z.number().int(),
  type: z.enum(['backup', 'restore']),
  courseid: z.number().int(),
  targetcourseid: z.number().int().nullable(),
  mode: z.enum(['new', 'merge', 'replace']),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  anonymize: z.boolean(),
});
export type BackupJob = z.infer<typeof backupJobSchema>;

export const backupIdMappingSchema = z.object({
  id: z.number().int(),
  jobid: z.number().int(),
  itemtype: z.string(),
  oldid: z.number().int(),
  newid: z.number().int(),
}).refine((m) => m.newid !== m.oldid, { message: 'restore must remap ids, never keep the original id' });
export type BackupIdMapping = z.infer<typeof backupIdMappingSchema>;

/* ---- Analytics ---- */
export const insightSchema = z.object({
  id: z.number().int(),
  modelid: z.number().int(),
  userid: z.number().int(),
  recipientid: z.number().int(),
  contextid: z.number().int(),
  courseid: z.number().int(),
  heading: z.string(),
});
export type Insight = z.infer<typeof insightSchema>;

/* ---- Reports ---- */
export const REPORT_DATASOURCES = ['enrolments', 'grades', 'completion'] as const;
export const reportSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  datasource: z.enum(REPORT_DATASOURCES),
  columns: z.array(z.string()),
  createdby: z.number().int(),
});
export type Report = z.infer<typeof reportSchema>;

/* ---- Content Bank ---- */
export const contentBankContentSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  contenttype: z.string(),
  contextid: z.number().int(),
  creatorid: z.number().int(),
  visibility: z.enum(['draft', 'public']),
  fileid: z.number().int().nullable(),
});
export type ContentBankContent = z.infer<typeof contentBankContentSchema>;

/* ---- Payments ---- */
export const paymentSchema = z.object({
  id: z.number().int(),
  accountid: z.number().int(),
  userid: z.number().int(),
  /** Số tiền nguyên ở đơn vị nhỏ nhất — không bao giờ là float. */
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']),
  gateway: z.string(),
});
export type Payment = z.infer<typeof paymentSchema>;

/* ---- Privacy ---- */
export const privacyRequestSchema = z.object({
  id: z.number().int(),
  userid: z.number().int(),
  type: z.enum(['export', 'delete']),
  status: z.enum(['pending', 'approved', 'rejected', 'completed', 'failed']),
});
export type PrivacyRequest = z.infer<typeof privacyRequestSchema>;

/* ---- Request payload schemas (Zod — nguồn sự thật duy nhất cho validation ở
 * API qua Standard Schema và cho form phía React; xem ADR về Zod-only) ---- */

/** Payload lập chỉ mục một item của một search area đã đăng ký. */
export const searchIndexItemSchema = z.strictObject({
  area: z.string().min(1),
  itemid: z.number().int(),
});
export type SearchIndexItem = z.infer<typeof searchIndexItemSchema>;

/** Payload tạo external service. */
export const createExternalServiceSchema = z.strictObject({
  name: z.string().min(1),
  shortname: z.string().min(1),
  enabled: z.boolean().optional(),
  functions: z.array(z.string()).optional(),
});
export type CreateExternalService = z.infer<typeof createExternalServiceSchema>;

/** Payload bật/tắt external service. */
export const setExternalServiceEnabledSchema = z.strictObject({ enabled: z.boolean() });
export type SetExternalServiceEnabled = z.infer<typeof setExternalServiceEnabledSchema>;

/** Payload tạo external token cho một user trong một service. */
export const createExternalTokenSchema = z.strictObject({
  userid: z.number().int(),
  serviceid: z.number().int(),
  validuntil: z.string().optional(),
  iprestriction: z.string().optional(),
});
export type CreateExternalToken = z.infer<typeof createExternalTokenSchema>;

/** Payload gọi một external function qua envelope thống nhất. */
export const callExternalFunctionSchema = z.strictObject({
  token: z.string().min(1),
  functionName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type CallExternalFunction = z.infer<typeof callExternalFunctionSchema>;

/** Payload tạo backup job cho một khoá. */
export const createBackupSchema = z.strictObject({
  courseId: z.number().int(),
  anonymize: z.boolean().optional(),
});
export type CreateBackup = z.infer<typeof createBackupSchema>;

/** Payload restore: ba chế độ tường minh, target bắt buộc với merge/replace ở tầng service. */
export const restoreCourseSchema = z.strictObject({
  backupJobId: z.number().int(),
  mode: z.enum(['new', 'merge', 'replace']),
  targetCourseId: z.number().int().optional(),
});
export type RestoreCourse = z.infer<typeof restoreCourseSchema>;

/** Payload chạy một model phân tích cho một khoá. */
export const runAnalyticsModelSchema = z.strictObject({ courseId: z.number().int() });
export type RunAnalyticsModel = z.infer<typeof runAnalyticsModelSchema>;

/** Payload tạo báo cáo: datasource là entity đã đăng ký, columns/filters là cấu hình (không nới quyền). */
export const createReportSchema = z.strictObject({
  name: z.string().min(1),
  datasource: z.enum(['enrolments', 'grades', 'completion']),
  columns: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  audienceUserIds: z.array(z.number().int()).optional(),
  audienceRoles: z.array(z.string()).optional(),
});
export type CreateReport = z.infer<typeof createReportSchema>;

/** Payload đặt lịch chạy báo cáo. */
export const createReportScheduleSchema = z.strictObject({ cron: z.string().optional() });
export type CreateReportSchedule = z.infer<typeof createReportScheduleSchema>;

/** Payload tạo nội dung Content Bank (loại nội dung là extension point, mặc định file-based). */
export const createContentBankContentSchema = z.strictObject({
  name: z.string().min(1),
  contextid: z.number().int(),
  contenttype: z.string().optional(),
  visibility: z.enum(['draft', 'public']).optional(),
  fileid: z.number().int().optional(),
});
export type CreateContentBankContent = z.infer<typeof createContentBankContentSchema>;

/** Payload sửa nội dung Content Bank. */
export const updateContentBankContentSchema = createContentBankContentSchema
  .omit({ contextid: true })
  .partial()
  .extend({ fileid: z.number().int().optional() });
export type UpdateContentBankContent = z.infer<typeof updateContentBankContentSchema>;

/** Payload upload file cho một nội dung (nội dung file dạng base64 qua JSON để giữ envelope thống nhất). */
export const uploadContentBankFileSchema = z.strictObject({
  filename: z.string().min(1),
  contentBase64: z.string(),
  mimetype: z.string().optional(),
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
  accountid: z.number().int(),
  amount: z.number().int().min(1),
  currency: z.string().min(3),
  component: z.string().optional(),
  itemid: z.number().int().optional(),
});
export type CreatePayment = z.infer<typeof createPaymentSchema>;

/** Payload webhook từ gateway: xử lý idempotent theo externalTransactionId. */
export const paymentWebhookSchema = z.strictObject({
  gateway: z.string().min(1),
  externalTransactionId: z.string().min(1),
  paymentId: z.number().int(),
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
  contextid: z.number().int(),
  component: z.string(),
  filearea: z.string(),
  itemid: z.number().int().optional(),
  filepath: z.string().optional(),
});
export type UploadFileMeta = z.infer<typeof uploadFileMetaSchema>;
