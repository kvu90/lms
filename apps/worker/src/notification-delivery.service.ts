import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { I18nService } from '@nestjs/i18n';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { redisConnectionFromUrl } from './config/env';
import { sql, type CentreDB } from '@lms/db';
import { SpaceDatabaseService } from './db/routing/space-database.service';

/**
 * Kênh Redis pub/sub mang tín hiệu "số thông báo chưa đọc của một user
 * vừa thay đổi" — PHẢI khớp hằng số cùng tên phía API
 * (`notification-unread-stream.service.ts`): payload chỉ là userId, số
 * đếm thật luôn được phía API đọc lại từ database.
 */
export const NOTIFICATION_UNREAD_CHANGED_CHANNEL = 'lms:notifications:unread-changed';

/** Định nghĩa provider tối thiểu mà phía worker cần để áp luật phân phối. */
export interface WorkerProviderLaw {
  name: string;
  component: string;
  /** Loại bắt buộc (P2): luôn giao ở kênh trong-app, không tắt được. */
  mandatoryInApp: boolean;
}

/**
 * Sổ provider phía worker — chỉ gồm các provider mà WORKER là nơi phát
 * (các đường trước đây ghi thẳng vào bảng notifications). `component` và
 * `mandatoryInApp` PHẢI khớp `MESSAGE_PROVIDERS` phía API
 * (apps/api/src/modules/messaging/notification-providers.ts) — nguồn
 * sự thật của registry vẫn là phía API; bảng này là bản chiếu tối thiểu
 * để worker áp đúng luật mà không import ngược từ app API (khác tiến
 * trình). Spec parity của issue #293 gác đối chiếu này tự động: đổi
 * registry mà không cập nhật bản chiếu ở đây thì spec đỏ.
 *
 * `badge_awarded` vào sổ ở lát #174-A: đường cấp huy hiệu nền của
 * `BadgeAwardProcessor` quy về hàm luật chung này thay cho đường ghi
 * thẳng trước đây (lớp G10) — từ đây thông báo huy hiệu phía worker áp
 * đủ luật như hai đường NB-6 (đình chỉ / chính sách admin NB-7 / ghi đè
 * tắt tiếng theo khoá NB-4 / tuỳ chọn người dùng) và có dispatch log.
 *
 * Hai provider digest phụ huynh (`guardian_digest`,
 * `guardian_overdue_alert`) vào sổ khi consumer digest chuyển sang
 * worker (issue con #518 của #491): chúng là các provider đầu tiên mà
 * worker phát TRỌN notify() gồm cả kênh email — xem {@link notify} và
 * {@link WORKER_NOTIFY_PROVIDERS} ngay dưới. Ba provider còn lại vẫn
 * chỉ phát kênh trong-app qua {@link deliverInApp}.
 *
 * Mười provider của consumer thông báo sự kiện vào sổ khi consumer
 * đó chuyển sang worker (issue con #520 của #491): cả mười đều do
 * `NotificationEventsHandlerService` phát qua {@link notify} — chín
 * provider có kênh email nằm thêm ở {@link WORKER_NOTIFY_PROVIDERS},
 * riêng `course_completed` chỉ có kênh trong-app theo registry nên
 * không vào sổ luật email. `enrol_expiry_warning` là provider bắt
 * buộc (P2) đầu tiên phía worker: `mandatoryInApp: true` phải khớp
 * registry phía API (spec parity canh).
 */
export const WORKER_PROVIDERS: Record<string, WorkerProviderLaw> = {
  calendar_reminder: { name: 'calendar_reminder', component: 'core_calendar', mandatoryInApp: false },
  report_scheduled: { name: 'report_scheduled', component: 'core_reportbuilder', mandatoryInApp: false },
  badge_awarded: { name: 'badge_awarded', component: 'core_badges', mandatoryInApp: false },
  guardian_digest: { name: 'guardian_digest', component: 'core_guardian', mandatoryInApp: false },
  guardian_overdue_alert: { name: 'guardian_overdue_alert', component: 'core_guardian', mandatoryInApp: false },
  grade_updated: { name: 'grade_updated', component: 'core_grades', mandatoryInApp: false },
  course_completed: { name: 'course_completed', component: 'core_completion', mandatoryInApp: false },
  enrol_expiry_warning: { name: 'enrol_expiry_warning', component: 'core_enrol', mandatoryInApp: true },
  activity_due_soon: { name: 'activity_due_soon', component: 'core_course', mandatoryInApp: false },
  assignment_assigned: { name: 'assignment_assigned', component: 'mod_assign', mandatoryInApp: false },
  assignment_submitted: { name: 'assignment_submitted', component: 'mod_assign', mandatoryInApp: false },
  assignment_returned: { name: 'assignment_returned', component: 'mod_assign', mandatoryInApp: false },
  quiz_available: { name: 'quiz_available', component: 'mod_quiz', mandatoryInApp: false },
  quiz_attempt_finished: { name: 'quiz_attempt_finished', component: 'mod_quiz', mandatoryInApp: false },
  message_new: { name: 'message_new', component: 'core_message', mandatoryInApp: false },
};

