import { z } from 'zod';
import {
  bulkRemoveMessagesSchema,
  createConversationSchema,
  createGroupConversationSchema,
  hardDeleteMessageSchema,
  listCourseRosterQuerySchema,
  listMessagesQuerySchema,
  listNotificationGroupsQuerySchema,
  listNotificationItemsQuerySchema,
  notifyUserSchema,
  readNotificationGroupSchema,
  reportConversationSchema,
  searchMessagesQuerySchema,
  sendMessageSchema,
  setNotificationCourseOverrideSchema,
  setNotificationPreferenceSchema,
  updateConversationSchema,
  updateReportStatusSchema,
  type BulkRemoveMessages,
  type CreateConversation,
  type CreateGroupConversation,
  type HardDeleteMessage,
  type ListCourseRosterQuery,
  type NotifyUser,
  type ReadNotificationGroup,
  type ReportConversation,
  type SendMessage,
  type SetNotificationCourseOverride,
  type SetNotificationPreference,
  type UpdateConversation,
  type UpdateReportStatus,
} from '@lms/contracts';

/**
 * Validation của Messaging dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { bulkRemoveMessagesSchema, createConversationSchema, createGroupConversationSchema, hardDeleteMessageSchema, notifyUserSchema, readNotificationGroupSchema, reportConversationSchema, searchMessagesQuerySchema, sendMessageSchema, setNotificationCourseOverrideSchema, setNotificationPreferenceSchema, updateConversationSchema, updateReportStatusSchema };
export type CreateConversationDto = CreateConversation;
export type CreateGroupConversationDto = CreateGroupConversation;
export type SendMessageDto = SendMessage;
export type SetPreferenceDto = SetNotificationPreference;
export type SetCourseOverrideDto = SetNotificationCourseOverride;
export type NotifyDto = NotifyUser;
export type UpdateConversationDto = UpdateConversation;
export type ReportConversationDto = ReportConversation;
export type UpdateReportStatusDto = UpdateReportStatus;
export type HardDeleteMessageDto = HardDeleteMessage;
export type BulkRemoveMessagesDto = BulkRemoveMessages;

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

/**
 * Schema phía server cho query tìm tin trong conversation (lát M4):
 * `limit` ép kiểu từ query string như các schema server khác; `q`
 * giữ nguyên chuỗi — tầng service cắt khoảng trắng và từ chối truy
 * vấn rỗng bằng 400 xác định (schema chỉ chặn chuỗi rỗng hẳn).
 */
export const searchMessagesQueryServerSchema = searchMessagesQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type SearchMessagesQueryDto = z.infer<typeof searchMessagesQueryServerSchema>;

/**
 * Schema phía server cho query phân trang roster thành viên khoá —
 * cùng kỷ luật ép kiểu từ query string như phân trang tin nhắn ở trên:
 * `limit` ép sang số (mặc định và trần 100 chốt ở tầng service theo
 * contracts), `cursor` là chuỗi mờ do server phát hành, giữ nguyên.
 */
export const listCourseRosterQueryServerSchema = listCourseRosterQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
});
export type ListCourseRosterQueryDto = ListCourseRosterQuery;

/**
 * Cờ boolean trên query string: chỉ đúng chuỗi 'true' mới là true
 * (`z.coerce.boolean` biến 'false' thành true nên không dùng được).
 */
const queryBooleanSchema = z.string().optional().transform((v) => v === 'true');

/**
 * Schema phía server cho query trung tâm thông báo v2 (issue #51):
 * `limit` đến từ query string nên ép kiểu ở tầng server như tiền lệ
 * listMessages; `cursor` giữ nguyên là chuỗi mờ.
 */
export const listNotificationGroupsQueryServerSchema = listNotificationGroupsQuerySchema.extend({
  unreadOnly: queryBooleanSchema,
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type ListNotificationGroupsQueryDto = z.infer<typeof listNotificationGroupsQueryServerSchema>;

export const listNotificationItemsQueryServerSchema = listNotificationItemsQuerySchema.extend({
  unreadOnly: queryBooleanSchema,
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListNotificationItemsQueryDto = z.infer<typeof listNotificationItemsQueryServerSchema>;

export type ReadNotificationGroupDto = ReadNotificationGroup;
