import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { EnrolService } from '../enrol/enrol.service';
import { PaymentsRepository, type AccountRow, type PaymentRow, type RefundRow } from './payments.repository';

/** Tên header mang shared secret xác thực webhook của gateway 'manual'. */
export const PAYMENT_WEBHOOK_SECRET_HEADER = 'x-payment-webhook-secret';

/** Dữ kiện của một lần gọi webhook mà gateway dùng để xác thực nguồn gốc. */
export interface PaymentWebhookVerificationInput {
  externalTransactionId: string;
  paymentId: string;
  status: string;
  /** Header HTTP của request webhook (tên header đã được Node thường hoá). */
  headers: Record<string, string | string[] | undefined>;
}

/** PORT của payment gateway — adapter manual/fake dùng cho test và vận hành thủ công. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
export interface PaymentGateway {
  name: string;
  /**
   * Xác thực một webhook đúng là của gateway. Đây là cổng BẮT BUỘC của
   * đường webhook (vá H1, issue #134): `handleWebhook` gọi verify TRƯỚC
   * mọi xử lý — false ⇒ từ chối, không đổi trạng thái payment, không phát
   * sự kiện, không kích hoạt nghiệp vụ hưởng lợi (enrol có phí).
   */
  verify(input: PaymentWebhookVerificationInput): Promise<boolean>;
}

/**
 * Adapter manual: không gọi mạng; xác thực bằng shared secret cấu hình qua
 * biến môi trường `PAYMENT_WEBHOOK_SECRET`, mang trong header
 * `x-payment-webhook-secret`, so sánh hằng-thời-gian. Chưa cấu hình secret
 * ⇒ verify LUÔN false (fail-closed): tuyệt đối không có chế độ "chưa có
 * gateway thật thì bỏ qua verify".
 */
