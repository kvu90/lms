import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { UsersService } from '../users/users.service';
import { MessagingRepository, type ConversationRow, type MessageRow, type NotificationRow } from './messaging.repository';

export const NOTIFICATION_DISPATCH_QUEUE = 'notification-dispatch';

/** Delivery channels are PORTS. 'popup' (in-app) is the only real channel. */
export const MESSAGE_CHANNELS = ['popup', 'email', 'push'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];
export type LoginState = 'loggedin' | 'loggedoff';

export interface MessageProviderDefinition {
  name: string;
  component: string;
  channels: MessageChannel[];
}

/**
 * Message providers are registered IN CODE (like Moodle's db/messages.php).
 * Each provider produces NOTIFICATIONS (system messages) — never confused
 * with user-to-user messages, which live in conversations (report §2#12).
 */
export const MESSAGE_PROVIDERS: MessageProviderDefinition[] = [
  { name: 'grade_updated', component: 'core_grades', channels: ['popup', 'email'] },
  { name: 'badge_awarded', component: 'core_badges', channels: ['popup', 'email', 'push'] },
  { name: 'enrol_expiry_warning', component: 'core_enrol', channels: ['popup', 'email'] },
  { name: 'calendar_reminder', component: 'core_calendar', channels: ['popup', 'email'] },
  { name: 'competency_review_requested', component: 'core_competency', channels: ['popup', 'email'] },
  { name: 'course_completed', component: 'core_completion', channels: ['popup'] },
  { name: 'report_scheduled', component: 'core_reportbuilder', channels: ['popup', 'email'] },
];

export function providerByName(name: string): MessageProviderDefinition | undefined {
  return MESSAGE_PROVIDERS.find((p) => p.name === name);
}

/** Preference key stored in user_preferences: provider × channel × login state. */
export function preferenceName(provider: string, channel: MessageChannel, state: LoginState): string {
  return `message_provider_${provider}_${channel}_${state}`;
}

export interface NotifyResult {
  provider: string;
  userId: number;
  notificationId: number | null;
  channels: Record<string, string>;
  skipped?: 'suspended' | 'unknown-provider';
}

export interface NotificationChannelPort {
  channel: MessageChannel;
  /** Deliver for real or record the dispatch. Returns the log status. */
  /**
   * Phân phối một notification tới các kênh đã bật của người nhận và ghi dispatch log.
   */
  deliver(input: { userId: number; provider: string; subject: string; body: string; notificationId: number | null }): Promise<string>;
}

/**
 * MessagingModule facade (Moodle core_message):
 *  - CONVERSATIONS + MESSAGES are user-to-user. After sending, ownership of
 *    a message passes to core_message: NO endpoint edits or deletes it.
 *  - NOTIFICATIONS are system messages produced by registered providers and
 *    dispatched per (provider × channel × loggedin/loggedoff) preferences
 *    stored in user_preferences.
 *  - A suspended (or deleted) user RECEIVES nothing: no message delivery,
 *    no notification, on any channel. A user who blocked the sender does
 *    not receive their messages either.
 *  - Dispatch of external channels goes through the BullMQ
 *    'notification-dispatch' queue consumed by the worker; those channels
 *    are ports that only LOG the dispatch (no real email/push is sent).
 */
@Injectable()
/**
 * Nhắn tin và thông báo.
 * Đối chiếu Moodle: message/classes (api, output) và message providers.
 * Quy tắc: người bị chặn không gửi được tin; notification được tạo theo provider và phân phối theo
 * tuỳ chọn kênh của người nhận (logged-in/logged-off), mọi lần phân phối đều ghi dispatch log;
 * chuỗi hiển thị của notification do tầng tạo nội dung lấy từ catalog i18n.
 */
export class MessagingService {
  constructor(
    private readonly repo: MessagingRepository,
    private readonly users: UsersService,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly outbox: OutboxService,
    @InjectQueue(NOTIFICATION_DISPATCH_QUEUE) private readonly dispatchQueue: Queue,
  ) {}

  // --- preferences -----------------------------------------------------------

  /**
   * Kênh có đang bật cho provider này theo tuỳ chọn của user (phân biệt logged-in/logged-off) hay không.
   */
  async isChannelEnabled(userId: number, provider: string, channel: MessageChannel, state: LoginState): Promise<boolean> {
    const value = await this.users.getPreference(userId, preferenceName(provider, channel, state));
    return value !== '0'; // default: enabled (Moodle default for core providers)
  }

