import { Injectable } from '@nestjs/common';
import { sql, type CentreDb, type CentreDB, type CentreTx } from '@lms/db';
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

/** Bề mặt transaction tối thiểu mà đường ghi Drizzle chuyển tiếp cần (một tx của Drizzle). */
export interface OutboxTx {
  insert: Database['insert'];
}

/**
 * Outbox giao dịch (tự dựng): dòng sự kiện được ghi trong CÙNG
 * transaction cơ sở dữ liệu với thay đổi nghiệp vụ. Nếu transaction bị rollback
 * thì không tồn tại dòng sự kiện nào và không gì có thể được phát đi.
 *
 * Trạng thái sau chuyển đổi Kysely (D1, issue #653): handle riêng
 * của service là handle Kysely kho trung tâm (`CentreDb` — ở tầng
 * ứng dụng là facade định tuyến theo không gian), và đường ghi
 * chuẩn là {@link OutboxService.enqueueKysely}. Đường ghi Drizzle
 * {@link OutboxService.enqueue} còn giữ dạng CHUYỂN TIẾP cho các
 * phía gọi vẫn mở transaction Drizzle; nó chỉ được gỡ khi điểm gọi
 * Drizzle cuối cùng đã chuyển sang Kysely (hạng mục gỡ Drizzle
 * cuối chiến dịch đối chiếu điểm này không còn tồn tại).
 */
@Injectable()
export class OutboxService {
  constructor(private readonly db: CentreDb) {}

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

  /**
   * Đường ghi Drizzle CHUYỂN TIẾP: ghi dòng sự kiện bằng chính
   * transaction Drizzle của phía gọi, cho các module chưa chuyển
   * sang Kysely. Cùng bảng `outbox_events`, cùng hình dạng dòng và
   * cùng khâu phân giải tenant/payload với đường Kysely chuẩn
   * ({@link OutboxService.enqueueKysely}) — bản Kysely là đặc tả
   * đích. Điều kiện gỡ: điểm gọi Drizzle cuối cùng chuyển sang
   * Kysely thì phương thức này và kiểu {@link OutboxTx} bị xoá;
   * hạng mục gỡ Drizzle cuối chiến dịch đối chiếu.
   */
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
   * Đường ghi outbox chuẩn qua handle Kysely: dòng sự kiện được
   * ghi trong CÙNG transaction Kysely với thay đổi nghiệp vụ của
   * nơi gọi — cùng bất biến giao dịch với {@link enqueue}. Đây là
   * điểm nối A của phán quyết C-8 đã được hợp nhất tại D1 (issue
   * #653): biến thể do các cụm đã chuyển (G7 #647 đưa vào, G5 #645
   * tái sử dụng) nay là đường ghi chuẩn của service đã chuyển đổi;
   * chữ ký `enqueueKysely(tx: CentreTx, input)` giữ nguyên để mọi
   * phía gọi phía Kysely không đổi hợp đồng. Cột `payload` jsonb
   * đi qua serialize tường minh kèm `::jsonb` theo khuôn ghi jsonb
   * của `@lms/db`: driver `pg` tự stringify object thường nhưng
   * hiểu MẢNG cấp cao nhất là mảng PostgreSQL.
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

  /** Hàm tiện ích: đưa vào hàng đợi trong một transaction Kysely ngắn riêng trên handle của service. */
  async enqueueStandalone(input: OutboxEventInput): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.enqueueKysely(tx, input);
    });
  }
}
