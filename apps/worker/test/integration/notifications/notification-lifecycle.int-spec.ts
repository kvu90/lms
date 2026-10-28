import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import {
  NOTIFICATION_UNREAD_CHANGED_CHANNEL,
  NotificationDeliveryService,
} from '../../../src/notification-delivery.service';
import { CalendarReminderProcessor } from '../../../src/processors/calendar-reminder.processor';
import { ReportScheduleProcessor } from '../../../src/processors/platform-services.processors';
import {
  NotificationRetentionProcessor,
} from '../../../src/processors/notification-retention.processor';
import { redisConnectionFromUrl } from '../../../src/config/env';
import { tenantAls } from '../../../src/db/tenant-als';
import {
  calendarEvents, notificationDispatchLog, notifications, reportBuilderReport,
  reportBuilderSchedule, taskLog, userPreferences,
} from '@lms/db';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

const DAY_MS = 24 * 3600_000;

/**
 * NB-6 (issue #174, G9 + G10): vòng đời dữ liệu thông báo + hai đường
 * phát nền (calendar reminder, report schedule) quy về hàm luật phân
 * phối dùng chung của worker. Oracle: mô hình đích D.6 (đã đọc 90 ngày /
 * chưa đọc 180 ngày / dispatch log 90 ngày) + luật `notify()` phía API
 * sau NB-2 (v2 → suy dữ liệu cũ loggedin → loggedoff → mặc định bật;
 * loại bắt buộc P2 ép bật; người bị đình chỉ không nhận gì).
 *
 * Từ lát 2 của issue #294, spec này boot WorkerModule qua harness
 * role thường (`test/ordinary-worker-module.ts`): module chạy bằng
 * role NOSUPERUSER/NOBYPASSRLS như production, fixture và đọc kiểm
 * chứng đi qua kết nối quản trị của harness — khẳng định nghiệp vụ
 * của spec không đổi. Hệ quả của việc chạy bằng role thường: ca nào
 * gọi trực tiếp service phân phối (không qua processor) phải tự đặt
 * ngữ cảnh platform bằng `tenantAls.run({ platform: true }, ...)`
 * như mọi processor vẫn làm trước khi gọi service trong production —
 * ngoài ngữ cảnh, RLS fail-closed chặn cả dòng thông báo không gắn
 * tenant, vốn chỉ được phép ở ngữ cảnh platform.
 */
