import { Injectable } from '@nestjs/common';
import { sql, type CentreTx } from '@lms/db';
import {
  ENROL_SUSPENDED,
  ENROL_WITHDRAWN,
  SharedDomainError,
} from '@lms/enrol';
import {
  PaymentsRepository,
  planChargedAmountOf,
  type PaymentRow,
  type ProviderEventRow,
  type RefundRow,
} from '@lms/payments';
import type { PaymentSettlementPort } from '@lms/payments';
import { tenantAls } from './db/tenant-als';
import { WorkerEnrolOutboxService } from './worker-enrol-outbox.service';
import { WorkerPaymentSpaceScope } from './worker-payment-space-scope.service';

/**
 * Slug của tenant platform (tenant-zero) — định danh dữ liệu đã gieo,
 * ghi trong tài liệu schema dùng chung `@lms/db` (`tenants.schema.ts`):
 * tenant-zero là không gian của Trang chính, chủ của dòng tiền gói và
 * của hàng đợi platform. Đọc trực tiếp từ bảng `tenants` để không
 * phụ thuộc service tenant phía API.
 */
const PLATFORM_TENANT_SLUG = 'trang-chinh';

/**
 * Cài đặt phía worker cho cổng đối chiếu đích phía server và xác nhận
 * chi hoàn (`PAYMENT_SETTLEMENT_PORT` — issue con #539 của #522).
 *
 * Gồm hai hiệu ứng của facade thanh toán phía API, dựng lại trên dữ
 * liệu dùng chung `@lms/db` + repository/service của `@lms/payments`
 * (không import gì từ `apps/api`):
 *
 * 1. `verifyPaymentAgainstServerTarget` — phép đối chiếu phòng thủ
 *    chiều sâu của issue #419: giá và bên hưởng chỉ lấy từ đối tượng
 *    phía server, không lấy từ chính payment (payment là dữ kiện có
 *    thể đã bị can thiệp). Đối tượng đích không tồn tại, không còn
 *    cấu hình phí, hoặc ảnh chụp gói thiếu/sai hình dạng đều coi là
 *    KHÔNG khớp (fail-closed): thà đẩy vào `needs_review` còn hơn
 *    kích hoạt một quyền lợi không xác minh được. Riêng hai
 *    component có đích thuộc trung tâm của payment (`enrol_fee`,
 *    `class_fee`) thì lượt đọc đích chạy tại kho của trung tâm đó
 *    qua điểm phân giải không gian theo payment
 *    (`WorkerPaymentSpaceScope` — tiền điều kiện Phần B của issue
 *    #587, hạng mục 2), vì đích của trung tâm đã chuyển kho chỉ
 *    tồn tại ở kho riêng.
 * 2. `settleRefundFromDebitEvent` — xác nhận chi tự động từ một sự
 *    kiện `debit`: đối khớp theo (mã lệnh chi, tài khoản, số tiền)
 *    với dòng hoàn đang `approved`, rồi xác nhận chi qua cùng khâu
 *    dùng chung với đường xác nhận tay (đảo quyền lợi nếu cộng dồn
 *    đạt 100%). Toàn bộ quyết định chạy trong MỘT transaction mở
 *    đầu bằng khoá dòng khoản thu (`FOR UPDATE`) — khoá này tuần tự
 *    hoá mọi lượt xác nhận chi trên cùng khoản thu nên từng bước
 *    luôn thấy trạng thái đã chốt của lượt trước.
 *
 * Ba điểm khác đường API, đều có chủ đích và ghi rõ tại chỗ:
 *
 * - Đình chỉ ghi danh khi hoàn đủ (`enrol_fee`): đường API đi qua
 *   `EnrolService.setSuspended`, vốn gác capability `enrol:manage`
 *   của actor qua `PermissionEvaluator` — bộ đánh giá quyền này
 *   sống trong `apps/api` và không có bản dùng chung để worker
 *   mang theo. Worker là tiến trình hệ thống tin cậy đang thực thi
 *   một quyết định đã chốt (dòng hoàn đã duyệt + sự kiện `debit`
 *   đã xác thực), nên adapter thực hiện ĐÚNG các bước ghi của
 *   `setSuspended` (lật trạng thái + vết modifierId + sự kiện
 *   `user_enrolment_suspended` trong cùng transaction) mà không
 *   kiểm lại capability của actor. Vết actor vẫn giữ nguyên để truy
 *   vết. Điểm này ghi vào thân PR để đội review soi.
 * - Gỡ roster khi hoàn đủ (`class_fee`): đường API phát bù sự kiện
 *   TRONG TIẾN TRÌNH `cohort_member_removed` sau khi transaction
 *   commit để listener đồng bộ của `EnrolModule` áp đình chỉ ngay.
 *   Tiến trình worker không có listener đó nên không phát; dòng
 *   outbox `cohort_member_removed` ghi trong chính transaction là
 *   đường đồng bộ bền (consumer đồng bộ cohort quét hàng đó — phía
 *   API hôm nay, phía worker sau #550) và là đường mà chính tài
 *   liệu của khâu settle API đã khẳng định không phụ thuộc bước
 *   phát nhanh.
 * - Không gửi tin nhắn chào mừng ở chiều kích hoạt lại (không thuộc
 *   cổng này) — xem adapter kích hoạt ghi danh.
 *
 * Idempotent: sự kiện phát lại được nhận diện qua `settled_event_id`
 * đã ghi trên dòng hoàn (coi như đã xử lý, không xác nhận chi hai
 * lần); khâu xác nhận chi đọc lại dòng hoàn dưới khoá nên lượt đua
 * thắng đã ghi thì lượt sau trả nguyên dòng đó; mọi khâu đình chỉ
 * đều idempotent (đình chỉ một ghi danh/quyền lợi đã đình chỉ là
 * no-op) nên gọi lại sau lỗi giữa chừng vẫn an toàn.
 */
