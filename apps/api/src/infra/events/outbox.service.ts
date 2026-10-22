import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../../db/database';
import { outboxEvents } from '../../db/schema';

export interface OutboxEventInput {
  aggregate: string;
  type: string;
  payload: Record<string, unknown>;
}

/** The minimal transaction surface OutboxService needs (a Drizzle tx). */
export interface OutboxTx {
  insert: Database['insert'];
}

/**
 * Transactional outbox (self-built, ADR-004): the event row is written in the
 * SAME database transaction as the business change. If the transaction rolls
 * back, no event row exists and nothing can ever be published.
 */
@Injectable()
export class OutboxService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async enqueue(tx: OutboxTx, input: OutboxEventInput): Promise<void> {
    await tx.insert(outboxEvents).values({
      aggregate: input.aggregate,
      type: input.type,
      payload: input.payload,
    });
  }

  /** Convenience: enqueue in its own short transaction. */
  async enqueueStandalone(input: OutboxEventInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.enqueue(tx as OutboxTx, input);
    });
  }
}
