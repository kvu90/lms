import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { paymentRefunds, payments, planEntitlements } from '@lms/db';
import type { RefundRow } from '@lms/payments';
import type { relations } from './db/relations';

type Database = NodePgDatabase<typeof relations>;
/** Handle của một transaction Drizzle đang mở trên tay cầm của worker. */
type WorkerTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Repository CHUYỂN TIẾP phía Drizzle cho transaction settle của
 * worker — điểm nối của chiến dịch chuyển Kysely trong PR #683 (D4).
 *
 * Vì sao cần cầu nối này: package `@lms/payments` từ PR này đã
 * Kysely-only, nhưng transaction settle của worker
 * (`WorkerPaymentSettlementService.applyRefundSettlement`) vẫn mở
 * bằng Drizzle và truyền transaction Drizzle vào các phương thức
 * repository — transaction Drizzle không có `selectFrom` /
 * `updateTable` / `insertInto` của handle Kysely nên các lời gọi
 * đó gãy ở runtime (đã chứng minh bằng 6 spec e2e dùng cầu dẫn
 * sweep rớt bằng timeout trên head `5f041746`). Đường API không
 * nằm trong phạm vi này: settle tay qua HTTP và các đường ghi
 * không dùng transaction đã Kysely nhất quán.
 *
 * Phạm vi CHỈ gồm đúng 5 phương thức mà transaction settle dùng
 * kèm `tx` — thân verbatim từ bản Drizzle gốc của
 * `PaymentsRepository` (main, trước PR #683), không thêm logic,
 * không thêm phương thức nào khác:
 * `getRefund`, `sumRefundsByStatuses`, `updateRefund`,
 * `updatePayment`, `suspendEntitlementsByPayment`. Các lời gọi
 * repository không kèm `tx` của worker giữ nguyên trên repository
 * Kysely của `@lms/payments`.
 *
 * Chủ đóng: W2b #661. Khi #661 lật transaction settle sang Kysely
 * thì xoá file này, nối lại các điểm gọi trong
 * `WorkerPaymentSettlementService` về `PaymentsRepository`, và gỡ
 * provider khỏi `WorkerModule`; issue #663 đối chiếu không còn
 * sót. Tuyệt đối không khôi phục hai repository chuyển tiếp
 * enrol/groups đã xoá ở PR này — Seam C đã đóng, không đụng tới.
 */
@Injectable()
export class WorkerPaymentsTransitionalRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Đọc dòng hoàn theo id, trong transaction của nơi gọi khi có `tx`. */
  async getRefund(id: string, tx?: WorkerTx): Promise<RefundRow | undefined> {
    const [row] = await (tx ?? this.db).select().from(paymentRefunds).where(eq(paymentRefunds.id, id));
    return row;
  }

  /** Cập nhật dòng hoàn, trả dòng sau ghi. */
  async updateRefund(id: string, v: Partial<typeof paymentRefunds.$inferInsert>, tx?: WorkerTx): Promise<RefundRow> {
    const [row] = await (tx ?? this.db).update(paymentRefunds).set({ ...v, updatedAt: new Date() })
      .where(eq(paymentRefunds.id, id)).returning();
    return row!;
  }

  /** Lật trạng thái khoản thu (settle đạt 100% → `refunded`). */
  async updatePayment(id: string, v: Partial<typeof payments.$inferInsert>, tx?: WorkerTx): Promise<void> {
    await (tx ?? this.db).update(payments).set({ ...v, updatedAt: new Date() }).where(eq(payments.id, id));
  }

  /**
   * Tổng cộng dồn của các dòng hoàn thuộc một TẬP TRẠNG THÁI cho trước.
   * Cổng cộng dồn dùng tập {requested, approved, settled} (mọi dòng
   * chưa bị từ chối đều giữ chỗ ngân sách hoàn); mốc đảo quyền lợi dùng
   * tập {settled} (chỉ tiền đã xác nhận chi mới tính tiền đã ra). Dòng
   * `rejected` không thuộc tập nào cả nên ngân sách được giải phóng.
   * Chạy trong transaction có khoá dòng `payments` khi gọi từ khâu xác
   * nhận chi (truyền `tx`).
   */
  async sumRefundsByStatuses(paymentId: string, statuses: string[], tx?: WorkerTx): Promise<number> {
    const [row] = await (tx ?? this.db).select({ total: sql<number>`coalesce(sum(${paymentRefunds.amount}), 0)::int` })
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.paymentId, paymentId), inArray(paymentRefunds.status, statuses)));
    return row?.total ?? 0;
  }

  /** Đảo quyền lợi khi hoàn đủ: quyền lợi của chính payment chuyển `suspended`. */
  async suspendEntitlementsByPayment(paymentId: string, tx?: WorkerTx): Promise<void> {
    const db = tx ?? this.db;
    await db.update(planEntitlements)
      .set({ status: 'suspended', updatedAt: new Date() })
      .where(eq(planEntitlements.paymentId, paymentId));
  }
}