@Injectable()
export class WorkerPaymentSettlementService implements PaymentSettlementPort {
  constructor(
    private readonly repo: PaymentsRepository,
    private readonly enrolOutbox: WorkerEnrolOutboxService,
    private readonly spaceScope: WorkerPaymentSpaceScope,
  ) {}

  /** Tenant platform (tenant-zero) — chủ của dòng tiền gói và của hàng đợi platform. */
  private async platformTenantId(): Promise<string> {
    const zero = await this.spaceScope.routedKysely
      .selectFrom('tenants')
      .select('id')
      .where('slug', '=', PLATFORM_TENANT_SLUG)
      .executeTakeFirst();
    if (!zero) {
      throw new SharedDomainError('tenant.platform_missing', 'Platform tenant (tenant-zero) is not seeded');
    }
    return zero.id;
  }

  /**
   * Đối chiếu payment với đối tượng đích phía server (giá + tenant).
   *
   * @param payment - Bản ghi payment sắp được kích hoạt quyền lợi.
   * @returns `true` khi payment mang component thường (không có
   * quyền lợi để đối chiếu) hoặc khớp cả giá lẫn tenant phía
   * server; `false` khi lệch hoặc không xác minh được.
   */
  async verifyPaymentAgainstServerTarget(payment: PaymentRow): Promise<boolean> {
    // Hai component có đối tượng đích thuộc về trung tâm của
    // payment (`enrol_fee`, `class_fee`): đối chiếu phải đọc đối
    // tượng đích tại đúng kho của trung tâm đó — instance/lớp của
    // trung tâm đã chuyển kho chỉ tồn tại ở kho riêng, đọc ở kho
    // chung sẽ kết luận "không tồn tại" và đẩy payment oan vào
    // `needs_review` trước khi kích hoạt được gọi. Phân giải
    // không gian theo từng payment qua cùng điểm phân giải của
    // hai cổng kích hoạt (`WorkerPaymentSpaceScope` — tiền điều
    // kiện Phần B của issue #587, hạng mục 2); lỗi phân giải hoặc
    // chuẩn bị kho đích ném ra (fail-closed) thay vì trả `false`,
    // vì `false` nghĩa là "đích lệch" trong khi đây là "không đọc
    // được đích" — payment ở lại `pending` để nhịp sau thử lại.
    // Các component còn lại giữ nguyên phạm vi platform ở kho
    // chung như trước (đích của payment gói là tenant platform).
    if (payment.component === 'enrol_fee' || payment.component === 'class_fee') {
      return this.spaceScope.runForTenant(payment.tenantId, () =>
        this.verifyTargetInCurrentScope(payment),
      );
    }
    return tenantAls.run({ platform: true }, () => this.verifyTargetInCurrentScope(payment));
  }

