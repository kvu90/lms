import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { redisConnectionFromUrl } from './config/env';

/** Tiền tố khoá Redis của dấu "đang xử lý" (lease) theo outboxId. */
const PROCESSING_KEY_PREFIX = 'lms:notification-events:processing:';
/** Tiền tố khoá Redis của dấu "đã xử lý" theo outboxId. */
const PROCESSED_KEY_PREFIX = 'lms:notification-events:processed:';
/**
 * Thời hạn của lease "đang xử lý": 10 phút. Lease chỉ là chốt chống
 * hai lượt chạy xử lý CÙNG một sự kiện song song, không phải giới
 * hạn thời gian xử lý: một sự kiện thông báo có thể fan-out tới toàn
 * bộ học viên của một khoá (mỗi người nhận là nhiều truy vấn DB cộng
 * một lần xếp hàng kênh ngoài), nên cửa sổ phải rộng hơn nhiều so
 * với lease của consumer email xác thực (60 giây, một thư duy nhất).
 * Lượt chạy sập giữa chừng thì lease hết hạn sau tối đa 10 phút và
 * lượt thử lại của BullMQ (đã được processor hoãn, không đốt lượt
 * thử) xử lý tiếp sự kiện.
 */
const PROCESSING_TTL_SECONDS = 600;
/**
 * Thời hạn của dấu "đã xử lý": 7 ngày — cùng thời hạn với dấu đã gửi
 * của consumer email xác thực. Cửa sổ phát lại thực tế của một job
 * (relay phát lại dòng chưa đóng dấu, BullMQ thử lại, chạy lại job
 * thủ công) nằm trong vài phút; 7 ngày bao phủ dư thừa mà vẫn tự
 * dọn.
 */
const PROCESSED_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Chốt chống trùng của consumer thông báo sự kiện ở worker (issue
 * con #520 của #491) — hai khoá Redis theo `outboxId`, đúng khuôn
 * hai trạng thái của consumer email xác thực sau phán quyết vòng 2
 * của issue #517:
 *
 * - Dấu ĐÃ XỬ LÝ (`processed:<outboxId>`): chỉ ghi SAU KHI handler
 *   đã xử lý xong sự kiện. Dấu này là căn cứ trả "trùng" cho mọi
 *   lần phát lại về sau: job được phát lại, thử lại hay chạy lại
 *   thủ công đều dừng ở đây, không sinh thông báo thứ hai.
 * - Lease ĐANG XỬ LÝ (`processing:<outboxId>`, giá trị là token duy
 *   nhất của lượt chạy đang giữ): chiếm nguyên tử bằng SET NX.
 *   Lease tách hẳn khỏi dấu đã xử lý để một lượt chạy sập SAU KHI
 *   chiếm lease nhưng TRƯỚC KHI xử lý xong không để lại dấu giả —
 *   sự kiện vẫn được xử lý khi lease hết hạn thay vì bị coi là
 *   trùng vĩnh viễn. Nhả lease kiểm tra đúng token của chủ (script
 *   Lua so token trước khi xoá) để một lượt chạy chậm không xoá
 *   được lease của lượt chạy sau.
 *
 * Cả hai thao tác đọc dấu đều được processor gọi lại BÊN TRONG
 * lease (đọc nhanh trước khi chiếm chỉ là lối tắt): nhờ vậy cửa sổ
 * "đọc thấy chưa xử lý → bị giữ lại → lượt khác xử lý xong và nhả
 * lease → lượt này chiếm được lease trống" vẫn bị chặn ở lần đọc
 * lại, và handler của một `outboxId` chạy tối đa một lần.
 *
 * Khoá không chứa dữ kiện sự kiện nào (chỉ `outboxId`); phía đọc
 * khoá là chính processor `NotificationEventsProcessor`.
 */
@Injectable()
export class NotificationEventsMarker implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(config: ConfigService) {
    this.redis = new Redis({
      ...redisConnectionFromUrl(config.getOrThrow<string>('REDIS_URL')),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  /**
   * Dấu đã xử lý của sự kiện có tồn tại không — căn cứ kết luận
   * "trùng" của processor. Đọc cả ở lối tắt trước khi chiếm lease
   * lẫn bên trong lease (lần đọc trong lease mới là lần có thẩm
   * quyền).
   *
   * @param outboxId Id dòng outbox của sự kiện.
   * @returns true khi sự kiện đã được xử lý xong ở một lượt trước.
   */
  async hasProcessed(outboxId: string): Promise<boolean> {
    return (await this.redis.get(`${PROCESSED_KEY_PREFIX}${outboxId}`)) !== null;
  }

  /**
   * Chiếm lease "đang xử lý" cho sự kiện bằng SET NX nguyên tử.
   *
   * @param outboxId Id dòng outbox của sự kiện.
   * @returns Token của lease khi chiếm được; null khi một lượt chạy
   * khác đang giữ lease chưa hết hạn.
   */
  async claimProcessing(outboxId: string): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(
      `${PROCESSING_KEY_PREFIX}${outboxId}`,
      token,
      'EX',
      PROCESSING_TTL_SECONDS,
      'NX',
    );
    return result === 'OK' ? token : null;
  }

  /**
   * Ghi dấu đã xử lý cho sự kiện — processor chỉ gọi sau khi
   * handler đã xử lý xong; đây là điểm duy nhất dấu được ghi.
   *
   * @param outboxId Id dòng outbox của sự kiện.
   */
  async markProcessed(outboxId: string): Promise<void> {
    await this.redis.set(`${PROCESSED_KEY_PREFIX}${outboxId}`, '1', 'EX', PROCESSED_TTL_SECONDS);
  }

  /**
   * Nhả lease đang giữ — chỉ xoá khi token trong Redis vẫn là
   * token của lượt chạy này (so khớp nguyên tử bằng script Lua,
   * khuôn của BullMQ cho các thao tác kiểm-tra-rồi-xoá trên Redis).
   * Lease đã hết hạn hoặc đã thuộc lượt khác thì thao tác là no-op.
   *
   * @param outboxId Id dòng outbox của sự kiện.
   * @param token Token do {@link claimProcessing} cấp cho lượt này.
   */
  async releaseProcessing(outboxId: string, token: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      `${PROCESSING_KEY_PREFIX}${outboxId}`,
      token,
    );
  }
}
