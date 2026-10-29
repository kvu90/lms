import { describe, expect, it, vi } from 'vitest';
import { DelayedError } from 'bullmq';
import {
  MESSAGING_DISTRIBUTED_KEY_PREFIX,
  MessagingRealtimeProcessor,
} from './messaging-realtime.processor';
import type { OutboxEventJobData } from '../outbox-event-routes';

/**
 * Consumer phân phối realtime phía worker — ghim các tính chất
 * của cơ chế chống trùng theo `outboxId` và cơ chế thử lại khi
 * lỗi (issue #521):
 * (i) sự kiện chưa có dấu thì được phân phối đúng một lần và dấu
 *     chỉ ghi SAU khi phân phối xong;
 * (ii) job phát lại của sự kiện đã có dấu thì bị bỏ qua hoàn toàn
 *     (không phân phối lần hai);
 * (iii) phân phối lỗi thì job được hoãn bằng `moveToDelayed` và
 *     `DelayedError` được ném ra — lượt hoãn không đốt số lần
 *     thử của job và dấu không được ghi, nên job lỗi bền không
 *     chết theo attempts mặc định mà thử lại tới khi phân phối
 *     được (hành vi đầu-cuối trên hàng đợi thật do spec
 *     integration `messaging-realtime-retry` ghim).
 */
describe('MessagingRealtimeProcessor — chống trùng theo outboxId', () => {
  const JOB_DATA: OutboxEventJobData = {
    outboxId: '0191e8f2-7c3a-7b21-9f00-000000000001',
    seq: 42,
    aggregate: 'messaging',
    type: 'message_sent',
    payload: { conversationId: 'conv-1', messageId: 'msg-1' },
    tenantId: 'tenant-1',
    occurredAt: '2026-10-29T00:00:00.000Z',
  };

  function build(opts: { alreadyDistributed?: boolean; distributeError?: Error; existsError?: Error } = {}) {
    const calls: string[] = [];
    const distribution = {
      distributeEvent: vi.fn(async (type: string) => {
        calls.push(`distribute:${type}`);
        if (opts.distributeError) throw opts.distributeError;
      }),
    };
    const redis = {
      exists: vi.fn(async () => {
        if (opts.existsError) throw opts.existsError;
        return opts.alreadyDistributed ? 1 : 0;
      }),
      set: vi.fn(async () => {
        calls.push('mark');
        return 'OK';
      }),
    };
    const processor = new MessagingRealtimeProcessor(distribution as never, redis as never);
    return { processor, distribution, redis, calls };
  }

  it('sự kiện chưa có dấu thì phân phối đúng dữ kiện của job và ghi dấu sau khi phân phối xong', async () => {
    const { processor, distribution, redis, calls } = build();

    await processor.process({ data: JOB_DATA } as never);

    expect(distribution.distributeEvent).toHaveBeenCalledWith('message_sent', JOB_DATA.payload);
    expect(redis.exists).toHaveBeenCalledWith(`${MESSAGING_DISTRIBUTED_KEY_PREFIX}${JOB_DATA.outboxId}`);
    expect(redis.set).toHaveBeenCalledWith(
      `${MESSAGING_DISTRIBUTED_KEY_PREFIX}${JOB_DATA.outboxId}`,
      '1',
      'EX',
      expect.any(Number),
    );
    // Thứ tự chốt: dấu chỉ xuất hiện sau khi phân phối đã xong.
    expect(calls).toEqual(['distribute:message_sent', 'mark']);
  });

  it('job phát lại của sự kiện đã có dấu thì bị bỏ qua, không phân phối lần hai', async () => {
    const { processor, distribution, redis } = build({ alreadyDistributed: true });

    await processor.process({ data: JOB_DATA } as never);

    expect(distribution.distributeEvent).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('phân phối lỗi thì ném DelayedError để hoãn thử lại chứ không đốt attempts, và không ghi dấu', async () => {
    const { processor, redis } = build({ distributeError: new Error('database connection lost') });

    await expect(processor.process({ data: JOB_DATA } as never)).rejects.toThrow(DelayedError);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('phân phối lỗi khi có token của worker thì hoãn job bằng moveToDelayed đúng một lần với mốc hoãn khoảng 5 giây trước khi ném DelayedError', async () => {
    const { processor, redis } = build({ distributeError: new Error('publish NOPERM') });
    const moveToDelayed = vi.fn(async () => undefined);
    const before = Date.now();

    await expect(
      processor.process({ data: JOB_DATA, moveToDelayed } as never, 'worker-token-1'),
    ).rejects.toThrow(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    const [timestamp, token] = moveToDelayed.mock.calls[0]! as unknown as [number, string];
    expect(token).toBe('worker-token-1');
    expect(timestamp).toBeGreaterThanOrEqual(before + 4_000);
    expect(timestamp).toBeLessThanOrEqual(Date.now() + 6_000);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('đọc dấu lỗi thì hoãn job bằng moveToDelayed và ném DelayedError như mọi lỗi phân phối khác, không phân phối và không ghi dấu', async () => {
    const { processor, distribution, redis } = build({ existsError: new Error('EXISTS timeout') });
    const moveToDelayed = vi.fn(async () => undefined);

    await expect(
      processor.process({ data: JOB_DATA, moveToDelayed } as never, 'worker-token-2'),
    ).rejects.toThrow(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(distribution.distributeEvent).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('job thiếu outboxId thì ném lỗi ngay, không đọc dấu và không phân phối', async () => {
    const { processor, distribution, redis } = build();

    await expect(processor.process({ data: { ...JOB_DATA, outboxId: '' } } as never)).rejects.toThrow();
    expect(redis.exists).not.toHaveBeenCalled();
    expect(distribution.distributeEvent).not.toHaveBeenCalled();
  });
});