  /**
   * Thân đối chiếu đích, chạy trong phạm vi kho mà nơi gọi đã mở
   * (xem {@link verifyPaymentAgainstServerTarget}): mọi lượt đọc
   * đối tượng đích đi qua handle định tuyến nên vào đúng kho của
   * phạm vi hiện hành.
   *
   * @param payment - Bản ghi payment đang đối chiếu.
   * @returns `true` khi khớp cả giá lẫn tenant phía server của
   *   đối tượng đích; `false` khi lệch hoặc không xác minh được.
   */
  private async verifyTargetInCurrentScope(payment: PaymentRow): Promise<boolean> {
    switch (payment.component) {
      case 'enrol_fee': {
        if (!payment.itemId) return false;
        const instance = await this.spaceScope.routedKysely
          .selectFrom('enrol')
          .select(['enrol', 'cost', 'course_id as courseId'])
          .where('id', '=', payment.itemId)
          .executeTakeFirst();
        if (!instance) return false;
        if (instance.enrol !== 'fee' || !instance.cost || instance.cost <= 0) return false;
        const courseRow = await this.spaceScope.routedKysely
          .selectFrom('course')
          .select('tenant_id as tenantId')
          .where('id', '=', instance.courseId)
          .executeTakeFirst();
        if (!courseRow?.tenantId) return false;
        return payment.amount === instance.cost && payment.tenantId === courseRow.tenantId;
      }
      case 'class_fee': {
        if (!payment.itemId) return false;
        const target = await this.spaceScope.routedKysely
          .selectFrom('classes')
          .select(['fee_cost as feeCost', 'tenant_id as tenantId'])
          .where('id', '=', payment.itemId)
          .executeTakeFirst();
        if (!target || !target.feeCost || target.feeCost <= 0) return false;
        return payment.amount === target.feeCost && payment.tenantId === target.tenantId;
      }
      case 'tenant_plan':
      case 'teacher_plan': {
        const expectedAmount = planChargedAmountOf(payment);
        if (expectedAmount === null) return false;
        return payment.amount === expectedAmount && payment.tenantId === (await this.platformTenantId());
      }
      default:
        return true;
    }
  }

