import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import { Logger } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import type { Job } from 'bullmq';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { notificationDispatchLog, pluginConfig, userPreferences, users } from '@lms/db';
import { tenantAls } from '../db/tenant-als';
import { ResendMailService, type WorkerMailSendResult } from '../resend-mail.service';

type Database = NodePgDatabase<typeof relations>;

/**
 * Hai loại bắt buộc (P2) — bản chiếu tối thiểu của `mandatoryInApp`
 * trong registry phía API, cùng bản chiếu ở processor dispatch:
 * chính sách admin cấp site không bao giờ chặn chúng, kể cả ở khâu
 * tổng hợp này.
 */
const MANDATORY_PROVIDERS = new Set(['enrol_expiry_warning', 'admin_announcement']);

/** Kết quả một lượt quét tổng hợp email theo ngày (để truy vết qua log/return của job). */
export interface NotificationDigestSweepResult {
  /** Số người nhận đã nhận email tổng hợp trong lượt này. */
  usersSent: number;
  /** Số người nhận bị hoãn vì transport chưa cấu hình (mục vẫn ở trạng thái chờ). */
  usersDeferred: number;
  /** Số người nhận bị bỏ qua vì đình chỉ/đã xoá (mục đã chốt `skipped-suspended`). */
  usersSkipped: number;
  /** Số người nhận có lỗi gửi thật trong lượt (mục vẫn chờ, lượt sau thử lại). */
  usersFailed: number;
  /** Tổng số mục đã được tổng hợp thành công. */
  itemsSent: number;
  /** Số mục bị chặn bởi chính sách admin cấp site (NB-7) tại lúc tổng hợp. */
  itemsSuppressedAdmin: number;
  /** Số mục bị chặn bởi tuỳ chọn email của chính người nhận tại lúc tổng hợp. */
  itemsSuppressedPreference: number;
}

/**
 * Tổng hợp email theo ngày cho thông báo (NB-5, issue #174 — chính
 * sách P1: nhóm học tập dùng tần suất email `daily`).
 *
 * Điểm vào: job `sweep` trên queue `notification-digests`, do
 * NotificationDigestScheduler đăng ký lặp mỗi ngày (07:15 giờ Việt
 * Nam). Processor `notification-dispatch` KHÔNG gửi các job email có
 * tần suất `daily` — nó chỉ ghi một dòng dispatch log trạng thái
 * `digest-queued` cho mỗi sự kiện. Lượt quét này là nơi duy nhất biến
 * các dòng chờ đó thành email thật.
 *
 * Flow một lượt quét:
 *  1. Đọc mọi dòng dispatch log kênh email đang ở `digest-queued`
 *     (xuyên tenant — ngữ cảnh platform tường minh như các processor
 *     nền khác), sắp theo thời gian tạo, gom theo người nhận.
 *  2. Mỗi người nhận: nếu không còn tồn tại/bị đình chỉ/đã xoá →
 *     chốt các dòng của họ thành `skipped-suspended`, không gửi.
 *  3. Kiểm LUẬT TẠI LÚC GỬI cho từng dòng theo đúng thứ tự của đường
 *     dispatch (luật sống tại thời điểm tổng hợp thắng trạng thái lúc
 *     xếp hàng — người dùng tắt email hoặc admin tắt loại SAU khi sự
 *     kiện xếp hàng thì email tổng hợp vẫn phải tôn trọng):
 *     - Chính sách admin cấp site (NB-7) đã tắt loại của dòng →
 *       chốt dòng `skipped-admin-disabled` (hai loại bắt buộc P2
 *       miễn trừ, như mọi đường phát khác).
 *     - Tuỳ chọn email của người nhận cho loại của dòng ở trạng
 *       thái tắt (khoá v2 `off`, hoặc mô hình cũ tắt ở cả hai trạng
 *       thái đăng nhập) → chốt dòng `skipped-preference`.
 *  4. Các dòng còn lại dựng thành MỘT email tổng hợp: tiêu đề đếm số
 *     sự kiện, thân là danh sách tiêu đề của từng sự kiện. Các tiêu
 *     đề này là bản tối thiểu hoá cho kênh ngoài ngay từ nơi phát
 *     (P4) — email tổng hợp vì vậy không chứa điểm số hay nội dung
 *     tin nhắn, và KHÔNG kèm thân chi tiết của từng sự kiện.
 *  5. Gửi qua Resend:
 *     - Thành công → cập nhật các dòng thành `digest-sent`.
 *     - Transport chưa cấu hình (fail-soft có khai báo) → GIỮ
 *       NGUYÊN trạng thái chờ: cấu hình xong thì lượt sau gửi, không
 *       mất sự kiện, không ghi nhận giả.
 *     - Resend trả lỗi thật → giữ nguyên trạng thái chờ, ghi log
 *       lỗi, tiếp tục với người nhận khác (một người lỗi không chặn
 *       cả lượt); lượt quét sau thử lại.
 *
 * Idempotent: một dòng rời `digest-queued` ngay khi đã chốt kết quả
 * (gửi thành công hoặc người nhận không còn hợp lệ) nên chạy lại
 * lượt quét không gửi trùng. Ngoại lệ cửa sổ hẹp đã biết: tiến trình
 * chết giữa lúc Resend đã nhận mail và lúc cập nhật trạng thái →
 * lượt sau gửi lại các mục đó (chấp nhận trùng thay vì mất — cùng
 * đánh đổi với đường dispatch gửi ngay).
 */
