import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, gt, inArray, max } from 'drizzle-orm';
import Redis from 'ioredis';
import { COURSE_COMPLETION_REAGGREGATION_REQUESTED } from '@lms/enrol';
import type { Database } from '../../db/database';
import { outboxEvents } from '../../db/schema';
import { redisTlsFromUrl } from '../../config/env';
import { CompletionService } from './completion.service';

/** Nhịp quét outbox của consumer tái tổng hợp hoàn thành. */
const POLL_INTERVAL_MS = 1000;
/** Số sự kiện tối đa xử lý trong một nhịp quét. */
const BATCH_SIZE = 200;
/** Loại sự kiện duy nhất consumer này tiêu thụ. */
const REAGGREGATION_TYPES = [COURSE_COMPLETION_REAGGREGATION_REQUESTED] as const;

/**
 * Consumer outbox cho yêu cầu TÁI TỔNG HỢP HOÀN THÀNH KHOÁ HỌC sau
 * khi gỡ ghi danh.
 *
 * Vì sao consumer này tồn tại: rời một khoá học tự nó có thể làm
 * hoàn thành khoá đó (tiêu chí 'unenrol' của Moodle trong bộ tiêu
 * chí hoàn thành khoá), nên mỗi thao tác gỡ ghi danh phải kéo theo
 * một lần tái tổng hợp hoàn thành cho đúng (người dùng, khoá) đó.
 * Trước đây việc này chạy bằng hook đồng bộ trong tiến trình API do
 * CompletionModule đăng ký vào EnrolService lúc khởi tạo: hook chạy
 * sau khi unenrol đã xong và lỗi của nó bị nuốt, nên tiến trình
 * chết giữa hai bước là mất tái tổng hợp vĩnh viễn, và cơ chế đăng
 * ký lúc chạy đó chỉ tồn tại trong tiến trình API — bề mặt vật chất
 * hoá dùng chung (`@lms/enrol`) không mang theo được. Nay bề mặt đó
 * phát sự kiện `course_completion_reaggregation_requested` trong
 * CÙNG transaction với thao tác gỡ ghi danh (rollback thì không có
 * yêu cầu nào tồn tại; commit thì yêu cầu chắc chắn tồn tại), và
 * consumer này — thuộc CompletionModule, phía API — tiêu thụ nó để
 * gọi `CompletionService.reaggregateCourseCompletion`.
 *
 * Cách tiêu thụ theo khuôn các consumer outbox của API: quét bảng
 * `outbox_events` theo watermark `seq` RIÊNG của consumer này (lưu
 * Redis, khoá theo tên database), tự neo lại khi phát hiện cơ sở
 * dữ liệu bị dựng lại trong lúc tiến trình vẫn chạy. Một điểm KHÁC
 * khuôn khởi tạo của các consumer loại sự kiện cũ: khi chưa có
 * watermark đã lưu hợp lệ, consumer này bắt đầu từ 0 thay vì neo
 * tại seq lớn nhất hiện có — loại sự kiện này sinh ra cùng chính
 * consumer này nên không có lịch sử của chính nó cần tránh phát
 * lại, còn yêu cầu ghi trước tick đầu tiên (hoặc trong lúc API
 * ngừng, bởi tiến trình khác dùng bề mặt vật chất hoá dùng chung)
 * đều là việc thật phải làm; neo qua chúng là mất yêu cầu vĩnh
 * viễn vì không có quét đối soát nào cho loại này (xem
 * `initialWatermark`). Sự kiện này KHÔNG nằm trong bảng định tuyến relay của
 * worker: relay không đóng dấu `published_at` cho nó và không phía
 * nào khác tiêu thụ nó. Payload thiếu định danh người dùng/khoá thì
 * bỏ qua. Lỗi khi tái tổng hợp một sự kiện được ghi log rồi bỏ qua
 * (watermark vẫn tiến) — cùng ngữ nghĩa nuốt lỗi của hook trước đây
 * (tái tổng hợp lỗi không bao giờ được làm hỏng việc gỡ ghi danh
 * hay chặn hàng đợi), chỉ khác là nay có log để vận hành nhìn thấy.
 */
