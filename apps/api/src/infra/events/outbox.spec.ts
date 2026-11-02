import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '@lms/db';
import { OutboxService } from './outbox.service';

/**
 * Hợp đồng giao dịch của writer outbox (real DB, lms_test_api).
 *
 * Spec này chỉ khẳng định phía ghi: sự kiện được đưa vào outbox
 * trong cùng transaction với nghiệp vụ thì chỉ tồn tại sau khi
 * transaction commit, và biến mất cùng transaction khi rollback.
 * Phía phát (đóng dấu `publishedAt` sau khi phát) thuộc về relay
 * duy nhất ở worker và được ghim bởi
 * `apps/worker/src/outbox-relay.scheduler.spec.ts` — từ issue #523,
 * tiến trình API không còn relay riêng nên spec này không còn gọi
 * relay nữa; dòng chưa phát giữ `publishedAt` null cho tới khi
 * relay của worker chạy.
 *
 * Service được dựng trực tiếp trên handle Kysely của chính nó;
 * mọi khẳng định đọc lại qua cùng handle đó. Đường ghi duy nhất
 * là `enqueueKysely` trong transaction của phía gọi, cộng đường
 * `enqueueStandalone` tự mở transaction riêng (đường ghi bộ máy cũ
 * chuyển tiếp đã xoá ở issue #663).
 */
describe('Outbox giao dịch (DB thật, lms_test_api)', () => {
  let pool: Pool;
  let kysely: CentreDb;
  let outbox: OutboxService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    kysely = createCentreKysely(pool);
    outbox = new OutboxService(kysely);
  });

  beforeEach(async () => {
    await kysely.deleteFrom('outbox_events').execute();
  });

  afterAll(async () => {
    // Instance Kysely sở hữu pool: destroy() đóng luôn pool, nên
    // đây là thao tác dọn dẹp cuối cùng của spec.
    await kysely.destroy();
  });

  it('ghi sự kiện vào outbox khi transaction commit (chưa phát: publishedAt null cho tới khi relay worker chạy)', async () => {
    await kysely.transaction().execute(async (tx) => {
      await outbox.enqueueKysely(tx, {
        aggregate: 'test', type: 'Test.Committed', payload: { n: 1 },
      });
    });

    const rows = await kysely.selectFrom('outbox_events').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('Test.Committed');
    expect(rows[0]?.payload).toEqual({ n: 1 });
    expect(rows[0]?.published_at).toBeNull();
  });

  it('không ghi sự kiện nào khi transaction rollback', async () => {
    await expect(
      kysely.transaction().execute(async (tx) => {
        await outbox.enqueueKysely(tx, {
          aggregate: 'test', type: 'Test.RolledBack', payload: { n: 2 },
        });
        throw new Error('business failure — roll back');
      }),
    ).rejects.toThrow('business failure');

    const rows = await kysely
      .selectFrom('outbox_events')
      .selectAll()
      .where('type', '=', 'Test.RolledBack')
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('ghi sự kiện kèm payload có mảng cấp cao nhất trong cùng transaction khi commit', async () => {
    await kysely.transaction().execute(async (tx) => {
      await outbox.enqueueKysely(tx, {
        aggregate: 'test', type: 'Test.KyselyCommitted', payload: { n: 3, tags: ['a', 'b'] },
      });
    });

    const rows = await kysely
      .selectFrom('outbox_events')
      .selectAll()
      .where('type', '=', 'Test.KyselyCommitted')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ n: 3, tags: ['a', 'b'] });
    expect(rows[0]?.published_at).toBeNull();
  });

  it('enqueueStandalone tự mở transaction Kysely riêng và dòng sự kiện tồn tại ngay sau khi hàm trả về', async () => {
    await outbox.enqueueStandalone({
      aggregate: 'test', type: 'Test.Standalone', payload: { n: 5 },
    });

    const rows = await kysely
      .selectFrom('outbox_events')
      .selectAll()
      .where('type', '=', 'Test.Standalone')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ n: 5 });
  });

  it('enqueueStandalone ghi qua handle do hàm phân giải cấp khi tầng wiring có cấp hàm phân giải', async () => {
    // Handle chính trỏ vào đầu mối chết (cổng 1): nếu đường
    // standalone dùng handle chính thay vì handle của hàm phân
    // giải, lượt ghi sẽ chết ở kết nối — ca này ghim đúng hợp
    // đồng "phiên chưa chuẩn bị phía Kysely vẫn ghi được qua hàm
    // phân giải" mà tầng wiring dựa vào.
    const deadKysely = createCentreKysely(
      new Pool({ connectionString: 'postgres://postgres:postgres@localhost:1/khong_ton_tai' }),
    );
    const resolved = new OutboxService(deadKysely, async () => kysely);
    try {
      await resolved.enqueueStandalone({
        aggregate: 'test', type: 'Test.StandaloneResolved', payload: { n: 6 },
      });
    } finally {
      await deadKysely.destroy().catch(() => undefined);
    }

    const rows = await kysely
      .selectFrom('outbox_events')
      .selectAll()
      .where('type', '=', 'Test.StandaloneResolved')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ n: 6 });
  });
});
