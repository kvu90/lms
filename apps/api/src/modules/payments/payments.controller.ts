import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { createPaymentAccountSchema, createPaymentSchema, createRefundSchema, paymentWebhookSchema, type CreateAccountDto, type CreatePaymentDto, type RefundDto, type WebhookDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';

/** Controller thanh toán: accounts, payments, webhook (public, idempotent), refunds, IPN SePay. */
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
  @Get('me')
  async mine(@CurrentUser() actor: AuthenticatedUser) { return this.payments.listPaymentsForUser(actor.id); }
  @Get(':id')
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) { return this.payments.getPaymentForUser(actor.id, id); }
  @Get(':id/refunds')
  async refunds(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) { return this.payments.listRefundsForUser(actor.id, id); }
  @Post(':id/refund')
  async refund(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createRefundSchema }) dto: RefundDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.refund(actor.id, id, dto);
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
   * matching chạy bất đồng bộ ở SepayIpnConsumer.
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
