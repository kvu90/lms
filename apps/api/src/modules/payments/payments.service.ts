import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OutboxService } from '../../infra/events/outbox.service';
import type { DbTx } from '../../db/database';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { ClassesService } from '../classes/classes.service';
import { EnrolService } from '../enrol/enrol.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import { TenantConfigService } from '../tenants/tenant-config.service';
import { TenantsService } from '../tenants/tenants.service';
import { PaymentsRepository, type AccountRow, type CouponRow, type EntitlementRow, type PaymentRow, type ProviderEventRow, type RefundRow } from './payments.repository';
import { PlanEntitlementsService, planChargedAmountOf, type PlanSnapshot } from './plan-entitlements.service';
import { buildVietQrPayload, extractPaymentCode, maskAccountConfig, paymentCodeFromSequence, readAccountConfig, PAYMENT_CODE_TTL_MS } from './vietqr';
import type { Coupon, CreateCoupon, CreateRefund, PaymentRefund, PaymentReviewQueueItem, PlanEntitlement, RejectRefund, ResolvePaymentReview, SettleRefund, UpdateCoupon } from '@lms/contracts';

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

/** Payment kèm chuỗi payload VietQR (chỉ có khi payment còn hạn và đang chờ — web tự render QR). */
export type PaymentView = PaymentRow & { vietqrPayload: string | null };
/** Account ở dạng API: config đã che khoá nhạy cảm (tiêu chí 6.4.5, issue #189). */
export type AccountView = Omit<AccountRow, 'config'> & { config: Record<string, unknown> | null };

/** Thân IPN SePay sau khi bóc tách (chấp nhận cả snake_case theo tài liệu lẫn camelCase). */
export interface SepayIpnInput {
  ip?: string;
  authorization?: string;
  body: unknown;
}

/**
 * Các component CẤP QUYỀN LỢI của pipeline thanh toán (issue #419):
 * payment mang một trong bốn component này, khi chốt thành công, sẽ
 * sinh ghi danh khoá (`enrol_fee`), ghi danh lớp + membership tenant
 * của lớp (`class_fee`) hoặc quyền lợi gói (`tenant_plan` /
 * `teacher_plan`). Vì hệ quả đó, chúng chỉ được sinh từ các đường
 * tạo chuyên trách đã chốt giá phía server; đường tạo chung và phép
 * đối chiếu tại điểm kích hoạt đều neo vào danh sách này.
 */
export const ENTITLEMENT_COMPONENTS = ['enrol_fee', 'class_fee', 'tenant_plan', 'teacher_plan'] as const;

