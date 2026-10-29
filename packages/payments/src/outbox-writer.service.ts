import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { outboxEvents } from '@lms/db';
import type { Database } from './database';

/** Một sự kiện outbox cần phát: aggregate, loại sự kiện và payload. */
export interface OutboxEventInput {
  aggregate: string;
  type: string;
  payload: Record<string, unknown>;
  /** Tenant của ngữ cảnh phát sinh sự kiện; bỏ trống = platform/không gian chung. */
  tenantId?: string | null;
}

/** Bề mặt transaction tối thiểu mà OutboxWriterService cần (một tx của Drizzle). */
export interface OutboxTx {
  insert: Database['insert'];
}

/**
 * Bề mặt phát outbox dùng chung của package `@lms/payments` (issue
 * #538): ghi dòng sự kiện vào bảng `outbox_events` dùng chung với
 * ĐÚNG khuôn dòng của `OutboxService` phía apps/api (aggregate, type,
 * payload, tenant_id; tenant được gương vào payload khi payload chưa
 * có khoá `tenantId`, để các consumer chạy ở ngữ cảnh platform biết
 * sự kiện thuộc tenant nào).
 *
 * Vì sao bề mặt này tồn tại cạnh `OutboxService` của apps/api: các
 * luồng của package (matching IPN SePay) phải chạy được ở cả tiến
 * trình API lẫn tiến trình worker, mà `OutboxService` của apps/api
 * còn một hành vi riêng của tiến trình API — tenant hiệu lực mặc
 * định lấy từ ngữ cảnh ALS của request (`tenantAls`). Ngữ cảnh chạy
 * của matching (consumer theo nhịp trong API; điểm quét ở worker ở
 * issue con tiếp theo của #522) không nằm trong request nào nên
 * store ALS luôn rỗng và mặc định đó luôn cho kết quả null; bề mặt
 * này vì vậy lấy tenant CHỈ từ tham số tường minh của nơi gọi, cho
 * cùng kết quả ghi ở mọi ngữ cảnh matching. Các luồng nghiệp vụ khác
 * của apps/api (phát sự kiện trong transaction của request) vẫn dùng
 * `OutboxService` của apps/api như cũ — bề mặt này chỉ phục vụ các
 * service của package.
 */
@Injectable()
export class OutboxWriterService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /**
   * Ghi một dòng sự kiện trong transaction `tx` do nơi gọi mở — nếu
   * transaction bị rollback thì không tồn tại dòng sự kiện nào và
   * không gì có thể được phát đi (khuôn outbox giao dịch).
   */
  async enqueue(tx: OutboxTx, input: OutboxEventInput): Promise<void> {
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

  /** Hàm tiện ích: phát sự kiện trong một transaction ngắn riêng. */
  async enqueueStandalone(input: OutboxEventInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.enqueue(tx as OutboxTx, input);
    });
  }
}
