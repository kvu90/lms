import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { outboxEvents, userEnrolments } from '../db/schema';

type Database = NodePgDatabase<typeof relations>;

export interface EnrolExpiryResult { checkedAt: string; suspendedIds: number[] }

/**
 * Enrolment expiry (P2): ACTIVE user_enrolments whose timeend has passed
 * are flipped to SUSPENDED and a user_enrolment_suspended outbox event is
 * written in the same transaction per row. Access is ALSO denied at read
 * time by the API's isEnrolled(onlyActive) time-window check, so a delayed
 * sweep never opens a window of access — the sweep only normalises state.
 */
@Processor('enrol-expiry')
export class EnrolExpiryProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }

  async process(_job: Job): Promise<EnrolExpiryResult> {
    void _job;
    const now = new Date();
    const expired = await this.db.select().from(userEnrolments)
      .where(and(eq(userEnrolments.status, 0), lt(userEnrolments.timeend, now)));
    const suspendedIds: number[] = [];
    for (const ue of expired) {
      await this.db.transaction(async (tx) => {
        await tx.update(userEnrolments).set({ status: 1, timemodified: now }).where(eq(userEnrolments.id, ue.id));
        await tx.insert(outboxEvents).values({
          aggregate: 'enrol', type: 'user_enrolment_suspended',
          payload: { userId: ue.userid, enrolmentId: ue.id, enrolid: ue.enrolid, reason: 'expired' },
        });
      });
      suspendedIds.push(ue.id);
    }
    void sql;
    return { checkedAt: now.toISOString(), suspendedIds };
  }
}
