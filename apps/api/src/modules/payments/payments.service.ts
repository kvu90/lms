import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { EnrolService } from '../enrol/enrol.service';
import { PaymentsRepository, type AccountRow, type PaymentRow, type RefundRow } from './payments.repository';

/** PORT của payment gateway — adapter manual/fake dùng cho test và vận hành thủ công. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
export interface PaymentGateway {
  name: string;
  /** Xác thực một webhook payload là của gateway (bản manual: luôn đúng khi có external tx id). */
  verify(input: { externalTransactionId: string }): Promise<boolean>;
}
/** Adapter manual/fake: không gọi mạng, xác thực dựa trên external transaction id có mặt. */
@Injectable()
export class ManualPaymentGateway implements PaymentGateway {
  name = 'manual';
  async verify(input: { externalTransactionId: string }): Promise<boolean> { return input.externalTransactionId.length > 0; }
}

/**
 * PaymentsModule facade (Moodle core_payment, §2#27).
 * Bất biến: amount là số nguyên đơn vị nhỏ nhất + currency (không float);
 * payment thành công là bất biến — hoàn tiền là giao dịch bù trừ riêng;
 * webhook idempotent theo external transaction id (replay không xử lý 2 lần);
 * nghiệp vụ hưởng lợi (enrol có phí) chỉ kích hoạt qua PaymentSucceeded.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly repo: PaymentsRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly outbox: OutboxService,
    private readonly enrol: EnrolService,
  ) {}

  private async requireManageAccounts(actorId: number): Promise<void> {
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'lms/payment:manageaccounts', sys.id);
  }

  async createAccount(actorId: number, input: { name: string; gateway?: string }): Promise<AccountRow> {
    await this.requireManageAccounts(actorId);
    return this.repo.insertAccount({ name: input.name, gateway: input.gateway ?? 'manual' });
  }
  async listAccounts(): Promise<AccountRow[]> { return this.repo.listAccounts(); }
  async getAccount(id: number): Promise<AccountRow> {
    const row = await this.repo.getAccount(id);
    if (!row) throw new NotFoundException({ message: `Payment account ${id} not found`, code: 'payment.account_not_found' });
    return row;
  }
  async getPayment(id: number): Promise<PaymentRow> {
    const row = await this.repo.getPayment(id);
    if (!row) throw new NotFoundException({ message: `Payment ${id} not found`, code: 'payment.not_found' });
    return row;
  }

  /** Tạo payment ở trạng thái pending cho một user. */
  async createPayment(userId: number, input: { accountid: number; amount: number; currency: string; component?: string; itemid?: number }): Promise<PaymentRow> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BadRequestException({ message: 'Amount must be a positive integer in the smallest currency unit', code: 'payment.amount_not_integer' });
    }
    const account = await this.getAccount(input.accountid);
    if (!account.enabled) throw new BadRequestException({ message: 'Payment account is disabled', code: 'payment.account_disabled' });
    return this.repo.insertPayment({
      accountid: input.accountid, userid: userId, amount: input.amount, currency: input.currency.toUpperCase(),
      status: 'pending', gateway: account.gateway, component: input.component ?? '', itemid: input.itemid ?? 0,
    });
  }

  /** Tạo payment cho một enrol instance có phí, lấy amount/currency từ config của instance. */
  async createFeePayment(userId: number, enrolInstanceId: number): Promise<PaymentRow> {
    const instance = await this.enrol.getInstance(enrolInstanceId);
    if (instance.enrol !== 'fee' || !instance.cost || instance.cost <= 0) {
      throw new BadRequestException({ message: 'Enrol instance has no fee configured', code: 'payment.no_fee' });
    }
    const accountId = instance.paymentaccountid ?? (await this.repo.listAccounts())[0]?.id;
    if (!accountId) throw new BadRequestException({ message: 'No payment account configured for this fee enrol instance', code: 'payment.no_account' });
    return this.createPayment(userId, { accountid: accountId, amount: instance.cost, currency: instance.currency || 'VND', component: 'enrol_fee', itemid: enrolInstanceId });
  }

  /**
   * Xử lý webhook: idempotent theo (gateway, externalTransactionId).
   * Replay ⇒ trả duplicate và KHÔNG phát lại sự kiện, KHÔNG kích hoạt lại enrol.
   */
  async handleWebhook(input: { gateway: string; externalTransactionId: string; paymentId: number; status: string }): Promise<{ status: string; duplicate?: boolean; payment: PaymentRow }> {
    const existing = await this.repo.getByExternalTx(input.gateway, input.externalTransactionId);
    if (existing) return { status: existing.status, duplicate: true, payment: existing };
    const payment = await this.getPayment(input.paymentId);
    if (payment.status === 'succeeded') return { status: 'succeeded', duplicate: true, payment };
    if (input.status !== 'succeeded') {
      await this.repo.updatePayment(payment.id, { status: 'failed', gateway: input.gateway, externaltransactionid: input.externalTransactionId });
      return { status: 'failed', payment: await this.getPayment(payment.id) };
    }
    await this.repo.updatePayment(payment.id, { status: 'succeeded', gateway: input.gateway, externaltransactionid: input.externalTransactionId });
    const succeeded = await this.getPayment(payment.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'payment', type: 'payment_succeeded',
      payload: { paymentId: succeeded.id, userId: succeeded.userid, amount: succeeded.amount, currency: succeeded.currency, component: succeeded.component, itemid: succeeded.itemid, externalTransactionId: input.externalTransactionId },
    });
    // Nghiệp vụ hưởng lợi: enrol có phí chỉ active sau PaymentSucceeded đã xác thực.
    if (succeeded.component === 'enrol_fee' && succeeded.itemid) {
      await this.enrol.activatePaidEnrol(succeeded.itemid, succeeded.userid);
    }
    return { status: 'succeeded', payment: succeeded };
  }

  /** Hoàn tiền: tạo refund riêng, payment gốc chỉ đổi status sang refunded (không sửa amount). */
  async refund(actorId: number, paymentId: number, input: { amount: number; reason?: string; externalTransactionId?: string }): Promise<RefundRow> {
    await this.requireManageAccounts(actorId);
    const payment = await this.getPayment(paymentId);
    if (payment.status !== 'succeeded') throw new BadRequestException({ message: 'Only a succeeded payment can be refunded', code: 'payment.not_succeeded' });
    if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > payment.amount) {
      throw new BadRequestException({ message: 'Refund amount must be a positive integer not exceeding the payment amount', code: 'payment.bad_refund_amount' });
    }
    const refund = await this.repo.insertRefund({
      paymentid: payment.id, amount: input.amount, currency: payment.currency,
      reason: input.reason ?? '', externaltransactionid: input.externalTransactionId ?? null,
    });
    if (input.amount === payment.amount) await this.repo.updatePayment(payment.id, { status: 'refunded' });
    return refund;
  }
  async listRefunds(paymentId: number): Promise<RefundRow[]> { return this.repo.listRefunds(paymentId); }
  async listPaymentsForUser(userId: number): Promise<PaymentRow[]> { return this.repo.listPaymentsForUser(userId); }

  /** Đối soát tối giản ở worker: đếm payment succeeded chưa có external tx (cần rà soát). */
  async reconcile(): Promise<{ total: number; succeeded: number; pendingWithoutExternalTx: number }> {
    const all = await this.repo.listPayments();
    return {
      total: all.length,
      succeeded: all.filter((p) => p.status === 'succeeded').length,
      pendingWithoutExternalTx: all.filter((p) => p.status === 'pending' && !p.externaltransactionid).length,
    };
  }
}
