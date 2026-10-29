import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type Redis from 'ioredis';
import type { MessagingDistributionService } from '@lms/messaging';
import { tenantAls } from '../db/tenant-als';
import type { OutboxEventJobData } from '../outbox-event-routes';

/** Tên hàng đợi BullMQ của consumer phân phối realtime messaging. */
export const MESSAGING_REALTIME_QUEUE = 'messaging-realtime';

/** Khoá tiêm của tầng phân phối (`@lms/messaging`) cấp cho processor này. */
export const MESSAGING_DISTRIBUTION_SERVICE = 'MESSAGING_DISTRIBUTION_SERVICE';

/** Khoá tiêm của connection Redis giữ dấu đã-phân-phối. */
export const MESSAGING_DISTRIBUTED_REDIS = 'MESSAGING_DISTRIBUTED_REDIS';

/** Tiền tố khoá Redis của dấu đã-phân-phối, khoá theo `outboxId` của sự kiện. */
export const MESSAGING_DISTRIBUTED_KEY_PREFIX = 'lms:messaging:distributed:';

/**
 * TTL của dấu đã-phân-phối: 7 ngày — cùng khuôn với dấu đã-gửi của
 * consumer thư xác thực. Dấu chỉ cần sống lâu hơn cửa sổ phát lại
 * thực tế của hàng đợi (job còn trong hàng đợi thì `jobId` đã chống
 * trùng); 7 ngày thừa sức cho mọi lượt phát lại quanh sự cố.
 */
const DISTRIBUTED_MARK_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Consumer phân phối realtime cho messaging ở worker (issue #521) —
 * mắt xích "hàng đợi → phân phối" của kênh WebSocket, thay consumer
 * quét outbox trong tiến trình API trước đây.
 *
 * Flow của một job: relay duy nhất đã phát job từ một dòng
 * `outbox_events` (tên job là loại sự kiện, `jobId` là id của dòng,
 * dữ liệu job là toàn bộ dòng). Processor này:
 * 1. Chạy trong ngữ cảnh platform tường minh (phân phối quét xuyên
 *    tenant — cùng kỷ luật TENANT-1 với relay và consumer tiền lệ).
 * 2. Kiểm dấu đã-phân-phối theo `outboxId` trong Redis: đã có dấu
 *    thì job là lượt phát lại của một sự kiện đã phân phối xong —
 *    kết thúc ngay, không phân phối lần hai.
 * 3. Gọi luật phân phối dùng chung ở `@lms/messaging`
 *    (`distributeEvent`): đọc dữ kiện tại thời điểm phân phối, qua
 *    cổng chặn 1–1 fail-closed và rà soát membership, rồi phát qua
 *    Redis emitter về phía API.
 * 4. Chỉ sau khi phân phối xong mới ghi dấu đã-phân-phối.
 *
 * Chống trùng theo `outboxId` là lớp gác của chính consumer này, vì
 * chống trùng theo `jobId` của BullMQ chỉ có hiệu lực trong cửa sổ
 * lưu giữ của hàng đợi (job đã dọn khỏi hàng đợi thì phát lại tạo
 * job mới). Lỗi thật khi phân phối (DB/Redis lỗi) thì NÉM ra để
 * BullMQ thử lại job — dấu chưa ghi nên lượt thử lại phân phối tiếp;
 * các ca payload hỏng/thiếu hoặc dữ kiện đã biến mất là no-op hoàn
 * thành bên trong luật phân phối, như consumer tiền lệ.
 *
 * Tính chất at-least-once ở biên sự cố: tiến trình chết GIỮA lượt
 * phân phối (đã phát một phần, chưa ghi dấu) thì job được xử lý lại
 * và phần đã phát có thể phát trùng — vô hại vì client chống trùng
 * theo id/seq của tin và mốc đã-đọc, đúng tính chất của đường phân
 * phối realtime từ trước tới nay.
 */
@Processor(MESSAGING_REALTIME_QUEUE)
export class MessagingRealtimeProcessor extends WorkerHost {
  private readonly logger = new Logger(MessagingRealtimeProcessor.name);

  constructor(
    @Inject(MESSAGING_DISTRIBUTION_SERVICE) private readonly distribution: MessagingDistributionService,
    @Inject(MESSAGING_DISTRIBUTED_REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  async process(job: Job<OutboxEventJobData>): Promise<void> {
    const data = job.data;
    if (!data || typeof data.outboxId !== 'string' || data.outboxId.length === 0 || typeof data.type !== 'string') {
      throw new Error('Messaging realtime job is missing its outboxId or event type');
    }
    await tenantAls.run({ platform: true }, async () => {
      const markKey = `${MESSAGING_DISTRIBUTED_KEY_PREFIX}${data.outboxId}`;
      if ((await this.redis.exists(markKey)) === 1) {
        this.logger.debug(`Bỏ qua job phát lại của sự kiện outbox ${data.outboxId} (đã phân phối)`);
        return;
      }
      await this.distribution.distributeEvent(data.type, data.payload ?? {});
      await this.redis.set(markKey, '1', 'EX', DISTRIBUTED_MARK_TTL_SECONDS);
    });
  }
}
