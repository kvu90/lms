import { Inject, Injectable, Logger } from '@nestjs/common';
import { OutboxWriterService } from './outbox-writer.service';
import { PaymentsRepository } from './payments.repository';
import { PlanEntitlementsService } from './plan-entitlements.service';
import {
  PAID_CLASS_ENROL_ACTIVATION_PORT,
  PAID_ENROL_ACTIVATION_PORT,
  PAYMENT_SETTLEMENT_PORT,
  type PaidClassEnrolActivationPort,
  type PaidEnrolActivationPort,
  type PaymentSettlementPort,
} from './sepay-matching-ports';

/**
 * Matching bất đồng bộ cho IPN SePay (lát 1 VietQR, issue #189 — hồ sơ
 * payment-vietqr §6.2/§2.4): sự kiện đã ghi ở `payment_provider_events`
 * (match_status `received`) được khớ theo luật 3 điều kiện — (1) mã thanh
 * toán trích từ nội dung chuẩn hoá tìm thấy payment, (2) số tiền bằng đúng,
 * (3) tài khoản nhận trùng account của payment — cộng payment còn `pending`
 * và chưa hết hạn. Cộng thêm phép đối chiếu phòng thủ chiều sâu (issue
 * #419): payment phải khớp giá + tenant phía server của đối tượng đích
 * (cổng đối chiếu đích `PaymentSettlementPort.verifyPaymentAgainstServerTarget`
 * — cài đặt hiện hành là `PaymentsService` phía apps/api) — ba điều kiện
 * khớp chỉ đối chiếu payment với sự kiện tiền về, một payment tự đặt
 * số tiền thấp vẫn tự khớp với chính nó nên chưa đủ để kích hoạt. Đủ:
 * kích hoạt MỌI quyền lợi (enrol có phí / ghi danh
 * lớp / quyền lợi gói) TRƯỚC, rồi mới lật payment → `succeeded` và phát
 * ĐÚNG outbox `payment_succeeded` sẵn có (cùng khuôn với webhook
 * manual). Thứ tự này giữ BẤT BIẾN ĐỒNG BỘ của nhịp chốt: trạng thái
 * `succeeded` không bao giờ quan sát được khi quyền lợi chưa kích
 * hoạt — nhịp chết giữa chừng thì payment còn `pending`, sự kiện được
 * nhận lại theo cửa sổ stale và các khâu kích hoạt (đều idempotent)
 * chạy lại cho tới khi chốt xong. Thiếu bất kỳ điều
 * kiện nào: sự kiện (và payment nếu xác định được mà còn pending) →
 * `needs_review`, KHÔNG kích hoạt gì (§5.7).
 *
 * Lát 3 (#189): biến động `debit` (tiền RA khỏi tài khoản) không còn bị
 * `ignored` — nó là bằng chứng lệnh chi của một khoản hoàn và được uỷ
 * thác cho cổng xác nhận chi `PaymentSettlementPort.settleRefundFromDebitEvent`
 * (cài đặt hiện hành là `PaymentsService` phía apps/api) đối khớp theo
 * (mã lệnh chi, tài khoản, số tiền) với dòng hoàn đang `approved`:
 * khớp ⇒ dòng hoàn `settled` (đảo quyền lợi nếu cộng dồn đạt 100%) và
 * sự kiện `matched`; không khớp ⇒ sự kiện vào `needs_review` của tenant
 * sở hữu tài khoản nhận để vận hành xử lý, không im lặng bỏ qua.
 *
 * CLASS-3 (#184): payment `class_fee` khớp đủ 3 điều kiện cũng đi đúng
 * đường này — kích hoạt ghi danh CẤP LỚP qua cổng
 * `PaidClassEnrolActivationPort.activatePaidClassEnrol` (cài đặt hiện
 * hành là `ClassesService` phía apps/api: vào backing cohort, cohort
 * sync vật chất hoá xuống mọi khoá của lớp) trước nhịp lật `succeeded`;
 * thiếu điều kiện → `needs_review` và KHÔNG vào lớp, như enrol_fee.
 *
 * Lát 2 (#189): payment gói `tenant_plan`/`teacher_plan` khớp đủ 3
 * điều kiện cũng đi đúng đường này — kích hoạt quyền lợi gói qua
 * `PlanEntitlementsService.activateForPayment` trước nhịp lật
 * `succeeded`; thiếu điều kiện → `needs_review` và KHÔNG sinh quyền
 * lợi, như các component khác.
 *
 * Issue #538 (issue con của #522): service này thuộc bề mặt matching
 * dùng chung của package `@lms/payments` — cùng package với
 * `PaymentsRepository`, `PlanEntitlementsService` và bề mặt phát
 * outbox `OutboxWriterService`. Ba hiệu ứng xuyên module (kích hoạt
 * ghi danh, kích hoạt ghi danh cấp lớp, đối chiếu đích và xác nhận
 * chi) nằm sau các cổng được tiêm ở `sepay-matching-ports.ts`; cài
 * đặt cổng phía apps/api là chính các service hiện hành, nối trong
 * `PaymentsModule` — luật matching chỉ tồn tại đúng một bản ở đây.
 * Việc trích xuất bảo toàn hành vi: luồng dưới đây không đổi so với
 * bản phía apps/api trước khi chuyển.
 */