  /**
   * Xác nhận chi TỰ ĐỘNG từ một sự kiện `debit` của provider (SePay)
   * — điểm vào của `SepayMatchingService`. Đối khớp theo (mã lệnh
   * chi, tài khoản, số tiền): dòng hoàn đang `approved` có mã lệnh
   * chi trùng mã giao dịch ngoài hoặc mã tham chiếu của sự kiện,
   * thuộc khoản thu trên đúng tài khoản nhận sự kiện, số tiền bằng
   * nhau. Khớp ⇒ xác nhận chi qua cùng khâu dùng chung (đảo quyền
   * lợi nếu đạt 100%) và đánh dấu sự kiện `matched`. Không khớp
   * được dòng hoàn nào ⇒ sự kiện vào `needs_review` của tenant sở
   * hữu tài khoản nhận (tiền đã ra khỏi tài khoản mà hệ thống
   * không rõ chi cho khoản hoàn nào — tuyệt đối không `ignored`
   * im lặng). Sự kiện phát lại (retry) được nhận diện qua
   * `settled_event_id` đã ghi trên dòng hoàn: coi như đã xử lý,
   * không xác nhận chi hai lần.
   *
   * @param event - Sự kiện provider chiều tiền ra đã được claim.
   */
  async settleRefundFromDebitEvent(event: ProviderEventRow): Promise<void> {
    await tenantAls.run({ platform: true }, async () => {
      const already = await this.repo.getRefundBySettledEventId(event.id);
      if (already) {
        await this.repo.updateProviderEvent(event.id, { matchStatus: 'matched', matchedPaymentId: already.paymentId });
        return;
      }
      if (!event.accountId) {
        // Sự kiện không gắn tài khoản nhận (bất thường ở đường IPN,
        // vốn luôn định tuyến theo tài khoản) — không đối khớp được,
        // vào hàng đợi của tenant chủ sự kiện để vận hành nhìn thấy.
        await this.repo.updateProviderEvent(event.id, { matchStatus: 'needs_review' });
        return;
      }
      const raw = (event.raw ?? {}) as Record<string, unknown>;
      const referenceCode = typeof raw['reference_code'] === 'string'
        ? raw['reference_code']
        : typeof raw['referenceCode'] === 'string' ? raw['referenceCode'] : '';
      const candidate = await this.repo.findRefundCandidateForDebit({
        accountId: event.accountId, amount: event.amount,
        transactionIds: [event.externalTransactionId, referenceCode],
      });
      if (!candidate) {
        await this.repo.updateProviderEvent(event.id, { matchStatus: 'needs_review' });
        return;
      }
      try {
        await this.applyRefundSettlement({
          payment: candidate.payment, refund: candidate.refund,
          externalTransactionId: candidate.refund.externalTransactionId ?? event.externalTransactionId,
          settledBy: null, settledEventId: event.id,
          suspensionActorId: candidate.refund.createdBy ?? candidate.payment.userId,
        });
        await this.repo.updateProviderEvent(event.id, { matchStatus: 'matched', matchedPaymentId: candidate.payment.id });
      } catch {
        // Xác nhận chi lỗi giữa chừng (ví dụ đình chỉ quyền lợi ném
        // lỗi): dòng hoàn còn `approved` để xử lý lại được; sự kiện
        // vào `needs_review` dạng mồ côi (không gắn khoản thu) để
        // hiện lên hàng đợi của chủ tiền — tiền đã ra mà chưa ghi sổ
        // xong là việc vận hành phải nhìn thấy, không được phép chìm
        // im lặng.
        await this.repo.updateProviderEvent(event.id, { matchStatus: 'needs_review' });
      }
    });
  }

  /**
   * Đình chỉ quyền lợi của một khoản thu khi hoàn đủ 100% — dùng
   * chung cho cả ba component có quyền lợi. Mọi khâu đều idempotent
   * (đình chỉ một ghi danh/quyền lợi đã đình chỉ là no-op) nên khâu
   * xác nhận chi gọi lại được an toàn sau lỗi giữa chừng. `actorId`
   * là người tạo yêu cầu hoàn (khi hệ thống tự xác nhận qua sự kiện
   * `debit`) — vết truy vết cho bước đình chỉ, xem ghi chú phân kỳ
   * ở đầu file về cổng capability của đường API.
   *
   * Riêng sự kiện rời cohort của đường `class_fee` là sự kiện
   * TRONG TIẾN TRÌNH mà handler đồng bộ đọc trạng thái đã commit,
   * nên không phát tại đây: việc gỡ roster ghi dòng outbox
   * `cohort_member_removed` trong chính transaction (xem
   * `suspendPaidClassMember` dưới đây) và consumer đồng bộ cohort
   * quét hàng đó để áp đình chỉ bù.
   */
  private async suspendEntitlementForFullRefund(
    actorId: string,
    payment: PaymentRow,
    tx: CentreTx,
  ): Promise<void> {
    if (payment.component === 'enrol_fee' && payment.itemId) {
      await this.suspendEnrolment(actorId, payment.itemId, payment.userId, tx);
    }
    // Hoàn đủ gói lớp → đình chỉ khỏi lớp (gỡ backing cohort; cohort
    // sync đình chỉ mọi khoá, giữ điểm/dữ liệu theo chế độ rời mặc
    // định của lớp).
    if (payment.component === 'class_fee' && payment.itemId) {
      await this.suspendPaidClassMember(payment.itemId, payment.userId, tx);
      return;
    }
    // Hoàn đủ gói → đình chỉ quyền lợi gói của chính payment đó
    // (qua `PaymentsRepository` của `@lms/payments` trên chính
    // transaction của khâu settle; đường worker đã gác component
    // gói trước nên nối trực tiếp giữ nguyên ngữ nghĩa của
    // `plans.suspendForPayment`).
    if (payment.component === 'tenant_plan' || payment.component === 'teacher_plan') {
      await this.repo.suspendEntitlementsByPayment(payment.id, tx);
    }
  }

