import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { tenantAls } from '../db/tenant-als';
import type { OutboxEventJobData } from '../outbox-event-routes';
import { NotificationEventsMarker } from '../notification-events-marker.service';
import {
  NOTIFICATION_EVENT_TYPES,
  NotificationEventsHandlerService,
} from '../notification-events-handler.service';

/** Thời gian hoãn một job khi sự kiện của nó đang được một lượt chạy khác xử lý. */
const PROCESSING_LEASE_RETRY_DELAY_MS = 5_000;

/**
 * Consumer phía worker của mười sự kiện thông báo nghiệp vụ (issue
 * con #520 của #491), thay consumer polling phía API trước đây.
 *
 * @remarks
 * Flow: relay outbox duy nhất phát job vào hàng đợi
 * `notification-events` với `jobId` bằng `outboxId`; processor này
 * chạy toàn bộ job trong ngữ cảnh platform (handler tự gắn tenant
 * tường minh cho từng thông báo), chống trùng theo `outboxId` bằng
 * {@link NotificationEventsMarker}, rồi uỷ xử lý nghiệp vụ cho
 * {@link NotificationEventsHandlerService}.
 *
 * Trình tự chống trùng là bất biến của consumer:
 * 1. Đọc nhanh dấu đã xử lý: có dấu thì hoàn thành với
 *    `duplicate: true`, không gọi handler.
 * 2. Chiếm lease đang xử lý bằng token riêng. Không chiếm được
 *    nghĩa là một lượt chạy khác đang xử lý cùng sự kiện: job
 *    được hoãn 5 giây bằng `moveToDelayed` và ném `DelayedError`
 *    theo đúng pattern BullMQ — lượt hoãn không bị tính là một
 *    lần thử thất bại và tuyệt đối không hoàn thành như thể đã
 *    xử lý.
 * 3. Bên trong lease, đọc LẠI dấu đã xử lý. Lần đọc này mới có
 *    thẩm quyền: nó bịt cửa sổ mà lượt chạy bị giữ sau lần đọc
 *    nhanh trong lúc một lượt khác xử lý xong, ghi dấu và nhả
 *    lease.
 * 4. Chỉ khi lần đọc lại vẫn chưa có dấu, handler mới chạy. Dấu
 *    đã xử lý được ghi sau khi handler hoàn thành, rồi lease
 *    được nhả bằng chính token của lượt chạy.
 *
 * Ngữ nghĩa lỗi khác consumer digest và khác consumer polling cũ
 * có chủ đích: handler ném lỗi thì processor nhả lease và ném lại
 * lỗi để BullMQ thử lại theo cấu hình hàng đợi. Thông báo không có
 * một dòng nghiệp vụ bền đóng vai trò điểm kiểm tra hoàn thành
 * như lượt digest, nên nuốt lỗi tại đây sẽ làm mất sự kiện lặng
 * lẽ; ngược lại polling cũ nuốt lỗi nhưng watermark vẫn dừng ở sự
 * kiện lỗi và thử lại ở nhịp sau. Hàng đợi giữ tính ít-nhất-một-
 * lần mà không chặn các sự kiện khác.
 *
 * Giới hạn còn lại được ghi rõ: nếu tiến trình sập sau khi handler
 * đã tạo một phần thông báo nhưng trước khi ghi dấu đã xử lý, lần
 * thử lại có thể tạo trùng ở phần chưa được các handler kiểu gộp
 * hợp nhất theo bản chưa đọc. Đây là hệ quả của phát ít-nhất-một-
 * lần khi đường tạo thông báo chưa có khoá chống trùng bền theo
 * từng người nhận; dấu theo `outboxId` bịt mọi phát lại thông
 * thường (relay phát lại, BullMQ thử lại sau lỗi, job bị chạy lại)
 * vốn là phạm vi chống trùng của issue này.
 */
@Processor('notification-events')
export class NotificationEventsProcessor extends WorkerHost {
  constructor(
    private readonly handler: NotificationEventsHandlerService,
    private readonly marker: NotificationEventsMarker,
  ) {
    super();
  }

  /**
   * Xử lý một job sự kiện thông báo.
   *
   * @param job Job do relay phát, dữ liệu là dòng outbox đã chuẩn hoá.
   * @param token Token khoá job do BullMQ cấp cho lượt xử lý, dùng
   * khi hoãn job trong lúc lease của sự kiện đang bị lượt khác giữ.
   * @returns `handled: true` khi handler đã xử lý; kèm
   * `duplicate: true` khi sự kiện được kết luận là phát lại và
   * handler không chạy; `handled: false` với loại sự kiện lạ.
   * @throws {DelayedError} Khi lease đang bị giữ và job đã được
   * hoãn để BullMQ phát lại sau.
   * @throws Lỗi của handler hoặc hạ tầng chống trùng được truyền ra
   * để BullMQ thử lại job.
   */
  async process(
    job: Job<OutboxEventJobData>,
    token?: string,
  ): Promise<{ handled: boolean; duplicate?: boolean }> {
    return tenantAls.run({ platform: true }, async () => {
      const { outboxId, type, payload } = job.data;
      if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type)) {
        return { handled: false };
      }

      if (await this.marker.hasProcessed(outboxId)) {
        return { handled: true, duplicate: true };
      }

      const leaseToken = await this.marker.claimProcessing(outboxId);
      if (leaseToken === null) {
        await job.moveToDelayed(Date.now() + PROCESSING_LEASE_RETRY_DELAY_MS, token);
        throw new DelayedError();
      }

      try {
        // Đọc lại dấu bên trong lease: lượt chạy khác có thể đã
        // hoàn thành sự kiện trong khoảng giữa lần đọc nhanh và
        // lần chiếm lease của lượt này.
        if (await this.marker.hasProcessed(outboxId)) {
          await this.marker.releaseProcessing(outboxId, leaseToken);
          return { handled: true, duplicate: true };
        }

        await this.handler.handle(type, payload ?? {});
        await this.marker.markProcessed(outboxId);
        await this.marker.releaseProcessing(outboxId, leaseToken);
        return { handled: true };
      } catch (error) {
        await this.marker.releaseProcessing(outboxId, leaseToken).catch(() => undefined);
        throw error;
      }
    });
  }
}
