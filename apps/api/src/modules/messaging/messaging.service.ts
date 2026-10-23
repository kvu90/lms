import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type MessageEvent } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Observable } from 'rxjs';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { UsersService } from '../users/users.service';
import { MessagingRepository, type ConversationRow, type MessageRow, type NotificationRow } from './messaging.repository';
import { NotificationUnreadStreamService } from './notification-unread-stream.service';

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
  { name: 'enrol_welcome', component: 'core_enrol', channels: ['popup', 'email'] },
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
  userId: string;
  notificationId: string | null;
  channels: Record<string, string>;
  skipped?: 'suspended' | 'unknown-provider';
}

/** Lỗi vi phạm ràng buộc duy nhất của Postgres (kể cả khi drizzle bọc lỗi gốc trong `cause`). */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface NotificationChannelPort {
  channel: MessageChannel;
  /** Deliver for real or record the dispatch. Returns the log status. */
  /**
   * Phân phối một notification tới các kênh đã bật của người nhận và ghi dispatch log.
   */
  deliver(input: { userId: string; provider: string; subject: string; body: string; notificationId: string | null }): Promise<string>;
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
 * Cổng liên lạc: khi setting `core/messagingallusers` tắt, chỉ contact (theo hướng người nhận
 * đã thêm người gửi) hoặc bạn cùng khoá đang ghi danh mới mở được liên lạc 1-1 — notification
 * hệ thống không qua cổng này. Conversation gắn course group (component core_group) đồng bộ
 * thành viên theo group mỗi lần liệt kê/mở/gửi (đồng bộ lười phía messaging).
 */
export class MessagingService {
  constructor(
    private readonly repo: MessagingRepository,
    private readonly users: UsersService,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly outbox: OutboxService,
    private readonly siteConfig: SiteConfigService,
    private readonly unreadStream: NotificationUnreadStreamService,
    @InjectQueue(NOTIFICATION_DISPATCH_QUEUE) private readonly dispatchQueue: Queue,
  ) {}

  // --- preferences -----------------------------------------------------------

  /**
   * Kênh có đang bật cho provider này theo tuỳ chọn của user (phân biệt logged-in/logged-off) hay không.
   */
  async isChannelEnabled(userId: string, provider: string, channel: MessageChannel, state: LoginState): Promise<boolean> {
    const value = await this.users.getPreference(userId, preferenceName(provider, channel, state));
    return value !== '0'; // default: enabled (Moodle default for core providers)
  }

  /**
   * Tuỳ chọn notification của user theo provider/kênh.
   */
  async getPreferences(userId: string): Promise<{
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
  async setPreference(userId: string, input: { provider: string; channel: MessageChannel; state: LoginState; enabled: boolean }): Promise<{ provider: string; channel: MessageChannel; state: LoginState; enabled: boolean }> {
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
  async notify(userId: string, providerName: string, input: {
    subject: string; body: string; contextUrl?: string; fromUserId?: string; loggedIn?: boolean;
  }): Promise<NotifyResult> {
    const provider = providerByName(providerName);
    if (!provider) return { provider: providerName, userId, notificationId: null, channels: {}, skipped: 'unknown-provider' };
    const recipient = await this.users.getByIdOrUndefined(userId);
    if (!recipient || recipient.suspended || recipient.deleted) {
      // Suspended users receive nothing (report §2#12). Nothing is stored.
      await this.repo.insertDispatchLog({
        userId: userId, provider: providerName, channel: 'popup', status: 'skipped-suspended',
        subject: input.subject, dedupeKey: `skipped-suspended-${providerName}-${userId}-${randomUUID()}`,
      }).catch(() => undefined);
      return { provider: providerName, userId, notificationId: null, channels: {}, skipped: 'suspended' };
    }
    const state: LoginState = (input.loggedIn ?? true) ? 'loggedin' : 'loggedoff';
    const channels: Record<string, string> = {};
    let notificationId: string | null = null;

    // In-app (popup) is the only REAL channel: the notification row IS the delivery.
    if (provider.channels.includes('popup')) {
      if (await this.isChannelEnabled(userId, providerName, 'popup', state)) {
        const notification = await this.repo.insertNotification({
          userIdFrom: input.fromUserId ?? null, userIdTo: userId,
          subject: input.subject, fullMessage: input.body, smallMessage: input.body.slice(0, 200),
          component: provider.component, eventType: providerName,
          contextUrl: input.contextUrl ?? null,
        });
        notificationId = notification.id;
        channels.popup = 'delivered';
        await this.repo.insertDispatchLog({
          notificationId: notification.id, userId: userId, provider: providerName, channel: 'popup',
          status: 'delivered', subject: input.subject,
          dedupeKey: `popup-${notification.id}`,
        });
      } else {
        channels.popup = 'skipped-preference';
        await this.repo.insertDispatchLog({
          userId: userId, provider: providerName, channel: 'popup', status: 'skipped-preference',
          subject: input.subject, dedupeKey: `popup-off-${providerName}-${userId}-${randomUUID()}`,
        });
      }
    }

    // Số chưa đọc vừa tăng: báo cho các stream SSE đang mở của người
    // nhận (qua Redis pub/sub) để huy hiệu cập nhật ngay, không polling.
    if (notificationId) {
      await this.unreadStream.signalUnreadCountChanged(userId);
    }

    // External channels are ports: a BullMQ job carries the dispatch to the
    // worker, which only LOGS it. Disabled-by-preference ⇒ no job at all.
    for (const channel of provider.channels.filter((c) => c !== 'popup')) {
      if (await this.isChannelEnabled(userId, providerName, channel, state)) {
        const dedupeKey = `dispatch-${providerName}-${userId}-${channel}-${notificationId ?? randomUUID()}`;
        await this.dispatchQueue.add('dispatch', {
          userId, provider: providerName, channel, subject: input.subject, body: input.body,
          notificationId, dedupeKey,
        }, { jobId: dedupeKey, attempts: 3 });
        channels[channel] = 'queued';
      } else {
        channels[channel] = 'skipped-preference';
        await this.repo.insertDispatchLog({
          userId: userId, provider: providerName, channel, status: 'skipped-preference',
          subject: input.subject, dedupeKey: `${channel}-off-${providerName}-${userId}-${randomUUID()}`,
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
  async sendSystemNotification(actorId: string, dto: { userId: string; provider: string; subject: string; body: string; contextUrl?: string }): Promise<NotifyResult> {
    if (!(await this.evaluator.isSiteAdmin(actorId))) {
      throw new ForbiddenException({ message: 'Only site administrators can trigger system notifications directly', code: 'messaging.system_send_forbidden' });
    }
    return this.notify(dto.userId, dto.provider, { subject: dto.subject, body: dto.body, contextUrl: dto.contextUrl });
  }

  /**
   * Notification của user.
   */
  async listNotifications(userId: string): Promise<NotificationRow[]> {
    return this.repo.listNotifications(userId);
  }
  /**
   * Số notification chưa đọc.
   */
  async unreadNotificationCount(userId: string): Promise<number> {
    return this.repo.countUnreadNotifications(userId);
  }
  /**
   * Đánh dấu đã đọc.
   */
  async markNotificationRead(userId: string, notificationId: string): Promise<{ read: boolean }> {
    const ok = await this.repo.markNotificationRead(notificationId, userId);
    if (!ok) throw new NotFoundException({ message: `Notification ${notificationId} not found`, code: 'messaging.notification_not_found' });
    await this.unreadStream.signalUnreadCountChanged(userId);
    return { read: true };
  }
  /**
   * Đánh dấu tất cả đã đọc.
   */
  async markAllNotificationsRead(userId: string): Promise<{ marked: number }> {
    const marked = await this.repo.markAllNotificationsRead(userId);
    if (marked > 0) await this.unreadStream.signalUnreadCountChanged(userId);
    return { marked };
  }
  /**
   * Stream SSE số thông báo chưa đọc của chính user: snapshot số hiện
   * tại ngay khi nối, rồi đẩy mỗi thay đổi (xem NotificationUnreadStreamService).
   */
  unreadCountStream(userId: string): Observable<MessageEvent> {
    return this.unreadStream.streamUnreadCount(userId);
  }
  /**
   * Nhật ký phân phối notification.
   */
  async listDispatchLog(userId: string) {
    return this.repo.listDispatchLog(userId);
  }

  // --- contacts -------------------------------------------------------------

  /**
   * Thêm một user vào danh bạ của tôi. Không tự thêm chính mình; user đích
   * không tồn tại thì 404 như các flow liên hệ hiện hữu.
   */
  async addContact(userId: string, contactId: string): Promise<{ contacts: string[] }> {
    if (contactId === userId) throw new BadRequestException({ message: 'You cannot add yourself as a contact', code: 'messaging.contact_self' });
    await this.users.getUser(contactId);
    await this.repo.addContact(userId, contactId);
    return { contacts: await this.repo.listContacts(userId) };
  }
  /**
   * Gỡ một user khỏi danh bạ của tôi.
   */
  async removeContact(userId: string, contactId: string): Promise<{ contacts: string[] }> {
    await this.users.getUser(contactId);
    await this.repo.removeContact(userId, contactId);
    return { contacts: await this.repo.listContacts(userId) };
  }
  /**
   * Danh bạ của tôi.
   */
  async listContacts(userId: string): Promise<string[]> {
    return this.repo.listContacts(userId);
  }

  // --- cổng liên lạc (contact / shared-course gate) ----------------------------

  /**
   * Cổng liên lạc 1-1 (oracle: Moodle `core_message\api::can_contact_user` và
   * Behat "Disallow sending a message if you are neither a contact nor do you
   * share a course with the user"). Khi setting `core/messagingallusers` =
   * false, người gửi chỉ liên lạc được với người nhận khi ÍT NHẤT một điều
   * kiện đúng: (a) người nhận đã thêm người gửi vào danh bạ của người nhận,
   * hoặc (b) hai người có ít nhất một khoá học cùng ghi danh đang active.
   * Setting được đọc tươi qua SiteConfigService ở mỗi lần kiểm (không cache)
   * nên admin đổi là có hiệu lực ngay. Notification hệ thống (`notify`)
   * KHÔNG đi qua cổng này.
   */
  private async assertCanContact(senderId: string, recipientId: string): Promise<void> {
    const allUsers = await this.siteConfig.getValue<boolean>('core', 'messagingallusers');
    if (allUsers) return;
    if (await this.repo.isContact(recipientId, senderId)) return;
    if (await this.repo.sharesActiveCourse(senderId, recipientId)) return;
    throw new ForbiddenException({
      message: 'You can only message a user who has you as a contact or who shares a course with you (messagingallusers is off)',
      code: 'messaging.not_a_contact_or_course_member',
    });
  }

  // --- blocked contacts ---------------------------------------------------------

  /**
   * Chặn một liên hệ.
   */
  async blockContact(userId: string, blockedUserId: string): Promise<{ blocked: string[] }> {
    if (blockedUserId === userId) throw new BadRequestException({ message: 'You cannot block yourself', code: 'messaging.block_self' });
    await this.users.getUser(blockedUserId);
    await this.repo.block(userId, blockedUserId);
    return { blocked: await this.repo.listBlocked(userId) };
  }
  /**
   * Bỏ chặn liên hệ.
   */
  async unblockContact(userId: string, blockedUserId: string): Promise<{ blocked: string[] }> {
    await this.repo.unblock(userId, blockedUserId);
    return { blocked: await this.repo.listBlocked(userId) };
  }
  /**
   * Danh sách liên hệ bị chặn.
   */
  async listBlocked(userId: string): Promise<string[]> {
    return this.repo.listBlocked(userId);
  }
  /**
   * User có bị người kia chặn hay không.
   */
  async isBlockedBy(blockerId: string, senderId: string): Promise<boolean> {
    return this.repo.isBlocked(blockerId, senderId);
  }

  // --- conversations & messages ---------------------------------------------------

  /**
   * Tạo conversation (nhóm hoặc 1-1; 1-1 đã tồn tại thì dùng lại). Tạo MỚI
   * conversation 1-1 phải qua cổng liên lạc (xem {@link assertCanContact});
   * việc trả lại conversation đã tồn tại là truy hồi idempotent, còn việc
   * gửi tiếp trong đó vẫn bị cổng kiểm ở {@link sendMessage} — đúng luật
   * Moodle (can_send_message_to_conversation kiểm mỗi lần gửi, kể cả
   * conversation có từ trước khi bật cổng).
   */
  async createConversation(actorId: string, input: { type?: number; memberIds: string[]; name?: string }): Promise<ConversationRow & { members: string[] }> {
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
    if (type === 1) {
      const other = memberIds.find((id) => id !== actorId)!;
      await this.assertCanContact(actorId, other);
    }
    const conversation = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertConversation({ type, name: input.name ?? null }, tx as never);
      for (const id of memberIds) await this.repo.addMember(created.id, id, tx as never);
      return created;
    });
    return { ...conversation, members: memberIds };
  }

  // --- group conversations (gắn course group) ---------------------------------

  /** Conversation có gắn với một course group qua (component, itemType, itemId) hay không. */
  private isGroupLinked(conversation: ConversationRow): boolean {
    return conversation.type === 2
      && conversation.component === 'core_group'
      && conversation.itemType === 'groups'
      && conversation.itemId !== null;
  }

  /**
   * Đồng bộ lười thành viên của một conversation gắn group theo thành viên
   * group HIỆN TẠI: người mới vào group được thêm, người rời group bị gỡ
   * khỏi conversation (tin nhắn cũ giữ nguyên). Trả về danh sách thành viên
   * sau đồng bộ. Chỉ chạy phía messaging khi conversation được liệt kê/mở/
   * gửi — không cần hook trong module groups.
   */
  private async syncGroupConversationMembers(conversation: ConversationRow): Promise<string[]> {
    const groupMemberIds = [...new Set(await this.repo.listGroupMemberIds(conversation.itemId!))];
    const current = await this.repo.listMembers(conversation.id);
    for (const id of groupMemberIds) {
      if (!current.includes(id)) await this.repo.addMember(conversation.id, id);
    }
    for (const id of current) {
      if (!groupMemberIds.includes(id)) await this.repo.removeMember(conversation.id, id);
    }
    return groupMemberIds;
  }

  /** Đồng bộ nếu conversation gắn group; conversation thường thì bỏ qua. */
  private async syncGroupConversationIfLinked(conversation: ConversationRow): Promise<void> {
    if (this.isGroupLinked(conversation)) await this.syncGroupConversationMembers(conversation);
  }

  /**
   * Staff của khoá theo đúng nghĩa GroupsModule dùng: site admin, hoặc có
   * capability `moodle/course:managegroups` tại context của khoá.
   */
  private async isCourseStaff(userId: string, courseId: string): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
    if (!courseCtx) return false;
    return this.evaluator.hasCapability(userId, 'moodle/course:managegroups', courseCtx.id);
  }

  /**
   * Tạo (hoặc lấy lại) conversation của một course group: component
   * 'core_group', itemType 'groups', itemId = group id. Chỉ thành viên
   * group hoặc staff của khoá mới tạo được; thành viên conversation khởi
   * tạo đúng bằng thành viên group hiện tại và về sau được đồng bộ lười.
   */
  async createGroupConversation(actorId: string, input: { groupId: string; name?: string }): Promise<ConversationRow & { members: string[] }> {
    const group = await this.repo.getCourseGroup(input.groupId);
    if (!group) throw new NotFoundException({ message: `Course group ${input.groupId} not found`, code: 'messaging.group_not_found' });
    const groupMemberIds = await this.repo.listGroupMemberIds(group.id);
    if (!groupMemberIds.includes(actorId) && !(await this.isCourseStaff(actorId, group.courseId))) {
      throw new ForbiddenException({ message: 'Only group members or course staff can create the group conversation', code: 'messaging.group_conversation_forbidden' });
    }
    const existing = await this.repo.findGroupConversation(group.id);
    if (existing) return { ...existing, members: await this.syncGroupConversationMembers(existing) };
    const courseCtx = await this.contexts.getByLevelInstance(50, group.courseId);
    const conversation = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertConversation({
        type: 2, name: input.name ?? group.name,
        component: 'core_group', itemType: 'groups', itemId: group.id,
        contextId: courseCtx?.id ?? null,
      }, tx as never);
      for (const id of groupMemberIds) await this.repo.addMember(created.id, id, tx as never);
      return created;
    });
    return { ...conversation, members: groupMemberIds };
  }

  /**
   * Conversation của user kèm số chưa đọc, tin cuối và mốc đã đọc của
   * chính user — lấy bằng MỘT truy vấn tổng hợp ở repository (không còn
   * tải toàn bộ lịch sử về đếm như trước). Conversation gắn group được
   * đồng bộ lười trước khi liệt kê — kể cả các group mà user mới gia
   * nhập (chưa từng là thành viên conversation) để chúng xuất hiện
   * ngay; membership đã cũ (user đã rời group nhưng chưa lần đồng bộ
   * nào chạy) được đồng bộ và loại khỏi danh sách tại đây.
   */
  async listConversations(userId: string): Promise<(ConversationRow & {
    members: string[]; unread: number; lastReadSeq: number; lastMessage: MessageRow | null;
  })[]> {
    for (const c of await this.repo.listGroupConversationsForGroupMember(userId)) {
      await this.syncGroupConversationMembers(c);
    }
    const summaries = await this.repo.listConversationSummaries(userId);
    const myGroupIds = new Set(await this.repo.listGroupIdsForUser(userId));
    const out: (ConversationRow & {
      members: string[]; unread: number; lastReadSeq: number; lastMessage: MessageRow | null;
    })[] = [];
    for (const s of summaries) {
      if (this.isGroupLinked(s.conversation) && !myGroupIds.has(s.conversation.itemId!)) {
        // Đã rời group nhưng membership conversation chưa được đồng bộ:
        // đồng bộ ngay (gỡ user khỏi conversation) và ẩn khỏi danh sách.
        await this.syncGroupConversationMembers(s.conversation);
        continue;
      }
      out.push({
        ...s.conversation,
        members: s.members,
        unread: s.unreadCount,
        lastReadSeq: s.lastReadSeq,
        lastMessage: s.lastMessage,
      });
    }
    return out;
  }

  /**
   * Chi tiết conversation + một cửa sổ tin nhắn mới nhất theo cursor
   * seq (chỉ thành viên mới xem được; conversation gắn group được đồng
   * bộ thành viên trước khi kiểm tra). `memberReadMarkers` cho client
   * hiển thị biên "đã xem" theo mốc đã đọc của từng thành viên.
   */
  async getConversation(userId: string, conversationId: string, opts: { limit?: number } = {}): Promise<ConversationRow & {
    members: string[]; messages: MessageRow[]; hasMoreBefore: boolean;
    lastReadSeq: number; memberReadMarkers: { userId: string; lastReadSeq: number }[];
  }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    if (!(await this.repo.isMember(conversationId, userId))) {
      throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
    }
    const messages = await this.repo.listMessages(conversationId, { limit: opts.limit ?? 50 });
    const markers = await this.repo.listMemberReadMarkers(conversationId);
    return {
      ...conversation,
      members: await this.repo.listMembers(conversationId),
      messages,
      hasMoreBefore: messages.length > 0 ? await this.repo.hasMessagesBefore(conversationId, messages[0]!.seq) : false,
      lastReadSeq: markers.find((m) => m.userId === userId)?.lastReadSeq ?? 0,
      memberReadMarkers: markers,
    };
  }

  /**
   * Một cửa sổ tin theo cursor seq của conversation (tải lịch sử cũ
   * bằng beforeSeq, đồng bộ phần thiếu bằng afterSeq) — đầu REST cho
   * phân trang/đồng bộ, cùng ngữ nghĩa cursor với kênh realtime.
   */
  async listConversationMessages(userId: string, conversationId: string, query: {
    beforeSeq?: number; afterSeq?: number; limit?: number;
  }): Promise<{ messages: MessageRow[]; hasMoreBefore: boolean }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    if (!(await this.repo.isMember(conversationId, userId))) {
      throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
    }
    const messages = await this.repo.listMessages(conversationId, query);
    return {
      messages,
      hasMoreBefore: messages.length > 0 && query.afterSeq === undefined
        ? await this.repo.hasMessagesBefore(conversationId, messages[0]!.seq)
        : false,
    };
  }

  /**
   * Send a user-to-user message. Delivery law (report §2#12): every other
   * member must be contactable — not suspended, and must not have blocked
   * the sender. Once stored, the message is immutable through the API.
   */
  /**
   * Gửi tin nhắn: kiểm tra thành viên và quan hệ chặn. Nếu client kèm
   * `clientMessageId` (gửi lạc quan/thử lại), lần gửi trùng khoá trả
   * chính tin đã lưu — không tạo tin thứ hai, không phát sự kiện mới.
   * Tin mới nhận seq đơn điệu của conversation trong cùng transaction
   * với outbox `message_sent`; realtime đến client qua consumer của
   * outbox, service KHÔNG tự phát socket.
   */
  async sendMessage(actorId: string, conversationId: string, input: { text: string; subject?: string; clientMessageId?: string }): Promise<MessageRow> {
    const systemCtx = await this.contexts.ensureSystemContext();
    const senderCtx = await this.contexts.getByLevelInstance(30, actorId);
    await this.evaluator.requireCapability(actorId, 'moodle/site:sendmessage', senderCtx?.id ?? systemCtx.id);
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    // Conversation gắn group: đồng bộ thành viên theo group trước khi kiểm
    // tra tư cách thành viên (người mới vào group gửi được ngay, người rời
    // group bị chặn ở kiểm tra ngay dưới đây).
    await this.syncGroupConversationIfLinked(conversation);
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
    // Cổng liên lạc chỉ áp cho conversation cá nhân (type 1) — đúng Moodle:
    // can_send_message_to_conversation kiểm can_contact_user ở MỖI lần gửi
    // vào conversation cá nhân (conversation có từ trước khi bật cổng vẫn bị
    // chặn), còn conversation nhóm thì thành viên gửi tự do. Kiểm sau luật
    // suspended/blocked để giữ nguyên mã lỗi đã có của hai luật đó.
    if (conversation.type === 1) {
      const other = members.find((id) => id !== actorId);
      if (other) await this.assertCanContact(actorId, other);
    }
    if (input.clientMessageId) {
      const existing = await this.repo.getMessageByClientId(conversationId, actorId, input.clientMessageId);
      if (existing) return existing;
    }
    try {
      return await this.repo.dbHandle.transaction(async (tx) => {
        const seq = await this.repo.allocateNextSeq(conversationId, tx as never);
        const msg = await this.repo.insertMessage({
          conversationId: conversationId, userIdFrom: actorId,
          subject: input.subject ?? '', fullMessage: input.text, smallMessage: input.text.slice(0, 200),
          seq, clientMessageId: input.clientMessageId ?? null,
        }, tx as never);
        await this.outbox.enqueue(tx as never, {
          aggregate: 'messaging', type: 'message_sent',
          payload: {
            conversationId, messageId: msg.id, seq, fromUserId: actorId,
            memberIds: members, clientMessageId: input.clientMessageId ?? null,
          },
        });
        return msg;
      });
    } catch (err) {
      // Hai lần gửi trùng khoá chạy đồng thời: một lần thắng ở ràng buộc
      // duy nhất, lần còn lại nhận lỗi 23505 sau khi transaction đã huỷ —
      // đọc lại tin thắng và trả như một lần gửi thành công.
      if (input.clientMessageId && isUniqueViolation(err)) {
        const existing = await this.repo.getMessageByClientId(conversationId, actorId, input.clientMessageId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Sửa tin nhắn vẫn bị từ chối. Xoá tin: chính sách đã chốt (issue
   * #33) là XOÁ MỀM có truy vết ở đợt Lớp B — đợt nền này CHƯA triển
   * khai nên cả hai đường vẫn từ chối như cũ; khi Lớp B làm, xoá sẽ
   * ghi trạng thái/người xoá/thời điểm chứ không xoá vật lý dòng tin.
   */
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
   * Đánh dấu đã đọc conversation: chỉ nâng mốc đã đọc của CHÍNH user
   * này (thành viên khác giữ nguyên số chưa đọc của họ). Mốc tăng thì
   * ghi outbox `message_conversation_read` để consumer phân phối biên
   * đã-đọc ("đã xem tới seq N") cho các thành viên còn lại.
   */
  async markConversationRead(userId: string, conversationId: string): Promise<{ marked: number; lastReadSeq: number }> {
    if (!(await this.repo.isMember(conversationId, userId))) {
      throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
    }
    const before = (await this.repo.getMemberLastReadSeq(conversationId, userId)) ?? 0;
    const result = await this.repo.markConversationRead(conversationId, userId);
    if (result.lastReadSeq > before) {
      await this.outbox.enqueueStandalone({
        aggregate: 'messaging', type: 'message_conversation_read',
        payload: { conversationId, userId, lastReadSeq: result.lastReadSeq },
      });
    }
    return result;
  }

  /**
   * Số conversation chưa đọc và số notification chưa đọc (cho huy hiệu trên giao diện).
   */
  async unreadCounts(userId: string): Promise<{ conversations: number; notifications: number }> {
    return {
      conversations: await this.repo.countUnreadConversations(userId),
      notifications: await this.repo.countUnreadNotifications(userId),
    };
  }
}
