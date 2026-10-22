import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { asc, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from './db/relations';
import { outboxEvents } from './db/schema';

type Database = NodePgDatabase<typeof relations>;

/**
 * Worker-side outbox relay: polls committed outbox rows, re-emits them for
 * worker-local consumers and marks them published. Same table and semantics
 * as the API-side relay (apps/api OutboxRelayService).
 */
@Injectable()
export class OutboxRelayScheduler {
  private readonly logger = new Logger(OutboxRelayScheduler.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
  ) {}

  @Interval(5000)
  async relayTick(): Promise<void> {
    await this.publishPending();
  }

  async publishPending(limit = 50): Promise<number> {
    const pending = await this.db
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt))
      .orderBy(asc(outboxEvents.id))
      .limit(limit);

    let published = 0;
    for (const row of pending) {
      this.emitter.emit(row.type, row.payload);
      await this.db
        .update(outboxEvents)
        .set({ publishedAt: new Date() })
        .where(eq(outboxEvents.id, row.id));
      published += 1;
    }
    if (published > 0) {
      this.logger.log(`Relayed ${published} outbox event(s)`);
    }
    return published;
  }
}
