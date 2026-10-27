import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { notificationDispatchLog, pluginConfig, userPreferences, users } from '@lms/db-schema';
import { tenantAls } from '../db/tenant-als';
import { ResendMailService } from '../resend-mail.service';

type Database = NodePgDatabase<typeof relations>;

export interface NotificationDispatchJobData {
  userId: string;
  provider: string;
  channel: string; // email | push (external ports)
  subject: string;
  body: string;
  notificationId?: string | null;
  dedupeKey: string;
  /** Tenant của notification nguồn (TENANT-1, #196); job cũ không có → null. */
  tenantId?: string | null;
  /**
   * Tần suất email đã phân giải ở phía API tại lúc phát (NB-5, issue
   * #174): chỉ có nghĩa với kênh email. `daily` = không gửi ngay —
   * ghi dispatch log `digest-queued` chờ lượt tổng hợp ngày của
   * NotificationDigestProcessor. Job xếp hàng trước NB-5 không có
   * trường này → coi như `immediate`.
   */
  emailFrequency?: 'immediate' | 'daily' | 'off' | null;
}
export interface NotificationDispatchResult {
  status: 'logged' | 'sent' | 'digest-queued' | 'skipped-not-configured' | 'skipped-suspended' | 'skipped-preference' | 'skipped-admin-disabled' | 'duplicate';
  channel: string;
}

/**
 * Hai loại bắt buộc (P2) — bản chiếu tối thiểu của `mandatoryInApp`
 * trong registry phía API (messaging/notification-providers.ts):
 * chính sách admin không bao giờ chặn chúng, kể cả ở khâu kiểm lại
 * lúc phân phối này.
 */
const MANDATORY_PROVIDERS = new Set(['enrol_expiry_warning', 'admin_announcement']);

/**
 * Xử lý job phân phối notification ra kênh ngoài (NB-5, issue #174).
 *
 * Đầu vào: job `dispatch` trên queue `notification-dispatch` do phía
 * API xếp khi `MessagingService.notify` phát một thông báo có kênh
 * ngoài (email/push). subject/body trong job LÀ BẢN TỐI THIỂU HOÁ cho
 * kênh ngoài (P4: không điểm số, không nội dung tin nhắn — phía API
 * đã thay bằng `externalSubject`/`externalBody` ở nơi phát).
 *
 * Flow (luật được kiểm LẠI tại lúc phát, theo dữ liệu sống — thay đổi
 * sau khi xếp hàng vẫn thắng):
 *  1. Đã có dispatch log cùng `dedupeKey` → trả `duplicate`, không
 *     làm gì thêm (idempotent; dedupeKey là khoá duy nhất của bảng).
 *  2. Người nhận không tồn tại/bị đình chỉ/đã xoá → log
 *     `skipped-suspended`.
 *  3. Chính sách admin cấp site (NB-7) đã tắt loại này sau khi xếp
 *     hàng → log `skipped-admin-disabled`. Hai loại bắt buộc P2 miễn
 *     trừ ở khâu này (xem `MANDATORY_PROVIDERS` ở trên).
 *  4. Tuỳ chọn: mô hình cũ (cả hai trạng thái đăng nhập đều tắt) →
 *     log `skipped-preference`. Riêng kênh email kiểm thêm tuỳ chọn
 *     v2: giá trị `off` tại lúc phát → cũng `skipped-preference`
 *     (P2: kênh ngoài là quyền cá nhân tuyệt đối của người dùng).
 *  5. Kênh email: tần suất `daily` → log `digest-queued`, CHƯA gửi
 *     (NotificationDigestProcessor gom và gửi theo ngày); gửi ngay
 *     → gửi thật qua Resend: thành công log `sent`; transport chưa
 *     cấu hình (thiếu khoá/địa chỉ gửi ở môi trường) → log
 *     `skipped-not-configured` (fail-soft có khai báo, không thử
 *     lại); Resend trả lỗi thật → ném lỗi để BullMQ thử lại job
 *     (chưa ghi log nên lần thử lại không vướng dedupe).
 *  6. Kênh push: chưa có hạ tầng push (chờ ứng dụng native) → giữ
 *     chế độ ghi log như trước NB-5: log `logged`.
 */
