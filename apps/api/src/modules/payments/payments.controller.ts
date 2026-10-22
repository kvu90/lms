import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { CreateAccountDto, CreatePaymentDto, RefundDto, WebhookDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';

/** Controller thanh toán: accounts, payments, webhook (public, idempotent), refunds. */
@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Post('accounts')
  async createAccount(@Body() dto: CreateAccountDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createAccount(actor.id, dto);
  }
  @Get('accounts')
  async listAccounts() { return this.payments.listAccounts(); }
  @Post()
  async create(@Body() dto: CreatePaymentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createPayment(actor.id, dto);
  }
  @Post('fee/:instanceId')
  async createFee(@Param('instanceId', ParseIntPipe) instanceId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.createFeePayment(actor.id, instanceId);
  }
  @Get('me')
  async mine(@CurrentUser() actor: AuthenticatedUser) { return this.payments.listPaymentsForUser(actor.id); }
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) { return this.payments.getPayment(id); }
  @Get(':id/refunds')
  async refunds(@Param('id', ParseIntPipe) id: number) { return this.payments.listRefunds(id); }
  @Post(':id/refund')
  async refund(@Param('id', ParseIntPipe) id: number, @Body() dto: RefundDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.payments.refund(actor.id, id, dto);
  }
  /** Webhook của gateway — không dùng JWT, tính đúng đắn dựa trên idempotency theo external tx id. */
  @Public()
  @Post('webhook')
  async webhook(@Body() dto: WebhookDto) {
    return this.payments.handleWebhook({ gateway: dto.gateway, externalTransactionId: dto.externalTransactionId, paymentId: dto.paymentId, status: dto.status });
  }
}
