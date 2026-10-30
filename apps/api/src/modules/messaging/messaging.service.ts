import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type MessageEvent } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import type { Queue } from 'bullmq';
import type { Observable } from 'rxjs';
import type { NotificationGroupPage, NotificationItemPage } from '@lms/contracts';
import type { ListNotificationGroupsQueryDto, ListNotificationItemsQueryDto, ReadNotificationGroupDto } from './dto/messaging.dto';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { UsersService } from '../users/users.service';
import { MessagingRepository, type ConversationRow, type MessageRow, type MessageWithQuoteRow, type ReportRow } from './messaging.repository';
import { MessagingRealtimeService } from './messaging-realtime.service';
import { MessagingSendThrottleService } from './messaging-send-throttle.service';
import { NotificationUnreadStreamService } from './notification-unread-stream.service';
import {
  type EmailFrequency,
  type LoginState,
  type MessageChannel,
  type MessageProviderDefinition,
  type NotificationAudience,
  type NotificationCourseOverrideMode,
  type NotificationCourseOverrideView,
  type NotificationPreferenceView,
  type NotifyResult,
} from './notification-providers';
import { MessagingContactsService, type PersonSummaryView } from './messaging-contacts.service';
import { MessagingConversationsService } from './messaging-conversations.service';
import { MessagingGroupTreeService, type ClassRosterMemberView, type ConversationGroupTreeView, type CourseRosterMemberView, type MessagingCourseView } from './messaging-group-tree.service';
import { MessagingMembershipSyncService } from './messaging-membership-sync.service';
import { MessagingMessagesService } from './messaging-messages.service';
import { MessagingNotificationsService, NOTIFICATION_DISPATCH_QUEUE } from './messaging-notifications.service';

export {
  MESSAGE_CHANNELS,
  MESSAGE_PROVIDERS,
  providerByName,
  externalPolicyOf,
  providerVisibleToAudiences,
  isTeacherOnlyProvider,
  preferenceName,
  preferenceNameV2,
  coursePreferenceName,
  isExemptFromCourseMute,
  EMAIL_CHANNEL_AVAILABLE,
  NOTIFICATION_POLICY_COMPONENT,
  notificationPolicySettingName,
  MANDATORY_NOTIFICATION_PROVIDERS,
  type MessageChannel,
  type LoginState,
  type MessageProviderGroup,
  type EmailFrequency,
  type ExternalContentPolicy,
  type MessageProviderDefinition,
  type NotificationAudience,
  type NotificationPreferenceView,
  type NotifyResult,
  type NotificationCourseOverrideMode,
  type NotificationCourseOverrideView,
} from './notification-providers';

export { NOTIFICATION_DISPATCH_QUEUE, type NotificationChannelPort } from './messaging-notifications.service';
export { displayNameOf, type ContactRelationship, type PersonSummaryView } from './messaging-contacts.service';
export {
  ROSTER_DEFAULT_PAGE_SIZE,
  ROSTER_MAX_PAGE_SIZE,
  type ClassRosterMemberView,
  type ConversationGroupTreeView,
  type ConversationTreeClassView,
  type ConversationTreeCourseView,
  type ConversationTreeFreeGroupView,
  type ConversationTreeGroupView,
  type ConversationTreeRole,
  type CourseRosterMemberView,
  type MessagingCourseView,
} from './messaging-group-tree.service';
export { countUserVisibleCharacters, isWithinRecallWindow } from './messaging-messages.service';

/**
 * Facade của MessagingModule (core_message của Moodle):
 *  - CONVERSATION + MESSAGE là user-tới-user. Sau khi gửi, quyền sở hữu của
 *    một message chuyển cho core_message: KHÔNG endpoint nào sửa hoặc xoá nó
 *    (xoá mềm có truy vết là chặng sau của Lớp B, issue #33).
 *  - NOTIFICATION là message hệ thống do các provider đã đăng ký tạo và
 *    được phân phối theo tuỳ chọn (provider × channel × loggedin/loggedoff)
 *    lưu trong user_preferences.
 *  - Một user bị suspended (hoặc đã xoá) KHÔNG NHẬN gì: không phân phối message,
 *    không notification, trên bất kỳ kênh nào. Một user đã chặn người gửi cũng
 *    không nhận message của họ.
 *  - Phân phối kênh ngoài đi qua hàng đợi BullMQ 'notification-dispatch'
 *    do worker tiêu thụ. Từ NB-5 (issue #174) kênh email gửi thật qua
 *    Resend ở phía worker (gửi ngay, hoặc qua tổng hợp theo ngày với
 *    tần suất 'daily'); push vẫn là cổng chỉ ghi log (chưa có ứng
 *    dụng native).
 */

