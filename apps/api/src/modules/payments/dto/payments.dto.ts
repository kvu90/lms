import {
  createCouponSchema,
  createPaymentAccountSchema,
  createPaymentSchema,
  createRefundSchema,
  paymentWebhookSchema,
  purchasePlanSchema,
  updateCouponSchema,
  type CreateCoupon,
  type CreatePayment,
  type CreatePaymentAccount,
  type CreateRefund,
  type PaymentWebhook,
  type PurchasePlan,
  type UpdateCoupon,
} from '@lms/contracts';

/**
 * Validation Payments dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts`; số tiền là số nguyên đơn vị nhỏ nhất được ép ngay ở schema
 * (`z.number().int()`), không chờ xuống service.
 */
export { createCouponSchema, createPaymentAccountSchema, createPaymentSchema, createRefundSchema, paymentWebhookSchema, purchasePlanSchema, updateCouponSchema };
export type CreateAccountDto = CreatePaymentAccount;
export type CreatePaymentDto = CreatePayment;
export type WebhookDto = PaymentWebhook;
export type RefundDto = CreateRefund;
export type PurchasePlanDto = PurchasePlan;
export type CreateCouponDto = CreateCoupon;
export type UpdateCouponDto = UpdateCoupon;
