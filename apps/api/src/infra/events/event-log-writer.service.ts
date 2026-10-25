import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { context, eventLog } from '../../db/schema';

/** The outbox row shape the writer mirrors (structural subset of the Drizzle row). */
export interface OutboxRowLike {
  id: string;
  seq: number;
  aggregate: string;
  type: string;
  payload: Record<string, unknown> | null;
  /** Tenant của ngữ cảnh phát sinh (cột trên outbox_events, TENANT-0 #168). */
  tenantId?: string | null;
  occurredAt: Date;
}

const COURSE_CONTEXT_LEVEL = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * The single logstore observer (Moodle logstore_standard equivalent): every
 * committed outbox row relayed by either relay (API or worker) is mirrored
 * into `event_log` — an immutable, queryable audit trail — with a normalised
 * payload (component / action / actor / related user / course / object / IP)
 * so the read API can filter without knowing each event's raw payload shape.
 *
 * Mirroring NEVER breaks the relay: failures are logged and swallowed, the
 * outbox row stays published exactly as before (at-least-once semantics of
 * the relay are unchanged; a relay replay can therefore duplicate a log row,
 * the same trade-off the in-process emit already accepts).
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

  /** Read-only course-context lookup; a missing context leaves the column null (the payload still carries courseId). */
  private async courseContextId(courseId: string): Promise<string | null> {
    if (!UUID_RE.test(courseId)) return null;
    const rows = await this.db
      .select({ id: context.id })
      .from(context)
      .where(and(eq(context.contextLevel, COURSE_CONTEXT_LEVEL), eq(context.instanceId, courseId)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
}
