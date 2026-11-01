import type { PaymentRow, ProviderEventRow } from './payments.repository';

/**
 * Các cổng (port) cho ba hiệu ứng xuyên module của luồng matching IPN
 * SePay (issue #538, issue cha #522).
 *
 * Bề mặt matching dùng chung (`SepayMatchingService` trong package
 * này) chỉ ĐỊNH NGHĨA các cổng và gọi qua cổng — nó không import
 * trực tiếp service của bất kỳ module nghiệp vụ nào khác, để cùng
 * một bản logic matching chạy được ở mọi tiến trình. Cài đặt cổng
 * là phần thuộc về tiến trình chủ:
 *
 * - Phía apps/api (hiện hành): cài đặt là chính các service hiện
 *   hành — `EnrolService` cho cổng ghi danh, `ClassesService` cho
 *   cổng ghi danh cấp lớp, `PaymentsService` cho cổng đối chiếu
 *   đích và xác nhận chi — nối bằng `useExisting` trong
 *   `PaymentsModule`. Luật nghiệp vụ của ba hiệu ứng vì vậy chỉ tồn
 *   tại đúng một bản, ở chính các service đó.
 * - Phía apps/worker (issue con tiếp theo của #522): cài đặt dựa
 *   trên bề mặt phễu ghi danh/cohort dùng chung mà issue #527 trích
 *   xuất — không thuộc phạm vi của issue này.
 *
 * Mọi cổng đều idempotent theo cùng nghĩa với cài đặt hiện hành:
 * nhịp matching chết giữa chừng được nhận lại theo cửa sổ stale của
 * claim sự kiện và các khâu kích hoạt chạy lại an toàn.
 */

/** Token tiêm cho cổng kích hoạt ghi danh có phí ({@link PaidEnrolActivationPort}). */
export const PAID_ENROL_ACTIVATION_PORT = Symbol('PAID_ENROL_ACTIVATION_PORT');

/** Token tiêm cho cổng kích hoạt ghi danh cấp lớp ({@link PaidClassEnrolActivationPort}). */
export const PAID_CLASS_ENROL_ACTIVATION_PORT = Symbol('PAID_CLASS_ENROL_ACTIVATION_PORT');

/** Token tiêm cho cổng đối chiếu đích phía server và xác nhận chi hoàn ({@link PaymentSettlementPort}). */
export const PAYMENT_SETTLEMENT_PORT = Symbol('PAYMENT_SETTLEMENT_PORT');

/**
 * Cổng kích hoạt ghi danh có phí: payment `enrol_fee` khớp đủ điều
 * kiện thì ghi danh của người dùng vào instance đích được kích hoạt
 * (cài đặt hiện hành: `EnrolService.activatePaidEnrol` phía apps/api,
 * đi vào phễu ghi danh dùng chung của tiến trình đó).
 */
export interface PaidEnrolActivationPort {
  /**
   * Kích hoạt ghi danh có phí.
   * @param itemId Id của instance ghi danh đích (trường `itemId` của payment).
   * @param userId Id của người dùng được ghi danh (trường `userId` của payment).
   * @param tenantId Id của tenant sở hữu payment (trường `tenantId` của
   *   payment). Tiến trình chủ dùng giá trị này để chạy kích hoạt tại
   *   đúng kho của trung tâm sở hữu payment khi trung tâm đó có kho
   *   riêng (phía worker phân giải không gian theo từng payment);
   *   cài đặt phía apps/api hiện hành không cần tới vì đường kích
   *   hoạt của API chạy trong ngữ cảnh của request/tiến trình đó.
   */
  activatePaidEnrol(itemId: string, userId: string, tenantId: string): Promise<void>;
}

/**
 * Cổng kích hoạt ghi danh cấp lớp: payment `class_fee` khớp đủ điều
 * kiện thì người dùng được vào lớp đích (cài đặt hiện hành:
 * `ClassesService.activatePaidClassEnrol` phía apps/api — vào
 * backing cohort của lớp, cohort sync vật chất hoá xuống mọi khoá
 * của lớp).
 */
export interface PaidClassEnrolActivationPort {
  /**
   * Kích hoạt ghi danh cấp lớp.
   * @param itemId Id của lớp đích (trường `itemId` của payment).
   * @param userId Id của người dùng vào lớp (trường `userId` của payment).
   * @param tenantId Id của tenant sở hữu payment (trường `tenantId` của
   *   payment) — cùng vai trò với tham số cùng tên của
   *   {@link PaidEnrolActivationPort.activatePaidEnrol}: tiến trình
   *   chủ phân giải không gian của trung tâm sở hữu payment để chạy
   *   kích hoạt tại đúng kho của trung tâm đó.
   */
  activatePaidClassEnrol(itemId: string, userId: string, tenantId: string): Promise<void>;
}

/**
 * Cổng đối chiếu đích phía server và xác nhận chi hoàn — hai hiệu
 * ứng còn nằm trong facade thanh toán của tiến trình chủ (cài đặt
 * hiện hành: `PaymentsService` phía apps/api):
 *
 * - `verifyPaymentAgainstServerTarget` là phép đối chiếu phòng thủ
 *   chiều sâu của matching: payment phải khớp giá + tenant phía
 *   server của đối tượng đích thì mới được kích hoạt quyền lợi.
 * - `settleRefundFromDebitEvent` đối khớp một sự kiện `debit` (bằng
 *   chứng lệnh chi hoàn) với dòng hoàn đang `approved` và xác nhận
 *   chi trong một transaction có khoá dòng.
 */
export interface PaymentSettlementPort {
  /**
   * Đối chiếu payment với đối tượng đích phía server (giá + tenant).
   * @param payment Payment đang xét kích hoạt.
   * @returns `true` khi payment khớp đích phía server; `false` là
   *   tín hiệu rơi nhánh `needs_review`, tuyệt đối không kích hoạt.
   */
  verifyPaymentAgainstServerTarget(payment: PaymentRow): Promise<boolean>;

  /**
   * Đối khớp và xác nhận chi hoàn cho một sự kiện `debit`.
   * @param event Sự kiện provider chiều tiền ra đã được claim.
   */
  settleRefundFromDebitEvent(event: ProviderEventRow): Promise<void>;
}
