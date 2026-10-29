import { Body, Controller, Get, Headers, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { createCouponSchema, createPaymentAccountSchema, createPaymentSchema, createRefundSchema, paymentWebhookSchema, purchasePlanSchema, rejectRefundSchema, resolvePaymentReviewSchema, settleRefundSchema, updateCouponSchema, type CreateAccountDto, type CreateCouponDto, type CreatePaymentDto, type PurchasePlanDto, type RefundDto, type RejectRefundDto, type ResolvePaymentReviewDto, type SettleRefundDto, type UpdateCouponDto, type WebhookDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';

/**
 * Controller thanh toán: accounts, payments, webhook (public,
 * idempotent), refunds, IPN SePay.
 * Lát 3 (issue #189): hoàn tiền là vòng đời nhiều bước —
 * `POST :id/refunds` tạo yêu cầu, `POST :id/refunds/:refundId/approve`
 * duyệt cấp 2, `POST :id/refunds/:refundId/reject` từ chối,
 * `POST :id/refunds/:refundId/settle` xác nhận chi — thay cho route
 * hoàn một bước `POST :id/refund` trước đây (route cũ bỏ hẳn, không
 * giữ bí danh, vì giữ lại sẽ lách được cổng duyệt). Hàng đợi rà soát
 * `needs_review`: `GET review-queue` và `POST :id/review`.
 */
@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Post('accounts')
  async createAccount(@Body({ schema: createPaymentAccountSchema }) dto: CreateAccountDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createAccount(actor.id, dto);
  }
  @Get('accounts')
  async listAccounts(@CurrentUser() actor: AuthenticatedUser) { return this.payments.listAccounts(actor.id); }
  @Get('accounts/:id')
  async getAccount(@Param('id', { schema: uuidIdSchema }) id: string) { return this.payments.getAccount(id); }
  @Post()
  async create(@Body({ schema: createPaymentSchema }) dto: CreatePaymentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createPayment(actor.id, dto);
  }
  @Post('fee/:instanceId')
  async createFee(@Param('instanceId', { schema: uuidIdSchema }) instanceId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createFeePayment(actor.id, instanceId);
  }
  /**
   * POST /payments/class-fee/:classId — bắt đầu thanh toán GÓI LỚP
   * (CLASS-3, #184): tạo payment `component = 'class_fee'` theo cấu
   * hình học phí trên lớp; ghi danh cấp lớp chỉ kích hoạt khi payment
   * succeeded qua webhook/IPN đã xác thực, không ghi danh tại đây.
   */
  @Post('class-fee/:classId')
  async createClassFee(@Param('classId', { schema: uuidIdSchema }) classId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createClassFeePayment(actor.id, classId);
  }
  /**
   * POST /payments/plans — mua/nâng GÓI (lát 2, issue #189): thân gồm
   * loại gói (`tenant_plan` | `teacher_plan`) và `couponCode` tuỳ
   * chọn; số tiền do hệ thống lấy từ CẤU HÌNH giá tại thời điểm giao
   * dịch (component `payments` ở Cài đặt hệ thống) trừ mức giảm của
   * coupon nếu có, client không gửi amount. Payment sinh ra chạy
   * đúng pipeline VietQR/IPN như mọi component khác; quyền lợi gói chỉ
   * kích hoạt khi payment succeeded qua đường đã xác thực.
   */
  @Post('plans')
  async purchasePlan(@Body({ schema: purchasePlanSchema }) dto: PurchasePlanDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createPlanPayment(actor.id, dto);
  }
  /**
   * Bề mặt quản trị COUPON (phần còn lại của lát 2, issue #189): tạo,
   * liệt kê, xem và cập nhật coupon giảm giá cho đường mua gói. Mọi
   * route đều gác bằng capability `payment:managecoupons` trong
   * service (chỉ quản trị platform). Khai báo TRƯỚC các route `:id`
   * của payment để đoạn tĩnh `coupons` không bị nuốt vào tham số id.
   */
  @Post('coupons')
  async createCoupon(@Body({ schema: createCouponSchema }) dto: CreateCouponDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createCoupon(actor.id, dto);
  }
  @Get('coupons')
  async listCoupons(@CurrentUser() actor: AuthenticatedUser) { return this.payments.listCoupons(actor.id); }
  @Get('coupons/:id')
  async getCoupon(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.getCoupon(actor.id, id);
  }
  @Patch('coupons/:id')
  async updateCoupon(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateCouponSchema }) dto: UpdateCouponDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.updateCoupon(actor.id, id, dto);
  }
  /**
   * GET /payments/plans/me — quyền lợi gói của chính người gọi: gói
   * giáo viên của họ + gói trung tâm của tenant hiệu lực.
   */
  @Get('plans/me')
  async myPlans(@CurrentUser() actor: AuthenticatedUser) { return this.payments.listMyPlanEntitlements(actor.id); }
  @Get('me')
  async mine(@CurrentUser() actor: AuthenticatedUser) { return this.payments.listPaymentsForUser(actor.id); }
  /**
   * GET /payments/review-queue — hàng đợi `needs_review` trong phạm
   * vi chủ tiền của người gọi (tiền gói ở platform, học phí ở trung
   * tâm của họ). Khai báo TRƯỚC route `:id` để đoạn tĩnh không bị
   * nuốt vào tham số id.
   */
  @Get('review-queue')
  async reviewQueue(@CurrentUser() actor: AuthenticatedUser) { return this.payments.listReviewQueue(actor.id); }
  @Get(':id')
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) { return this.payments.getPaymentForUser(actor.id, id); }
  @Get(':id/refunds')
  async refunds(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) { return this.payments.listRefundsForUser(actor.id, id); }
  /**
   * POST /payments/:id/refunds — tạo YÊU CẦU hoàn (bước 1 của vòng
   * đời, lát 3 issue #189): cổng cộng dồn nguyên tử + quyết cấp duyệt
   * nằm ở service; khoản hoàn một cấp tự duyệt ngay, khoản hai cấp ở
   * trạng thái `requested` chờ người duyệt khác người tạo.
   */
  @Post(':id/refunds')
  async createRefund(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createRefundSchema }) dto: RefundDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createRefund(actor.id, id, dto);
  }
  /** POST /payments/:id/refunds/:refundId/approve — duyệt cấp 2 (người duyệt phải khác người tạo, chặn ở service). */
  @Post(':id/refunds/:refundId/approve')
  async approveRefund(@Param('id', { schema: uuidIdSchema }) id: string, @Param('refundId', { schema: uuidIdSchema }) refundId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.approveRefund(actor.id, id, refundId);
  }
  /** POST /payments/:id/refunds/:refundId/reject — từ chối yêu cầu hoàn, lý do bắt buộc. */
  @Post(':id/refunds/:refundId/reject')
  async rejectRefund(@Param('id', { schema: uuidIdSchema }) id: string, @Param('refundId', { schema: uuidIdSchema }) refundId: string, @Body({ schema: rejectRefundSchema }) dto: RejectRefundDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.rejectRefund(actor.id, id, refundId, dto);
  }
  /**
   * POST /payments/:id/refunds/:refundId/settle — xác nhận chi TAY:
   * mốc duy nhất đảo quyền lợi khi cộng dồn đã chi đạt 100% (thứ tự
   * đình chỉ-trước-ghi-sau ở service). Đường tự động qua sự kiện
   * `debit` của SePay không qua route này.
   */
  @Post(':id/refunds/:refundId/settle')
  async settleRefund(@Param('id', { schema: uuidIdSchema }) id: string, @Param('refundId', { schema: uuidIdSchema }) refundId: string, @Body({ schema: settleRefundSchema }) dto: SettleRefundDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.settleRefund(actor.id, id, refundId, dto);
  }
  /**
   * POST /payments/:id/review — xử lý tay một khoản thu đang
   * `needs_review`: `matched` khớp về `succeeded` (kích hoạt quyền
   * lợi qua outbox như đường khớp tự động) hoặc `rejected` bác bỏ về
   * `failed`; lý do bắt buộc, vết xử lý ghi lên khoản thu.
   */
  @Post(':id/review')
  async resolveReview(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: resolvePaymentReviewSchema }) dto: ResolvePaymentReviewDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.resolvePaymentReview(actor.id, id, dto);
  }
  /**
   * Webhook của gateway — không dùng JWT. Tính đúng đắn dựa trên XÁC THỰC
   * của gateway (service gọi gateway.verify TRƯỚC mọi xử lý — với 'manual'
   * là shared-secret header `x-payment-webhook-secret`), sau đó mới tới
   * idempotency theo external tx id (vá H1, issue #134).
   */
  @Public()
  @Post('webhook')
  async webhook(@Body({ schema: paymentWebhookSchema }) dto: WebhookDto, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.payments.handleWebhook({ gateway: dto.gateway, externalTransactionId: dto.externalTransactionId, paymentId: dto.paymentId, status: dto.status }, headers);
  }
  /**
   * IPN SePay (lát 1 VietQR, #189): không dùng JWT — cổng là allowlist IP +
   * header `Authorization: Apikey …` kiểm trong service sau khi định tuyến
   * theo bank_account_xid. Thân IPN là định dạng của SePay nên KHÔNG qua
   * zod schema của hệ thống; handler chỉ ghi sự kiện rồi trả {success:true},
   * matching chạy bất đồng bộ ở điểm quét phía worker (issue #539).
   */
  @Public()
  @Post('ipn/sepay')
  async sepayIpn(@Req() req: Request) {
    return this.payments.handleSepayIpn({
      ip: req.ip,
      authorization: req.headers.authorization,
      body: (req as { body?: unknown }).body,
    });
  }
}
