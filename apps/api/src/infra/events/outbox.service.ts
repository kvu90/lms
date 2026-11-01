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
   * Phân giải tenant hiệu lực và payload của một sự kiện — nhà duy
   * nhất của luật này cho MỌI đường ghi outbox (Drizzle, Kysely và
   * standalone), để các đường không bao giờ lệch nhau.
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
   * Biến thể phía Kysely của `enqueue` — ĐIỂM NỐI C-8/A của chiến
   * dịch chuyển tầng dữ liệu sang Kysely (xem `CORRECTIONS.md` của
   * chiến dịch, mục C-8): cùng bảng `outbox_events`, cùng hình
   * dạng dòng và cùng cơ chế suy tenant/gương tenant vào payload
   * như bản Drizzle (bản Drizzle là đặc tả), chỉ khác handle
   * transaction — biến thể này nhận transaction Kysely của kho
   * trung tâm cho các luồng đã chuyển điểm mở giao dịch sang
   * Kysely (đợt đầu là cụm courses/classes/enrol/groups, issue
   * #645). Chủ hấp thụ: D1 (#653) — khi chuyển OutboxService sang
   * Kysely, PR đó hợp nhất hai đường ghi thành một và xoá biến
   * thể này; issue #663 đối chiếu không còn sót.
   *
   * Hội tụ với PR #672 (issue #647): PR đó độc lập thêm đúng biến
   * thể này với cùng tên, cùng chữ ký và cùng khâu phân giải
   * tenant/payload dùng chung. PR nào trong {#672, #645} merge
   * trước thì mang biến thể vào; PR merge sau chỉ bỏ phần trùng
   * và tái sử dụng — không tồn tại hai biến thể song song.
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
