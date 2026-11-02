import { Injectable } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  type SharedOutboxEventInput,
  type SharedOutboxPort,
} from '@lms/enrol';
import { outboxEvents, sql, type CentreDB, type CentreTx } from '@lms/db';
import { SpaceDatabaseService } from './db/routing/space-database.service';
import type { relations } from './db/relations';

type Database = NodePgDatabase<typeof relations>;

/**
 * Transaction Drizzle mà các luồng thanh toán trả phí của worker
 * đang mở — cùng khuôn suy kiểu với cầu nối thanh toán chuyển
 * tiếp (`worker-payments-transitional.repository.ts`).
 */
type WorkerTx = Parameters<Parameters<Database['transaction']>[0]>[0];

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
 * Đường Drizzle còn lại dưới tên `enqueueInDrizzleTx` cho các
 * luồng thanh toán trả phí (kích hoạt ghi danh lớp, đối soát thanh
 * toán) — các luồng đó vẫn mở MỘT transaction Drizzle cho cả ghi
 * danh và hai dòng outbox (bất biến đã chốt ở phán quyết trên PR
 * #552), và chỉ chuyển sang làn Kysely ở W2b #661. Từ PR #683
 * (D4), đường này KHÔNG còn uỷ thác cho `OutboxWriterService` của
 * `@lms/payments` nữa: writer đó nay đã Kysely-only
 * (`tx.insertInto(…)`), trong khi nơi gọi cổng này truyền
 * transaction Drizzle đang mở — ghi qua writer sẽ gãy ở runtime vì
 * transaction Drizzle không có `insertInto`.
 * `enqueueInDrizzleTx` vì vậy tự ghi dòng outbox trên chính
 * transaction Drizzle nhận được, với ngữ nghĩa `enqueue` VERBATIM
 * từ bản Drizzle gốc của `OutboxWriterService` (trước PR #683):
 * cùng khuôn dòng (aggregate, type, payload, tenant_id), tenant
 * chỉ lấy từ tham số tường minh của nơi gọi, và gương `tenantId`
 * vào payload khi payload chưa có khoá đó.
 *
 * Chủ đóng của đường Drizzle: W2b #661. Khi #661 lật các
 * transaction của worker sang Kysely thì `enqueueInDrizzleTx` bị
 * xoá và các nơi gọi quay về cổng Kysely của cổng này; issue #663
 * đối chiếu không còn sót.
 */
@Injectable()
export class WorkerEnrolOutboxService implements SharedOutboxPort {
  constructor(private readonly spaceDb: SpaceDatabaseService) {}

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
   * thanh toán trả phí (điểm nối chuyển tiếp, chủ đóng W2b #661):
   * tự ghi trực tiếp trên transaction nhận được theo ngữ nghĩa
   * Drizzle gốc của `OutboxWriterService` (xem docblock của lớp về
   * lý do không uỷ thác qua writer Kysely-only từ PR #683).
   *
   * @param tx - transaction Drizzle của nơi gọi (luồng thanh toán).
   * @param input - sự kiện cần ghi.
   */
  async enqueueInDrizzleTx(tx: WorkerTx, input: SharedOutboxEventInput): Promise<void> {
    const tenantId = input.tenantId ?? null;
    const payload = tenantId && input.payload['tenantId'] === undefined
      ? { ...input.payload, tenantId }
      : input.payload;
    await tx.insert(outboxEvents).values({
      aggregate: input.aggregate,
      type: input.type,
      payload,
      tenantId,
    });
  }
}