@Injectable()
/**
 * Nhắn tin và thông báo.
 * Đối chiếu Moodle: message/classes (api, output) và message providers.
 * Quy tắc: người bị chặn không gửi được tin; notification được tạo theo provider và phân phối theo
 * tuỳ chọn kênh của người nhận (logged-in/logged-off), mọi lần phân phối đều ghi dispatch log;
 * chuỗi hiển thị của notification do tầng tạo nội dung lấy từ catalog i18n.
 * Cổng liên lạc (đã chốt lại 24/10/2026 trên issue #33): nhắn riêng 1-1 CHỈ
 * giữa liên hệ ĐÃ ĐƯỢC DUYỆT (luồng yêu cầu–chấp nhận) — cổng "cùng khoá"
 * đã bỏ và setting site `core/messagingallusers` không còn hiệu lực với
 * tin nhắn (mục cấu hình vẫn nằm trong registry nhưng không cổng nào đọc
 * nó nữa). Khám phá bạn bè đi qua roster thành viên khoá, không còn tìm
 * người theo tên. Notification hệ thống không qua cổng liên lạc này.
 * Conversation gắn course group (component core_group) đồng bộ thành viên
 * theo group mỗi lần liệt kê/mở/gửi (đồng bộ lười phía messaging).
 * Conversation CẤP KHOÁ (chat toàn lớp, component core_course/itemType
 * course) cùng cơ chế: cấp phát lười khi thành viên/staff mở, thành viên
 * = ghi danh hiệu lực ∪ staff khoá, đồng bộ lười mỗi lần liệt kê/mở/gửi.
 *
 * Tách cụm (issue #295): toàn bộ logic nằm ở năm service cụm —
 * MessagingNotificationsService (tuỳ chọn + phát thông báo),
 * MessagingContactsService (liên hệ/chặn), MessagingGroupTreeService
 * (cây nhóm/roster), MessagingConversationsService (hội thoại),
 * MessagingMessagesService (tin nhắn/kiểm duyệt) — cộng service hỗ
 * trợ MessagingMembershipSyncService (đồng bộ thành viên các
 * conversation gắn cấu trúc). Class này là FACADE: giữ nguyên bề mặt
 * công khai, chữ ký constructor (khớp main hiện tại, gồm tham số
 * I18nService thứ 11 mà main bổ sung cho luật C-5) và cách module
 * lắp ráp; constructor
 * tự dựng các service cụm từ đúng các phụ thuộc hạ tầng cũ, mọi
 * method uỷ quyền thẳng cho service cụm sở hữu (đặc tả luồng đầy đủ
 * nằm ở docblock của method đích). Nhờ vậy hợp đồng khởi tạo trực
 * tiếp `new MessagingService(...)` của các test đơn vị hiện hữu
 * không đổi.
 */
export class MessagingService {
  private readonly notifications: MessagingNotificationsService;
  private readonly contacts: MessagingContactsService;
  private readonly groupTree: MessagingGroupTreeService;
  private readonly conversations: MessagingConversationsService;
  private readonly messages: MessagingMessagesService;

