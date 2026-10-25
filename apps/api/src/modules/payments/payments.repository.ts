import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { course, paymentAccounts, paymentProviderEvents, paymentRefunds, payments } from '../../db/schema';

export type AccountRow = typeof paymentAccounts.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type RefundRow = typeof paymentRefunds.$inferSelect;
export type ProviderEventRow = typeof paymentProviderEvents.$inferSelect;

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
  async updatePayment(id: string, v: Partial<typeof payments.$inferInsert>): Promise<void> {
    await this.db.update(payments).set({ ...v, updatedAt: new Date() }).where(eq(payments.id, id));
  }
  async insertRefund(v: typeof paymentRefunds.$inferInsert): Promise<RefundRow> {
    const [row] = await this.db.insert(paymentRefunds).values(v).returning(); return row!;
  }
  async listRefunds(paymentId: string): Promise<RefundRow[]> {
    return this.db.select().from(paymentRefunds).where(eq(paymentRefunds.paymentId, paymentId));
  }
  /** Tổng đã hoàn của một payment (cổng cộng dồn 5.5 — issue #189). */
  async sumRefunds(paymentId: string): Promise<number> {
    const [row] = await this.db.select({ total: sql<number>`coalesce(sum(${paymentRefunds.amount}), 0)::int` })
      .from(paymentRefunds).where(eq(paymentRefunds.paymentId, paymentId));
    return row?.total ?? 0;
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
}
