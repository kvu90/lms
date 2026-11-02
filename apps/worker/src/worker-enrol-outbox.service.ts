import { Injectable } from '@nestjs/common';
import {
  type SharedOutboxEventInput,
  type SharedOutboxPort,
} from '@lms/enrol';
import { sql, type CentreDB, type CentreTx } from '@lms/db';
import { OutboxWriterService, type OutboxTx } from '@lms/payments';
import { SpaceDatabaseService } from './db/routing/space-database.service';

/**
 * Cổng ghi outbox phía worker cho bề mặt vật chất hoá cohort dùng
 * chung (`@lms/enrol`).
 *
 * Đường Kysely (`enqueue`/`enqueueStandalone`) là cổng của bề mặt
 * từ D5 #657: ghi trực tiếp bằng Kysely với ĐÚNG ngữ nghĩa của
 * `OutboxWriterService` — tenant CHỈ lấy từ tham số tường minh của
 * nơi gọi, không lấy từ ALS (các lời gọi outbox của bề mặt enrol
 * không mang `tenantId` tường minh nên dòng ghi mang `tenantId`
 * null — ĐÚNG hành vi hiện hành của nhịp matching phía API,
 * consumer `setInterval` chạy ngoài mọi request nên ALS luôn rỗng;
 * relay và các consumer đã xử lý các sự kiện enrol mang tenant null
 * này từ trước, không có gì thay đổi ở đây); tenant được gương vào
 * payload khi payload chưa có khoá `tenantId`.
 *
 * Đường Drizzle cũ còn giữ lại dưới tên `enqueueInDrizzleTx` cho
 * các luồng thanh toán trả phí (kích hoạt ghi danh lớp, đối soát
 * thanh toán) — các luồng đó vẫn mở MỘT transaction Drizzle cho cả
 * ghi danh và hai dòng outbox (bất biến đã chốt ở phán quyết trên
 * PR #552), và chỉ chuyển sang làn Kysely ở W2b #661. Đường này
 * uỷ thác thẳng cho `OutboxWriterService.enqueue` như trước, không
 * đổi ngữ nghĩa.
 */
@Injectable()
export class WorkerEnrolOutboxService implements SharedOutboxPort {
  constructor(
    private readonly writer: OutboxWriterService,
    private readonly spaceDb: SpaceDatabaseService,
  ) {}

  /**
   * Ghi sự kiện trong transaction Kysely nghiệp vụ đang mở (đường
   * của bề mặt enrol từ D5).
   *
   * @param tx - transaction Kysely của nơi gọi (bề mặt enrol).
   * @param input - sự kiện cần ghi.
   */
  async enqueue(tx: CentreTx, input: SharedOutboxEventInput): Promise<void> {
    const tenantId = input.tenantId ?? null;
    const payload = tenantId && input.payload['tenantId'] === undefined
      ? { ...input.payload, tenantId }
      : input.payload;
    await tx
      .insertInto('outbox_events')
      .values({
        aggregate: input.aggregate,
        type: input.type,
        // Cột `payload` jsonb đi qua serialize tường minh kèm
        // `::jsonb` theo khuôn ghi jsonb của `@lms/db` (xem cổng
        // outbox của worker trong `cohort-sync.service.ts`).
        payload: sql<CentreDB['outbox_events']['payload']>`${JSON.stringify(payload)}::jsonb`,
        tenant_id: tenantId,
      })
      .execute();
  }

  /**
   * Ghi sự kiện trong một transaction Kysely ngắn riêng.
   *
   * @param input - sự kiện cần ghi.
   */
  async enqueueStandalone(input: SharedOutboxEventInput): Promise<void> {
    await this.spaceDb.routedKysely.transaction().execute((trx) => this.enqueue(trx, input));
  }

  /**
   * Ghi sự kiện trong transaction Drizzle đang mở của các luồng
   * thanh toán trả phí (điểm nối chuyển tiếp, chủ đóng W2b #661).
   *
   * @param tx - transaction Drizzle của nơi gọi (luồng thanh toán).
   * @param input - sự kiện cần ghi.
   */
  async enqueueInDrizzleTx(tx: OutboxTx, input: SharedOutboxEventInput): Promise<void> {
    await this.writer.enqueue(tx, input);
  }
}