  constructor(
    private readonly repo: MessagingRepository,
    private readonly users: UsersService,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly outbox: OutboxService,
    private readonly realtime: MessagingRealtimeService,
    private readonly unreadStream: NotificationUnreadStreamService,
    @InjectQueue(NOTIFICATION_DISPATCH_QUEUE) private readonly dispatchQueue: Queue,
    private readonly siteConfig: SiteConfigService,
    private readonly sendThrottle: MessagingSendThrottleService,
    // I18n (tham số thứ 11): notify() dùng để dựng BẢN TÓM TẮT MẶC
    // ĐỊNH cho kênh ngoài theo luật C-5 (issue #219) khi provider
    // thuộc diện tối thiểu hoá mà nơi gọi không truyền bản tối
    // thiểu hoá.
    private readonly i18n: I18nService,
  ) {
    const membershipSync = new MessagingMembershipSyncService(this.repo, this.realtime);
    this.groupTree = new MessagingGroupTreeService(this.repo, membershipSync);
    this.notifications = new MessagingNotificationsService(
      this.repo, this.users, this.evaluator, this.outbox, this.unreadStream,
      this.dispatchQueue, this.siteConfig, this.groupTree, this.i18n,
    );
    this.contacts = new MessagingContactsService(this.repo, this.users, this.realtime, this.notifications);
    this.conversations = new MessagingConversationsService(
      this.repo, this.users, this.evaluator, this.contexts, this.contacts, membershipSync,
    );
    this.messages = new MessagingMessagesService(
      this.repo, this.users, this.evaluator, this.contexts, this.outbox, this.siteConfig,
      this.sendThrottle, this.conversations, this.contacts, this.notifications, membershipSync,
    );
  }
  // --- cụm tuỳ chọn + phát thông báo (MessagingNotificationsService) ---

