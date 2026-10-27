import { BadRequestException, ForbiddenException, Logger, NotFoundException, type MessageEvent } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Observable } from 'rxjs';
import type { NotificationGroup, NotificationGroupPage, NotificationItem, NotificationItemPage } from '@lms/contracts';
import type { ListNotificationGroupsQueryDto, ListNotificationItemsQueryDto, ReadNotificationGroupDto } from './dto/messaging.dto';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { UsersService } from '../users/users.service';
import { MessagingRepository, type NotificationRow } from './messaging.repository';
import { NotificationUnreadStreamService } from './notification-unread-stream.service';
import { tenantAls } from '../tenants/tenant-als';
import { MessagingGroupTreeService } from './messaging-group-tree.service';
import {
  MESSAGE_PROVIDERS,
  providerByName,
  externalPolicyOf,
  providerVisibleToAudiences,
  isTeacherOnlyProvider,
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
  type EmailFrequency,
  type ExternalContentPolicy,
  type MessageProviderDefinition,
  type NotificationAudience,
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

export interface NotificationChannelPort {
  channel: MessageChannel;
  /** Phân phối thật hoặc ghi lại dispatch. Trả trạng thái log. */
  /**
   * Phân phối một notification tới các kênh đã bật của người nhận và ghi dispatch log.
   */
  deliver(input: { userId: string; provider: string; subject: string; body: string; notificationId: string | null }): Promise<string>;
}

/**
 * TUỲ CHỌN + PHÁT THÔNG BÁO của MessagingModule (cụm ca sử dụng
 * "tuỳ chọn và phát thông báo").
 *
 * Luồng nghiệp vụ: NOTIFICATION là thông báo hệ thống do các provider
 * đã đăng ký (notification-providers.ts) tạo qua `notify()` và được
 * phân phối theo tuỳ chọn của người nhận (provider × kênh): kênh
 * trong app (popup) là kênh thật duy nhất — dòng notification CHÍNH LÀ
 * lần phân phối; kênh ngoài (email qua Resend từ NB-5/issue #174,
 * push) đi qua hàng đợi BullMQ 'notification-dispatch' do worker tiêu
 * thụ. Thứ tự cổng khi phát: người nhận suspended/đã xoá không nhận
 * gì → chính sách admin cấp site (NB-7) → ghi đè tắt tiếng theo khoá
 * (NB-4) → tuỳ chọn v2 của người nhận; mọi lần phân phối/bỏ qua đều
 * ghi dispatch log để truy vết. Tuỳ chọn v2 (popup bật/tắt + tần suất
 * email) quyết ngay tại lần phát — đổi tuỳ chọn hiệu lực ở lần phát
 * kế tiếp. Trung tâm thông báo v2 (issue #51) gộp danh sách theo
 * (loại × nguồn × ngày) với phân trang keyset; số chưa đọc đẩy qua
 * SSE (NotificationUnreadStreamService) thay cho polling.
 *
 * Cách lắp ráp (issue #295): service này là một CỤM của MessagingModule,
 * tách từ MessagingService cũ theo cụm ca sử dụng — tách cấu trúc thuần,
 * không đổi hành vi. MessagingService nay là facade giữ nguyên bề mặt
 * công khai và chữ ký constructor (khớp main hiện tại, gồm tham số
 * I18nService thứ 11 cho luật C-5), tự lắp ráp các service cụm trong
 * constructor của nó (các test đơn vị hiện hữu khởi tạo trực tiếp
 * `new MessagingService(...)` với đúng các phụ thuộc hạ tầng nên
 * facade là điểm lắp ráp để giữ nguyên hợp đồng khởi tạo đó) và
 * chuyển tiếp I18nService cho riêng cụm này, vì chỉ `notify()` của
 * cụm này dùng nó (phân giải nội dung kênh ngoài theo luật C-5);
 * các service cụm không đăng ký provider riêng trong module và module
 * wiring giữ nguyên như trước khi tách.
 */
export class MessagingNotificationsService {
  private readonly logger = new Logger(MessagingNotificationsService.name);

  constructor(
    private readonly repo: MessagingRepository,
    private readonly users: UsersService,
    private readonly evaluator: PermissionEvaluator,
    private readonly outbox: OutboxService,
    private readonly unreadStream: NotificationUnreadStreamService,
    private readonly dispatchQueue: Queue,
    private readonly siteConfig: SiteConfigService,
    private readonly groupTree: MessagingGroupTreeService,
    // I18n: notify() dùng để dựng BẢN TÓM TẮT MẶC ĐỊNH cho kênh ngoài
    // theo luật C-5 (issue #219) khi provider thuộc diện tối thiểu hoá
    // mà nơi gọi không truyền bản tối thiểu hoá. Facade chuyển tiếp
    // tham số này từ constructor của chính nó (tham số thứ 11).
    private readonly i18n: I18nService,
  ) {}

  // --- tuỳ chọn -----------------------------------------------------------

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
   * mặt tối thiểu của học sinh (NB-7, issue #174 — quy định:
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
   * Tập CONTEXT VAI thật của user cho tầng phân chia tuỳ chọn thông
   * báo theo audience (việc nối tiếp của issue #288): registry khai
   * mỗi provider thuộc phía người nhận nào (học sinh / nhân sự / phụ
   * huynh / admin / mọi vai — truy vết tại điểm phát), còn tập này
   * trả lời user đang đứng ở những phía nào THẬT:
   *
   * - `'admin'` + mọi phía còn lại khi user là site admin: context
   *   quản trị phủ mọi audience — admin là người cấu hình chính sách
   *   phát cấp site cho cả 20 loại (NB-7) và `admin_announcement`
   *   có thể gửi đích danh cho bất kỳ ai kể cả chính admin, nên bề
   *   mặt của admin giữ nguyên đầy đủ như trước lát này.
   * - `'staff'` khi có gán vai nhân sự — CÙNG nguồn với cổng bề mặt
   *   đầy đủ ở trên (`hasStaffRoleAssignment`), không cơ chế song song.
   * - `'student'` khi có context học sinh thật (ghi danh hiệu lực ∪
   *   gán vai archetype student — `repo.hasStudentContext`): giáo
   *   viên thuần không có context này nên không thấy loại chỉ học
   *   sinh nhận; người vừa dạy vừa học thì có cả hai phía.
   * - `'guardian'` khi có liên kết giám hộ đang hiệu lực trong vai
   *   phụ huynh (`repo.hasActiveGuardianLink`).
   *
   * @param userId - User cần tính tập context vai.
   * @returns Tập audience mà user có ít nhất một context thuộc về.
   */
  async resolvePreferenceAudiences(userId: string): Promise<Set<NotificationAudience>> {
    if (await this.evaluator.isSiteAdmin(userId)) {
      return new Set<NotificationAudience>(['student', 'staff', 'guardian', 'admin', 'all']);
    }
    const audiences = new Set<NotificationAudience>();
    if (await this.repo.hasStaffRoleAssignment(userId)) audiences.add('staff');
    if (await this.repo.hasStudentContext(userId)) audiences.add('student');
    if (await this.repo.hasActiveGuardianLink(userId)) audiences.add('guardian');
    return audiences;
  }

  /**
   * Kênh có đang bật cho provider này theo tuỳ chọn của user (phân biệt logged-in/logged-off) hay không.
   * CHỈ còn dùng cho kênh push (chưa có mô hình v2 — push ẩn khỏi trang
   * cài đặt cho tới khi có app native) và làm nền suy giá trị cũ.
   */
  async isChannelEnabled(userId: string, provider: string, channel: MessageChannel, state: LoginState): Promise<boolean> {
    const value = await this.users.getPreference(userId, preferenceName(provider, channel, state));
    return value !== '0'; // mặc định: bật (mặc định của Moodle cho provider lõi)
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

  /**
   * Một dòng tuỳ chọn v2 đầy đủ (nhãn/mô tả từ registry + giá trị hiệu
   * lực của user). Kèm `siteEnabled` — chính sách phát của admin ở cấp
   * site (NB-7) qua đúng hàm `isProviderEnabledBySitePolicy` mà
   * `notify()` tôn trọng khi phát — để trang Cài đặt thông báo hiển
   * thị "Admin đã tắt ở cấp site" và khoá điều khiển: chỉ là BỀ MẶT
   * HIỂN THỊ của chính sách đã thi hành ở server, không đổi mô hình
   * dữ liệu hay luật phát nào.
   */
  private async preferenceView(userId: string, provider: MessageProviderDefinition): Promise<NotificationPreferenceView> {
    const resolved = await this.resolveNotificationPreference(userId, provider);
    return {
      provider: provider.name, component: provider.component, group: provider.group,
      label: provider.label, description: provider.description,
      // teacherOnly là giá trị SUY RA từ audience của registry (hàm
      // isTeacherOnlyProvider) — registry không còn cờ khai riêng.
      teacherOnly: isTeacherOnlyProvider(provider), mandatoryInApp: provider.mandatoryInApp ?? false,
      popupEnabled: resolved.popupEnabled, emailFrequency: resolved.emailFrequency,
      emailAvailable: EMAIL_CHANNEL_AVAILABLE,
      siteEnabled: await this.isProviderEnabledBySitePolicy(provider),
    };
  }

  /**
   * Tuỳ chọn notification v2 của user: một dòng cho mỗi provider đã
   * đăng ký (NB-2 — không còn ma trận provider × kênh × trạng thái),
   * LỌC theo audience của registry giao với context vai thật của
   * user (lát phân chia theo vai, issue #288): giáo viên thuần không
   * còn thấy loại chỉ học sinh nhận (báo điểm, bài mới giao…) hay
   * loại của phụ huynh; người nhiều vai thấy hợp nhất các phía của
   * mình. Học sinh thuần (NB-7) giữ nguyên hành vi cũ: danh sách
   * theo loại rỗng — bề mặt tuỳ chọn duy nhất của họ là ngoại lệ
   * theo khoá (NB-4) ở endpoint riêng; cổng NB-7 chạy TRƯỚC tầng
   * audience và không đổi.
   */
  async getPreferences(userId: string): Promise<NotificationPreferenceView[]> {
    if (!(await this.hasFullNotificationPreferences(userId))) return [];
    const audiences = await this.resolvePreferenceAudiences(userId);
    const out: NotificationPreferenceView[] = [];
    for (const provider of MESSAGE_PROVIDERS) {
      if (providerVisibleToAudiences(provider, audiences)) out.push(await this.preferenceView(userId, provider));
    }
    return out;
  }

  /**
   * Đặt tuỳ chọn v2 cho MỘT provider (popup và/hoặc tần suất email).
   * Ghi khoá v2 mới; khoá cũ không bị xoá hay ghi đè. Tắt popup của
   * loại bắt buộc (P2) bị từ chối — kênh ngoài của loại bắt buộc vẫn
   * tắt được tuyệt đối qua emailFrequency='off'. Hai cổng chặn ở
   * server chạy trước khi ghi: cổng bề mặt NB-7 (chỉ nhân sự/admin —
   * 403 `messaging.preference_staff_only`) và cổng audience theo
   * vai + context (issue #288 — 403 `messaging.preference_audience`).
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
    // Phân chia theo vai + context (issue #288): provider ngoài
    // audience của user bị từ chối ngay ở server (403, cùng họ với
    // cổng staff-only ở trên) — không chỉ giấu ở giao diện, để client
    // nào gọi thẳng API cũng không đặt được tuỳ chọn cho loại thông
    // báo mà vai của mình không bao giờ nhận. Chạy ngay sau khi tra
    // được provider (provider không tồn tại vẫn là 400 ở trên, vì
    // không có audience để đối chiếu) và trước các kiểm chứng payload.
    if (!providerVisibleToAudiences(provider, await this.resolvePreferenceAudiences(userId))) {
      throw new ForbiddenException({
        message: `Notification type ${input.provider} is not available for your roles`,
        code: 'messaging.preference_audience',
      });
    }
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
    const courses = await this.groupTree.listMyMessagingCourses(userId);
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
    const courses = await this.groupTree.listMyMessagingCourses(userId);
    const course = courses.find((c) => c.courseId === input.courseId);
    if (!course) {
      throw new NotFoundException({ message: 'Course not found', code: 'messaging.course_not_found' });
    }
    await this.users.setPreference(userId, coursePreferenceName(input.courseId), input.mode);
    return { courseId: course.courseId, courseName: course.fullName, mode: input.mode };
  }

  // --- notification -----------------------------------------------------------

  /**
   * Tạo một notification hệ thống cho một user qua một provider đã đăng ký.
   * Người nhận được coi là ĐÃ ĐĂNG NHẬP cho quyết định kênh trong-app
   * khi họ có bất kỳ ngữ nghĩa session sống nào trong luồng API; phía hệ thống
   * truyền `loggedIn` tường minh (mặc định true cho lời gọi API trực tiếp).
   * Một tuỳ chọn đặt disabled cho trạng thái liên quan nghĩa là kênh
   * KHÔNG được phân phối — và điều đó được khẳng định bởi dispatch log.
   */
  /**
   * Tạo notification cho user từ một provider (điểm vào chuẩn của các module khác).
   *
   * LUẬT TỐI THIỂU HOÁ KÊNH NGOÀI (chuẩn Canvas, lát N1 issue #49;
   * siết chặt theo quyết định C-5 của issue #219 — CẤM fallback
   * nguyên văn tại điểm này): nội dung rời khỏi app (email/push)
   * KHÔNG chứa dữ liệu học tập/riêng tư — không điểm số, không nội
   * dung tin nhắn. Job phân phối kênh ngoài chỉ được mang đúng một
   * trong ba thứ sau (phân giải tại `resolveExternalContent`):
   *
   *  1. Bản tối thiểu hoá `externalSubject`/`externalBody` do phía
   *     gọi truyền — chỉ thay nội dung của job kênh ngoài, bản
   *     trong app giữ nguyên subject/body.
   *  2. Nội dung gốc — CHỈ khi provider được khai báo tường minh
   *     `externalPolicy: 'original-ok'` kèm lý do trong registry
   *     provider (`notification-providers.ts`); không khai báo =
   *     mặc định `'minimized'`.
   *  3. BẢN TÓM TẮT MẶC ĐỊNH dựng từ mẫu i18n chung (chỉ nêu loại
   *     sự kiện; `contextUrl` trên notification trong app giữ
   *     nguyên nên kênh ngoài vẫn là đường dẫn vào app sau đăng
   *     nhập) — áp dụng khi provider thuộc diện `'minimized'` mà
   *     phía gọi thiếu bản tối thiểu hoá, kèm log cảnh báo để nơi
   *     gọi chưa phân loại lộ diện khi vận hành. Riêng ở môi trường
   *     test, trường hợp này NÉM LỖI thay vì thay thế, để bộ test
   *     ép mọi nơi gọi phải được phân loại.
   *
   * Đường `sendSystemNotification` áp cứng nhánh 3 qua cờ
   * `forceExternalMinimized` (nội dung là văn bản tự do của quản trị
   * viên, không qua mẫu nào).
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
    const provider = providerByName(providerName);
    if (!provider) return { provider: providerName, userId, notificationId: null, channels: {}, skipped: 'unknown-provider' };
    const recipient = await this.users.getByIdOrUndefined(userId);
    let tenantId = input.tenantId ?? tenantAls.getStore()?.tenantId ?? null;
    if (tenantId === null && recipient) {
      tenantId = await this.repo.getUserDefaultTenantId(userId);
    }
    const tenantKey = tenantId ?? 'platform';
    if (!recipient || recipient.suspended || recipient.deleted) {
      // User bị suspended không nhận gì (report §2#12). Không gì được lưu.
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

    // Trong-app (popup) là kênh THẬT duy nhất: dòng notification CHÍNH LÀ lần phân phối.
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

    // Kênh ngoài là các cổng: một job BullMQ mang việc phân phối sang
    // worker. Bị tắt theo tuỳ chọn ⇒ không xếp job nào cả.
    // Email theo tần suất v2: 'off' chặn ngay tại đây. Từ NB-5 (issue
    // #174) kênh email gửi thật qua Resend ở phía worker: job mang
    // theo tần suất đã phân giải ở đây — 'immediate' gửi ngay khi
    // job chạy, 'daily' được worker ghi nhận vào hàng chờ và gom
    // thành email tổng hợp theo ngày (động cơ digest ở worker). Push
    // giữ luật cũ theo trạng thái và vẫn là cổng ghi log ở worker.
    // Nội dung kênh ngoài phân giải LƯỜI tại job đầu tiên thật sự
    // được xếp (luật C-5 — xem docblock của notify): kênh bị tuỳ
    // chọn tắt thì không xếp job và cũng không kích hoạt phân giải,
    // để luật cấm chỉ gõ đúng khi nội dung thật sự sắp rời app.
    // Phân giải một lần, dùng chung cho mọi kênh ngoài của lần phát.
    let externalContent: { subject: string; body: string } | undefined;
    for (const channel of provider.channels.filter((c) => c !== 'popup')) {
      const channelEnabled = channel === 'email'
        ? resolved.emailFrequency !== 'off'
        : await this.isChannelEnabled(userId, providerName, channel, state);
      if (channelEnabled) {
        externalContent ??= this.resolveExternalContent(provider, userId, input);
        const dedupeKey = `${tenantKey}-dispatch-${providerName}-${userId}-${channel}-${notificationId ?? randomUUID()}`;
        await this.dispatchQueue.add('dispatch', {
          userId, provider: providerName, channel, tenantId,
          // Tần suất email đã phân giải (NB-5): worker dựa vào đây
          // để quyết gửi ngay hay gom digest — không phân giải lại.
          ...(channel === 'email' ? { emailFrequency: resolved.emailFrequency } : {}),
          // Nội dung job đã qua luật C-5 (resolveExternalContent):
          // bản tối thiểu hoá của phía gọi, nội dung gốc của
          // provider 'original-ok', hoặc bản tóm tắt mặc định —
          // điểm số/nội dung tin nhắn không bao giờ rời app qua
          // job này dưới dạng nguyên văn của một provider thuộc
          // diện tối thiểu hoá.
          subject: externalContent.subject, body: externalContent.body,
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

  /**
   * Phân giải nội dung mà job phân phối kênh ngoài ĐƯỢC PHÉP mang,
   * theo luật C-5 (issue #219) — xem docblock của `notify()` để có
   * luật đầy đủ. Thứ tự áp dụng:
   *
   *  1. Provider khai báo `'original-ok'` (và lần phát không bị áp
   *     cứng) → bản tối thiểu hoá của phía gọi cho trường nào có
   *     truyền, nội dung gốc cho trường còn lại (hành vi cũ, nay là
   *     ngoại lệ theo khai báo tường minh kèm lý do ở registry).
   *  2. Provider thuộc diện `'minimized'` (khai báo tường minh, mặc
   *     định khi thiếu khai báo, hoặc bị áp cứng qua
   *     `forceExternalMinimized`) và phía gọi truyền ĐỦ cặp
   *     `externalSubject`/`externalBody` → bản tối thiểu hoá đó.
   *  3. Còn lại (diện `'minimized'` mà bản tối thiểu hoá thiếu hoặc
   *     thiếu một phần): ở môi trường test thì NÉM LỖI để lưới test
   *     bắt nơi gọi chưa phân loại — trừ đường áp cứng, nơi thay thế
   *     là hành vi đã thiết kế; ngoài môi trường test thì ghi log
   *     cảnh báo và dùng BẢN TÓM TẮT MẶC ĐỊNH i18n cho (các) trường
   *     còn thiếu — nội dung gốc không xuất hiện trong job ở bất kỳ
   *     trường nào.
   *
   * @param provider - Định nghĩa provider trong registry.
   * @param userId - Người nhận (chỉ để ghi log cảnh báo truy vết).
   * @param input - Đầu vào gốc của `notify()`.
   * @returns Cặp subject/body mà job kênh ngoài được phép mang.
   * @throws Error ở môi trường test khi provider thuộc diện tối
   * thiểu hoá mà phía gọi không truyền đủ bản tối thiểu hoá (và lần
   * phát không thuộc đường áp cứng).
   */
  private resolveExternalContent(
    provider: MessageProviderDefinition,
    userId: string,
    input: {
      subject: string; body: string;
      externalSubject?: string; externalBody?: string;
      forceExternalMinimized?: boolean;
    },
  ): { subject: string; body: string } {
    const policy: ExternalContentPolicy = input.forceExternalMinimized
      ? 'minimized'
      : externalPolicyOf(provider);
    if (policy === 'original-ok') {
      return { subject: input.externalSubject ?? input.subject, body: input.externalBody ?? input.body };
    }
    if (input.externalSubject !== undefined && input.externalBody !== undefined) {
      return { subject: input.externalSubject, body: input.externalBody };
    }
    if (!input.forceExternalMinimized && process.env.NODE_ENV === 'test') {
      throw new Error(
        `messaging.external_minimization_required: provider "${provider.name}" is classified 'minimized' for external channels but notify() received no complete externalSubject/externalBody — pass minimized variants at the call site or declare 'original-ok' with a reason in the provider registry (C-5, issue #219)`,
      );
    }
    this.logger.warn(
      input.forceExternalMinimized
        ? `notify(): đường gửi hệ thống áp cứng tối thiểu hoá cho provider "${provider.name}" (người nhận ${userId}) — job kênh ngoài dùng bản tóm tắt mặc định (C-5, issue #219).`
        : `notify(): provider "${provider.name}" thuộc diện tối thiểu hoá kênh ngoài nhưng nơi gọi không truyền đủ bản tối thiểu hoá (người nhận ${userId}) — job kênh ngoài dùng bản tóm tắt mặc định (C-5, issue #219).`,
    );
    return {
      subject: input.externalSubject ?? String(this.i18n.t('platform.externalGenericSubject', { locale: 'vi' })),
      body: input.externalBody ?? String(this.i18n.t('platform.externalGenericBody', { locale: 'vi', args: { event: provider.label.vi } })),
    };
  }

  /** Endpoint /notifications/send là kích hoạt hệ thống: chỉ site admin. */
  /**
   * Gửi notification hệ thống (vd hoàn tất báo cáo) kèm nội dung đã dịch.
   *
   * Luật C-5 (issue #219): nội dung của đường này là VĂN BẢN TỰ DO
   * do quản trị viên soạn và provider do DTO quyết định — bề mặt
   * duy nhất không có trần nội dung — nên đường này ÁP CỨNG chính
   * sách tối thiểu hoá kênh ngoài (`forceExternalMinimized: true`):
   * bản trong app giữ nguyên văn, job kênh ngoài chỉ mang bản tóm
   * tắt mặc định bất kể provider trong DTO khai báo gì ở registry.
   */
  async sendSystemNotification(actorId: string, dto: { userId: string; provider: string; subject: string; body: string; contextUrl?: string }): Promise<NotifyResult> {
    if (!(await this.evaluator.isSiteAdmin(actorId))) {
      throw new ForbiddenException({ message: 'Only site administrators can trigger system notifications directly', code: 'messaging.system_send_forbidden' });
    }
    return this.notify(dto.userId, dto.provider, { subject: dto.subject, body: dto.body, contextUrl: dto.contextUrl, forceExternalMinimized: true });
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
}
