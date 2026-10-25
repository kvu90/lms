import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { notificationDispatchLog, pluginConfig, userPreferences, users } from '@lms/db-schema';
import { tenantAls } from '../db/tenant-als';

type Database = NodePgDatabase<typeof relations>;

export interface NotificationDispatchJobData {
  userId: string;
  provider: string;
  channel: string; // email | push (external ports)
  subject: string;
  body: string;
  notificationId?: string | null;
  dedupeKey: string;
  /** Tenant của notification nguồn (TENANT-1, #196); job cũ không có → null. */
  tenantId?: string | null;
}
export interface NotificationDispatchResult {
  status: 'logged' | 'skipped-suspended' | 'skipped-preference' | 'skipped-admin-disabled' | 'duplicate';
  channel: string;
}

/**
 * Hai loại bắt buộc (P2) — bản chiếu tối thiểu của `mandatoryInApp`
 * trong registry phía API (messaging/notification-providers.ts):
 * chính sách admin không bao giờ chặn chúng, kể cả ở khâu kiểm lại
 * lúc phân phối này.
 */
const MANDATORY_PROVIDERS = new Set(['enrol_expiry_warning', 'admin_announcement']);

/**
 * Notification dispatch: the worker end of the channel PORTS. Email and
 * push are never actually sent — the dispatch is LOGGED (that log is the
 * deliverable of the port). Delivery law is re-checked here, at dispatch
 * time, against live data: a suspended user gets nothing, and a preference
 * disabled after enqueueing still suppresses the dispatch. Idempotent via
 * the job's dedupeKey (unique in notification_dispatch_log).
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
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<NotificationDispatchJobData>): Promise<NotificationDispatchResult> {
    const { userId, provider, channel, subject, dedupeKey } = job.data;
    const tenantId = job.data.tenantId ?? null;
    const [existing] = await this.db.select().from(notificationDispatchLog)
      .where(eq(notificationDispatchLog.dedupeKey, dedupeKey));
    if (existing) return { status: 'duplicate', channel };

    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.suspended || user.deleted) {
      await this.db.insert(notificationDispatchLog).values({
        userId: userId, provider, channel, status: 'skipped-suspended', subject, dedupeKey, tenantId,
        notificationId: job.data.notificationId ?? null,
      }).onConflictDoNothing();
      return { status: 'skipped-suspended', channel };
    }
    // Admin site policy re-check (NB-7): the type may have been
    // disabled site-wide AFTER the job was queued — the dispatch-time
    // law wins, like the suspended/preference re-checks. Mandatory P2
    // types are never blocked here either.
    if (!MANDATORY_PROVIDERS.has(provider)) {
      const [policy] = await this.db.select({ value: pluginConfig.value }).from(pluginConfig)
        .where(and(
          eq(pluginConfig.plugin, 'notifications'),
          eq(pluginConfig.name, `provider_${provider}_enabled`),
          isNull(pluginConfig.tenantId),
        ));
      let adminDisabled = false;
      if (policy && policy.value !== null) {
        try { adminDisabled = JSON.parse(policy.value) === false; } catch { adminDisabled = false; }
      }
      if (adminDisabled) {
        await this.db.insert(notificationDispatchLog).values({
          userId: userId, provider, channel, status: 'skipped-admin-disabled', subject, dedupeKey, tenantId,
          notificationId: job.data.notificationId ?? null,
        }).onConflictDoNothing();
        return { status: 'skipped-admin-disabled', channel };
      }
    }
    // Preference re-check for both login states: disabled in both ⇒ no dispatch.
    const prefName = (state: string) => `message_provider_${provider}_${channel}_${state}`;
    const prefs = await this.db.select().from(userPreferences).where(and(
      eq(userPreferences.userId, userId),
    ));
    const byName = new Map(prefs.map((p) => [p.name, p.value]));
    const loggedin = byName.get(prefName('loggedin')) !== '0';
    const loggedoff = byName.get(prefName('loggedoff')) !== '0';
    if (!loggedin && !loggedoff) {
      await this.db.insert(notificationDispatchLog).values({
        userId: userId, provider, channel, status: 'skipped-preference', subject, dedupeKey, tenantId,
        notificationId: job.data.notificationId ?? null,
      }).onConflictDoNothing();
      return { status: 'skipped-preference', channel };
    }
    await this.db.insert(notificationDispatchLog).values({
      userId: userId, provider, channel, status: 'logged', subject, dedupeKey, tenantId,
      notificationId: job.data.notificationId ?? null,
    }).onConflictDoNothing();
    return { status: 'logged', channel };
  }
}