  /**
   * Chính sách phát của ADMIN ở cấp site cho một provider (NB-7,
   * Uỷ quyền cho MessagingNotificationsService.isProviderEnabledBySitePolicy — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async isProviderEnabledBySitePolicy(provider: MessageProviderDefinition): Promise<boolean> {
    return this.notifications.isProviderEnabledBySitePolicy(provider);
  }

  /**
   * User có được toàn bộ bề mặt tuỳ chọn theo loại (v2) hay chỉ bề
   * Uỷ quyền cho MessagingNotificationsService.hasFullNotificationPreferences — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async hasFullNotificationPreferences(userId: string): Promise<boolean> {
    return this.notifications.hasFullNotificationPreferences(userId);
  }

  /**
   * Tập CONTEXT VAI thật của user cho tầng phân chia tuỳ chọn thông
   * Uỷ quyền cho MessagingNotificationsService.resolvePreferenceAudiences — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async resolvePreferenceAudiences(userId: string): Promise<Set<NotificationAudience>> {
    return this.notifications.resolvePreferenceAudiences(userId);
  }

  /**
   * Kênh có đang bật cho provider này theo tuỳ chọn của user (phân biệt logged-in/logged-off) hay không.
   * Uỷ quyền cho MessagingNotificationsService.isChannelEnabled — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async isChannelEnabled(userId: string, provider: string, channel: MessageChannel, state: LoginState): Promise<boolean> {
    return this.notifications.isChannelEnabled(userId, provider, channel, state);
  }

  /**
   * Giá trị tuỳ chọn v2 HIỆU LỰC của một provider cho một user: khoá
   * Uỷ quyền cho MessagingNotificationsService.resolveNotificationPreference — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async resolveNotificationPreference(userId: string, provider: MessageProviderDefinition): Promise<{ popupEnabled: boolean; emailFrequency: EmailFrequency | null }> {
    return this.notifications.resolveNotificationPreference(userId, provider);
  }

  /**
   * Tuỳ chọn notification v2 của user: một dòng cho mỗi provider đã
   * Uỷ quyền cho MessagingNotificationsService.getPreferences — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async getPreferences(userId: string): Promise<NotificationPreferenceView[]> {
    return this.notifications.getPreferences(userId);
  }

  /**
   * Đặt tuỳ chọn v2 cho MỘT provider (popup và/hoặc tần suất email).
   * Uỷ quyền cho MessagingNotificationsService.setPreference — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async setPreference(userId: string, input: { provider: string; popupEnabled?: boolean; emailFrequency?: EmailFrequency }): Promise<NotificationPreferenceView> {
    return this.notifications.setPreference(userId, input);
  }

  /**
   * Uỷ quyền cho MessagingNotificationsService.getCourseOverrideMode — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async getCourseOverrideMode(userId: string, courseId: string): Promise<NotificationCourseOverrideMode> {
    return this.notifications.getCourseOverrideMode(userId, courseId);
  }

  /**
   * Ghi đè theo khoá của user (NB-4): một dòng cho MỖI khoá người
   * Uỷ quyền cho MessagingNotificationsService.listCourseNotificationOverrides — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listCourseNotificationOverrides(userId: string): Promise<NotificationCourseOverrideView[]> {
    return this.notifications.listCourseNotificationOverrides(userId);
  }

  /**
   * Đặt ghi đè cho MỘT khoá ('all' | 'mute') — hiệu lực ngay ở lần
   * Uỷ quyền cho MessagingNotificationsService.setCourseNotificationOverride — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async setCourseNotificationOverride(
    userId: string,
    input: { courseId: string; mode: NotificationCourseOverrideMode },
  ): Promise<NotificationCourseOverrideView> {
    return this.notifications.setCourseNotificationOverride(userId, input);
  }

  /**
   * Tạo một notification hệ thống cho một user qua một provider đã đăng ký.
   * Uỷ quyền cho MessagingNotificationsService.notify — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async notify(userId: string, providerName: string, input: {
    subject: string; body: string; contextUrl?: string; fromUserId?: string; loggedIn?: boolean;
    externalSubject?: string; externalBody?: string;
    /**
     * Áp cứng chính sách `'minimized'` bất kể khai báo registry
     * (C-5): CHỈ `sendSystemNotification` truyền cờ này — nội dung
     * của đường đó là văn bản tự do do quản trị viên soạn và
     * provider do DTO quyết định, nên không được hưởng ngoại lệ
     * `'original-ok'` của bất kỳ provider nào. Khi cờ này bật, việc
     * thay nội dung kênh ngoài bằng bản tóm tắt mặc định là hành vi
     * đã thiết kế nên KHÔNG ném lỗi kể cả ở môi trường test.
     */
    forceExternalMinimized?: boolean;
    /**
     * Khoá nguồn của sự kiện (NB-4): nơi phát nào biết sự kiện thuộc
     * khoá nào thì truyền vào để notify() áp ghi đè tắt tiếng theo
     * khoá của người nhận. Không truyền = sự kiện không gắn khoá, ghi
     * đè theo khoá không áp dụng (hành vi như trước NB-4).
     */
    courseId?: string;
    /**
     * Tenant của notification (TENANT-1, #196): nơi gọi biết đối tượng
     * nguồn (khoá/conversation/liên kết giám hộ) thì truyền tường minh;
     * không truyền thì lấy ngữ cảnh ALS của luồng, cuối cùng là tenant
     * mặc định của người nhận theo membership active. Mọi dedupe_key
     * dispatch mang tiền tố tenant, nối bằng dấu '-' — dedupe_key của
     * kênh ngoài đồng thời là jobId BullMQ, mà BullMQ cấm ký tự ':'
     * trong custom jobId (bài học TENANT-1: tiền tố '{tenant}:' làm
     * queue.add ném lỗi giữa notify, digest kẹt trạng thái queued).
     */
    tenantId?: string | null;
  }): Promise<NotifyResult> {
    return this.notifications.notify(userId, providerName, input);
  }

  /**
   * Gửi notification hệ thống (vd hoàn tất báo cáo) kèm nội dung đã dịch.
   * Uỷ quyền cho MessagingNotificationsService.sendSystemNotification — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async sendSystemNotification(actorId: string, dto: { userId: string; provider: string; subject: string; body: string; contextUrl?: string }): Promise<NotifyResult> {
    return this.notifications.sendSystemNotification(actorId, dto);
  }

  /**
   * Trung tâm thông báo v2 (issue #51) — danh sách GỘP theo
   * Uỷ quyền cho MessagingNotificationsService.listNotificationGroups — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listNotificationGroups(userId: string, query: ListNotificationGroupsQueryDto): Promise<NotificationGroupPage> {
    return this.notifications.listNotificationGroups(userId, query);
  }

  /**
   * Trung tâm v2 — danh sách PHẲNG phân trang con trỏ: bộ lọc
   * Uỷ quyền cho MessagingNotificationsService.listNotificationItems — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listNotificationItems(userId: string, query: ListNotificationItemsQueryDto): Promise<NotificationItemPage> {
    return this.notifications.listNotificationItems(userId, query);
  }

  /**
   * Trung tâm v2 — đánh dấu đã đọc HÀNG LOẠT theo khoá gộp
   * Uỷ quyền cho MessagingNotificationsService.markNotificationGroupRead — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async markNotificationGroupRead(userId: string, dto: ReadNotificationGroupDto): Promise<{ marked: number }> {
    return this.notifications.markNotificationGroupRead(userId, dto);
  }

  /**
   * Trung tâm v2 — xoá MỘT thông báo của chính mình; thông báo của
   * Uỷ quyền cho MessagingNotificationsService.deleteNotification — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async deleteNotification(userId: string, notificationId: string): Promise<{ deleted: boolean }> {
    return this.notifications.deleteNotification(userId, notificationId);
  }

  /**
   * Uỷ quyền cho MessagingNotificationsService.clearReadNotifications — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async clearReadNotifications(userId: string): Promise<{ deleted: number }> {
    return this.notifications.clearReadNotifications(userId);
  }

  /**
   * Số notification chưa đọc.
   * Uỷ quyền cho MessagingNotificationsService.unreadNotificationCount — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async unreadNotificationCount(userId: string): Promise<number> {
    return this.notifications.unreadNotificationCount(userId);
  }

  /**
   * Đánh dấu đã đọc.
   * Uỷ quyền cho MessagingNotificationsService.markNotificationRead — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async markNotificationRead(userId: string, notificationId: string): Promise<{ read: boolean }> {
    return this.notifications.markNotificationRead(userId, notificationId);
  }

  /**
   * Đánh dấu tất cả đã đọc.
   * Uỷ quyền cho MessagingNotificationsService.markAllNotificationsRead — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async markAllNotificationsRead(userId: string): Promise<{ marked: number }> {
    return this.notifications.markAllNotificationsRead(userId);
  }

  /**
   * Stream SSE số thông báo chưa đọc của chính user: snapshot số hiện
   * Uỷ quyền cho MessagingNotificationsService.unreadCountStream — đặc tả luồng đầy đủ nằm tại method đích.
   */
  unreadCountStream(userId: string): Observable<MessageEvent> {
    return this.notifications.unreadCountStream(userId);
  }

  /**
   * Nhật ký phân phối notification.
   * Uỷ quyền cho MessagingNotificationsService.listDispatchLog — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listDispatchLog(userId: string) {
    return this.notifications.listDispatchLog(userId);
  }

  // --- cụm liên hệ/chặn (MessagingContactsService) ---

  /**
   * Gửi yêu cầu kết bạn tới một user. Đã là liên hệ thì trả trạng thái
   * Uỷ quyền cho MessagingContactsService.requestContact — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async requestContact(userId: string, contactId: string): Promise<{ status: 'pending' | 'accepted'; contacts: string[] }> {
    return this.contacts.requestContact(userId, contactId);
  }

  /**
   * Các yêu cầu kết bạn của tôi: `incoming` là yêu cầu người khác gửi
   * Uỷ quyền cho MessagingContactsService.listContactRequests — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listContactRequests(userId: string): Promise<{
    incoming: { userId: string; createdAt: Date; displayName: string; username: string }[];
    outgoing: { userId: string; createdAt: Date; displayName: string; username: string }[];
  }> {
    return this.contacts.listContactRequests(userId);
  }

  /**
   * Tóm tắt hiển thị (tên + username) cho một tập user id — các
   * Uỷ quyền cho MessagingContactsService.profilesFor — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async profilesFor(userIds: string[]): Promise<Record<string, PersonSummaryView>> {
    return this.contacts.profilesFor(userIds);
  }

  /**
   * Chấp nhận yêu cầu kết bạn TỪ requesterId: quan hệ hình thành ở cả
   * Uỷ quyền cho MessagingContactsService.acceptContactRequest — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async acceptContactRequest(userId: string, requesterId: string): Promise<{ contacts: string[] }> {
    return this.contacts.acceptContactRequest(userId, requesterId);
  }

  /**
   * Từ chối yêu cầu kết bạn TỪ requesterId: yêu cầu biến mất, quan hệ
   * Uỷ quyền cho MessagingContactsService.declineContactRequest — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async declineContactRequest(userId: string, requesterId: string): Promise<{ declined: boolean }> {
    return this.contacts.declineContactRequest(userId, requesterId);
  }

  /**
   * Gỡ một liên hệ đã duyệt: quan hệ mất ở CẢ hai phía (cổng liên lạc
   * Uỷ quyền cho MessagingContactsService.removeContact — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async removeContact(userId: string, contactId: string): Promise<{ contacts: string[] }> {
    return this.contacts.removeContact(userId, contactId);
  }

  /**
   * Danh bạ của tôi (chỉ các liên hệ ĐÃ ĐƯỢC DUYỆT).
   * Uỷ quyền cho MessagingContactsService.listContacts — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listContacts(userId: string): Promise<string[]> {
    return this.contacts.listContacts(userId);
  }

  // --- cụm cây nhóm/roster (MessagingGroupTreeService) ---

  /**
   * Các khoá mà người dùng thuộc về (ghi danh hiệu lực ∪ gán vai tại
   * Uỷ quyền cho MessagingGroupTreeService.listMyMessagingCourses — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listMyMessagingCourses(actorId: string): Promise<MessagingCourseView[]> {
    return this.groupTree.listMyMessagingCourses(actorId);
  }

  /**
   * CÂY NHÓM của chính người gọi (lát MSG-T1, issue #33 — thiết kế
   * Uỷ quyền cho MessagingGroupTreeService.getGroupTree — đặc tả luồng đầy đủ nằm tại method đích.
   * Cờ `canCreateFreeGroup` của cây do facade tính tại đây bằng ĐÚNG
   * cổng tạo nhóm tự do của cụm hội thoại
   * (MessagingConversationsService.canCreateFreeGroup) cho tenant
   * hiện hành, để nút tạo nhóm phía web khớp tuyệt đối với cổng API.
   */
  async getGroupTree(actorId: string): Promise<ConversationGroupTreeView> {
    const canCreateFreeGroup = await this.conversations.canCreateFreeGroup(actorId);
    return this.groupTree.getGroupTree(actorId, canCreateFreeGroup);
  }

  /**
   * Một trang roster thành viên của một khoá — đường khám phá bạn bè
   * Uỷ quyền cho MessagingGroupTreeService.listCourseRoster — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listCourseRoster(actorId: string, courseId: string, query: { limit?: number; cursor?: string }): Promise<{
    members: CourseRosterMemberView[];
    nextCursor: string | null;
  }> {
    return this.groupTree.listCourseRoster(actorId, courseId, query);
  }

  /**
   * Một trang roster thành viên của một LỚP — bản cấp lớp của roster
   * Uỷ quyền cho MessagingGroupTreeService.listClassRoster — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listClassRoster(actorId: string, classId: string, query: { limit?: number; cursor?: string }): Promise<{
    members: ClassRosterMemberView[];
    nextCursor: string | null;
  }> {
    return this.groupTree.listClassRoster(actorId, classId, query);
  }

  // --- cụm liên hệ/chặn (MessagingContactsService) ---

  /**
   * Chặn một liên hệ.
   * Uỷ quyền cho MessagingContactsService.blockContact — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async blockContact(userId: string, blockedUserId: string): Promise<{ blocked: string[] }> {
    return this.contacts.blockContact(userId, blockedUserId);
  }

  /**
   * Bỏ chặn liên hệ.
   * Uỷ quyền cho MessagingContactsService.unblockContact — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async unblockContact(userId: string, blockedUserId: string): Promise<{ blocked: string[] }> {
    return this.contacts.unblockContact(userId, blockedUserId);
  }

  /**
   * Danh sách liên hệ bị chặn.
   * Uỷ quyền cho MessagingContactsService.listBlocked — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listBlocked(userId: string): Promise<string[]> {
    return this.contacts.listBlocked(userId);
  }

  /**
   * User có bị người kia chặn hay không.
   * Uỷ quyền cho MessagingContactsService.isBlockedBy — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async isBlockedBy(blockerId: string, senderId: string): Promise<boolean> {
    return this.contacts.isBlockedBy(blockerId, senderId);
  }

  // --- cụm hội thoại (MessagingConversationsService) ---

  /**
   * Tạo conversation (nhóm hoặc 1-1; 1-1 đã tồn tại thì dùng lại). Tạo MỚI
   * Uỷ quyền cho MessagingConversationsService.createConversation — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async createConversation(actorId: string, input: { type?: number; memberIds: string[]; name?: string }): Promise<ConversationRow & { members: string[] }> {
    return this.conversations.createConversation(actorId, input);
  }

  /**
   * Tạo (hoặc lấy lại) conversation của một course group: component
   * Uỷ quyền cho MessagingConversationsService.createGroupConversation — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async createGroupConversation(actorId: string, input: { groupId: string; name?: string }): Promise<ConversationRow & { members: string[] }> {
    return this.conversations.createGroupConversation(actorId, input);
  }

  /**
   * Mở (ensure) conversation của CHÍNH khoá — chat toàn lớp: component
   * Uỷ quyền cho MessagingConversationsService.ensureCourseConversation — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async ensureCourseConversation(actorId: string, courseId: string): Promise<ConversationRow & { members: string[] }> {
    return this.conversations.ensureCourseConversation(actorId, courseId);
  }

  /**
   * Mở (ensure) conversation của CHÍNH lớp — chat cấp lớp: component
   * Uỷ quyền cho MessagingConversationsService.ensureClassConversation — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async ensureClassConversation(actorId: string, classId: string): Promise<ConversationRow & { members: string[] }> {
    return this.conversations.ensureClassConversation(actorId, classId);
  }

  /**
   * Bật/tắt chat của một conversation (Lớp B — chốt "nhóm lớp mặc
   * Uỷ quyền cho MessagingConversationsService.updateConversation — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async updateConversation(actorId: string, conversationId: string, input: { enabled: boolean }): Promise<ConversationRow & { members: string[] }> {
    return this.conversations.updateConversation(actorId, conversationId, input);
  }

  /**
   * Gỡ một thành viên khỏi NHÓM TỰ DO (lát MSG-T4, issue #33 — hành
   * Uỷ quyền cho MessagingConversationsService.removeConversationMember — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async removeConversationMember(actorId: string, conversationId: string, targetUserId: string): Promise<ConversationRow & { members: string[] }> {
    return this.conversations.removeConversationMember(actorId, conversationId, targetUserId);
  }

  /**
   * Đặt trạng thái cá nhân của CHÍNH thành viên trên một conversation
   * Uỷ quyền cho MessagingConversationsService.updateConversationState — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async updateConversationState(
    userId: string,
    conversationId: string,
    input: { pinned?: boolean; archived?: boolean; muted?: boolean },
  ): Promise<{ conversationId: string; pinned: boolean; pinnedAt: Date | null; archived: boolean; archivedAt: Date | null; muted: boolean }> {
    return this.conversations.updateConversationState(userId, conversationId, input);
  }

  /**
   * Conversation của user kèm số chưa đọc, tin cuối và mốc đã đọc của
   * Uỷ quyền cho MessagingConversationsService.listConversations — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listConversations(userId: string, opts: { archivedOnly?: boolean } = {}): Promise<(ConversationRow & {
    members: string[]; unread: number; lastReadSeq: number; lastMessage: MessageRow | null;
    pinnedAt: Date | null; archivedAt: Date | null; muted: boolean;
    memberProfiles: Record<string, PersonSummaryView>;
  })[]> {
    return this.conversations.listConversations(userId, opts);
  }

  /**
   * Chi tiết conversation + một cửa sổ tin nhắn mới nhất theo cursor
   * Uỷ quyền cho MessagingConversationsService.getConversation — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async getConversation(userId: string, conversationId: string, opts: { limit?: number } = {}): Promise<ConversationRow & {
    members: string[]; messages: MessageWithQuoteRow[]; hasMoreBefore: boolean;
    lastReadSeq: number; memberReadMarkers: { userId: string; lastReadSeq: number }[];
    memberProfiles: Record<string, PersonSummaryView>;
    canModerate: boolean; canManage: boolean;
  }> {
    return this.conversations.getConversation(userId, conversationId, opts);
  }

  // --- cụm tin nhắn/kiểm duyệt (MessagingMessagesService) ---

  /**
   * Một cửa sổ tin theo cursor seq của conversation (tải lịch sử cũ
   * Uỷ quyền cho MessagingMessagesService.listConversationMessages — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listConversationMessages(userId: string, conversationId: string, query: {
    beforeSeq?: number; afterSeq?: number; limit?: number;
  }): Promise<{ messages: MessageWithQuoteRow[]; hasMoreBefore: boolean }> {
    return this.messages.listConversationMessages(userId, conversationId, query);
  }

  /**
   * Tìm nội dung tin TRONG một conversation (lát M4, issue #237):
   * Uỷ quyền cho MessagingMessagesService.searchConversationMessages — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async searchConversationMessages(userId: string, conversationId: string, query: {
    q: string; limit?: number;
  }): Promise<{ results: { id: string; conversationId: string; userIdFrom: string; seq: number; excerpt: string; createdAt: Date }[] }> {
    return this.messages.searchConversationMessages(userId, conversationId, query);
  }

  /**
   * Gửi một message user-tới-user. Luật phân phối (report §2#12): mọi thành viên khác
   * Uỷ quyền cho MessagingMessagesService.sendMessage — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async sendMessage(actorId: string, conversationId: string, input: { text: string; subject?: string; clientMessageId?: string; replyToMessageId?: string }): Promise<MessageWithQuoteRow> {
    return this.messages.sendMessage(actorId, conversationId, input);
  }

  /**
   * Sửa tin nhắn vẫn bị từ chối (chính sách đã chốt chỉ nới XOÁ, theo
   * Uỷ quyền cho MessagingMessagesService.updateMessage — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async updateMessage(): Promise<never> {
    return this.messages.updateMessage();
  }

  /**
   * Lớp (a) — XOÁ-PHÍA-MÌNH: tác giả ẩn tin của chính mình khỏi tầm
   * Uỷ quyền cho MessagingMessagesService.deleteMessage — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async deleteMessage(actorId: string, messageId: string): Promise<MessageRow> {
    return this.messages.deleteMessage(actorId, messageId);
  }

  /**
   * Lớp (b) — THU HỒI cho mọi người: chỉ tác giả, chỉ trong cửa sổ
   * Uỷ quyền cho MessagingMessagesService.recallMessage — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async recallMessage(actorId: string, messageId: string): Promise<MessageRow> {
    return this.messages.recallMessage(actorId, messageId);
  }

  /**
   * Lớp (c) — XOÁ CỨNG một tin: chỉ moderator có `moderation:manage`
   * Uỷ quyền cho MessagingMessagesService.hardDeleteMessage — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async hardDeleteMessage(actorId: string, messageId: string, input: { reason: string }): Promise<{ deleted: true; messageId: string; conversationId: string }> {
    return this.messages.hardDeleteMessage(actorId, messageId, input);
  }

  /**
   * Lớp (c) — GỠ HÀNG LOẠT: cùng cổng thẩm quyền và lý do bắt buộc
   * Uỷ quyền cho MessagingMessagesService.bulkRemoveMessages — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async bulkRemoveMessages(actorId: string, input: { messageIds: string[]; reason: string }): Promise<{ removed: number; messageIds: string[] }> {
    return this.messages.bulkRemoveMessages(actorId, input);
  }

  /**
   * Báo cáo một conversation: chỉ THÀNH VIÊN của conversation báo cáo
   * Uỷ quyền cho MessagingMessagesService.reportConversation — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async reportConversation(actorId: string, conversationId: string, reason?: string): Promise<ReportRow> {
    return this.messages.reportConversation(actorId, conversationId, reason);
  }

  /**
   * Hàng đợi báo cáo TRONG THẨM QUYỀN của người gọi: quản trị viên
   * Uỷ quyền cho MessagingMessagesService.listReports — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async listReports(actorId: string): Promise<ReportRow[]> {
    return this.messages.listReports(actorId);
  }

  /**
   * Xem lại nội dung của ĐÚNG conversation bị báo cáo — đường truy vết
   * Uỷ quyền cho MessagingMessagesService.getReportConversation — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async getReportConversation(actorId: string, reportId: string): Promise<{
    report: ReportRow;
    conversation: ConversationRow & { members: string[]; messages: MessageRow[] };
  }> {
    return this.messages.getReportConversation(actorId, reportId);
  }

  /**
   * Đổi trạng thái xử lý của một báo cáo (open/resolved/dismissed) —
   * Uỷ quyền cho MessagingMessagesService.updateReportStatus — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async updateReportStatus(actorId: string, reportId: string, status: string): Promise<ReportRow> {
    return this.messages.updateReportStatus(actorId, reportId, status);
  }

  /**
   * Đánh dấu đã đọc conversation: chỉ nâng mốc đã đọc của CHÍNH user
   * Uỷ quyền cho MessagingMessagesService.markConversationRead — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async markConversationRead(userId: string, conversationId: string): Promise<{ marked: number; lastReadSeq: number }> {
    return this.messages.markConversationRead(userId, conversationId);
  }

  /**
   * Số conversation chưa đọc và số notification chưa đọc (cho huy hiệu trên giao diện).
   * Uỷ quyền cho MessagingMessagesService.unreadCounts — đặc tả luồng đầy đủ nằm tại method đích.
   */
  async unreadCounts(userId: string): Promise<{ conversations: number; notifications: number }> {
    return this.messages.unreadCounts(userId);
  }
}