  /**
   * Đình chỉ một ghi danh có phí — nhánh đình chỉ của
   * `EnrolService.setSuspended` phía API, không qua cổng capability
   * (xem ghi chú phân kỳ ở đầu file): đọc instance + dòng ghi danh,
   * dòng không tồn tại hoặc đã rút mềm thì ném
   * `enrol.user_not_enrolled` để khâu settle bắt và đẩy sự kiện về
   * `needs_review`; còn lại lật trạng thái SUSPENDED kèm vết
   * modifierId và phát `user_enrolment_suspended` trong CÙNG
   * transaction của khâu settle (rollback của settle cũng huỷ việc
   * đình chỉ).
   */
  private async suspendEnrolment(
    actorId: string,
    instanceId: string,
    userId: string,
    tx: CentreTx,
  ): Promise<void> {
    const instance = await this.spaceScope.routedKysely
      .selectFrom('enrol')
      .select('course_id as courseId')
      .where('id', '=', instanceId)
      .executeTakeFirst();
    if (!instance) {
      throw new SharedDomainError('enrol.instance_not_found', `Enrol instance ${instanceId} not found`);
    }
    const ue = await this.spaceScope.routedKysely
      .selectFrom('user_enrolments')
      .select(['id', 'status'])
      .where('enrol_id', '=', instanceId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!ue || ue.status === ENROL_WITHDRAWN) {
      throw new SharedDomainError('enrol.user_not_enrolled', 'User enrolment not found');
    }
    // modifierId = người thao tác: VẾT phân biệt đình chỉ THỦ CÔNG
    // theo khoá với đình chỉ do hệ thống đồng bộ áp (job đối soát
    // class-enrol-reconcile chỉ tôn trọng/không kích hoạt lại đúng
    // các dòng mang vết người này).
    await tx.updateTable('user_enrolments')
      .set({ status: ENROL_SUSPENDED, modifier_id: actorId, updated_at: new Date() })
      .where('id', '=', ue.id)
      .execute();
    await this.enrolOutbox.enqueue(tx, {
      aggregate: 'enrol', type: 'user_enrolment_suspended',
      payload: { courseId: instance.courseId, userId, instanceId, actorId },
    });
  }

  /**
   * Gỡ người học khỏi backing cohort khi hoàn đủ gói lớp — đối tác
   * phía worker của `ClassesService.suspendPaidClassMember` trong
   * transaction của khâu settle: việc xoá và dòng outbox
   * `cohort_member_removed` đi bằng chính transaction đó (rollback
   * thì cả hai cùng huỷ). Không phải thành viên thì im lặng bỏ qua
   * (idempotent). Lớp ĐÃ LƯU TRỮ vẫn gỡ được — hoàn tiền là giao
   * dịch bù trừ tài chính, không phải thao tác sửa roster, nên luật
   * đóng băng roster không chặn nó. Lớp không tồn tại thì bỏ qua
   * (đường API trả null trong ca này; khâu settle vẫn ghi sổ hoàn
   * vì quyết định hoàn đã chốt, khác đường kích hoạt vốn ném lỗi).
   */
  private async suspendPaidClassMember(
    classId: string,
    userId: string,
    tx: CentreTx,
  ): Promise<void> {
    const row = await this.spaceScope.routedKysely
      .selectFrom('classes')
      .select('cohort_id as cohortId')
      .where('id', '=', classId)
      .executeTakeFirst();
    if (!row) return;
    const deleted = await tx.deleteFrom('cohort_members')
      .where('cohort_id', '=', row.cohortId)
      .where('user_id', '=', userId)
      .returningAll()
      .execute();
    if (deleted.length === 0) return;
    await this.enrolOutbox.enqueue(tx, {
      aggregate: 'cohort', type: 'cohort_member_removed',
      payload: { cohortId: row.cohortId, userId },
    });
  }

