import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { paymentAccounts, paymentRefunds, payments } from '../../db/schema';

export type AccountRow = typeof paymentAccounts.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type RefundRow = typeof paymentRefunds.$inferSelect;

/** Kho dữ liệu payment_accounts / payments / payment_refunds. */
@Injectable()
export class PaymentsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async insertAccount(v: typeof paymentAccounts.$inferInsert): Promise<AccountRow> {
    const [row] = await this.db.insert(paymentAccounts).values(v).returning(); return row!;
  }
  async getAccount(id: number): Promise<AccountRow | undefined> {
    const [row] = await this.db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)); return row;
  }
  async listAccounts(): Promise<AccountRow[]> { return this.db.select().from(paymentAccounts); }
  async insertPayment(v: typeof payments.$inferInsert): Promise<PaymentRow> {
    const [row] = await this.db.insert(payments).values(v).returning(); return row!;
  }
  async getPayment(id: number): Promise<PaymentRow | undefined> {
    const [row] = await this.db.select().from(payments).where(eq(payments.id, id)); return row;
  }
  async getByExternalTx(gateway: string, externaltransactionid: string): Promise<PaymentRow | undefined> {
    const [row] = await this.db.select().from(payments)
      .where(and(eq(payments.gateway, gateway), eq(payments.externaltransactionid, externaltransactionid)));
    return row;
  }
  async listPayments(): Promise<PaymentRow[]> { return this.db.select().from(payments); }
  async listPaymentsForUser(userid: number): Promise<PaymentRow[]> {
    return this.db.select().from(payments).where(eq(payments.userid, userid));
  }
  async updatePayment(id: number, v: Partial<typeof payments.$inferInsert>): Promise<void> {
    await this.db.update(payments).set({ ...v, timemodified: new Date() }).where(eq(payments.id, id));
  }
  async insertRefund(v: typeof paymentRefunds.$inferInsert): Promise<RefundRow> {
    const [row] = await this.db.insert(paymentRefunds).values(v).returning(); return row!;
  }
  async listRefunds(paymentid: number): Promise<RefundRow[]> {
    return this.db.select().from(paymentRefunds).where(eq(paymentRefunds.paymentid, paymentid));
  }
}
