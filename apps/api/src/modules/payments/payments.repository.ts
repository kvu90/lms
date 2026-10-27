import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';

/** Kiểu transaction của Drizzle — các method ghi của vòng đời hoàn
 * tiền (lát 3, issue #189) nhận transaction tuỳ chọn để cổng cộng dồn
 * chạy trong MỘT transaction có khoá dòng `payments`. */
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];
import { course, paymentAccounts, paymentCoupons, paymentProviderEvents, paymentRefunds, payments, planEntitlements } from '../../db/schema';

export type AccountRow = typeof paymentAccounts.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type RefundRow = typeof paymentRefunds.$inferSelect;
export type ProviderEventRow = typeof paymentProviderEvents.$inferSelect;
export type EntitlementRow = typeof planEntitlements.$inferSelect;
export type CouponRow = typeof paymentCoupons.$inferSelect;

/** Kho dữ liệu payment_accounts / payments / payment_refunds. */
@Injectable()
export class PaymentsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async insertAccount(v: typeof paymentAccounts.$inferInsert): Promise<AccountRow> {
    const [row] = await this.db.insert(paymentAccounts).values(v).returning(); return row!;
  }
  async getAccount(id: string): Promise<AccountRow | undefined> {
    const [row] = await this.db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)); return row;
  }
  async listAccounts(): Promise<AccountRow[]> { return this.db.select().from(paymentAccounts); }
  async insertPayment(v: typeof payments.$inferInsert): Promise<PaymentRow> {
    const [row] = await this.db.insert(payments).values(v).returning(); return row!;
  }
  async getPayment(id: string): Promise<PaymentRow | undefined> {
    const [row] = await this.db.select().from(payments).where(eq(payments.id, id)); return row;
  }
  async getByExternalTx(gateway: string, externalTransactionId: string): Promise<PaymentRow | undefined> {
    const [row] = await this.db.select().from(payments)
      .where(and(eq(payments.gateway, gateway), eq(payments.externalTransactionId, externalTransactionId)));
    return row;
  }
  async listPayments(): Promise<PaymentRow[]> { return this.db.select().from(payments); }
  async listPaymentsForUser(userId: string): Promise<PaymentRow[]> {
    return this.db.select().from(payments).where(eq(payments.userId, userId));
  }
  async updatePayment(id: string, v: Partial<typeof payments.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(payments).set({ ...v, updatedAt: new Date() }).where(eq(payments.id, id));
  }
  async insertRefund(v: typeof paymentRefunds.$inferInsert, tx?: DbTx): Promise<RefundRow> {
    const [row] = await (tx ?? this.db).insert(paymentRefunds).values(v).returning(); return row!;
  }
  async listRefunds(paymentId: string): Promise<RefundRow[]> {
    return this.db.select().from(paymentRefunds).where(eq(paymentRefunds.paymentId, paymentId))
      .orderBy(asc(paymentRefunds.createdAt));
  }
  /** Tổng đã hoàn của một payment (cổng cộng dồn 5.5 — issue #189). */
  async sumRefunds(paymentId: string): Promise<number> {
    const [row] = await this.db.select({ total: sql<number>`coalesce(sum(${paymentRefunds.amount}), 0)::int` })
      .from(paymentRefunds).where(eq(paymentRefunds.paymentId, paymentId));
    return row?.total ?? 0;
  }

  // --- Vòng đời hoàn tiền (lát 3, issue #189) ------------------------------
  async getRefund(id: string, tx?: DbTx): Promise<RefundRow | undefined> {
    const [row] = await (tx ?? this.db).select().from(paymentRefunds).where(eq(paymentRefunds.id, id)); return row;
  }
  async updateRefund(id: string, v: Partial<typeof paymentRefunds.$inferInsert>, tx?: DbTx): Promise<RefundRow> {
    const [row] = await (tx ?? this.db).update(paymentRefunds).set({ ...v, updatedAt: new Date() })
      .where(eq(paymentRefunds.id, id)).returning();
    return row!;
  }
  /**
   * Tổng cộng dồn của các dòng hoàn thuộc một TẬP TRẠNG THÁI cho trước.
   * Cổng cộng dồn dùng tập {requested, approved, settled} (mọi dòng
   * chưa bị từ chối đều giữ chỗ ngân sách hoàn); mốc đảo quyền lợi dùng
   * tập {settled} (chỉ tiền đã xác nhận chi mới tính tiền đã ra). Dòng
   * `rejected` không thuộc tập nào cả nên ngân sách được giải phóng.
   * Chạy trong transaction có khoá dòng `payments` khi gọi từ cổng tạo
   * yêu cầu hoàn / khâu xác nhận chi (truyền `tx`).
   */
  async sumRefundsByStatuses(paymentId: string, statuses: string[], tx?: DbTx): Promise<number> {
    const [row] = await (tx ?? this.db).select({ total: sql<number>`coalesce(sum(${paymentRefunds.amount}), 0)::int` })
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.paymentId, paymentId), inArray(paymentRefunds.status, statuses)));
    return row?.total ?? 0;
  }
  /**
   * Dòng hoàn ứng viên cho một sự kiện `debit`: đang `approved` (chờ xác
   * nhận chi), tài khoản của khoản thu gốc trùng tài khoản nhận sự
   * kiện, số tiền bằng nhau, và mã lệnh chi ghi trên dòng hoàn (mã dự
   * kiến lúc tạo) trùng mã giao dịch ngoài HOẶC mã tham chiếu của sự
   * kiện. Lấy dòng cũ nhất trước khi có nhiều dòng hoàn cùng chờ.
   */
  async findRefundCandidateForDebit(input: {
    accountId: string; amount: number; transactionIds: string[];
  }): Promise<{ refund: RefundRow; payment: PaymentRow } | undefined> {
    const ids = input.transactionIds.filter((v) => v.length > 0);
    if (ids.length === 0) return undefined;
    const [row] = await this.db.select({ refund: paymentRefunds, payment: payments })
      .from(paymentRefunds)
      .innerJoin(payments, eq(payments.id, paymentRefunds.paymentId))
      .where(and(
        eq(paymentRefunds.status, 'approved'),
        eq(payments.accountId, input.accountId),
        eq(paymentRefunds.amount, input.amount),
        inArray(paymentRefunds.externalTransactionId, ids),
      ))
      .orderBy(asc(paymentRefunds.createdAt))
      .limit(1);
    return row;
  }
  /** Dòng hoàn đã được xác nhận chi bởi chính sự kiện này — căn cứ idempotency khi sự kiện bị phát lại. */
  async getRefundBySettledEventId(eventId: string): Promise<RefundRow | undefined> {
    const [row] = await this.db.select().from(paymentRefunds).where(eq(paymentRefunds.settledEventId, eventId)); return row;
  }

  // --- Hàng đợi needs_review (lát 3, issue #189) ---------------------------
  /** Mọi khoản thu đang chờ xử lý tay thuộc các tenant cho trước (phạm vi hàng đợi của người xem). */
  async listNeedsReviewPayments(tenantIds: string[]): Promise<PaymentRow[]> {
    if (tenantIds.length === 0) return [];
    return this.db.select().from(payments)
      .where(and(eq(payments.status, 'needs_review'), inArray(payments.tenantId, tenantIds)))
      .orderBy(asc(payments.updatedAt));
  }
  /**
   * Mọi sự kiện provider đang `needs_review` MÀ KHÔNG gắn khoản thu nào
   * (matched_payment_id rỗng) thuộc các tenant cho trước — đây là các
   * sự kiện "mồ côi" (mã lạ, debit không khớp dòng hoàn) cần xuất hiện
   * như mục độc lập trong hàng đợi. Sự kiện đã gắn khoản thu được trình
   * bày như ngữ cảnh của chính khoản thu đó, không thành mục riêng.
   */
  async listNeedsReviewEvents(tenantIds: string[]): Promise<ProviderEventRow[]> {
    if (tenantIds.length === 0) return [];
    return this.db.select().from(paymentProviderEvents)
      .where(and(
        eq(paymentProviderEvents.matchStatus, 'needs_review'),
        isNull(paymentProviderEvents.matchedPaymentId),
        inArray(paymentProviderEvents.tenantId, tenantIds),
      ))
      .orderBy(asc(paymentProviderEvents.receivedAt));
  }
  /**
   * Sự kiện provider liên quan gần nhất của một khoản thu: sự kiện đã
   * được gắn vào khoản thu (matched_payment_id) hoặc sự kiện mang mã
   * trích xuất trùng mã thanh toán của khoản thu — dùng làm ngữ cảnh
   * đối soát khi trình bày khoản chờ trong hàng đợi.
   */
  async getLatestEventForPayment(payment: PaymentRow): Promise<ProviderEventRow | undefined> {
    const clauses = [eq(paymentProviderEvents.matchedPaymentId, payment.id)];
    if (payment.paymentCode) clauses.push(eq(paymentProviderEvents.extractedCode, payment.paymentCode));
    const [row] = await this.db.select().from(paymentProviderEvents)
      .where(or(...clauses))
      .orderBy(desc(paymentProviderEvents.receivedAt))
      .limit(1);
    return row;
  }

  // --- VietQR / SePay (lát 1, issue #189) -----------------------------------
  /** Số thứ tự tiếp theo cho mã thanh toán — sequence chỉ tăng, mã không tái sử dụng. */
  async nextPaymentCodeValue(): Promise<number> {
    const res = (await this.db.execute(sql`select nextval('payment_code_seq')::int as v`)) as unknown as { rows: { v: number }[] };
    return res.rows[0]!.v;
  }
  async getPaymentByCode(code: string): Promise<PaymentRow | undefined> {
    const [row] = await this.db.select().from(payments).where(eq(payments.paymentCode, code)); return row;
  }
  /** Tenant sở hữu một khoá — căn cứ cổng tenant cho createFeePayment (6.4.6). */
  async getCourseTenantId(courseId: string): Promise<string | undefined> {
    const [row] = await this.db.select({ tenantId: course.tenantId }).from(course).where(eq(course.id, courseId)); return row?.tenantId;
  }
  /** Định tuyến IPN: account theo `sepayBankAccountXid` trong config (định danh tổ chức SePay). */
  async findAccountBySepayXid(xid: string): Promise<AccountRow | undefined> {
    const [row] = await this.db.select().from(paymentAccounts)
      .where(sql`${paymentAccounts.config}->>'sepayBankAccountXid' = ${xid}`);
    return row;
  }
  /** Định tuyến IPN dự phòng: account theo số tài khoản ngân hàng trong config. */
  async findAccountByBankNumber(accountNumber: string): Promise<AccountRow | undefined> {
    const [row] = await this.db.select().from(paymentAccounts)
      .where(sql`${paymentAccounts.config}->>'bankAccountNumber' = ${accountNumber}`);
    return row;
  }
  /**
   * Ghi sự kiện kênh: unique (provider, external_transaction_id) là cổng
   * idempotency — bản ghi trùng (SePay retry) trả `undefined`, không ghi hai lần.
   */
  async insertProviderEvent(v: typeof paymentProviderEvents.$inferInsert): Promise<ProviderEventRow | undefined> {
    const [row] = await this.db.insert(paymentProviderEvents).values(v)
      .onConflictDoNothing({ target: [paymentProviderEvents.provider, paymentProviderEvents.externalTransactionId] })
      .returning();
    return row;
  }
  async getProviderEvent(id: string): Promise<ProviderEventRow | undefined> {
    const [row] = await this.db.select().from(paymentProviderEvents).where(eq(paymentProviderEvents.id, id)); return row;
  }
  async getProviderEventByTx(provider: string, externalTransactionId: string): Promise<ProviderEventRow | undefined> {
    const [row] = await this.db.select().from(paymentProviderEvents)
      .where(and(eq(paymentProviderEvents.provider, provider), eq(paymentProviderEvents.externalTransactionId, externalTransactionId)));
    return row;
  }
  /** Sự kiện đang chờ matching: `received`, cộng `processing` treo quá lâu (tiến trình chết giữa chừng). */
  async listPendingProviderEvents(limit: number, staleProcessingBefore: Date): Promise<ProviderEventRow[]> {
    return this.db.select().from(paymentProviderEvents)
      .where(or(
        eq(paymentProviderEvents.matchStatus, 'received'),
        and(eq(paymentProviderEvents.matchStatus, 'processing'), lt(paymentProviderEvents.receivedAt, staleProcessingBefore)),
      ))
      .orderBy(asc(paymentProviderEvents.receivedAt))
      .limit(limit);
  }
  /** Nhận việc một sự kiện (received → processing); trả false nếu sự kiện đã bị nhịp khác nhận. */
  async claimProviderEvent(id: string): Promise<boolean> {
    const rows = await this.db.update(paymentProviderEvents)
      .set({ matchStatus: 'processing' })
      .where(and(eq(paymentProviderEvents.id, id), inArray(paymentProviderEvents.matchStatus, ['received', 'processing'])))
      .returning({ id: paymentProviderEvents.id });
    return rows.length > 0;
  }
  async updateProviderEvent(id: string, v: Partial<typeof paymentProviderEvents.$inferInsert>): Promise<void> {
    await this.db.update(paymentProviderEvents).set(v).where(eq(paymentProviderEvents.id, id));
  }

  // --- Quyền lợi gói (lát 2, issue #189) ------------------------------------
  async insertEntitlement(v: typeof planEntitlements.$inferInsert): Promise<EntitlementRow> {
    const [row] = await this.db.insert(planEntitlements).values(v).returning(); return row!;
  }
  /** Quyền lợi sinh từ một payment gói — căn cứ idempotency của khâu kích hoạt. */
  async getEntitlementByPayment(paymentId: string): Promise<EntitlementRow | undefined> {
    const [row] = await this.db.select().from(planEntitlements).where(eq(planEntitlements.paymentId, paymentId)); return row;
  }
  /**
   * Mốc hết hạn muộn nhất trong các quyền lợi đang `active` của cùng một
   * bên hưởng + cùng loại gói — căn cứ nối tiếp cửa sổ khi mua tiếp.
   * Bên hưởng của `tenant_plan` xác định bằng (tenant_id, user_id NULL);
   * của `teacher_plan` bằng user_id.
   */
  async maxActiveEntitlementExpiry(component: string, tenantId: string, userId: string | null): Promise<Date | null> {
    const beneficiary = userId
      ? eq(planEntitlements.userId, userId)
      : and(eq(planEntitlements.tenantId, tenantId), isNull(planEntitlements.userId));
    const [row] = await this.db.select({ m: sql<string | null>`max(${planEntitlements.expiresAt})` })
      .from(planEntitlements)
      .where(and(eq(planEntitlements.component, component), eq(planEntitlements.status, 'active'), beneficiary));
    return row?.m ? new Date(row.m) : null;
  }
  /** Mọi quyền lợi gói giáo viên của một người dùng (theo thứ tự bắt đầu tăng dần). */
  async listEntitlementsForUser(userId: string): Promise<EntitlementRow[]> {
    return this.db.select().from(planEntitlements)
      .where(eq(planEntitlements.userId, userId))
      .orderBy(asc(planEntitlements.startsAt));
  }
  /** Mọi quyền lợi gói trung tâm của một tenant (theo thứ tự bắt đầu tăng dần). */
  async listTenantPlanEntitlements(tenantId: string): Promise<EntitlementRow[]> {
    return this.db.select().from(planEntitlements)
      .where(and(eq(planEntitlements.tenantId, tenantId), isNull(planEntitlements.userId)))
      .orderBy(asc(planEntitlements.startsAt));
  }
  /** Đảo quyền lợi khi hoàn đủ: quyền lợi của chính payment chuyển `suspended`. */
  async suspendEntitlementsByPayment(paymentId: string): Promise<void> {
    await this.db.update(planEntitlements)
      .set({ status: 'suspended', updatedAt: new Date() })
      .where(eq(planEntitlements.paymentId, paymentId));
  }

  // --- Coupon giảm giá mua gói (phần còn lại của lát 2, issue #189) --------
  async insertCoupon(v: typeof paymentCoupons.$inferInsert): Promise<CouponRow> {
    const [row] = await this.db.insert(paymentCoupons).values(v).returning(); return row!;
  }
  async getCoupon(id: string): Promise<CouponRow | undefined> {
    const [row] = await this.db.select().from(paymentCoupons).where(eq(paymentCoupons.id, id)); return row;
  }
  /** Tra coupon theo mã đã chuẩn hoá chữ hoa (mã là duy nhất toàn hệ). */
  async getCouponByCode(code: string): Promise<CouponRow | undefined> {
    const [row] = await this.db.select().from(paymentCoupons).where(eq(paymentCoupons.code, code)); return row;
  }
  async listCoupons(): Promise<CouponRow[]> {
    return this.db.select().from(paymentCoupons).orderBy(asc(paymentCoupons.createdAt));
  }
  async updateCoupon(id: string, v: Partial<typeof paymentCoupons.$inferInsert>): Promise<CouponRow> {
    const [row] = await this.db.update(paymentCoupons).set({ ...v, updatedAt: new Date() }).where(eq(paymentCoupons.id, id)).returning();
    return row!;
  }
  /**
   * Số lượt dùng đã tiêu thụ của một coupon: số payment gói mang
   * coupon này trong ảnh chụp `data.plan` và đang ở trạng thái
   * `pending` hoặc `succeeded` — payment `failed` không tính (lượt
   * dùng được hoàn lại), đúng đặc tả coupon của issue.
   */
  async countCouponRedemptions(couponId: string): Promise<number> {
    const [row] = await this.db.select({ total: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(
        inArray(payments.component, ['tenant_plan', 'teacher_plan']),
        inArray(payments.status, ['pending', 'succeeded']),
        sql`${payments.data}->'plan'->>'couponId' = ${couponId}`,
      ));
    return row?.total ?? 0;
  }
}
