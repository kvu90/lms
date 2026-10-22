import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DrizzleModule } from '@nestjs/drizzle';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { relations } from '../../db/relations';
import { outboxEvents } from '../../db/schema';
import type { Database } from '../../db/database';
import { getDrizzleToken } from '@nestjs/drizzle';
import { validateEnv } from '../../config/env';
import { EventsModule } from './events.module';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';

describe('Transactional outbox (real DB, lms_test)', () => {
  let moduleRef: TestingModule;
  let db: Database;
  let outbox: OutboxService;
  let relay: OutboxRelayService;
  let emitter: EventEmitter2;

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
    relay = moduleRef.get(OutboxRelayService);
    emitter = moduleRef.get(EventEmitter2);
  });

  beforeEach(async () => {
    await db.delete(outboxEvents);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('publishes the event after the transaction commits', async () => {
    const received: unknown[] = [];
    emitter.on('P0.Committed', (payload) => received.push(payload));

    await db.transaction(async (tx) => {
      await outbox.enqueue(tx, {
        aggregate: 'p0', type: 'P0.Committed', payload: { n: 1 },
      });
    });

    const published = await relay.publishPending();
    expect(published).toBe(1);
    expect(received).toEqual([{ n: 1 }]);

    const rows = await db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publishedAt).not.toBeNull();
  });

  it('publishes NOTHING when the transaction rolls back', async () => {
    const received: unknown[] = [];
    emitter.on('P0.RolledBack', (payload) => received.push(payload));

    await expect(
      db.transaction(async (tx) => {
        await outbox.enqueue(tx, {
          aggregate: 'p0', type: 'P0.RolledBack', payload: { n: 2 },
        });
        throw new Error('business failure — roll back');
      }),
    ).rejects.toThrow('business failure');

    const rows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, 'P0.RolledBack'));
    expect(rows).toHaveLength(0);

    const published = await relay.publishPending();
    expect(published).toBe(0);
    expect(received).toEqual([]);
  });
});
