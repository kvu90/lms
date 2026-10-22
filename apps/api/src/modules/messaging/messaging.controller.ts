import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { MessagingService } from './messaging.service';
import { createConversationSchema, notifyUserSchema, sendMessageSchema, setMessagePreferenceSchema, type CreateConversationDto, type NotifyDto, type SendMessageDto, type SetPreferenceDto } from './dto/messaging.dto';

@ApiTags('messaging')
@Controller({ path: 'messages', version: '1' })
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Post('conversations')
  async createConversation(@Body({ schema: createConversationSchema }) dto: CreateConversationDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.createConversation(actor.id, dto);
  }
  @Get('conversations')
  async listConversations(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listConversations(actor.id);
  }
  @Get('conversations/:id')
  async getConversation(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.getConversation(actor.id, id);
  }
  @Post('conversations/:id/messages')
  async send(@Param('id', ParseIntPipe) id: number, @Body({ schema: sendMessageSchema }) dto: SendMessageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.sendMessage(actor.id, id, dto);
  }
  @Post('conversations/:id/read')
  async markRead(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.markConversationRead(actor.id, id);
  }
  /** Sent messages are immutable: both verbs exist only to refuse (report §2#12). */
  @Patch('messages/:id')
  async updateMessage() { return this.messaging.updateMessage(); }
  @Delete('messages/:id')
  async deleteMessage() { return this.messaging.deleteMessage(); }

  @Get('unread-count')
  async unread(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.unreadCounts(actor.id);
  }
  @Get('preferences')
  async preferences(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.getPreferences(actor.id);
  }
  @Put('preferences')
  async setPreference(@Body({ schema: setMessagePreferenceSchema }) dto: SetPreferenceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.setPreference(actor.id, dto);
  }
  @Get('contacts/blocked')
  async blocked(@CurrentUser() actor: AuthenticatedUser) {
    return { blocked: await this.messaging.listBlocked(actor.id) };
  }
  @Post('contacts/:userId/block')
  async block(@Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.blockContact(actor.id, userId);
  }
  @Delete('contacts/:userId/block')
  async unblock(@Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.unblockContact(actor.id, userId);
  }
}

@ApiTags('notifications')
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  async list(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.listNotifications(actor.id);
  }
  @Get('unread-count')
  async unread(@CurrentUser() actor: AuthenticatedUser) {
    return { unread: await this.messaging.unreadNotificationCount(actor.id) };
  }
  @Get('dispatch-log')
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
  async readAll(@CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.markAllNotificationsRead(actor.id);
  }
  @Post(':id/read')
  async read(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.messaging.markNotificationRead(actor.id, id);
  }
}
