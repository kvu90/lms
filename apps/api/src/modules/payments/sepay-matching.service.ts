import { Injectable, Logger } from '@nestjs/common';
import { OutboxService } from '../../infra/events/outbox.service';
import { ClassesService } from '../classes/classes.service';
import { EnrolService } from '../enrol/enrol.service';
import { PaymentsRepository, type ProviderEventRow } from './payments.repository';
import { PlanEntitlementsService } from './plan-entitlements.service';

/**
 * Matching bất đồng bộ cho IPN SePay (lát 1 VietQR, issue #189 — hồ sơ
 * payment-vietqr §6.2/§2.4): sự kiện đã ghi ở `payment_provider_events`
 * (match_status `received`) được khớ theo luật 3 điều kiện — (1) mã thanh
 * toán trích từ nội dung chuẩn hoá tìm thấy payment, (2) số tiền bằng đúng,
 * (3) tài khoản nhận trùng account của payment — cộng payment còn `pending`
 * và chưa hết hạn. Đủ: payment → `succeeded`, phát ĐÚNG outbox
 * `payment_succeeded` sẵn có (đường kích hoạt quyền lợi duy nhất, cùng
 * khuôn với webhook manual) rồi kích hoạt enrol có phí. Thiếu bất kỳ điều
 * kiện nào: sự kiện (và payment nếu xác định được mà còn pending) →
 * `needs_review`, KHÔNG kích hoạt gì (§5.7). Biến động debit không qua
 * matching tiền vào — đối khớp lệnh chi hoàn thuộc lát 3; ở lát 1 sự kiện
 * debit được đánh dấu `ignored` nhưng vẫn nằm trong sổ làm bằng chứng.
 *
 * CLASS-3 (#184): payment `class_fee` khớp đủ 3 điều kiện cũng đi đúng
 * đường này — succeeded → kích hoạt ghi danh CẤP LỚP qua
 * `ClassesService.activatePaidClassEnrol` (vào backing cohort, cohort
 * sync vật chất hoá xuống mọi khoá của lớp); thiếu điều kiện →
 * `needs_review` và KHÔNG vào lớp, như enrol_fee.
 *
 * Lát 2 (#189): payment gói `tenant_plan`/`teacher_plan` khớp đủ 3
 * điều kiện cũng đi đúng đường này — succeeded → kích hoạt quyền lợi
 * gói qua `PlanEntitlementsService.activateForPayment`; thiếu điều
 * kiện → `needs_review` và KHÔNG sinh quyền lợi, như các component khác.
 */
@Injectable()
export class SepayMatchingService {
  private readonly logger = new Logger(SepayMatchingService.name);

  constructor(
    private readonly repo: PaymentsRepository,
    private readonly outbox: OutboxService,
    private readonly enrol: EnrolService,
    private readonly classes: ClassesService,
    private readonly plans: PlanEntitlementsService,
  ) {}

  /** Quét một nhịp: xử lý tối đa `limit` sự kiện đang chờ. Trả số sự kiện đã xử lý. */
  async sweep(limit = 20): Promise<number> {
    const staleBefore = new Date(Date.now() - 60_000);
    const pending = await this.repo.listPendingProviderEvents(limit, staleBefore);
    let processed = 0;
    for (const event of pending) {
      try {
        await this.processEvent(event.id);
        processed += 1;
      } catch (error) {
        // Sự kiện lỗi ở trạng thái processing treo sẽ được nhịp sau nhận lại
        // theo cửa sổ stale — không để một sự kiện hỏng chặn cả hàng đợi.
        this.logger.warn(`Matching sự kiện SePay ${event.id} lỗi: ${(error as Error).message}`);
      }
    }
    return processed;
  }

  /** Xử lý một sự kiện: nhận việc (claim) rồi áp luật khớp. */
  async processEvent(eventId: string): Promise<void> {
    if (!(await this.repo.claimProviderEvent(eventId))) return;
    const event = await this.repo.getProviderEvent(eventId);
    if (!event) return;
    if (event.direction === 'debit') {
      await this.repo.updateProviderEvent(event.id, { matchStatus: 'ignored' });
      return;
    }
    const raw = (event.raw ?? {}) as Record<string, unknown>;
    const referenceCode = String(raw.reference_code ?? raw.referenceCode ?? event.externalTransactionId);
    const payment = event.extractedCode ? await this.repo.getPaymentByCode(event.extractedCode) : undefined;

    // Hoàn tất idempotent: payment đã succeeded bởi chính giao dịch này
    // (nhịp trước chết sau khi kích hoạt, trước khi chốt sự kiện).
    if (payment && payment.status === 'succeeded' && payment.externalTransactionId === referenceCode) {
      await this.repo.updateProviderEvent(event.id, { matchStatus: 'matched', matchedPaymentId: payment.id });
      return;
    }

    const accountMatches = !!payment && !!event.accountId && payment.accountId === event.accountId;
    const amountMatches = !!payment && payment.amount === event.amount;
    const stillPending = !!payment && payment.status === 'pending';
    const notExpired = !!payment && !(payment.expiresAt && payment.expiresAt.getTime() <= Date.now());

    if (payment && accountMatches && amountMatches && stillPending && notExpired) {
      await this.repo.updatePayment(payment.id, { status: 'succeeded', externalTransactionId: referenceCode });
      const succeeded = await this.repo.getPayment(payment.id);
      await this.outbox.enqueueStandalone({
        aggregate: 'payment', type: 'payment_succeeded',
        payload: {
          paymentId: succeeded!.id, userId: succeeded!.userId, amount: succeeded!.amount, currency: succeeded!.currency,
          component: succeeded!.component, itemId: succeeded!.itemId, externalTransactionId: referenceCode,
        },
      });
      if (succeeded!.component === 'enrol_fee' && succeeded!.itemId) {
        await this.enrol.activatePaidEnrol(succeeded!.itemId, succeeded!.userId);
      }
      // CLASS-3: gói lớp — kích hoạt ghi danh cấp lớp (idempotent).
      if (succeeded!.component === 'class_fee' && succeeded!.itemId) {
        await this.classes.activatePaidClassEnrol(succeeded!.itemId, succeeded!.userId);
      }
      // Lát 2 (#189): gói trung tâm / gói giáo viên — kích hoạt quyền
      // lợi gói (idempotent theo payment; cửa sổ nối tiếp khi mua tiếp).
      if (succeeded!.component === 'tenant_plan' || succeeded!.component === 'teacher_plan') {
        await this.plans.activateForPayment(succeeded!);
      }
      await this.repo.updateProviderEvent(event.id, { matchStatus: 'matched', matchedPaymentId: payment.id });
      return;
    }

    // Thiếu ít nhất một điều kiện → hàng đợi needs_review (§5.7): payment
    // còn pending thì lật sang needs_review để chặn kích hoạt muộn; payment
    // đã kết thúc (succeeded/refunded…) giữ nguyên trạng thái.
    if (payment && payment.status === 'pending') {
      await this.repo.updatePayment(payment.id, { status: 'needs_review' });
    }
    await this.repo.updateProviderEvent(event.id, {
      matchStatus: 'needs_review',
      matchedPaymentId: payment?.id ?? null,
    });
  }
}
