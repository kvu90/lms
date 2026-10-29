import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, gt, inArray, max } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import { outboxEvents } from '@lms/db';
import type { relations } from './db/relations';
import { redisConnectionFromUrl } from './config/env';
import { tenantAls } from './db/tenant-als';
import { NOTIFICATION_EVENT_TYPES } from './notification-events-handler.service';
import type { OutboxEventJobData } from './outbox-event-routes';

type Database = NodePgDatabase<typeof relations>;

/**
 * Tiền tố khoá watermark của consumer polling thông báo phía API
 * trước đây: khoá đầy đủ là `${LEGACY_WATERMARK_KEY_PREFIX}<tên
 * database>:seq`, giá trị là `seq` của dòng outbox cuối cùng
 * consumer cũ đã xử lý xong. Tên khoá và ngữ nghĩa giá trị lấy
 * đúng từ consumer cũ — cơ chế phát bù đọc lại chính khoá đó,
 * không dựng khoá song song.
 */
const LEGACY_WATERMARK_KEY_PREFIX = 'lms:messaging:notifications:';
/** Số dòng tồn đọng tối đa đọc trong một lô phát bù — cùng cỡ lô quét của consumer cũ. */
const DRAIN_BATCH_SIZE = 100;
/**
 * Nhịp chờ đầu tiên trước lần thử phát bù kế tiếp khi một lần
 * thử bị lỗi — cùng quy ước backoff mũ của hàng đợi trong hệ
 * (`defaultJobOptions` ở `worker.module.ts`: backoff
 * exponential, delay 1000 ms).
 */
