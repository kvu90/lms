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
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Thanh toán: amount là số nguyên đơn vị nhỏ nhất + currency; bản ghi thành công là bất biến. */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountid: uuid('accountid').notNull().references(() => paymentAccounts.id),
  userid: uuid('userid').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('pending'), // pending | succeeded | failed | refunded
  gateway: text('gateway').notNull().default('manual'),
  externaltransactionid: text('externaltransactionid'),
  component: text('component').notNull().default(''),
  itemid: uuid('itemid'), // e.g. enrol instance id
  data: jsonb('data'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('payments_accountid_idx').on(t.accountid),
      index('payments_userid_idx').on(t.userid),
      index('payments_itemid_idx').on(t.itemid),unique('payments_external_tx_unique').on(t.gateway, t.externaltransactionid)]);

/** Hoàn tiền là giao dịch bù trừ riêng — payment gốc không bị sửa. */
export const paymentRefunds = pgTable('payment_refunds', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  paymentid: uuid('paymentid').notNull().references(() => payments.id),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  reason: text('reason').notNull().default(''),
  externaltransactionid: text('externaltransactionid'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('payment_refunds_paymentid_idx').on(table.paymentid),
  ]);