  /**
   * Tuỳ chọn notification của user theo provider/kênh.
   */
  async getPreferences(userId: number): Promise<{
    provider: string; component: string; channel: MessageChannel; state: LoginState; enabled: boolean;
  }[]> {
    const out: { provider: string; component: string; channel: MessageChannel; state: LoginState; enabled: boolean }[] = [];
    for (const provider of MESSAGE_PROVIDERS) {
      for (const channel of provider.channels) {
        for (const state of ['loggedin', 'loggedoff'] as LoginState[]) {
          out.push({
            provider: provider.name, component: provider.component, channel, state,
            enabled: await this.isChannelEnabled(userId, provider.name, channel, state),
          });
        }
      }
    }
    return out;
  }

  /**
   * Đặt tuỳ chọn một provider/kênh.
   */
  async setPreference(userId: number, input: { provider: string; channel: MessageChannel; state: LoginState; enabled: boolean }): Promise<{ provider: string; channel: MessageChannel; state: LoginState; enabled: boolean }> {
    const provider = providerByName(input.provider);
    if (!provider) throw new BadRequestException({ message: `Unknown message provider ${input.provider}`, code: 'messaging.unknown_provider' });
    if (!provider.channels.includes(input.channel)) {
      throw new BadRequestException({ message: `Provider ${input.provider} has no channel ${input.channel}`, code: 'messaging.unknown_channel' });
    }
    await this.users.setPreference(userId, preferenceName(input.provider, input.channel, input.state), input.enabled ? '1' : '0');
    return { ...input };
  }

  // --- notifications -----------------------------------------------------------

