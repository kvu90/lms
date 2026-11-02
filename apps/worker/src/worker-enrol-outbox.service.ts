import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { outboxEvents } from '@lms/db';
import type { SharedOutboxEventInput, SharedOutboxPort, SharedOutboxTx } from '@lms/enrol';
import type { relations } from './db/relations';

type Database = NodePgDatabase<typeof relations>;

/**
 * Cổng ghi outbox phía worker cho bề mặt vật chất hoá cohort dùng
 * chung (`@lms/enrol`) — ĐIỂM NỐI của chiến dịch chuyển Kysely
 * trong PR #683 (D4).
 *
 * Vì sao không uỷ thác cho `OutboxWriterService` của `@lms/payments`
 * nữa: writer đó từ PR này đã Kysely-only (`tx.insertInto(…)`),
 * trong khi mọi nơi gọi cổng này (khâu settle hoàn tiền, kích hoạt
 * ghi danh cấp lớp) đều truyền transaction Drizzle đang mở — ghi
 * qua writer sẽ gãy ở runtime vì transaction Drizzle không có
 * `insertInto`. File này vì vậy tự ghi dòng outbox trên chính
 * transaction Drizzle nhận được, với ngữ nghĩa `enqueue` VERBATIM
 * từ bản Drizzle gốc của `OutboxWriterService` (main, trước PR
 * #683): cùng khuôn dòng (aggregate, type, payload, tenant_id),
 * tenant chỉ lấy từ tham số tường minh của nơi gọi, và gương
 * `tenantId` vào payload khi payload chưa có khoá đó.
 *
 * Tenant mang `null` khi nơi gọi không chỉ định: ĐÚNG hành vi hiện
 * hành của các luồng worker này (các luồng chạy ngoài mọi request
 * nên không có ngữ cảnh ALS để lấy tenant; relay và các consumer
 * đã xử lý các sự kiện enrol mang tenant null này từ trước, không
 * có gì thay đổi ở đây).
 *
 * Chủ đóng: W2b #661. Khi #661 lật các transaction của worker sang
 * Kysely thì cổng này quay lại uỷ thác cho writer Kysely của
 * `@lms/payments` (hoặc bị xoá nếu cổng outbox dùng chung đã bao
 * được các nơi gọi); issue #663 đối chiếu không còn sót.
 */
@Injectable()
export class WorkerEnrolOutboxService implements SharedOutboxPort {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /**
   * Ghi sự kiện trong transaction nghiệp vụ đang mở.
   *
   * @param tx - transaction Drizzle của nơi gọi (bề mặt enrol).
   * @param input - sự kiện cần ghi.
   */
  async enqueue(tx: SharedOutboxTx, input: SharedOutboxEventInput): Promise<void> {
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

  /**
   * Ghi sự kiện trong một transaction ngắn riêng (transaction
   * Drizzle, như bản gốc — không mở transaction Kysely).
   *
   * @param input - sự kiện cần ghi.
   */
  async enqueueStandalone(input: SharedOutboxEventInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.enqueue(tx, input);
    });
  }
}