describe('Worker NB-6: notification retention + shared delivery law', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: any;
  let delivery: NotificationDeliveryService;
  const suffix = Date.now() % 100000;
  const uid = (slot: number) => `01970000-0000-7000-8000-${String(970000 + suffix * 10 + slot).padStart(12, '0')}`;
  const plainUser = uid(1);
  const v2OffUser = uid(2);
  const legacyInOffUser = uid(3);
  const legacyOutOffUser = uid(4);
  const suspendedUser = uid(5);
  const retentionUser = uid(6);
  const startedAt = new Date(Date.now() - 1000);

  async function mkUser(id: string, username: string, suspended = false) {
    await db.execute(sql`insert into users (id, username, email, first_name, last_name, suspended, deleted)
      values (${id}, ${username}, ${`${username}@x.io`}, 'Nb6', 'User', ${suspended}, false)
      on conflict (id) do nothing`);
  }

  async function setPref(userId: string, name: string, value: string) {
    await db.insert(userPreferences).values({ userId, name, value }).onConflictDoNothing();
  }

  async function mkEvent(userId: string, name: string) {
    const [event] = await db.insert(calendarEvents).values({
      name, eventType: 'user', userId, timeStart: new Date(Date.now() + 3600_000),
    }).returning();
    return event.id as string;
  }

  async function notesOf(userId: string, eventType: string) {
    return db.select().from(notifications)
      .where(and(eq(notifications.userIdTo, userId), eq(notifications.eventType, eventType)));
  }

  async function dispatchOf(userId: string, provider: string, status: string) {
    return db.select().from(notificationDispatchLog).where(and(
      eq(notificationDispatchLog.userId, userId),
      eq(notificationDispatchLog.provider, provider),
      eq(notificationDispatchLog.status, status),
    ));
  }

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    delivery = context.get(NotificationDeliveryService);
    await mkUser(plainUser, `nb6-plain-${suffix}`);
    await mkUser(v2OffUser, `nb6-v2off-${suffix}`);
    await mkUser(legacyInOffUser, `nb6-login-off-${suffix}`);
    await mkUser(legacyOutOffUser, `nb6-logout-off-${suffix}`);
    await mkUser(suspendedUser, `nb6-susp-${suffix}`, true);
    await mkUser(retentionUser, `nb6-ret-${suffix}`);
    // v2OffUser tắt popup theo mô hình v2 cho cả hai provider của lát.
    await setPref(v2OffUser, 'message_provider_calendar_reminder_popup_v2', '0');
    await setPref(v2OffUser, 'message_provider_report_scheduled_popup_v2', '0');
    // legacyInOffUser chỉ tắt theo khoá cũ ở trạng thái loggedin.
    await setPref(legacyInOffUser, 'message_provider_calendar_reminder_popup_loggedin', '0');
    // legacyOutOffUser chỉ có khoá cũ ở trạng thái loggedoff: luật chung
    // (như API sau NB-2) suy loggedin → loggedoff nên vẫn tính là tắt.
    await setPref(legacyOutOffUser, 'message_provider_calendar_reminder_popup_loggedoff', '0');
  });
  afterAll(async () => { await harness.close(); });

  it('calendar reminder delivers through the shared law: notification + delivered dispatch log, replay is duplicate', async () => {
    const processor = context.get(CalendarReminderProcessor);
    const eventId = await mkEvent(plainUser, `NB6 exam ${suffix}`);
    const first = await processor.process({ data: { eventId, userId: plainUser, minutesBefore: 30 } } as never);
    expect(first.status).toBe('notified');
    const notes = await notesOf(plainUser, 'calendar_reminder');
    expect(notes).toHaveLength(1);
    expect(notes[0].contextUrl).toBe(`/calendar/events/${eventId}`);
    // Giữ nguyên bề mặt hiển thị cũ: smallMessage là subject.
    expect(notes[0].smallMessage).toBe(notes[0].subject);
    const logs = await dispatchOf(plainUser, 'calendar_reminder', 'delivered');
    expect(logs).toHaveLength(1);
    expect(logs[0].dedupeKey).toBe(`popup-${notes[0].id}`);
    expect(logs[0].notificationId).toBe(notes[0].id);
    const replay = await processor.process({ data: { eventId, userId: plainUser, minutesBefore: 30 } } as never);
    expect(replay.status).toBe('duplicate');
    expect(await notesOf(plainUser, 'calendar_reminder')).toHaveLength(1);
  });

  it('calendar reminder honours the v2 preference: off ⇒ nothing stored, skipped-preference logged', async () => {
    const processor = context.get(CalendarReminderProcessor);
    const eventId = await mkEvent(v2OffUser, `NB6 exam off ${suffix}`);
    const result = await processor.process({ data: { eventId, userId: v2OffUser, minutesBefore: 30 } } as never);
    expect(result.status).toBe('skipped-preference');
    expect(await notesOf(v2OffUser, 'calendar_reminder')).toHaveLength(0);
    expect(await dispatchOf(v2OffUser, 'calendar_reminder', 'skipped-preference')).toHaveLength(1);
  });

  it('calendar reminder honours legacy preferences by the shared derivation (loggedin, then loggedoff)', async () => {
    const processor = context.get(CalendarReminderProcessor);
    const inEvent = await mkEvent(legacyInOffUser, `NB6 legacy in ${suffix}`);
    const inResult = await processor.process({ data: { eventId: inEvent, userId: legacyInOffUser, minutesBefore: 30 } } as never);
    expect(inResult.status).toBe('skipped-preference');
    expect(await notesOf(legacyInOffUser, 'calendar_reminder')).toHaveLength(0);
    const outEvent = await mkEvent(legacyOutOffUser, `NB6 legacy out ${suffix}`);
    const outResult = await processor.process({ data: { eventId: outEvent, userId: legacyOutOffUser, minutesBefore: 30 } } as never);
    expect(outResult.status).toBe('skipped-preference');
    expect(await notesOf(legacyOutOffUser, 'calendar_reminder')).toHaveLength(0);
  });

  it('calendar reminder delivers nothing to a suspended user and logs skipped-suspended', async () => {
    const processor = context.get(CalendarReminderProcessor);
    const eventId = await mkEvent(suspendedUser, `NB6 exam susp ${suffix}`);
    const result = await processor.process({ data: { eventId, userId: suspendedUser, minutesBefore: 30 } } as never);
    expect(result.status).toBe('skipped-suspended');
    expect(await notesOf(suspendedUser, 'calendar_reminder')).toHaveLength(0);
    expect(await dispatchOf(suspendedUser, 'calendar_reminder', 'skipped-suspended')).toHaveLength(1);
  });

  it('mandatory providers (P2) cannot be turned off: resolution forces the in-app channel on', async () => {
    // v2OffUser không có khoá nào cho provider bắt buộc này — gieo thêm
    // khoá v2 tắt tường minh rồi vẫn phải bị ép bật khi mandatory.
    await setPref(v2OffUser, 'message_provider_enrol_expiry_warning_popup_v2', '0');
    const law = { name: 'enrol_expiry_warning', component: 'core_enrol', mandatoryInApp: true };
    expect(await delivery.resolvePopupEnabled(v2OffUser, law)).toBe(true);
    expect(await delivery.resolvePopupEnabled(v2OffUser, { ...law, mandatoryInApp: false })).toBe(false);
  });

  it('the shared law rejects unregistered providers without writing anything', async () => {
    const result = await delivery.deliverInApp(plainUser, 'not_a_provider', {
      subject: 'x', body: 'y', smallMessage: 'x',
    });
    expect(result.status).toBe('unknown-provider');
    expect(await notesOf(plainUser, 'not_a_provider')).toHaveLength(0);
  });

  it('delivery publishes the unread-changed badge signal on the shared Redis channel', async () => {
    const subscriber = new Redis(redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379'));
    try {
      await subscriber.subscribe(NOTIFICATION_UNREAD_CHANGED_CHANNEL);
      const messagePromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('badge signal not received in 5s')), 5000);
        subscriber.on('message', (_channel: string, message: string) => {
          if (message === plainUser) { clearTimeout(timer); resolve(message); }
        });
      });
      // Gọi service trực tiếp nên spec tự đặt ngữ cảnh platform —
      // trong production service luôn được processor gọi từ bên
      // trong ngữ cảnh platform/tenant mà processor đã bọc.
      const result = await tenantAls.run({ platform: true }, () => delivery.deliverInApp(plainUser, 'report_scheduled', {
        subject: `NB6 signal ${suffix}`, body: 'body', smallMessage: `NB6 signal ${suffix}`,
        contextUrl: '/reports/signal',
      }));
      expect(result.status).toBe('delivered');
      await expect(messagePromise).resolves.toBe(plainUser);
    } finally {
      await subscriber.quit();
    }
  });

  it('report schedule notifies through the shared law and now leaves a delivered dispatch log', async () => {
    const [report] = await db.insert(reportBuilderReport).values({
      name: `NB6 report ${suffix}`, dataSource: 'enrolments', createdBy: plainUser, columns: ['userId'],
    }).returning();
    const [schedule] = await db.insert(reportBuilderSchedule).values({
      reportId: report.id, createdBy: plainUser, cron: 'daily', enabled: true,
    }).returning();
    const processor = context.get(ReportScheduleProcessor);
    const result = await processor.process({ data: { scheduleId: schedule.id } } as never);
    expect(result.status).toBe('completed');
    const notes = await notesOf(plainUser, 'report_scheduled');
    expect(notes.length).toBeGreaterThanOrEqual(1);
    const mine = notes.find((n: { contextUrl: string }) => n.contextUrl === `/reports/${report.id}`);
    expect(mine).toBeDefined();
    const logs = await dispatchOf(plainUser, 'report_scheduled', 'delivered');
    expect(logs.some((l: { notificationId: string }) => l.notificationId === mine.id)).toBe(true);
  });

  it('report schedule respects the law: preference off and suspended creators get no notification', async () => {
    const processor = context.get(ReportScheduleProcessor);
    async function runFor(creator: string, tag: string) {
      const [report] = await db.insert(reportBuilderReport).values({
        name: `NB6 report ${tag} ${suffix}`, dataSource: 'enrolments', createdBy: creator, columns: ['userId'],
      }).returning();
      const [schedule] = await db.insert(reportBuilderSchedule).values({
        reportId: report.id, createdBy: creator, cron: 'daily', enabled: true,
      }).returning();
      const result = await processor.process({ data: { scheduleId: schedule.id } } as never);
      expect(result.status).toBe('completed');
      return report.id as string;
    }
    const offReportId = await runFor(v2OffUser, 'off');
    expect((await notesOf(v2OffUser, 'report_scheduled'))
      .some((n: { contextUrl: string }) => n.contextUrl === `/reports/${offReportId}`)).toBe(false);
    expect(await dispatchOf(v2OffUser, 'report_scheduled', 'skipped-preference')).toHaveLength(1);
    const suspReportId = await runFor(suspendedUser, 'susp');
    expect((await notesOf(suspendedUser, 'report_scheduled'))
      .some((n: { contextUrl: string }) => n.contextUrl === `/reports/${suspReportId}`)).toBe(false);
    expect((await dispatchOf(suspendedUser, 'report_scheduled', 'skipped-suspended')).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('retention sweep deletes exactly past the 90/180/90 day boundaries and keeps the boundary day', async () => {
    const processor = context.get(NotificationRetentionProcessor);
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
    async function mkNote(days: number, read: boolean) {
      const [row] = await db.insert(notifications).values({
        userIdTo: retentionUser, subject: `nb6-ret-${days}-${read ? 'r' : 'u'}-${suffix}`,
        fullMessage: 'x', smallMessage: 'x', component: 'core_test', eventType: 'retention_probe',
        createdAt: at(days), timeRead: read ? at(days) : null,
      }).returning();
      return row.id as string;
    }
    async function mkDispatch(days: number) {
      const [row] = await db.insert(notificationDispatchLog).values({
        userId: retentionUser, provider: 'retention_probe', channel: 'popup',
        status: 'delivered', subject: 'x', dedupeKey: `nb6-ret-${days}-${suffix}`,
        createdAt: at(days),
      }).returning();
      return row.id as string;
    }
    const readKept89 = await mkNote(89, true);
    const readKept90 = await mkNote(90, true);
    const readGone91 = await mkNote(91, true);
    const unreadKept179 = await mkNote(179, false);
    const unreadKept180 = await mkNote(180, false);
    const unreadGone181 = await mkNote(181, false);
    const dispatchKept89 = await mkDispatch(89);
    const dispatchKept90 = await mkDispatch(90);
    const dispatchGone91 = await mkDispatch(91);

    const result = await processor.sweep(now);
    expect(result.readDeleted).toBeGreaterThanOrEqual(1);
    expect(result.unreadDeleted).toBeGreaterThanOrEqual(1);
    expect(result.dispatchLogDeleted).toBeGreaterThanOrEqual(1);

    const remainingNotes = await db.select({ id: notifications.id }).from(notifications)
      .where(eq(notifications.userIdTo, retentionUser));
    const noteIds = new Set(remainingNotes.map((r: { id: string }) => r.id));
    expect(noteIds.has(readKept89)).toBe(true);
    expect(noteIds.has(readKept90)).toBe(true);
    expect(noteIds.has(readGone91)).toBe(false);
    expect(noteIds.has(unreadKept179)).toBe(true);
    expect(noteIds.has(unreadKept180)).toBe(true);
    expect(noteIds.has(unreadGone181)).toBe(false);

    const remainingDispatch = await db.select({ id: notificationDispatchLog.id })
      .from(notificationDispatchLog).where(eq(notificationDispatchLog.userId, retentionUser));
    const dispatchIds = new Set(remainingDispatch.map((r: { id: string }) => r.id));
    expect(dispatchIds.has(dispatchKept89)).toBe(true);
    expect(dispatchIds.has(dispatchKept90)).toBe(true);
    expect(dispatchIds.has(dispatchGone91)).toBe(false);
  });

  it('retention process run leaves a success task_log row', async () => {
    const processor = context.get(NotificationRetentionProcessor);
    await processor.process({ data: {} } as never);
    const rows = await db.select().from(taskLog)
      .where(and(eq(taskLog.taskName, 'notification-retention'), gte(taskLog.startedAt, startedAt)))
      .orderBy(desc(taskLog.startedAt));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].message).toContain('dispatch log');
  });
});
