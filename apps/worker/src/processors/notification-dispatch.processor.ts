import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { tenantAls } from '../db/tenant-als';
import { ResendMailService } from '../resend-mail.service';
import { SpaceDatabaseService } from '../db/routing/space-database.service';

export interface NotificationDispatchJobData {
  userId: string;
  provider: string;
  channel: string; // email | push (các cổng kênh ngoài)
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
 *
 * Concurrency 10: hàng đợi thuần I/O (gọi dịch vụ gửi thư qua HTTP)
 * — concurrency mặc định 1 để một email chậm chặn toàn bộ hàng đợi
 * phía sau. Job mang dedupeKey bền và khâu ghi log chống trùng nên
 * chạy song song an toàn.
 */
@Processor('notification-dispatch', { concurrency: 10 })
export class NotificationDispatchProcessor extends WorkerHost {
  constructor(
    private readonly spaceDb: SpaceDatabaseService,
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
    const existing = await this.spaceDb.routedKysely
      .selectFrom('notification_dispatch_log')
      .select('id')
      .where('dedupe_key', '=', dedupeKey)
      .executeTakeFirst();
    if (existing) return { status: 'duplicate', channel };

    const user = await this.spaceDb.routedKysely
      .selectFrom('users')
      .select(['suspended', 'deleted', 'email'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || user.suspended || user.deleted) {
      await this.spaceDb.routedKysely.insertInto('notification_dispatch_log').values({
        user_id: userId, provider, channel, status: 'skipped-suspended', subject, dedupe_key: dedupeKey, tenant_id: tenantId,
        notification_id: job.data.notificationId ?? null,
      }).onConflict((oc) => oc.doNothing()).execute();
      return { status: 'skipped-suspended', channel };
    }
    // Kiểm lại chính sách admin cấp site (NB-7): loại có thể đã bị
    // tắt cho toàn site SAU khi job xếp hàng — luật tại lúc phát
    // thắng, như các kiểm lại đình chỉ/tuỳ chọn. Hai loại bắt buộc
    // P2 cũng không bao giờ bị chặn ở khâu này.
    if (!MANDATORY_PROVIDERS.has(provider)) {
      const policy = await this.spaceDb.routedKysely
        .selectFrom('plugin_config')
        .select('value')
        .where('plugin', '=', 'notifications')
        .where('name', '=', `provider_${provider}_enabled`)
        .where('tenant_id', 'is', null)
        .executeTakeFirst();
      let adminDisabled = false;
      if (policy && policy.value !== null) {
        try { adminDisabled = JSON.parse(policy.value) === false; } catch { adminDisabled = false; }
      }
      if (adminDisabled) {
        await this.spaceDb.routedKysely.insertInto('notification_dispatch_log').values({
          user_id: userId, provider, channel, status: 'skipped-admin-disabled', subject, dedupe_key: dedupeKey, tenant_id: tenantId,
          notification_id: job.data.notificationId ?? null,
        }).onConflict((oc) => oc.doNothing()).execute();
        return { status: 'skipped-admin-disabled', channel };
      }
    }
    // Kiểm lại tuỳ chọn ở cả hai trạng thái đăng nhập: tắt ở cả hai ⇒ không phát.
    const prefName = (state: string) => `message_provider_${provider}_${channel}_${state}`;
    const prefs = await this.spaceDb.routedKysely
      .selectFrom('user_preferences')
      .select(['name', 'value'])
      .where('user_id', '=', userId)
      .execute();
    const byName = new Map(prefs.map((p) => [p.name, p.value]));
    const loggedin = byName.get(prefName('loggedin')) !== '0';
    const loggedoff = byName.get(prefName('loggedoff')) !== '0';
    if (!loggedin && !loggedoff) {
      await this.spaceDb.routedKysely.insertInto('notification_dispatch_log').values({
        user_id: userId, provider, channel, status: 'skipped-preference', subject, dedupe_key: dedupeKey, tenant_id: tenantId,
        notification_id: job.data.notificationId ?? null,
      }).onConflict((oc) => oc.doNothing()).execute();
      return { status: 'skipped-preference', channel };
    }
    if (channel === 'email') {
      return this.dispatchEmail(job, user.email, byName);
    }
    // Kênh push: chưa có hạ tầng gửi thật — giữ chế độ ghi log.
    await this.spaceDb.routedKysely.insertInto('notification_dispatch_log').values({
      user_id: userId, provider, channel, status: 'logged', subject, dedupe_key: dedupeKey, tenant_id: tenantId,
      notification_id: job.data.notificationId ?? null,
    }).onConflict((oc) => oc.doNothing()).execute();
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
    const logRow = (status: NotificationDispatchResult['status']) => this.spaceDb.routedKysely
      .insertInto('notification_dispatch_log').values({
        user_id: userId, provider, channel, status, subject, dedupe_key: dedupeKey, tenant_id: tenantId,
        notification_id: job.data.notificationId ?? null,
      }).onConflict((oc) => oc.doNothing()).execute();

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
