import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '@lms/db';
import { relations } from '../../db/relations';
import { outboxEvents } from '../../db/schema';
import type { Database } from '../../db/database';
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
 * Service được dựng trực tiếp trên MỘT pool vật lý dùng chung cho
 * cả hai ORM (handle Kysely của chính service + handle Drizzle
 * cho đường ghi chuyển tiếp và cho việc đọc khẳng định) để đối
 * chiếu hai đường ghi trên cùng một kho thật: đường Kysely chuẩn
 * (`enqueueKysely`, `enqueueStandalone`) và đường Drizzle chuyển
 * tiếp (`enqueue`) phải cho cùng hình dạng dòng.
 */
describe('Outbox giao dịch (DB thật, lms_test_api)', () => {
  let pool: Pool;
  let db: Database;
  let kysely: CentreDb;
  let outbox: OutboxService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle({ client: pool, relations });
    kysely = createCentreKysely(pool);
    outbox = new OutboxService(kysely);
  });

  beforeEach(async () => {
    await db.delete(outboxEvents);
  });

  afterAll(async () => {
    // Instance Kysely sở hữu pool dùng chung: destroy() đóng luôn
    // pool, nên đây là thao tác dọn dẹp cuối cùng của spec.
    await kysely.destroy();
  });

  it('ghi sự kiện vào outbox khi transaction commit (chưa phát: publishedAt null cho tới khi relay worker chạy)', async () => {
    await db.transaction(async (tx) => {
      await outbox.enqueue(tx, {
        aggregate: 'test', type: 'Test.Committed', payload: { n: 1 },
      });
    });

    const rows = await db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('Test.Committed');
    expect(rows[0]?.payload).toEqual({ n: 1 });
    expect(rows[0]?.publishedAt).toBeNull();
  });

  it('không ghi sự kiện nào khi transaction rollback', async () => {
    await expect(
      db.transaction(async (tx) => {
        await outbox.enqueue(tx, {
          aggregate: 'test', type: 'Test.RolledBack', payload: { n: 2 },
        });
        throw new Error('business failure — roll back');
      }),
    ).rejects.toThrow('business failure');

    const rows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'Test.RolledBack'));
    expect(rows).toHaveLength(0);
  });

  it('đường Kysely ghi sự kiện vào outbox trong cùng transaction với nghiệp vụ khi transaction commit', async () => {
    await kysely.transaction().execute(async (tx) => {
      await outbox.enqueueKysely(tx, {
        aggregate: 'test', type: 'Test.KyselyCommitted', payload: { n: 3, tags: ['a', 'b'] },
      });
    });

    const rows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'Test.KyselyCommitted'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ n: 3, tags: ['a', 'b'] });
    expect(rows[0]?.publishedAt).toBeNull();
  });

  it('đường Kysely không ghi sự kiện nào khi transaction của nghiệp vụ rollback', async () => {
    await expect(
      kysely.transaction().execute(async (tx) => {
        await outbox.enqueueKysely(tx, {
          aggregate: 'test', type: 'Test.KyselyRolledBack', payload: { n: 4 },
        });
        throw new Error('business failure — roll back');
      }),
    ).rejects.toThrow('business failure');

    const rows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'Test.KyselyRolledBack'));
    expect(rows).toHaveLength(0);
  });

  it('enqueueStandalone tự mở transaction Kysely riêng và dòng sự kiện tồn tại ngay sau khi hàm trả về', async () => {
    await outbox.enqueueStandalone({
      aggregate: 'test', type: 'Test.Standalone', payload: { n: 5 },
    });

    const rows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'Test.Standalone'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ n: 5 });
  });
});