/** Tần suất email hiệu lực của một thông báo (khớp `EmailFrequency` phía API). */
export type WorkerEmailFrequency = 'immediate' | 'daily' | 'off';

/**
 * Luật kênh email của các provider mà WORKER phát trọn qua
 * {@link NotificationDeliveryService.notify} — ĐÂY LÀ BỀ MẶT DÙNG
 * CHUNG của đợt chuyển consumer sang worker: consumer nào của các
 * issue con sau (ví dụ đường sự kiện thông báo của issue #520) cần
 * phát thông báo có kênh ngoài thì dùng `notify()` ở đây thay vì tự
 * dựng đường phát riêng.
 *
 * Vì sao tách khỏi {@link WORKER_PROVIDERS}: spec parity của issue
 * #293 ghim mỗi mục của sổ đó đúng ba trường
 * {name, component, mandatoryInApp} đối chiếu với registry phía API,
 * nên hai dữ kiện luật email dưới đây — vốn registry phía API suy từ
 * `group` và `label` — phải nằm ở sổ riêng này:
 *
 * - `defaultEmailFrequency`: tần suất email mặc định khi người nhận
 *   chưa đặt tuỳ chọn nào — bản chiếu của `defaultEmailFrequency`
 *   phía API (nhóm 'learning' → 'daily', còn lại → 'immediate'). Cả
 *   hai provider digest phụ huynh đều thuộc nhóm 'learning'.
 * - `labelVi`: nhãn tiếng Việt của provider trong registry phía API,
 *   chỉ dùng làm tham số {event} của nội dung generic khi luật C-5
 *   phải thay cặp nội dung ngoài đã tối thiểu hoá còn thiếu.
 * - `externalPolicy`: chính sách nội dung kênh ngoài của registry
 *   phía API (luật C-5). `'minimized'` — nơi phát PHẢI truyền đủ
 *   cặp `externalSubject`/`externalBody` đã tối thiểu hoá.
 *   `'original-ok'` — registry đã khai báo tường minh kèm lý do
 *   rằng nội dung gốc an toàn cho kênh ngoài: job kênh ngoài mang
 *   bản tối thiểu hoá của nơi phát cho trường nào có truyền, nội
 *   dung gốc cho trường còn lại, đúng nhánh 1 của luật phân giải
 *   phía API (chín provider sự kiện thông báo của issue #520 thuộc
 *   diện này: nội dung của chúng chỉ gồm dữ kiện người nhận tự
 *   thấy — tên khoá/hoạt động, số lượng công việc của chính họ —
 *   và tuyệt đối không chứa điểm số hay nội dung tin nhắn).
 *
 * Có mặt trong sổ này có nghĩa: provider có kênh email mà worker
 * phát trọn qua {@link NotificationDeliveryService.notify}.
 */
export interface WorkerNotifyProviderLaw {
  defaultEmailFrequency: Exclude<WorkerEmailFrequency, 'off'>;
  labelVi: string;
  externalPolicy: 'original-ok' | 'minimized';
}

/** Xem {@link WorkerNotifyProviderLaw}. */
export const WORKER_NOTIFY_PROVIDERS: Record<string, WorkerNotifyProviderLaw> = {
  guardian_digest: { defaultEmailFrequency: 'daily', labelVi: 'Tổng hợp cho phụ huynh', externalPolicy: 'minimized' },
  guardian_overdue_alert: { defaultEmailFrequency: 'daily', labelVi: 'Cảnh báo quá hạn cho phụ huynh', externalPolicy: 'minimized' },
  grade_updated: { defaultEmailFrequency: 'daily', labelVi: 'Điểm số thay đổi', externalPolicy: 'original-ok' },
  enrol_expiry_warning: { defaultEmailFrequency: 'daily', labelVi: 'Sắp hết hạn ghi danh', externalPolicy: 'original-ok' },
  activity_due_soon: { defaultEmailFrequency: 'daily', labelVi: 'Hoạt động sắp đến hạn', externalPolicy: 'original-ok' },
  assignment_assigned: { defaultEmailFrequency: 'daily', labelVi: 'Bài tập mới', externalPolicy: 'original-ok' },
  assignment_submitted: { defaultEmailFrequency: 'daily', labelVi: 'Bài nộp', externalPolicy: 'original-ok' },
  assignment_returned: { defaultEmailFrequency: 'daily', labelVi: 'Bài đã được trả', externalPolicy: 'original-ok' },
  quiz_available: { defaultEmailFrequency: 'daily', labelVi: 'Bài kiểm tra mới', externalPolicy: 'original-ok' },
  quiz_attempt_finished: { defaultEmailFrequency: 'daily', labelVi: 'Lượt làm bài cần chấm', externalPolicy: 'original-ok' },
  message_new: { defaultEmailFrequency: 'immediate', labelVi: 'Tin nhắn mới', externalPolicy: 'original-ok' },
};