  /**
   * Khâu xác nhận chi dùng chung cho xác nhận TAY và xác nhận TỰ
   * ĐỘNG qua sự kiện `debit` — cùng khuôn với
   * `PaymentsService.applyRefundSettlement` phía API:
   *
   * 1. Đọc lại dòng hoàn DƯỚI khoá: đã `settled` (lượt đua thắng đã
   *    ghi) thì trả nguyên dòng đó, không ghi thêm; không còn
   *    `approved` thì ném `payment.refund_not_approved` TRƯỚC mọi
   *    đình chỉ — không bao giờ đình chỉ oan cho một khoản hoàn
   *    không được ghi.
   * 2. Tính lại tổng đã `settled` DƯỚI khoá: lần xác nhận này có làm
   *    cộng dồn đạt 100% hay không được quyết định TẠI ĐÂY, không
   *    dựa vào bất kỳ lượt đọc ngoài khoá nào (quyết định đình chỉ
   *    bằng tổng đọc ngoài khoá là khe đồng thời: hai dòng hoàn bù
   *    nhau cùng xác nhận một lúc đều đọc tổng settled bằng 0,
   *    không lượt nào đình chỉ, nhưng transaction vào sau vẫn lật
   *    khoản thu `refunded` trong khi quyền lợi chưa hề bị đình chỉ).
   * 3. Đạt 100% theo tổng đã khoá thì đình chỉ quyền lợi
   *    (idempotent) TRƯỚC khi ghi: đình chỉ ném lỗi ⇒ transaction
   *    huỷ, chưa ghi gì, gọi lại được. Chưa đạt thì ghi mà không
   *    đình chỉ. Đình chỉ ghi BẰNG CHÍNH transaction này — mọi bước
   *    ghi sổ sau đó mà lỗi, transaction rollback thì đình chỉ cũng
   *    bị huỷ theo, không còn trạng thái "đã đình chỉ nhưng chưa
   *    ghi hoàn".
   * 4. Ghi dòng hoàn `settled` (+ lật khoản thu `refunded` khi đạt
   *    100%) trong cùng transaction rồi commit.
   *
   * Hoàn một phần: không đình chỉ, khoản thu giữ `succeeded`.
   */
  private async applyRefundSettlement(input: {
    payment: PaymentRow; refund: RefundRow; externalTransactionId: string;
    settledBy: string | null; settledEventId: string | null; suspensionActorId: string;
  }): Promise<RefundRow> {
    const { payment, refund } = input;
    const now = new Date();
    return this.repo.transaction(async (tx) => {
      await sql`select id from payments where id = ${payment.id} for update`.execute(tx);
      const fresh = await this.repo.getRefund(refund.id, tx);
      if (!fresh || fresh.status === 'settled') return fresh ?? refund;
      if (fresh.status !== 'approved') {
        throw new SharedDomainError('payment.refund_not_approved', 'Refund is not approved for settlement');
      }
      const settledSum = await this.repo.sumRefundsByStatuses(payment.id, ['settled'], tx);
      const full = settledSum + fresh.amount === payment.amount;
      if (full) {
        // Đình chỉ trước mọi ghi sổ, theo đúng tổng đã khoá ở trên
        // và bằng chính transaction này: lỗi tại đây ⇒ transaction
        // huỷ trước khi ghi, gọi lại được.
        await this.suspendEntitlementForFullRefund(input.suspensionActorId, payment, tx);
      }
      const data = { ...((fresh.data ?? {}) as Record<string, unknown>), reversal: { applied: full, at: now.toISOString() } };
      const updated = await this.repo.updateRefund(fresh.id, {
        status: 'settled', settledAt: now,
        settledBy: input.settledBy, settledEventId: input.settledEventId,
        externalTransactionId: input.externalTransactionId, data,
      }, tx);
      if (full) await this.repo.updatePayment(payment.id, { status: 'refunded' }, tx);
      return updated;
    });
  }
}
