import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { asc, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from './db/relations';
import { outboxEvents } from '@lms/db';
import { EventLogWriter } from './event-log-writer.service';
import { TaskLogService } from './task-log.service';
import { tenantAls } from './db/tenant-als';

type Database = NodePgDatabase<typeof relations>;

/**
 * Relay outbox phía worker: thăm dò các dòng outbox đã commit, phát lại chúng cho
 * các consumer cục bộ của worker và đánh dấu đã phát hành. Dùng cùng bảng và cùng ngữ nghĩa
 * với relay phía API (apps/api OutboxRelayService).
 */
@Injectable()
/**
 * Chuyển tiếp outbox → hàng đợi BullMQ (transactional outbox pattern).
 * Sự kiện nghiệp vụ được ghi cùng transaction với dữ liệu vào bảng outbox ở API;
 * relay này đọc các bản ghi chưa phát hành, đẩy vào queue tương ứng và đánh dấu đã phát hành —
 * đảm bảo sự kiện không mất khi tiến trình sập giữa chừng (at-least-once; processor phải idempotent).
 */
export class OutboxRelayScheduler {
  private readonly logger = new Logger(OutboxRelayScheduler.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
    private readonly eventLog: EventLogWriter,
    private readonly taskLog: TaskLogService,
  ) {}

  @Interval(5000)
  /**
   * Một nhịp relay: lấy lô sự kiện chờ và phát hành. Nhịp có phát hành (hoặc
   * lỗi) được ghi vào task_log; nhịp rỗng không ghi để tránh nhiễu 5 giây.
   */
  async relayTick(): Promise<void> {
    // TENANT-1 (#196): relay quét outbox XUYÊN tenant — bọc ngữ cảnh
    // platform tường minh để RLS fail-closed không làm mù các sự kiện
    // mang tenant_id (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.relayTickInContext());
  }

  private async relayTickInContext(): Promise<void> {
    const startedAt = new Date();
    try {
      const published = await this.publishPending();
      if (published > 0) {
        await this.taskLog.recordRun('outbox-relay', startedAt, 'success', `relayed ${published} event(s)`);
      }
    } catch (err) {
      await this.taskLog.recordRun('outbox-relay', startedAt, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Phát hành mọi sự kiện outbox đang chờ vào các queue BullMQ.
   */
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
      // Logstore: phản chiếu sang event_log qua observer duy nhất; việc này
      // không đổi ngữ nghĩa phát hành của relay (writer nuốt lỗi của nó).
      await this.eventLog.record({
        id: row.id, seq: row.seq, aggregate: row.aggregate, type: row.type,
        payload: row.payload as Record<string, unknown> | null, occurredAt: row.occurredAt,
        tenantId: row.tenantId,
      });
      published += 1;
    }
    if (published > 0) {
      this.logger.log(`Relayed ${published} outbox event(s)`);
    }
    return published;
  }
}