  /**
   * Produce a system notification for a user through a registered provider.
   * The recipient is treated as LOGGED IN for the in-app channel decision
   * when they have any live session semantics in the API flow; system-side
   * callers pass `loggedIn` explicitly (default true for direct API calls).
   * A preference set to disabled for the relevant state means the channel
   * is NOT dispatched — and that is asserted by the dispatch log.
   */
  /**
   * Tạo notification cho user từ một provider (điểm vào chuẩn của các module khác).
   */
  async notify(userId: number, providerName: string, input: {
    subject: string; body: string; contextUrl?: string; fromUserId?: number; loggedIn?: boolean;
  }): Promise<NotifyResult> {
    const provider = providerByName(providerName);
    if (!provider) return { provider: providerName, userId, notificationId: null, channels: {}, skipped: 'unknown-provider' };
    const recipient = await this.users.getByIdOrUndefined(userId);
    if (!recipient || recipient.suspended || recipient.deleted) {
      // Suspended users receive nothing (report §2#12). Nothing is stored.
      await this.repo.insertDispatchLog({
        userid: userId, provider: providerName, channel: 'popup', status: 'skipped-suspended',
        subject: input.subject, dedupekey: `skipped-suspended-${providerName}-${userId}-${randomUUID()}`,
      }).catch(() => undefined);
      return { provider: providerName, userId, notificationId: null, channels: {}, skipped: 'suspended' };
    }
    const state: LoginState = (input.loggedIn ?? true) ? 'loggedin' : 'loggedoff';
    const channels: Record<string, string> = {};
    let notificationId: number | null = null;

    // In-app (popup) is the only REAL channel: the notification row IS the delivery.
    if (provider.channels.includes('popup')) {
      if (await this.isChannelEnabled(userId, providerName, 'popup', state)) {
        const notification = await this.repo.insertNotification({
          useridfrom: input.fromUserId ?? null, useridto: userId,
          subject: input.subject, fullmessage: input.body, smallmessage: input.body.slice(0, 200),
          component: provider.component, eventtype: providerName,
          contexturl: input.contextUrl ?? null,
        });
        notificationId = notification.id;
        channels.popup = 'delivered';
        await this.repo.insertDispatchLog({
          notificationid: notification.id, userid: userId, provider: providerName, channel: 'popup',
          status: 'delivered', subject: input.subject,
          dedupekey: `popup-${notification.id}`,
        });
      } else {
        channels.popup = 'skipped-preference';
        await this.repo.insertDispatchLog({
          userid: userId, provider: providerName, channel: 'popup', status: 'skipped-preference',
          subject: input.subject, dedupekey: `popup-off-${providerName}-${userId}-${randomUUID()}`,
        });
      }
    }

    // External channels are ports: a BullMQ job carries the dispatch to the
    // worker, which only LOGS it. Disabled-by-preference ⇒ no job at all.
    for (const channel of provider.channels.filter((c) => c !== 'popup')) {
      if (await this.isChannelEnabled(userId, providerName, channel, state)) {
        const dedupekey = `dispatch-${providerName}-${userId}-${channel}-${notificationId ?? randomUUID()}`;
        await this.dispatchQueue.add('dispatch', {
          userId, provider: providerName, channel, subject: input.subject, body: input.body,
          notificationId, dedupekey,
        }, { jobId: dedupekey, attempts: 3 });
        channels[channel] = 'queued';
      } else {
        channels[channel] = 'skipped-preference';
        await this.repo.insertDispatchLog({
          userid: userId, provider: providerName, channel, status: 'skipped-preference',
          subject: input.subject, dedupekey: `${channel}-off-${providerName}-${userId}-${randomUUID()}`,
        });
      }
    }

    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'notification_created',
      payload: { userId, provider: providerName, notificationId },
    });
    return { provider: providerName, userId, notificationId, channels };
  }

  /** The /notifications/send endpoint is a system trigger: site admins only. */
  /**
   * Gửi notification hệ thống (vd hoàn tất báo cáo) kèm nội dung đã dịch.
   */
  async sendSystemNotification(actorId: number, dto: { userId: number; provider: string; subject: string; body: string; contextUrl?: string }): Promise<NotifyResult> {
    if (!(await this.evaluator.isSiteAdmin(actorId))) {
      throw new ForbiddenException({ message: 'Only site administrators can trigger system notifications directly', code: 'messaging.system_send_forbidden' });
    }
    return this.notify(dto.userId, dto.provider, { subject: dto.subject, body: dto.body, contextUrl: dto.contextUrl });
  }

  /**
   * Notification của user.
   */
  async listNotifications(userId: number): Promise<NotificationRow[]> {
    return this.repo.listNotifications(userId);
  }
  /**
   * Số notification chưa đọc.
   */
  async unreadNotificationCount(userId: number): Promise<number> {
    return this.repo.countUnreadNotifications(userId);
  }
  /**
   * Đánh dấu đã đọc.
   */
  async markNotificationRead(userId: number, notificationId: number): Promise<{ read: boolean }> {
    const ok = await this.repo.markNotificationRead(notificationId, userId);
    if (!ok) throw new NotFoundException({ message: `Notification ${notificationId} not found`, code: 'messaging.notification_not_found' });
    return { read: true };
  }
  /**
   * Đánh dấu tất cả đã đọc.
   */
  async markAllNotificationsRead(userId: number): Promise<{ marked: number }> {
    return { marked: await this.repo.markAllNotificationsRead(userId) };
  }
  /**
   * Nhật ký phân phối notification.
   */
  async listDispatchLog(userId: number) {
    return this.repo.listDispatchLog(userId);
  }

  // --- blocked contacts ---------------------------------------------------------

  /**
   * Chặn một liên hệ.
   */
  async blockContact(userId: number, blockedUserId: number): Promise<{ blocked: number[] }> {
    if (blockedUserId === userId) throw new BadRequestException({ message: 'You cannot block yourself', code: 'messaging.block_self' });
    await this.users.getUser(blockedUserId);
    await this.repo.block(userId, blockedUserId);
    return { blocked: await this.repo.listBlocked(userId) };
  }
  /**
   * Bỏ chặn liên hệ.
   */
  async unblockContact(userId: number, blockedUserId: number): Promise<{ blocked: number[] }> {
    await this.repo.unblock(userId, blockedUserId);
    return { blocked: await this.repo.listBlocked(userId) };
  }
  /**
   * Danh sách liên hệ bị chặn.
   */
  async listBlocked(userId: number): Promise<number[]> {
    return this.repo.listBlocked(userId);
  }
  /**
   * User có bị người kia chặn hay không.
   */
  async isBlockedBy(blockerId: number, senderId: number): Promise<boolean> {
    return this.repo.isBlocked(blockerId, senderId);
  }

  // --- conversations & messages ---------------------------------------------------

  /**
   * Tạo conversation (nhóm hoặc 1-1; 1-1 đã tồn tại thì dùng lại).
   */
  async createConversation(actorId: number, input: { type?: number; memberIds: number[]; name?: string }): Promise<ConversationRow & { members: number[] }> {
    const type = input.type ?? 1;
    const memberIds = [...new Set([actorId, ...input.memberIds])];
    if (type === 1) {
      if (memberIds.length !== 2) throw new BadRequestException({ message: 'An individual conversation has exactly 2 members', code: 'messaging.individual_members' });
      const other = memberIds.find((id) => id !== actorId)!;
      const existing = await this.repo.findIndividualConversation(actorId, other);
      if (existing) return { ...existing, members: await this.repo.listMembers(existing.id) };
    }
    if (type === 2 && memberIds.length < 2) {
      throw new BadRequestException({ message: 'A group conversation needs at least 2 members', code: 'messaging.group_members' });
    }
    for (const id of memberIds) await this.users.getUser(id);
    const conversation = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertConversation({ type, name: input.name ?? null }, tx as never);
      for (const id of memberIds) await this.repo.addMember(created.id, id, tx as never);
      return created;
    });
    return { ...conversation, members: memberIds };
  }

  /**
   * Conversation của user kèm số chưa đọc.
   */
  async listConversations(userId: number): Promise<(ConversationRow & { members: number[]; unread: number })[]> {
    const conversations = await this.repo.listConversationsForUser(userId);
    const out: (ConversationRow & { members: number[]; unread: number })[] = [];
    for (const c of conversations) {
      const messages = await this.repo.listMessages(c.id);
      out.push({
        ...c,
        members: await this.repo.listMembers(c.id),
        unread: messages.filter((m) => m.useridfrom !== userId && !m.timeread).length,
      });
    }
    return out;
  }

  /**
   * Chi tiết conversation + tin nhắn (chỉ thành viên mới xem được).
   */
  async getConversation(userId: number, conversationId: number): Promise<ConversationRow & { members: number[]; messages: MessageRow[] }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    if (!(await this.repo.isMember(conversationId, userId))) {
      throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
    }
    return { ...conversation, members: await this.repo.listMembers(conversationId), messages: await this.repo.listMessages(conversationId) };
  }

  /**
   * Send a user-to-user message. Delivery law (report §2#12): every other
   * member must be contactable — not suspended, and must not have blocked
   * the sender. Once stored, the message is immutable through the API.
   */
  /**
   * Gửi tin nhắn: kiểm tra thành viên và quan hệ chặn.
   */
  async sendMessage(actorId: number, conversationId: number, input: { text: string; subject?: string }): Promise<MessageRow> {
    const systemCtx = await this.contexts.ensureSystemContext();
    const senderCtx = await this.contexts.getByLevelInstance(30, actorId);
    await this.evaluator.requireCapability(actorId, 'moodle/site:sendmessage', senderCtx?.id ?? systemCtx.id);
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    if (!(await this.repo.isMember(conversationId, actorId))) {
      throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
    }
    const members = await this.repo.listMembers(conversationId);
    for (const memberId of members) {
      if (memberId === actorId) continue;
      const recipient = await this.users.getByIdOrUndefined(memberId);
      if (!recipient || recipient.suspended || recipient.deleted) {
        throw new ForbiddenException({ message: `User ${memberId} cannot receive messages (suspended)`, code: 'messaging.recipient_suspended' });
      }
      if (await this.repo.isBlocked(memberId, actorId)) {
        throw new ForbiddenException({ message: `User ${memberId} has blocked you`, code: 'messaging.contact_blocked' });
      }
    }
    const saved = await this.repo.dbHandle.transaction(async (tx) => {
      const msg = await this.repo.insertMessage({
        conversationid: conversationId, useridfrom: actorId,
        subject: input.subject ?? '', fullmessage: input.text, smallmessage: input.text.slice(0, 200),
      }, tx as never);
      await this.repo.touchConversation(conversationId, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'messaging', type: 'message_sent',
        payload: { conversationId, messageId: msg.id, fromUserId: actorId, memberIds: members },
      });
      return msg;
    });
    return saved;
  }

  /** Messages are owned by core_message after sending: edits are refused, always. */
  /**
   * Sửa tin nhắn của chính mình.
   */
  async updateMessage(): Promise<never> {
    throw new ForbiddenException({
      message: 'A sent message cannot be modified: ownership passed to core_message when it was sent',
      code: 'messaging.message_immutable',
    });
  }
  /**
   * Xoá tin nhắn của chính mình.
   */
  async deleteMessage(): Promise<never> {
    throw new ForbiddenException({
      message: 'A sent message cannot be deleted by its sender: ownership passed to core_message when it was sent',
      code: 'messaging.message_immutable',
    });
  }

  /**
   * Đánh dấu đã đọc conversation.
   */
  async markConversationRead(userId: number, conversationId: number): Promise<{ marked: number }> {
    if (!(await this.repo.isMember(conversationId, userId))) {
      throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
    }
    return { marked: await this.repo.markConversationRead(conversationId, userId) };
  }

  /**
   * Số conversation chưa đọc và số notification chưa đọc (cho huy hiệu trên giao diện).
   */
  async unreadCounts(userId: number): Promise<{ conversations: number; notifications: number }> {
    return {
      conversations: await this.repo.countUnreadConversations(userId),
      notifications: await this.repo.countUnreadNotifications(userId),
    };
  }
}