/**
 * Các loại KHÔNG bao giờ bị ghi đè tắt tiếng theo khoá chặn — bản chiếu
 * của `COURSE_MUTE_EXEMPT_PROVIDERS` + luật P2 phía API (xem
 * `isExemptFromCourseMute` trong registry): chính sách P3 chừa điểm mới
 * và sắp hết hạn ghi danh của chính khoá bị mute; hai loại bắt buộc P2
 * (`mandatoryInApp`) cũng không bị chặn. Từ issue con #520 của #491,
 * cả hai loại P3 đều có mặt trong `WORKER_PROVIDERS` và do consumer
 * thông báo sự kiện ở worker phát qua {@link NotificationDeliveryService.notify},
 * nên miễn trừ này áp thật trên đường phát của chúng.
 */
const COURSE_MUTE_EXEMPT_PROVIDERS = new Set(['grade_updated', 'enrol_expiry_warning']);

/** Provider này có được miễn trừ khỏi ghi đè tắt tiếng theo khoá hay không (khớp `isExemptFromCourseMute` phía API). */
function isExemptFromCourseMute(provider: WorkerProviderLaw): boolean {
  return provider.mandatoryInApp === true || COURSE_MUTE_EXEMPT_PROVIDERS.has(provider.name);
}

export type InAppDeliveryStatus = 'delivered' | 'skipped-suspended' | 'skipped-preference' | 'skipped-admin-disabled' | 'skipped-course-mute' | 'unknown-provider';
export interface InAppDeliveryResult { status: InAppDeliveryStatus; notificationId?: string }

/**
 * Hàm luật phân phối kênh trong-app DÙNG CHUNG của worker (NB-6, G10) —
 * bản song sinh của `MessagingService.notify()` phía API cho kênh popup,
 * là kênh thật duy nhất mà các processor nền phát:
 *
 * - Người nhận không tồn tại / bị đình chỉ / đã xoá → không lưu gì, chỉ
 *   ghi dispatch log `skipped-suspended` (như API).
 * - Chính sách ADMIN cấp site (NB-7): loại bị admin tắt trong
 *   site-config (`notifications/provider_<tên>_enabled` = false, đọc
 *   thẳng từ `plugin_config` như API đọc qua SiteConfigService) → ghi
 *   dispatch log `skipped-admin-disabled`, không sinh thông báo. Luật
 *   này chạy TRƯỚC tuỳ chọn người dùng, như notify() phía API; loại
 *   bắt buộc (P2) không bao giờ bị chặn ở đây.
 * - Ghi đè TẮT TIẾNG THEO KHOÁ (NB-4, áp ở lát #174-A cho đường huy
 *   hiệu): nơi phát biết sự kiện thuộc khoá nào thì truyền `courseId`;
 *   người nhận đã đặt `notif.course.<courseId>` = 'mute' thì ghi
 *   dispatch log `skipped-course-mute`, không sinh thông báo — đúng
 *   thứ tự luật của notify() phía API (sau NB-7, trước tuỳ chọn theo
 *   loại) và cùng tập miễn trừ P3/P2 (xem `isExemptFromCourseMute`).
 *   Không truyền `courseId` = sự kiện không gắn khoá, ghi đè không áp.
 * - Tuỳ chọn hiệu lực theo đúng luật NB-2 (`resolveNotificationPreference`
 *   phía API): khoá v2 `message_provider_<p>_popup_v2` trước; chưa có thì
 *   suy từ dữ liệu cũ theo thứ tự loggedin → loggedoff; chưa đặt ở đâu
 *   thì mặc định bật. Loại bắt buộc (P2) ép bật bất kể giá trị đã lưu.
 * - Giao được → dòng `notifications` + dispatch log `delivered`
 *   (dedupeKey `popup-<notificationId>` như API) + phát tín hiệu badge
 *   qua Redis pub/sub để số chưa đọc cập nhật ngay trên stream SSE.
 * - Tắt theo tuỳ chọn → dispatch log `skipped-preference`, không sinh
 *   thông báo.
 *
 * Kênh ngoài (email/push) không thuộc `deliverInApp`: các đường phát
 * nền trước đây không hề xếp hàng job kênh ngoài. Động cơ kênh ngoài
 * nằm ở processor `notification-dispatch` (gửi email thật qua Resend
 * từ NB-5 của issue #174, kèm tổng hợp theo ngày) — `deliverInApp`
 * chỉ nhất quán hoá đường trong-app.
 *
 * Từ issue con #518 của #491, service có thêm {@link notify}: bản đầy
 * đủ của notify() phía API cho các sự kiện mà WORKER là nơi phát và
 * registry có kênh ngoài (xem {@link WORKER_NOTIFY_PROVIDERS} — hai
 * provider digest phụ huynh từ #518, chín provider sự kiện thông báo
 * từ issue con #520). `notify()` dùng lại chính `deliverInApp` cho
 * nửa kênh trong-app (một bản luật popup duy nhất, không fork), tự
 * lo nửa kênh email (phân giải tần suất + luật C-5 + xếp job vào
 * hàng đợi `notification-dispatch` dùng chung với phía API) và ghi
 * sự kiện outbox `notification_created` như notify() phía API. Đây
 * là bề mặt phát thông báo dùng chung của worker cho cả đợt chuyển
 * consumer — mọi consumer chuyển sang worker đều dùng lại
 * `notify()`/`deliverInApp` ở đây, không dựng đường phát riêng.
 */