@Processor('notification-dispatch')
export class NotificationDispatchProcessor extends WorkerHost {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly mail: ResendMailService,
  ) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<NotificationDispatchJobData>): Promise<NotificationDispatchResult> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<NotificationDispatchJobData>): Promise<NotificationDispatchResult> {
    const { userId, provider, channel, subject, dedupeKey } = job.data;
    const tenantId = job.data.tenantId ?? null;
    const [existing] = await this.db.select().from(notificationDispatchLog)
      .where(eq(notificationDispatchLog.dedupeKey, dedupeKey));
    if (existing) return { status: 'duplicate', channel };

    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.suspended || user.deleted) {
      await this.db.insert(notificationDispatchLog).values({
        userId: userId, provider, channel, status: 'skipped-suspended', subject, dedupeKey, tenantId,
        notificationId: job.data.notificationId ?? null,
      }).onConflictDoNothing();
      return { status: 'skipped-suspended', channel };
    }
    // Admin site policy re-check (NB-7): the type may have been
    // disabled site-wide AFTER the job was queued — the dispatch-time
    // law wins, like the suspended/preference re-checks. Mandatory P2
    // types are never blocked here either.
    if (!MANDATORY_PROVIDERS.has(provider)) {
      const [policy] = await this.db.select({ value: pluginConfig.value }).from(pluginConfig)
        .where(and(
          eq(pluginConfig.plugin, 'notifications'),
          eq(pluginConfig.name, `provider_${provider}_enabled`),
          isNull(pluginConfig.tenantId),
        ));
      let adminDisabled = false;
      if (policy && policy.value !== null) {
        try { adminDisabled = JSON.parse(policy.value) === false; } catch { adminDisabled = false; }
      }
      if (adminDisabled) {
        await this.db.insert(notificationDispatchLog).values({
          userId: userId, provider, channel, status: 'skipped-admin-disabled', subject, dedupeKey, tenantId,
          notificationId: job.data.notificationId ?? null,
        }).onConflictDoNothing();
        return { status: 'skipped-admin-disabled', channel };
      }
    }
    // Preference re-check for both login states: disabled in both ⇒ no dispatch.
    const prefName = (state: string) => `message_provider_${provider}_${channel}_${state}`;
    const prefs = await this.db.select().from(userPreferences).where(and(
      eq(userPreferences.userId, userId),
    ));
    const byName = new Map(prefs.map((p) => [p.name, p.value]));
    const loggedin = byName.get(prefName('loggedin')) !== '0';
    const loggedoff = byName.get(prefName('loggedoff')) !== '0';
    if (!loggedin && !loggedoff) {
      await this.db.insert(notificationDispatchLog).values({
        userId: userId, provider, channel, status: 'skipped-preference', subject, dedupeKey, tenantId,
        notificationId: job.data.notificationId ?? null,
      }).onConflictDoNothing();
      return { status: 'skipped-preference', channel };
    }
    if (channel === 'email') {
      return this.dispatchEmail(job, user.email, byName);
    }
    // Kênh push: chưa có hạ tầng gửi thật — giữ chế độ ghi log.
    await this.db.insert(notificationDispatchLog).values({
      userId: userId, provider, channel, status: 'logged', subject, dedupeKey, tenantId,
      notificationId: job.data.notificationId ?? null,
    }).onConflictDoNothing();
    return { status: 'logged', channel };
  }

  /**
   * Nhánh kênh email (NB-5): kiểm tuỳ chọn v2 tại lúc phát, rồi theo
   * tần suất trong job mà xếp vào hàng tổng hợp ngày hoặc gửi thật
   * qua Resend. Mọi kết quả đều chốt bằng đúng một dòng dispatch log
   * (trừ khi Resend ném lỗi — job thử lại và chưa ghi gì).
   */
  private async dispatchEmail(
    job: Job<NotificationDispatchJobData>,
    recipientEmail: string,
    preferencesByName: Map<string, string | null>,
  ): Promise<NotificationDispatchResult> {
    const { userId, provider, channel, subject, dedupeKey } = job.data;
    const tenantId = job.data.tenantId ?? null;
    const logRow = (status: NotificationDispatchResult['status']) => this.db.insert(notificationDispatchLog).values({
      userId: userId, provider, channel, status, subject, dedupeKey, tenantId,
      notificationId: job.data.notificationId ?? null,
    }).onConflictDoNothing();

    // Tuỳ chọn email v2 ở trạng thái tắt TẠI LÚC PHÁT thắng tần suất
    // đã phân giải lúc xếp hàng: người dùng tắt sau khi job xếp hàng
    // thì email này không đi (kiểm mô hình cũ ở trên không đọc khoá
    // v2 nên phải kiểm riêng ở đây).
    if (preferencesByName.get(`message_provider_${provider}_email_v2`) === 'off') {
      await logRow('skipped-preference');
      return { status: 'skipped-preference', channel };
    }
    // Tần suất tổng hợp ngày (P1 cho nhóm học tập): chỉ ghi nhận vào
    // hàng chờ digest — NotificationDigestProcessor gom theo người
    // nhận và gửi một email tổng hợp mỗi ngày.
    if ((job.data.emailFrequency ?? 'immediate') === 'daily') {
      await logRow('digest-queued');
      return { status: 'digest-queued', channel };
    }
    const result = await this.mail.send({ to: recipientEmail, subject, text: job.data.body });
    if (result.status === 'skipped') {
      // Chưa cấu hình Resend ở môi trường này: bỏ qua có khai báo
      // (như mail xác thực), ghi nhận trung thực thay vì giả vờ đã gửi.
      await logRow('skipped-not-configured');
      return { status: 'skipped-not-configured', channel };
    }
    await logRow('sent');
    return { status: 'sent', channel };
  }
}
