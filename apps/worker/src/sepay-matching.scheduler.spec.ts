import { describe, expect, it, vi } from 'vitest';
import type { SepayMatchingService } from '@lms/payments';
import { SepayMatchingScheduler } from './sepay-matching.scheduler';

/**
 * Đặc tả nhịp quét matching IPN SePay ở worker (issue con #539 của
 * #522): scheduler là lớp mỏng quanh `SepayMatchingService.sweep`
 * — các ca ở đây ghim đúng hợp đồng nhịp của nó (lô 20, chống quét
 * chồng, lỗi được nuốt để nhịp sau thử lại). Luật matching và các
 * hiệu ứng kích hoạt được ghim ở tầng integration
 * (`test/integration/payments/sepay-matching-sweep.int-spec.ts`)
 * và các suite e2e payments — không khẳng định lại ở đây.
 */
describe('Điểm quét matching IPN SePay ở worker', () => {
  function makeScheduler(sweep: (limit: number) => Promise<number>): SepayMatchingScheduler {
    const matching = { sweep: vi.fn(sweep) } as unknown as SepayMatchingService;
    return new SepayMatchingScheduler(matching);
  }

  it('nhịp quét gọi sweep đúng một lần với lô 20 sự kiện', async () => {
    const sweep = vi.fn(async () => 3);
    const scheduler = makeScheduler(sweep);
    await scheduler.sweepTick();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith(20);
  });

  it('nhịp đang chạy thì nhịp khác bỏ qua, nhịp sau chạy lại được', async () => {
    let release!: () => void;
    const gate = new Promise<number>((resolve) => { release = () => resolve(1); });
    const sweep = vi.fn(() => gate);
    const scheduler = makeScheduler(sweep);
    const first = scheduler.sweepTick();
    await scheduler.sweepTick();
    expect(sweep).toHaveBeenCalledTimes(1);
    release();
    await first;
    await scheduler.sweepTick();
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('nhịp lỗi được nuốt, cờ được nhả để nhịp sau chạy lại được', async () => {
    const sweep = vi.fn(async () => 0)
      .mockRejectedValueOnce(new Error('DB chập chờn'));
    const scheduler = makeScheduler(sweep);
    await expect(scheduler.sweepTick()).resolves.toBeUndefined();
    await scheduler.sweepTick();
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
