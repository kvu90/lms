import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
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
 * Thời gian hoãn một job phân phối khi lượt phân phối gặp lỗi
 * thật: job được đưa vào hàng đợi delayed của BullMQ và phát lại
 * sau khoảng này, lặp lại cho tới khi phân phối thành công —
 * cùng độ dài hoãn với các processor tiền lệ của đợt chuyển đổi
 * (`PROCESSING_RETRY_DELAY_MS` của consumer thư xác thực,
 * `PROCESSING_LEASE_RETRY_DELAY_MS` của consumer thông báo sự
 * kiện). 5 giây khớp nhịp quét của relay và giữ độ trễ của kênh
 * realtime ở mức giây khi lỗi chỉ thoáng qua.
 */
const DISTRIBUTION_RETRY_DELAY_MS = 5_000;

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
 * job mới). Các ca payload hỏng/thiếu hoặc dữ kiện đã biến mất là
 * no-op hoàn thành bên trong luật phân phối, như consumer tiền lệ.
 *
 * Ngữ nghĩa lỗi — phần tự phục hồi của đường này: lỗi thật khi
 * phân phối (đọc dữ kiện lỗi ở tầng phân phối, publish Redis bị từ
 * chối ở cổng phát, ghi dấu lỗi) KHÔNG được ném thẳng ra cho
 * BullMQ tính là lần thử thất bại. Khác biệt này là cốt lõi: relay
 * đã đóng dấu `publishedAt` cho dòng outbox ngay khi job vào hàng
 * đợi thành công, nên một job chết hẳn sau số lần thử mặc định
 * (attempts 3 toàn worker) là mất sự kiện vĩnh viễn — không còn
 * đường phát lại nào với tới dòng đó nữa, trong khi lỗi gây ra có
 * thể chỉ là thoáng qua kéo dài hơn cửa sổ thử mặc định. Vì vậy
 * processor bắt lỗi phân phối, hoãn job bằng `moveToDelayed` và
 * ném `DelayedError` — đúng pattern hoãn chính thức của BullMQ mà
 * các processor tiền lệ của đợt chuyển đổi (thư xác thực, thông
 * báo sự kiện) đã dùng: lượt hoãn không tính là lần thử thất bại,
 * không đốt số lần thử của job, và trạng thái thử lại neo ở chính
 * job trong Redis (bền qua khởi động lại của worker) chứ không
 * nằm ở bộ nhớ tiến trình. Chu trình hoãn lặp lại sau mỗi
 * {@link DISTRIBUTION_RETRY_DELAY_MS} cho tới khi phân phối thành
 * công và dấu được ghi như bình thường; mỗi lượt hoãn đều ghi log
 * lỗi kèm `outboxId` để vận hành nhìn thấy job đang chờ phục hồi.
 *
 * Ranh giới phục hồi còn lại, ghi rõ để không hiểu nhầm phạm vi:
 * - Nếu hạ tầng hàng đợi sập tới mức chính thao tác
 *   `moveToDelayed` cũng không thực hiện được (ví dụ Redis chứa
 *   hàng đợi không với tới được), lỗi của thao tác hoãn truyền ra
 *   ngoài và BullMQ xử lý theo chính sách attempts mặc định —
 *   đây là suy biến khi chính nền thử lại đã mất, nằm ngoài khả
 *   năng tự cứu của bất kỳ consumer nào trên cùng hàng đợi.
 * - Job có phong bì hỏng vĩnh viễn (thiếu `outboxId` hoặc loại sự
 *   kiện) vẫn ném lỗi ngay và chết theo attempts như cũ: nó không
 *   mang sự kiện nào để mất, và hoãn vô hạn một job không bao giờ
 *   hợp lệ được chỉ làm rác hàng đợi.
 * - Kênh realtime là kênh phụ phát sự kiện, không phải nơi lưu sự
 *   kiện: dữ kiện gốc của messaging (tin nhắn, trạng thái đã đọc)
 *   nằm nguyên trong cơ sở dữ liệu, nên kể cả khi một sự kiện
 *   realtime bị trễ trong cửa sổ phục hồi, phía đọc vẫn tự lành
 *   khi client nối lại hoặc tải lại cuộc trò chuyện.
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

  /**
   * Xử lý một job phân phối realtime.
   *
   * @param job Job do relay phát: `job.data` là toàn bộ dòng
   * outbox đã chuẩn hoá; định danh chống trùng là
   * `job.data.outboxId` (đồng thời là `jobId` của job).
   * @param token Token khoá job do worker của BullMQ cấp (NestJS
   * truyền qua `WorkerHost.process`) — cần cho thao tác hoãn job
   * `moveToDelayed`; các lượt gọi trực tiếp không qua worker
   * (test) bỏ qua tham số này.
   * @throws Lỗi phong bì job (thiếu `outboxId`/loại sự kiện):
   * hỏng vĩnh viễn, ném ra để job chết theo attempts như cũ.
   * @throws {DelayedError} Khi lượt phân phối gặp lỗi thật: job
   * đã được hoãn {@link DISTRIBUTION_RETRY_DELAY_MS} bằng
   * `moveToDelayed` (khi có token của worker) trước khi lỗi này
   * được ném — đây là TÍN HIỆU HẸN THỬ LẠI, không phải lần thử
   * thất bại; dấu chưa ghi nên lượt phát lại phân phối tiếp.
   */
  async process(job: Job<OutboxEventJobData>, token?: string): Promise<void> {
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
      try {
        await this.distribution.distributeEvent(data.type, data.payload ?? {});
        await this.redis.set(markKey, '1', 'EX', DISTRIBUTED_MARK_TTL_SECONDS);
      } catch (error) {
        // Lỗi thật của lượt phân phối: hoãn job để thử lại thay
        // vì để BullMQ đốt attempts rồi giết job (dòng outbox đã
        // đóng dấu publishedAt ở relay nên job chết là mất sự
        // kiện — xem ngữ nghĩa lỗi ở đầu file). Thao tác hoãn
        // lỗi (hạ tầng hàng đợi sập) thì lỗi của nó truyền ra
        // ngoài thay cho DelayedError, đúng ranh giới đã ghi.
        this.logger.error(
          `Phân phối sự kiện outbox ${data.outboxId} (loại ${data.type}) lỗi, hẹn thử lại sau ${DISTRIBUTION_RETRY_DELAY_MS}ms: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (token) {
          await job.moveToDelayed(Date.now() + DISTRIBUTION_RETRY_DELAY_MS, token);
        }
        throw new DelayedError();
      }
    });
  }
}
