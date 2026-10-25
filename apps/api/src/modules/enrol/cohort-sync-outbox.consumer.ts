import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, gt, inArray, max } from 'drizzle-orm';
import Redis from 'ioredis';
import type { Database } from '../../db/database';
import { outboxEvents } from '../../db/schema';
import { redisTlsFromUrl } from '../../config/env';
import { EnrolService } from './enrol.service';

/** Nhịp quét outbox của consumer đồng bộ cohort. */
const POLL_INTERVAL_MS = 1000;
/** Số sự kiện tối đa xử lý trong một nhịp quét. */
const BATCH_SIZE = 200;
/** Các loại sự kiện cohort được vật chất hoá thành ghi danh cấp khoá. */
const SYNC_TYPES = ['cohort_member_added', 'cohort_member_removed'] as const;

/**
 * Consumer outbox cho sự kiện thành viên cohort (issue #184, CLASS-0 —
 * vá bền vững #1 của hồ sơ lớp học).
 *
 * Vì sao consumer này tồn tại: `GroupsService.addCohortMember` /
 * `removeCohortMember` phát sự kiện cohort theo HAI đường — outbox (bền)
 * và EventEmitter in-process (nhanh). Trước lát này CHỈ đường in-process
 * có người nghe (`EnrolService.onCohortMemberAdded/Removed`): tiến trình
 * API chết sau khi `cohort_members` đã commit mà trước khi emit xong —
 * hoặc emit lỗi giữa chừng — thì đồng bộ ghi danh mất vĩnh viễn, không
 * dấu vết. Consumer này quét bảng `outbox_events` theo watermark `seq`
 * riêng (lưu Redis, khoá theo tên database như MessagingOutboxConsumer)
 * và gọi ĐÚNG hai handler đó — vốn đã idempotent — nên sự kiện được tiêu
 * thụ ít nhất một lần và trạng thái hội tụ về nguồn sự thật
 * `cohort_members`. Nó không đóng dấu `published_at` (đường relay của
 * worker giữ nguyên việc đó cho logstore).
 *
 * Watermark khởi tạo neo tại seq lớn nhất hiện có khi chưa từng lưu
 * (không phát lại lịch sử trước lát này — job đối soát
 * `class-enrol-reconcile` ở worker là lưới sửa lệch cho mọi khoảng
 * trống). DB bị dựng lại trong lúc tiến trình vẫn chạy được phát hiện
 * và neo lại như MessagingOutboxConsumer (bài học issue #125). Lỗi ở
 * một sự kiện được ghi log rồi bỏ qua (watermark vẫn tiến): handler lỗi
 * dai dẳng trên một payload không được phép chặn cả hàng đợi — phần
 * lệch do nó gây ra thuộc diện job đối soát sửa.
 */
@Injectable()
export class CohortSyncOutboxConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CohortSyncOutboxConsumer.name);
  private readonly redis: Redis;
  private readonly watermarkKey: string;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private watermark: number | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @InjectDrizzle() private readonly db: Database,
    private readonly enrol: EnrolService,
  ) {
    const redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, ...redisTlsFromUrl(redisUrl) });
    this.redis.on('error', (error: Error) => {
      this.logger.warn(`Redis của consumer đồng bộ cohort lỗi: ${error.message}`);
    });
    let databaseName = 'default';
    try {
      databaseName = new URL(config.getOrThrow<string>('DATABASE_URL')).pathname.replace(/^\//, '') || 'default';
    } catch {
      // DATABASE_URL không parse được: dùng khoá mặc định, vẫn an toàn.
    }
    this.watermarkKey = `lms:cohort-sync:${databaseName}:seq`;
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

  /** Một nhịp quét: khởi tạo watermark nếu cần, rồi tiêu thụ mọi sự kiện cohort mới theo thứ tự seq. */
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
        try {
          await this.dispatch(row.type, row.payload as Record<string, unknown>);
        } catch (error) {
          this.logger.warn(`Tiêu thụ sự kiện cohort seq=${row.seq} (${row.type}) lỗi, bỏ qua — job đối soát sẽ sửa lệch: ${(error as Error).message}`);
        }
        this.watermark = row.seq;
        await this.redis.set(this.watermarkKey, String(row.seq)).catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn(`Nhịp đồng bộ cohort từ outbox lỗi: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Các sự kiện cohort đang chờ sau watermark, theo thứ tự seq. */
  private async fetchPending() {
    return this.db.select({ seq: outboxEvents.seq, type: outboxEvents.type, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(gt(outboxEvents.seq, this.watermark!), inArray(outboxEvents.type, [...SYNC_TYPES])))
      .orderBy(asc(outboxEvents.seq))
      .limit(BATCH_SIZE);
  }

  /** Phát hiện DB dựng lại trong lúc tiến trình chạy và neo watermark về 0 (khuôn MessagingOutboxConsumer / issue #125). */
  private async reanchorIfDbReset(): Promise<boolean> {
    const [row] = await this.db.select({ value: max(outboxEvents.seq) }).from(outboxEvents);
    const dbMax = row?.value ?? 0;
    if (this.watermark === null || dbMax >= this.watermark) return false;
    this.logger.warn(
      `Phát hiện DB đã bị dựng lại trong lúc tiến trình chạy (seq lớn nhất hiện có ${dbMax} < watermark ${this.watermark}) — neo lại watermark về 0 để tiêu thụ các sự kiện của đời DB mới.`,
    );
    this.watermark = 0;
    await this.redis.set(this.watermarkKey, '0').catch(() => undefined);
    return true;
  }

  /** Watermark khởi tạo: giá trị đã lưu trong Redis nếu còn hợp lệ; chưa có thì neo tại seq hiện tại (không phát lại lịch sử). */
  private async initialWatermark(): Promise<number> {
    const [row] = await this.db.select({ value: max(outboxEvents.seq) }).from(outboxEvents);
    const dbMax = row?.value ?? 0;
    const storedRaw = await this.redis.get(this.watermarkKey).catch(() => null);
    const stored = storedRaw === null ? null : Number(storedRaw);
    const start = stored !== null && Number.isFinite(stored) && stored <= dbMax ? stored : dbMax;
    await this.redis.set(this.watermarkKey, String(start)).catch(() => undefined);
    return start;
  }

  /** Gọi đúng handler in-process sẵn có của EnrolService (idempotent) theo loại sự kiện. */
  private async dispatch(type: string, payload: Record<string, unknown>): Promise<void> {
    const cohortId = typeof payload.cohortId === 'string' ? payload.cohortId : null;
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    if (!cohortId || !userId) return;
    if (type === 'cohort_member_added') {
      await this.enrol.onCohortMemberAdded({ cohortId, userId });
    } else if (type === 'cohort_member_removed') {
      await this.enrol.onCohortMemberRemoved({ cohortId, userId });
    }
  }
}
