import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { notificationDispatchLog, userPreferences, users } from '../db/schema';

type Database = NodePgDatabase<typeof relations>;

export interface NotificationDispatchJobData {
  userId: number;
  provider: string;
  channel: string; // email | push (external ports)
  subject: string;
  body: string;
  notificationId?: number | null;
  dedupekey: string;
}
export interface NotificationDispatchResult {
  status: 'logged' | 'skipped-suspended' | 'skipped-preference' | 'duplicate';
  channel: string;
}

/**
 * Notification dispatch: the worker end of the channel PORTS. Email and
 * push are never actually sent — the dispatch is LOGGED (that log is the
 * deliverable of the port). Delivery law is re-checked here, at dispatch
 * time, against live data: a suspended user gets nothing, and a preference
 * disabled after enqueueing still suppresses the dispatch. Idempotent via
 * the job's dedupekey (unique in notification_dispatch_log).
 */
@Processor('notification-dispatch')
/**
 * Xử lý job phân phối notification ra kênh ngoài (email/popup) theo tuỳ chọn người nhận.
 */
export class NotificationDispatchProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<NotificationDispatchJobData>): Promise<NotificationDispatchResult> {
    const { userId, provider, channel, subject, dedupekey } = job.data;
    const [existing] = await this.db.select().from(notificationDispatchLog)
      .where(eq(notificationDispatchLog.dedupekey, dedupekey));
    if (existing) return { status: 'duplicate', channel };

    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.suspended || user.deleted) {
      await this.db.insert(notificationDispatchLog).values({
        userid: userId, provider, channel, status: 'skipped-suspended', subject, dedupekey,
        notificationid: job.data.notificationId ?? null,
      }).onConflictDoNothing();
      return { status: 'skipped-suspended', channel };
    }
    // Preference re-check for both login states: disabled in both ⇒ no dispatch.
    const prefName = (state: string) => `message_provider_${provider}_${channel}_${state}`;
    const prefs = await this.db.select().from(userPreferences).where(and(
      eq(userPreferences.userid, userId),
    ));
    const byName = new Map(prefs.map((p) => [p.name, p.value]));
    const loggedin = byName.get(prefName('loggedin')) !== '0';
    const loggedoff = byName.get(prefName('loggedoff')) !== '0';
    if (!loggedin && !loggedoff) {
      await this.db.insert(notificationDispatchLog).values({
        userid: userId, provider, channel, status: 'skipped-preference', subject, dedupekey,
        notificationid: job.data.notificationId ?? null,
      }).onConflictDoNothing();
      return { status: 'skipped-preference', channel };
    }
    await this.db.insert(notificationDispatchLog).values({
      userid: userId, provider, channel, status: 'logged', subject, dedupekey,
      notificationid: job.data.notificationId ?? null,
    }).onConflictDoNothing();
    return { status: 'logged', channel };
  }
}