@Injectable()
export class ManualPaymentGateway implements PaymentGateway {
  name = 'manual';
  constructor(private readonly config: ConfigService) {}
  async verify(input: PaymentWebhookVerificationInput): Promise<boolean> {
    if (input.externalTransactionId.length === 0) return false;
    const expected = this.config.get<string>('PAYMENT_WEBHOOK_SECRET');
    if (!expected) return false;
    const raw = input.headers[PAYMENT_WEBHOOK_SECRET_HEADER];
    const given = Array.isArray(raw) ? raw[0] : raw;
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/**
 * PaymentsModule facade (Moodle core_payment, §2#27).
 * Bất biến: amount là số nguyên đơn vị nhỏ nhất + currency (không float);
 * payment thành công là bất biến — hoàn tiền là giao dịch bù trừ riêng;
 * webhook idempotent theo external transaction id (replay không xử lý 2 lần);
 * nghiệp vụ hưởng lợi (enrol có phí) chỉ kích hoạt qua PaymentSucceeded
 * của một webhook ĐÃ QUA gateway.verify (H1, #134).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly repo: PaymentsRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly outbox: OutboxService,
    private readonly enrol: EnrolService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  private async requireManageAccounts(actorId: string): Promise<void> {
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'payment:manageaccounts', sys.id);
  }

  async createAccount(actorId: string, input: { name: string; gateway?: string }): Promise<AccountRow> {
    await this.requireManageAccounts(actorId);
    return this.repo.insertAccount({ name: input.name, gateway: input.gateway ?? 'manual' });
  }
  async listAccounts(): Promise<AccountRow[]> { return this.repo.listAccounts(); }
  async getAccount(id: string): Promise<AccountRow> {
    const row = await this.repo.getAccount(id);
    if (!row) throw new NotFoundException({ message: `Payment account ${id} not found`, code: 'payment.account_not_found' });
    return row;
  }
  async getPayment(id: string): Promise<PaymentRow> {
    const row = await this.repo.getPayment(id);
    if (!row) throw new NotFoundException({ message: `Payment ${id} not found`, code: 'payment.not_found' });
    return row;
  }

  /** Tạo payment ở trạng thái pending cho một user. */
  async createPayment(userId: string, input: { accountId: string; amount: number; currency: string; component?: string; itemId?: string }): Promise<PaymentRow> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BadRequestException({ message: 'Amount must be a positive integer in the smallest currency unit', code: 'payment.amount_not_integer' });
    }
    const account = await this.getAccount(input.accountId);
    if (!account.enabled) throw new BadRequestException({ message: 'Payment account is disabled', code: 'payment.account_disabled' });
    return this.repo.insertPayment({
      accountId: input.accountId, userId: userId, amount: input.amount, currency: input.currency.toUpperCase(),
      status: 'pending', gateway: account.gateway, component: input.component ?? '', itemId: input.itemId ?? null,
    });
  }

  /** Tạo payment cho một enrol instance có phí, lấy amount/currency từ config của instance. */
  async createFeePayment(userId: string, enrolInstanceId: string): Promise<PaymentRow> {
    const instance = await this.enrol.getInstance(enrolInstanceId);
    if (instance.enrol !== 'fee' || !instance.cost || instance.cost <= 0) {
      throw new BadRequestException({ message: 'Enrol instance has no fee configured', code: 'payment.no_fee' });
    }
    const accountId = instance.paymentAccountId ?? (await this.repo.listAccounts())[0]?.id;
    if (!accountId) throw new BadRequestException({ message: 'No payment account configured for this fee enrol instance', code: 'payment.no_account' });
    return this.createPayment(userId, { accountId: accountId, amount: instance.cost, currency: instance.currency || 'VND', component: 'enrol_fee', itemId: enrolInstanceId });
  }

  /**
   * Xử lý webhook. CỔNG XÁC THỰC CHẠY TRƯỚC TIÊN (vá H1, issue #134):
   * resolve gateway theo `input.gateway` rồi gọi `gateway.verify` — gateway
   * lạ ⇒ 400; verify fail ⇒ 401. Cả hai đều xảy ra TRƯỚC mọi đọc/ghi trạng
   * thái payment: không đổi status, không phát outbox, không kích hoạt
   * enrol — kể cả với payload `status: 'failed'` (webhook giả mạo không
   * được phép đánh rớt payment thật). Qua cổng mới tới idempotency theo
   * (gateway, externalTransactionId): replay ⇒ trả duplicate và KHÔNG
   * phát lại sự kiện, KHÔNG kích hoạt lại enrol.
   */
  async handleWebhook(input: { gateway: string; externalTransactionId: string; paymentId: string; status: string }, headers: Record<string, string | string[] | undefined> = {}): Promise<{ status: string; duplicate?: boolean; payment: PaymentRow }> {
    if (input.gateway !== this.gateway.name) {
      throw new BadRequestException({ message: `Unknown payment gateway: ${input.gateway}`, code: 'payment.webhook_unknown_gateway' });
    }
    const verified = await this.gateway.verify({ externalTransactionId: input.externalTransactionId, paymentId: input.paymentId, status: input.status, headers });
    if (!verified) {
      throw new UnauthorizedException({ message: 'Payment webhook verification failed', code: 'payment.webhook_verification_failed' });
    }
    const existing = await this.repo.getByExternalTx(input.gateway, input.externalTransactionId);
    if (existing) return { status: existing.status, duplicate: true, payment: existing };
    const payment = await this.getPayment(input.paymentId);
    if (payment.status === 'succeeded') return { status: 'succeeded', duplicate: true, payment };
    if (input.status !== 'succeeded') {
      await this.repo.updatePayment(payment.id, { status: 'failed', gateway: input.gateway, externalTransactionId: input.externalTransactionId });
      return { status: 'failed', payment: await this.getPayment(payment.id) };
    }
    await this.repo.updatePayment(payment.id, { status: 'succeeded', gateway: input.gateway, externalTransactionId: input.externalTransactionId });
    const succeeded = await this.getPayment(payment.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'payment', type: 'payment_succeeded',
      payload: { paymentId: succeeded.id, userId: succeeded.userId, amount: succeeded.amount, currency: succeeded.currency, component: succeeded.component, itemId: succeeded.itemId, externalTransactionId: input.externalTransactionId },
    });
    // Nghiệp vụ hưởng lợi: enrol có phí chỉ active sau PaymentSucceeded đã xác thực.
    if (succeeded.component === 'enrol_fee' && succeeded.itemId) {
      await this.enrol.activatePaidEnrol(succeeded.itemId, succeeded.userId);
    }
    return { status: 'succeeded', payment: succeeded };
  }

  /** Hoàn tiền: tạo refund riêng, payment gốc chỉ đổi status sang refunded (không sửa amount). */
  async refund(actorId: string, paymentId: string, input: { amount: number; reason?: string; externalTransactionId?: string }): Promise<RefundRow> {
    await this.requireManageAccounts(actorId);
    const payment = await this.getPayment(paymentId);
    if (payment.status !== 'succeeded') throw new BadRequestException({ message: 'Only a succeeded payment can be refunded', code: 'payment.not_succeeded' });
    if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > payment.amount) {
      throw new BadRequestException({ message: 'Refund amount must be a positive integer not exceeding the payment amount', code: 'payment.bad_refund_amount' });
    }
    const refund = await this.repo.insertRefund({
      paymentId: payment.id, amount: input.amount, currency: payment.currency,
      reason: input.reason ?? '', externalTransactionId: input.externalTransactionId ?? null,
    });
    if (input.amount === payment.amount) await this.repo.updatePayment(payment.id, { status: 'refunded' });
    return refund;
  }
  async listRefunds(paymentId: string): Promise<RefundRow[]> { return this.repo.listRefunds(paymentId); }
  async listPaymentsForUser(userId: string): Promise<PaymentRow[]> { return this.repo.listPaymentsForUser(userId); }

  /** Đối soát tối giản ở worker: đếm payment succeeded chưa có external tx (cần rà soát). */
  async reconcile(): Promise<{ total: number; succeeded: number; pendingWithoutExternalTx: number }> {
    const all = await this.repo.listPayments();
    return {
      total: all.length,
      succeeded: all.filter((p) => p.status === 'succeeded').length,
      pendingWithoutExternalTx: all.filter((p) => p.status === 'pending' && !p.externalTransactionId).length,
    };
  }
}
