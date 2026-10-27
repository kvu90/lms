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
import { users } from '../users/schema';

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
 * status: pending | succeeded | failed | refunded | needs_review (lệch đối soát, chờ vận hành).
 * Bốn cột `review_*` là VẾT XỬ LÝ TAY của hàng đợi `needs_review` (lát 3,
 * issue #189): khi người có quyền xử lý một khoản chờ (khớp tay về
 * `succeeded` hoặc bác bỏ về `failed`), hệ thống ghi người xử lý, quyết
 * định, lý do và thời điểm ngay trên dòng khoản thu — một khoản thu chỉ
 * vào hàng đợi một lần trong vòng đời (pending → needs_review → trạng
 * thái cuối) nên vết xử lý là một mốc duy nhất, không cần bảng vết
 * riêng. Cả bốn cột đều null cho tới khi khoản thu được xử lý tay. */
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
  itemId: uuid('item_id'), // ví dụ: id của instance ghi danh
  /** Mã thanh toán nhúng trong nội dung chuyển khoản (trường 62/08 của VietQR); unique, không tái sử dụng. */
  paymentCode: text('payment_code'),
  /** Hạn của payment/QR; tiền về sau hạn → needs_review, không tự kích hoạt. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** Quyết định xử lý tay hàng đợi `needs_review`: matched (khớp về succeeded) | rejected (bác bỏ về failed). */
  reviewDecision: text('review_decision'),
  /** Lý do xử lý tay — bắt buộc ở tầng service cho cả hai quyết định. */
  reviewReason: text('review_reason'),
  /** Người đã xử lý tay khoản chờ này. */
  reviewHandledBy: uuid('review_handled_by').references(() => users.id, { onDelete: 'restrict' }),
  /** Thời điểm xử lý tay. */
  reviewHandledAt: timestamp('review_handled_at', { withTimezone: true }),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('payments_account_id_idx').on(t.accountId),
      index('payments_tenant_id_idx').on(t.tenantId),
      index('payments_user_id_idx').on(t.userId),
      index('payments_item_id_idx').on(t.itemId),
      index('payments_review_handled_by_idx').on(t.reviewHandledBy),
      unique('payments_payment_code_unique').on(t.paymentCode),
      unique('payments_external_tx_unique').on(t.gateway, t.externalTransactionId)]);

/**
 * Hoàn tiền là giao dịch bù trừ riêng — payment gốc không bị sửa số tiền.
 *
 * Vòng đời của một dòng hoàn (lát 3, issue #189): `requested` (đã tạo yêu
 * cầu, chờ duyệt cấp 2) → `approved` (đã duyệt, chờ xác nhận chi) →
 * `settled` (lệnh chi đã xác nhận); `requested`/`approved` → `rejected`
 * (từ chối). Đảo quyền lợi của khoản thu gốc chỉ xảy ra tại mốc `settled`
 * khi cộng dồn các dòng hoàn đã `settled` đạt 100% số tiền khoản thu.
 *
 * Cấp duyệt được quyết ngay tại thời điểm tạo và ghi vào
 * `approval_level`: một cấp (người tạo đồng thời là người duyệt, dòng
 * hoàn sang `approved` ngay khi tạo) khi hoàn một phần dưới ngưỡng; hai
 * cấp khi số tiền lần hoàn từ ngưỡng trở lên hoặc lần hoàn làm cộng dồn
 * đạt 100%. `approval_threshold` ghi lại ngưỡng hiệu lực đã dùng tại
 * thời điểm tạo (khoá cấu hình `refunddualapprovalthreshold` của
 * component `payments`, có thể ghi đè theo tenant; 0 = luôn hai cấp) để
 * vết kiểm toán không phụ thuộc cấu hình tại thời điểm đọc.
 *
 * Vết kiểm toán nằm ngay trên dòng hoàn: người tạo + lý do (bắt buộc ở
 * tầng service) khi tạo; người duyệt + thời điểm + cấp khi duyệt; người
 * từ chối + thời điểm + lý do từ chối khi từ chối; xác nhận chi gồm mã
 * lệnh chi (`external_transaction_id` — ghi lúc tạo như mã lệnh chi dự
 * kiến hoặc bổ sung lúc xác nhận), người xác nhận (`settled_by`, khi xác
 * nhận tay) hoặc sự kiện `debit` của provider đã khớp
 * (`settled_event_id`, khi hệ thống tự xác nhận qua đối khớp SePay),
 * cùng thời điểm xác nhận (`settled_at`). Kết quả đảo quyền lợi khi hoàn
 * đủ ghi trong `data` (khoá `reversal`) tại mốc `settled`.
 */
