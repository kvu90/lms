import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { createPaymentAccountSchema, createPaymentSchema, createRefundSchema, paymentWebhookSchema, type CreateAccountDto, type CreatePaymentDto, type RefundDto, type WebhookDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';

/** Controller thanh toán: accounts, payments, webhook (public, idempotent), refunds. */
@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Post('accounts')
  async createAccount(@Body({ schema: createPaymentAccountSchema }) dto: CreateAccountDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createAccount(actor.id, dto);
  }
  @Get('accounts')
  async listAccounts() { return this.payments.listAccounts(); }
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
  async get(@Param('id', { schema: uuidIdSchema }) id: string) { return this.payments.getPayment(id); }
  @Get(':id/refunds')
  async refunds(@Param('id', { schema: uuidIdSchema }) id: string) { return this.payments.listRefunds(id); }
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
}
