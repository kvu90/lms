import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { relations } from './db/relations';
import { redisConnectionFromUrl } from './config/env';
import { notificationDispatchLog, notifications, userPreferences, users } from '@lms/db-schema';

type Database = NodePgDatabase<typeof relations>;

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
 * (hai đường trước đây ghi thẳng vào bảng notifications). `component` và
 * `mandatoryInApp` PHẢI khớp `MESSAGE_PROVIDERS` phía API
 * (apps/api/src/modules/messaging/messaging.service.ts) — nguồn sự thật
 * của registry vẫn là phía API; bảng này là bản chiếu tối thiểu để worker
 * áp đúng luật mà không import ngược từ app API (khác tiến trình).
 */
export const WORKER_PROVIDERS: Record<string, WorkerProviderLaw> = {
  calendar_reminder: { name: 'calendar_reminder', component: 'core_calendar', mandatoryInApp: false },
  report_scheduled: { name: 'report_scheduled', component: 'core_reportbuilder', mandatoryInApp: false },
};

export type InAppDeliveryStatus = 'delivered' | 'skipped-suspended' | 'skipped-preference' | 'unknown-provider';
export interface InAppDeliveryResult { status: InAppDeliveryStatus; notificationId?: string }

/**
 * Hàm luật phân phối kênh trong-app DÙNG CHUNG của worker (NB-6, G10) —
 * bản song sinh của `MessagingService.notify()` phía API cho kênh popup,
 * là kênh thật duy nhất mà các processor nền phát:
 *
 * - Người nhận không tồn tại / bị đình chỉ / đã xoá → không lưu gì, chỉ
 *   ghi dispatch log `skipped-suspended` (như API).
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
 * Kênh ngoài (email/push) KHÔNG đổi ở lát này: hai đường phát nền trước
 * đây không hề xếp hàng job kênh ngoài, và động cơ gửi/digest thuộc NB-5
 * (chờ SMTP) — service này chỉ nhất quán hoá đường trong-app.
 */
@Injectable()
export class NotificationDeliveryService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliveryService.name);
  private publisher: Redis | null = null;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(ConfigService) private readonly config: ConfigService,
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

  /** Đọc một khoá tuỳ chọn của user; không có dòng → undefined. */
  private async getPreference(userId: string, name: string): Promise<string | undefined> {
    const [row] = await this.db.select({ value: userPreferences.value }).from(userPreferences)
      .where(and(eq(userPreferences.userId, userId), eq(userPreferences.name, name)));
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
  }): Promise<InAppDeliveryResult> {
    const provider = WORKER_PROVIDERS[providerName];
    if (!provider) return { status: 'unknown-provider' };

    const [user] = await this.db.select({ id: users.id, suspended: users.suspended, deleted: users.deleted })
      .from(users).where(eq(users.id, userId));
    if (!user || user.suspended || user.deleted) {
      // Người bị đình chỉ/xoá không nhận gì (như notify phía API): không
      // lưu thông báo, chỉ ghi vết dispatch log để truy được.
      await this.db.insert(notificationDispatchLog).values({
        userId, provider: providerName, channel: 'popup', status: 'skipped-suspended',
        subject: input.subject, dedupeKey: `skipped-suspended-${providerName}-${userId}-${randomUUID()}`,
        tenantId: input.tenantId ?? null,
      }).onConflictDoNothing();
      return { status: 'skipped-suspended' };
    }

    if (!(await this.resolvePopupEnabled(userId, provider))) {
      await this.db.insert(notificationDispatchLog).values({
        userId, provider: providerName, channel: 'popup', status: 'skipped-preference',
        subject: input.subject, dedupeKey: `popup-off-${providerName}-${userId}-${randomUUID()}`,
        tenantId: input.tenantId ?? null,
      }).onConflictDoNothing();
      return { status: 'skipped-preference' };
    }

    const [notification] = await this.db.insert(notifications).values({
      userIdFrom: input.fromUserId ?? null, userIdTo: userId,
      subject: input.subject, fullMessage: input.body, smallMessage: input.smallMessage,
      component: provider.component, eventType: providerName,
      contextUrl: input.contextUrl ?? null,
      tenantId: input.tenantId ?? null,
    }).returning();
    await this.db.insert(notificationDispatchLog).values({
      notificationId: notification!.id, userId, provider: providerName,
      channel: 'popup', status: 'delivered', subject: input.subject,
      dedupeKey: `popup-${notification!.id}`,
      tenantId: input.tenantId ?? null,
    }).onConflictDoNothing();
    // Số chưa đọc vừa tăng: báo cho các stream SSE đang mở của người
    // nhận (qua Redis pub/sub) để huy hiệu cập nhật ngay, không polling.
    await this.signalUnreadCountChanged(userId);
    return { status: 'delivered', notificationId: notification!.id };
  }
}