export const paymentRefunds = pgTable('payment_refunds', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  /** Lý do hoàn — bắt buộc ở tầng service (hợp đồng tạo yêu cầu hoàn cũng bắt buộc). */
  reason: text('reason').notNull().default(''),
  /** Mã lệnh chi của khoản hoàn: mã dự kiến ghi lúc tạo, là khoá đối khớp với sự kiện `debit`. */
  externalTransactionId: text('external_transaction_id'),
  /** Trạng thái vòng đời: requested | approved | settled | rejected. */
  status: text('status').notNull().default('requested'),
  /** Người tạo yêu cầu hoàn. */
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
  /** Cấp duyệt áp dụng cho dòng hoàn này: 1 = một cấp, 2 = hai cấp (quyết tại thời điểm tạo). */
  approvalLevel: integer('approval_level'),
  /** Ngưỡng hai cấp hiệu lực tại thời điểm tạo (đơn vị tiền nhỏ nhất, cùng đơn vị với amount). */
  approvalThreshold: integer('approval_threshold'),
  /** Người duyệt (với một cấp chính là người tạo; với hai cấp phải khác người tạo — chặn ở tầng service). */
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'restrict' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  /** Người từ chối và lý do từ chối (lý do bắt buộc ở tầng service khi từ chối). */
  rejectedBy: uuid('rejected_by').references(() => users.id, { onDelete: 'restrict' }),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  /** Người xác nhận chi khi xác nhận tay; null khi hệ thống tự xác nhận qua sự kiện `debit`. */
  settledBy: uuid('settled_by').references(() => users.id, { onDelete: 'restrict' }),
  /** Sự kiện `debit` của provider đã khớp để xác nhận chi; null khi xác nhận tay. */
  settledEventId: uuid('settled_event_id').references(() => paymentProviderEvents.id, { onDelete: 'restrict' }),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  /** Tài khoản đích hoàn + kết quả đảo quyền lợi (khoá `reversal`) ghi tại mốc settled. */
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('payment_refunds_payment_id_idx').on(table.paymentId),
      index('payment_refunds_status_idx').on(table.status),
      index('payment_refunds_external_tx_idx').on(table.externalTransactionId),
      index('payment_refunds_created_by_idx').on(table.createdBy),
      index('payment_refunds_approved_by_idx').on(table.approvedBy),
      index('payment_refunds_rejected_by_idx').on(table.rejectedBy),
      index('payment_refunds_settled_by_idx').on(table.settledBy),
      index('payment_refunds_settled_event_id_idx').on(table.settledEventId),
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
  // Idempotency của khâu kích hoạt bảo đảm ở tầng DB: một payment gói
  // sinh TỐI ĐA một bản ghi quyền lợi (xem PlanEntitlementsService).
  unique('plan_entitlements_payment_id_unique').on(t.paymentId),
]);

/**
 * Coupon giảm giá cho đường MUA GÓI (phần còn lại của lát 2, issue
 * #189; đặc tả bổ sung đã ghi trong issue): coupon là DỮ LIỆU do quản
 * trị platform tạo trong bề mặt quản trị coupon — mã, loại giảm, mức
 * giảm, phạm vi gói áp dụng, cửa sổ hiệu lực và giới hạn lượt dùng đều
 * nằm ở bản ghi này, TUYỆT ĐỐI không có giá trị giảm nào ghim trong
 * code. `code` là duy nhất toàn hệ và được chuẩn hoá chữ hoa khi tạo
 * lẫn khi áp dụng. `discount_type`: `percent` (giảm theo phần trăm giá
 * gói đang cấu hình, hợp lệ 1–99) hoặc `fixed` (giảm số tiền cố định,
 * đơn vị tiền nhỏ nhất như mọi `amount`). `applies_to`: `tenant_plan`,
 * `teacher_plan` hoặc `all`. `starts_at`/`ends_at` cho phép null
 * (null = không giới hạn phía đó); `max_redemptions` cho phép null
 * (null = không giới hạn lượt dùng). Ngừng sử dụng coupon bằng
 * `is_active = false`, không xoá cứng. Coupon chỉ áp dụng tại thời
 * điểm tạo payment gói: mức giảm trừ vào giá cấu hình, `payments.amount`
 * là giá sau giảm, và ảnh chụp trong `payments.data.plan` ghi lại mã
 * coupon + số tiền đã giảm — lượt dùng được đếm từ chính các payment
 * đó (payment `pending`/`succeeded` tính một lượt, `failed` không
 * tính) nên bảng này không cần bảng lượt dùng riêng. Bảng nghiệp vụ
 * tầng platform nên theo khuôn các bảng payments: KHÔNG bật RLS —
 * quản trị coupon là nghiệp vụ của platform, gác bằng capability ở
 * tầng service.
 */
export const paymentCoupons = pgTable('payment_coupons', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  code: text('code').notNull(),
  /** percent: giảm theo phần trăm (1–99); fixed: giảm số tiền cố định theo đơn vị nhỏ nhất của currency. */
  discountType: text('discount_type').notNull(), // percent | fixed
  discountValue: integer('discount_value').notNull(),
  appliesTo: text('applies_to').notNull().default('all'), // tenant_plan | teacher_plan | all
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  maxRedemptions: integer('max_redemptions'),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('payment_coupons_code_unique').on(t.code),
  index('payment_coupons_created_by_idx').on(t.createdBy),
]);
