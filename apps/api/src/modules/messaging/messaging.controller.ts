import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { MessagingService } from './messaging.service';
import { createConversationSchema, notifyUserSchema, sendMessageSchema, setMessagePreferenceSchema, type CreateConversationDto, type NotifyDto, type SendMessageDto, type SetPreferenceDto } from './dto/messaging.dto';

@ApiTags('messaging')
@Controller({ path: 'messages', version: '1' })
/**
 * API nhắn tin: conversation, tin nhắn, chặn liên hệ.
 */
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Post('conversations')
  /**
   * POST /messages/conversations — tạo conversation.
   */
  async createConversation(@Body({ schema: createConversationSchema }) dto: CreateConversationDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.createConversation(actor.id, dto);
  }
  @Get('conversations')
  /**
   * GET /messages/conversations — conversation của tôi.
   */
  async listConversations(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listConversations(actor.id);
  }
  @Get('conversations/:id')
  /**
   * GET /messages/conversations/:id — chi tiết + tin nhắn.
   */
  async getConversation(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.getConversation(actor.id, id);
  }
  @Post('conversations/:id/messages')
  /**
   * POST /messages/conversations/:id/messages — gửi tin nhắn (handler send của NotificationsController là POST /notifications/send).
   */
  async send(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: sendMessageSchema }) dto: SendMessageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.sendMessage(actor.id, id, dto);
  }
  @Post('conversations/:id/read')
  /**
   * POST /messages/conversations/:id/read — đánh dấu đã đọc.
   */
  async markRead(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.markConversationRead(actor.id, id);
  }
  /** Sent messages are immutable: both verbs exist only to refuse (report §2#12). */
  @Patch('messages/:id')
  /**
   * PATCH /messages/messages/:id — sửa tin nhắn.
   */
  async updateMessage() { return this.messaging.updateMessage(); }
  @Delete('messages/:id')
  /**
   * DELETE /messages/messages/:id — xoá tin nhắn.
   */
  async deleteMessage() { return this.messaging.deleteMessage(); }

  @Get('unread-count')
  /**
   * GET /messages/unread-count (và /notifications/unread-count) — số chưa đọc.
   */
  async unread(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.unreadCounts(actor.id);
  }
  @Get('preferences')
  /**
   * GET /messages/preferences — tuỳ chọn kênh của tôi.
   */
  async preferences(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.getPreferences(actor.id);
  }
  @Put('preferences')
  /**
   * PUT /messages/preferences — đặt tuỳ chọn kênh.
   */
  async setPreference(@Body({ schema: setMessagePreferenceSchema }) dto: SetPreferenceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.setPreference(actor.id, dto);
  }
  @Get('contacts/blocked')
  /**
   * GET /messages/contacts/blocked — liên hệ bị chặn.
   */
  async blocked(@CurrentUser() actor: AuthenticatedUser) {
    return { blocked: await this.messaging.listBlocked(actor.id) };
  }
  @Post('contacts/:userId/block')
  /**
   * POST /messages/contacts/:userId/block — chặn liên hệ.
   */
  async block(@Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.blockContact(actor.id, userId);
  }
  @Delete('contacts/:userId/block')
  /**
   * DELETE /messages/contacts/:userId/block — bỏ chặn.
   */
  async unblock(@Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.unblockContact(actor.id, userId);
  }
}

@ApiTags('notifications')
@Controller({ path: 'notifications', version: '1' })
/**
 * API thông báo: danh sách, chưa đọc, tuỳ chọn kênh và gửi (nội bộ).
 */
export class NotificationsController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  /**
   * GET /notifications — danh sách thông báo.
   */
  async list(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listNotifications(actor.id);
  }
  @Get('unread-count')
  async unread(@CurrentUser() actor: AuthenticatedUser) {
    return { unread: await this.messaging.unreadNotificationCount(actor.id) };
  }
  @Get('dispatch-log')
  /**
   * GET /notifications/dispatch-log — nhật ký phân phối.
   */
  async dispatchLog(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listDispatchLog(actor.id);
  }
  @Post('send')
  async send(@Body({ schema: notifyUserSchema }) dto: NotifyDto, @CurrentUser() actor: AuthenticatedUser) {
    // System-trigger endpoint (used by other subsystems/tests): site admins
    // only; delivery law lives in MessagingService.notify.
    return this.messaging.sendSystemNotification(actor.id, dto);
  }
  @Post('read-all')
  /**
   * POST /notifications/read-all — đánh dấu tất cả đã đọc.
   */
  async readAll(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.markAllNotificationsRead(actor.id);
  }
  @Post(':id/read')
  /**
   * POST /notifications/:id/read — đánh dấu một thông báo đã đọc.
   */
  async read(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.markNotificationRead(actor.id, id);
  }
}