const DRAIN_RETRY_BASE_DELAY_MS = 1_000;
/** Trần nhịp chờ giữa hai lần thử phát bù: backoff gấp đôi sau mỗi lần thử lỗi nhưng không vượt mức này. */
const DRAIN_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Cơ chế chuyển tiếp MỘT LẦN của consumer thông báo sự kiện (issue
 * con #520 của #491; bổ sung theo phân xử điểm chặn trên PR #542):
 * phát bù các dòng outbox thông báo bị kẹt lại tại thời điểm gỡ
 * consumer polling phía API.
 *
 * @remarks
 * Bối cảnh bắt buộc phải có cơ chế này: consumer polling cũ đọc
 * dòng theo `seq > watermark` KHÔNG phụ thuộc `publishedAt`, còn
 * relay outbox đóng dấu `publishedAt` vô điều kiện cho cả loại sự
 * kiện chưa có trong bảng định tuyến. Tại thời điểm PR #542 triển
 * khai (mười loại thông báo vào bảng định tuyến, consumer cũ bị
 * gỡ), mọi dòng thông báo có `seq` lớn hơn watermark cuối của
 * consumer cũ đều đã mang `publishedAt`: relay không bao giờ phát
 * chúng thành job (relay chỉ lấy dòng chưa có dấu), và reader theo
 * watermark đã bị gỡ — thông báo tương ứng mất vĩnh viễn và lặng
 * lẽ nếu không có bước chuyển tiếp.
 *
 * Flow (kích hoạt khi module khởi động — `onModuleInit` chờ
 * lượt phát bù rút cạn xong mới hoàn tất khởi tạo, đúng mẫu
 * hook async của NestJS; trong ngữ cảnh platform tường minh
 * như relay vì việc quét xuyên tenant):
 * 1. Dựng lại khoá watermark của consumer cũ từ tên database
 *    trong `DATABASE_URL` — đúng cách consumer cũ dựng — và đọc
 *    giá trị đã lưu. Khoá không tồn tại nghĩa là hệ mới tinh
 *    (consumer cũ chưa từng chạy trên đời DB này): dừng ngay,
 *    không làm gì thêm.
 * 2. Đọc các dòng thuộc mười loại sự kiện thông báo có `seq` lớn
 *    hơn watermark, theo thứ tự `seq` tăng dần, từng lô
 *    {@link DRAIN_BATCH_SIZE} dòng, BẤT KỂ dòng đã có
 *    `publishedAt` hay chưa (dòng chưa có dấu thì relay cũng sẽ
 *    phát — hai đường gặp nhau ở khoá chống trùng dưới đây).
 * 3. Mỗi dòng được phát thành job vào hàng đợi
 *    `notification-events` theo đúng hình dạng relay phát: tên
 *    job là loại sự kiện, `jobId` là id của dòng, dữ liệu là
 *    toàn bộ dòng đã chuẩn hoá ({@link OutboxEventJobData}).
 * 4. Rút cạn hết các lô thì XOÁ khoá watermark cũ: dấu vết
 *    chuyển tiếp không còn, các lần khởi động sau là no-op.
 *
 * Bất biến:
 * - Chống trùng hai lớp, cùng khuôn toàn hệ outbox: `jobId`
 *   bằng id dòng khiến BullMQ trả lại job đã có thay vì tạo job
 *   thứ hai khi dòng được phát hai đường (phát bù và relay) hoặc
 *   phát bù chạy lại sau một lần rút cạn dở dang; ngoài cửa sổ
 *   lưu giữ của hàng đợi, processor `NotificationEventsProcessor`
 *   chống trùng theo `outboxId` bằng dấu đã xử lý — dòng đã xử
 *   lý rồi không sinh thông báo thứ hai.
 * - Đây KHÔNG phải consumer polling thứ hai: cơ chế chỉ chạy
 *   khi còn khoá watermark cũ (triển khai lần đầu) và tự xoá
 *   khoá khi rút cạn xong. Đường thường trực duy nhất vẫn là
 *   relay → hàng đợi như thiết kế gốc.
 * - Tự neo khi DB dựng lại: watermark lưu lớn hơn `seq` lớn
 *   nhất hiện có nghĩa là khoá thuộc về đời DB trước (seq đã
 *   thụt lùi sau reset) — không dòng nào của đời DB này nằm
 *   trên watermark đó, phần rút cạn hoàn tất rỗng và khoá cũ
 *   được xoá như thường, không kẹt lại cho các lần khởi động
 *   sau.
 *
 * Hành vi khi lỗi (sửa vòng 2 theo phân xử trên PR #542): lỗi
 * ở bất kỳ bước nào (đọc khoá, đọc DB, đẩy job) làm LẦN THỬ
 * đang chạy dừng ngay tại đó; khoá watermark cũ KHÔNG bị xoá.
 * Lượt phát bù tự thử lại ngay trong cùng tiến trình, có
 * backoff mũ ({@link DRAIN_RETRY_BASE_DELAY_MS} gấp đôi mỗi
 * lần, trần {@link DRAIN_RETRY_MAX_DELAY_MS}), cho tới khi
 * rút cạn trọn vẹn — mỗi lần thử thất bại ghi log mức error
 * kèm số lần thử và nhịp chờ kế tiếp, không nuốt lặng. Cơ
 * chế trước đây chỉ thử đúng một lần ở `onModuleInit` rồi
 * nuốt lỗi: relay thường trực chỉ quét dòng chưa có
 * `publishedAt` nên phần tồn đọng chưa phát kẹt vô hạn tới
 * lần khởi động worker kế tiếp — vòng thử lại này đóng đúng
 * cửa sổ đó, và việc phát lại an toàn nhờ hai lớp chống
 * trùng ở trên. Vòng thử chỉ dừng hẳn khi module bị huỷ
 * (`onModuleDestroy`, tiến trình đang đóng): lần khởi động
 * kế tiếp vẫn gặp khoá cũ và phát bù lại từ đầu. Vì
 * `onModuleInit` chờ lượt phát bù, một hạ tầng đang lỗi kéo
 * dài việc khởi tạo module tương ứng — đây là lựa chọn có
 * chủ đích: thà worker chậm lên còn hơn chuyển tiếp kẹt
 * lặng lẽ; hệ không còn khoá cũ (trạng thái thường trực sau
 * chuyển đổi) thì lượt phát bù là no-op tức thì và khởi tạo
 * không bị ảnh hưởng.
 *
 * Side-effect: đẩy job BullMQ vào hàng đợi `notification-events`
 * và xoá khoá Redis của consumer cũ sau khi rút cạn. Không ghi
 * DB, không đóng dấu `publishedAt` (dấu đó là của relay).
 */
@Injectable()
export class NotificationEventsCatchupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationEventsCatchupService.name);
  private readonly redis: Redis;
  private readonly legacyWatermarkKey: string;
  /** Cờ báo module đang bị huỷ: vòng thử lại của lượt phát bù dừng hẳn thay vì quay tiếp trong tiến trình đang đóng. */
  private destroying = false;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @InjectQueue('notification-events') private readonly queue: Queue<OutboxEventJobData>,
    config: ConfigService,
  ) {
    this.redis = new Redis({
      ...redisConnectionFromUrl(config.getOrThrow<string>('REDIS_URL')),
    });
    // Dựng khoá đúng cách consumer polling cũ dựng: tên database
    // là path của DATABASE_URL bỏ dấu gạch đầu; không parse được
    // thì dùng tên mặc định — cả hai phía cùng một luật nên khoá
    // luôn gặp nhau.
    let databaseName = 'default';
    try {
      databaseName = new URL(config.getOrThrow<string>('DATABASE_URL')).pathname.replace(/^\//, '') || 'default';
    } catch {
      // DATABASE_URL không parse được: giữ tên mặc định như consumer cũ.
    }
    this.legacyWatermarkKey = `${LEGACY_WATERMARK_KEY_PREFIX}${databaseName}:seq`;
  }

  /**
   * Điểm vào khi module khởi động: chạy lượt phát bù và chờ nó
   * rút cạn xong mới hoàn tất khởi tạo (hook async được NestJS
   * chờ theo đúng vòng đời của framework).
   * {@link drainLegacyBacklog} tự thử lại có backoff khi gặp
   * lỗi thoáng qua nên hook này không ném; nó chỉ trở về sớm
   * khi module bị huỷ giữa chừng (tiến trình đang đóng).
   */
  async onModuleInit(): Promise<void> {
    await this.drainLegacyBacklog();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroying = true;
    await this.redis.quit().catch(() => undefined);
  }

  /**
   * Rút cạn tồn đọng theo watermark cũ và phát bù thành job,
   * tự thử lại có backoff cho tới khi rút cạn trọn vẹn.
   *
   * @returns Số job đã phát trong lần thử hoàn tất: 0 khi
   * không có khoá watermark cũ (hệ mới tinh, hoặc chuyển tiếp
   * đã hoàn tất ở một lần khởi động trước), 0 khi tồn đọng
   * rỗng, và 0 khi vòng thử bị dừng vì module đang bị huỷ.
   * Các dòng đã phát ở một lần thử dở dang được phát lại ở lần
   * thử kế tiếp và được BullMQ trả về job đã có theo `jobId`,
   * nên con số này đếm theo lần thử hoàn tất, không cộng dồn
   * qua các lần thử.
   */
  async drainLegacyBacklog(): Promise<number> {
    return tenantAls.run({ platform: true }, () => this.drainWithRetry());
  }

  /**
   * Vòng thử lại của lượt phát bù: chạy từng lần thử rút cạn
   * ({@link drainAttempt}) cho tới khi một lần thử hoàn tất.
   * Mỗi lần thử thất bại ghi log mức error kèm số lần thử, số
   * job đã phát được trong lần thử đó và nhịp chờ backoff
   * trước lần thử kế tiếp — tồn đọng không bao giờ kẹt lặng
   * lẽ trong lúc tiến trình còn sống. Vòng chỉ dừng hẳn khi
   * module đang bị huỷ.
   *
   * @returns Số job đã phát trong lần thử hoàn tất (0 khi bị
   * dừng vì module đang bị huỷ).
   */
  private async drainWithRetry(): Promise<number> {
    let attempt = 0;
    for (;;) {
      if (this.destroying) return 0;
      attempt += 1;
      let enqueuedThisAttempt = 0;
      try {
        const enqueued = await this.drainAttempt((count) => {
          enqueuedThisAttempt = count;
        });
        if (attempt > 1) {
          this.logger.log(
            `Phát bù tồn đọng thông báo theo watermark cũ hoàn tất ở lần thử ${attempt} (${enqueued} job).`,
          );
        }
        return enqueued;
      } catch (error) {
        const delayMs = Math.min(
          DRAIN_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          DRAIN_RETRY_MAX_DELAY_MS,
        );
        this.logger.error(
          `Phát bù tồn đọng thông báo theo watermark cũ dừng giữa chừng ở lần thử ${attempt} sau ${enqueuedThisAttempt} job (khoá ${this.legacyWatermarkKey} được giữ nguyên): ${error instanceof Error ? error.message : String(error)}. Thử lại sau ${delayMs} ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Một lần thử rút cạn trong ngữ cảnh platform đã bọc: đọc
   * khoá watermark cũ và rút cạn các dòng trên nó. Lỗi ở bất
   * kỳ bước nào được ném ra cho {@link drainWithRetry} quyết
   * định thử lại — hàm này không tự nuốt lỗi.
   *
   * Hai trạng thái kết thúc không phải lỗi: không có khoá cũ
   * (hệ mới tinh hoặc chuyển tiếp đã xong — no-op) và giá trị
   * khoá không phải số (dữ kiện hỏng cố định, thử lại không
   * sửa được: ghi log mức warn và giữ nguyên khoá, giữ đúng
   * hành vi trước đây).
   *
   * @param onProgress Báo số job đã phát sau mỗi job, để tầng
   * gọi ghi được con số thật của lần thử khi nó dừng vì lỗi.
   * @returns Số job đã phát trong lần thử này.
   */
  private async drainAttempt(onProgress: (enqueued: number) => void): Promise<number> {
    const storedRaw = await this.redis.get(this.legacyWatermarkKey);
    if (storedRaw === null) return 0;
    const watermark = Number(storedRaw);
    if (!Number.isFinite(watermark)) {
      this.logger.warn(
        `Khoá watermark cũ ${this.legacyWatermarkKey} mang giá trị không phải số ("${storedRaw}") — bỏ qua lượt phát bù, giữ nguyên khoá.`,
      );
      return 0;
    }

    return this.drainFromWatermark(watermark, onProgress);
  }

  /**
   * Rút cạn các dòng trên `watermark` và xoá khoá cũ khi xong.
   *
   * @param watermark Giá trị `seq` đã lưu của consumer cũ.
   * @param onProgress Báo số job đã phát sau mỗi job, để tầng
   * gọi giữ được con số thật khi lượt rút cạn dừng vì lỗi.
   * @returns Tổng số job đã phát bù trong lượt này.
   */
  private async drainFromWatermark(
    watermark: number,
    onProgress: (enqueued: number) => void,
  ): Promise<number> {

    // Neo khi DB đã dựng lại: watermark vượt quá seq lớn nhất
    // hiện có thì không dòng nào của đời DB này nằm trên
    // watermark — tồn đọng rỗng theo định nghĩa.
    const [maxRow] = await this.db.select({ value: max(outboxEvents.seq) }).from(outboxEvents);
    const dbMax = maxRow?.value === null || maxRow?.value === undefined ? 0 : Number(maxRow.value);

    let enqueued = 0;
    if (watermark < dbMax) {
      // Đọc tồn đọng theo đúng hình dạng truy vấn của consumer
      // cũ: `seq > watermark AND type IN (mười loại)`, thứ tự
      // seq tăng dần, từng lô — chỉ khác ở chỗ cơ chế này đọc
      // bất kể `publishedAt` và đích đến là hàng đợi thay vì
      // handler trực tiếp.
      let cursor = watermark;
      for (;;) {
        const rows = await this.db
          .select()
          .from(outboxEvents)
          .where(
            and(
              gt(outboxEvents.seq, cursor),
              inArray(outboxEvents.type, [...NOTIFICATION_EVENT_TYPES]),
            ),
          )
          .orderBy(asc(outboxEvents.seq))
          .limit(DRAIN_BATCH_SIZE);
        if (rows.length === 0) break;
        for (const row of rows) {
          cursor = Number(row.seq);
          const data: OutboxEventJobData = {
            outboxId: row.id,
            seq: row.seq,
            aggregate: row.aggregate,
            type: row.type,
            payload: row.payload as Record<string, unknown> | null,
            tenantId: row.tenantId,
            occurredAt: row.occurredAt.toISOString(),
          };
          await this.queue.add(row.type, data, { jobId: row.id });
          enqueued += 1;
          onProgress(enqueued);
        }
        if (rows.length < DRAIN_BATCH_SIZE) break;
      }
    }

    await this.redis.del(this.legacyWatermarkKey);
    if (enqueued > 0) {
      this.logger.log(
        `Đã phát bù ${enqueued} sự kiện thông báo tồn đọng theo watermark cũ (seq > ${watermark}) và xoá khoá watermark của consumer cũ.`,
      );
    }
    return enqueued;
  }
}
