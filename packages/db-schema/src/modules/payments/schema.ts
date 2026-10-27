/** Các bảng của bounded context Payments — định nghĩa Drizzle do module payments sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from '../tenants/schema';

/** Tài khoản thanh toán (Payment account). Mỗi account thuộc đúng một chủ sở hữu
 * tenant (platform = tenant-zero) — nghiên cứu VietQR §4.3.1/§6.1 (issue #189). */
export const paymentAccounts = pgTable('payment_accounts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  gateway: text('gateway').notNull().default('manual'),
  enabled: boolean('enabled').notNull().default(true),
  config: jsonb('config'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('payment_accounts_tenant_id_idx').on(t.tenantId),
]);

/** Sequence riêng cho mã thanh toán VietQR (LMS + base32 Crockford) — sinh một
 * lần lúc tạo payment, không bao giờ tái sử dụng (nghiên cứu VietQR §2.4/§6.3). */
export const paymentCodeSeq = pgSequence('payment_code_seq', { startWith: 1 });

/** Thanh toán: amount là số nguyên đơn vị nhỏ nhất + currency; bản ghi thành công là bất biến.
 * status: pending | succeeded | failed | refunded | needs_review (lệch đối soát, chờ vận hành). */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountId: uuid('account_id').notNull().references(() => paymentAccounts.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('pending'), // pending | succeeded | failed | refunded | needs_review
  gateway: text('gateway').notNull().default('manual'),
  externalTransactionId: text('external_transaction_id'),
  component: text('component').notNull().default(''),
  itemId: uuid('item_id'), // e.g. enrol instance id
  /** Mã thanh toán nhúng trong nội dung chuyển khoản (trường 62/08 của VietQR); unique, không tái sử dụng. */
  paymentCode: text('payment_code'),
  /** Hạn của payment/QR; tiền về sau hạn → needs_review, không tự kích hoạt. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('payments_account_id_idx').on(t.accountId),
      index('payments_tenant_id_idx').on(t.tenantId),
      index('payments_user_id_idx').on(t.userId),
      index('payments_item_id_idx').on(t.itemId),
      unique('payments_payment_code_unique').on(t.paymentCode),
      unique('payments_external_tx_unique').on(t.gateway, t.externalTransactionId)]);

/** Hoàn tiền là giao dịch bù trừ riêng — payment gốc không bị sửa. */
export const paymentRefunds = pgTable('payment_refunds', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  reason: text('reason').notNull().default(''),
  externalTransactionId: text('external_transaction_id'),
  /** Tài khoản đích hoàn + trạng thái xử lý chi (nghiên cứu VietQR §5.3/§6.1). */
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('payment_refunds_payment_id_idx').on(table.paymentId),
  ]);

/**
 * Sổ sự kiện thô từ kênh đối soát (SePay): nền của idempotency (unique theo
 * (provider, external_transaction_id) = transaction_id của kênh), của hàng đợi
 * needs_review và của đối soát thật (nghiên cứu VietQR §6.1).
 * matchStatus: received | matched | needs_review | ignored | duplicate.
 */
export const paymentProviderEvents = pgTable('payment_provider_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  provider: text('provider').notNull(), // sepay
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  accountId: uuid('account_id').references(() => paymentAccounts.id),
  externalTransactionId: text('external_transaction_id').notNull(),
  direction: text('direction').notNull(), // credit | debit
  amount: integer('amount').notNull(),
  content: text('content').notNull().default(''),
  extractedCode: text('extracted_code'),
  matchedPaymentId: uuid('matched_payment_id').references(() => payments.id),
  matchStatus: text('match_status').notNull().default('received'),
  raw: jsonb('raw'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('payment_provider_events_tx_unique').on(t.provider, t.externalTransactionId),
  index('payment_provider_events_tenant_idx').on(t.tenantId),
  index('payment_provider_events_account_idx').on(t.accountId),
  index('payment_provider_events_payment_idx').on(t.matchedPaymentId),
  index('payment_provider_events_status_idx').on(t.matchStatus),
]);

/**
 * Quyền lợi gói đã mua (lát 2 của issue #189 — mô hình gói
 * `tenant_plan`/`teacher_plan`): mỗi payment gói THÀNH CÔNG sinh đúng
 * một bản ghi quyền lợi với cửa sổ hiệu lực [starts_at, expires_at).
 * Mua tiếp khi gói cùng loại của cùng bên hưởng còn hạn thì cửa sổ mới
 * NỐI TIẾP từ mốc hết hạn hiện tại (cộng dồn thời hạn, không ghi đè
 * lịch sử mua). `tenant_id` là tenant HƯỞNG gói — với `tenant_plan`
 * chính là tenant đó (user_id = NULL); với `teacher_plan` là tenant nơi
 * giao dịch diễn ra và `user_id` là giáo viên hưởng gói. status:
 * `active` | `suspended` — hoàn ĐỦ tiền của payment gói thì quyền lợi
 * của chính payment đó chuyển `suspended` (cùng khuôn đảo quyền lợi của
 * enrol_fee/class_fee). Bảng nghiệp vụ tầng platform nên theo khuôn
 * các bảng payments: KHÔNG bật RLS — cách ly bằng `tenant_id` tường
 * minh ở tầng service, vì đối soát gói là nghiệp vụ xuyên tenant của
 * platform (platform thu tiền gói của mọi tenant).
 */
export const planEntitlements = pgTable('plan_entitlements', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id'),
  component: text('component').notNull(), // tenant_plan | teacher_plan
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('active'), // active | suspended
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('plan_entitlements_tenant_id_idx').on(t.tenantId),
  index('plan_entitlements_user_id_idx').on(t.userId),
  index('plan_entitlements_payment_id_idx').on(t.paymentId),
]);
