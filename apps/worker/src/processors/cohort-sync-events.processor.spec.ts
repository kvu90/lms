import { describe, expect, it } from 'vitest';
import type { OutboxEventJobData } from '../outbox-event-routes';
import type { CohortSyncService } from '../cohort-sync.service';
import { SpaceJobRunner } from '../db/routing/space-job-runner';
import type { SpaceDatabaseService } from '../db/routing/space-database.service';
import { CohortSyncEventsProcessor } from './cohort-sync-events.processor';

/**
 * Đặc tả hoá điều phối của consumer đồng bộ cohort trên hàng đợi
 * (issue con #528 của #519) — chạy processor THẬT với host bề mặt
 * giả đếm số lần gọi. Các khẳng định đều là hệ quả quan sát được
 * của điều phối: gọi đúng điểm vào vật chất hoá theo `type` của
 * job, bỏ qua lặng loại lạ và payload sai hình dạng, và để lỗi của
 * bề mặt nổi lên cho BullMQ thử lại (bề mặt an toàn khi thử lại
 * nhờ transaction + guard trạng thái).
 */
class FakeCohortSync {
  readonly addedCalls: Array<{ cohortId: string; userId: string }> = [];
  readonly removedCalls: Array<{ cohortId: string; userId: string }> = [];
  failNextWith: Error | null = null;

  async materializeMemberAdded(payload: { cohortId: string; userId: string }): Promise<void> {
    this.addedCalls.push(payload);
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
  }

  async materializeMemberRemoved(payload: { cohortId: string; userId: string }): Promise<void> {
    this.removedCalls.push(payload);
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
  }
}

function makeJob(partial: Partial<OutboxEventJobData> = {}) {
  const data: OutboxEventJobData = {
    outboxId: '0191e8f2-7c3a-7b21-9f00-000000000528',
    seq: 528,
    aggregate: 'cohort',
    type: 'cohort_member_added',
    payload: { cohortId: 'cohort-1', userId: 'user-1' },
    tenantId: null,
    spaceSlug: null,
    occurredAt: '2026-10-30T00:00:00.000Z',
    ...partial,
  };
  return { data } as never;
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
  const cohortSync = new FakeCohortSync();
  const processor = new CohortSyncEventsProcessor(
    cohortSync as unknown as CohortSyncService,
    makeJobRunner(),
  );
  return { processor, cohortSync };
}

describe('CohortSyncEventsProcessor — điều phối theo loại sự kiện', () => {
  it('sự kiện thêm thành viên gọi đúng điểm vào vật chất hoá thêm và trả handled', async () => {
    const { processor, cohortSync } = makeProcessor();

    const result = await processor.process(makeJob());

    expect(result).toEqual({ handled: true });
    expect(cohortSync.addedCalls).toEqual([{ cohortId: 'cohort-1', userId: 'user-1' }]);
    expect(cohortSync.removedCalls).toHaveLength(0);
  });

  it('sự kiện rời cohort gọi đúng điểm vào vật chất hoá rời và trả handled', async () => {
    const { processor, cohortSync } = makeProcessor();

    const result = await processor.process(makeJob({ type: 'cohort_member_removed' }));

    expect(result).toEqual({ handled: true });
    expect(cohortSync.removedCalls).toEqual([{ cohortId: 'cohort-1', userId: 'user-1' }]);
    expect(cohortSync.addedCalls).toHaveLength(0);
  });

  it('loại sự kiện lạ lạc vào hàng đợi: không gọi bề mặt và trả handled false', async () => {
    const { processor, cohortSync } = makeProcessor();

    const result = await processor.process(makeJob({ type: 'grade_updated' }));

    expect(result).toEqual({ handled: false });
    expect(cohortSync.addedCalls).toHaveLength(0);
    expect(cohortSync.removedCalls).toHaveLength(0);
  });

  it('payload thiếu cohortId hoặc userId: bỏ qua lặng, không gọi bề mặt', async () => {
    const { processor, cohortSync } = makeProcessor();

    const noCohort = await processor.process(makeJob({ payload: { userId: 'user-1' } }));
    const noUser = await processor.process(makeJob({ type: 'cohort_member_removed', payload: { cohortId: 'cohort-1' } }));
    const nullPayload = await processor.process(makeJob({ payload: null }));

    expect(noCohort).toEqual({ handled: false });
    expect(noUser).toEqual({ handled: false });
    expect(nullPayload).toEqual({ handled: false });
    expect(cohortSync.addedCalls).toHaveLength(0);
    expect(cohortSync.removedCalls).toHaveLength(0);
  });

  it('payload có cohortId hoặc userId là chuỗi rỗng: bỏ qua lặng như consumer cũ, không gọi bề mặt', async () => {
    const { processor, cohortSync } = makeProcessor();

    const emptyCohort = await processor.process(makeJob({ payload: { cohortId: '', userId: 'user-1' } }));
    const emptyUser = await processor.process(makeJob({ type: 'cohort_member_removed', payload: { cohortId: 'cohort-1', userId: '' } }));
    const bothEmpty = await processor.process(makeJob({ payload: { cohortId: '', userId: '' } }));

    expect(emptyCohort).toEqual({ handled: false });
    expect(emptyUser).toEqual({ handled: false });
    expect(bothEmpty).toEqual({ handled: false });
    expect(cohortSync.addedCalls).toHaveLength(0);
    expect(cohortSync.removedCalls).toHaveLength(0);
  });

  it('lỗi của bề mặt nổi lên cho BullMQ thử lại thay vì bị nuốt', async () => {
    const { processor, cohortSync } = makeProcessor();
    cohortSync.failNextWith = new Error('cơ sở dữ liệu tạm lỗi');

    await expect(processor.process(makeJob())).rejects.toThrow('cơ sở dữ liệu tạm lỗi');
    expect(cohortSync.addedCalls).toHaveLength(1);
  });

  it('processor không giữ watermark hay trạng thái tiến độ riêng: hai job khác outboxId xử lý độc lập', async () => {
    const { processor, cohortSync } = makeProcessor();

    await processor.process(makeJob({ outboxId: '0191e8f2-7c3a-7b21-9f00-000000000529' }));
    await processor.process(makeJob({ outboxId: '0191e8f2-7c3a-7b21-9f00-000000000530' }));

    expect(cohortSync.addedCalls).toHaveLength(2);
  });
});
