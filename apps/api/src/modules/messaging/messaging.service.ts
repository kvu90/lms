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
import { MessagingRepository, type ConversationRow, type MessageRow, type NotificationRow, type ReportRow } from './messaging.repository';
import { MessagingRealtimeService } from './messaging-realtime.service';
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
  // Lớp B (issue #33): yêu cầu kết bạn mới — phía nhận được thông báo qua pipeline sẵn có.
  { name: 'contact_request', component: 'core_message', channels: ['popup', 'email'] },
  // Lớp B (issue #33): một conversation bị báo cáo — giáo viên phụ trách + quản trị viên nhận được.
  { name: 'conversation_reported', component: 'core_message', channels: ['popup', 'email'] },
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

/** Tóm tắt hiển thị của một user trong các response của messaging (hợp đồng ở @lms/contracts). */
export interface PersonSummaryView {
  userId: string;
  displayName: string;
  username: string;
}

/** Trạng thái quan hệ của một người so với người đang tìm (hợp đồng ở @lms/contracts). */
export type ContactRelationship = 'contact' | 'pending_incoming' | 'pending_outgoing' | 'blocked' | 'none';

/** Một kết quả tìm người: tóm tắt hiển thị + trạng thái quan hệ với người tìm. */
export interface PeopleSearchResultView extends PersonSummaryView {
  relationship: ContactRelationship;
}

/** Tên hiển thị của một user: "firstName lastName" đã cắt khoảng trắng; cả hai trống thì lùi về username. */
export function displayNameOf(user: { firstName: string; lastName: string; username: string }): string {
  const name = `${user.firstName} ${user.lastName}`.trim();
  return name || user.username;
}