@Processor('notification-digests')
export class NotificationDigestProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationDigestProcessor.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly mail: ResendMailService,
    private readonly i18n: I18nService,
  ) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job): Promise<NotificationDigestSweepResult> {
    // Processor nền quét xuyên tenant — bọc ngữ cảnh platform tường
    // minh để RLS fail-closed không làm mù dữ liệu (như các
    // processor nền khác của worker).
    void job;
    return tenantAls.run({ platform: true }, () => this.sweep());
  }

  /** Một lượt gom + gửi; tách khỏi `process` để giữ ngữ cảnh tenant ở một chỗ. */
  private async sweep(): Promise<NotificationDigestSweepResult> {
    const result: NotificationDigestSweepResult = {
      usersSent: 0, usersDeferred: 0, usersSkipped: 0, usersFailed: 0, itemsSent: 0,
      itemsSuppressedAdmin: 0, itemsSuppressedPreference: 0,
    };
    const pending = await this.db.select().from(notificationDispatchLog)
      .where(and(
        eq(notificationDispatchLog.channel, 'email'),
        eq(notificationDispatchLog.status, 'digest-queued'),
      ))
      .orderBy(asc(notificationDispatchLog.createdAt));
    if (pending.length === 0) return result;

    const byUser = new Map<string, typeof pending>();
    for (const row of pending) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }

    for (const [userId, rows] of byUser) {
      const ids = rows.map((r) => r.id);
      const [user] = await this.db.select().from(users).where(eq(users.id, userId));
      if (!user || user.suspended || user.deleted) {
        // Người nhận không còn hợp lệ tại thời điểm tổng hợp: chốt
        // các dòng chờ thành skipped-suspended như luật ở mọi đường
        // phát khác, không gửi gì.
        await this.db.update(notificationDispatchLog)
          .set({ status: 'skipped-suspended' })
          .where(and(inArray(notificationDispatchLog.id, ids), eq(notificationDispatchLog.status, 'digest-queued')));
        result.usersSkipped += 1;
        continue;
      }
      // Kiểm luật tại lúc gửi cho từng dòng (bước 3 của flow ở đầu
      // file): nạp tuỳ chọn của người nhận + chính sách site cho các
      // loại có mặt trong nhóm, rồi phân nhóm dòng thành bị chặn bởi
      // admin / bị chặn bởi tuỳ chọn / được gửi.
      const prefs = await this.db.select().from(userPreferences)
        .where(eq(userPreferences.userId, userId));
      const prefByName = new Map(prefs.map((p) => [p.name, p.value]));
      const providersInGroup = [...new Set(rows.map((r) => r.provider))];
      const policyRows = await this.db.select({ name: pluginConfig.name, value: pluginConfig.value })
        .from(pluginConfig)
        .where(and(
          eq(pluginConfig.plugin, 'notifications'),
          isNull(pluginConfig.tenantId),
          inArray(pluginConfig.name, providersInGroup.map((p) => `provider_${p}_enabled`)),
        ));
      const adminDisabledProviders = new Set<string>();
      for (const policy of policyRows) {
        let disabled = false;
        try { disabled = JSON.parse(policy.value ?? 'null') === false; } catch { disabled = false; }
        if (disabled) adminDisabledProviders.add(policy.name.replace('provider_', '').replace('_enabled', ''));
      }
      const suppressedAdmin: string[] = [];
      const suppressedPreference: string[] = [];
      const sendable: typeof rows = [];
      for (const row of rows) {
        if (adminDisabledProviders.has(row.provider) && !MANDATORY_PROVIDERS.has(row.provider)) {
          suppressedAdmin.push(row.id);
          continue;
        }
        const emailOff = prefByName.get(`message_provider_${row.provider}_email_v2`) === 'off'
          || (prefByName.get(`message_provider_${row.provider}_email_loggedin`) === '0'
            && prefByName.get(`message_provider_${row.provider}_email_loggedoff`) === '0');
        if (emailOff) {
          suppressedPreference.push(row.id);
          continue;
        }
        sendable.push(row);
      }
      if (suppressedAdmin.length > 0) {
        await this.db.update(notificationDispatchLog)
          .set({ status: 'skipped-admin-disabled' })
          .where(and(inArray(notificationDispatchLog.id, suppressedAdmin), eq(notificationDispatchLog.status, 'digest-queued')));
        result.itemsSuppressedAdmin += suppressedAdmin.length;
      }
      if (suppressedPreference.length > 0) {
        await this.db.update(notificationDispatchLog)
          .set({ status: 'skipped-preference' })
          .where(and(inArray(notificationDispatchLog.id, suppressedPreference), eq(notificationDispatchLog.status, 'digest-queued')));
        result.itemsSuppressedPreference += suppressedPreference.length;
      }
      if (sendable.length === 0) continue;
      const count = sendable.length;
      const subject = this.i18n.t('platform.notificationDigestSubject', { locale: 'vi', args: { count } });
      const intro = this.i18n.t('platform.notificationDigestIntro', { locale: 'vi', args: { count } });
      const footer = this.i18n.t('platform.notificationDigestFooter', { locale: 'vi' });
      const text = [intro, ...sendable.map((r) => `- ${r.subject}`), footer].join('\n');
      let sendResult: WorkerMailSendResult;
      try {
        sendResult = await this.mail.send({ to: user.email, subject, text });
      } catch (err) {
        // Lỗi gửi thật của một người nhận: giữ các dòng ở trạng thái
        // chờ để lượt sau thử lại, không chặn các người nhận còn lại.
        this.logger.error(
          `Tổng hợp email cho user ${userId} lỗi (${count} mục vẫn chờ): ${err instanceof Error ? err.message : String(err)}`,
        );
        result.usersFailed += 1;
        continue;
      }
      if (sendResult.status === 'skipped') {
        result.usersDeferred += 1;
        continue;
      }
      await this.db.update(notificationDispatchLog)
        .set({ status: 'digest-sent' })
        .where(and(inArray(notificationDispatchLog.id, sendable.map((r) => r.id)), eq(notificationDispatchLog.status, 'digest-queued')));
      result.usersSent += 1;
      result.itemsSent += count;
    }
    return result;
  }
}
