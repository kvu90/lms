import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import { uuidIdSchema } from '@lms/contracts';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from './db/relations';
import { context as contextTable, eventLog, outboxEvents } from '@lms/db';

type Database = NodePgDatabase<typeof relations>;

type OutboxRow = typeof outboxEvents.$inferSelect;

/**
 * Hình dáng row outbox mà writer phản chiếu — suy thẳng từ định nghĩa bảng
 * dùng chung `@lms/db-schema` (trước đây là interface chép tay). `payload`
 * thu hẹp về record vì writer chỉ đọc payload dạng object.
 */
export type OutboxRowLike = Pick<OutboxRow, 'id' | 'seq' | 'aggregate' | 'type' | 'occurredAt' | 'tenantId'> & {
  payload: Record<string, unknown> | null;
};

const COURSE_CONTEXT_LEVEL = 50;

/**
 * Các khoá payload ứng viên đặt tên cho đối tượng chính của một sự kiện, theo từng outbox
 * aggregate. Khoá đầu tiên hiện diện sẽ thắng; giá trị được đưa vào trường
 * `objectId` đã chuẩn hoá của payload log đã lưu.
 */
const OBJECT_ID_KEYS: Record<string, string[]> = {
  course: ['courseId'],
  course_category: ['categoryId'],
  course_module: ['cmId'],
  enrol: ['enrolmentId', 'instanceId'],
  grades: ['itemId', 'gradeId'],
  question: ['questionId', 'usageId'],
  stimulus: ['stimulusId'],
  user: ['userId'],
  auth: ['userId'],
  access: ['assignmentId'],
  badges: ['badgeId', 'issuedId'],
  group: ['groupId'],
  grouping: ['groupingId'],
  cohort: ['cohortId'],
  calendar: ['eventId'],
  completion: ['cmId', 'courseId'],
  competency: ['competencyId'],
  messaging: ['conversationId', 'messageId'],
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Bản sao phía worker của EventLogWriter phía API (worker giữ góc nhìn riêng
 * của mình về hạ tầng dùng chung, giống như chính outbox relay): observer logstore duy nhất.
 * Mọi dòng outbox mà relay của worker phát hành đều được phản chiếu
 * vào `event_log` với payload đã chuẩn hoá (component / action / actor /
 * related user / course / object / IP). Việc phản chiếu KHÔNG BAO GIỜ làm gãy relay:
 * lỗi được ghi log và nuốt, ngữ nghĩa phát hành giữ nguyên không đổi.
 */
@Injectable()
export class EventLogWriter {
  private readonly logger = new Logger(EventLogWriter.name);

  constructor(@InjectDrizzle() private readonly db: Database) {}

  async record(row: OutboxRowLike): Promise<void> {
    try {
      const source = (row.payload ?? {}) as Record<string, unknown>;
      const actorId = str(source.actorId);
      const payloadUserId = str(source.userId);
      const relatedUserId = str(source.relatedUserId)
        ?? (payloadUserId && payloadUserId !== actorId ? payloadUserId : null);
      const courseId = str(source.courseId);
      let contextId = str(source.contextId);
      if (!contextId && courseId) contextId = await this.courseContextId(courseId);
      const objectId = this.objectIdOf(row.aggregate, source);
      const sourceComponent = str(source.component);
      const payload: Record<string, unknown> = {
        ...source,
        // Một số payload đã mang sẵn trường `component` của riêng chúng (component
        // hoạt động của một course module) — giữ nó dưới
        // `sourceComponent`; `component` đã chuẩn hoá là phân hệ của sự kiện
        // (outbox aggregate).
        ...(sourceComponent ? { sourceComponent } : {}),
        component: row.aggregate,
        action: row.type,
        actorId,
        relatedUserId,
        courseId,
        objectId,
        ip: str(source.ip),
        outboxId: row.id,
        outboxSeq: row.seq,
      };
      await this.db.insert(eventLog).values({
        eventType: row.type,
        contextId,
        userId: actorId,
        tenantId: row.tenantId ?? str(source.tenantId),
        payload,
        createdAt: row.occurredAt,
      });
    } catch (err) {
      this.logger.error(`Failed to mirror outbox event ${row.type} (${row.id}) into event_log: ${String(err)}`);
    }
  }

  private objectIdOf(aggregate: string, payload: Record<string, unknown>): string | null {
    const keys = OBJECT_ID_KEYS[aggregate] ?? ['objectId'];
    for (const key of keys) {
      const value = str(payload[key]);
      if (value) return value;
    }
    return str(payload.objectId);
  }

  /** Tra cứu context của khoá học chỉ đọc; context bị thiếu thì cột để null (payload vẫn mang courseId). */
  private async courseContextId(courseId: string): Promise<string | null> {
    if (!uuidIdSchema.safeParse(courseId).success) return null;
    const rows = await this.db
      .select({ id: contextTable.id })
      .from(contextTable)
      .where(and(eq(contextTable.contextLevel, COURSE_CONTEXT_LEVEL), eq(contextTable.instanceId, courseId)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
}
