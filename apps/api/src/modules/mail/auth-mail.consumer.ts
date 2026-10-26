import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, gt, max, ne } from 'drizzle-orm';
import Redis from 'ioredis';
import type { Database } from '../../db/database';
import { outboxEvents } from '../../db/schema';
import { redisTlsFromUrl } from '../../config/env';
import { tenantAls } from '../tenants/tenant-als';
import { AUTH_MAIL_OUTBOX_TYPE } from './auth-mail.service';
import { renderAuthMail, type AuthMailPayload } from './mail-templates';
import { ResendMailService } from './resend-mail.service';

/** Nhịp quét outbox mail auth. */
const POLL_INTERVAL_MS = 1000;
/** Số mail tối đa xử lý trong một nhịp quét. */
const BATCH_SIZE = 20;
/**
 * Số lần thử gửi tối đa cho một dòng outbox trước khi bỏ cuộc: lỗi
 * Resend tạm thời (mạng/5xx) phải được thử lại ở nhịp sau, nhưng một
 * dòng hỏng vĩnh viễn không được chặn mọi mail phía sau mãi mãi — quá
 * ngưỡng thì ghi log lỗi rõ ràng và bỏ qua dòng đó (dead-letter bằng
 * log; dòng outbox vẫn còn nguyên trong DB để truy vết).
 */
const MAX_SEND_ATTEMPTS = 5;

/**
 * Consumer gửi mail auth (issue #7 chặng 2.5) — mắt xích "outbox →
 * Resend" chạy trong tiến trình API, cùng khuôn với các consumer
 * outbox sẵn có của hệ (messaging, SePay):
 *
 * - Các callback của Better Auth chỉ GHI dòng outbox
 *   `auth_mail_requested` (AuthMailService); consumer này quét các
 *   dòng đó theo watermark `seq` của riêng nó (lưu Redis, khoá theo
 *   tên database), dựng nội dung mail và gọi ResendMailService.
 * - KHÔNG đóng dấu `published_at`: cột đó thuộc đường relay/logstore
 *   hiện hữu (worker) — hai đường đọc cùng bảng cho hai mục đích độc
 *   lập, như consumer phân phối realtime của messaging đã làm.
 * - Watermark khởi tạo: tại seq lớn nhất của mọi dòng KHÔNG phải mail
 *   auth — lịch sử cũ không bị phát lại, nhưng mail auth còn nằm chờ
 *   trong outbox (kể cả được ghi ngay trước một lần restart) vẫn được
 *   gửi ở nhịp đầu tiên.
 * - DB bị dựng lại trong lúc tiến trình vẫn chạy (reset production
 *   không kèm restart) được phát hiện ở nhịp trống: seq lớn nhất của
 *   DB nhỏ hơn watermark đang giữ là điều không thể xảy ra trong một
 *   đời DB — khi đó watermark neo lại từ đầu như lúc khởi động (bài
 *   học issue #125 của consumer messaging).
 * - Mail gửi lỗi tạm thời: watermark KHÔNG tiến qua dòng lỗi, nhịp
 *   sau thử lại (tối đa MAX_SEND_ATTEMPTS lần cho một dòng). Vì gửi
 *   là at-least-once, một lần sập tiến trình đúng giữa chừng có thể
 *   làm một mail bị gửi trùng — vô hại với cả hai loại mail auth
 *   (liên kết reset dùng lại cùng token; mã OTP trùng là cùng một mã).
 */
