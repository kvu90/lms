import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type MessageEvent } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Observable } from 'rxjs';
import type { NotificationGroup, NotificationGroupPage, NotificationItem, NotificationItemPage } from '@lms/contracts';
import type { ListNotificationGroupsQueryDto, ListNotificationItemsQueryDto, ReadNotificationGroupDto } from './dto/messaging.dto';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { UsersService } from '../users/users.service';
import { blankRecalledContent, MessagingRepository, searchExcerptOf, type ConversationRow, type MessageRow, type MessageWithQuoteRow, type NotificationRow, type ReportRow } from './messaging.repository';
import { MessagingRealtimeService } from './messaging-realtime.service';
import { MessagingSendThrottleService } from './messaging-send-throttle.service';
import { NotificationUnreadStreamService } from './notification-unread-stream.service';
import { tenantAls } from '../tenants/tenant-als';

import {
  MESSAGE_PROVIDERS,
  providerByName,
  eventTypesOfGroup,
  groupOfEventType,
  preferenceName,
  preferenceNameV2,
  coursePreferenceName,
  isExemptFromCourseMute,
  EMAIL_CHANNEL_AVAILABLE,
  defaultEmailFrequency,
  NOTIFICATION_POLICY_COMPONENT,
  notificationPolicySettingName,
  type MessageChannel,
  type LoginState,
  type MessageProviderGroup,
  type EmailFrequency,
  type MessageProviderDefinition,
  type NotificationPreferenceView,
  type NotifyResult,
  type NotificationCourseOverrideMode,
  type NotificationCourseOverrideView,
} from './notification-providers';
export {
  MESSAGE_CHANNELS,
  MESSAGE_PROVIDERS,
  providerByName,
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
  type MessageProviderDefinition,
  type NotificationPreferenceView,
  type NotifyResult,
  type NotificationCourseOverrideMode,
  type NotificationCourseOverrideView,
} from './notification-providers';


export const NOTIFICATION_DISPATCH_QUEUE = 'notification-dispatch';


/** Kích thước trang mặc định của trung tâm thông báo v2 (issue #51). */
const NOTIFICATION_PAGE_DEFAULT_LIMIT = 20;

/**
 * Con trỏ keyset của trung tâm v2: chuỗi mờ base64url của
 * `{ t, id }` — mốc (thời điểm, id) của dòng cuối trang trước. Client
 * chỉ truyền lại nguyên vẹn, không tự dựng.
 */
function encodeNotificationCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: at.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeNotificationCursor(raw: string): { at: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') throw new Error('bad cursor');
    const at = new Date(parsed.t);
    if (Number.isNaN(at.getTime())) throw new Error('bad cursor');
    return { at, id: parsed.id };
  } catch {
    throw new BadRequestException({ message: 'Invalid notification cursor', code: 'messaging.invalid_cursor' });
  }
}

