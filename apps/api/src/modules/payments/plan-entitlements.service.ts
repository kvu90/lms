import { Injectable } from '@nestjs/common';
import { PaymentsRepository, type EntitlementRow, type PaymentRow } from './payments.repository';

/**
 * Ảnh chụp cấu hình gói ghi vào `payments.data` (khoá `plan`) tại thời
 * điểm tạo payment gói: giá đang cấu hình + độ dài chu kỳ đã áp + bên
 * hưởng. Khâu kích hoạt chỉ tin ảnh chụp này — KHÔNG đọc lại cấu hình
 * hiện hành — để một lần đổi giá của quản trị trong lúc khoản thu
 * đang chờ tiền về không làm sai lệch quyền lợi của khoản thu đó.
 */
export interface PlanSnapshot {
  component: 'tenant_plan' | 'teacher_plan';
  /** Giá gói đã áp (số nguyên, đơn vị nhỏ nhất) tại thời điểm tạo payment. */
  configuredPrice: number;
  /** Độ dài chu kỳ gói (ngày) đã áp tại thời điểm tạo payment. */
  periodDays: number;
  /** Tenant hưởng gói; với `teacher_plan` là tenant nơi giao dịch diễn ra. */
  beneficiaryTenantId: string;
  /** Giáo viên hưởng gói — chỉ có ở `teacher_plan`, còn lại null. */
  beneficiaryUserId: string | null;
  /**
   * Coupon đã áp cho khoản thu này (phần còn lại của lát 2): id và mã
   * của coupon cùng số tiền đã giảm so với `configuredPrice`. Chỉ có
   * khi người mua dùng coupon hợp lệ; `payments.amount` khi đó bằng
   * `configuredPrice - discountAmount`. Coupon không đổi chu kỳ hay
   * bên hưởng — khâu kích hoạt không đọc các trường này.
   */
  couponId?: string;
  couponCode?: string;
  discountAmount?: number;
}

/**
 * Đọc ảnh chụp gói từ `payments.data`; trả null khi payment không mang
 * ảnh chụp hợp lệ (ví dụ payment tạo qua đường tạo payment chung với
 * component tự do) — các payment như vậy KHÔNG sinh quyền lợi gói:
 * quyền lợi chỉ sinh từ đường mua gói chính thức
 * (`PaymentsService.createPlanPayment`).
 */
export function planSnapshotOf(payment: PaymentRow): PlanSnapshot | null {
  const data = payment.data as { plan?: Partial<PlanSnapshot> } | null;
  const plan = data?.plan;
  if (!plan || (plan.component !== 'tenant_plan' && plan.component !== 'teacher_plan')) return null;
  if (typeof plan.periodDays !== 'number' || !Number.isInteger(plan.periodDays) || plan.periodDays <= 0) return null;
  if (typeof plan.beneficiaryTenantId !== 'string' || plan.beneficiaryTenantId.length === 0) return null;
  return {
    component: plan.component,
    configuredPrice:
      typeof plan.configuredPrice === 'number' && Number.isInteger(plan.configuredPrice)
        ? plan.configuredPrice
        : payment.amount,
    periodDays: plan.periodDays,
    beneficiaryTenantId: plan.beneficiaryTenantId,
    beneficiaryUserId: typeof plan.beneficiaryUserId === 'string' ? plan.beneficiaryUserId : null,
    // Trường coupon là tuỳ chọn và tương thích ngược: ảnh chụp cũ
    // không có thì giữ undefined; có mà sai kiểu thì bỏ qua từng
    // trường thay vì vô hiệu hoá toàn bộ ảnh chụp.
    couponId: typeof plan.couponId === 'string' ? plan.couponId : undefined,
    couponCode: typeof plan.couponCode === 'string' ? plan.couponCode : undefined,
    discountAmount:
      typeof plan.discountAmount === 'number' && Number.isInteger(plan.discountAmount) && plan.discountAmount >= 0
        ? plan.discountAmount
        : undefined,
  };
}