@Injectable()
export class AuthMailConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthMailConsumer.name);
  private readonly redis: Redis;
  private readonly watermarkKey: string;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private watermark: number | null = null;
  /** Số lần gửi lỗi theo seq của dòng outbox, trong đời tiến trình hiện tại. */
  private readonly failedAttempts = new Map<number, number>();

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @InjectDrizzle() private readonly db: Database,
    private readonly mailer: ResendMailService,
  ) {
    const redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, ...redisTlsFromUrl(redisUrl) });
    this.redis.on('error', (error: Error) => {
      this.logger.warn(`Redis của consumer mail auth lỗi: ${error.message}`);
    });
    let databaseName = 'default';
    try {
      databaseName = new URL(config.getOrThrow<string>('DATABASE_URL')).pathname.replace(/^\//, '') || 'default';
    } catch {
      // DATABASE_URL không parse được: dùng khoá mặc định, vẫn an toàn.
    }
    this.watermarkKey = `lms:auth-mail:${databaseName}:seq`;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.redis.quit().catch(() => undefined);
  }

  /** Một nhịp quét đầy đủ — public để test e2e chủ động xả hàng chờ thay vì đợi nhịp. */
  async sweepOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    return tenantAls.run({ platform: true }, () => this.tickInContext());
  }

  private async tickInContext(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.watermark === null) this.watermark = await this.initialWatermark();
      let rows = await this.fetchPending();
      // Nhịp trống có thể là im lặng giả do DB đã bị dựng lại (xem
      // docblock): kiểm dấu hiệu và neo lại trước khi kết luận.
      if (rows.length === 0 && (await this.reanchorIfDbReset())) {
        rows = await this.fetchPending();
      }
      for (const row of rows) {
        const handled = await this.deliver(row.payload, row.seq);
        if (!handled) break; // lỗi tạm thời: giữ watermark trước dòng này, nhịp sau thử lại
        this.watermark = row.seq;
        await this.redis.set(this.watermarkKey, String(row.seq)).catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn(`Nhịp gửi mail auth lỗi: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Watermark khởi tạo: watermark đã lưu trong Redis (nếu có) — nếu
   * chưa từng lưu thì lấy seq lớn nhất của các dòng KHÔNG thuộc mail
   * auth, để không phát lại lịch sử nhưng không bỏ sót mail đang chờ.
   */
  private async initialWatermark(): Promise<number> {
    const stored = await this.redis.get(this.watermarkKey).catch(() => null);
    if (stored !== null && stored !== undefined) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed)) return parsed;
    }
    const [row] = await this.db
      .select({ maxSeq: max(outboxEvents.seq) })
      .from(outboxEvents)
      .where(ne(outboxEvents.type, AUTH_MAIL_OUTBOX_TYPE));
    return row?.maxSeq ?? 0;
  }

  /** DB đã bị dựng lại dưới chân tiến trình đang chạy? Nếu có, neo watermark lại và trả true. */
  private async reanchorIfDbReset(): Promise<boolean> {
    const [row] = await this.db.select({ maxSeq: max(outboxEvents.seq) }).from(outboxEvents);
    const dbMax = row?.maxSeq ?? 0;
    if (this.watermark !== null && dbMax < this.watermark) {
      this.logger.warn(
        `Phát hiện DB đã dựng lại (seq tối đa ${dbMax} < watermark ${this.watermark}): neo lại watermark mail auth.`,
      );
      this.failedAttempts.clear();
      this.watermark = null;
      this.watermark = await this.initialWatermarkAfterReset();
      return true;
    }
    return false;
  }

  /** Neo sau reset: như khởi tạo nhưng không đọc lại watermark cũ trong Redis (nó thuộc đời DB trước). */
  private async initialWatermarkAfterReset(): Promise<number> {
    const [row] = await this.db
      .select({ maxSeq: max(outboxEvents.seq) })
      .from(outboxEvents)
      .where(ne(outboxEvents.type, AUTH_MAIL_OUTBOX_TYPE));
    return row?.maxSeq ?? 0;
  }

  /** Các dòng mail auth đang chờ sau watermark, theo thứ tự seq. */
  private async fetchPending() {
    return this.db
      .select({ seq: outboxEvents.seq, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(gt(outboxEvents.seq, this.watermark!), eq(outboxEvents.type, AUTH_MAIL_OUTBOX_TYPE)))
      .orderBy(asc(outboxEvents.seq))
      .limit(BATCH_SIZE);
  }

  /**
   * Gửi một dòng mail. Trả true nếu dòng coi như đã xử lý xong (gửi
   * được / bỏ qua do chưa cấu hình / payload hỏng / quá số lần thử) —
   * watermark được tiến qua nó; trả false khi lỗi gửi tạm thời và còn
   * lượt thử lại — watermark đứng yên để nhịp sau làm lại dòng này.
   */
  private async deliver(payload: unknown, seq?: number): Promise<boolean> {
    const parsed = payload as AuthMailPayload | null;
    if (!parsed || (parsed.kind !== 'password_reset' && parsed.kind !== 'email_otp') || !parsed.to) {
      this.logger.error(`Payload mail auth không hợp lệ, bỏ qua dòng: ${JSON.stringify(payload)?.slice(0, 200)}`);
      return true;
    }
    try {
      const message = renderAuthMail(parsed);
      const result = await this.mailer.send(message);
      if (result.status === 'skipped') {
        this.logger.warn(
          `Mail auth tới ${parsed.to} (loại ${parsed.kind}) không được gửi: ${result.reason} — môi trường chưa cấu hình Resend.`,
        );
      }
      return true;
    } catch (error) {
      const attempts = (seq !== undefined ? (this.failedAttempts.get(seq) ?? 0) : 0) + 1;
      if (seq !== undefined) this.failedAttempts.set(seq, attempts);
      if (attempts >= MAX_SEND_ATTEMPTS) {
        this.logger.error(
          `Gửi mail auth tới ${parsed.to} (loại ${parsed.kind}) lỗi ${attempts} lần, bỏ qua dòng này: ${(error as Error).message}`,
        );
        if (seq !== undefined) this.failedAttempts.delete(seq);
        return true;
      }
      this.logger.warn(
        `Gửi mail auth tới ${parsed.to} (loại ${parsed.kind}) lỗi lần ${attempts}, sẽ thử lại: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