@Injectable()
export class SepayMatchingService {
  private readonly logger = new Logger(SepayMatchingService.name);

  constructor(
    private readonly repo: PaymentsRepository,
    private readonly outbox: OutboxWriterService,
    @Inject(PAID_ENROL_ACTIVATION_PORT) private readonly enrol: PaidEnrolActivationPort,
    @Inject(PAID_CLASS_ENROL_ACTIVATION_PORT) private readonly classes: PaidClassEnrolActivationPort,
    private readonly plans: PlanEntitlementsService,
    @Inject(PAYMENT_SETTLEMENT_PORT) private readonly payments: PaymentSettlementPort,
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
      // Lát 3 (#189): tiền ra = bằng chứng lệnh chi hoàn — đối khớp với
      // dòng hoàn đang chờ xác nhận; không khớp thì vào hàng đợi
      // `needs_review` của chủ tài khoản (xem cổng xác nhận chi
      // `PaymentSettlementPort`).
      await this.payments.settleRefundFromDebitEvent(event);
      return;
    }
    const raw = (event.raw ?? {}) as Record<string, unknown>;
    const referenceCode = String(raw.reference_code ?? raw.referenceCode ?? event.externalTransactionId);
    const payment = event.extractedCode ? await this.repo.getPaymentByCode(event.extractedCode) : undefined;

    // Hoàn tất idempotent: payment đã succeeded bởi chính giao dịch này
    // (nhịp trước chết sau khi lật trạng thái, trước khi chốt sự kiện —
    // quyền lợi chắc chắn đã kích hoạt vì khâu kích hoạt chạy TRƯỚC
    // nhịp lật trạng thái).
    if (payment && payment.status === 'succeeded' && payment.externalTransactionId === referenceCode) {
      await this.repo.updateProviderEvent(event.id, { matchStatus: 'matched', matchedPaymentId: payment.id });
      return;
    }

    const accountMatches = !!payment && !!event.accountId && payment.accountId === event.accountId;
    const amountMatches = !!payment && payment.amount === event.amount;
    const stillPending = !!payment && payment.status === 'pending';
    const notExpired = !!payment && !(payment.expiresAt && payment.expiresAt.getTime() <= Date.now());

    // Đối chiếu phòng thủ chiều sâu (issue #419): khớp đủ các điều
    // kiện trên mới chứng minh tiền về đúng payment, chưa chứng minh
    // payment khớp GIÁ + TENANT phía server của đối tượng đích —
    // một payment tự đặt số tiền thấp hơn giá thật cũng khớp với
    // chính nó ở cả ba điều kiện. Trước khi kích hoạt phải đối
    // chiếu payment với đối tượng phía server; lệch thì rơi xuống
    // nhánh `needs_review` ở dưới như mọi ca thiếu điều kiện khác,
    // TUYỆT ĐỐI không kích hoạt.
    const targetVerified = payment && accountMatches && amountMatches && stillPending && notExpired
      ? await this.payments.verifyPaymentAgainstServerTarget(payment)
      : false;

    if (payment && accountMatches && amountMatches && stillPending && notExpired && targetVerified) {
      // Kích hoạt MỌI quyền lợi TRƯỚC nhịp lật trạng thái (bất biến
      // đồng bộ của nhịp chốt, xem docblock đầu file): chừng nào
      // payment còn `pending` thì chưa bên nào được coi giao dịch đã
      // thành công; kích hoạt xong mới lật `succeeded`. Cả ba khâu
      // kích hoạt đều idempotent — nhịp chết giữa chừng được nhận lại
      // theo cửa sổ stale của claim và chạy lại an toàn.
      if (payment.component === 'enrol_fee' && payment.itemId) {
        await this.enrol.activatePaidEnrol(payment.itemId, payment.userId);
      }
      // CLASS-3: gói lớp — kích hoạt ghi danh cấp lớp (idempotent).
      if (payment.component === 'class_fee' && payment.itemId) {
        await this.classes.activatePaidClassEnrol(payment.itemId, payment.userId);
      }
      // Lát 2 (#189): gói trung tâm / gói giáo viên — kích hoạt quyền
      // lợi gói (idempotent theo payment; cửa sổ nối tiếp khi mua tiếp).
      if (payment.component === 'tenant_plan' || payment.component === 'teacher_plan') {
        await this.plans.activateForPayment(payment);
      }
      await this.repo.updatePayment(payment.id, { status: 'succeeded', externalTransactionId: referenceCode });
      const succeeded = await this.repo.getPayment(payment.id);
      await this.outbox.enqueueStandalone({
        aggregate: 'payment', type: 'payment_succeeded',
        payload: {
          paymentId: succeeded!.id, userId: succeeded!.userId, amount: succeeded!.amount, currency: succeeded!.currency,
          component: succeeded!.component, itemId: succeeded!.itemId, externalTransactionId: referenceCode,
        },
      });
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
