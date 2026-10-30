import { DelayedError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { OutboxEventJobData } from '../outbox-event-routes';
import type { NotificationEventsMarker } from '../notification-events-marker.service';
import type { NotificationEventsHandlerService } from '../notification-events-handler.service';
import { SpaceJobRunner } from '../db/routing/space-job-runner';
import type { SpaceDatabaseService } from '../db/routing/space-database.service';
import { NotificationEventsProcessor } from './notification-events.processor';

/**
 * Đặc tả hoá chốt chống trùng theo `outboxId` của consumer thông
 * báo sự kiện (issue con #520 của #491) — chạy processor THẬT với
 * marker giả trong bộ nhớ (đúng ngữ nghĩa hai khoá của marker thật:
 * dấu đã xử lý chỉ ghi sau khi xử lý xong; lease có token chủ và
 * chỉ chủ mới nhả được) và handler giả đếm số lần chạy. Các khẳng
 * định đều là hệ quả nghiệp vụ quan sát được: handler của một sự
 * kiện chạy tối đa một lần dù job bị phát lại, chạy song song xen
 * kẽ, hay bị thử lại sau lỗi; job bị hoãn vì lease không bị tính là
 * đã xử lý và cũng không đốt một lần thử.
 */
class FakeMarker {
  readonly processed = new Set<string>();
  private readonly leases = new Map<string, string>();
  private tokenCounter = 0;
  /** Cổng chặn lần chiếm lease đầu tiên — dựng kịch bản xen kẽ. */
  firstClaimGate: Promise<void> | null = null;
  private claimCalls = 0;

  async hasProcessed(outboxId: string): Promise<boolean> {
    return this.processed.has(outboxId);
  }

  async claimProcessing(outboxId: string): Promise<string | null> {
    this.claimCalls += 1;
    if (this.claimCalls === 1 && this.firstClaimGate) await this.firstClaimGate;
    if (this.leases.has(outboxId)) return null;
    const token = `lease-token-${++this.tokenCounter}`;
    this.leases.set(outboxId, token);
    return token;
  }

  async markProcessed(outboxId: string): Promise<void> {
    this.processed.add(outboxId);
  }

  async releaseProcessing(outboxId: string, token: string): Promise<void> {
    if (this.leases.get(outboxId) === token) this.leases.delete(outboxId);
  }

  /** Lease hiện tại của một sự kiện có đang bị giữ hay không. */
  leaseHeld(outboxId: string): boolean {
    return this.leases.has(outboxId);
  }
}

class FakeHandler {
  readonly calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  failNextWith: Error | null = null;

  async handle(type: string, payload: Record<string, unknown>): Promise<boolean> {
    this.calls.push({ type, payload });
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
    return true;
  }
}

function makeJob(partial: Partial<OutboxEventJobData> = {}) {
  const data: OutboxEventJobData = {
    outboxId: '0191e8f2-7c3a-7b21-9f00-000000000520',
    seq: 520,
    aggregate: 'messaging',
    type: 'message_sent',
    payload: { messageId: 'msg-1' },
    tenantId: null,
    occurredAt: '2026-10-29T00:00:00.000Z',
    ...partial,
  };
  const moveToDelayed = vi.fn(async () => undefined);
  return { job: { data, moveToDelayed }, moveToDelayed };
}

/**
 * Bộ chạy job THẬT với khung định tuyến không có sổ phía sau
 * (issue #582): các job của spec này không mang slug trung tâm
 * nên bộ chạy luôn mở ngữ cảnh platform như đường xử lý trước
 * đợt này — spec khoá hành vi của processor, không khoá định
 * tuyến kho (định tuyến có spec riêng của bộ chạy và của relay).
 */
function makeJobRunner(): SpaceJobRunner {
  return new SpaceJobRunner({
    resolveTarget: async () => {
      throw new Error('spec không cấu hình sổ đăng ký');
    },
  } as unknown as SpaceDatabaseService);
}

function makeProcessor() {
  const marker = new FakeMarker();
  const handler = new FakeHandler();
  const processor = new NotificationEventsProcessor(
    handler as unknown as NotificationEventsHandlerService,
    marker as unknown as NotificationEventsMarker,
    makeJobRunner(),
  );
  return { processor, marker, handler };
}

describe('NotificationEventsProcessor — chống trùng theo outboxId', () => {
  it('xử lý lần đầu: handler chạy đúng một lần, dấu đã xử lý được ghi và lease được nhả', async () => {
    const { processor, marker, handler } = makeProcessor();
    const { job } = makeJob();

    const result = await processor.process(job as never, 'worker-token');

    expect(result).toEqual({ handled: true });
    expect(handler.calls).toEqual([{ type: 'message_sent', payload: { messageId: 'msg-1' } }]);
    expect(marker.processed.has(job.data.outboxId)).toBe(true);
    expect(marker.leaseHeld(job.data.outboxId)).toBe(false);
  });

  it('phát lại cùng outboxId sau khi đã xử lý: trả duplicate và handler không chạy lần thứ hai', async () => {
    const { processor, handler } = makeProcessor();
    const { job } = makeJob();

    await processor.process(job as never, 'worker-token');
    const replay = await processor.process(job as never, 'worker-token');

    expect(replay).toEqual({ handled: true, duplicate: true });
    expect(handler.calls).toHaveLength(1);
  });

  it('hai lượt chạy xen kẽ: lượt bị giữ sau lần đọc nhanh vẫn bị chặn bởi lần đọc lại trong lease — handler chạy đúng một lần', async () => {
    const { processor, marker, handler } = makeProcessor();
    const { job } = makeJob();
    let openGate!: () => void;
    marker.firstClaimGate = new Promise<void>((resolve) => { openGate = resolve; });

    // Lượt A: qua được lần đọc nhanh (chưa có dấu) rồi bị giữ ngay
    // trước khi chiếm lease.
    const runA = processor.process(job as never, 'worker-token');
    // Xả hàng đợi microtask để A thật sự đang đứng ở cổng chiếm
    // lease (lần chiếm đầu tiên) rồi mới bắt đầu lượt B.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Lượt B chạy trọn: chiếm lease, xử lý, ghi dấu, nhả lease.
    const resultB = await processor.process(job as never, 'worker-token');
    expect(resultB).toEqual({ handled: true });

    // Mở cổng cho A: A chiếm được lease trống nhưng lần đọc lại
    // trong lease thấy dấu đã xử lý nên kết luận trùng.
    openGate();
    const resultA = await runA;
    expect(resultA).toEqual({ handled: true, duplicate: true });
    expect(handler.calls).toHaveLength(1);
    expect(marker.leaseHeld(job.data.outboxId)).toBe(false);
  });

  it('lease đang bị một lượt khác giữ: job bị hoãn bằng DelayedError, handler không chạy và sự kiện được xử lý khi lease được nhả', async () => {
    const { processor, marker, handler } = makeProcessor();
    const { job, moveToDelayed } = makeJob();
    const otherToken = await marker.claimProcessing(job.data.outboxId);
    expect(otherToken).not.toBeNull();

    await expect(processor.process(job as never, 'worker-token')).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    const [delayedUntil] = moveToDelayed.mock.calls[0]! as unknown as [number];
    expect(delayedUntil).toBeGreaterThan(Date.now());
    expect(handler.calls).toHaveLength(0);
    expect(marker.processed.has(job.data.outboxId)).toBe(false);

    await marker.releaseProcessing(job.data.outboxId, otherToken!);
    const result = await processor.process(job as never, 'worker-token');
    expect(result).toEqual({ handled: true });
    expect(handler.calls).toHaveLength(1);
  });

  it('handler ném lỗi: lỗi được truyền ra để BullMQ thử lại, dấu đã xử lý không được ghi, lease được nhả và lần chạy lại xử lý thành công', async () => {
    const { processor, marker, handler } = makeProcessor();
    const { job } = makeJob();
    handler.failNextWith = new Error('database unavailable');

    await expect(processor.process(job as never, 'worker-token')).rejects.toThrow('database unavailable');
    expect(marker.processed.has(job.data.outboxId)).toBe(false);
    expect(marker.leaseHeld(job.data.outboxId)).toBe(false);

    const retry = await processor.process(job as never, 'worker-token');
    expect(retry).toEqual({ handled: true });
    expect(handler.calls).toHaveLength(2);
    expect(marker.processed.has(job.data.outboxId)).toBe(true);
  });

  it('loại sự kiện lạ lạc vào hàng đợi: không xử lý, không chiếm lease, không ghi dấu', async () => {
    const { processor, marker, handler } = makeProcessor();
    const { job } = makeJob({ type: 'course_created' });

    const result = await processor.process(job as never, 'worker-token');

    expect(result).toEqual({ handled: false });
    expect(handler.calls).toHaveLength(0);
    expect(marker.leaseHeld(job.data.outboxId)).toBe(false);
    expect(marker.processed.has(job.data.outboxId)).toBe(false);
  });

  it('payload null: handler nhận object rỗng để tự bỏ qua theo cổng trường bắt buộc như consumer cũ', async () => {
    const { processor, handler } = makeProcessor();
    const { job } = makeJob({ type: 'grade_updated', payload: null });

    const result = await processor.process(job as never, 'worker-token');

    expect(result).toEqual({ handled: true });
    expect(handler.calls).toEqual([{ type: 'grade_updated', payload: {} }]);
  });
});
