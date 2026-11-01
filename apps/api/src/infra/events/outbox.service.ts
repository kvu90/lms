import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql, type CentreTx } from '@lms/db';
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

/** Bề mặt transaction tối thiểu mà OutboxService cần (một tx của Drizzle). */
export interface OutboxTx {
  insert: Database['insert'];
}

/**
 * Outbox giao dịch (tự dựng): dòng sự kiện được ghi trong CÙNG
 * transaction cơ sở dữ liệu với thay đổi nghiệp vụ. Nếu transaction bị rollback
 * thì không tồn tại dòng sự kiện nào và không gì có thể được phát đi.
 */
@Injectable()
export class OutboxService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async enqueue(tx: OutboxTx, input: OutboxEventInput): Promise<void> {
    const { tenantId, payload } = this.resolveTenantPayload(input);
    await tx.insert(outboxEvents).values({
      aggregate: input.aggregate,
      type: input.type,
      payload,
      tenantId,
    });
  }

  /**
   * Đường ghi outbox trên một transaction KYSELY — điểm nối cho các
   * module đã chuyển sang Kysely trong chiến dịch chuyển tầng dữ
   * liệu (điểm đầu tiên: module competencies, issue #646). Ngữ
   * nghĩa giữ nguyên như {@link enqueue}: sự kiện ghi trong CÙNG
   * transaction nghiệp vụ của phía gọi (không mở transaction thứ
   * hai, không lai hai ORM trên hai kết nối), tenant hiệu lực và
   * gương tenant vào payload tính bằng cùng một hàm phân giải.
   * Cột `payload` là jsonb nên giá trị đi qua serialize tường minh
   * + ép kiểu `::jsonb` như khuôn ghi jsonb của các repository
   * Kysely. Khi hạng mục hạ tầng sự kiện (D1) chuyển đổi, hai đường
   * ghi hợp nhất về đường này.
   *
   * @param tx - Transaction Kysely đang mở của phía gọi.
   * @param input - Sự kiện cần ghi.
   */
  async enqueueKysely(tx: CentreTx, input: OutboxEventInput): Promise<void> {
    const { tenantId, payload } = this.resolveTenantPayload(input);
    await tx
      .insertInto('outbox_events')
      .values({
        aggregate: input.aggregate,
        type: input.type,
        payload: sql`${JSON.stringify(payload)}::jsonb`,
        tenant_id: tenantId,
      })
      .execute();
  }

  /**
   * Phân giải tenant hiệu lực + payload sẽ ghi cho một sự kiện.
   *
   * TENANT-1 (#196): tenant hiệu lực mặc định lấy từ ngữ cảnh ALS
   * của luồng phát sinh (request tenant / job đã bọc) khi nơi gọi
   * không chỉ định tường minh; tenant cũng được GƯƠNG vào payload
   * để các consumer chạy ở ngữ cảnh platform (relay, consumer
   * thông báo/digest) biết sự kiện thuộc tenant nào mà gắn đúng
   * tenant cho dữ liệu chúng tạo ra.
   */
  private resolveTenantPayload(input: OutboxEventInput): { tenantId: string | null; payload: Record<string, unknown> } {
    const tenantId = input.tenantId ?? tenantAls.getStore()?.tenantId ?? null;
    const payload = tenantId && input.payload['tenantId'] === undefined
      ? { ...input.payload, tenantId }
      : input.payload;
    return { tenantId, payload };
  }

  /** Hàm tiện ích: đưa vào hàng đợi trong một transaction ngắn riêng. */
  async enqueueStandalone(input: OutboxEventInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.enqueue(tx as OutboxTx, input);
    });
  }
}
