import {
  createCouponSchema,
  createPaymentAccountSchema,
  createPaymentSchema,
  createRefundSchema,
  paymentWebhookSchema,
  purchasePlanSchema,
  rejectRefundSchema,
  resolvePaymentReviewSchema,
  settleRefundSchema,
  updateCouponSchema,
  type CreateCoupon,
  type CreatePayment,
  type CreatePaymentAccount,
  type CreateRefund,
  type PaymentWebhook,
  type PurchasePlan,
  type RejectRefund,
  type ResolvePaymentReview,
  type SettleRefund,
  type UpdateCoupon,
} from '@lms/contracts';

/**
 * Validation Payments dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts`; số tiền là số nguyên đơn vị nhỏ nhất được ép ngay ở schema
 * (`z.number().int()`), không chờ xuống service.
 * Lát 3 (issue #189): hoàn tiền đi qua vòng đời duyệt nên có thêm
 * schema cho từng bước — tạo yêu cầu (`createRefundSchema`, lý do bắt
 * buộc), từ chối (`rejectRefundSchema`, lý do bắt buộc), xác nhận chi
 * (`settleRefundSchema`) — và schema xử lý hàng đợi `needs_review`
 * (`resolvePaymentReviewSchema`, quyết định + lý do bắt buộc).
 */
export {
  createCouponSchema, createPaymentAccountSchema, createPaymentSchema, createRefundSchema,
  paymentWebhookSchema, purchasePlanSchema, rejectRefundSchema, resolvePaymentReviewSchema,
  settleRefundSchema, updateCouponSchema,
};
export type CreateAccountDto = CreatePaymentAccount;
export type CreatePaymentDto = CreatePayment;
export type WebhookDto = PaymentWebhook;
export type RefundDto = CreateRefund;
export type RejectRefundDto = RejectRefund;
export type SettleRefundDto = SettleRefund;
export type ResolvePaymentReviewDto = ResolvePaymentReview;
export type PurchasePlanDto = PurchasePlan;
export type CreateCouponDto = CreateCoupon;
export type UpdateCouponDto = UpdateCoupon;
