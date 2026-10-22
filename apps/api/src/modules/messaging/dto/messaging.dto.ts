import {
  createConversationSchema,
  createGroupConversationSchema,
  notifyUserSchema,
  sendMessageSchema,
  setMessagePreferenceSchema,
  type CreateConversation,
  type CreateGroupConversation,
  type NotifyUser,
  type SendMessage,
  type SetMessagePreference,
} from '@lms/contracts';

/**
 * Validation của Messaging dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { createConversationSchema, createGroupConversationSchema, notifyUserSchema, sendMessageSchema, setMessagePreferenceSchema };
export type CreateConversationDto = CreateConversation;
export type CreateGroupConversationDto = CreateGroupConversation;
export type SendMessageDto = SendMessage;
export type SetPreferenceDto = SetMessagePreference;
export type NotifyDto = NotifyUser;
