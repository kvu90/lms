import { Injectable } from '@nestjs/common';
import type { SharedOutboxEventInput, SharedOutboxPort, SharedOutboxTx } from '@lms/enrol';
import { OutboxWriterService } from '@lms/payments';

/**
 * Cổng ghi outbox phía worker cho bề mặt vật chất hoá cohort dùng
 * chung (`@lms/enrol`): uỷ thác thẳng cho `OutboxWriterService`
 * của `@lms/payments` — cùng khuôn dòng với `OutboxService` phía
 * API (aggregate, type, payload, tenant_id; tenant được gương vào
 * payload khi payload chưa có khoá `tenantId`).
 *
 * Vì sao dùng writer của `@lms/payments` thay vì một writer riêng:
 * bề mặt matching dùng chung đã cần đúng writer này cho sự kiện
 * `payment_succeeded`, và writer này được thiết kế cho các luồng
 * không nằm trong request — tenant chỉ lấy từ tham số tường minh
 * của nơi gọi, không lấy từ ALS. Các lời gọi outbox của bề mặt
 * enrol không mang `tenantId` tường minh nên dòng ghi mang
 * `tenantId` null — ĐÚNG hành vi hiện hành của nhịp matching phía
 * API (consumer `setInterval` chạy ngoài mọi request nên ALS luôn
 * rỗng): relay và các consumer đã xử lý các sự kiện enrol mang
 * tenant null này từ trước, không có gì thay đổi ở đây.
 */
@Injectable()
export class WorkerEnrolOutboxService implements SharedOutboxPort {
  constructor(private readonly writer: OutboxWriterService) {}

  /**
   * Ghi sự kiện trong transaction nghiệp vụ đang mở.
   *
   * @param tx - transaction Drizzle của nơi gọi (bề mặt enrol).
   * @param input - sự kiện cần ghi.
   */
  async enqueue(tx: SharedOutboxTx, input: SharedOutboxEventInput): Promise<void> {
    await this.writer.enqueue(tx, input);
  }

  /**
   * Ghi sự kiện trong một transaction ngắn riêng.
   *
   * @param input - sự kiện cần ghi.
   */
  async enqueueStandalone(input: SharedOutboxEventInput): Promise<void> {
    await this.writer.enqueueStandalone(input);
  }
}