/**
 * Facade của PaymentsModule (Moodle core_payment, §2#27).
 * Bất biến: amount là số nguyên đơn vị nhỏ nhất + currency (không float);
 * payment thành công là bất biến — hoàn tiền là giao dịch bù trừ riêng;
 * webhook idempotent theo external transaction id (replay không xử lý 2 lần);
 * nghiệp vụ hưởng lợi (enrol có phí) chỉ kích hoạt qua PaymentSucceeded
 * của một webhook ĐÃ QUA gateway.verify (H1, #134).
 *
 * Lát 1 VietQR (#189, hồ sơ payment-vietqr §4.3/§6): payment_accounts và
 * payments gắn tenant sở hữu; payment trên account SePay đã liên kết được
 * sinh mã thanh toán + QR động; tiền về qua IPN SePay chỉ kích hoạt khi
 * khớp đủ 3 điều kiện ở khâu matching bất đồng bộ (SepayMatchingService).
 *
 * CLASS-3 (#184): component `class_fee` (item_id = classes.id) chạy trên
 * đúng pipeline này — tạo payment qua cấu hình học phí trên lớp
 * (`createClassFeePayment`), kích hoạt ghi danh cấp lớp khi succeeded,
 * đình chỉ khỏi lớp khi hoàn đủ; không có pipeline thanh toán riêng.
 *
 * Lát 2 (#189): component `tenant_plan`/`teacher_plan` (gói trung tâm /
 * gói giáo viên) cũng chạy trên đúng pipeline này — tạo payment qua
 * `createPlanPayment` với GIÁ LẤY TỪ CẤU HÌNH HỆ THỐNG (component
 * `payments` của site-config; giá không ghim trong code), ghi vết giá +
 * chu kỳ đã áp vào `payments.data`; kích hoạt quyền lợi gói khi
 * succeeded và đình chỉ quyền lợi khi hoàn đủ qua
 * `PlanEntitlementsService`; không có pipeline thanh toán riêng.
 *
 * Lát 3 (#189): hoàn tiền chuyển từ một bước sang VÒNG ĐỜI duyệt
 * `requested → approved → settled` (hoặc `rejected`) trên bảng
 * `payment_refunds` — tạo yêu cầu (cổng cộng dồn nguyên tử có khoá
 * dòng), duyệt (một cấp tự duyệt / hai cấp khác người tạo), xác nhận
 * chi (đảo quyền lợi tại đây khi cộng dồn đã chi đạt 100%, thứ tự đình
 * chỉ-trước-ghi-sau); sự kiện `debit` của SePay tự xác nhận chi khi
 * khớp dòng hoàn đang chờ, không khớp thì vào hàng đợi `needs_review`
 * của chủ tiền. Hàng đợi `needs_review` và cổng `payment:manageaccounts`
 * đều NEO THEO CHỦ TIỀN: tiền platform gác tại context hệ thống, tiền
 * của trung tâm gác tại context tenant của chính trung tâm đó.
 *
 * Chốt chặn component cấp quyền (issue #419): bốn component sinh
 * quyền lợi (`enrol_fee`, `class_fee`, `tenant_plan`, `teacher_plan`)
 * CHỈ được sinh từ các đường tạo chuyên trách đã chốt giá phía
 * server (`createFeePayment`, `createClassFeePayment`,
 * `createPlanPayment`) — đường tạo chung `createPayment` từ chối
 * chúng, vì giá và bên hưởng của một giao dịch cấp quyền chỉ lấy từ
 * đối tượng phía server (instance/lớp/cấu hình gói), không bao giờ
 * lấy từ `amount`/`itemId` do client gửi lên. Phòng thủ chiều sâu:
 * cả ba điểm kích hoạt quyền lợi (matching SePay, webhook,
 * `resolvePaymentReview`) đều đối chiếu lại payment với giá + tenant
 * phía server của đối tượng đích qua
 * `verifyPaymentAgainstServerTarget` trước khi kích hoạt; lệch thì
 * rơi vào hàng đợi `needs_review`, không kích hoạt.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly repo: PaymentsRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly outbox: OutboxService,
    private readonly enrol: EnrolService,
    private readonly classes: ClassesService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly tenantContext: TenantContextService,
    private readonly tenants: TenantsService,
    private readonly tenantConfig: TenantConfigService,
    private readonly siteConfig: SiteConfigService,
    private readonly plans: PlanEntitlementsService,
    private readonly config: ConfigService,
  ) {}

  /** Tenant platform ("tenant-zero") — chủ của dòng tiền gói và của hàng đợi platform. */
  private async platformTenantId(): Promise<string> {
    return (await this.tenants.platformTenant()).id;
  }

  /**
   * Cổng `payment:manageaccounts` NEO THEO CHỦ TIỀN (lát 3, issue #189 —
   * sửa nền vận hành thanh toán của trung tâm): tiền của tenant
   * platform được gác tại CONTEXT HỆ THỐNG như trước; tiền của một
   * trung tâm được gác tại CONTEXT TENANT của chính trung tâm đó —
   * quản trị trung tâm (archetype `manager`) có quyền hoàn/khớp tay học
   * phí của trung tâm mình bằng tài khoản của trung tâm mình, và trung
   * tâm cấp thêm được quyền này cho vai tuỳ biến (ví dụ kế toán) qua cơ
   * chế gán vai sẵn có. Đường context tenant của PermissionEvaluator
   * vốn đã áp cổng tenant (chỉ thành viên đang hoạt động của tenant mới
   * qua, không có lối tắt quản trị toàn site) nên vai trò của tenant
   * khác không chạm được tiền của tenant này.
   */
  private async requireManageAccountsForTenant(actorId: string, tenantId: string): Promise<void> {
    if (tenantId === (await this.platformTenantId())) {
      const sys = await this.contexts.ensureSystemContext();
      await this.evaluator.requireCapability(actorId, 'payment:manageaccounts', sys.id);
      return;
    }
    const ctx = await this.contexts.ensureTenantContext(tenantId);
    await this.evaluator.requireCapability(actorId, 'payment:manageaccounts', ctx.id);
  }

  /**
   * Cổng quản trị tài khoản nhận tiền theo PHIÊN hiện tại: neo tại
   * tenant hiệu lực của phiên (platform → context hệ thống; trung tâm
   * đã chuyển ngữ cảnh → context tenant của trung tâm đó).
   */
  private async requireManageAccounts(actorId: string): Promise<void> {
    await this.requireManageAccountsForTenant(actorId, await this.effectiveTenantId());
  }

  /** Cổng quản trị coupon: capability riêng `payment:managecoupons` tại context hệ thống (chỉ quản trị platform). */
  private async requireManageCoupons(actorId: string): Promise<void> {
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'payment:managecoupons', sys.id);
  }

  /** Tenant hiệu lực: ngữ cảnh request; ngoài request (seed/job) rơi về tenant-zero. */
  private async effectiveTenantId(): Promise<string> {
    return this.tenantContext.currentTenantId() ?? (await this.tenants.fallbackTenantId());
  }
  /** Che config nhạy cảm trước khi ra API (6.4.5) — bản ghi gốc trong DB không đổi. */
  private maskAccount(row: AccountRow): AccountView {
    return { ...row, config: row.config == null ? null : maskAccountConfig(row.config) };
  }

  /** Account cho đường ĐỌC API: tenant khác với tenant hiệu lực = coi như không tồn tại. */
  private async getAccountForRead(id: string): Promise<AccountRow> {
    const row = await this.repo.getAccount(id);
    if (!row) throw new NotFoundException({ message: `Payment account ${id} not found`, code: 'payment.account_not_found' });
    const active = this.tenantContext.currentTenantId();
    if (active !== undefined && row.tenantId !== active) {
      throw new NotFoundException({ message: `Payment account ${id} not found`, code: 'payment.account_not_found' });
    }
    return row;
  }

  async createAccount(actorId: string, input: { name: string; gateway?: string; config?: Record<string, unknown> }): Promise<AccountView> {
    await this.requireManageAccounts(actorId);
    const tenantId = await this.effectiveTenantId();
    const row = await this.repo.insertAccount({
      name: input.name, gateway: input.gateway ?? 'manual', tenantId, config: input.config ?? null,
    });
    return this.maskAccount(row);
  }
  /**
   * Danh sách account của tenant hiệu lực, config đã che (6.4.5 + cổng đọc
   * theo tenant, §6.1). Bề mặt quản trị — cùng cổng payment:manageaccounts
   * như createAccount/refund (H3, #134).
   */
  async listAccounts(actorId: string): Promise<AccountView[]> {
    await this.requireManageAccounts(actorId);
    const tenantId = await this.effectiveTenantId();
    const rows = await this.repo.listAccounts();
    return rows.filter((r) => r.tenantId === tenantId).map((r) => this.maskAccount(r));
  }
  async getAccount(id: string): Promise<AccountView> {
    return this.maskAccount(await this.getAccountForRead(id));
  }
  async getPayment(id: string): Promise<PaymentView> {
    const row = await this.repo.getPayment(id);
    if (!row) throw new NotFoundException({ message: `Payment ${id} not found`, code: 'payment.not_found' });
    return this.paymentView(row);
  }

  /** Gắn chuỗi payload VietQR cho payment đang chờ + còn hạn; ngoài các trạng thái đó trả null. */
  private async paymentView(row: PaymentRow): Promise<PaymentView> {
    let vietqrPayload: string | null = null;
    if (row.paymentCode && row.status === 'pending' && !(row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
      const account = await this.repo.getAccount(row.accountId);
      if (account) vietqrPayload = buildVietQrPayload(account, row.amount, row.paymentCode);
    }
    return { ...row, vietqrPayload };
  }

  /**
   * Cổng đọc payment cho bề mặt HTTP (H3, #134): chỉ chủ sở hữu hoặc holder
   * payment:manageaccounts tại system mới đọc được. Người ngoài nhận 404
   * payment.not_found y như payment không tồn tại — không lộ sự tồn tại.
   * Đường nội bộ (webhook, refund đã gác manageaccounts) dùng getPayment.
   */
  private async assertCanReadPayment(actorId: string, payment: PaymentRow): Promise<void> {
    if (payment.userId === actorId) return;
    const sys = await this.contexts.ensureSystemContext();
    if (await this.evaluator.hasCapability(actorId, 'payment:manageaccounts', sys.id)) return;
    throw new NotFoundException({ message: `Payment ${payment.id} not found`, code: 'payment.not_found' });
  }
  async getPaymentForUser(actorId: string, id: string): Promise<PaymentRow> {
    const row = await this.getPayment(id);
    await this.assertCanReadPayment(actorId, row);
    return row;
  }
  async listRefundsForUser(actorId: string, paymentId: string): Promise<PaymentRefund[]> {
    const payment = await this.getPayment(paymentId);
    await this.assertCanReadPayment(actorId, payment);
    const rows = await this.repo.listRefunds(paymentId);
    return rows.map((r) => this.toRefundView(r));
  }

  /**
   * Tạo payment ở trạng thái pending cho một user — đường tạo CHUNG
   * của `POST /payments`, nơi `amount`/`component`/`itemId` do
   * client đặt. Vì vậy đường này bị cấm sinh payment mang component
   * CẤP QUYỀN LỢI (issue #419): bốn component `enrol_fee`,
   * `class_fee`, `tenant_plan`, `teacher_plan` chỉ được sinh từ các
   * đường tạo chuyên trách tương ứng (`createFeePayment`,
   * `createClassFeePayment`, `createPlanPayment`), nơi số tiền và
   * bên hưởng được lấy từ chính đối tượng phía server (instance có
   * phí / cấu hình học phí trên lớp / cấu hình giá gói), không từ dữ
   * kiện client gửi lên. Payment mang component thường (không sinh
   * quyền lợi) giữ nguyên hành vi như trước.
   */
  async createPayment(userId: string, input: { accountId: string; amount: number; currency: string; component?: string; itemId?: string }): Promise<PaymentView> {
    if (input.component !== undefined && (ENTITLEMENT_COMPONENTS as readonly string[]).includes(input.component)) {
      throw new BadRequestException({
        message: `Component ${input.component} grants entitlements and can only be created through its dedicated server-priced purchase endpoint`,
        code: 'payment.entitlement_component_forbidden',
      });
    }
    const active = this.tenantContext.currentTenantId();
    return this.createPaymentInTenant(userId, input, active);
  }

  /**
   * Lõi tạo payment với cổng tenant tường minh: account phải thuộc đúng
   * `contextTenantId` (khi có ngữ cảnh) — account của tenant A không bao
   * giờ dùng được cho payment của tenant B (§4.3.1/6.4.6). Ngữ cảnh rỗng
   * (job/test gọi thẳng) thì tenant của payment = tenant của account.
   */
  private async createPaymentInTenant(
    userId: string,
    input: { accountId: string; amount: number; currency: string; component?: string; itemId?: string; data?: Record<string, unknown> },
    contextTenantId: string | undefined,
  ): Promise<PaymentView> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BadRequestException({ message: 'Amount must be a positive integer in the smallest currency unit', code: 'payment.amount_not_integer' });
    }
    const account = await this.repo.getAccount(input.accountId);
    if (!account) throw new NotFoundException({ message: `Payment account ${input.accountId} not found`, code: 'payment.account_not_found' });
    if (!account.enabled) throw new BadRequestException({ message: 'Payment account is disabled', code: 'payment.account_disabled' });
    if (contextTenantId !== undefined && account.tenantId !== contextTenantId) {
      throw new BadRequestException({ message: 'Payment account belongs to a different tenant', code: 'payment.account_tenant_mismatch' });
    }
    // Account SePay đã liên kết → sinh mã thanh toán (một lần, không tái sử
    // dụng) + hạn 24h + QR động. Chưa liên kết → đường manual hiện hành.
    let paymentCode: string | null = null;
    let expiresAt: Date | null = null;
    let vietqrPayload: string | null = null;
    if (account.gateway === 'sepay') {
      const code = paymentCodeFromSequence(await this.repo.nextPaymentCodeValue());
      const built = buildVietQrPayload(account, input.amount, code);
      if (built) {
        paymentCode = code;
        expiresAt = new Date(Date.now() + PAYMENT_CODE_TTL_MS);
        vietqrPayload = built;
      }
    }
    const row = await this.repo.insertPayment({
      accountId: input.accountId, tenantId: account.tenantId, userId: userId, amount: input.amount, currency: input.currency.toUpperCase(),
      status: 'pending', gateway: account.gateway, component: input.component ?? '', itemId: input.itemId ?? null,
      paymentCode, expiresAt, data: input.data ?? null,
    });
    return { ...row, vietqrPayload };
  }

  /**
   * Đối chiếu phòng thủ chiều sâu của một payment cấp quyền lợi với
   * ĐỐI TƯỢNG PHÍA SERVER của nó (issue #419) — phép kiểm bắt buộc
   * tại cả ba điểm kích hoạt quyền lợi (matching SePay, webhook,
   * `resolvePaymentReview`), chạy TRƯỚC mọi khâu kích hoạt:
   *
   *  1. `payment.amount` phải bằng đúng giá phía server của đối
   *     tượng đích: `instance.cost` với `enrol_fee`; học phí đang
   *     cấu hình trên lớp với `class_fee`; giá cấu hình trừ mức
   *     giảm coupon trong ảnh chụp do server ghi với gói.
   *  2. `payment.tenantId` phải bằng tenant của đối tượng đích:
   *     tenant sở hữu khoá với `enrol_fee`, tenant sở hữu lớp với
   *     `class_fee`, tenant platform (chủ của tài khoản nhận tiền
   *     gói) với gói — bên hưởng quyền lợi gói nằm trong ảnh chụp
   *     và được khâu kích hoạt gói tự kiểm, không phải tenant của
   *     payment.
   *
   * Nguyên tắc: giá và bên hưởng chỉ lấy từ đối tượng phía server,
   * không lấy từ chính payment — payment là dữ kiện có thể đã bị
   * can thiệp (tạo qua đường chung trước khi có chốt chặn, hoặc bị
   * sửa trực tiếp), nên "payment khớp với chính nó" không chứng
   * minh được gì. Đối tượng đích không tồn tại, không còn cấu hình
   * phí, hoặc ảnh chụp gói thiếu/sai hình dạng đều coi là KHÔNG
   * khớp (fail-closed): thà đẩy vào `needs_review` để vận hành xử
   * lý còn hơn kích hoạt một quyền lợi không xác minh được.
   *
   * @param payment - Bản ghi payment sắp được kích hoạt quyền lợi.
   * @returns `true` khi payment mang component thường (không có
   *   quyền lợi để đối chiếu) hoặc khớp cả giá lẫn tenant phía
   *   server; `false` khi lệch hoặc không xác minh được.
   */
  async verifyPaymentAgainstServerTarget(payment: PaymentRow): Promise<boolean> {
    switch (payment.component) {
      case 'enrol_fee': {
        if (!payment.itemId) return false;
        let instance: Awaited<ReturnType<EnrolService['getInstance']>>;
        try {
          instance = await this.enrol.getInstance(payment.itemId);
        } catch {
          return false;
        }
        if (instance.enrol !== 'fee' || !instance.cost || instance.cost <= 0) return false;
        const courseTenantId = await this.repo.getCourseTenantId(instance.courseId);
        if (!courseTenantId) return false;
        return payment.amount === instance.cost && payment.tenantId === courseTenantId;
      }
      case 'class_fee': {
        if (!payment.itemId) return false;
        const target = await this.classes.getClassFeeTarget(payment.itemId);
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
   * Tạo payment cho một enrol instance có phí, lấy amount/currency từ config
   * của instance. Cổng tenant (§6.3/6.4.6): account được chọn phải thuộc
   * đúng tenant của khoá; account mặc định = account đầu tiên CỦA tenant đó.
   */
  async createFeePayment(userId: string, enrolInstanceId: string): Promise<PaymentView> {
    const instance = await this.enrol.getInstance(enrolInstanceId);
    if (instance.enrol !== 'fee' || !instance.cost || instance.cost <= 0) {
      throw new BadRequestException({ message: 'Enrol instance has no fee configured', code: 'payment.no_fee' });
    }
    const courseTenantId = await this.repo.getCourseTenantId(instance.courseId);
    if (!courseTenantId) throw new BadRequestException({ message: 'Course not found for this fee enrol instance', code: 'payment.no_course' });
    let accountId = instance.paymentAccountId ?? undefined;
    if (accountId) {
      const account = await this.repo.getAccount(accountId);
      if (!account) throw new BadRequestException({ message: 'Configured payment account no longer exists', code: 'payment.no_account' });
      if (account.tenantId !== courseTenantId) {
        throw new BadRequestException({ message: 'Payment account belongs to a different tenant than the course', code: 'payment.account_tenant_mismatch' });
      }
    } else {
      const own = (await this.repo.listAccounts()).filter((a) => a.tenantId === courseTenantId && a.enabled);
      accountId = own[0]?.id;
    }
    if (!accountId) throw new BadRequestException({ message: 'No payment account configured for this fee enrol instance', code: 'payment.no_account' });
    return this.createPaymentInTenant(userId, { accountId, amount: instance.cost, currency: instance.currency || 'VND', component: 'enrol_fee', itemId: enrolInstanceId }, courseTenantId);
  }

  /**
   * Tạo payment cho GÓI LỚP (CLASS-3, issue #184) — hàm song song với
   * `createFeePayment` của `enrol_fee`, dùng đúng seam
   * `component`/`item_id` sẵn có: payment mang `component = 'class_fee'`,
   * `item_id = classes.id`. Số tiền/đơn vị tiền lấy từ cấu hình học phí
   * trên lớp; mọi cổng phía lớp (lớp tồn tại trong tenant hiệu lực /
   * chưa lưu trữ / có bật thu phí / người mua chưa thuộc roster) do
   * `ClassesService.resolveClassFeePurchase` gác.
   *
   * Chọn tài khoản nhận theo luật hai dòng tiền tách bạch (sổ quyết
   * định mục E): tài khoản chỉ định riêng trên lớp nếu có, không thì
   * tài khoản enabled đầu tiên CỦA TENANT SỞ HỮU LỚP — lớp của trung
   * tâm thu về tài khoản của chính trung tâm, lớp của GV tự do ở trang
   * chính (tenant nền tảng) thu về tài khoản platform; account của
   * tenant khác bị chặn ở đây và chặn lần nữa ở `createPaymentInTenant`
   * (mã `payment.account_tenant_mismatch`).
   */
  async createClassFeePayment(userId: string, classId: string): Promise<PaymentView> {
    const target = await this.classes.resolveClassFeePurchase(classId, userId);
    let accountId = target.feePaymentAccountId ?? undefined;
    if (accountId) {
      const account = await this.repo.getAccount(accountId);
      if (!account) throw new BadRequestException({ message: 'Configured payment account no longer exists', code: 'payment.no_account' });
      if (account.tenantId !== target.tenantId) {
        throw new BadRequestException({ message: 'Payment account belongs to a different tenant than the class', code: 'payment.account_tenant_mismatch' });
      }
    } else {
      const own = (await this.repo.listAccounts()).filter((a) => a.tenantId === target.tenantId && a.enabled);
      accountId = own[0]?.id;
    }
    if (!accountId) throw new BadRequestException({ message: 'No payment account configured for this class fee', code: 'payment.no_account' });
    return this.createPaymentInTenant(userId, { accountId, amount: target.feeCost, currency: target.feeCurrency || 'VND', component: 'class_fee', itemId: target.classId }, target.tenantId);
  }

  // --- Coupon giảm giá mua gói (phần còn lại của lát 2, issue #189) --------
  //
  // Luồng nghiệp vụ: coupon là DỮ LIỆU do quản trị platform tạo ở bề
  // mặt quản trị dưới đây (gác bằng `payment:managecoupons`) — mã,
  // loại giảm, mức giảm, phạm vi gói, cửa sổ hiệu lực, giới hạn lượt
  // dùng đều nằm ở bản ghi coupon, không có giá trị nào ghim trong
  // code. Coupon chỉ phát huy tại ĐIỂM TẠO payment gói
  // (`createPlanPayment`): mức giảm trừ vào giá đang cấu hình, số
  // tiền của payment là giá sau giảm (đây là số tiền pipeline
  // VietQR/SePay khớp), và ảnh chụp `payments.data.plan` ghi lại mã
  // coupon + số tiền đã giảm để đối soát về sau. Coupon không đổi
  // chu kỳ gói, không đổi bên hưởng và không đổi định nghĩa slot.

  /** Chiếu một bản ghi coupon thành dạng API (mốc thời gian dạng ISO). */
  private toCouponView(row: CouponRow): Coupon {
    return {
      id: row.id,
      code: row.code,
      discountType: row.discountType as Coupon['discountType'],
      discountValue: row.discountValue,
      appliesTo: row.appliesTo as Coupon['appliesTo'],
      startsAt: row.startsAt ? row.startsAt.toISOString() : null,
      endsAt: row.endsAt ? row.endsAt.toISOString() : null,
      maxRedemptions: row.maxRedemptions,
      isActive: row.isActive,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Kiểm tra chéo các trường tiền bạc/cửa sổ của coupon trên TRẠNG
   * THÁI CUỐI CÙNG (payload tạo mới hoặc trạng thái gộp sau cập
   * nhật): phần trăm hợp lệ 1–99 (hợp đồng hình dạng đã chặn ở biên
   * tạo mới; đường cập nhật từng phần phải kiểm lại ở đây), số tiền
   * cố định là số nguyên dương, cửa sổ hiệu lực có đầu trước cuối.
   */
  private assertCouponFieldsValid(fields: {
    discountType: string; discountValue: number; startsAt: Date | null; endsAt: Date | null;
  }): void {
    if (fields.discountType === 'percent' && (fields.discountValue < 1 || fields.discountValue > 99)) {
      throw new BadRequestException({ message: 'Percent discount value must be between 1 and 99', code: 'payment.coupon_invalid' });
    }
    if (fields.discountType === 'fixed' && (!Number.isInteger(fields.discountValue) || fields.discountValue < 1)) {
      throw new BadRequestException({ message: 'Fixed discount value must be a positive integer', code: 'payment.coupon_invalid' });
    }
    if (fields.discountType !== 'percent' && fields.discountType !== 'fixed') {
      throw new BadRequestException({ message: `Unknown coupon discount type: ${fields.discountType}`, code: 'payment.coupon_invalid' });
    }
    if (fields.startsAt && fields.endsAt && fields.startsAt.getTime() >= fields.endsAt.getTime()) {
      throw new BadRequestException({ message: 'Coupon endsAt must be after startsAt', code: 'payment.coupon_invalid' });
    }
  }

  /**
   * Tạo coupon mới. Mã được chuẩn hoá chữ hoa trước khi lưu (tra cứu
   * khi áp dụng cũng chuẩn hoá nên người mua nhập hoa/thường đều
   * khớp); mã trùng với coupon đã có → `payment.coupon_code_taken`.
   */
  async createCoupon(actorId: string, input: CreateCoupon): Promise<Coupon> {
    await this.requireManageCoupons(actorId);
    const code = input.code.trim().toUpperCase();
    const startsAt = input.startsAt ? new Date(input.startsAt) : null;
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    this.assertCouponFieldsValid({ discountType: input.discountType, discountValue: input.discountValue, startsAt, endsAt });
    if (await this.repo.getCouponByCode(code)) {
      throw new ConflictException({ message: `Coupon code ${code} is already taken`, code: 'payment.coupon_code_taken' });
    }
    const row = await this.repo.insertCoupon({
      code,
      discountType: input.discountType,
      discountValue: input.discountValue,
      appliesTo: input.appliesTo,
      startsAt,
      endsAt,
      maxRedemptions: input.maxRedemptions ?? null,
      isActive: input.isActive,
      createdBy: actorId,
    });
    return this.toCouponView(row);
  }

  /** Danh sách coupon cho bề mặt quản trị (mọi trạng thái, kể cả đã tắt). */
  async listCoupons(actorId: string): Promise<Coupon[]> {
    await this.requireManageCoupons(actorId);
    return (await this.repo.listCoupons()).map((r) => this.toCouponView(r));
  }

  /** Một coupon theo id cho bề mặt quản trị; không có → `payment.coupon_not_found`. */
  async getCoupon(actorId: string, id: string): Promise<Coupon> {
    await this.requireManageCoupons(actorId);
    const row = await this.repo.getCoupon(id);
    if (!row) throw new NotFoundException({ message: `Coupon ${id} not found`, code: 'payment.coupon_not_found' });
    return this.toCouponView(row);
  }

  /**
   * Cập nhật coupon theo từng phần; mã coupon không sửa được (mã là
   * định danh tra cứu khi áp dụng). Trạng thái gộp sau cập nhật phải
   * qua cùng kiểm tra chéo như khi tạo. Ngừng sử dụng coupon bằng
   * `isActive = false` — không có đường xoá cứng.
   */
  async updateCoupon(actorId: string, id: string, input: UpdateCoupon): Promise<Coupon> {
    await this.requireManageCoupons(actorId);
    const row = await this.repo.getCoupon(id);
    if (!row) throw new NotFoundException({ message: `Coupon ${id} not found`, code: 'payment.coupon_not_found' });
    const merged = {
      discountType: input.discountType ?? row.discountType,
      discountValue: input.discountValue ?? row.discountValue,
      startsAt: input.startsAt !== undefined ? (input.startsAt ? new Date(input.startsAt) : null) : row.startsAt,
      endsAt: input.endsAt !== undefined ? (input.endsAt ? new Date(input.endsAt) : null) : row.endsAt,
    };
    this.assertCouponFieldsValid(merged);
    const updated = await this.repo.updateCoupon(id, {
      discountType: merged.discountType,
      discountValue: merged.discountValue,
      appliesTo: input.appliesTo ?? row.appliesTo,
      startsAt: merged.startsAt,
      endsAt: merged.endsAt,
      maxRedemptions: input.maxRedemptions !== undefined ? input.maxRedemptions : row.maxRedemptions,
      isActive: input.isActive ?? row.isActive,
    });
    return this.toCouponView(updated);
  }

  /**
   * Phân giải coupon tại điểm tạo payment gói: tra mã (đã chuẩn hoá
   * chữ hoa) và kiểm tra lần lượt — tồn tại, đang bật, trong cửa sổ
   * hiệu lực, đúng loại gói, còn lượt dùng — rồi tính mức giảm trên
   * GIÁ ĐANG CẤU HÌNH của gói. Mỗi trường hợp sai phạm có mã lỗi
   * riêng để bề mặt mua gói hiển thị đúng lý do. Mức giảm không được
   * làm số tiền phải trả nhỏ hơn 1 đơn vị tiền (pipeline khớp số
   * tiền chuyển khoản không vận hành được với khoản thu 0 đồng) —
   * chạm trường hợp đó thì từ chối áp coupon thay vì âm thầm đổi mức
   * giảm.
   */
  private async resolveCouponDiscount(
    couponCode: string,
    component: 'tenant_plan' | 'teacher_plan',
    configuredPrice: number,
  ): Promise<{ coupon: CouponRow; discountAmount: number }> {
    const code = couponCode.trim().toUpperCase();
    const coupon = await this.repo.getCouponByCode(code);
    if (!coupon) {
      throw new BadRequestException({ message: `Coupon ${code} not found`, code: 'payment.coupon_not_found' });
    }
    if (!coupon.isActive) {
      throw new BadRequestException({ message: `Coupon ${code} is not active`, code: 'payment.coupon_inactive' });
    }
    const now = Date.now();
    if ((coupon.startsAt && now < coupon.startsAt.getTime()) || (coupon.endsAt && now >= coupon.endsAt.getTime())) {
      throw new BadRequestException({ message: `Coupon ${code} is outside its validity window`, code: 'payment.coupon_not_in_window' });
    }
    if (coupon.appliesTo !== 'all' && coupon.appliesTo !== component) {
      throw new BadRequestException({ message: `Coupon ${code} does not apply to ${component}`, code: 'payment.coupon_not_applicable' });
    }
    if (coupon.maxRedemptions !== null && (await this.repo.countCouponRedemptions(coupon.id)) >= coupon.maxRedemptions) {
      throw new BadRequestException({ message: `Coupon ${code} has no redemptions left`, code: 'payment.coupon_exhausted' });
    }
    const discountAmount = coupon.discountType === 'percent'
      ? Math.floor((configuredPrice * coupon.discountValue) / 100)
      : coupon.discountValue;
    if (discountAmount < 1 || discountAmount >= configuredPrice) {
      throw new BadRequestException({
        message: `Coupon ${code} discount must leave a payable amount of at least 1`,
        code: 'payment.coupon_exceeds_price',
      });
    }
    return { coupon, discountAmount };
  }

  /**
   * Tạo payment mua/nâng GÓI (lát 2, issue #189) — hàm song song với
   * `createFeePayment`/`createClassFeePayment`, dùng đúng seam
   * `component`/`item_id` sẵn có: payment mang `component` =
   * `tenant_plan` (item_id = tenant hưởng gói) hoặc `teacher_plan`
   * (item_id = giáo viên mua gói).
   *
   * GIÁ KHÔNG ĐẾN TỪ CLIENT VÀ KHÔNG GHIM TRONG CODE (quyết định về
   * giá gói của issue): số tiền + độ dài chu kỳ đọc từ cấu hình hệ
   * thống tại đúng thời điểm giao dịch — component `payments`, khoá
   * `tenantplanprice`/`tenantplanperioddays` hoặc
   * `teacherplanprice`/`teacherplanperioddays` (quản trị sửa trong bề
   * mặt Cài đặt hệ thống; registry khai giá trị khởi tạo). Giá trị
   * không phải số nguyên dương = cấu hình hỏng → từ chối tạo khoản
   * thu (`payment.plan_not_configured`) thay vì thu sai giá. Giá +
   * chu kỳ + bên hưởng được GHI VẾT vào `payments.data` (khoá `plan`)
   * để khâu kích hoạt về sau dùng đúng giá trị đã áp cho khoản thu
   * này, kể cả khi quản trị đã đổi giá trong lúc chờ tiền về.
   *
   * Tài khoản nhận: tiền gói là doanh thu của PLATFORM (hai dòng
   * tiền tách bạch, quyết định 4 của issue) — tài khoản đang bật của
   * tenant platform (tenant-zero), KHÔNG phải tài khoản của tenant
   * mua gói; học phí của trung tâm vẫn về tài khoản của chính trung
   * tâm như cũ. Khi tenant platform có nhiều tài khoản đang bật, luật
   * chọn xác định: ưu tiên gateway `sepay`, rồi tài khoản tạo sớm
   * nhất, rồi id (xem thân hàm). Bên hưởng: `tenant_plan` hưởng theo
   * tenant hiệu lực của người mua; `teacher_plan` hưởng theo chính
   * người mua.
   *
   * COUPON (phần còn lại của lát 2): người mua có thể kèm `couponCode`
   * — coupon do quản trị platform tạo, được phân giải tại đây qua
   * {@link PaymentsService.resolveCouponDiscount}: số tiền của
   * payment là giá cấu hình TRỪ mức giảm, và ảnh chụp bổ sung mã
   * coupon + số tiền đã giảm (giá gốc vẫn ở `configuredPrice`).
   */
  async createPlanPayment(userId: string, input: { component: string; couponCode?: string }): Promise<PaymentView> {
    if (input.component !== 'tenant_plan' && input.component !== 'teacher_plan') {
      throw new BadRequestException({ message: `Unknown plan component: ${input.component}`, code: 'payment.unknown_plan_component' });
    }
    const component = input.component;
    const price = await this.siteConfig.getValue<number>('payments', component === 'tenant_plan' ? 'tenantplanprice' : 'teacherplanprice');
    const periodDays = await this.siteConfig.getValue<number>('payments', component === 'tenant_plan' ? 'tenantplanperioddays' : 'teacherplanperioddays');
    if (price === undefined || !Number.isInteger(price) || price <= 0 || periodDays === undefined || !Number.isInteger(periodDays) || periodDays <= 0) {
      throw new BadRequestException({ message: 'Plan price is not configured as a positive integer in system settings', code: 'payment.plan_not_configured' });
    }
    const platformTenantId = await this.tenants.fallbackTenantId();
    // Luật chọn tài khoản XÁC ĐỊNH (cùng trạng thái DB luôn cho cùng
    // một lựa chọn, không phụ thuộc thứ tự trả hàng của truy vấn):
    // trong các tài khoản đang bật của tenant platform, ưu tiên tài
    // khoản gateway `sepay` đã liên kết (đường mua gói là pipeline
    // VietQR — tài khoản manual không sinh được mã/QR và không bao
    // giờ khớp IPN), sau đó tài khoản tạo sớm nhất, hoà thì theo id.
    const account = (await this.repo.listAccounts())
      .filter((a) => a.tenantId === platformTenantId && a.enabled)
      .sort((a, b) =>
        (a.gateway === 'sepay' ? 0 : 1) - (b.gateway === 'sepay' ? 0 : 1)
        || a.createdAt.getTime() - b.createdAt.getTime()
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )[0];
    if (!account) throw new BadRequestException({ message: 'No payment account configured for plan purchases', code: 'payment.no_account' });
    const beneficiaryTenantId = await this.effectiveTenantId();
    // Coupon áp tại điểm tạo khoản thu: mức giảm tính trên giá cấu
    // hình vừa đọc ở trên; số tiền thực thu của payment là giá sau
    // giảm — pipeline khớp đúng số tiền này như mọi payment khác.
    let amount = price;
    let couponSnapshot: Pick<PlanSnapshot, 'couponId' | 'couponCode' | 'discountAmount'> = {};
    if (input.couponCode) {
      const resolved = await this.resolveCouponDiscount(input.couponCode, component, price);
      amount = price - resolved.discountAmount;
      couponSnapshot = {
        couponId: resolved.coupon.id,
        couponCode: resolved.coupon.code,
        discountAmount: resolved.discountAmount,
      };
    }
    const snapshot: PlanSnapshot = {
      component,
      configuredPrice: price,
      periodDays,
      beneficiaryTenantId,
      beneficiaryUserId: component === 'teacher_plan' ? userId : null,
      ...couponSnapshot,
    };
    return this.createPaymentInTenant(userId, {
      accountId: account.id, amount, currency: 'VND', component,
      itemId: component === 'tenant_plan' ? beneficiaryTenantId : userId,
      data: { plan: snapshot },
    }, platformTenantId);
  }

  /**
   * Quyền lợi gói của chính người gọi (cho bề mặt "gói của tôi"): gói
   * giáo viên của họ cộng gói trung tâm của tenant hiệu lực, khử trùng
   * theo id, chiếu thành dạng contract (ngày tháng dạng ISO).
   */
  async listMyPlanEntitlements(userId: string): Promise<PlanEntitlement[]> {
    const tenantId = await this.effectiveTenantId();
    const byId = new Map<string, EntitlementRow>();
    const rows = [
      ...(await this.repo.listEntitlementsForUser(userId)),
      ...(await this.repo.listTenantPlanEntitlements(tenantId)),
    ];
    for (const row of rows) byId.set(row.id, row);
    return [...byId.values()].map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      component: row.component as PlanEntitlement['component'],
      paymentId: row.paymentId,
      startsAt: row.startsAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      status: row.status as PlanEntitlement['status'],
      createdAt: row.createdAt.toISOString(),
    }));
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
    // Đối chiếu phòng thủ chiều sâu TRƯỚC khi kích hoạt (issue
    // #419): webhook đã xác thực chỉ chứng minh gateway báo tiền về,
    // không chứng minh payment khớp giá/tenant phía server của đối
    // tượng đích. Payment lệch (số tiền hoặc tenant bị can thiệp)
    // → `needs_review` để vận hành đối soát, TUYỆT ĐỐI không kích
    // hoạt quyền lợi và không đánh `failed` (tiền có thể là thật,
    // chỉ là payment không đáng tin).
    if (!(await this.verifyPaymentAgainstServerTarget(payment))) {
      await this.repo.updatePayment(payment.id, { status: 'needs_review', gateway: input.gateway, externalTransactionId: input.externalTransactionId });
      return { status: 'needs_review', payment: await this.getPayment(payment.id) };
    }
    // Nghiệp vụ hưởng lợi chạy TRƯỚC nhịp lật trạng thái — cùng bất
    // biến đồng bộ với đường matching SePay: trạng thái `succeeded`
    // không bao giờ quan sát được khi quyền lợi chưa kích hoạt. Webhook
    // đã xác thực mới tới được đây; các khâu kích hoạt đều idempotent
    // nên webhook bắn lại (sau cổng duplicate ở trên) an toàn.
    // Enrol có phí: chỉ active khi PaymentSucceeded đã xác thực.
    if (payment.component === 'enrol_fee' && payment.itemId) {
      await this.enrol.activatePaidEnrol(payment.itemId, payment.userId);
    }
    // CLASS-3: gói lớp — vào roster của lớp, cohort sync vật chất hoá
    // xuống mọi khoá của lớp (idempotent như activatePaidEnrol).
    if (payment.component === 'class_fee' && payment.itemId) {
      await this.classes.activatePaidClassEnrol(payment.itemId, payment.userId);
    }
    // Lát 2 (#189): gói trung tâm / gói giáo viên — sinh quyền lợi gói
    // theo ảnh chụp giá + chu kỳ đã ghi vết lúc tạo payment.
    if (payment.component === 'tenant_plan' || payment.component === 'teacher_plan') {
      await this.plans.activateForPayment(payment);
    }
    await this.repo.updatePayment(payment.id, { status: 'succeeded', gateway: input.gateway, externalTransactionId: input.externalTransactionId });
    const succeeded = await this.getPayment(payment.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'payment', type: 'payment_succeeded',
      payload: { paymentId: succeeded.id, userId: succeeded.userId, amount: succeeded.amount, currency: succeeded.currency, component: succeeded.component, itemId: succeeded.itemId, externalTransactionId: input.externalTransactionId },
    });
    return { status: 'succeeded', payment: succeeded };
  }

  // --- IPN SePay (lát 1, §6.2) ------------------------------------------------

  /**
   * IPN SePay: handler NHẸ — allowlist IP → định tuyến theo
   * bank_account_xid/số tài khoản → account → verify Apikey hằng-thời-gian
   * → ghi `payment_provider_events` → trả {success:true}. Verify trượt ở
   * bất kỳ lớp nào: 401 và KHÔNG ghi sự kiện, KHÔNG kích hoạt gì (6.4.1).
   * Matching chạy bất đồng bộ ở SepayMatchingService.
   */
  async handleSepayIpn(input: SepayIpnInput): Promise<{ success: true; duplicate?: boolean }> {
    const body = (input.body && typeof input.body === 'object' ? input.body : {}) as Record<string, unknown>;
    // Lớp 1 — allowlist IP nguồn (biến env SEPAY_IPN_IP_ALLOWLIST khai
    // trong env schema, đọc qua tầng config; phân cách dấu phẩy; chưa
    // cấu hình = lớp này tắt, lớp Apikey vẫn bắt buộc).
    const allowlist = (this.config.get<string>('SEPAY_IPN_IP_ALLOWLIST') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowlist.length > 0) {
      const ip = (input.ip ?? '').replace(/^::ffff:/, '');
      if (!allowlist.includes(ip)) {
        throw new UnauthorizedException({ message: 'IPN source IP is not allowlisted', code: 'payment.ipn_ip_not_allowed' });
      }
    }
    const transactionId = String(body.transaction_id ?? body.transactionId ?? body.id ?? '');
    if (!transactionId) {
      throw new BadRequestException({ message: 'IPN payload has no transaction id', code: 'payment.ipn_missing_transaction' });
    }
    const amountRaw = Number(body.amount ?? body.transferAmount ?? body.transfer_amount);
    const amount = Number.isFinite(amountRaw) ? Math.trunc(amountRaw) : 0;
    const content = String(body.content ?? '');
    const transferType = String(body.transfer_type ?? body.transferType ?? '').toLowerCase();
    const direction = transferType === 'debit' || transferType === 'out' ? 'debit' : 'credit';
    // Lớp 2 — định tuyến TRƯỚC khi xác thực (khoá nằm trong config của account đích).
    const xid = String(body.bank_account_xid ?? body.bankAccountXid ?? '');
    const accountNumber = String(body.account_number ?? body.accountNumber ?? '');
    let account = xid ? await this.repo.findAccountBySepayXid(xid) : undefined;
    if (!account && accountNumber) account = await this.repo.findAccountByBankNumber(accountNumber);
    if (!account) {
      throw new UnauthorizedException({ message: 'IPN targets an unknown payment account', code: 'payment.ipn_account_unknown' });
    }
    const expectedKey = readAccountConfig(account.config).sepayApiKey;
    if (!expectedKey) {
      throw new UnauthorizedException({ message: 'Payment account has no SePay API key configured', code: 'payment.ipn_not_configured' });
    }
    const headerMatch = /^Apikey\s+(.+)$/i.exec((input.authorization ?? '').trim());
    const presented = headerMatch?.[1] ?? '';
    const presentedBuf = Buffer.from(presented);
    const expectedBuf = Buffer.from(expectedKey);
    if (!presented || presentedBuf.length !== expectedBuf.length || !timingSafeEqual(presentedBuf, expectedBuf)) {
      throw new UnauthorizedException({ message: 'IPN API key verification failed', code: 'payment.ipn_unauthorized' });
    }
    // Đã xác thực: ghi sổ sự kiện thô. Trùng transaction_id (SePay retry) →
    // unique chặn, trả thành công ngay, không xử lý lại (6.4.2).
    const event = await this.repo.insertProviderEvent({
      provider: 'sepay', tenantId: account.tenantId, accountId: account.id,
      externalTransactionId: transactionId, direction, amount, content,
      extractedCode: extractPaymentCode(content), matchStatus: 'received', raw: body,
    });
    if (!event) return { success: true, duplicate: true };
    return { success: true };
  }

  // --- Vòng đời hoàn tiền (lát 3, issue #189) ------------------------------
  //
  // Luồng nghiệp vụ: hoàn tiền là TIỀN RA KHỎI TÀI KHOẢN CỦA CHỦ TIỀN
  // nên không còn là một thao tác ghi sổ tức thời như trước. Một khoản
  // hoàn đi qua vòng đời `requested → approved → settled` (hoặc bị
  // `rejected` kèm lý do bắt buộc):
  //
  // 1. TẠO YÊU CẦU (createRefund): người có quyền quản lý tài khoản của
  //    chủ tiền (neo theo tenant chủ tiền) tạo yêu cầu kèm lý do bắt
  //    buộc và mã lệnh chi dự kiến nếu đã biết. Cổng cộng dồn chạy
  //    TRONG MỘT TRANSACTION CÓ KHOÁ DÒNG `payments`: tổng các dòng
  //    hoàn chưa bị từ chối (requested + approved + settled) cộng lần
  //    này không được vượt số tiền khoản thu — hai yêu cầu song song
  //    thì đúng một yêu cầu qua cổng, yêu cầu còn lại nhận
  //    `payment.refund_exceeds_total`. Cấp duyệt quyết ngay tại đây:
  //    MỘT CẤP (dòng hoàn sang `approved` ngay, người tạo là người
  //    duyệt) khi hoàn một phần dưới ngưỡng; HAI CẤP (dòng hoàn ở
  //    `requested` chờ duyệt) khi số tiền lần hoàn từ ngưỡng trở lên
  //    HOẶC lần hoàn làm cộng dồn đạt 100% khoản thu. Ngưỡng đọc từ
  //    khoá cấu hình `refunddualapprovalthreshold` (component
  //    `payments`), phân giải theo tenant chủ tiền (platform đặt giá
  //    trị chung, tenant ghi đè được); 0 = luôn hai cấp. Ngưỡng hiệu
  //    lực được ghi vào chính dòng hoàn để vết kiểm toán đứng vững dù
  //    cấu hình đổi sau này.
  // 2. DUYỆT (approveRefund): chỉ áp cho dòng đang `requested`; người
  //    duyệt phải KHÁC người tạo — chặn ở tầng service này bằng mã lỗi
  //    riêng để không đường gọi nào (kể cả gọi thẳng service) lách
  //    được; TỪ CHỐI (rejectRefund) áp cho dòng `requested`/`approved`
  //    và bắt buộc lý do — dòng `rejected` giải phóng ngân sách hoàn.
  // 3. XÁC NHẬN CHI (settleRefund tay, hoặc tự động khi sự kiện
  //    `debit` của SePay khớp — xem settleRefundFromDebitEvent): chỉ
  //    áp cho dòng `approved`, kèm mã lệnh chi thực tế. Đây là mốc DUY
  //    NHẤT đảo quyền lợi: nếu lần xác nhận này làm cộng dồn đã chi
  //    (các dòng `settled`) đạt đúng 100% khoản thu thì đình chỉ quyền
  //    lợi TRƯỚC (ghi danh / thành viên lớp / quyền lợi gói — mọi khâu
  //    đều idempotent) rồi mới ghi dòng hoàn `settled` + lật khoản thu
  //    sang `refunded` trong một transaction. Đình chỉ ném lỗi ⇒ chưa
  //    ghi gì cả, khoản thu còn `succeeded`, dòng hoàn còn `approved`,
  //    gọi lại được — không để trạng thái "tiền đã ghi hoàn nhưng
  //    quyền lợi vẫn chạy". Hoàn một phần (cộng dồn chưa 100%) không
  //    đảo quyền lợi.
  //
  // Quyền ở mọi bước neo theo CHỦ TIỀN của khoản thu (tenant của khoản
  // thu): tiền gói neo tại context hệ thống; học phí neo tại context
  // tenant của trung tâm sở hữu.

  /** Chiếu một dòng hoàn thành dạng API kèm trọn vết kiểm toán vòng đời. */
  private toRefundView(row: RefundRow): PaymentRefund {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const reversal = (data['reversal'] ?? null) as { applied?: boolean } | null;
    return {
      id: row.id,
      paymentId: row.paymentId,
      amount: row.amount,
      currency: row.currency,
      reason: row.reason,
      externalTransactionId: row.externalTransactionId,
      status: row.status as PaymentRefund['status'],
      createdBy: row.createdBy,
      approvalLevel: row.approvalLevel,
      approvalThreshold: row.approvalThreshold,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      rejectedBy: row.rejectedBy,
      rejectedAt: row.rejectedAt ? row.rejectedAt.toISOString() : null,
      rejectionReason: row.rejectionReason,
      settledBy: row.settledBy,
      settledEventId: row.settledEventId,
      settledAt: row.settledAt ? row.settledAt.toISOString() : null,
      entitlementReversed: reversal ? reversal.applied === true : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Ngưỡng duyệt hai cấp hiệu lực cho chủ tiền của khoản thu (đơn vị tiền nhỏ nhất). */
  private async refundDualApprovalThreshold(tenantId: string): Promise<number> {
    const value = await this.tenantConfig.getEffectiveValue<number>(tenantId, 'payments', 'refunddualapprovalthreshold');
    return typeof value === 'number' && Number.isFinite(value) ? value : 1_000_000;
  }

  /** Ngưỡng tuổi quá hạn (giờ) của hàng đợi `needs_review` cho một tenant chủ tiền. */
  private async reviewTargetHours(tenantId: string): Promise<number> {
    const value = await this.tenantConfig.getEffectiveValue<number>(tenantId, 'payments', 'reviewtargethours');
    return typeof value === 'number' && Number.isFinite(value) ? value : 48;
  }

  /**
   * Tạo yêu cầu hoàn — bước 1 của vòng đời. Xem khối luồng nghiệp vụ ở
   * đầu mục này: cổng cộng dồn nguyên tử (transaction + khoá dòng
   * `payments` FOR UPDATE, tổng tính cả dòng `requested`/`approved`)
   * và luật cấp duyệt đều nằm ở đây.
   */
  async createRefund(actorId: string, paymentId: string, input: CreateRefund): Promise<PaymentRefund> {
    const payment = await this.getPayment(paymentId);
    await this.requireManageAccountsForTenant(actorId, payment.tenantId);
    if (payment.status !== 'succeeded') throw new BadRequestException({ message: 'Only a succeeded payment can be refunded', code: 'payment.not_succeeded' });
    if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > payment.amount) {
      throw new BadRequestException({ message: 'Refund amount must be a positive integer not exceeding the payment amount', code: 'payment.bad_refund_amount' });
    }
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new BadRequestException({ message: 'A refund reason is required', code: 'payment.refund_reason_required' });
    }
    const threshold = await this.refundDualApprovalThreshold(payment.tenantId);
    const created = await this.repo.dbHandle.transaction(async (tx) => {
      // Khoá dòng payments: mọi yêu cầu hoàn của cùng một khoản thu xếp
      // hàng tại đây, cổng cộng dồn đọc-tổng → so sánh → ghi không thể
      // bị hai yêu cầu song song chẻ đôi (mỗi transaction thấy tổng đã
      // gồm dòng của transaction thắng trước).
      await tx.execute(sql`select id from payments where id = ${payment.id} for update`);
      const counted = await this.repo.sumRefundsByStatuses(payment.id, ['requested', 'approved', 'settled'], tx);
      if (counted + input.amount > payment.amount) {
        throw new BadRequestException({ message: 'Cumulative refunds would exceed the original payment amount', code: 'payment.refund_exceeds_total' });
      }
      // Luật hai cấp: lần hoàn từ ngưỡng trở lên, hoặc lần hoàn làm
      // cộng dồn đạt 100% khoản thu. Ngưỡng 0 ⇒ điều kiện thứ nhất luôn
      // đúng ⇒ mọi khoản hoàn đều hai cấp.
      const dual = input.amount >= threshold || counted + input.amount === payment.amount;
      const now = new Date();
      return this.repo.insertRefund({
        paymentId: payment.id, amount: input.amount, currency: payment.currency,
        reason, externalTransactionId: input.externalTransactionId ?? null,
        status: dual ? 'requested' : 'approved',
        createdBy: actorId,
        approvalLevel: dual ? 2 : 1,
        approvalThreshold: threshold,
        approvedBy: dual ? null : actorId,
        approvedAt: dual ? null : now,
      }, tx);
    });
    return this.toRefundView(created);
  }

  /** Nạp dòng hoàn thuộc đúng khoản thu, không tồn tại (hoặc thuộc khoản thu khác) ⇒ 404. */
  private async getRefundOfPayment(paymentId: string, refundId: string): Promise<RefundRow> {
    const refund = await this.repo.getRefund(refundId);
    if (!refund || refund.paymentId !== paymentId) {
      throw new NotFoundException({ message: `Refund ${refundId} not found`, code: 'payment.refund_not_found' });
    }
    return refund;
  }

  /**
   * Duyệt cấp 2 một yêu cầu hoàn đang `requested`. Người duyệt phải
   * khác người tạo — luật tách nhiệm vụ của dòng tiền, chặn tại tầng
   * service (mọi đường gọi đều qua đây) bằng mã lỗi riêng
   * `payment.refund_approver_must_differ`.
   *
   * Chuyển trạng thái bằng cập nhật CÓ ĐIỀU KIỆN (`requested` nằm ngay
   * trong `WHERE`): kiểm tra đọc ở trên chỉ để báo lỗi sớm cho lượt
   * gọi thường; hai lượt duyệt song song thì chỉ một câu cập nhật
   * khớp dòng, lượt còn lại khớp 0 dòng và nhận cùng mã lỗi
   * `payment.refund_not_pending_approval` — không có chuyện hai người
   * cùng duyệt qua hoặc duyệt ghi đè lên từ chối.
   */
  async approveRefund(actorId: string, paymentId: string, refundId: string): Promise<PaymentRefund> {
    const payment = await this.getPayment(paymentId);
    await this.requireManageAccountsForTenant(actorId, payment.tenantId);
    const refund = await this.getRefundOfPayment(paymentId, refundId);
    if (refund.status !== 'requested') {
      throw new BadRequestException({ message: 'Refund is not pending approval', code: 'payment.refund_not_pending_approval' });
    }
    if (refund.createdBy !== null && refund.createdBy === actorId) {
      throw new BadRequestException({ message: 'The second approver must differ from the refund creator', code: 'payment.refund_approver_must_differ' });
    }
    const updated = await this.repo.updateRefundFromStatuses(refund.id, ['requested'], { status: 'approved', approvedBy: actorId, approvedAt: new Date() });
    if (!updated) {
      throw new BadRequestException({ message: 'Refund is not pending approval', code: 'payment.refund_not_pending_approval' });
    }
    return this.toRefundView(updated);
  }

  /**
   * Từ chối một yêu cầu hoàn (`requested` hoặc `approved`) — lý do bắt
   * buộc. Dòng `rejected` ra khỏi cổng cộng dồn nên ngân sách hoàn của
   * khoản thu được giải phóng cho yêu cầu khác.
   *
   * Chuyển trạng thái bằng cập nhật CÓ ĐIỀU KIỆN như ở
   * {@link approveRefund}: tập trạng thái nguồn (`requested`,
   * `approved`) nằm ngay trong `WHERE` của câu cập nhật; lượt từ chối
   * đua với một lượt duyệt/từ chối khác mà về sau thì khớp 0 dòng và
   * nhận cùng mã lỗi `payment.refund_not_rejectable`.
   */
  async rejectRefund(actorId: string, paymentId: string, refundId: string, input: RejectRefund): Promise<PaymentRefund> {
    const payment = await this.getPayment(paymentId);
    await this.requireManageAccountsForTenant(actorId, payment.tenantId);
    const refund = await this.getRefundOfPayment(paymentId, refundId);
    if (refund.status !== 'requested' && refund.status !== 'approved') {
      throw new BadRequestException({ message: 'Refund can no longer be rejected', code: 'payment.refund_not_rejectable' });
    }
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new BadRequestException({ message: 'A rejection reason is required', code: 'payment.refund_rejection_reason_required' });
    }
    const updated = await this.repo.updateRefundFromStatuses(refund.id, ['requested', 'approved'], {
      status: 'rejected', rejectedBy: actorId, rejectedAt: new Date(), rejectionReason: reason,
    });
    if (!updated) {
      throw new BadRequestException({ message: 'Refund can no longer be rejected', code: 'payment.refund_not_rejectable' });
    }
    return this.toRefundView(updated);
  }

  /**
   * Đình chỉ quyền lợi của một khoản thu khi hoàn đủ 100% — dùng chung
   * cho cả ba component có quyền lợi. Mọi khâu đều idempotent (đình
   * chỉ một ghi danh/quyền lợi đã đình chỉ là no-op) nên khâu xác nhận
   * chi gọi lại được an toàn sau lỗi giữa chừng. `actorId` là người
   * xác nhận chi (hoặc người tạo yêu cầu hoàn khi hệ thống tự xác
   * nhận qua sự kiện `debit`) vì `EnrolService.setSuspended` tự gác
   * quyền `enrol:manage` theo actor đó.
   *
   * Nguyên tử (issue #490, DL-10): hàm này chạy BẰNG transaction
   * `tx` của khâu settle truyền vào — cả ba đường đình chỉ đều ghi
   * qua đúng transaction đó, nên settle rollback thì đình chỉ cũng
   * bị huỷ (trước đây mỗi đường đình chỉ tự mở transaction riêng và
   * commit ngay giữa settle: settle lỗi ghi sổ thì học viên đã mất
   * quyền lợi trong khi khoản hoàn chưa hề được ghi). Riêng sự kiện
   * rời cohort của đường `class_fee` là sự kiện TRONG TIẾN TRÌNH mà
   * handler đồng bộ đọc trạng thái đã commit, nên không phát tại
   * đây: hàm trả về `{ cohortId, userId }` của lần gỡ để khâu settle
   * phát bù SAU khi transaction commit (xem `applyRefundSettlement`).
   * Trả null khi không có lần gỡ cohort nào chờ phát.
   */
  private async suspendEntitlementForFullRefund(actorId: string, payment: PaymentRow, tx: DbTx): Promise<{ cohortId: string; userId: string } | null> {
    if (payment.component === 'enrol_fee' && payment.itemId) {
      await this.enrol.setSuspended(actorId, payment.itemId, payment.userId, true, tx);
    }
    // CLASS-3: hoàn đủ gói lớp → đình chỉ khỏi lớp (gỡ backing cohort;
    // cohort sync đình chỉ mọi khoá, giữ điểm/dữ liệu theo chế độ rời
    // mặc định của lớp).
    if (payment.component === 'class_fee' && payment.itemId) {
      const cohortId = await this.classes.suspendPaidClassMember(payment.itemId, payment.userId, tx);
      return cohortId ? { cohortId, userId: payment.userId } : null;
    }
    // Lát 2 (#189): hoàn đủ gói → đình chỉ quyền lợi gói của chính
    // payment đó.
    if (payment.component === 'tenant_plan' || payment.component === 'teacher_plan') {
      await this.plans.suspendForPayment(payment, tx);
    }
    return null;
  }

  /**
   * Khâu xác nhận chi dùng chung cho xác nhận TAY (settleRefund) và
   * xác nhận TỰ ĐỘNG qua sự kiện `debit` (settleRefundFromDebitEvent).
   *
   * Toàn bộ quyết định chạy trong MỘT transaction mở đầu bằng khoá
   * dòng khoản thu (`FOR UPDATE`). Khoá này tuần tự hoá mọi lượt xác
   * nhận chi trên cùng khoản thu — kể cả hai đường tay/`debit` chạy
   * song song — nên từng bước dưới đây luôn thấy trạng thái đã chốt
   * của lượt trước:
   *  1. Đọc lại dòng hoàn DƯỚI khoá: đã `settled` (lượt đua thắng đã
   *     ghi) thì trả nguyên dòng đó, không ghi thêm; không còn
   *     `approved` thì ném `payment.refund_not_approved` TRƯỚC mọi
   *     đình chỉ — không bao giờ đình chỉ oan cho một khoản hoàn
   *     không được ghi.
   *  2. Tính lại tổng đã `settled` DƯỚI khoá: lần xác nhận này có
   *     làm cộng dồn đạt 100% hay không được quyết định TẠI ĐÂY,
   *     không dựa vào bất kỳ lượt đọc ngoài khoá nào. (Quyết định
   *     đình chỉ bằng tổng đọc ngoài khoá là khe đồng thời: hai
   *     dòng hoàn bù nhau — ví dụ 60.000 + 40.000 trên khoản
   *     100.000 — cùng xác nhận chi một lúc đều đọc tổng settled
   *     bằng 0, không lượt nào đình chỉ, nhưng transaction vào sau
   *     vẫn lật khoản thu `refunded` và ghi `reversal.applied =
   *     true` trong khi quyền lợi chưa hề bị đình chỉ — tiền đã
   *     ghi hoàn mà quyền lợi vẫn chạy.)
   *  3. Đạt 100% theo tổng đã khoá thì đình chỉ quyền lợi
   *     (idempotent) TRƯỚC khi ghi: đình chỉ ném lỗi ⇒ transaction
   *     huỷ, chưa ghi gì, gọi lại được. Chưa đạt thì ghi mà không
   *     đình chỉ. Đình chỉ ghi BẰNG CHÍNH transaction này (issue
   *     #490, DL-10) — mọi bước ghi sổ sau đó mà lỗi, transaction
   *     rollback thì đình chỉ cũng bị huỷ theo, không còn trạng thái
   *     "đã đình chỉ nhưng chưa ghi hoàn".
   *  4. Ghi dòng hoàn `settled` (+ lật khoản thu `refunded` khi đạt
   *     100%) trong cùng transaction rồi commit.
   *  5. SAU khi commit: nếu bước 3 có gỡ một thành viên khỏi backing
   *     cohort (đường `class_fee`), phát sự kiện trong-tiến-trình
   *     `cohort_member_removed` để cohort sync đình chỉ các ghi danh
   *     tương ứng. Sự kiện này bắt buộc chờ sau commit vì handler
   *     đồng bộ kiểm tra tư cách thành viên ĐÃ commit — phát giữa
   *     transaction sẽ thấy thành viên vẫn còn và bỏ qua, trong khi
   *     thứ tự sự kiện quan sát được từ bên ngoài không đổi: việc gỡ
   *     chỉ hiện hình (commit) ngay trước khi sự kiện phát. Bước
   *     phát này mà ném lỗi thì kết quả settle KHÔNG đổi: settle đã
   *     commit xong nên lỗi chỉ được bắt và ghi log cảnh báo có ngữ
   *     cảnh tại điểm phát — tuyệt đối không ném ngược ra người gọi
   *     (đường tay sẽ báo lỗi cho một xác nhận chi đã ghi sổ, đường
   *     tự động sẽ đánh dấu oan sự kiện `debit` là `needs_review`).
   *     Đường đồng bộ bền không phụ thuộc bước phát nhanh này: hàng
   *     outbox `cohort_member_removed` đã ghi trong chính
   *     transaction ở bước 3 (xem `removeCohortMemberInternal`) và
   *     consumer outbox sẵn có sẽ quét hàng đó để áp đình chỉ bù.
   * Hoàn một phần: không đình chỉ, khoản thu giữ `succeeded`.
   */
  private async applyRefundSettlement(input: {
    payment: PaymentRow; refund: RefundRow; externalTransactionId: string;
    settledBy: string | null; settledEventId: string | null; suspensionActorId: string;
  }): Promise<RefundRow> {
    const { payment, refund } = input;
    const now = new Date();
    const outcome = await this.repo.dbHandle.transaction(async (tx) => {
      await tx.execute(sql`select id from payments where id = ${payment.id} for update`);
      const fresh = await this.repo.getRefund(refund.id, tx);
      if (!fresh || fresh.status === 'settled') return { settled: fresh ?? refund, pendingRemoval: null };
      if (fresh.status !== 'approved') {
        throw new BadRequestException({ message: 'Refund is not approved for settlement', code: 'payment.refund_not_approved' });
      }
      const settledSum = await this.repo.sumRefundsByStatuses(payment.id, ['settled'], tx);
      const full = settledSum + fresh.amount === payment.amount;
      let pendingRemoval: { cohortId: string; userId: string } | null = null;
      if (full) {
        // Đình chỉ trước mọi ghi sổ, theo đúng tổng đã khoá ở trên và
        // bằng chính transaction này: lỗi tại đây ⇒ transaction huỷ
        // trước khi ghi, gọi lại được.
        pendingRemoval = await this.suspendEntitlementForFullRefund(input.suspensionActorId, payment, tx);
      }
      const data = { ...((fresh.data ?? {}) as Record<string, unknown>), reversal: { applied: full, at: now.toISOString() } };
      const updated = await this.repo.updateRefund(fresh.id, {
        status: 'settled', settledAt: now,
        settledBy: input.settledBy, settledEventId: input.settledEventId,
        externalTransactionId: input.externalTransactionId, data,
      }, tx);
      if (full) await this.repo.updatePayment(payment.id, { status: 'refunded' }, tx);
      return { settled: updated, pendingRemoval };
    });
    // Bước 5 của flow: transaction đã commit — phát bù sự kiện rời
    // cohort để cohort sync áp đình chỉ xuống các ghi danh của lớp.
    // Lỗi tại bước phát này không được ném ngược: sổ hoàn đã settled
    // và khoản thu đã refunded, nên chỉ ghi log cảnh báo có ngữ cảnh;
    // hàng outbox đã ghi trong transaction là đường đồng bộ bù bền.
    if (outcome.pendingRemoval) {
      try {
        await this.classes.notifyPaidClassMemberRemoved(outcome.pendingRemoval.cohortId, outcome.pendingRemoval.userId);
      } catch (error) {
        this.logger.warn(
          `Phát sự kiện cohort_member_removed sau khi settle hoàn tiền đã commit lỗi (refund=${outcome.settled.id}, payment=${payment.id}, cohort=${outcome.pendingRemoval.cohortId}, user=${outcome.pendingRemoval.userId}) — kết quả settle giữ nguyên, đồng bộ ghi danh đi qua hàng outbox đã ghi trong transaction: ${(error as Error).message}`,
        );
      }
    }
    return outcome.settled;
  }

  /**
   * Xác nhận chi TAY cho một dòng hoàn đã duyệt: gắn mã lệnh chi thực
   * tế; mã này phải trùng mã dự kiến đã ghi lúc tạo nếu có (hai nguồn
   * lệch nhau ⇒ dừng, người vận hành phải làm rõ lệnh chi nào là
   * thật trước khi tiền được ghi là đã ra).
   */
  async settleRefund(actorId: string, paymentId: string, refundId: string, input: SettleRefund): Promise<PaymentRefund> {
    const payment = await this.getPayment(paymentId);
    await this.requireManageAccountsForTenant(actorId, payment.tenantId);
    const refund = await this.getRefundOfPayment(paymentId, refundId);
    if (refund.status !== 'approved') {
      throw new BadRequestException({ message: 'Refund is not approved for settlement', code: 'payment.refund_not_approved' });
    }
    const externalTransactionId = input.externalTransactionId ?? refund.externalTransactionId;
    if (!externalTransactionId) {
      throw new BadRequestException({ message: 'A payout transaction reference is required to settle a refund', code: 'payment.refund_tx_required' });
    }
    if (refund.externalTransactionId && input.externalTransactionId && refund.externalTransactionId !== input.externalTransactionId) {
      throw new BadRequestException({ message: 'Payout transaction reference does not match the reference recorded on the refund', code: 'payment.refund_tx_mismatch' });
    }
    const settled = await this.applyRefundSettlement({
      payment, refund, externalTransactionId,
      settledBy: actorId, settledEventId: null, suspensionActorId: actorId,
    });
    return this.toRefundView(settled);
  }

  /**
   * Xác nhận chi TỰ ĐỘNG từ một sự kiện `debit` của provider (SePay) —
   * điểm vào của SepayMatchingService. Đối khớp theo (mã lệnh chi, tài
   * khoản, số tiền): dòng hoàn đang `approved` có mã lệnh chi trùng mã
   * giao dịch ngoài hoặc mã tham chiếu của sự kiện, thuộc khoản thu
   * trên đúng tài khoản nhận sự kiện, số tiền bằng nhau. Khớp ⇒ xác
   * nhận chi qua cùng khâu dùng chung (đảo quyền lợi nếu đạt 100%) và
   * đánh dấu sự kiện `matched`. Không khớp được dòng hoàn nào ⇒ sự
   * kiện vào `needs_review` của tenant sở hữu tài khoản nhận (tiền đã
   * ra khỏi tài khoản mà hệ thống không rõ chi cho khoản hoàn nào —
   * tuyệt đối không `ignored` im lặng). Sự kiện phát lại (retry) được
   * nhận diện qua `settled_event_id` đã ghi trên dòng hoàn: coi như đã
   * xử lý, không xác nhận chi hai lần.
   */
  async settleRefundFromDebitEvent(event: ProviderEventRow): Promise<void> {
    const already = await this.repo.getRefundBySettledEventId(event.id);
    if (already) {
      await this.repo.updateProviderEvent(event.id, { matchStatus: 'matched', matchedPaymentId: already.paymentId });
      return;
    }
    if (!event.accountId) {
      // Sự kiện không gắn tài khoản nhận (bất thường ở đường IPN, vốn
      // luôn định tuyến theo tài khoản) — không đối khớp được, vào
      // hàng đợi của tenant chủ sự kiện để vận hành nhìn thấy.
      await this.repo.updateProviderEvent(event.id, { matchStatus: 'needs_review' });
      return;
    }
    const raw = (event.raw ?? {}) as Record<string, unknown>;
    const referenceCode = typeof raw['reference_code'] === 'string' ? raw['reference_code'] : typeof raw['referenceCode'] === 'string' ? raw['referenceCode'] : '';
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
      // lỗi): dòng hoàn còn `approved` để xử lý lại được; sự kiện vào
      // `needs_review` dạng mồ côi (không gắn khoản thu) để hiện lên
      // hàng đợi của chủ tiền — tiền đã ra mà chưa ghi sổ xong là
      // việc vận hành phải nhìn thấy, không được phép chìm im lặng.
      await this.repo.updateProviderEvent(event.id, { matchStatus: 'needs_review' });
    }
  }

  async listRefunds(paymentId: string): Promise<PaymentRefund[]> {
    const rows = await this.repo.listRefunds(paymentId);
    return rows.map((r) => this.toRefundView(r));
  }

  // --- Hàng đợi needs_review (lát 3, issue #189) ---------------------------
  //
  // Luồng nghiệp vụ: khoản thu rơi vào `needs_review` khi tiền về
  // không khớp sạch (sai số tiền, sai tài khoản, quá hạn, mã lạ) hoặc
  // một sự kiện `debit` không khớp được dòng hoàn nào. Hàng đợi CHIA
  // THEO CHỦ TIỀN qua khoá phân vùng là tenant của khoản thu/tài khoản
  // nhận: tiền gói thuộc hàng đợi PLATFORM (gác tại context hệ thống),
  // học phí thuộc hàng đợi CỦA TRUNG TÂM sở hữu (gác tại context tenant
  // của trung tâm) — tách bạch hiển thị tuyệt đối, không vai nào thấy
  // khoản chờ của tenant khác. Phạm vi của người xem = mọi tenant mà
  // người đó có `payment:manageaccounts` tại đúng context neo của
  // tenant đó; không có tenant nào trong phạm vi ⇒ bị chặn.
  //
  // Xử lý tay (resolvePaymentReview) có hai quyết định, cả hai bắt
  // buộc lý do và đều ghi VẾT XỬ LÝ (người xử lý, quyết định, lý do,
  // thời điểm) lên chính dòng khoản thu: `matched` = khớp tay về
  // `succeeded` — kích hoạt quyền lợi TRỰC TIẾP (ghi danh / lớp / gói,
  // đều idempotent) TRƯỚC nhịp lật trạng thái rồi phát đúng outbox
  // `payment_succeeded`, đúng bất biến đồng bộ của đường khớp tự động
  // (trạng thái `succeeded` không bao giờ quan sát được khi quyền lợi
  // chưa kích hoạt; kích hoạt lỗi thì khoản thu còn ở hàng đợi, xử lý
  // lại được); `rejected` = bác bỏ, khoản thu về `failed`. Khoản chờ
  // quá tuổi cấu hình (`payments/reviewtargethours`) chỉ bị đánh dấu
  // QUÁ HẠN để cảnh báo — hệ thống không bao giờ tự xử lý, vì xử lý
  // tay là xác nhận tiền thật và phải có người chịu trách nhiệm.
  // Riêng quyết định `matched` còn một cổng nữa (issue #419):
  // payment phải khớp giá + tenant phía server của đối tượng đích
  // qua `verifyPaymentAgainstServerTarget`; lệch thì quyết định bị
  // từ chối và khoản thu ở nguyên trong hàng đợi.

  /**
   * Phạm vi hàng đợi của một người xem: tenant platform nếu người đó
   * có quyền tại context hệ thống, cộng mọi tenant trung tâm mà người
   * đó là thành viên đang hoạt động VÀ có quyền tại context tenant
   * của trung tâm đó.
   */
  private async reviewQueueScopeTenantIds(actorId: string): Promise<string[]> {
    const scope: string[] = [];
    const platformId = await this.platformTenantId();
    const sys = await this.contexts.ensureSystemContext();
    if (await this.evaluator.hasCapability(actorId, 'payment:manageaccounts', sys.id)) {
      scope.push(platformId);
    }
    const mine = await this.tenants.listMyTenants(actorId);
    for (const tenant of mine) {
      if (tenant.id === platformId || scope.includes(tenant.id)) continue;
      const ctx = await this.contexts.ensureTenantContext(tenant.id);
      if (await this.evaluator.hasCapability(actorId, 'payment:manageaccounts', ctx.id)) {
        scope.push(tenant.id);
      }
    }
    return scope;
  }

  /**
   * Danh sách khoản chờ trong phạm vi của người xem: khoản thu
   * `needs_review` (kèm sự kiện liên quan gần nhất + các điều kiện lệch
   * suy tại thời điểm xem) và sự kiện provider mồ côi `needs_review`
   * (không gắn khoản thu nào). Mỗi mục mang tuổi chờ và cờ quá hạn
   * theo cấu hình của tenant chủ tiền.
   */
  async listReviewQueue(actorId: string): Promise<PaymentReviewQueueItem[]> {
    const scope = await this.reviewQueueScopeTenantIds(actorId);
    if (scope.length === 0) {
      throw new ForbiddenException({ message: 'Missing capability payment:manageaccounts', code: 'access.capability_denied' });
    }
    const now = Date.now();
    const items: PaymentReviewQueueItem[] = [];
    // Ngưỡng quá hạn là cấu hình hiệu lực THEO TENANT: trong một lần
    // dựng hàng đợi, mỗi tenant chỉ tra cấu hình một lần rồi dùng lại
    // cho mọi khoản thu/sự kiện của tenant đó (trước đây tra lại theo
    // từng dòng). Cache giữ cả Promise để các dòng cùng tenant dùng
    // chung đúng một lượt tra.
    const targetHoursByTenant = new Map<string, Promise<number>>();
    const targetHoursFor = (tenantId: string): Promise<number> => {
      let cached = targetHoursByTenant.get(tenantId);
      if (!cached) {
        cached = this.reviewTargetHours(tenantId);
        targetHoursByTenant.set(tenantId, cached);
      }
      return cached;
    };
    const payments = await this.repo.listNeedsReviewPayments(scope);
    for (const payment of payments) {
      const event = await this.repo.getLatestEventForPayment(payment);
      const mismatches: PaymentReviewQueueItem['mismatches'] = [];
      if (event) {
        if (event.amount !== payment.amount) mismatches.push('amount_mismatch');
        if (event.accountId !== payment.accountId) mismatches.push('account_mismatch');
        if (payment.expiresAt && event.receivedAt.getTime() > payment.expiresAt.getTime()) mismatches.push('expired');
      }
      const ageHours = Math.max(0, (now - payment.updatedAt.getTime()) / 3_600_000);
      items.push({
        kind: 'payment',
        tenantId: payment.tenantId,
        payment: {
          id: payment.id, paymentCode: payment.paymentCode, amount: payment.amount,
          currency: payment.currency, component: payment.component, userId: payment.userId,
          expiresAt: payment.expiresAt ? payment.expiresAt.toISOString() : null,
          createdAt: payment.createdAt.toISOString(),
        },
        event: event ? {
          id: event.id, externalTransactionId: event.externalTransactionId, direction: event.direction as 'credit' | 'debit',
          amount: event.amount, extractedCode: event.extractedCode,
          receivedAt: event.receivedAt.toISOString(),
        } : null,
        mismatches,
        ageHours,
        overdue: ageHours > (await targetHoursFor(payment.tenantId)),
      });
    }
    const events = await this.repo.listNeedsReviewEvents(scope);
    for (const event of events) {
      // Truy vấn đã lọc theo danh sách tenant trong phạm vi nên
      // tenantId không thể rỗng ở đây; chốt chặn cho tầng kiểu.
      if (!event.tenantId) continue;
      const ageHours = Math.max(0, (now - event.receivedAt.getTime()) / 3_600_000);
      items.push({
        kind: 'event',
        tenantId: event.tenantId,
        payment: null,
        event: {
          id: event.id, externalTransactionId: event.externalTransactionId, direction: event.direction as 'credit' | 'debit',
          amount: event.amount, extractedCode: event.extractedCode,
          receivedAt: event.receivedAt.toISOString(),
        },
        mismatches: [event.direction === 'debit' ? 'unmatched_debit' : 'unknown_code'],
        ageHours,
        overdue: ageHours > (await targetHoursFor(event.tenantId)),
      });
    }
    return items;
  }

  /**
   * Xử lý tay một khoản thu đang `needs_review` — quyền neo theo chủ
   * tiền của chính khoản thu (không theo phiên): quản trị platform
   * không xử lý được học phí của trung tâm và ngược lại, trừ khi có
   * quyền tại đúng context neo của tenant chủ tiền.
   */
  async resolvePaymentReview(actorId: string, paymentId: string, input: ResolvePaymentReview): Promise<PaymentView> {
    const payment = await this.getPayment(paymentId);
    await this.requireManageAccountsForTenant(actorId, payment.tenantId);
    if (payment.status !== 'needs_review') {
      throw new BadRequestException({ message: 'Payment is not waiting in the review queue', code: 'payment.not_in_review' });
    }
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new BadRequestException({ message: 'A review resolution reason is required', code: 'payment.review_reason_required' });
    }
    const trail = {
      reviewDecision: input.decision, reviewReason: reason,
      reviewHandledBy: actorId, reviewHandledAt: new Date(),
    };
    if (input.decision === 'rejected') {
      await this.repo.updatePayment(payment.id, { status: 'failed', ...trail });
      return this.getPayment(payment.id);
    }
    // Quyết định `matched` cũng không được lách phép đối chiếu giá
    // phía server (issue #419): người xử lý xác nhận tiền đã về bằng
    // bằng chứng ngoài hệ thống, nhưng quyền lợi chỉ được kích hoạt
    // khi payment khớp giá + tenant của đối tượng đích phía server.
    // Payment bị can thiệp (số tiền tự đặt thấp hơn giá thật, tenant
    // khác tenant đích) phải ở lại hàng đợi để rà soát/hoàn tiền —
    // từ chối quyết định khớp, giữ nguyên trạng thái `needs_review`
    // và không ghi vết xử lý `matched` lên một khoản thu chưa sạch.
    if (!(await this.verifyPaymentAgainstServerTarget(payment))) {
      throw new BadRequestException({
        message: 'Payment amount or tenant does not match the server-side price and tenant of its target; refusing to activate entitlements',
        code: 'payment.target_mismatch',
      });
    }
    // matched: mã giao dịch ngoài lấy từ sự kiện liên quan gần nhất
    // (mã tham chiếu trong nội dung chuyển khoản nếu có, không thì mã
    // giao dịch của sự kiện) để khoản thu mang đúng định danh đối soát
    // của khoản tiền đã về; khoản chờ không có sự kiện đi kèm thì giữ
    // nguyên mã hiện tại.
    const event = await this.repo.getLatestEventForPayment(payment);
    let externalTransactionId = payment.externalTransactionId;
    if (event) {
      const raw = (event.raw ?? {}) as Record<string, unknown>;
      const reference = typeof raw['reference_code'] === 'string' ? raw['reference_code'] : typeof raw['referenceCode'] === 'string' ? raw['referenceCode'] : null;
      externalTransactionId = reference ?? event.externalTransactionId;
    }
    // Kích hoạt quyền lợi TRỰC TIẾP trước nhịp lật trạng thái — đúng
    // bất biến đồng bộ của đường khớp tự động và đường webhook (cả ba
    // khâu đều idempotent; khâu nào lỗi thì khoản thu còn nguyên ở
    // hàng đợi, người xử lý gọi lại được). Khác đường khớp tự động ở
    // chỗ: quyết định khớp ở đây là của NGƯỜI xử lý (đã đối chiếu
    // bằng chứng ngoài hệ thống), không phải của luật 3 điều kiện —
    // nhưng vẫn phải qua phép đối chiếu giá + tenant phía server ở
    // trên (issue #419): người xử lý xác nhận TIỀN, hệ thống xác
    // nhận QUYỀN LỢI chỉ sinh cho payment khớp đối tượng phía server.
    if (payment.component === 'enrol_fee' && payment.itemId) {
      await this.enrol.activatePaidEnrol(payment.itemId, payment.userId);
    }
    if (payment.component === 'class_fee' && payment.itemId) {
      await this.classes.activatePaidClassEnrol(payment.itemId, payment.userId);
    }
    if (payment.component === 'tenant_plan' || payment.component === 'teacher_plan') {
      await this.plans.activateForPayment(payment);
    }
    await this.repo.updatePayment(payment.id, { status: 'succeeded', externalTransactionId, ...trail });
    const succeeded = await this.getPayment(payment.id);
    // Vết sự kiện dùng chung với đường khớp tự động và đường webhook.
    await this.outbox.enqueueStandalone({
      aggregate: 'payment', type: 'payment_succeeded',
      payload: {
        paymentId: succeeded.id, userId: succeeded.userId, amount: succeeded.amount,
        currency: succeeded.currency, component: succeeded.component, itemId: succeeded.itemId,
        externalTransactionId: succeeded.externalTransactionId,
      },
    });
    return succeeded;
  }

  async listPaymentsForUser(userId: string): Promise<PaymentRow[]> { return this.repo.listPaymentsForUser(userId); }

  /**
   * Đối soát tối giản ở worker: đếm payment succeeded chưa có external
   * tx (cần rà soát). Cả ba con số đếm ở SQL (xem
   * `PaymentsRepository.countPaymentsForReconcile`) — không nạp toàn
   * bộ bảng payments về để đếm ở tầng ứng dụng.
   */
  async reconcile(): Promise<{ total: number; succeeded: number; pendingWithoutExternalTx: number }> {
    return this.repo.countPaymentsForReconcile();
  }
}