/** Ánh xạ một dòng notifications sang hình dạng hợp đồng của trung tâm v2 (ngày giờ dạng ISO). */
function notificationItemView(row: NotificationRow): NotificationItem {
  return {
    id: row.id,
    userIdFrom: row.userIdFrom,
    userIdTo: row.userIdTo,
    subject: row.subject,
    fullMessage: row.fullMessage,
    smallMessage: row.smallMessage,
    component: row.component,
    eventType: row.eventType,
    contextUrl: row.contextUrl,
    contextUrlName: row.contextUrlName,
    timeRead: row.timeRead ? row.timeRead.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Đếm ký tự NGƯỜI DÙNG THẤY (grapheme cluster) của một đoạn văn bản —
 * cách đếm của trần độ dài tin (lát M2, issue #212): một emoji đơn,
 * một emoji ghép ZWJ (vd biểu tượng gia đình) hay một chữ cái kèm dấu
 * tổ hợp đều tính là MỘT ký tự, tuyệt đối không đếm byte UTF-8 hay đơn
 * vị UTF-16 (hai cách đếm đó phạt oan tiếng Việt và emoji nhiều lần).
 * `Intl.Segmenter` là API chuẩn của Node ≥ 16; môi trường thiếu nó thì
 * lùi về đếm theo code point Unicode ([...text]) — vẫn đúng hơn byte.
 */
export function countUserVisibleCharacters(text: string): number {
  const SegmenterCtor = (Intl as unknown as {
    Segmenter?: new (locales?: string, options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<unknown>;
    };
  }).Segmenter;
  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor(undefined, { granularity: 'grapheme' });
    let count = 0;
    for (const _segment of segmenter.segment(text)) count += 1;
    return count;
  }
  return [...text].length;
}

/** Tóm tắt hiển thị của một user trong các response của messaging (hợp đồng ở @lms/contracts). */
export interface PersonSummaryView {
  userId: string;
  displayName: string;
  username: string;
}

/** Trạng thái quan hệ của một người so với người đang tìm (hợp đồng ở @lms/contracts). */
export type ContactRelationship = 'contact' | 'pending_incoming' | 'pending_outgoing' | 'blocked' | 'none';

/** Một dòng roster thành viên khoá: tóm tắt hiển thị + dấu hiệu vai trò + trạng thái quan hệ với người xem. */
export interface CourseRosterMemberView extends PersonSummaryView {
  role: 'teacher' | 'student';
  relationship: ContactRelationship;
  /**
   * Người xem là giáo viên của khoá này và thành viên đang ghi danh
   * hiệu lực trong khoá → hai người nhắn riêng trực tiếp được không
   * cần kết bạn (ngoại lệ chốt bổ sung 25/10/2026 trên issue #33).
   * Web hiện nút "Nhắn tin" tại dòng theo cờ này; cổng API vẫn tự
   * kiểm lại quan hệ tại mỗi lần mở/gửi, cờ này chỉ là gợi ý hiển thị.
   */
  canDirectMessage: boolean;
}

/** Một khoá mà người dùng thuộc về — đầu vào của luồng tìm bạn theo khoá. */
export interface MessagingCourseView {
  courseId: string;
  fullName: string;
  shortName: string;
}

/** Vai của người gọi tại một nút cây nhóm (hợp đồng ở @lms/contracts, lát MSG-T1). */
export type ConversationTreeRole = 'teaching' | 'learning' | 'staff';

/** Nút NHÓM CON của cây nhóm: chat chưa ensure thì conversationId null + unread 0. */
export interface ConversationTreeGroupView {
  groupId: string;
  name: string;
  myRole: ConversationTreeRole;
  conversationId: string | null;
  unread: number;
}

/** Nút NHÓM TỰ DO của cây nhóm (conversation luôn đã tồn tại). */
export interface ConversationTreeFreeGroupView {
  conversationId: string;
  name: string;
  myRole: ConversationTreeRole;
  unread: number;
}

/** Nút KHOÁ của cây nhóm: unread gồm chat khoá + các nhóm con của nó. */
export interface ConversationTreeCourseView {
  courseId: string;
  name: string;
  myRole: ConversationTreeRole;
  conversationId: string | null;
  unread: number;
  groups: ConversationTreeGroupView[];
}

/** Nút LỚP của cây nhóm: unread là tổng của nút lớp + mọi nút con. */
export interface ConversationTreeClassView {
  classId: string;
  name: string;
  myRole: ConversationTreeRole;
  conversationId: string | null;
  unread: number;
  courses: ConversationTreeCourseView[];
}

/** CÂY NHÓM của chính người gọi (GET /messages/group-tree, lát MSG-T1). */
export interface ConversationGroupTreeView {
  classes: ConversationTreeClassView[];
  coursesOutsideClasses: ConversationTreeCourseView[];
  freeGroups: ConversationTreeFreeGroupView[];
}

/** Tên hiển thị của một user: "firstName lastName" đã cắt khoảng trắng; cả hai trống thì lùi về username. */
export function displayNameOf(user: { firstName: string; lastName: string; username: string }): string {
  const name = `${user.firstName} ${user.lastName}`.trim();
  return name || user.username;
}

/** Roster thành viên khoá: kích thước trang mặc định và trần cứng mỗi trang (phân trang con trỏ là bắt buộc — xem contracts). */
export const ROSTER_DEFAULT_PAGE_SIZE = 50;
export const ROSTER_MAX_PAGE_SIZE = 100;

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
/**
 * Tin có còn nằm trong CỬA SỔ THU HỒI hay không (vòng đời tin nhắn
 * theo vai, issue #33): thuần hàm thời gian để kiểm chứng đơn vị
 * tách khỏi DB — `windowMinutes <= 0` nghĩa là thu hồi đã TẮT (không
 * tin nào thu hồi được, kể cả tin vừa gửi); mốc biên ĐÚNG bằng cửa
 * sổ vẫn được tính là trong cửa sổ.
 */
export function isWithinRecallWindow(createdAt: Date, now: Date, windowMinutes: number): boolean {
  if (windowMinutes <= 0) return false;
  return now.getTime() - createdAt.getTime() <= windowMinutes * 60_000;
}

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
 */
export class MessagingService {
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
  ) {}

  // --- preferences -----------------------------------------------------------

  /**
   * Chính sách phát của ADMIN ở cấp site cho một provider (NB-7,
   * issue #174): đọc khoá `notifications/provider_<tên>_enabled` trong
   * site-config; chưa ghi đè = mặc định bật (hành vi trước NB-7). Loại
   * bắt buộc P2 luôn bật ở tầng này — SiteConfigService đã chặn không
   * cho admin đặt false, ở đây ép bật thêm một lớp cho chắc.
   */
  async isProviderEnabledBySitePolicy(provider: MessageProviderDefinition): Promise<boolean> {
    if (provider.mandatoryInApp) return true;
    const value = await this.siteConfig.getValue<boolean>(
      NOTIFICATION_POLICY_COMPONENT,
      notificationPolicySettingName(provider.name),
    );
    return value !== false;
  }

  /**
   * User có được toàn bộ bề mặt tuỳ chọn theo loại (v2) hay chỉ bề
   * mặt tối thiểu của học sinh (NB-7, issue #174 — quyết của Lão gia:
   * học sinh chỉ tuỳ chọn TỐI THIỂU). Đầy đủ = site admin, hoặc có bất
   * kỳ gán vai nhân sự (archetype manager/coursecreator/
   * editingteacher/teacher) tại bất kỳ context nào. Còn lại — học
   * sinh thuần, phụ huynh, tài khoản chưa gán vai — là tối thiểu: bề
   * mặt duy nhất còn lại là ngoại lệ tắt tiếng theo khoá (NB-4).
   */
  async hasFullNotificationPreferences(userId: string): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    return this.repo.hasStaffRoleAssignment(userId);
  }

  /**
   * Kênh có đang bật cho provider này theo tuỳ chọn của user (phân biệt logged-in/logged-off) hay không.
   * CHỈ còn dùng cho kênh push (chưa có mô hình v2 — push ẩn khỏi trang
   * cài đặt cho tới khi có app native) và làm nền suy giá trị cũ.
   */
  async isChannelEnabled(userId: string, provider: string, channel: MessageChannel, state: LoginState): Promise<boolean> {
    const value = await this.users.getPreference(userId, preferenceName(provider, channel, state));
    return value !== '0'; // default: enabled (Moodle default for core providers)
  }

  /**
   * Giá trị bật/tắt của mô hình CŨ cho một (provider × kênh): hàng
   * loggedin là hàng notify() vẫn dùng trên thực tế (mọi nơi phát đều
   * để loggedIn mặc định true), nên suy tương đương lấy loggedin
   * trước, loggedoff sau; cả hai chưa đặt → undefined (dùng mặc định).
   */
  private async legacyChannelValue(userId: string, provider: string, channel: MessageChannel): Promise<boolean | undefined> {
    for (const state of ['loggedin', 'loggedoff'] as LoginState[]) {
      const value = await this.users.getPreference(userId, preferenceName(provider, channel, state));
      if (value !== undefined && value !== null) return value !== '0';
    }
    return undefined;
  }

  /**
   * Giá trị tuỳ chọn v2 HIỆU LỰC của một provider cho một user: khoá
   * v2 đã đặt thì dùng thẳng; chưa có thì suy từ dữ liệu cũ (không phá
   * user_preferences hiện có — khoá cũ giữ nguyên, chỉ đọc). Loại bắt
   * buộc (P2) luôn bật ở kênh trong-app bất kể giá trị đã lưu.
   */
  async resolveNotificationPreference(userId: string, provider: MessageProviderDefinition): Promise<{ popupEnabled: boolean; emailFrequency: EmailFrequency | null }> {
    let popupEnabled: boolean;
    const popupV2 = await this.users.getPreference(userId, preferenceNameV2(provider.name, 'popup'));
    if (popupV2 !== undefined && popupV2 !== null) popupEnabled = popupV2 !== '0';
    else popupEnabled = (await this.legacyChannelValue(userId, provider.name, 'popup')) ?? true;
    if (provider.mandatoryInApp) popupEnabled = true;

    let emailFrequency: EmailFrequency | null = null;
    if (provider.channels.includes('email')) {
      const emailV2 = await this.users.getPreference(userId, preferenceNameV2(provider.name, 'email'));
      if (emailV2 === 'immediate' || emailV2 === 'daily' || emailV2 === 'off') emailFrequency = emailV2;
      else {
        const legacy = await this.legacyChannelValue(userId, provider.name, 'email');
        emailFrequency = legacy === undefined ? defaultEmailFrequency(provider.group) : legacy ? defaultEmailFrequency(provider.group) : 'off';
      }
    }
    return { popupEnabled, emailFrequency };
  }

  /** Một dòng tuỳ chọn v2 đầy đủ (nhãn/mô tả từ registry + giá trị hiệu lực của user). */
  private async preferenceView(userId: string, provider: MessageProviderDefinition): Promise<NotificationPreferenceView> {
    const resolved = await this.resolveNotificationPreference(userId, provider);
    return {
      provider: provider.name, component: provider.component, group: provider.group,
      label: provider.label, description: provider.description,
      teacherOnly: provider.teacherOnly ?? false, mandatoryInApp: provider.mandatoryInApp ?? false,
      popupEnabled: resolved.popupEnabled, emailFrequency: resolved.emailFrequency,
      emailAvailable: EMAIL_CHANNEL_AVAILABLE,
    };
  }

  /**
   * Tuỳ chọn notification v2 của user: một dòng cho mỗi provider đã
   * đăng ký (NB-2 — không còn ma trận provider × kênh × trạng thái).
   * Học sinh (NB-7) chỉ nhận phần tối thiểu: danh sách theo loại rỗng —
   * bề mặt tuỳ chọn duy nhất của họ là ngoại lệ theo khoá (NB-4) ở
   * endpoint riêng.
   */
  async getPreferences(userId: string): Promise<NotificationPreferenceView[]> {
    if (!(await this.hasFullNotificationPreferences(userId))) return [];
    const out: NotificationPreferenceView[] = [];
    for (const provider of MESSAGE_PROVIDERS) out.push(await this.preferenceView(userId, provider));
    return out;
  }

  /**
   * Đặt tuỳ chọn v2 cho MỘT provider (popup và/hoặc tần suất email).
   * Ghi khoá v2 mới; khoá cũ không bị xoá hay ghi đè. Tắt popup của
   * loại bắt buộc (P2) bị từ chối — kênh ngoài của loại bắt buộc vẫn
   * tắt được tuyệt đối qua emailFrequency='off'.
   */
  async setPreference(userId: string, input: { provider: string; popupEnabled?: boolean; emailFrequency?: EmailFrequency }): Promise<NotificationPreferenceView> {
    // Phân tầng bề mặt (NB-7): tuỳ chọn theo loại chỉ dành cho giáo
    // viên/nhân sự — học sinh bị chặn ngay ở server (403), không chỉ
    // giấu giao diện. Chặn trước mọi kiểm chứng khác để học sinh gọi
    // với bất kỳ payload nào cũng nhận cùng một 403 rõ ràng.
    if (!(await this.hasFullNotificationPreferences(userId))) {
      throw new ForbiddenException({
        message: 'Per-type notification preferences are only available to teaching and administrative staff',
        code: 'messaging.preference_staff_only',
      });
    }
    const provider = providerByName(input.provider);
    if (!provider) throw new BadRequestException({ message: `Unknown message provider ${input.provider}`, code: 'messaging.unknown_provider' });
    if (input.popupEnabled === undefined && input.emailFrequency === undefined) {
      throw new BadRequestException({ message: 'Nothing to update: provide popupEnabled and/or emailFrequency', code: 'messaging.preference_empty' });
    }
    if (input.emailFrequency !== undefined && !provider.channels.includes('email')) {
      throw new BadRequestException({ message: `Provider ${input.provider} has no channel email`, code: 'messaging.unknown_channel' });
    }
    if (input.popupEnabled === false && provider.mandatoryInApp) {
      throw new BadRequestException({ message: `Provider ${input.provider} is mandatory in-app and cannot be turned off`, code: 'messaging.preference_mandatory' });
    }
    if (input.popupEnabled !== undefined) {
      await this.users.setPreference(userId, preferenceNameV2(input.provider, 'popup'), input.popupEnabled ? '1' : '0');
    }
    if (input.emailFrequency !== undefined) {
      await this.users.setPreference(userId, preferenceNameV2(input.provider, 'email'), input.emailFrequency);
    }
    return this.preferenceView(userId, provider);
  }

  /** Chế độ ghi đè hiệu lực của một khoá cho một user: khoá `notif.course.<id>` đã đặt là 'mute' thì mute, còn lại 'all'. */
  async getCourseOverrideMode(userId: string, courseId: string): Promise<NotificationCourseOverrideMode> {
    const value = await this.users.getPreference(userId, coursePreferenceName(courseId));
    return value === 'mute' ? 'mute' : 'all';
  }

  /**
   * Ghi đè theo khoá của user (NB-4): một dòng cho MỖI khoá người
   * dùng thuộc về (ghi danh hiệu lực ∪ gán vai tại context khoá —
   * cùng tập với bước chọn khoá của luồng tìm bạn), kèm chế độ hiệu
   * lực. Đây là dữ liệu của trang "Ngoại lệ" trong cài đặt: mọi khoá
   * đang mute đều hiện ở đây để gỡ một chỗ.
   */
  async listCourseNotificationOverrides(userId: string): Promise<NotificationCourseOverrideView[]> {
    const courses = await this.listMyMessagingCourses(userId);
    const out: NotificationCourseOverrideView[] = [];
    for (const course of courses) {
      out.push({
        courseId: course.courseId, courseName: course.fullName,
        mode: await this.getCourseOverrideMode(userId, course.courseId),
      });
    }
    return out;
  }

  /**
   * Đặt ghi đè cho MỘT khoá ('all' | 'mute') — hiệu lực ngay ở lần
   * phát kế tiếp, đối xứng với tuỳ chọn v2 theo provider. Chỉ đặt
   * được cho khoá người dùng thật sự thuộc về; khoá ngoài phạm vi
   * nhận 404 y hệt khoá không tồn tại (cùng kỷ luật roster).
   */
  async setCourseNotificationOverride(
    userId: string,
    input: { courseId: string; mode: NotificationCourseOverrideMode },
  ): Promise<NotificationCourseOverrideView> {
    const courses = await this.listMyMessagingCourses(userId);
    const course = courses.find((c) => c.courseId === input.courseId);
    if (!course) {
      throw new NotFoundException({ message: 'Course not found', code: 'messaging.course_not_found' });
    }
    await this.users.setPreference(userId, coursePreferenceName(input.courseId), input.mode);
    return { courseId: course.courseId, courseName: course.fullName, mode: input.mode };
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
   *
   * LUẬT TỐI THIỂU HOÁ KÊNH NGOÀI (chuẩn Canvas, lát N1 issue #49): nội
   * dung rời khỏi app (email/push) KHÔNG chứa dữ liệu học tập/riêng tư
   * — không điểm số, không nội dung tin nhắn. Phía gọi mà subject/body
   * chứa dữ liệu như vậy PHẢI truyền `externalSubject`/`externalBody`
   * dạng tóm tắt (chỉ nêu loại sự kiện + ngữ cảnh); hai trường này chỉ
   * thay nội dung của job phân phối kênh ngoài, bản trong app giữ
   * nguyên subject/body. Không truyền = caller cam kết subject/body đã
   * an toàn cho kênh ngoài.
   */
  async notify(userId: string, providerName: string, input: {
    subject: string; body: string; contextUrl?: string; fromUserId?: string; loggedIn?: boolean;
    externalSubject?: string; externalBody?: string;
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
    const provider = providerByName(providerName);
    if (!provider) return { provider: providerName, userId, notificationId: null, channels: {}, skipped: 'unknown-provider' };
    const recipient = await this.users.getByIdOrUndefined(userId);
    let tenantId = input.tenantId ?? tenantAls.getStore()?.tenantId ?? null;
    if (tenantId === null && recipient) {
      tenantId = await this.repo.getUserDefaultTenantId(userId);
    }
    const tenantKey = tenantId ?? 'platform';
    if (!recipient || recipient.suspended || recipient.deleted) {
      // Suspended users receive nothing (report §2#12). Nothing is stored.
      await this.repo.insertDispatchLog({
        userId: userId, provider: providerName, channel: 'popup', status: 'skipped-suspended', tenantId,
        subject: input.subject, dedupeKey: `${tenantKey}-skipped-suspended-${providerName}-${userId}-${randomUUID()}`,
      }).catch(() => undefined);
      return { provider: providerName, userId, notificationId: null, channels: {}, skipped: 'suspended' };
    }
    // Chính sách ADMIN cấp site (NB-7, issue #174): loại bị admin tắt
    // trong site-config thì KHÔNG phát ở bất kỳ kênh nào cho bất kỳ ai
    // — luật toàn cục này chạy TRƯỚC tuỳ chọn người dùng và ghi đè theo
    // khoá, chỉ ghi dispatch log 'skipped-admin-disabled' để truy vết.
    // Hai loại bắt buộc P2 không bao giờ bị chặn ở đây (admin cũng
    // không tắt được chúng — SiteConfigService từ chối đặt false).
    if (!(await this.isProviderEnabledBySitePolicy(provider))) {
      await this.repo.insertDispatchLog({
        userId: userId, provider: providerName, channel: 'popup', status: 'skipped-admin-disabled', tenantId,
        subject: input.subject, dedupeKey: `admin-disabled-${providerName}-${userId}-${randomUUID()}`,
      });
      return { provider: providerName, userId, notificationId: null, channels: {}, skipped: 'admin-disabled' };
    }
    // Ghi đè theo khoá (NB-4, issue #174): áp TRƯỚC khi xét kênh và
    // tuỳ chọn theo loại — khoá nguồn đã bị người nhận tắt tiếng thì
    // KHÔNG sinh thông báo ở bất kỳ kênh nào, chỉ ghi dispatch log
    // trạng thái 'skipped-course-mute' để truy vết. Các loại được
    // chốt ở P3 và loại bắt buộc P2 không bao giờ bị chặn ở đây
    // (isExemptFromCourseMute) — luật toàn cục thắng ghi đè theo khoá.
    if (input.courseId && !isExemptFromCourseMute(provider)
      && (await this.users.getPreference(userId, coursePreferenceName(input.courseId))) === 'mute') {
      await this.repo.insertDispatchLog({
        userId: userId, provider: providerName, channel: 'popup', status: 'skipped-course-mute', tenantId,
        subject: input.subject, dedupeKey: `course-mute-${providerName}-${userId}-${randomUUID()}`,
      });
      return { provider: providerName, userId, notificationId: null, channels: {}, skipped: 'course-mute' };
    }
    const state: LoginState = (input.loggedIn ?? true) ? 'loggedin' : 'loggedoff';
    const channels: Record<string, string> = {};
    let notificationId: string | null = null;
    // Tuỳ chọn v2 (NB-2) quyết định popup + email ngay tại lần phát này
    // — đổi tuỳ chọn có hiệu lực ở lần phát KẾ TIẾP, không cần chờ gì.
    // `state` chỉ còn quyết định kênh push (mô hình cũ, ẩn khỏi UI).
    const resolved = await this.resolveNotificationPreference(userId, provider);

    // In-app (popup) is the only REAL channel: the notification row IS the delivery.
    if (provider.channels.includes('popup')) {
      if (resolved.popupEnabled) {
        const notification = await this.repo.insertNotification({
          userIdFrom: input.fromUserId ?? null, userIdTo: userId, tenantId,
          subject: input.subject, fullMessage: input.body, smallMessage: input.body.slice(0, 200),
          component: provider.component, eventType: providerName,
          contextUrl: input.contextUrl ?? null,
        });
        notificationId = notification.id;
        channels.popup = 'delivered';
        await this.repo.insertDispatchLog({
          notificationId: notification.id, userId: userId, provider: providerName, channel: 'popup',
          status: 'delivered', subject: input.subject, tenantId,
          dedupeKey: `${tenantKey}-popup-${notification.id}`,
        });
      } else {
        channels.popup = 'skipped-preference';
        await this.repo.insertDispatchLog({
          userId: userId, provider: providerName, channel: 'popup', status: 'skipped-preference', tenantId,
          subject: input.subject, dedupeKey: `${tenantKey}-popup-off-${providerName}-${userId}-${randomUUID()}`,
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
    // Email theo tần suất v2: 'off' chặn ngay tại đây; 'immediate' và
    // 'daily' đều xếp hàng job như nhau CHO TỚI NB-5 — động cơ gom
    // cửa sổ/digest ngày thuộc NB-5 (gửi thật chờ SMTP), lát này chỉ
    // lưu tần suất + áp luật tắt. Push giữ luật cũ theo trạng thái.
    for (const channel of provider.channels.filter((c) => c !== 'popup')) {
      const channelEnabled = channel === 'email'
        ? resolved.emailFrequency !== 'off'
        : await this.isChannelEnabled(userId, providerName, channel, state);
      if (channelEnabled) {
        const dedupeKey = `${tenantKey}-dispatch-${providerName}-${userId}-${channel}-${notificationId ?? randomUUID()}`;
        await this.dispatchQueue.add('dispatch', {
          userId, provider: providerName, channel, tenantId,
          // Kênh ngoài chỉ nhận bản tối thiểu hoá khi caller cung cấp
          // (luật ở docblock của notify) — điểm số/nội dung tin nhắn
          // không bao giờ rời app qua job này.
          subject: input.externalSubject ?? input.subject, body: input.externalBody ?? input.body,
          notificationId, dedupeKey,
        }, { jobId: dedupeKey, attempts: 3 });
        channels[channel] = 'queued';
      } else {
        channels[channel] = 'skipped-preference';
        await this.repo.insertDispatchLog({
          userId: userId, provider: providerName, channel, status: 'skipped-preference', tenantId,
          subject: input.subject, dedupeKey: `${tenantKey}-${channel}-off-${providerName}-${userId}-${randomUUID()}`,
        });
      }
    }

    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'notification_created', tenantId,
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
   * Trung tâm thông báo v2 (issue #51) — danh sách GỘP theo
   * (loại × nguồn × ngày): tổng hợp ở tầng SQL, trang kết quả neo
   * keyset trên mục mới nhất của dòng gộp cuối trang. Mục đại diện
   * `latest` được nạp bổ sung theo đúng tập id neo của trang.
   */
  async listNotificationGroups(userId: string, query: ListNotificationGroupsQueryDto): Promise<NotificationGroupPage> {
    const limit = query.limit ?? NOTIFICATION_PAGE_DEFAULT_LIMIT;
    const cursor = query.cursor ? decodeNotificationCursor(query.cursor) : undefined;
    const aggregates = await this.repo.listNotificationGroups(userId, {
      eventTypes: query.group ? eventTypesOfGroup(query.group) : undefined,
      unreadOnly: query.unreadOnly,
      cursor: cursor ? { latestAt: cursor.at, latestId: cursor.id } : undefined,
      limit: limit + 1,
    });
    const page = aggregates.slice(0, limit);
    const latestRows = await this.repo.listNotificationsByIds(page.map((a) => a.latestId));
    const latestById = new Map(latestRows.map((r) => [r.id, r]));
    const items: NotificationGroup[] = page.map((a) => {
      const latest = latestById.get(a.latestId);
      const latestAt = a.latestAt instanceof Date ? a.latestAt : new Date(a.latestAt);
      return {
        eventType: a.eventType,
        component: a.component,
        group: groupOfEventType(a.eventType),
        contextUrl: a.sourceKey === '' ? null : a.sourceKey,
        day: a.day,
        count: a.count,
        unreadCount: a.unreadCount,
        latest: {
          id: a.latestId,
          subject: latest?.subject ?? '',
          smallMessage: latest?.smallMessage ?? '',
          contextUrlName: latest?.contextUrlName ?? null,
          createdAt: (latest?.createdAt ?? latestAt).toISOString(),
          timeRead: latest?.timeRead ? latest.timeRead.toISOString() : null,
        },
      };
    });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: aggregates.length > limit && last
        ? encodeNotificationCursor(last.latestAt instanceof Date ? last.latestAt : new Date(last.latestAt), last.latestId)
        : null,
    };
  }

  /**
   * Trung tâm v2 — danh sách PHẲNG phân trang con trỏ: bộ lọc
   * (loại × nguồn × ngày) mở chi tiết đúng một dòng gộp; `group` /
   * `unreadOnly` phục vụ các góc nhìn phẳng theo nhóm.
   */
  async listNotificationItems(userId: string, query: ListNotificationItemsQueryDto): Promise<NotificationItemPage> {
    const limit = query.limit ?? NOTIFICATION_PAGE_DEFAULT_LIMIT;
    const cursor = query.cursor ? decodeNotificationCursor(query.cursor) : undefined;
    const rows = await this.repo.listNotificationItems(userId, {
      eventType: query.eventType,
      eventTypes: query.group ? eventTypesOfGroup(query.group) : undefined,
      source: query.contextUrl === undefined ? undefined : query.contextUrl === '' ? null : query.contextUrl,
      day: query.day,
      unreadOnly: query.unreadOnly,
      cursor: cursor ? { createdAt: cursor.at, id: cursor.id } : undefined,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(notificationItemView),
      nextCursor: rows.length > limit && last ? encodeNotificationCursor(last.createdAt, last.id) : null,
    };
  }

  /**
   * Trung tâm v2 — đánh dấu đã đọc HÀNG LOẠT theo khoá gộp
   * (loại × nguồn × ngày); có đẩy tín hiệu SSE như các đường đọc khác.
   */
  async markNotificationGroupRead(userId: string, dto: ReadNotificationGroupDto): Promise<{ marked: number }> {
    const marked = await this.repo.markNotificationGroupRead(userId, {
      eventType: dto.eventType,
      sourceKey: dto.contextUrl ?? '',
      day: dto.day,
    });
    if (marked > 0) await this.unreadStream.signalUnreadCountChanged(userId);
    return { marked };
  }

  /**
   * Trung tâm v2 — xoá MỘT thông báo của chính mình; thông báo của
   * người khác được coi như không tồn tại (404, không lộ tồn tại).
   */
  async deleteNotification(userId: string, notificationId: string): Promise<{ deleted: boolean }> {
    const ok = await this.repo.deleteNotification(notificationId, userId);
    if (!ok) throw new NotFoundException({ message: `Notification ${notificationId} not found`, code: 'messaging.notification_not_found' });
    return { deleted: true };
  }

  /** Trung tâm v2 — dọn mọi thông báo ĐÃ ĐỌC của mình. */
  async clearReadNotifications(userId: string): Promise<{ deleted: number }> {
    return { deleted: await this.repo.deleteReadNotifications(userId) };
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

  // --- cổng liên lạc: chỉ liên hệ đã duyệt -------------------------------------

  /**
   * Cổng liên lạc 1-1 (đã chốt lại 24/10/2026 trên issue #33, thay mô
   * hình cũ "liên hệ hoặc cùng khoá" và thay luôn hiệu lực của setting
   * `core/messagingallusers`): người gửi chỉ nhắn riêng được với
   * người nhận khi hai người là liên hệ ĐÃ ĐƯỢC DUYỆT của nhau (luồng
   * yêu cầu–chấp nhận của Lớp B — yêu cầu đang chờ không mở cổng).
   * Cùng khoá KHÔNG còn mở cổng cho học sinh với nhau: bạn cùng lớp
   * muốn nhắn riêng phải kết bạn qua roster thành viên khoá trước.
   * Kiểm này là một tra cứu `isContact` theo khoá chính (đội kiểm tra
   * đo 0,018 ms — không nghẽn). Notification hệ thống (`notify`)
   * KHÔNG đi qua cổng này.
   *
   * NGOẠI LỆ duy nhất (Lão gia chốt bổ sung 25/10/2026 trên issue
   * #33): cặp GIÁO VIÊN của khoá ↔ HỌC SINH đang ghi danh chính khoá
   * đó nhắn riêng trực tiếp không cần kết bạn — cả mở hội thoại mới
   * lẫn gửi vào hội thoại cũ, cả hai chiều (học sinh trả lời được).
   * Căn cứ là quan hệ khoá thật (gán vai dạy tại context khoá +
   * ghi danh hiệu lực — xem
   * {@link MessagingRepository.findTeacherStudentSharedCourseId}),
   * tính lại tại MỖI lần kiểm: hết ghi danh hoặc hết vai dạy thì
   * cổng đóng lại ngay, lịch sử cũ vẫn đọc được như luật gỡ liên hệ.
   * Quan hệ CHẶN vẫn thắng ngoại lệ này ở cả hai chiều: đã chặn thì
   * cặp GV–HS cũng không qua được (đường gửi vốn đã chặn bằng mã
   * `messaging.contact_blocked` trước khi tới đây; kiểm thêm tại đây
   * để đường MỞ hội thoại mới khép cùng một luật).
   */
  private async assertCanContact(senderId: string, recipientId: string): Promise<void> {
    if (await this.repo.isContact(recipientId, senderId)) return;
    const blockedEitherWay = (await this.repo.isBlocked(senderId, recipientId))
      || (await this.repo.isBlocked(recipientId, senderId));
    if (!blockedEitherWay && await this.repo.findTeacherStudentSharedCourseId(senderId, recipientId)) return;
    throw new ForbiddenException({
      message: 'You can only message a contact directly — send a contact request from the course member list and wait for it to be accepted',
      code: 'messaging.not_a_contact',
    });
  }

  // --- roster thành viên khoá (khám phá bạn bè) --------------------------------

  /**
   * Các khoá mà người dùng thuộc về (ghi danh hiệu lực ∪ gán vai tại
   * context khoá) — bước chọn khoá của luồng tìm bạn mới. Sắp theo
   * tên khoá cho ổn định.
   */
  async listMyMessagingCourses(actorId: string): Promise<MessagingCourseView[]> {
    const courseIds = await this.repo.listMembershipCourseIds(actorId);
    const out: MessagingCourseView[] = [];
    for (const courseId of courseIds) {
      const summary = await this.repo.getCourseSummary(courseId);
      if (summary) out.push(summary);
    }
    return out.sort((a, b) => a.fullName.localeCompare(b.fullName) || a.shortName.localeCompare(b.shortName));
  }

  /**
   * CÂY NHÓM của chính người gọi (lát MSG-T1, issue #33 — thiết kế
   * cấu trúc nhắn tin chốt 11:36 ngày 26/10/2026): Lớp → Khoá → Nhóm
   * con theo VAI của người xem, cộng mục Nhóm tự do. Cây dựng hoàn
   * toàn ở server (classes + enrol + conversations): lớp tôi chỉ
   * thuộc QUA một khoá (không có quan hệ trực tiếp với lớp) vẫn xuất
   * hiện đúng vị trí cha của khoá đó — phần "chỉ qua khoá" được tổng
   * hợp thành khoá nằm NGOÀI các lớp trực tiếp của tôi
   * (`coursesOutsideClasses`) để client không mất khoá nào.
   *
   * Mỗi nút: `conversationId` null khi chat của nút CHƯA được ensure
   * (bấm vào mới ensure ở MSG-T3/T2), unread khi đó là 0; đã ensure
   * thì unread là số chưa đọc của chính người gọi trên conversation
   * đó. Unread của nút khoá gồm chat khoá + các nhóm con của nó;
   * unread của nút lớp là tổng của nút lớp + mọi nút con — để nhìn
   * lướt là biết lớp/khoá nào đang có tin. Chat cấp lớp có từ MSG-T2
   * nên ở lát này nút lớp luôn conversationId null. Đồng bộ lười
   * membership được kích hoạt như ở danh sách conversation để số
   * chưa đọc bám đúng tư cách thành viên hiện tại.
   */
  async getGroupTree(actorId: string): Promise<ConversationGroupTreeView> {
    // Đồng bộ lười membership như listConversations: group/khoá tôi
    // mới gia nhập (hoặc đã rời) phải phản ánh đúng trước khi đếm.
    for (const c of await this.repo.listGroupConversationsForGroupMember(actorId)) {
      await this.syncGroupConversationMembers(c);
    }
    for (const c of await this.repo.listCourseConversationsForMember(actorId)) {
      await this.syncCourseConversationMembers(c);
    }

    const classRelations = await this.repo.listTreeClassesForUser(actorId);
    const myClassIds = new Set(classRelations.map((r) => r.classId));
    // Khoá dạng MẪU (is_template) không phải khoá đang dạy/học — loại
    // ở cả hai đường (qua lớp và qua thành viên khoá).
    const membershipCourseIds = await this.repo.listMembershipCourseIds(actorId);
    const myCourseNameRows = await this.repo.listCourseNames(membershipCourseIds);
    const myCourseIds = new Set(myCourseNameRows.map((r) => r.courseId));
    const coursesInMyClasses = (await this.repo.listCoursesByClassIds([...myClassIds]))
      .filter((c) => myCourseIds.has(c.courseId));
    // Lớp chứa các khoá tôi thuộc về nhưng tôi không có quan hệ trực
    // tiếp: các khoá đó nằm ở coursesOutsideClasses (giữ nguyên
    // classId của chúng trong dữ liệu nguồn — client MSG-T3 trình
    // bày phẳng phần này, không ngắt quan hệ lớp–khoá ở dữ liệu).
    const parentRows = await this.repo.listClassesOfCourses(
      [...myCourseIds].filter((id) => !coursesInMyClasses.some((c) => c.courseId === id)),
    );
    const outsideCourseIds = parentRows
      .filter((r) => !myClassIds.has(r.classId) && r.classStatus === 'active')
      .map((r) => r.courseId);
    const detachedCourseIds = [...myCourseIds].filter((id) => !coursesInMyClasses.some((c) => c.courseId === id) && !parentRows.some((r) => r.courseId === id));
    const outsideAll = [...outsideCourseIds, ...detachedCourseIds];

    const allCourseIds = [...new Set([...coursesInMyClasses.map((c) => c.courseId), ...outsideAll])];
    const teachingIds = new Set(await this.repo.listTeachingCourseIds(actorId, allCourseIds));
    const nameOfCourse = new Map(myCourseNameRows.map((r) => [r.courseId, r.fullName]));

    // Số chưa đọc theo conversation của chính tôi (một truy vấn tổng
    // hợp như danh sách conversation; conversation đã lưu trữ vẫn
    // tính ở cây — cây là cấu trúc điều hướng, không phải hộp thư).
    const summaries = await this.repo.listConversationSummaries(actorId, {});
    const summariesArchived = await this.repo.listConversationSummaries(actorId, { archivedOnly: true });
    const unreadByConversation = new Map<string, number>();
    for (const s of [...summaries, ...summariesArchived]) {
      unreadByConversation.set(s.conversation.id, s.unreadCount);
    }
    // conversationId của nút cấu trúc tra TRỰC TIẾP theo item (đã
    // ensure hay chưa là sự thật ở bảng conversation, không phụ
    // thuộc việc tôi đã là thành viên conversation hay chưa); số chưa
    // đọc mới là phần theo người xem (không có dòng thành viên thì 0).
    const courseConvByCourse = new Map(
      (await this.repo.listCourseConversationsByCourseIds(allCourseIds)).map((c) => [c.itemId!, c.id]),
    );
    const classConvByClass = new Map(
      (await this.repo.listClassConversations([...myClassIds])).map((c) => [c.itemId!, c.id]),
    );

    // Nhóm con: các group tôi là thành viên, chỉ giữ group thuộc các
    // khoá có mặt trong cây.
    const myGroupIds = await this.repo.listGroupIdsForUser(actorId);
    const groupRows = (await this.repo.listGroupNames(myGroupIds))
      .filter((g) => allCourseIds.includes(g.courseId));
    const groupConvByGroup = new Map(
      (await this.repo.listGroupConversationsByGroupIds(groupRows.map((g) => g.groupId))).map((c) => [c.itemId!, c.id]),
    );

    const buildCourseNode = (courseId: string, name: string, myRole: ConversationTreeRole): ConversationTreeCourseView => {
      const convId = courseConvByCourse.get(courseId) ?? null;
      let unread = convId ? (unreadByConversation.get(convId) ?? 0) : 0;
      const groups: ConversationTreeGroupView[] = groupRows
        .filter((g) => g.courseId === courseId)
        .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
        .map((g) => {
          const gConvId = groupConvByGroup.get(g.groupId) ?? null;
          const gUnread = gConvId ? (unreadByConversation.get(gConvId) ?? 0) : 0;
          unread += gUnread;
          return { groupId: g.groupId, name: g.name, myRole, conversationId: gConvId, unread: gUnread };
        });
      return { courseId, name, myRole, conversationId: convId, unread, groups };
    };

    const classNodes: ConversationTreeClassView[] = [];
    for (const rel of classRelations) {
      const myRole: ConversationTreeRole = rel.isOwner ? 'teaching' : rel.isClassStaff ? 'staff' : 'learning';
      // Vai tại khoá suy từ vai tại lớp khi tôi có vai công tác ở
      // lớp: chủ lớp/staff lớp dạy các khoá trong lớp của mình; thành
      // viên roster thuần tuý thì học các khoá đó trừ khoá mình có
      // gán vai staff riêng (đã tính ở teachingIds).
      const courseNodes = coursesInMyClasses
        .filter((c) => c.classId === rel.classId)
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi'))
        .map((c) => buildCourseNode(
          c.courseId,
          c.fullName,
          teachingIds.has(c.courseId) || rel.isOwner || rel.isClassStaff ? 'teaching' : 'learning',
        ));
      const classConvId = classConvByClass.get(rel.classId) ?? null;
      const ownUnread = classConvId ? (unreadByConversation.get(classConvId) ?? 0) : 0;
      const totalUnread = ownUnread + courseNodes.reduce((sum, n) => sum + n.unread, 0);
      classNodes.push({
        classId: rel.classId, name: rel.name, myRole, conversationId: classConvId, unread: totalUnread, courses: courseNodes,
      });
    }
    classNodes.sort((a, b) => a.name.localeCompare(b.name, 'vi'));

    const outsideNodes = outsideAll
      .sort((a, b) => (nameOfCourse.get(a) ?? '').localeCompare(nameOfCourse.get(b) ?? '', 'vi'))
      .map((courseId) => buildCourseNode(
        courseId,
        nameOfCourse.get(courseId) ?? courseId,
        teachingIds.has(courseId) ? 'teaching' : 'learning',
      ));

    // Nhóm tự do: conversation type 2 KHÔNG gắn cấu trúc mà tôi là
    // thành viên (đúng tập listConversationSummaries trả về — đã qua
    // cổng hiển thị của danh sách).
    const freeGroups: ConversationTreeFreeGroupView[] = [...summaries, ...summariesArchived]
      .filter((s) => s.conversation.type === 2 && !s.conversation.itemType)
      .sort((a, b) => b.conversation.updatedAt.getTime() - a.conversation.updatedAt.getTime())
      .map((s) => ({
        conversationId: s.conversation.id,
        name: s.conversation.name ?? '',
        myRole: (s.conversation.createdBy === actorId ? 'staff' : 'learning') as ConversationTreeRole,
        unread: s.unreadCount,
      }));

    return { classes: classNodes, coursesOutsideClasses: outsideNodes, freeGroups };
  }

  /** Giải mã con trỏ phân trang roster; con trỏ hỏng → 400 rõ ràng thay vì lặng lẽ về trang đầu. */
  private decodeRosterCursor(raw: string): { displayName: string; username: string; userId: string } {
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
        d?: unknown; u?: unknown; i?: unknown;
      };
      if (typeof parsed.d !== 'string' || typeof parsed.u !== 'string' || typeof parsed.i !== 'string') {
        throw new Error('bad cursor shape');
      }
      return { displayName: parsed.d, username: parsed.u, userId: parsed.i };
    } catch {
      throw new BadRequestException({ message: 'Invalid roster cursor', code: 'messaging.roster_cursor_invalid' });
    }
  }

  /**
   * Một trang roster thành viên của một khoá — đường khám phá bạn bè
   * duy nhất sau khi gỡ tìm người theo tên (quyết định 24/10/2026
   * trên issue #33). Cổng xem: chỉ THÀNH VIÊN của chính khoá đó (ghi
   * danh hiệu lực ∪ gán vai tại context khoá) mới xem được; người
   * ngoài khoá nhận đúng 404 như khoá không tồn tại — không oracle
   * xác nhận tồn tại khoá hay số thành viên. Mỗi dòng đúng whitelist
   * đã kiểm chứng (userId, displayName, username) + dấu hiệu vai trò
   * + trạng thái quan hệ với người xem; quan hệ chặn (cả hai chiều)
   * đã bị giấu ngay tại SQL nên `blocked` không xuất hiện ở đây.
   * Mỗi dòng còn mang `canDirectMessage`: người xem là giáo viên của
   * khoá và thành viên đang ghi danh hiệu lực thì nhắn riêng trực
   * tiếp được theo ngoại lệ GV–HS (chốt bổ sung 25/10/2026 trên
   * issue #33) — web hiện nút "Nhắn tin" theo cờ này.
   * Phân trang con trỏ theo (displayName, username, id), trần trang
   * {@link ROSTER_MAX_PAGE_SIZE} — không có đường lấy toàn bộ roster.
   */
  async listCourseRoster(actorId: string, courseId: string, query: { limit?: number; cursor?: string }): Promise<{
    members: CourseRosterMemberView[];
    nextCursor: string | null;
  }> {
    const course = await this.repo.getCourseSummary(courseId);
    if (!course || !(await this.repo.isCourseMember(courseId, actorId))) {
      throw new NotFoundException({ message: 'Course not found', code: 'messaging.course_not_found' });
    }
    const limit = Math.min(Math.max(query.limit ?? ROSTER_DEFAULT_PAGE_SIZE, 1), ROSTER_MAX_PAGE_SIZE);
    const cursor = query.cursor ? this.decodeRosterCursor(query.cursor) : null;
    const rows = await this.repo.listCourseRosterPage(courseId, actorId, cursor, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const [contactIds, incoming, outgoing, viewerIsTeacher] = await Promise.all([
      this.repo.listContacts(actorId),
      this.repo.listIncomingContactRequests(actorId),
      this.repo.listOutgoingContactRequests(actorId),
      this.repo.isCourseTeachingStaff(courseId, actorId),
    ]);
    const contactSet = new Set(contactIds);
    const incomingSet = new Set(incoming.map((r) => r.userIdFrom));
    const outgoingSet = new Set(outgoing.map((r) => r.userIdTo));
    const relationshipOf = (id: string): ContactRelationship => {
      if (contactSet.has(id)) return 'contact';
      if (incomingSet.has(id)) return 'pending_incoming';
      if (outgoingSet.has(id)) return 'pending_outgoing';
      return 'none';
    };
    const members = page.map((row) => ({
      userId: row.userId,
      displayName: row.displayName,
      username: row.username,
      role: (row.staff ? 'teacher' : 'student') as 'teacher' | 'student',
      relationship: relationshipOf(row.userId),
      // Cờ nhắn thẳng khớp đúng cổng API: người xem dạy khoá này +
      // thành viên đang ghi danh (dòng có quan hệ chặn đã bị SQL giấu
      // nên không cần trừ ở đây).
      canDirectMessage: viewerIsTeacher && row.enrolled,
    }));
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ d: last.displayName, u: last.username, i: last.userId }), 'utf8').toString('base64url')
      : null;
    return { members, nextCursor };
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
    // Nối lại room 1–1 (tiếp quản PR #94): bỏ chặn phải khôi phục
    // nguyên trạng cho socket đang nối — xem rejoinDirectConversationAfterUnblock.
    await this.realtime.rejoinDirectConversationAfterUnblock(userId, blockedUserId);
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
      const created = await this.repo.insertConversation({ type, name: input.name ?? null, createdBy: actorId, tenantId: tenantAls.getStore()?.tenantId ?? null }, tx as never);
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

  /** Conversation có gắn với chính một KHOÁ (chat toàn lớp) qua (component, itemType, itemId) hay không. */
  private isCourseLinked(conversation: ConversationRow): boolean {
    return conversation.type === 2
      && conversation.component === 'core_course'
      && conversation.itemType === 'course'
      && conversation.itemId !== null;
  }

  /**
   * Đồng bộ lười thành viên của một conversation gắn cấu trúc (group
   * hoặc khoá) về đúng tập đích HIỆN TẠI: người mới thuộc cấu trúc được
   * thêm, người đã rời bị gỡ khỏi conversation (tin nhắn cũ giữ nguyên).
   * Trả về danh sách thành viên sau đồng bộ. Chỉ chạy phía messaging khi
   * conversation được liệt kê/mở/gửi — không cần hook trong module chủ
   * của cấu trúc.
   */
  private async syncLinkedConversationMembers(conversation: ConversationRow, targetIds: string[]): Promise<string[]> {
    const memberIds = [...new Set(targetIds)];
    const current = await this.repo.listMembers(conversation.id);
    for (const id of memberIds) {
      if (!current.includes(id)) await this.repo.addMember(conversation.id, id);
    }
    for (const id of current) {
      if (!memberIds.includes(id)) {
        await this.repo.removeMember(conversation.id, id);
        // Đẩy socket của người vừa bị gỡ ra khỏi room của conversation
        // NGAY: membership ở DB đã mất mà socket còn nằm trong room thì
        // vẫn nhận mọi sự kiện của conversation (F1). Tầng phân phối
        // còn rà soát lại membership một lần nữa trước mỗi lần phát.
        await this.realtime.evictUserFromConversation(id, conversation.id);
      }
    }
    return memberIds;
  }

  /** Đồng bộ thành viên theo thành viên course group hiện tại. */
  private async syncGroupConversationMembers(conversation: ConversationRow): Promise<string[]> {
    return this.syncLinkedConversationMembers(conversation, await this.repo.listGroupMemberIds(conversation.itemId!));
  }

  /** Đồng bộ thành viên theo ghi danh hiệu lực ∪ staff của khoá hiện tại. */
  private async syncCourseConversationMembers(conversation: ConversationRow): Promise<string[]> {
    return this.syncLinkedConversationMembers(conversation, await this.repo.listCourseConversationMemberIds(conversation.itemId!));
  }

  /** Đồng bộ nếu conversation gắn cấu trúc (group/khoá); conversation thường thì bỏ qua. */
  private async syncGroupConversationIfLinked(conversation: ConversationRow): Promise<void> {
    if (this.isGroupLinked(conversation)) await this.syncGroupConversationMembers(conversation);
    else if (this.isCourseLinked(conversation)) await this.syncCourseConversationMembers(conversation);
  }

  /**
   * Cổng thành viên cho các đường theo id (đọc/gửi/báo cáo): người
   * không phải thành viên bị từ chối — riêng conversation CẤP KHOÁ
   * hành xử như KHÔNG TỒN TẠI (404, cùng mã `conversation_not_found`)
   * để bề mặt chat lớp không rò sự tồn tại của khoá/conversation cho
   * người ngoài khoá, đồng nhất với cổng ensure; các loại conversation
   * khác giữ 403 `not_member` như hiện hành.
   */
  private async assertConversationMember(userId: string, conversation: ConversationRow): Promise<void> {
    if (await this.repo.isMember(conversation.id, userId)) return;
    if (this.isCourseLinked(conversation)) {
      throw new NotFoundException({ message: `Conversation ${conversation.id} not found`, code: 'messaging.conversation_not_found' });
    }
    throw new ForbiddenException({ message: 'You are not a member of this conversation', code: 'messaging.not_member' });
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
    // TENANT-1 (#196): conversation của group thuộc tenant của khoá chứa group.
    const tenantId = (await this.repo.getCourseTenantId(group.courseId)) ?? tenantAls.getStore()?.tenantId ?? null;
    const conversation = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertConversation({
        type: 2, name: input.name ?? group.name,
        component: 'core_group', itemType: 'groups', itemId: group.id,
        contextId: courseCtx?.id ?? null, createdBy: actorId, tenantId,
      }, tx as never);
      for (const id of groupMemberIds) await this.repo.addMember(created.id, id, tx as never);
      return created;
    });
    return { ...conversation, members: groupMemberIds };
  }

  // --- course conversations (chat toàn lớp, gắn chính khoá) -------------------

  /**
   * Mở (ensure) conversation của CHÍNH khoá — chat toàn lớp: component
   * 'core_course', itemType 'course', itemId = course id, contextId =
   * context của khoá. Cấp phát LƯỜI idempotent: chưa có thì tạo với
   * thành viên khởi tạo = ghi danh hiệu lực ∪ staff khoá, đã có thì
   * đồng bộ lười rồi trả lại — khoá cũ tự có chat khi mở lần đầu, không
   * migration dữ liệu. Chỉ thành viên của khoá (ghi danh hiệu lực, gán
   * vai tại context khoá) hoặc staff khoá mới mở được; người ngoài nhận
   * 404 cùng mã như khoá không tồn tại (không rò tồn tại). Thẩm quyền
   * quản lý (bật/tắt) theo staff khoá — người tạo bản ghi (có thể là
   * một học viên mở lần đầu) KHÔNG thành quản lý, đúng luật conversation
   * gắn cấu trúc. Đua ensure song song: transaction tạo giữ
   * `pg_advisory_xact_lock` theo courseId rồi re-check trong cùng
   * transaction — schema không có unique nên khoá này là điểm đồng bộ
   * giữ bất biến một khoá/một conversation (phán quyết 6395599464).
   */
  async ensureCourseConversation(actorId: string, courseId: string): Promise<ConversationRow & { members: string[] }> {
    const course = await this.repo.getCourseSummary(courseId);
    if (!course) throw new NotFoundException({ message: `Course ${courseId} not found`, code: 'messaging.course_not_found' });
    if (!(await this.repo.isCourseMember(courseId, actorId)) && !(await this.isCourseStaff(actorId, courseId))) {
      throw new NotFoundException({ message: `Course ${courseId} not found`, code: 'messaging.course_not_found' });
    }
    const existing = await this.repo.findCourseConversation(courseId);
    if (existing) return { ...existing, members: await this.syncCourseConversationMembers(existing) };
    const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
    const memberIds = await this.repo.listCourseConversationMemberIds(courseId);
    const ensured = await this.repo.dbHandle.transaction(async (tx) => {
      // Khoá advisory TRƯỚC, re-check SAU — trong cùng transaction:
      // lượt ensure song song đến sau phải chờ lượt trước commit xong
      // mới qua được khoá, và re-check lúc đó thấy conversation đã
      // tồn tại nên không insert trùng.
      await this.repo.acquireCourseConversationLock(tx as never, courseId);
      const rechecked = await this.repo.findCourseConversation(courseId, tx as never);
      if (rechecked) return { conversation: rechecked, created: false as const };
      const created = await this.repo.insertConversation({
        type: 2, name: course.fullName,
        component: 'core_course', itemType: 'course', itemId: courseId,
        contextId: courseCtx?.id ?? null, createdBy: actorId,
      }, tx as never);
      for (const id of memberIds) await this.repo.addMember(created.id, id, tx as never);
      return { conversation: created, created: true as const };
    });
    if (!ensured.created) return { ...ensured.conversation, members: await this.syncCourseConversationMembers(ensured.conversation) };
    return { ...ensured.conversation, members: memberIds };
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
    if (this.isCourseLinked(conversation)) return conversation.itemId;
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
    if (!this.isGroupLinked(conversation) && !this.isCourseLinked(conversation) && conversation.createdBy !== null && conversation.createdBy === userId) return true;
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
   * Đặt trạng thái cá nhân của CHÍNH thành viên trên một conversation
   * (lát M5, issue #240): ghim / lưu trữ / tắt tiếng — ba cờ độc lập,
   * chỉ trường có mặt mới đổi. Cổng như các đường theo id của thành
   * viên: conversation không tồn tại, người ngoài, và hội thoại 1–1
   * đang bị chặn đều 404 `messaging.conversation_not_found` — trạng
   * thái cá nhân không bao giờ lộ tồn tại của conversation với người
   * không thuộc về nó. Trạng thái chỉ chạm dòng thành viên của chính
   * người gọi; phía còn lại không đổi.
   */
  async updateConversationState(
    userId: string,
    conversationId: string,
    input: { pinned?: boolean; archived?: boolean; muted?: boolean },
  ): Promise<{ conversationId: string; pinned: boolean; pinnedAt: Date | null; archived: boolean; archivedAt: Date | null; muted: boolean }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    if (!(await this.repo.isMember(conversationId, userId))) {
      throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    }
    await this.assertDirectConversationVisible(userId, conversation);
    const state = await this.repo.updateMemberConversationState(conversationId, userId, input);
    if (!state) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    return {
      conversationId,
      pinned: state.pinnedAt !== null,
      pinnedAt: state.pinnedAt,
      archived: state.archivedAt !== null,
      archivedAt: state.archivedAt,
      muted: state.muted,
    };
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
  async listConversations(userId: string, opts: { archivedOnly?: boolean } = {}): Promise<(ConversationRow & {
    members: string[]; unread: number; lastReadSeq: number; lastMessage: MessageRow | null;
    pinnedAt: Date | null; archivedAt: Date | null; muted: boolean;
    memberProfiles: Record<string, PersonSummaryView>;
  })[]> {
    for (const c of await this.repo.listGroupConversationsForGroupMember(userId)) {
      await this.syncGroupConversationMembers(c);
    }
    for (const c of await this.repo.listCourseConversationsForMember(userId)) {
      await this.syncCourseConversationMembers(c);
    }
    const summaries = await this.repo.listConversationSummaries(userId, opts);
    const myGroupIds = new Set(await this.repo.listGroupIdsForUser(userId));
    const out: (ConversationRow & {
      members: string[]; unread: number; lastReadSeq: number; lastMessage: MessageRow | null;
      pinnedAt: Date | null; archivedAt: Date | null; muted: boolean;
    })[] = [];
    for (const s of summaries) {
      if (this.isGroupLinked(s.conversation) && !myGroupIds.has(s.conversation.itemId!)) {
        // Đã rời group nhưng membership conversation chưa được đồng bộ:
        // đồng bộ ngay (gỡ user khỏi conversation) và ẩn khỏi danh sách.
        await this.syncGroupConversationMembers(s.conversation);
        continue;
      }
      if (this.isCourseLinked(s.conversation)) {
        // Đã rời khoá (huỷ ghi danh/hết vai staff) nhưng membership
        // conversation chưa được đồng bộ: đối chiếu tập thành viên đúng
        // nghĩa của khoá — không còn thuộc thì đồng bộ ngay (gỡ user
        // khỏi conversation) và ẩn khỏi danh sách như đường group.
        const memberIds = await this.repo.listCourseConversationMemberIds(s.conversation.itemId!);
        if (!memberIds.includes(userId)) {
          await this.syncCourseConversationMembers(s.conversation);
          continue;
        }
      }
      out.push({
        ...s.conversation,
        members: s.members,
        unread: s.unreadCount,
        lastReadSeq: s.lastReadSeq,
        // Trạng thái cá nhân của chính người xem (lát M5): client
        // hiện dấu ghim, số chưa đọc dạng mờ khi tắt tiếng, và biết
        // mình đang ở mục đã lưu hay mục chính.
        pinnedAt: s.pinnedAt,
        archivedAt: s.archivedAt,
        muted: s.muted,
        // Danh sách là đường đọc thường: tin cuối đã thu hồi thì xem
        // trước chỉ còn dấu vết thu hồi, không lộ nội dung gốc.
        lastMessage: s.lastMessage ? blankRecalledContent(s.lastMessage) : null,
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
   * Cổng tầm nhìn hội thoại 1–1 khi đang chặn (việc nối tiếp của
   * issue #33, siết sau PR #89): danh sách hội thoại đã ẩn hội thoại
   * 1–1 có quan hệ chặn ở bất kỳ chiều nào, nhưng đường MỞ THẲNG
   * theo id (deep-link từ thông báo) trước đây chỉ kiểm tra tư cách
   * thành viên nên vẫn đọc được. Từ nay mọi đường đọc theo id của
   * hội thoại 1–1 đang bị chặn — chi tiết, cửa sổ lịch sử, đánh dấu
   * đã đọc — hành xử như hội thoại KHÔNG TỒN TẠI đối với cả hai
   * phía (404, cùng mã `messaging.conversation_not_found`); dữ liệu
   * giữ nguyên, bỏ chặn là mở lại. Hội thoại nhóm không bị chạm:
   * cổng chỉ chạy khi `type === 1`.
   */
  private async assertDirectConversationVisible(userId: string, conversation: ConversationRow): Promise<void> {
    if (conversation.type !== 1) return;
    const members = await this.repo.listMembers(conversation.id);
    const other = members.find((id) => id !== userId);
    if (!other) return;
    if ((await this.repo.listBlockedCounterpartIds(userId)).includes(other)) {
      throw new NotFoundException({ message: `Conversation ${conversation.id} not found`, code: 'messaging.conversation_not_found' });
    }
  }

  /**
   * Chi tiết conversation + một cửa sổ tin nhắn mới nhất theo cursor
   * seq (chỉ thành viên mới xem được; conversation gắn group được đồng
   * bộ thành viên trước khi kiểm tra). `memberReadMarkers` cho client
   * hiển thị biên "đã xem" theo mốc đã đọc của từng thành viên.
   * Hội thoại 1–1 đang có quan hệ chặn thì 404 như không tồn tại
   * (xem {@link assertDirectConversationVisible}).
   */
  async getConversation(userId: string, conversationId: string, opts: { limit?: number } = {}): Promise<ConversationRow & {
    members: string[]; messages: MessageWithQuoteRow[]; hasMoreBefore: boolean;
    lastReadSeq: number; memberReadMarkers: { userId: string; lastReadSeq: number }[];
    memberProfiles: Record<string, PersonSummaryView>;
    canModerate: boolean; canManage: boolean;
  }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    await this.assertConversationMember(userId, conversation);
    await this.assertDirectConversationVisible(userId, conversation);
    // Tầm nhìn theo vai trò (Lớp B): thành viên thường KHÔNG BAO GIỜ
    // thấy tin đã xoá mềm; người có thẩm quyền kiểm duyệt trên
    // conversation (giáo viên phụ trách/quản trị) thấy cả tin đã xoá
    // kèm dấu vết — đó là đường truy vết của chính sách xoá mềm.
    const canModerate = await this.canModerateConversation(userId, conversation);
    const canManage = canModerate || await this.canManageConversation(userId, conversation);
    // Đường đọc thường (không phải truy vết): lọc tin chính người xem
    // đã xoá-phía-mình và vô hiệu nội dung tin đã thu hồi. Đường truy
    // vết (canModerate) giữ nguyên mọi thứ kèm dấu vết đầy đủ.
    const rawMessages = await this.repo.listMessages(conversationId, {
      limit: opts.limit ?? 50,
      includeDeleted: canModerate,
      viewerId: canModerate ? undefined : userId,
    });
    // Khối trích dẫn (lát M3) dựng từ dòng tin gốc THÔ theo quyền
    // của người xem, TRƯỚC khi vô hiệu nội dung tin đã thu hồi của
    // chính cửa sổ — hai việc độc lập: quote lộ hay không do trạng
    // thái của tin GỐC quyết, theo messageQuoteOf.
    const withQuotes = await this.repo.attachQuotes(rawMessages, {
      privileged: canModerate,
      viewerId: canModerate ? undefined : userId,
    });
    const messages = canModerate ? withQuotes : withQuotes.map((m) => ({ ...blankRecalledContent(m), replyTo: m.replyTo }));
    const markers = await this.repo.listMemberReadMarkers(conversationId);
    const members = await this.repo.listMembers(conversationId);
    return {
      ...conversation,
      members,
      messages,
      hasMoreBefore: messages.length > 0 ? await this.repo.hasMessagesBefore(conversationId, messages[0]!.seq, canModerate, canModerate ? undefined : userId) : false,
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
  }): Promise<{ messages: MessageWithQuoteRow[]; hasMoreBefore: boolean }> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    await this.assertConversationMember(userId, conversation);
    await this.assertDirectConversationVisible(userId, conversation);
    // Cùng luật tầm nhìn với getConversation: chỉ người có thẩm quyền
    // kiểm duyệt mới nhận được tin đã xoá mềm trong cửa sổ đồng bộ;
    // người xem thường bị lọc tin đã xoá-phía-mình và nhận nội dung
    // rỗng cho tin đã thu hồi.
    const canModerate = await this.canModerateConversation(userId, conversation);
    const rawMessages = await this.repo.listMessages(conversationId, {
      ...query,
      includeDeleted: canModerate,
      viewerId: canModerate ? undefined : userId,
    });
    // Khối trích dẫn (lát M3): cùng luật dựng với getConversation —
    // theo quyền của người xem trên tin gốc thô, độc lập với việc vô
    // hiệu nội dung thu hồi của chính cửa sổ này.
    const withQuotes = await this.repo.attachQuotes(rawMessages, {
      privileged: canModerate,
      viewerId: canModerate ? undefined : userId,
    });
    const messages = canModerate ? withQuotes : withQuotes.map((m) => ({ ...blankRecalledContent(m), replyTo: m.replyTo }));
    return {
      messages,
      hasMoreBefore: messages.length > 0 && query.afterSeq === undefined
        ? await this.repo.hasMessagesBefore(conversationId, messages[0]!.seq, canModerate, canModerate ? undefined : userId)
        : false,
    };
  }

  /**
   * Tìm nội dung tin TRONG một conversation (lát M4, issue #237):
   * cùng cổng với các đường đọc tin — chỉ thành viên, hội thoại 1–1
   * đang bị chặn hành xử như không tồn tại, người có thẩm quyền kiểm
   * duyệt tìm theo tầm nhìn truy vết. Kết quả mang excerpt quanh chỗ
   * khớp + seq để client nhảy tới đúng tin; kết quả chỉ chứa tin còn
   * hiển thị được với chính người tìm (luật chi tiết ở repository).
   * Truy vấn rỗng sau khi cắt khoảng trắng → 400 xác định
   * `messaging.search_query_empty` (schema route chỉ chặn chuỗi
   * rỗng hẳn; truy vấn toàn khoảng trắng lọt tới đây).
   */
  async searchConversationMessages(userId: string, conversationId: string, query: {
    q: string; limit?: number;
  }): Promise<{ results: { id: string; conversationId: string; userIdFrom: string; seq: number; excerpt: string; createdAt: Date }[] }> {
    const q = query.q.trim();
    if (q.length === 0) {
      throw new BadRequestException({ message: 'Search query must not be empty', code: 'messaging.search_query_empty' });
    }
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    await this.assertConversationMember(userId, conversation);
    await this.assertDirectConversationVisible(userId, conversation);
    const canModerate = await this.canModerateConversation(userId, conversation);
    const rows = await this.repo.searchMessages(conversationId, {
      query: q,
      limit: query.limit,
      privileged: canModerate,
      viewerId: canModerate ? undefined : userId,
      excludedAuthorIds: canModerate ? undefined : await this.repo.listBlockedCounterpartIds(userId),
    });
    return {
      results: rows.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        userIdFrom: row.userIdFrom,
        seq: row.seq,
        excerpt: searchExcerptOf(row.fullMessage, q),
        createdAt: row.createdAt,
      })),
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
  async sendMessage(actorId: string, conversationId: string, input: { text: string; subject?: string; clientMessageId?: string; replyToMessageId?: string }): Promise<MessageWithQuoteRow> {
    const systemCtx = await this.contexts.ensureSystemContext();
    const senderCtx = await this.contexts.getByLevelInstance(30, actorId);
    await this.evaluator.requireCapability(actorId, 'site:sendmessage', senderCtx?.id ?? systemCtx.id);
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${conversationId} not found`, code: 'messaging.conversation_not_found' });
    // Conversation gắn group: đồng bộ thành viên theo group trước khi kiểm
    // tra tư cách thành viên (người mới vào group gửi được ngay, người rời
    // group bị chặn ở kiểm tra ngay dưới đây).
    await this.syncGroupConversationIfLinked(conversation);
    await this.assertConversationMember(actorId, conversation);
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
    // Cổng liên lạc chỉ áp cho conversation cá nhân (type 1): kiểm ở
    // MỖI lần gửi — hội thoại riêng có từ trước khi hai người thành
    // liên hệ (hoặc sau khi gỡ liên hệ) vẫn đọc được lịch sử nhưng gửi
    // mới bị chặn tới khi quan hệ được (tái) lập; conversation nhóm
    // thì thành viên gửi tự do. Kiểm sau luật suspended/blocked để
    // giữ nguyên mã lỗi đã có của hai luật đó.
    if (conversation.type === 1) {
      const other = members.find((id) => id !== actorId);
      if (other) {
        // Chiều chặn còn lại: chính người gửi đã chặn người nhận thì
        // cũng không gửi được (phải bỏ chặn trước) — vòng lặp phía
        // trên mới chỉ bắt chiều người nhận chặn người gửi.
        if (await this.repo.isBlocked(actorId, other)) {
          throw new ForbiddenException({ message: 'You have blocked this user', code: 'messaging.contact_blocked' });
        }
        await this.assertCanContact(actorId, other);
      }
    }
    // Kết quả trả về luôn mang khối trích dẫn đã dựng cho chính
    // người gửi (lát M3): client thay bản lạc quan bằng bản thật mà
    // không phải tải lại cửa sổ.
    const withQuote = async (row: MessageRow): Promise<MessageWithQuoteRow> =>
      (await this.repo.attachQuotes([row], { privileged: false, viewerId: actorId }))[0]!;
    if (input.clientMessageId) {
      const existing = await this.repo.getMessageByClientId(conversationId, actorId, input.clientMessageId);
      if (existing) return withQuote(existing);
    }
    // Gác TRÍCH DẪN (lát M3, issue #229): tin gốc phải thuộc ĐÚNG
    // conversation đang gửi. Tin không tồn tại và tin của conversation
    // khác nhận CÙNG một 400 — không lộ tồn tại tin của hội thoại
    // khác. Đặt trước cổng độ dài/throttle như mọi lỗi nội dung: yêu
    // cầu sai không đốt quota gửi. Phần trích dẫn KHÔNG tính vào
    // trần độ dài (chỉ `text` bị đếm ở assertMessageLengthAllowed).
    if (input.replyToMessageId) {
      const original = await this.repo.getMessage(input.replyToMessageId);
      if (!original || original.conversationId !== conversationId) {
        throw new BadRequestException({
          message: 'Quoted message not found in this conversation',
          code: 'messaging.reply_target_not_found',
        });
      }
    }
    // Chặn lạm dụng đường gửi (lát M2, issue #212) — đặt SAU điểm trả
    // trùng clientMessageId và sau mọi cổng tư cách/liên lạc: lượt gửi
    // lại của tin đã nhận không tốn quota throttle, tin bị từ chối ở
    // cổng trước cũng không; thứ tự hai cổng là độ dài TRƯỚC (400,
    // lỗi nội dung không đốt quota) rồi mới throttle (429).
    await this.assertMessageLengthAllowed(input.text);
    await this.sendThrottle.consume(actorId);
    try {
      const saved = await this.repo.dbHandle.transaction(async (tx) => {
        const seq = await this.repo.allocateNextSeq(conversationId, tx as never);
        const msg = await this.repo.insertMessage({
          conversationId: conversationId, userIdFrom: actorId,
          subject: input.subject ?? '', fullMessage: input.text, smallMessage: input.text.slice(0, 200),
          seq, clientMessageId: input.clientMessageId ?? null,
          replyToMessageId: input.replyToMessageId ?? null,
        }, tx as never);
        // Lát M5: tin mới làm hội thoại ĐÃ LƯU của các thành viên còn
        // lại tự hiện lại (bỏ lưu trong cùng transaction — xem
        // clearArchivedForIncomingMessage ở repository).
        await this.repo.clearArchivedForIncomingMessage(conversationId, actorId, tx as never);
        await this.outbox.enqueue(tx as never, {
          aggregate: 'messaging', type: 'message_sent',
          payload: {
            conversationId, messageId: msg.id, seq, fromUserId: actorId,
            memberIds: members, clientMessageId: input.clientMessageId ?? null,
            replyToMessageId: input.replyToMessageId ?? null,
          },
        });
        return msg;
      });
      return await withQuote(saved);
    } catch (err) {
      // Hai lần gửi trùng khoá chạy đồng thời: một lần thắng ở ràng buộc
      // duy nhất, lần còn lại nhận lỗi 23505 sau khi transaction đã huỷ —
      // đọc lại tin thắng và trả như một lần gửi thành công.
      if (input.clientMessageId && isUniqueViolation(err)) {
        const existing = await this.repo.getMessageByClientId(conversationId, actorId, input.clientMessageId);
        if (existing) return withQuote(existing);
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
  // --- vòng đời tin nhắn theo vai (issue #33, bổ sung PR #94) ---------------
  //
  // Ba lớp thao tác, tách bạch theo vai — thay mô hình xoá mềm toàn
  // cục cũ (một lần DELETE là tin biến mất với mọi người):
  //   (a) XOÁ-PHÍA-MÌNH (DELETE /messages/:id): chỉ TÁC GIẢ, mọi lúc
  //       không điều kiện cửa sổ — đặt cờ cá nhân
  //       `message_user_deletions`, tin chỉ ẩn khỏi tầm nhìn của
  //       chính người xoá; phía kia và đường truy vết không đổi.
  //   (b) THU HỒI (POST /messages/:id/recall): chỉ TÁC GIẢ, chỉ
  //       trong cửa sổ site-config `core/messagingrecallwindowminutes`
  //       (mặc định 15 phút từ lúc gửi) — nội dung bị vô hiệu với
  //       mọi thành viên thường, ghi dấu moderator_action 'recall'.
  //       Ngoài cửa sổ người thường không còn thao tác này.
  //   (c) XOÁ CỨNG / GỠ HÀNG LOẠT (POST /messages/:id/hard-delete,
  //       POST /messages/bulk-remove): chỉ người có capability
  //       `moderation:manage` trong phạm vi conversation, không
  //       giới hạn thời gian, lý do BẮT BUỘC và luôn ghi
  //       moderator_action trước khi dòng tin bị xoá vật lý.
  // Cổng chặn hội thoại 1–1 (assertDirectConversationVisible) vẫn đặt
  // TRƯỚC (a) và (b) như mọi đường theo id của người dùng thường;
  // đường (c) là đường kiểm duyệt có thẩm quyền riêng — như đường
  // xem báo cáo — nên KHÔNG qua cổng chặn: kiểm duyệt phải xử lý
  // được cả nội dung trong hội thoại đang bị chặn.

  /**
   * Cổng trần độ dài tin (lát M2, issue #212; chính sách P2 ở #33):
   * trần đọc từ site-config `core/messagingmaxmessagelength` (mặc
   * định 10.000 theo registry; 0 = tắt trần), đếm theo ký tự người
   * dùng thấy qua {@link countUserVisibleCharacters}. Vượt trần →
   * 400 `messaging.message_too_long`. Chỉ áp cho đường gửi tin của
   * người dùng (`sendMessage`) — tin hệ thống qua `notify()` không
   * qua cổng này.
   */
  private async assertMessageLengthAllowed(text: string): Promise<void> {
    const value = await this.siteConfig.getValue<number>('core', 'messagingmaxmessagelength');
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const max = Math.floor(value);
    if (max <= 0) return;
    const count = countUserVisibleCharacters(text);
    if (count > max) {
      throw new BadRequestException({
        message: `Message is too long: ${count} characters (maximum ${max})`,
        code: 'messaging.message_too_long',
      });
    }
  }

  /** Cửa sổ thu hồi hiện hành (phút) đọc từ site-config; giá trị lỗi/thiếu → mặc định 15. */
  private async recallWindowMinutes(): Promise<number> {
    const value = await this.siteConfig.getValue<number>('core', 'messagingrecallwindowminutes');
    if (typeof value !== 'number' || !Number.isFinite(value)) return 15;
    return Math.max(0, Math.floor(value));
  }

  /**
   * Cổng thẩm quyền XOÁ CỨNG: phải có thẩm quyền kiểm duyệt TRÊN
   * conversation (staff khoá/quản trị — canModerateConversation) VÀ
   * capability `moderation:manage` tại context khoá của conversation.
   * Conversation không thuộc khoá nào thì chỉ quản trị viên toàn
   * site qua được (canModerate đã là admin-only ở trường hợp đó và
   * evaluator cho admin qua mọi kiểm tra capability).
   */
  private async assertCanHardDelete(actorId: string, conversation: ConversationRow): Promise<void> {
    const forbidden = () => new ForbiddenException({
      message: 'Only a moderator with the moderation:manage capability in this conversation scope can permanently remove messages',
      code: 'messaging.message_moderation_forbidden',
    });
    if (!(await this.canModerateConversation(actorId, conversation))) throw forbidden();
    const courseId = await this.resolveConversationCourseId(conversation);
    if (!courseId) {
      if (!(await this.evaluator.isSiteAdmin(actorId))) throw forbidden();
      return;
    }
    const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
    const allowed = courseCtx
      ? await this.evaluator.hasCapability(actorId, 'moderation:manage', courseCtx.id)
      : await this.evaluator.isSiteAdmin(actorId);
    if (!allowed) throw forbidden();
  }

  /**
   * Lớp (a) — XOÁ-PHÍA-MÌNH: tác giả ẩn tin của chính mình khỏi tầm
   * nhìn của mình, mọi lúc. KHÔNG đổi dòng tin, KHÔNG ảnh hưởng phía
   * kia; sự kiện `message_deleted_for_me` chỉ phân phối tới CHÍNH
   * người xoá (đồng bộ các thiết bị của họ). Người không phải tác
   * giả → 403 (kể cả moderator: gỡ cho mọi người là việc của lớp
   * (c), không mượn đường này). Idempotent: xoá lại là no-op 200.
   */
  async deleteMessage(actorId: string, messageId: string): Promise<MessageRow> {
    const existing = await this.repo.getMessage(messageId);
    if (!existing) throw new NotFoundException({ message: `Message ${messageId} not found`, code: 'messaging.message_not_found' });
    const conversation = await this.repo.getConversation(existing.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${existing.conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    // Cổng hiển thị khi chặn (việc nối tiếp #33, siết sau PR #94):
    // hội thoại 1–1 đang chặn hành xử như KHÔNG TỒN TẠI ở mọi đường
    // theo id — kể cả xoá-phía-mình. Đặt TRƯỚC kiểm tra tác giả để
    // phía bị chặn nhận 404 thay vì 403 và không sự kiện nào phát ra.
    await this.assertDirectConversationVisible(actorId, conversation);
    if (existing.userIdFrom !== actorId) {
      throw new ForbiddenException({
        message: 'Only the author can delete this message for themselves; permanent removal belongs to moderators',
        code: 'messaging.message_delete_forbidden',
      });
    }
    // Tin đã bị xoá mềm toàn cục (dữ liệu từ mô hình cũ): không còn
    // hiển thị với ai — không còn gì để ẩn thêm, trả nguyên trạng.
    if (existing.deletedAt) return existing;
    if (!(await this.repo.isDeletedForUser(messageId, actorId))) {
      await this.repo.markDeletedForUser(messageId, actorId);
      const courseId = await this.resolveConversationCourseId(conversation);
      await this.outbox.enqueueStandalone({
        aggregate: 'messaging', type: 'message_deleted_for_me',
        payload: {
          actorId, conversationId: conversation.id, messageId, seq: existing.seq,
          authorId: existing.userIdFrom, courseId: courseId ?? undefined,
        },
      });
    }
    return existing;
  }

  /**
   * Lớp (b) — THU HỒI cho mọi người: chỉ tác giả, chỉ trong cửa sổ
   * cấu hình kể từ lúc gửi. Thu hồi thành công: set dấu
   * `recalled_at`/`recalled_by`, ghi moderator_action 'recall'
   * TRƯỚC khi đổi trạng thái, phát `message_recalled` (phía kia gỡ
   * nội dung + vô hiệu cache danh sách). Ngoài cửa sổ → 403
   * `messaging.recall_window_expired` — người thường chỉ còn lớp
   * (a). Thu hồi lại tin đã thu hồi là idempotent (giữ dấu đầu).
   */
  async recallMessage(actorId: string, messageId: string): Promise<MessageRow> {
    const existing = await this.repo.getMessage(messageId);
    if (!existing) throw new NotFoundException({ message: `Message ${messageId} not found`, code: 'messaging.message_not_found' });
    const conversation = await this.repo.getConversation(existing.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${existing.conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    // Cùng cổng chặn như lớp (a): đang chặn thì hội thoại như không
    // tồn tại — không thu hồi được và không phát sự kiện nào.
    await this.assertDirectConversationVisible(actorId, conversation);
    if (existing.userIdFrom !== actorId) {
      throw new ForbiddenException({
        message: 'Only the author can recall this message',
        code: 'messaging.message_recall_forbidden',
      });
    }
    if (existing.recalledAt) return existing;
    if (existing.deletedAt) {
      throw new BadRequestException({
        message: 'This message is already deleted and can no longer be recalled',
        code: 'messaging.message_already_deleted',
      });
    }
    const windowMinutes = await this.recallWindowMinutes();
    if (!isWithinRecallWindow(existing.createdAt, new Date(), windowMinutes)) {
      throw new ForbiddenException({
        message: `The recall window of ${windowMinutes} minutes has expired for this message`,
        code: 'messaging.recall_window_expired',
      });
    }
    await this.repo.insertModeratorAction({
      messageId, conversationId: conversation.id, actorId, authorId: existing.userIdFrom,
      action: 'recall', reason: null, messageSeq: existing.seq,
    });
    const recalled = await this.repo.applyRecall(messageId, actorId);
    const courseId = await this.resolveConversationCourseId(conversation);
    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'message_recalled',
      payload: {
        actorId, conversationId: conversation.id, messageId, seq: existing.seq,
        recalledBy: actorId, authorId: existing.userIdFrom, courseId: courseId ?? undefined,
      },
    });
    return recalled!;
  }

  /**
   * Lớp (c) — XOÁ CỨNG một tin: chỉ moderator có `moderation:manage`
   * trong phạm vi, lý do bắt buộc (chốt ở DTO), không giới hạn thời
   * gian. Dấu vết moderator_action ghi TRƯỚC, dòng tin xoá vật lý
   * SAU — sau thao tác này nội dung không còn ở bất kỳ đường đọc
   * nào, kể cả truy vết; căn cứ duy nhất còn lại là dòng hành động.
   */
  async hardDeleteMessage(actorId: string, messageId: string, input: { reason: string }): Promise<{ deleted: true; messageId: string; conversationId: string }> {
    const existing = await this.repo.getMessage(messageId);
    if (!existing) throw new NotFoundException({ message: `Message ${messageId} not found`, code: 'messaging.message_not_found' });
    const conversation = await this.repo.getConversation(existing.conversationId);
    if (!conversation) throw new NotFoundException({ message: `Conversation ${existing.conversationId} not found`, code: 'messaging.conversation_not_found' });
    await this.syncGroupConversationIfLinked(conversation);
    await this.assertCanHardDelete(actorId, conversation);
    await this.repo.insertModeratorAction({
      messageId, conversationId: conversation.id, actorId, authorId: existing.userIdFrom,
      action: 'hard_delete', reason: input.reason, messageSeq: existing.seq,
    });
    await this.repo.hardDeleteMessage(messageId);
    const courseId = await this.resolveConversationCourseId(conversation);
    await this.outbox.enqueueStandalone({
      aggregate: 'messaging', type: 'message_removed',
      payload: {
        actorId, conversationId: conversation.id, messageId, seq: existing.seq,
        removedBy: actorId, authorId: existing.userIdFrom, courseId: courseId ?? undefined,
      },
    });
    return { deleted: true, messageId, conversationId: conversation.id };
  }

  /**
   * Lớp (c) — GỠ HÀNG LOẠT: cùng cổng thẩm quyền và lý do bắt buộc
   * như xoá cứng một tin. Toàn bộ danh sách được kiểm tra (tồn tại +
   * thẩm quyền trên TỪNG conversation liên quan) TRƯỚC khi bất kỳ
   * tin nào bị gỡ — một tin hỏng là cả yêu cầu bị từ chối, không gỡ
   * một phần. Mỗi tin một dòng moderator_action 'bulk_hard_delete'
   * và một sự kiện `message_removed` riêng.
   */
  async bulkRemoveMessages(actorId: string, input: { messageIds: string[]; reason: string }): Promise<{ removed: number; messageIds: string[] }> {
    const uniqueIds = [...new Set(input.messageIds)];
    const rows = await this.repo.getMessagesByIds(uniqueIds);
    if (rows.length !== uniqueIds.length) {
      throw new NotFoundException({ message: 'One or more messages were not found', code: 'messaging.message_not_found' });
    }
    const conversations = new Map<string, ConversationRow>();
    for (const row of rows) {
      let conversation = conversations.get(row.conversationId);
      if (!conversation) {
        conversation = (await this.repo.getConversation(row.conversationId)) ?? undefined;
        if (!conversation) throw new NotFoundException({ message: `Conversation ${row.conversationId} not found`, code: 'messaging.conversation_not_found' });
        await this.syncGroupConversationIfLinked(conversation);
        conversations.set(row.conversationId, conversation);
      }
      await this.assertCanHardDelete(actorId, conversation);
    }
    for (const row of rows) {
      await this.repo.insertModeratorAction({
        messageId: row.id, conversationId: row.conversationId, actorId, authorId: row.userIdFrom,
        action: 'bulk_hard_delete', reason: input.reason, messageSeq: row.seq,
      });
    }
    for (const row of rows) {
      await this.repo.hardDeleteMessage(row.id);
    }
    for (const row of rows) {
      const conversation = conversations.get(row.conversationId)!;
      const courseId = await this.resolveConversationCourseId(conversation);
      await this.outbox.enqueueStandalone({
        aggregate: 'messaging', type: 'message_removed',
        payload: {
          actorId, conversationId: row.conversationId, messageId: row.id, seq: row.seq,
          removedBy: actorId, authorId: row.userIdFrom, bulk: true, courseId: courseId ?? undefined,
        },
      });
    }
    return { removed: rows.length, messageIds: rows.map((row) => row.id) };
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
    await this.assertConversationMember(actorId, conversation);
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
        // Nguồn của thông báo là khoá của conversation bị báo cáo
        // (NB-4): người nhận đã tắt tiếng khoá đó thì ghi đè theo
        // khoá áp dụng như mọi thông báo gắn khoá khác.
        courseId: courseId ?? undefined,
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
    const conversation = await this.repo.getConversation(conversationId);
    if (conversation) {
      // Cổng thành viên (conversation cấp khoá → 404 với người ngoài)
      // + cùng cổng chặn với đường đọc: hội thoại 1–1 đang chặn thì
      // đánh dấu đã đọc cũng 404 như không tồn tại — không phát biên
      // đã-đọc cho phía bên kia qua outbox.
      await this.assertConversationMember(userId, conversation);
      await this.assertDirectConversationVisible(userId, conversation);
    } else if (!(await this.repo.isMember(conversationId, userId))) {
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
