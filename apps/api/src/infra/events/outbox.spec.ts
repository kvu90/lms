import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DrizzleModule } from '@nestjs/drizzle';
import { createCentreKysely, type CentreDb } from '@lms/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { relations } from '../../db/relations';
import { outboxEvents } from '../../db/schema';
import type { Database } from '../../db/database';
import { getDrizzleToken } from '@nestjs/drizzle';
import { validateEnv } from '../../config/env';
import { EventsModule } from './events.module';
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
 */
describe('Outbox giao dịch (DB thật, lms_test_api)', () => {
  let moduleRef: TestingModule;
  let db: Database;
  let outbox: OutboxService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        DrizzleModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            drizzle,
            connection: config.getOrThrow<string>('DATABASE_URL'),
            relations,
          }),
        }),
        EventsModule,
      ],
    }).compile();
    db = moduleRef.get(getDrizzleToken());
    outbox = moduleRef.get(OutboxService);
  });

  beforeEach(async () => {
    await db.delete(outboxEvents);
  });

  afterAll(async () => {
    await moduleRef.close();
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

  describe('đường ghi Kysely (enqueueKysely, issue #646)', () => {
    let kysely: CentreDb;

    beforeAll(() => {
      const config = moduleRef.get(ConfigService);
      kysely = createCentreKysely(
        new Pool({ connectionString: config.getOrThrow<string>('DATABASE_URL') }),
      );
    });

    afterAll(async () => {
      await kysely.destroy().catch(() => undefined);
    });

    it('ghi sự kiện vào outbox khi transaction Kysely commit, payload jsonb đọc lại đúng qua phía Drizzle', async () => {
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

    it('không ghi sự kiện nào khi transaction Kysely rollback', async () => {
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
  });
});
