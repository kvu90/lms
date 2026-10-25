import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SepayMatchingService } from './sepay-matching.service';

/** Nhịp quét sự kiện IPN chờ matching. */
const POLL_INTERVAL_MS = 1000;
/** Số sự kiện tối đa xử lý trong một nhịp quét. */
const BATCH_SIZE = 20;

/**
 * Consumer matching IPN SePay (lát 1 VietQR, issue #189): chạy trong tiến
 * trình API, quét `payment_provider_events` đang `received` theo nhịp và
 * giao cho SepayMatchingService. Handler IPN chỉ ghi sự kiện rồi trả lời
 * ngay (SePay chỉ chờ ~8 giây và retry theo Fibonacci) nên khâu khớp —
 * gồm cả kích hoạt enrol — nằm ở đây, bất đồng bộ và bền qua restart:
 * tiến trình chết giữa chừng thì sự kiện `processing` treo quá 60 giây
 * được nhịp sau nhận lại. Mọi lỗi đều bị nuốt kèm cảnh báo: sổ sự kiện
 * là nguồn sự thật, nhịp sau luôn thử lại được.
 */
@Injectable()
export class SepayIpnConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SepayIpnConsumer.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly matching: SepayMatchingService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.matching.sweep(BATCH_SIZE);
    } catch (error) {
      this.logger.warn(`Nhịp matching IPN SePay lỗi: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