@Injectable()
export class CompletionReaggregationOutboxConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CompletionReaggregationOutboxConsumer.name);
  private readonly redis: Redis;
  private readonly watermarkKey: string;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private watermark: number | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @InjectDrizzle() private readonly db: Database,
    private readonly completion: CompletionService,
  ) {
    const redisUrl = config.getOrThrow<string>('REDIS_URL');
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, ...redisTlsFromUrl(redisUrl) });
    this.redis.on('error', (error: Error) => {
      this.logger.warn(`Redis của consumer tái tổng hợp hoàn thành lỗi: ${error.message}`);
    });
    let databaseName = 'default';
    try {
      databaseName = new URL(config.getOrThrow<string>('DATABASE_URL')).pathname.replace(/^\//, '') || 'default';
    } catch {
      // DATABASE_URL không parse được: giữ tên mặc định cho khoá watermark.
    }
    this.watermarkKey = `lms:completion-reaggregation:${databaseName}:seq`;
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

  /** Một nhịp quét: khởi tạo watermark nếu cần, rồi tiêu thụ mọi yêu cầu tái tổng hợp mới theo thứ tự seq. */
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
          await this.dispatch(row.payload as Record<string, unknown>);
        } catch (error) {
          this.logger.warn(`Tái tổng hợp hoàn thành cho sự kiện seq=${row.seq} lỗi, bỏ qua: ${(error as Error).message}`);
        }
        this.watermark = row.seq;
        await this.redis.set(this.watermarkKey, String(row.seq)).catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn(`Nhịp tái tổng hợp hoàn thành từ outbox lỗi: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Các yêu cầu tái tổng hợp đang chờ sau watermark, theo thứ tự seq. */
  private async fetchPending() {
    return this.db.select({ seq: outboxEvents.seq, type: outboxEvents.type, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(gt(outboxEvents.seq, this.watermark!), inArray(outboxEvents.type, [...REAGGREGATION_TYPES])))
      .orderBy(asc(outboxEvents.seq))
      .limit(BATCH_SIZE);
  }

  /** Phát hiện DB dựng lại trong lúc tiến trình chạy và neo watermark về 0 (khuôn consumer đồng bộ cohort). */
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

  /**
   * Watermark khởi tạo: giá trị đã lưu trong Redis nếu còn hợp lệ
   * (số hữu hạn, không vượt seq lớn nhất hiện có); chưa từng lưu
   * hoặc giá trị đã lưu không còn hợp lệ thì bắt đầu từ 0 để tiêu
   * thụ toàn bộ tồn đọng của loại sự kiện này. Đây là điểm khác
   * khuôn neo-tại-seq-lớn-nhất của các consumer loại sự kiện cũ:
   * khuôn đó sinh ra để không phát lại lịch sử của loại sự kiện
   * đã tồn tại trước consumer, còn loại sự kiện này sinh ra cùng
   * chính consumer này — mọi dòng tồn tại trước tick đầu tiên đều
   * là yêu cầu tái tổng hợp thật do thao tác gỡ ghi danh phát ra
   * (kể cả khi được ghi bởi tiến trình khác dùng bề mặt vật chất
   * hoá dùng chung trong lúc API ngừng) và neo qua chúng là bỏ
   * qua vĩnh viễn. Tiêu thụ lại một yêu cầu là an toàn vì tái
   * tổng hợp hoàn thành là phép tính lại theo trạng thái hiện
   * tại, có tính idempotent, và phép quét vẫn lọc đúng loại sự
   * kiện này.
   */
  private async initialWatermark(): Promise<number> {
    const [row] = await this.db.select({ value: max(outboxEvents.seq) }).from(outboxEvents);
    const dbMax = row?.value ?? 0;
    const storedRaw = await this.redis.get(this.watermarkKey).catch(() => null);
    const stored = storedRaw === null ? null : Number(storedRaw);
    const start = stored !== null && Number.isFinite(stored) && stored <= dbMax ? stored : 0;
    await this.redis.set(this.watermarkKey, String(start)).catch(() => undefined);
    return start;
  }

  /** Tái tổng hợp hoàn thành cho đúng (người dùng, khoá) mà sự kiện yêu cầu; payload thiếu định danh thì bỏ qua. */
  private async dispatch(payload: Record<string, unknown>): Promise<void> {
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    if (!courseId || !userId) return;
    await this.completion.reaggregateCourseCompletion(userId, courseId);
  }
}
