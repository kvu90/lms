import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import { Logger } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import type { Job } from 'bullmq';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { notificationDispatchLog, users } from '@lms/db-schema';
import { tenantAls } from '../db/tenant-als';
import { ResendMailService, type WorkerMailSendResult } from '../resend-mail.service';

type Database = NodePgDatabase<typeof relations>;

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
 *  3. Ngược lại dựng MỘT email tổng hợp: tiêu đề đếm số sự kiện, thân
 *     là danh sách tiêu đề của từng sự kiện. Các tiêu đề này là bản
 *     tối thiểu hoá cho kênh ngoài ngay từ nơi phát (P4) — email
 *     tổng hợp vì vậy không chứa điểm số hay nội dung tin nhắn, và
 *     KHÔNG kèm thân chi tiết của từng sự kiện.
 *  4. Gửi qua Resend:
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
      const count = rows.length;
      const subject = this.i18n.t('platform.notificationDigestSubject', { locale: 'vi', args: { count } });
      const intro = this.i18n.t('platform.notificationDigestIntro', { locale: 'vi', args: { count } });
      const footer = this.i18n.t('platform.notificationDigestFooter', { locale: 'vi' });
      const text = [intro, ...rows.map((r) => `- ${r.subject}`), footer].join('\n');
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
        .where(and(inArray(notificationDispatchLog.id, ids), eq(notificationDispatchLog.status, 'digest-queued')));
      result.usersSent += 1;
      result.itemsSent += count;
    }
    return result;
  }
}
