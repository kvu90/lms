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
