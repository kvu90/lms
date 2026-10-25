/** Các bảng của bounded context Payments — định nghĩa Drizzle do module payments sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Tài khoản thanh toán (Payment account). */
export const paymentAccounts = pgTable('payment_accounts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  gateway: text('gateway').notNull().default('manual'),
  enabled: boolean('enabled').notNull().default(true),
  config: jsonb('config'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Thanh toán: amount là số nguyên đơn vị nhỏ nhất + currency; bản ghi thành công là bất biến. */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountId: uuid('account_id').notNull().references(() => paymentAccounts.id),
  userId: uuid('user_id').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('pending'), // pending | succeeded | failed | refunded
  gateway: text('gateway').notNull().default('manual'),
  externalTransactionId: text('external_transaction_id'),
  component: text('component').notNull().default(''),
  itemId: uuid('item_id'), // e.g. enrol instance id
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('payments_account_id_idx').on(t.accountId),
      index('payments_user_id_idx').on(t.userId),
      index('payments_item_id_idx').on(t.itemId),unique('payments_external_tx_unique').on(t.gateway, t.externalTransactionId)]);

/** Hoàn tiền là giao dịch bù trừ riêng — payment gốc không bị sửa. */
export const paymentRefunds = pgTable('payment_refunds', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  reason: text('reason').notNull().default(''),
  externalTransactionId: text('external_transaction_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('payment_refunds_payment_id_idx').on(table.paymentId),
  ]);

