import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql, type CentreDB, type CentreTx } from '@lms/db';
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

  /**
   * Phân giải tenant hiệu lực và payload sẽ ghi cho một sự kiện:
   * TENANT-1 (#196): tenant hiệu lực mặc định lấy từ ngữ cảnh ALS
   * của luồng phát sinh (request tenant / job đã bọc) khi nơi gọi
   * không chỉ định tường minh; tenant cũng được GƯƠNG vào payload
   * để các consumer chạy ở ngữ cảnh platform (relay, consumer
   * thông báo/digest) biết sự kiện thuộc tenant nào mà gắn đúng
   * tenant cho dữ liệu chúng tạo ra. Cả hai đường ghi (Drizzle và
   * Kysely) dùng chung bước này để hình dạng dòng sự kiện không
   * lệch nhau theo ORM của nơi gọi.
   */
  private resolveTenantPayload(input: OutboxEventInput): { tenantId: string | null; payload: Record<string, unknown> } {
    const tenantId = input.tenantId ?? tenantAls.getStore()?.tenantId ?? null;
    const payload = tenantId && input.payload['tenantId'] === undefined
      ? { ...input.payload, tenantId }
      : input.payload;
    return { tenantId, payload };
  }

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
   * Biến thể Kysely của `enqueue`: ghi dòng sự kiện trong một
   * transaction Kysely đang mở — điểm ghép cho các nơi gọi đã
   * chuyển sang Kysely (đầu tiên là cụm người dùng, issue #641)
   * mà bất biến "thay đổi nghiệp vụ + dòng sự kiện cùng
   * thành/bại" vẫn phải giữ nguyên: TUYỆT ĐỐI không được tách
   * hai nửa sang hai transaction của hai ORM (giao dịch lai bị
   * cấm trong toàn chiến dịch chuyển đổi). Biến thể này chỉ là
   * điểm ghép tối thiểu đi kèm nơi gọi đã chuyển; việc chuyển
   * đổi toàn bộ OutboxService thuộc hạng mục hạ tầng sự kiện
   * (D1, issue #653) — khi đó nơi gọi Drizzle cuối cùng biến mất
   * thì biến thể Drizzle ở trên được gỡ.
   *
   * Payload đi qua helper serialize + ép kiểu `::jsonb` tường
   * minh như mọi đường ghi jsonb khác của chiến dịch: cột
   * `payload` mang kiểu sinh `Json` nên giá trị object thô không
   * khớp kiểu biểu thức ghi, và việc serialize tường minh giữ
   * hành vi không phụ thuộc mặc định của driver `pg` (đặc biệt
   * mảng ở cấp cao nhất bị driver hiểu là mảng PostgreSQL).
   */
  async enqueueKysely(tx: CentreTx, input: OutboxEventInput): Promise<void> {
    const { tenantId, payload } = this.resolveTenantPayload(input);
    await tx
      .insertInto('outbox_events')
      .values({
        aggregate: input.aggregate,
        type: input.type,
        payload: sql<CentreDB['outbox_events']['payload']>`${JSON.stringify(payload)}::jsonb`,
        tenant_id: tenantId,
      })
      .execute();
  }

  /** Hàm tiện ích: đưa vào hàng đợi trong một transaction ngắn riêng. */
  async enqueueStandalone(input: OutboxEventInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.enqueue(tx as OutboxTx, input);
    });
  }
}
