import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import { uuidIdSchema } from '@lms/contracts';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from './db/relations';
import { context as contextTable, eventLog, outboxEvents } from '@lms/db-schema';

type Database = NodePgDatabase<typeof relations>;

type OutboxRow = typeof outboxEvents.$inferSelect;

/**
 * Hình dáng row outbox mà writer phản chiếu — suy thẳng từ định nghĩa bảng
 * dùng chung `@lms/db-schema` (trước đây là interface chép tay). `payload`
 * thu hẹp về record vì writer chỉ đọc payload dạng object.
 */
export type OutboxRowLike = Pick<OutboxRow, 'id' | 'seq' | 'aggregate' | 'type' | 'occurredAt'> & {
  payload: Record<string, unknown> | null;
};

const COURSE_CONTEXT_LEVEL = 50;

/**
 * Candidate payload keys naming the primary object of an event, per outbox
 * aggregate. First present key wins; the value lands in the normalised
 * `objectId` field of the stored log payload.
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
 * Worker-side copy of the API's EventLogWriter (the worker keeps its own
 * view of shared infrastructure, like the outbox relay itself): the single
 * logstore observer. Every outbox row the worker relay publishes is mirrored
 * into `event_log` with a normalised payload (component / action / actor /
 * related user / course / object / IP). Mirroring NEVER breaks the relay:
 * failures are logged and swallowed, publish semantics stay unchanged.
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
        // A few payloads already carry a `component` field of their own (the
        // activity component of a course module) — keep it under
        // `sourceComponent`; the normalised `component` is the event's
        // subsystem (the outbox aggregate).
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

  /** Read-only course-context lookup; a missing context leaves the column null (the payload still carries courseId). */
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