@Injectable()
export class NotificationDeliveryService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliveryService.name);
  private publisher: Redis | null = null;

  constructor(
    private readonly spaceDb: SpaceDatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService,
    // Hai phụ thuộc dưới đây chỉ phục vụ notify() (xếp job kênh email +
    // nội dung generic của luật C-5). Đánh dấu tuỳ chọn để các spec
    // dựng service thủ công chỉ cho deliverInApp (spec parity) không
    // phải cấp hàng đợi/i18n; trong WorkerModule thật chúng luôn được
    // tiêm (hàng đợi `notification-dispatch` đã đăng ký sẵn cho
    // processor phát kênh ngoài, I18nService từ I18nWorkerModule).
    @Optional() @InjectQueue('notification-dispatch') private readonly dispatchQueue?: Queue,
    @Optional() private readonly i18n?: I18nService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.publisher) {
      await this.publisher.quit().catch(() => undefined);
      this.publisher = null;
    }
  }

  /** Kết nối publish Redis tạo lười: test/job không phát được thông báo nào thì không mở kết nối thừa. */
  private publisherClient(): Redis {
    if (!this.publisher) {
      this.publisher = new Redis({
        ...redisConnectionFromUrl(this.config.getOrThrow<string>('REDIS_URL')),
      });
      this.publisher.on('error', (err: Error) => {
        this.logger.warn(`Redis publisher của tín hiệu thông báo lỗi: ${err.message}`);
      });
    }
    return this.publisher;
  }

  /**
   * Phát tín hiệu số chưa đọc của user đã đổi. Lỗi Redis bị nuốt lặng
   * như phía API: đẩy thời gian thực là đường phụ, không bao giờ được
   * làm hỏng nghiệp vụ tạo thông báo vốn đã ghi xong xuống DB.
   */
  async signalUnreadCountChanged(userId: string): Promise<void> {
    try {
      await this.publisherClient().publish(NOTIFICATION_UNREAD_CHANGED_CHANNEL, userId);
    } catch {
      // Bỏ qua: client vẫn còn số khởi tạo từ REST và snapshot khi nối lại.
    }
  }

  /**
   * Chính sách phát của ADMIN ở cấp site cho provider này (NB-7) —
   * cùng luật `isProviderEnabledBySitePolicy` phía API: chưa có ghi
   * đè trong `plugin_config` (plugin `notifications`, khoá
   * `provider_<tên>_enabled`, tenant NULL — setting scope platform)
   * thì mặc định bật; giá trị lưu là JSON như SiteConfigRepository
   * ghi. Loại bắt buộc (P2) luôn bật.
   */
  private async isProviderEnabledBySitePolicy(provider: WorkerProviderLaw): Promise<boolean> {
    if (provider.mandatoryInApp) return true;
    const row = await this.spaceDb.routedKysely
      .selectFrom('plugin_config')
      .select('value')
      .where('plugin', '=', 'notifications')
      .where('name', '=', `provider_${provider.name}_enabled`)
      .where('tenant_id', 'is', null)
      .executeTakeFirst();
    if (!row || row.value === null) return true;
    try {
      return JSON.parse(row.value) !== false;
    } catch {
      return true;
    }
  }

  /** Đọc một khoá tuỳ chọn của user; không có dòng → undefined. */
  private async getPreference(userId: string, name: string): Promise<string | undefined> {
    const row = await this.spaceDb.routedKysely
      .selectFrom('user_preferences')
      .select('value')
      .where('user_id', '=', userId)
      .where('name', '=', name)
      .executeTakeFirst();
    return row?.value ?? undefined;
  }

  /**
   * Giá trị bật/tắt kênh trong-app HIỆU LỰC — cùng luật
   * `resolveNotificationPreference` phía API (xem docblock của class):
   * v2 → suy dữ liệu cũ (loggedin trước, loggedoff sau) → mặc định bật;
   * loại bắt buộc ép bật sau cùng.
   */
  async resolvePopupEnabled(userId: string, provider: WorkerProviderLaw): Promise<boolean> {
    let enabled: boolean;
    const v2 = await this.getPreference(userId, `message_provider_${provider.name}_popup_v2`);
    if (v2 !== undefined) {
      enabled = v2 !== '0';
    } else {
      let legacy: boolean | undefined;
      for (const state of ['loggedin', 'loggedoff'] as const) {
        const value = await this.getPreference(userId, `message_provider_${provider.name}_popup_${state}`);
        if (value !== undefined) { legacy = value !== '0'; break; }
      }
      enabled = legacy ?? true;
    }
    if (provider.mandatoryInApp) enabled = true;
    return enabled;
  }

  /**
   * Phát một thông báo trong-app cho user theo provider đã đăng ký, áp
   * trọn luật ở docblock của class. `smallMessage` do nơi phát truyền
   * tường minh để giữ nguyên bề mặt hiển thị hiện tại của từng đường
   * phát (hai processor nền vốn lấy subject làm smallMessage).
   */
  async deliverInApp(userId: string, providerName: string, input: {
    subject: string; body: string; smallMessage: string; contextUrl?: string | null; fromUserId?: string | null;
    // TENANT-1 (#196): nơi phát truyền tenant đã phân giải (tenant của
    // khoá chứa sự kiện / tenant mặc định của người nhận) để dòng
    // thông báo + dispatch log mang đúng tenant; không truyền thì giữ
    // hành vi cũ (không gắn tenant — chỉ hiển thị ở ngữ cảnh platform).
    tenantId?: string | null;
    // NB-4 (áp ở lát #174-A): khoá nguồn của sự kiện — nơi phát biết sự
    // kiện thuộc khoá nào thì truyền vào để áp ghi đè tắt tiếng theo
    // khoá của người nhận, như tham số cùng tên của notify() phía API.
    // Không truyền = sự kiện không gắn khoá, ghi đè không áp dụng.
    courseId?: string | null;
  }): Promise<InAppDeliveryResult> {
    const provider = WORKER_PROVIDERS[providerName];
    if (!provider) return { status: 'unknown-provider' };

    const user = await this.spaceDb.routedKysely
      .selectFrom('users')
      .select(['id', 'suspended', 'deleted'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || user.suspended || user.deleted) {
      // Người bị đình chỉ/xoá không nhận gì (như notify phía API): không
      // lưu thông báo, chỉ ghi vết dispatch log để truy được.
      await this.spaceDb.routedKysely.insertInto('notification_dispatch_log').values({
        user_id: userId, provider: providerName, channel: 'popup', status: 'skipped-suspended',
        subject: input.subject, dedupe_key: `skipped-suspended-${providerName}-${userId}-${randomUUID()}`,
        tenant_id: input.tenantId ?? null,
      }).onConflict((oc) => oc.doNothing()).execute();
      return { status: 'skipped-suspended' };
    }

    // Chính sách admin cấp site (NB-7) chạy TRƯỚC tuỳ chọn người dùng,
    // như notify() phía API.
    if (!(await this.isProviderEnabledBySitePolicy(provider))) {
      // Bản Drizzle cũ bỏ hẳn cột tenant_id ở dòng này (giá trị lưu
      // là NULL vì cột không có default); Kysely bắt ghi tường minh
      // cột nullable không default nên ghi `null` giữ đúng giá trị.
      await this.spaceDb.routedKysely.insertInto('notification_dispatch_log').values({
        user_id: userId, provider: providerName, channel: 'popup', status: 'skipped-admin-disabled',
        subject: input.subject, dedupe_key: `admin-disabled-${providerName}-${userId}-${randomUUID()}`,
        tenant_id: null,
      }).onConflict((oc) => oc.doNothing()).execute();
      return { status: 'skipped-admin-disabled' };
    }

    // Ghi đè tắt tiếng theo khoá (NB-4): áp SAU chính sách admin và
    // TRƯỚC tuỳ chọn theo loại — đúng thứ tự của notify() phía API.
    // Khoá nguồn đã bị người nhận tắt tiếng thì không sinh thông báo,
    // chỉ ghi dispatch log 'skipped-course-mute' để truy vết; các loại
    // miễn trừ P3/P2 không bao giờ bị chặn ở đây (luật toàn cục thắng
    // ghi đè theo khoá). Khoá tuỳ chọn dùng đúng hình dạng khoá phía
    // API: `notif.course.<courseId>` mang 'all' | 'mute'.
    if (input.courseId && !isExemptFromCourseMute(provider)
      && (await this.getPreference(userId, `notif.course.${input.courseId}`)) === 'mute') {
      await this.spaceDb.routedKysely.insertInto('notification_dispatch_log').values({
        user_id: userId, provider: providerName, channel: 'popup', status: 'skipped-course-mute',
        subject: input.subject, dedupe_key: `course-mute-${providerName}-${userId}-${randomUUID()}`,
        tenant_id: input.tenantId ?? null,
      }).onConflict((oc) => oc.doNothing()).execute();
      return { status: 'skipped-course-mute' };
    }

    if (!(await this.resolvePopupEnabled(userId, provider))) {
      await this.spaceDb.routedKysely.insertInto('notification_dispatch_log').values({
        user_id: userId, provider: providerName, channel: 'popup', status: 'skipped-preference',
        subject: input.subject, dedupe_key: `popup-off-${providerName}-${userId}-${randomUUID()}`,
        tenant_id: input.tenantId ?? null,
      }).onConflict((oc) => oc.doNothing()).execute();
      return { status: 'skipped-preference' };
    }

    const notification = await this.spaceDb.routedKysely.insertInto('notifications').values({
      user_id_from: input.fromUserId ?? null, user_id_to: userId,
      subject: input.subject, full_message: input.body, small_message: input.smallMessage,
      component: provider.component, event_type: providerName,
      context_url: input.contextUrl ?? null,
      tenant_id: input.tenantId ?? null,
    }).returning('id').executeTakeFirst();
    await this.spaceDb.routedKysely.insertInto('notification_dispatch_log').values({
      notification_id: notification!.id, user_id: userId, provider: providerName,
      channel: 'popup', status: 'delivered', subject: input.subject,
      dedupe_key: `popup-${notification!.id}`,
      tenant_id: input.tenantId ?? null,
    }).onConflict((oc) => oc.doNothing()).execute();
    // Số chưa đọc vừa tăng: báo cho các stream SSE đang mở của người
    // nhận (qua Redis pub/sub) để huy hiệu cập nhật ngay, không polling.
    await this.signalUnreadCountChanged(userId);
    return { status: 'delivered', notificationId: notification!.id };
  }

  /**
   * Tần suất email HIỆU LỰC — cùng luật
   * `resolveEmailFrequency` phía API: khoá v2
   * `message_provider_<p>_email_v2` ('immediate'/'daily'/'off') thắng;
   * chưa có thì giá trị kênh cũ: chưa đặt ở đâu → mặc định theo nhóm
   * của provider (truyền vào qua `defaultFrequency`); đặt bật → mặc
   * định đó; đặt tắt → 'off'.
   */
  private async resolveEmailFrequency(userId: string, providerName: string, defaultFrequency: Exclude<WorkerEmailFrequency, 'off'>): Promise<WorkerEmailFrequency> {
    const v2 = await this.getPreference(userId, `message_provider_${providerName}_email_v2`);
    if (v2 === 'immediate' || v2 === 'daily' || v2 === 'off') return v2;
    let legacy: boolean | undefined;
    for (const state of ['loggedin', 'loggedoff'] as const) {
      const value = await this.getPreference(userId, `message_provider_${providerName}_email_${state}`);
      if (value !== undefined) { legacy = value !== '0'; break; }
    }
    if (legacy === undefined) return defaultFrequency;
    return legacy ? defaultFrequency : 'off';
  }

  /**
   * Nội dung kênh NGOÀI theo luật C-5 (xem
   * {@link WORKER_NOTIFY_PROVIDERS}) — cùng luật
   * `resolveExternalContent` phía API:
   * - Provider khai báo `'original-ok'`: bản tối thiểu hoá của nơi
   *   phát cho trường nào có truyền, nội dung gốc cho trường còn
   *   lại — registry đã xác nhận nội dung gốc của các provider này
   *   an toàn cho kênh ngoài.
   * - Provider thuộc diện `'minimized'`: kênh ngoài chỉ mang cặp
   *   nội dung đã tối thiểu hoá do nơi phát truyền vào, KHÔNG bao
   *   giờ mang tiêu đề/nội dung trong-app (chúng có thể chứa dữ
   *   kiện nhạy cảm). Thiếu một trong hai trường: ở môi trường
   *   test ném lỗi để lộ sớm; ở production ghi cảnh báo và thay
   *   trường thiếu bằng nội dung generic không chứa dữ kiện nào.
   *   Nơi phát KHÔNG kèm cặp này là lỗi lập trình, không phải ca
   *   người dùng.
   */
  private resolveExternalContent(providerName: string, law: WorkerNotifyProviderLaw, input: { subject: string; body: string; externalSubject?: string; externalBody?: string }): { subject: string; body: string } {
    if (law.externalPolicy === 'original-ok') {
      return { subject: input.externalSubject ?? input.subject, body: input.externalBody ?? input.body };
    }
    if (input.externalSubject !== undefined && input.externalBody !== undefined) {
      return { subject: input.externalSubject, body: input.externalBody };
    }
    if (process.env.NODE_ENV === 'test') {
      throw new Error(
        `messaging.external_minimization_required: nhà cung cấp ${providerName} thiếu nội dung ngoài đã tối thiểu hoá (externalSubject/externalBody)`,
      );
    }
    this.logger.warn(`Thông báo ${providerName} thiếu nội dung ngoài đã tối thiểu hoá; dùng nội dung chung cho kênh ngoài`);
    return {
      subject: input.externalSubject ?? this.i18n!.t('platform.externalGenericSubject', { locale: 'vi' }),
      body: input.externalBody ?? this.i18n!.t('platform.externalGenericBody', { locale: 'vi', args: { event: law.labelVi } }),
    };
  }

  /**
   * Phát TRỌN một thông báo cho sự kiện mà worker là nơi phát — bản
   * đầy đủ của `MessagingService.notify()` phía API, dùng chung cho
   * cả đợt chuyển consumer sang worker (xem docblock của class):
   *
   * Luồng (đúng thứ tự luật của notify() phía API):
   *  1. Provider không có trong {@link WORKER_PROVIDERS} → trả
   *     `skipped: 'unknown-provider'`, không lưu gì, không sự kiện.
   *  2. Nửa kênh trong-app qua chính {@link deliverInApp} (đình chỉ /
   *     NB-7 / tuỳ chọn popup / ghi dòng + dispatch log + tín hiệu
   *     chưa đọc). Kết quả 'skipped-suspended' / 'skipped-admin-
   *     disabled' của nửa này là điểm dừng sớm như phía API: không
   *     kênh ngoài, không sự kiện `notification_created`. Ghi đè tắt
   *     tiếng theo khoá NB-4 áp khi nơi phát truyền `courseId` (từ
   *     issue con #520 của #491, consumer thông báo sự kiện luôn
   *     truyền khoá nguồn của sự kiện như consumer phía API trước
   *     đây) — kết quả 'skipped-course-mute' cũng là điểm dừng sớm
   *     như phía API; không truyền `courseId` thì ghi đè không áp
   *     như trước.
   *     Khác biệt còn lại so với phía API nằm ở dedupeKey của các
   *     dispatch log kênh popup: giữ nguyên định dạng phía worker của
   *     deliverInApp (không tiền tố tenant) — khoá đó chỉ để truy vết
   *     nội bộ một tiến trình, không phải khoá chống trùng liên tiến
   *     trình.
   *  3. Nửa kênh email (chỉ với provider có trong
   *     {@link WORKER_NOTIFY_PROVIDERS}): phân giải tần suất hiệu lực;
   *     'off' → dispatch log `skipped-preference` (kênh email); khác
   *     'off' → áp luật C-5 rồi xếp job 'dispatch' vào hàng đợi
   *     `notification-dispatch` DÙNG CHUNG với phía API — jobId là
   *     dedupeKey đúng định dạng phía API
   *     (`<tenant|platform>-dispatch-<provider>-<userId>-email-<notificationId|uuid>`)
   *     vì khoá này là khoá chống trùng liên tiến trình: cùng một
   *     thông báo, dù API hay worker xếp job, cũng chỉ tồn tại một
   *     job phát. Processor phát kênh ngoài (đã ở worker) áp tần
   *     suất ('daily' → giữ lại tổng hợp) ở đầu kia.
   *  4. Cuối đường chính (kể cả khi popup bị tuỳ chọn tắt): ghi sự
   *     kiện outbox `notification_created` (aggregate 'messaging',
   *     payload {userId, provider, notificationId} và tenantId được
   *     phản chiếu vào payload như `OutboxService.enqueue` phía API)
   *     để các đường đọc sự kiện phía API thấy đúng như khi API phát.
   *
   * `smallMessage` của dòng thông báo = 200 ký tự đầu của `body`,
   * như notify() phía API khi nơi phát không truyền smallMessage
   * riêng. Không dùng lại phiên bản này cho provider chỉ có kênh
   * trong-app — các đường đó gọi thẳng {@link deliverInApp}.
   */
  async notify(userId: string, providerName: string, input: {
    subject: string; body: string; contextUrl?: string; fromUserId?: string;
    externalSubject?: string; externalBody?: string; tenantId?: string | null;
    // NB-4: khoá nguồn của sự kiện — nơi phát biết sự kiện thuộc
    // khoá nào thì truyền vào để áp ghi đè tắt tiếng theo khoá của
    // người nhận qua deliverInApp, như tham số cùng tên của notify()
    // phía API. Không truyền = sự kiện không gắn khoá, ghi đè không
    // áp dụng.
    courseId?: string | null;
  }): Promise<{ notificationId: string | null; channels: Record<string, string>; skipped?: string }> {
    const provider = WORKER_PROVIDERS[providerName];
    if (!provider) return { notificationId: null, channels: {}, skipped: 'unknown-provider' };
    const tenantId = input.tenantId ?? null;
    const tenantKey = tenantId ?? 'platform';

    const popup = await this.deliverInApp(userId, providerName, {
      subject: input.subject, body: input.body, smallMessage: input.body.slice(0, 200),
      contextUrl: input.contextUrl, fromUserId: input.fromUserId, tenantId,
      courseId: input.courseId,
    });
    if (popup.status === 'skipped-suspended') return { notificationId: null, channels: {}, skipped: 'suspended' };
    if (popup.status === 'skipped-admin-disabled') return { notificationId: null, channels: {}, skipped: 'admin-disabled' };
    if (popup.status === 'skipped-course-mute') return { notificationId: null, channels: {}, skipped: 'course-mute' };

    const channels: Record<string, string> = {};
    const notificationId = popup.notificationId ?? null;
    if (popup.status === 'delivered') channels['popup'] = 'delivered';
    if (popup.status === 'skipped-preference') channels['popup'] = 'skipped-preference';

    const emailLaw = WORKER_NOTIFY_PROVIDERS[providerName];
    if (emailLaw) {
      if (!this.dispatchQueue || !this.i18n) {
        throw new Error('NotificationDeliveryService.notify cần hàng đợi notification-dispatch và I18nService — chỉ dùng qua WorkerModule');
      }
      const frequency = await this.resolveEmailFrequency(userId, providerName, emailLaw.defaultEmailFrequency);
      if (frequency === 'off') {
        await this.spaceDb.routedKysely.insertInto('notification_dispatch_log').values({
          user_id: userId, provider: providerName, channel: 'email', status: 'skipped-preference', subject: input.subject,
          dedupe_key: `${tenantKey}-email-off-${providerName}-${userId}-${randomUUID()}`,
          tenant_id: tenantId,
        }).onConflict((oc) => oc.doNothing()).execute();
        channels['email'] = 'skipped-preference';
      } else {
        const external = this.resolveExternalContent(providerName, emailLaw, input);
        const dedupeKey = `${tenantKey}-dispatch-${providerName}-${userId}-email-${notificationId ?? randomUUID()}`;
        await this.dispatchQueue.add('dispatch', {
          userId, provider: providerName, channel: 'email', tenantId,
          emailFrequency: frequency, subject: external.subject, body: external.body,
          notificationId, dedupeKey,
        }, { jobId: dedupeKey, attempts: 3 });
        channels['email'] = 'queued';
      }
    }

    await this.spaceDb.routedKysely.insertInto('outbox_events').values({
      aggregate: 'messaging', type: 'notification_created', tenant_id: tenantId,
      // jsonb: serialize tường minh kèm `::jsonb` theo khuôn ghi
      // jsonb của `@lms/db` (driver `pg` hiểu mảng cấp cao nhất là
      // mảng PostgreSQL nên không gắn object thô); khoá payload giữ
      // nguyên camelCase như sự kiện cũ vì consumer đọc đúng khoá đó.
      payload: sql<CentreDB['outbox_events']['payload']>`${JSON.stringify({ userId, provider: providerName, notificationId, ...(tenantId ? { tenantId } : {}) })}::jsonb`,
    }).execute();
    return { notificationId, channels };
  }
}
