import { Injectable } from '@nestjs/common';
import {
  type SharedOutboxEventInput,
  type SharedOutboxPort,
} from '@lms/enrol';
import { sql, type CentreDB, type CentreTx } from '@lms/db';
import { SpaceDatabaseService } from './db/routing/space-database.service';

/**
 * Cổng ghi outbox phía worker cho bề mặt vật chất hoá cohort dùng
 * chung (`@lms/enrol`).
 *
 * Cổng này ghi trực tiếp bằng Kysely với ĐÚNG ngữ nghĩa của
 * `OutboxWriterService` — tenant CHỈ lấy từ tham số tường minh của
 * nơi gọi, không lấy từ ALS (các lời gọi outbox của bề mặt enrol
 * không mang `tenantId` tường minh nên dòng ghi mang `tenantId`
 * null — ĐÚNG hành vi hiện hành của nhịp matching phía API,
 * consumer `setInterval` chạy ngoài mọi request nên ALS luôn rỗng;
 * relay và các consumer đã xử lý các sự kiện enrol mang tenant null
 * này từ trước, không có gì thay đổi ở đây); tenant được gương vào
 * payload khi payload chưa có khoá `tenantId`.
 *
 * Mọi luồng ghi của worker (bề mặt enrol và các luồng thanh toán
 * trả phí: kích hoạt ghi danh lớp, đối soát thanh toán) đều mở
 * transaction Kysely và ghi qua cổng `enqueue` trên chính
 * transaction đó — hợp đồng duy nhất của cổng này.
 */
@Injectable()
export class WorkerEnrolOutboxService implements SharedOutboxPort {
  constructor(private readonly spaceDb: SpaceDatabaseService) {}

  /**
   * Ghi sự kiện trong transaction Kysely nghiệp vụ đang mở.
   *
   * @param tx - transaction Kysely của nơi gọi.
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
}
