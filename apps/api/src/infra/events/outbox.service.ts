import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../../db/database';
import { outboxEvents } from '../../db/schema';
import { tenantAls } from '../../modules/tenants/tenant-als';

export interface OutboxEventInput {
  aggregate: string;
  type: string;
  payload: Record<string, unknown>;
  /** Tenant của ngữ cảnh phát sinh sự kiện (TENANT-0, #168); bỏ trống = platform/không gian chung. */
  tenantId?: string | null;
}

/** The minimal transaction surface OutboxService needs (a Drizzle tx). */
export interface OutboxTx {
  insert: Database['insert'];
}

/**
 * Transactional outbox (self-built, ADR-004): the event row is written in the
 * SAME database transaction as the business change. If the transaction rolls
 * back, no event row exists and nothing can ever be published.
 */
@Injectable()
export class OutboxService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async enqueue(tx: OutboxTx, input: OutboxEventInput): Promise<void> {
    // TENANT-1 (#196): tenant hiệu lực mặc định lấy từ ngữ cảnh ALS
    // của luồng phát sinh (request tenant / job đã bọc) khi nơi gọi
    // không chỉ định tường minh; tenant cũng được GƯƠNG vào payload
    // để các consumer chạy ở ngữ cảnh platform (relay, consumer
    // thông báo/digest) biết sự kiện thuộc tenant nào mà gắn đúng
    // tenant cho dữ liệu chúng tạo ra.
    const tenantId = input.tenantId ?? tenantAls.getStore()?.tenantId ?? null;
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

  /** Convenience: enqueue in its own short transaction. */
  async enqueueStandalone(input: OutboxEventInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.enqueue(tx as OutboxTx, input);
    });
  }
}
