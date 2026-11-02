import { Injectable } from '@nestjs/common';
import { sql, type CentreDb, type CentreDB, type CentreTx } from '@lms/db';
import { tenantAls } from '../../modules/tenants/tenant-als';

export interface OutboxEventInput {
  aggregate: string;
  type: string;
  payload: Record<string, unknown>;
  /** Tenant của ngữ cảnh phát sinh sự kiện (TENANT-0, #168); bỏ trống = platform/không gian chung. */
  tenantId?: string | null;
}

/**
 * Outbox giao dịch (tự dựng): dòng sự kiện được ghi trong CÙNG
 * transaction cơ sở dữ liệu với thay đổi nghiệp vụ. Nếu transaction bị rollback
 * thì không tồn tại dòng sự kiện nào và không gì có thể được phát đi.
 *
 * Handle của service là handle Kysely kho trung tâm (`CentreDb` —
 * ở tầng ứng dụng là facade định tuyến theo không gian), và đường
 * ghi duy nhất là {@link OutboxService.enqueueKysely} trong
 * transaction Kysely của phía gọi (điểm nối A của phán quyết C-8,
 * hợp nhất tại D1 issue #653; đường ghi bộ máy cũ chuyển tiếp đã xoá
 * ở issue #663 khi điểm gọi bộ máy cũ cuối cùng — ba luồng ghi điểm
 * của GradesService — lật sang Kysely).
 *
 * Riêng đường standalone cần một hàm phân giải handle riêng
 * (`resolveStandaloneDb`, tham số constructor thứ hai, tuỳ chọn):
 * facade định tuyến fail-closed cho một trung tâm kho riêng mà
 * phiên chưa được chuẩn bị (bước chuẩn bị là nghĩa vụ của tầng gắn
 * ngữ cảnh), nên hàm phân giải (tầng wiring cấp) chuẩn bị phía
 * Kysely cho đúng slug trong ngữ cảnh rồi mới trả handle, giữ
 * nguyên hành vi trước chuyển đổi (đường standalone luôn ghi được
 * vào kho của trung tâm đang hiệu lực). Điểm dựng tay ngoài tầng
 * wiring (runner cấp phát, spec) truyền handle của đúng kho đích
 * nên không cần hàm phân giải — khi đó handle chính là đích ghi.
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly db: CentreDb,
    private readonly resolveStandaloneDb?: () => Promise<CentreDb>,
  ) {}

  /**
   * Phân giải tenant hiệu lực và payload của một sự kiện — nhà duy
   * nhất của luật này cho MỌI đường ghi outbox (trong transaction
   * của phía gọi và standalone), để các đường không bao giờ lệch nhau.
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
   * Đường ghi outbox qua handle Kysely: dòng sự kiện được ghi
   * trong CÙNG transaction Kysely với thay đổi nghiệp vụ của nơi
   * gọi. Đây là điểm nối A của phán quyết C-8 đã được hợp nhất tại
   * D1 (issue #653): biến thể do các cụm đã chuyển (G7 #647 đưa
   * vào, G5 #645 tái sử dụng) nay là đường ghi duy nhất của
   * service; chữ ký `enqueueKysely(tx: CentreTx, input)` giữ
   * nguyên để mọi phía gọi không đổi hợp đồng. Cột `payload` jsonb
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

  /**
   * Hàm tiện ích: đưa vào hàng đợi trong một transaction Kysely
   * ngắn riêng. Handle đích lấy qua hàm phân giải standalone khi
   * tầng wiring có cấp (xem TSDoc của lớp — ngữ cảnh mang slug của
   * trung tâm kho riêng chưa chuẩn bị cần được chuẩn bị trước),
   * không thì dùng thẳng handle của service.
   */
  async enqueueStandalone(input: OutboxEventInput): Promise<void> {
    const db = this.resolveStandaloneDb ? await this.resolveStandaloneDb() : this.db;
    await db.transaction().execute(async (tx) => {
      await this.enqueueKysely(tx, input);
    });
  }
}