/** Tìm người theo tên: chuỗi tìm tối thiểu (sau khi cắt khoảng trắng) và trần kết quả trả về. */
export const PEOPLE_SEARCH_MIN_QUERY_LENGTH = 2;
export const PEOPLE_SEARCH_MAX_RESULTS = 20;
/** Số ứng viên tối đa lấy từ DB trước khi lọc phạm vi cổng nhắn (lọc xong mới cắt theo trần kết quả). */
const PEOPLE_SEARCH_CANDIDATE_LIMIT = 100;

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
 *    a message passes to core_message: NO endpoint edits or deletes it
 *    (xoá mềm có truy vết là chặng sau của Lớp B, issue #33).
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
 * Cổng liên lạc: khi setting `core/messagingallusers` tắt, chỉ liên hệ ĐÃ ĐƯỢC DUYỆT
 * (luồng yêu cầu–chấp nhận) hoặc bạn cùng khoá đang ghi danh mới mở được liên lạc 1-1 — notification
 * hệ thống không qua cổng này. Setting site là TRẦN cấp site duy nhất của cổng
 * (chính sách Lớp B đã chốt không có tuỳ chọn siết thêm theo từng user).
 * Conversation gắn course group (component core_group) đồng bộ thành viên
 * theo group mỗi lần liệt kê/mở/gửi (đồng bộ lười phía messaging).
 */
export class MessagingService {
  constructor(
    private readonly repo: MessagingRepository,
    private readonly users: UsersService,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly outbox: OutboxService,
    private readonly siteConfig: SiteConfigService,
    private readonly realtime: MessagingRealtimeService,
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

  // --- contacts: luồng yêu cầu – chấp nhận (Lớp B) ---------------------------
  // Thay danh bạ MỘT CHIỀU cũ bằng quan hệ có duyệt như Moodle: gửi yêu
  // cầu → phía kia chấp nhận thì quan hệ mới tồn tại (ở cả hai chiều)
  // và mới mở cổng liên lạc; từ chối thì yêu cầu biến mất, quan hệ
  // không hình thành. Gửi yêu cầu cho người ĐÃ gửi yêu cầu cho mình =
  // chấp nhận ngầm (hai phía cùng muốn kết nối thì không cần thêm một
  // lượt duyệt nữa).

  /**
   * Gửi yêu cầu kết bạn tới một user. Đã là liên hệ thì trả trạng thái
   * accepted (idempotent); đã có yêu cầu chiều ngược đang chờ thì chấp
   * nhận luôn yêu cầu đó. Người bị phía kia chặn (hoặc đã chặn phía
   * kia) không gửi được yêu cầu.
   */
  async requestContact(userId: string, contactId: string): Promise<{ status: 'pending' | 'accepted'; contacts: string[] }> {
    if (contactId === userId) throw new BadRequestException({ message: 'You cannot add yourself as a contact', code: 'messaging.contact_self' });
    await this.users.getUser(contactId);
    if (await this.repo.isContact(userId, contactId)) {
      return { status: 'accepted', contacts: await this.repo.listContacts(userId) };
    }
    if (await this.repo.isBlocked(contactId, userId) || await this.repo.isBlocked(userId, contactId)) {
      throw new ForbiddenException({ message: 'A block between you and this user prevents contact requests', code: 'messaging.contact_blocked' });
    }
    if (await this.repo.getContactRequest(contactId, userId)) {
      // Phía kia đã xin kết bạn với mình trước: gửi ngược lại = đồng ý.
      await this.repo.deleteContactRequest(contactId, userId);
      await this.repo.addContactPair(userId, contactId);
      return { status: 'accepted', contacts: await this.repo.listContacts(userId) };
    }
    const existing = await this.repo.getContactRequest(userId, contactId);
    if (!existing) {
      await this.repo.createContactRequest(userId, contactId);
      await this.notify(contactId, 'contact_request', {
        subject: 'New contact request',
        body: 'You have a new contact request. Open your messages to accept or decline it.',
        fromUserId: userId,
      });
    }
    return { status: 'pending', contacts: await this.repo.listContacts(userId) };
  }
  /**
   * Các yêu cầu kết bạn của tôi: `incoming` là yêu cầu người khác gửi
   * tới chờ tôi duyệt, `outgoing` là yêu cầu tôi đã gửi đang chờ.
   * Mỗi mục kèm tên hiển thị + username của phía kia để giao diện
   * hiện TÊN thay cho UUID thô.
   */
  async listContactRequests(userId: string): Promise<{
    incoming: { userId: string; createdAt: Date; displayName: string; username: string }[];
    outgoing: { userId: string; createdAt: Date; displayName: string; username: string }[];
  }> {
    const incoming = await this.repo.listIncomingContactRequests(userId);
    const outgoing = await this.repo.listOutgoingContactRequests(userId);
    const profiles = await this.profilesFor([
      ...incoming.map((r) => r.userIdFrom),
      ...outgoing.map((r) => r.userIdTo),
    ]);
    const withProfile = (id: string, createdAt: Date) => ({
      userId: id,
      createdAt,
      displayName: profiles[id]?.displayName ?? id,
      username: profiles[id]?.username ?? '',
    });
    return {
      incoming: incoming.map((r) => withProfile(r.userIdFrom, r.createdAt)),
      outgoing: outgoing.map((r) => withProfile(r.userIdTo, r.createdAt)),
    };
  }
  /**
   * Tóm tắt hiển thị (tên + username) cho một tập user id — các
   * response danh sách của messaging trả kèm để client hiện TÊN thay
   * cho UUID thô. User không còn tồn tại thì vắng khỏi bản đồ kết quả.
   */
  async profilesFor(userIds: string[]): Promise<Record<string, PersonSummaryView>> {
    const unique = [...new Set(userIds)];
    const out: Record<string, PersonSummaryView> = {};
    if (!unique.length) return out;
    const rows = await this.users.getUsersByIds(unique);
    for (const row of rows) {
      out[row.id] = { userId: row.id, displayName: displayNameOf(row), username: row.username };
    }
    return out;
  }
  /**
   * Chấp nhận yêu cầu kết bạn TỪ requesterId: quan hệ hình thành ở cả
   * hai chiều, yêu cầu rời hàng chờ. Không có yêu cầu như vậy thì 404.
   */
  async acceptContactRequest(userId: string, requesterId: string): Promise<{ contacts: string[] }> {
    await this.users.getUser(requesterId);
    const request = await this.repo.getContactRequest(requesterId, userId);
    if (!request) throw new NotFoundException({ message: `No pending contact request from ${requesterId}`, code: 'messaging.contact_request_not_found' });
    await this.repo.deleteContactRequest(requesterId, userId);
    await this.repo.addContactPair(userId, requesterId);
    return { contacts: await this.repo.listContacts(userId) };
  }
  /**
   * Từ chối yêu cầu kết bạn TỪ requesterId: yêu cầu biến mất, quan hệ
   * không hình thành. Không có yêu cầu như vậy thì 404.
   */
  async declineContactRequest(userId: string, requesterId: string): Promise<{ declined: boolean }> {
    await this.users.getUser(requesterId);
    const request = await this.repo.getContactRequest(requesterId, userId);
    if (!request) throw new NotFoundException({ message: `No pending contact request from ${requesterId}`, code: 'messaging.contact_request_not_found' });
    await this.repo.deleteContactRequest(requesterId, userId);
    return { declined: true };
  }
  /**
   * Gỡ một liên hệ đã duyệt: quan hệ mất ở CẢ hai phía (cổng liên lạc
   * đóng lại cho cả hai chiều), yêu cầu chờ giữa hai người cũng dọn.
   */
  async removeContact(userId: string, contactId: string): Promise<{ contacts: string[] }> {
    await this.users.getUser(contactId);
    await this.repo.removeContactPair(userId, contactId);
    return { contacts: await this.repo.listContacts(userId) };
  }
  /**
   * Danh bạ của tôi (chỉ các liên hệ ĐÃ ĐƯỢC DUYỆT).
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
   * kiện đúng: (a) hai người là liên hệ ĐÃ ĐƯỢC DUYỆT của nhau (luồng
   * yêu cầu–chấp nhận của Lớp B — yêu cầu đang chờ không mở cổng), hoặc
   * (b) hai người có ít nhất một khoá học cùng ghi danh đang active.
   * Setting cấp site là trần duy nhất của cổng (chính sách đã chốt
   * không có lớp tuỳ chọn theo từng user). Setting được đọc tươi qua
   * SiteConfigService ở mỗi lần kiểm (không cache) nên admin đổi là
   * có hiệu lực ngay. Notification hệ thống (`notify`) KHÔNG đi qua
   * cổng này.
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

  // --- tìm người theo tên (việc nối tiếp Lớp B) --------------------------------

  /**
   * Tìm người theo tên hiển thị/username — CHỈ trong phạm vi cổng
   * nhắn đã chốt: khi `core/messagingallusers` tắt, kết quả gồm người
   * cùng khoá đang ghi danh hiệu lực với người tìm CỘNG các liên hệ
   * đã duyệt của họ (đúng tập mà cổng liên lạc {@link assertCanContact}
   * cho phép mở liên lạc); công tắc bật thì toàn hệ thống. Người đã
   * chặn người tìm KHÔNG xuất hiện trong kết quả của phía bị chặn
   * (khớp ngữ nghĩa chặn hiện có); người bị chính người tìm chặn vẫn
   * hiện với trạng thái `blocked` để giao diện phân biệt. Loại trừ
   * chính người tìm; mỗi kết quả kèm trạng thái quan hệ hiện tại.
   */
  async searchPeople(actorId: string, rawQuery: string): Promise<PeopleSearchResultView[]> {
    const q = rawQuery.trim();
    if (q.length < PEOPLE_SEARCH_MIN_QUERY_LENGTH) {
      throw new BadRequestException({
        message: `Search query must be at least ${PEOPLE_SEARCH_MIN_QUERY_LENGTH} characters`,
        code: 'messaging.search_query_too_short',
      });
    }
    const candidates = (await this.repo.searchUsersByName(q, PEOPLE_SEARCH_CANDIDATE_LIMIT))
      .filter((c) => c.id !== actorId);
    if (!candidates.length) return [];
    const [blockerIds, contactIds, incoming, outgoing, blockedIds, allUsers] = await Promise.all([
      this.repo.listBlockerIds(actorId),
      this.repo.listContacts(actorId),
      this.repo.listIncomingContactRequests(actorId),
      this.repo.listOutgoingContactRequests(actorId),
      this.repo.listBlocked(actorId),
      this.siteConfig.getValue<boolean>('core', 'messagingallusers'),
    ]);
    const blockedBy = new Set(blockerIds);
    const contactSet = new Set(contactIds);
    let visible = candidates.filter((c) => !blockedBy.has(c.id));
    if (!allUsers) {
      const mateSet = new Set(await this.repo.listCourseMateIds(actorId));
      visible = visible.filter((c) => mateSet.has(c.id) || contactSet.has(c.id));
    }
    const incomingSet = new Set(incoming.map((r) => r.userIdFrom));
    const outgoingSet = new Set(outgoing.map((r) => r.userIdTo));
    const blockedSet = new Set(blockedIds);
    const relationshipOf = (id: string): ContactRelationship => {
      if (blockedSet.has(id)) return 'blocked';
      if (contactSet.has(id)) return 'contact';
      if (incomingSet.has(id)) return 'pending_incoming';
      if (outgoingSet.has(id)) return 'pending_outgoing';
      return 'none';
    };
    return visible.slice(0, PEOPLE_SEARCH_MAX_RESULTS).map((c) => ({
      userId: c.id,
      displayName: displayNameOf(c),
      username: c.username,
      relationship: relationshipOf(c.id),
    }));
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
    if (type === 2) {
      // Cổng lập nhóm tự do (Lớp B, chính sách đã chốt): học sinh KHÔNG
      // tự lập nhóm trong hệ thống — nhóm tự do chỉ do giáo viên/staff
      // (có ít nhất một gán vai trò staff ở bất kỳ context nào) hoặc
      // quản trị viên tạo; nhóm của lớp/khoá đi đường cấu trúc riêng
      // (createGroupConversation). Chặn TẠI TẦNG SERVICE này để mọi
      // client đều bị chặn như nhau, không chỉ ẩn ở giao diện.
      const isAdmin = await this.evaluator.isSiteAdmin(actorId);
      if (!isAdmin && !(await this.repo.hasStaffRoleAssignment(actorId))) {
        throw new ForbiddenException({
          message: 'Only teachers or staff can create group conversations; students cannot create their own groups',
          code: 'messaging.group_creation_forbidden',
        });
      }
    }
    const conversation = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertConversation({ type, name: input.name ?? null, createdBy: actorId }, tx as never);
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
      if (!groupMemberIds.includes(id)) {
        await this.repo.removeMember(conversation.id, id);
        // Đẩy socket của người vừa bị gỡ ra khỏi room của conversation
        // NGAY: membership ở DB đã mất mà socket còn nằm trong room thì
        // vẫn nhận mọi sự kiện của conversation (F1). Tầng phân phối
        // còn rà soát lại membership một lần nữa trước mỗi lần phát.
        await this.realtime.evictUserFromConversation(id, conversation.id);
      }
    }
    return groupMemberIds;
  }

  /** Đồng bộ nếu conversation gắn group; conversation thường thì bỏ qua. */
  private async syncGroupConversationIfLinked(conversation: ConversationRow): Promise<void> {
    if (this.isGroupLinked(conversation)) await this.syncGroupConversationMembers(conversation);
  }

  /**
   * Staff của khoá theo đúng nghĩa GroupsModule dùng: site admin, hoặc có
   * capability `course:managegroups` tại context của khoá.
   */
  private async isCourseStaff(userId: string, courseId: string): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
    if (!courseCtx) return false;
    return this.evaluator.hasCapability(userId, 'course:managegroups', courseCtx.id);
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
        contextId: courseCtx?.id ?? null, createdBy: actorId,
      }, tx as never);
      for (const id of groupMemberIds) await this.repo.addMember(created.id, id, tx as never);
      return created;
    });
    return { ...conversation, members: groupMemberIds };
  }

  // --- thẩm quyền theo phạm vi trên một conversation (Lớp B) -----------------
  // Ba câu hỏi khác nhau, không gộp làm một:
  //  - "phụ trách khoá của conversation này" (staff tại context khoá
  //    hoặc tổ tiên của nó, hoặc quản trị viên) → quyền KIỂM DUYỆT:
  //    xoá tin của người khác, xem lại báo cáo, xem tin đã xoá mềm.
  //  - "quản lý conversation" = phụ trách khoá, cộng thêm NGƯỜI TẠO
  //    đối với conversation KHÔNG gắn cấu trúc lớp/khoá → quyền bật/tắt
  //    chat và gửi tin khi chat đang tắt. Conversation gắn group của
  //    khoá thì người tạo bản ghi (có thể là một học sinh bấm mở nhóm
  //    lớp) KHÔNG thành người quản lý — quản lý chỉ theo staff khoá.

  /**
   * Khoá học mà một conversation "thuộc về" — căn cứ phân phạm vi
   * thẩm quyền của Lớp B. Thứ tự: conversation gắn course group thì là
   * khoá của group; conversation có context là context khoá thì là
   * khoá đó; còn lại (chat tự do/1-1) suy ra từ GIAO của các khoá mà
   * mọi thành viên đang cùng ghi danh active (không có khoá chung thì
   * conversation không thuộc khoá nào — chỉ quản trị viên có thẩm
   * quyền kiểm duyệt trên nó).
   */
  private async resolveConversationCourseId(conversation: ConversationRow): Promise<string | null> {
    if (this.isGroupLinked(conversation)) {
      const group = await this.repo.getCourseGroup(conversation.itemId!);
      if (group) return group.courseId;
    }
    if (conversation.contextId) {
      const ctx = await this.contexts.getContext(conversation.contextId).catch(() => undefined);
      if (ctx && ctx.contextLevel === 50) return ctx.instanceId;
    }
    const members = await this.repo.listMembers(conversation.id);
    if (!members.length) return null;
    let common: string[] | null = null;
    for (const memberId of members) {
      const courses = await this.repo.activeCourseIds(memberId);
      common = common === null ? [...courses] : common.filter((id) => courses.includes(id));
      if (!common.length) return null;
    }
    return common?.sort()[0] ?? null;
  }

  /**
   * Người có thẩm quyền KIỂM DUYỆT trên conversation: quản trị viên,
   * hoặc staff của khoá mà conversation thuộc về (gán vai trò staff
   * tại context khoá hoặc tổ tiên — đúng tập
   * {@link MessagingRepository.listCourseStaffUserIds}).
   */
  private async canModerateConversation(userId: string, conversation: ConversationRow): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    const courseId = await this.resolveConversationCourseId(conversation);
    if (!courseId) return false;
    const staff = await this.repo.listCourseStaffUserIds(courseId);
    return staff.includes(userId);
  }

  /**
   * Người có thẩm quyền QUẢN LÝ conversation (bật/tắt chat, gửi khi
   * chat tắt): mọi người có thẩm quyền kiểm duyệt, cộng người tạo —
   * nhưng chỉ với conversation không gắn cấu trúc lớp/khoá.
   */
  private async canManageConversation(userId: string, conversation: ConversationRow): Promise<boolean> {
    if (await this.canModerateConversation(userId, conversation)) return true;
    if (!this.isGroupLinked(conversation) && conversation.createdBy !== null && conversation.createdBy === userId) return true;
    return false;
  }

  /**
   * Bật/tắt chat của một conversation (Lớp B — chốt "nhóm lớp mặc
   * định chat hai chiều, giáo viên tắt được"): chỉ người có thẩm
   * quyền quản lý theo phạm vi khoá. Khi tắt, đường gửi chặn thành
   * viên thường nhưng người quản lý vẫn gửi được (đường thông báo
   * một chiều của giáo viên).
   */
  async updateConversation(actorId: string, conversationId: string, input: { enabled: boolean }): Promise<ConversationRow & { members: string[] }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    if (!(await this.canManageConversation(actorId, conversation))) {
      throw new ForbiddenException({
        message: 'Only the teacher in charge, course staff, an administrator, or the group creator can change this conversation',
        code: 'messaging.conversation_manage_forbidden',
      });
    }
    const updated = await this.repo.setConversationEnabled(conversationId, input.enabled);
    return { ...updated!, members: await this.repo.listMembers(conversationId) };
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
    memberProfiles: Record<string, PersonSummaryView>;
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
    // Tên hiển thị của mọi thành viên (gồm người gửi tin cuối) để
    // client hiện TÊN thay cho UUID thô trong danh sách.
    const profiles = await this.profilesFor(out.flatMap((entry) => entry.members));
    return out.map((entry) => ({
      ...entry,
      memberProfiles: Object.fromEntries(
        entry.members.filter((id) => profiles[id]).map((id) => [id, profiles[id]!]),
      ),
    }));
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
    memberProfiles: Record<string, PersonSummaryView>;
    canModerate: boolean; canManage: boolean;
  }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    if (!(await this.repo.isMember(conversationId, userId))) {
      throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
    }
    // Tầm nhìn theo vai trò (Lớp B): thành viên thường KHÔNG BAO GIỜ
    // thấy tin đã xoá mềm; người có thẩm quyền kiểm duyệt trên
    // conversation (giáo viên phụ trách/quản trị) thấy cả tin đã xoá
    // kèm dấu vết — đó là đường truy vết của chính sách xoá mềm.
    const canModerate = await this.canModerateConversation(userId, conversation);
    const canManage = canModerate || await this.canManageConversation(userId, conversation);
    const messages = await this.repo.listMessages(conversationId, { limit: opts.limit ?? 50, includeDeleted: canModerate });
    const markers = await this.repo.listMemberReadMarkers(conversationId);
    const members = await this.repo.listMembers(conversationId);
    return {
      ...conversation,
      members,
      messages,
      hasMoreBefore: messages.length > 0 ? await this.repo.hasMessagesBefore(conversationId, messages[0]!.seq, canModerate) : false,
      lastReadSeq: markers.find((m) => m.userId === userId)?.lastReadSeq ?? 0,
      memberReadMarkers: markers,
      // Tên hiển thị của thành viên: client dùng cho nhãn người gửi,
      // chỉ báo đang gõ và danh sách thành viên (thay UUID thô).
      memberProfiles: await this.profilesFor(members),
      canModerate,
      canManage,
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
    // Cùng luật tầm nhìn với getConversation: chỉ người có thẩm quyền
    // kiểm duyệt mới nhận được tin đã xoá mềm trong cửa sổ đồng bộ.
    const canModerate = await this.canModerateConversation(userId, conversation);
    const messages = await this.repo.listMessages(conversationId, { ...query, includeDeleted: canModerate });
    return {
      messages,
      hasMoreBefore: messages.length > 0 && query.afterSeq === undefined
        ? await this.repo.hasMessagesBefore(conversationId, messages[0]!.seq, canModerate)
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
    await this.evaluator.requireCapability(actorId, 'site:sendmessage', senderCtx?.id ?? systemCtx.id);
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    // Conversation gắn group: đồng bộ thành viên theo group trước khi kiểm
    // tra tư cách thành viên (người mới vào group gửi được ngay, người rời
    // group bị chặn ở kiểm tra ngay dưới đây).
    await this.syncGroupConversationIfLinked(conversation);
    if (!(await this.repo.isMember(conversationId, actorId))) {
      throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
    }
    // Cột `enabled` phải được tôn trọng THẬT ở đường gửi (Lớp B):
    // giáo viên tắt chat của nhóm lớp thì thành viên thường dừng gửi
    // tại đây; người có thẩm quyền quản lý vẫn gửi được — đó là đường
    // thông báo một chiều của giáo viên khi lớp đã tắt chat.
    if (!conversation.enabled && !(await this.canManageConversation(actorId, conversation))) {
      throw new ForbiddenException({
        message: 'Chat is disabled for this conversation',
        code: 'messaging.conversation_disabled',
      });
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
   * Sửa tin nhắn vẫn bị từ chối (chính sách đã chốt chỉ nới XOÁ, theo
   * mô hình xoá mềm có truy vết — sửa nội dung tin đã gửi không nằm
   * trong chính sách).
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
   * Xoá mềm một tin nhắn (Lớp B — thay tính bất biến tuyệt đối cũ):
   *   - NGƯỜI GỬI xoá tin của chính mình: tin biến mất khỏi tầm nhìn
   *     của mọi học sinh (kể cả chính người gửi), nhưng giáo viên phụ
   *     trách/quản trị vẫn truy vết được nội dung.
   *   - NGƯỜI CÓ THẨM QUYỀN KIỂM DUYỆT trên conversation (giáo viên
   *     phụ trách khoá / quản trị viên) xoá tin của bất kỳ ai: học
   *     sinh không còn thấy, phía có thẩm quyền vẫn thấy dấu vết.
   * Người khác (thành viên thường không phải tác giả) → 403. Dòng tin
   * KHÔNG bị xoá vật lý: chỉ ghi `deleted_at`/`deleted_by`, kèm sự
   * kiện outbox `message_deleted` cho realtime (client gỡ tin khỏi
   * khung) và cho event_log (truy vết ai đã xoá tin nào). Xoá lại tin
   * đã xoá là idempotent — dấu vết lần xoá đầu được giữ nguyên.
   */
  async deleteMessage(actorId: string, messageId: string): Promise<MessageRow> {
    const existing = await this.repo.getMessage(messageId);
    if (!existing) throw new NotFoundException({ message: `Message ${messageId} not found`, code: 'messaging.message_not_found' });
    const conversation = await this.repo.getConversation(existing.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${existing.conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    const isAuthor = existing.userIdFrom === actorId;
    if (!isAuthor && !(await this.canModerateConversation(actorId, conversation))) {
      throw new ForbiddenException({
        message: 'Only the author, the teacher in charge, or an administrator can delete this message',
        code: 'messaging.message_delete_forbidden',
      });
    }
    if (existing.deletedAt) return existing;
    const deleted = await this.repo.softDeleteMessage(messageId, actorId);
    const courseId = await this.resolveConversationCourseId(conversation);
    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'message_deleted',
      payload: {
        actorId, conversationId: conversation.id, messageId, seq: existing.seq,
        deletedBy: actorId, authorId: existing.userIdFrom, courseId: courseId ?? undefined,
      },
    });
    return deleted!;
  }

  // --- báo cáo conversation (Lớp B) -------------------------------------------

  /**
   * Báo cáo một conversation: chỉ THÀNH VIÊN của conversation báo cáo
   * được. Báo cáo vào hàng đợi của giáo viên phụ trách lớp/khoá liên
   * quan + quản trị viên toàn site — hai tập này nhận notification
   * trong ứng dụng ngay khi báo cáo được tạo (trừ chính người báo cáo
   * nếu họ thuộc hai tập đó). Việc XEM lại nội dung đi đường riêng có
   * ghi vết ({@link getReportConversation}).
   */
  async reportConversation(actorId: string, conversationId: string, reason?: string): Promise<ReportRow> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    if (!(await this.repo.isMember(conversationId, actorId))) {
      throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
    }
    const report = await this.repo.insertReport({
      conversationId, reporterId: actorId, reason: (reason ?? '').trim(),
    });
    const courseId = await this.resolveConversationCourseId(conversation);
    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'message_conversation_reported',
      payload: { actorId, conversationId, reportId: report.id, courseId: courseId ?? undefined },
    });
    const recipients = new Set<string>(await this.evaluator.listSiteAdmins());
    if (courseId) {
      for (const staffId of await this.repo.listCourseStaffUserIds(courseId)) recipients.add(staffId);
    }
    recipients.delete(actorId);
    for (const recipientId of recipients) {
      await this.notify(recipientId, 'conversation_reported', {
        subject: 'A conversation was reported',
        body: 'A conversation was reported and is waiting in the moderation queue. Open the reports list in Messages to review it.',
        fromUserId: actorId,
      }).catch(() => undefined);
    }
    return report;
  }

  /**
   * Hàng đợi báo cáo TRONG THẨM QUYỀN của người gọi: quản trị viên
   * thấy tất cả; giáo viên chỉ thấy báo cáo của các conversation thuộc
   * khoá mình phụ trách; người khác thấy danh sách rỗng. Quyền xem
   * theo từng conversation được chốt tại đây (không tin client).
   */
  async listReports(actorId: string): Promise<ReportRow[]> {
    const reports = await this.repo.listReports();
    const admin = await this.evaluator.isSiteAdmin(actorId);
    if (admin) return reports;
    const cache = new Map<string, boolean>();
    const out: ReportRow[] = [];
    for (const report of reports) {
      let allowed = cache.get(report.conversationId);
      if (allowed === undefined) {
        const conversation = await this.repo.getConversation(report.conversationId);
        allowed = conversation ? await this.canModerateConversation(actorId, conversation) : false;
        cache.set(report.conversationId, allowed);
      }
      if (allowed) out.push(report);
    }
    return out;
  }

  /**
   * Xem lại nội dung của ĐÚNG conversation bị báo cáo — đường truy vết
   * có thẩm quyền của Lớp B: chỉ quản trị viên hoặc giáo viên phụ trách
   * khoá của conversation đó. Nội dung trả về GỒM cả tin đã xoá mềm
   * (mục đích của việc xem lại là truy vết). MỌI lần xem đều ghi một
   * sự kiện outbox `message_conversation_report_viewed` — relay của
   * logstore (issue #22) phản chiếu nó vào event_log với actor là
   * người xem, object là conversation, kèm id báo cáo làm căn cứ.
   */
  async getReportConversation(actorId: string, reportId: string): Promise<{
    report: ReportRow;
    conversation: ConversationRow & { members: string[]; messages: MessageRow[] };
  }> {
    const report = await this.repo.getReport(reportId);
    if (!report) throw new NotFoundException({ message: `Report ${reportId} not found`, code: 'messaging.report_not_found' });
    const conversation = await this.repo.getConversation(report.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${report.conversationId} not found`, code: 'messaging.conversation_not_found' });
    if (!(await this.canModerateConversation(actorId, conversation))) {
      throw new ForbiddenException({
        message: 'Only an administrator or the teacher in charge of this conversation\'s course can review a reported conversation',
        code: 'messaging.report_review_forbidden',
      });
    }
    const courseId = await this.resolveConversationCourseId(conversation);
    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'message_conversation_report_viewed',
      payload: { actorId, conversationId: conversation.id, reportId: report.id, courseId: courseId ?? undefined },
    });
    const messages = await this.repo.listMessages(conversation.id, { limit: 100, includeDeleted: true });
    return {
      report,
      conversation: {
        ...conversation,
        members: await this.repo.listMembers(conversation.id),
        messages,
      },
    };
  }

  /**
   * Đổi trạng thái xử lý của một báo cáo (open/resolved/dismissed) —
   * cùng phạm vi thẩm quyền với đường xem lại nội dung.
   */
  async updateReportStatus(actorId: string, reportId: string, status: string): Promise<ReportRow> {
    const report = await this.repo.getReport(reportId);
    if (!report) throw new NotFoundException({ message: `Report ${reportId} not found`, code: 'messaging.report_not_found' });
    const conversation = await this.repo.getConversation(report.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${report.conversationId} not found`, code: 'messaging.conversation_not_found' });
    if (!(await this.canModerateConversation(actorId, conversation))) {
      throw new ForbiddenException({
        message: 'Only an administrator or the teacher in charge of this conversation\'s course can handle its reports',
        code: 'messaging.report_review_forbidden',
      });
    }
    const updated = await this.repo.updateReportStatus(reportId, status, actorId);
    return updated!;
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
