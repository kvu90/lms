import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SepayMatchingService } from '@lms/payments';
import { tenantAls } from './db/tenant-als';

/** Nhịp quét sự kiện IPN chờ matching — giữ đúng nhịp của consumer phía API trước đây. */
const POLL_INTERVAL_MS = 1000;
/** Số sự kiện tối đa xử lý trong một nhịp quét. */
const BATCH_SIZE = 20;

/**
 * Điểm quét matching IPN SePay ở worker (issue con #539 của #522):
 * quét bảng `payment_provider_events` theo nhịp và giao cho
 * `SepayMatchingService` của package dùng chung `@lms/payments`.
 *
 * Flow: mỗi nhịp 1.000 ms → gọi `SepayMatchingService.sweep(20)` —
 * quét tối đa 20 sự kiện đang chờ (trạng thái `received`, hoặc
 * `processing` treo quá 60 giây) và chạy matching cho từng sự kiện.
 * Handler IPN phía API chỉ ghi sự kiện rồi trả lời ngay (SePay chỉ
 * chờ ~8 giây và retry theo Fibonacci) nên khâu khớp — gồm cả kích
 * hoạt quyền lợi — nằm ở đây, bất đồng bộ và bền qua restart: tiến
 * trình chết giữa chừng thì sự kiện `processing` treo quá 60 giây
 * được nhịp sau nhận lại. Mọi lỗi đều bị nuốt kèm cảnh báo: sổ sự
 * kiện là nguồn sự thật, nhịp sau luôn thử lại được.
 *
 * Vì sao là scheduler chứ không phải hàng đợi BullMQ: luồng này quét
 * BẢNG `payment_provider_events`, không phải đường relay outbox —
 * nó không thăm dò `outbox_events` và không dựa vào ngữ nghĩa đóng
 * dấu phát hành của relay. Một job BullMQ lặp mỗi giây chỉ thêm một
 * vòng qua Redis mỗi giây mà độ chính xác nhịp 1 giây lại kém; khuôn
 * scheduler quét trực tiếp này theo đúng tiền lệ
 * `OutboxRelayScheduler` của worker và consumer `setInterval` phía
 * API trước đây.
 *
 * Ngữ cảnh platform: toàn bộ nhịp chạy trong `tenantAls.run({
 * platform: true })` — các hiệu ứng kích hoạt đọc chính sách xuyên
 * tenant (tách vai, slot gói, membership) nên ngoài ngữ cảnh
 * platform, RLS fail-closed sẽ che dữ kiện và cho kết quả "không
 * thấy" giả (lớp lỗi #292 của relay outbox). Các bảng payments
 * không bật RLS nên bọc này không đổi gì với chính nhịp quét.
 * Bọc platform của nhịp KHÔNG mang slug của bất kỳ trung tâm nào:
 * một nhịp gồm payment của nhiều trung tâm, nên không gian được
 * phân giải THEO TỪNG PAYMENT tại các cổng hiệu ứng (kích hoạt
 * ghi danh, kích hoạt cấp lớp, đối chiếu đích) qua
 * `WorkerPaymentSpaceScope` từ `tenantId` của chính payment đó
 * (tiền điều kiện Phần B của issue #587 — hạng mục 2); thân hiệu
 * ứng của payment thuộc trung tâm kho riêng chạy trong phiên của
 * kho đó, tách khỏi ngữ cảnh quét chung này.
 *
 * Chống quét chồng: cờ `ticking` giữ đúng một nhịp chạy tại một thời
 * điểm trong tiến trình — cờ này là chốt chặn có thật, không phải
 * tối ưu: vị từ claim của repository (`received` HOẶC
 * `processing`) cho phép hai nhịp đồng thời cùng claim một sự kiện
 * dưới READ COMMITTED, và matching chạy trùng sẽ kích hoạt trùng /
 * ghi outbox trùng. Một tiến trình worker duy nhất + cờ này là
 * người quét duy nhất của bảng.
 *
 * @remarks Không ghi `task_log` cho từng nhịp: nhịp 1 giây mà ghi
 * vết mỗi lần sẽ spam bảng log; vết lỗi đã có qua logger cảnh báo,
 * vết thành công của từng sự kiện nằm ở chính dòng sự kiện
 * (`match_status`) và dòng outbox `payment_succeeded`.
 */
@Injectable()
export class SepayMatchingScheduler {
  private readonly logger = new Logger(SepayMatchingScheduler.name);
  private ticking = false;

  constructor(private readonly matching: SepayMatchingService) {}

  /**
   * Một nhịp quét matching.
   *
   * @returns Không trả gì; lỗi được nuốt kèm cảnh báo để nhịp sau thử lại.
   */
  @Interval(POLL_INTERVAL_MS)
  async sweepTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await tenantAls.run({ platform: true }, () => this.matching.sweep(BATCH_SIZE));
    } catch (error) {
      this.logger.warn(`Nhịp matching IPN SePay lỗi: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
