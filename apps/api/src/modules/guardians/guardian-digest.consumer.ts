import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, gt, inArray, max } from 'drizzle-orm';
import Redis from 'ioredis';
import type { Database } from '../../db/database';
import { outboxEvents } from '../../db/schema';
import { redisTlsFromUrl } from '../../config/env';
import { GuardianDigestService, type GuardianDigestDuePayload, type GuardianOverdueAlertPayload } from './guardian-digest.service';

/** Nhịp quét outbox của consumer digest (khớp nhịp các consumer khác). */
const POLL_INTERVAL_MS = 500;
/** Số sự kiện tối đa xử lý trong một nhịp quét. */
const BATCH_SIZE = 100;
/**
 * Các loại sự kiện digest phụ huynh (PH-2, issue #159) do worker phát:
 * guardian_digest_due (một lượt digest định kỳ đã được chốt bền trong
 * guardian_digests) và guardian_overdue_alert (một việc quá hạn ≥7
 * ngày cần đẩy riêng đúng một lần).
 */
const HANDLED_TYPES = ['guardian_digest_due', 'guardian_overdue_alert'] as const;

/**
 * Consumer digest phụ huynh (PH-2, issue #159): quét outbox đã commit
 * và giao từng sự kiện cho GuardianDigestService tổng hợp + gửi qua
 * MessagingService.notify(). Đặt ở GuardiansModule thay vì mở rộng
 * NotificationEventsConsumer của MessagingModule để tránh vòng phụ
 * thuộc module (Guardians cần MessagingService, không chiều ngược).
 *
 * Cơ chế watermark/neo lại khi DB bị dựng lại trong lúc tiến trình
 * chạy theo đúng tiền lệ NotificationEventsConsumer (issue #125):
 * watermark riêng lưu Redis theo tên database, chỉ tiến sau khi sự
 * kiện xử lý xong; seq lớn nhất của DB nhỏ hơn watermark thì neo về 0
 * để không bỏ sót sự kiện của đời DB mới. Mọi handler đều an toàn khi
 * chạy lại (vết lượt guardian_digests không còn `queued` thì bỏ qua)
 * nên tính chất phân phối ít-nhất-một-lần là đủ. Lỗi của một sự kiện
 * được nuốt kèm cảnh báo sau khi thử xử lý — digest là kênh phụ,
 * không được làm hỏng nhịp quét của các sự kiện sau.
 */
@Injectable()
export class GuardianDigestConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GuardianDigestConsumer.name);
  private readonly redis: Redis;
  private readonly watermarkKey: string;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private watermark: number | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @InjectDrizzle() private readonly db: Database,
    private readonly digests: GuardianDigestService,
  ) {
    const redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, ...redisTlsFromUrl(redisUrl) });
    this.redis.on('error', (error: Error) => {
      this.logger.warn(`Redis của consumer digest phụ huynh lỗi: ${error.message}`);
    });
    let databaseName = 'default';
    try {
      databaseName = new URL(config.getOrThrow<string>('DATABASE_URL')).pathname.replace(/^\//, '') || 'default';
    } catch {
      // DATABASE_URL không parse được: giữ tên mặc định cho khoá watermark.
    }
    this.watermarkKey = `lms:guardians:digest:${databaseName}:seq`;
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

  /** Một nhịp quét: khởi tạo watermark nếu cần, rồi xử lý mọi sự kiện mới theo thứ tự seq. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.watermark === null) this.watermark = await this.initialWatermark();
      let rows = await this.fetchPending();
      if (rows.length === 0 && (await this.reanchorIfDbReset())) {
        rows = await this.fetchPending();
      }
      for (const row of rows) {
        await this.handle(row.type, row.payload as Record<string, unknown>);
        this.watermark = row.seq;
        await this.redis.set(this.watermarkKey, String(row.seq)).catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn(`Nhịp consumer digest phụ huynh lỗi: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Các sự kiện consumer này xử lý được đang chờ sau watermark, theo thứ tự seq. */
  private async fetchPending() {
    return this.db.select({ seq: outboxEvents.seq, type: outboxEvents.type, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(gt(outboxEvents.seq, this.watermark!), inArray(outboxEvents.type, [...HANDLED_TYPES])))
      .orderBy(asc(outboxEvents.seq))
      .limit(BATCH_SIZE);
  }

  /** Phát hiện DB đã bị dựng lại trong lúc tiến trình chạy và neo watermark về 0 (tiền lệ issue #125). */
  private async reanchorIfDbReset(): Promise<boolean> {
    const [row] = await this.db.select({ value: max(outboxEvents.seq) }).from(outboxEvents);
    const dbMax = row?.value ?? 0;
    if (this.watermark === null || dbMax >= this.watermark) return false;
    this.logger.warn(
      `Phát hiện DB đã bị dựng lại trong lúc tiến trình chạy (seq lớn nhất hiện có ${dbMax} < watermark ${this.watermark}) — neo lại watermark về 0 để xử lý các sự kiện của đời DB mới.`,
    );
    this.watermark = 0;
    await this.redis.set(this.watermarkKey, '0').catch(() => undefined);
    return true;
  }

  /** Watermark khởi tạo: giá trị đã lưu trong Redis nếu còn hợp lệ, ngược lại neo tại seq hiện tại (không phát lại lịch sử). */
  private async initialWatermark(): Promise<number> {
    const [row] = await this.db.select({ value: max(outboxEvents.seq) }).from(outboxEvents);
    const dbMax = row?.value ?? 0;
    const storedRaw = await this.redis.get(this.watermarkKey).catch(() => null);
    const stored = storedRaw === null ? null : Number(storedRaw);
    const start = stored !== null && Number.isFinite(stored) && stored <= dbMax ? stored : dbMax;
    await this.redis.set(this.watermarkKey, String(start)).catch(() => undefined);
    return start;
  }

  /** Xử lý một sự kiện outbox đã commit; payload hỏng/thiếu trường thì bỏ qua (watermark vẫn tiến ở tầng gọi). */
  private async handle(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      if (type === 'guardian_digest_due') {
        const due = payload as unknown as GuardianDigestDuePayload;
        if (typeof due.guardianUserId === 'string' && typeof due.studentUserId === 'string'
          && typeof due.digestId === 'string' && typeof due.windowStart === 'string' && typeof due.windowEnd === 'string'
          && (due.kind === 'weekly' || due.kind === 'daily')) {
          await this.digests.processDigestDue(due);
        }
        return;
      }
      if (type === 'guardian_overdue_alert') {
        const alert = payload as unknown as GuardianOverdueAlertPayload;
        if (typeof alert.guardianUserId === 'string' && typeof alert.studentUserId === 'string'
          && typeof alert.digestId === 'string' && typeof alert.cmId === 'string') {
          await this.digests.processOverdueAlert(alert);
        }
      }
    } catch (error) {
      this.logger.warn(`Xử lý sự kiện digest ${type} lỗi: ${(error as Error).message}`);
    }
  }
}
