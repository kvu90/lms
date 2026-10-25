import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { asc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { outboxEvents } from '../../db/schema';
import { tenantAls } from '../../modules/tenants/tenant-als';
import { EventLogWriter } from './event-log-writer.service';

/**
 * Publishes committed outbox rows to the in-process EventEmitter (and, in the
 * worker process, to BullMQ consumers). Rows are marked published only after
 * the emit, so a crash mid-relay replays instead of losing events. Each
 * published row is also mirrored into the event log by the single logstore
 * observer (EventLogWriter) — mirroring never changes publish semantics.
 */
@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
    private readonly eventLog: EventLogWriter,
  ) {}

  /**
   * TENANT-1 (#196): relay quét outbox XUYÊN tenant — chạy trong ngữ
   * cảnh platform tường minh để RLS fail-closed không làm mù các sự
   * kiện mang tenant_id (pool gắn GUC theo ALS ở mọi checkout). Các
   * handler nghe EventEmitter trong nhịp này cũng thừa hưởng ngữ cảnh.
   */
  async publishPending(limit = 50): Promise<number> {
    return tenantAls.run({ platform: true }, () => this.publishPendingInContext(limit));
  }

  private async publishPendingInContext(limit: number): Promise<number> {
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
      await this.eventLog.record({
        id: row.id, seq: row.seq, aggregate: row.aggregate, type: row.type,
        payload: row.payload as Record<string, unknown> | null, occurredAt: row.occurredAt,
      });
      published += 1;
    }
    if (published > 0) {
      this.logger.debug(`Published ${published} outbox event(s)`);
    }
    return published;
  }
}