/**
 * Kích hoạt + đảo quyền lợi gói (lát 2, issue #189).
 *
 * Luồng nghiệp vụ: payment gói (`tenant_plan`/`teacher_plan`) chỉ sinh
 * quyền lợi khi giao dịch đã xác thực thành công (webhook gateway đã
 * qua `verify`, hoặc IPN SePay khớp đủ 3 điều kiện ở khâu matching) —
 * hai đường đó gọi {@link PlanEntitlementsService.activateForPayment}
 * trong nhịp chốt, TRƯỚC khi lật payment sang `succeeded`, cùng khuôn
 * với kích hoạt ghi danh có phí: bất biến đồng bộ là trạng thái
 * `succeeded` không bao giờ quan sát được khi quyền lợi chưa tồn tại.
 * Cửa sổ hiệu lực: bắt đầu từ hiện tại, hoặc NỐI TIẾP từ mốc hết
 * hạn muộn nhất của các quyền lợi đang `active` của cùng bên hưởng +
 * cùng loại gói khi mua tiếp lúc gói cũ còn hạn (cộng dồn thời hạn);
 * độ dài cửa sổ là `periodDays` trong ảnh chụp của chính payment.
 * Idempotent theo payment: mỗi payment sinh tối đa một bản ghi quyền
 * lợi — BẢO ĐẢM Ở TẦNG DB bằng ràng buộc UNIQUE trên
 * `plan_entitlements.payment_id` (nhịp matching/webhook chạy lại gặp
 * lại bản ghi đã có; hai nhịp đồng thời thì nhịp thua cuộc đọc lại
 * bản ghi của nhịp thắng thay vì lỗi). Hoàn ĐỦ tiền
 * của payment gói (kèm lệnh chi đã xác nhận) thì
 * {@link PlanEntitlementsService.suspendForPayment} đình chỉ đúng
 * quyền lợi của payment đó; hoàn một phần giữ nguyên quyền lợi.
 */
@Injectable()
export class PlanEntitlementsService {
  constructor(private readonly repo: PaymentsRepository) {}

  /**
   * Sinh quyền lợi gói cho một payment gói vừa succeeded; trả bản ghi
   * quyền lợi (bản ghi đã có nếu nhịp này chạy lại), hoặc null khi
   * payment không phải payment gói chính thức.
   */
  async activateForPayment(payment: PaymentRow): Promise<EntitlementRow | null> {
    if (payment.component !== 'tenant_plan' && payment.component !== 'teacher_plan') return null;
    const snapshot = planSnapshotOf(payment);
    if (!snapshot) return null;
    const existing = await this.repo.getEntitlementByPayment(payment.id);
    if (existing) return existing;
    const now = new Date();
    const currentMax = await this.repo.maxActiveEntitlementExpiry(
      snapshot.component,
      snapshot.beneficiaryTenantId,
      snapshot.beneficiaryUserId,
    );
    const startsAt = currentMax && currentMax.getTime() > now.getTime() ? currentMax : now;
    const expiresAt = new Date(startsAt.getTime() + snapshot.periodDays * 86_400_000);
    try {
      return await this.repo.insertEntitlement({
        tenantId: snapshot.beneficiaryTenantId,
        userId: snapshot.beneficiaryUserId,
        component: snapshot.component,
        paymentId: payment.id,
        startsAt,
        expiresAt,
        status: 'active',
      });
    } catch (error) {
      // Đua hai nhịp kích hoạt đồng thời: cả hai cùng qua cổng kiểm
      // tra ở trên, ràng buộc UNIQUE trên payment_id chặn bản ghi thứ
      // hai ở tầng DB — nhịp thua đọc lại bản ghi đã thắng; không đọc
      // lại được thì lỗi là thật, ném tiếp.
      const winner = await this.repo.getEntitlementByPayment(payment.id);
      if (winner) return winner;
      throw error;
    }
  }

  /**
   * Đình chỉ quyền lợi của một payment gói (đường hoàn đủ tiền gọi);
   * payment không phải gói thì không làm gì.
   */
  async suspendForPayment(payment: PaymentRow): Promise<void> {
    if (payment.component !== 'tenant_plan' && payment.component !== 'teacher_plan') return;
    await this.repo.suspendEntitlementsByPayment(payment.id);
  }
}
