import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { asc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { outboxEvents } from '../../db/schema';

/**
 * Publishes committed outbox rows to the in-process EventEmitter (and, in the
 * worker process, to BullMQ consumers). Rows are marked published only after
 * the emit, so a crash mid-relay replays instead of losing events.
 */
@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
  ) {}

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
      this.logger.debug(`Published ${published} outbox event(s)`);
    }
    return published;
  }
}
