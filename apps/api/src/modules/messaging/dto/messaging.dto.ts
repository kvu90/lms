import { z } from 'zod';
import {
  createConversationSchema,
  createGroupConversationSchema,
  listMessagesQuerySchema,
  notifyUserSchema,
  reportConversationSchema,
  sendMessageSchema,
  setMessagePreferenceSchema,
  updateConversationSchema,
  updateReportStatusSchema,
  type CreateConversation,
  type CreateGroupConversation,
  type NotifyUser,
  type ReportConversation,
  type SendMessage,
  type SetMessagePreference,
  type UpdateConversation,
  type UpdateReportStatus,
} from '@lms/contracts';

/**
 * Validation của Messaging dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { createConversationSchema, createGroupConversationSchema, notifyUserSchema, reportConversationSchema, sendMessageSchema, setMessagePreferenceSchema, updateConversationSchema, updateReportStatusSchema };
export type CreateConversationDto = CreateConversation;
export type CreateGroupConversationDto = CreateGroupConversation;
export type SendMessageDto = SendMessage;
export type SetPreferenceDto = SetMessagePreference;
export type NotifyDto = NotifyUser;
export type UpdateConversationDto = UpdateConversation;
export type ReportConversationDto = ReportConversation;
export type UpdateReportStatusDto = UpdateReportStatus;

/**
 * Schema phía server cho query phân trang tin nhắn — EXTEND từ schema
 * nền ở contracts: giá trị đến từ query string (chuỗi) nên ép kiểu bằng
 * `z.coerce.number` ở tầng server. Chỉ dùng kiểu số nguyên — biểu diễn
 * được trong JSON Schema (bài học sự cố PR #28: không `z.date()`/
 * `z.coerce.date()` trong schema route).
 */
export const listMessagesQueryServerSchema = listMessagesQuerySchema.extend({
  beforeSeq: z.coerce.number().int().positive().optional(),
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListMessagesQueryDto = z.infer<typeof listMessagesQueryServerSchema>;
