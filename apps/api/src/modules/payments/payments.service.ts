import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { ClassesService } from '../classes/classes.service';
import { EnrolService } from '../enrol/enrol.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import { TenantsService } from '../tenants/tenants.service';
import { PaymentsRepository, type AccountRow, type CouponRow, type EntitlementRow, type PaymentRow, type RefundRow } from './payments.repository';
import { PlanEntitlementsService, type PlanSnapshot } from './plan-entitlements.service';
import { buildVietQrPayload, extractPaymentCode, maskAccountConfig, paymentCodeFromSequence, readAccountConfig, PAYMENT_CODE_TTL_MS } from './vietqr';
import type { Coupon, CreateCoupon, PlanEntitlement, UpdateCoupon } from '@lms/contracts';

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
 */
@Injectable()
export class PaymentsService {
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
    private readonly siteConfig: SiteConfigService,
    private readonly plans: PlanEntitlementsService,
  ) {}

  private async requireManageAccounts(actorId: string): Promise<void> {
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'payment:manageaccounts', sys.id);
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
  async listRefundsForUser(actorId: string, paymentId: string): Promise<RefundRow[]> {
    const payment = await this.getPayment(paymentId);
    await this.assertCanReadPayment(actorId, payment);
    return this.repo.listRefunds(paymentId);
  }

  /** Tạo payment ở trạng thái pending cho một user. */
  async createPayment(userId: string, input: { accountId: string; amount: number; currency: string; component?: string; itemId?: string }): Promise<PaymentView> {
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
    // Lớp 1 — allowlist IP nguồn (env SEPAY_IPN_IP_ALLOWLIST, phân cách dấu
    // phẩy; chưa cấu hình = lớp này tắt, lớp Apikey vẫn bắt buộc).
    const allowlist = (process.env.SEPAY_IPN_IP_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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

  /**
   * Hoàn tiền: tạo refund riêng, payment gốc chỉ đổi status sang refunded
   * (không sửa amount). Cổng cộng dồn (§5.5): tổng đã hoàn + lần này phải
   * ≤ amount gốc; status `refunded` khi tổng hoàn bằng đúng amount.
   * Đảo quyền lợi (§5.6, tiêu chí 6.4.7): hoàn TOÀN BỘ + lệnh chi đã xác
   * nhận (externalTransactionId đi kèm) → đình chỉ ghi danh qua
   * `EnrolService.setSuspended`; hoàn một phần giữ nguyên quyền lợi.
   * CLASS-3: cùng khuôn cho gói lớp — hoàn toàn bộ → đình chỉ khỏi lớp
   * qua `ClassesService.suspendPaidClassMember`.
   */
  async refund(actorId: string, paymentId: string, input: { amount: number; reason?: string; externalTransactionId?: string }): Promise<RefundRow> {
    await this.requireManageAccounts(actorId);
    const payment = await this.getPayment(paymentId);
    if (payment.status !== 'succeeded') throw new BadRequestException({ message: 'Only a succeeded payment can be refunded', code: 'payment.not_succeeded' });
    if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > payment.amount) {
      throw new BadRequestException({ message: 'Refund amount must be a positive integer not exceeding the payment amount', code: 'payment.bad_refund_amount' });
    }
    const alreadyRefunded = await this.repo.sumRefunds(paymentId);
    if (alreadyRefunded + input.amount > payment.amount) {
      throw new BadRequestException({ message: 'Cumulative refunds would exceed the original payment amount', code: 'payment.refund_exceeds_total' });
    }
    const refund = await this.repo.insertRefund({
      paymentId: payment.id, amount: input.amount, currency: payment.currency,
      reason: input.reason ?? '', externalTransactionId: input.externalTransactionId ?? null,
    });
    if (alreadyRefunded + input.amount === payment.amount) {
      await this.repo.updatePayment(payment.id, { status: 'refunded' });
      if (input.externalTransactionId && payment.component === 'enrol_fee' && payment.itemId) {
        await this.enrol.setSuspended(actorId, payment.itemId, payment.userId, true);
      }
      // CLASS-3: hoàn đủ gói lớp → đình chỉ khỏi lớp (gỡ backing
      // cohort; cohort sync đình chỉ mọi khoá, giữ điểm/dữ liệu theo
      // chế độ rời mặc định của lớp). Hoàn một phần giữ nguyên quyền
      // lợi như enrol_fee.
      if (input.externalTransactionId && payment.component === 'class_fee' && payment.itemId) {
        await this.classes.suspendPaidClassMember(payment.itemId, payment.userId);
      }
      // Lát 2 (#189): hoàn đủ gói → đình chỉ quyền lợi gói của chính
      // payment đó (cùng điều kiện đã-xác-nhận-lệnh-chi như enrol_fee).
      if (input.externalTransactionId && (payment.component === 'tenant_plan' || payment.component === 'teacher_plan')) {
        await this.plans.suspendForPayment(payment);
      }
    }
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
