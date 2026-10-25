import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { CalendarReminderProcessor } from '../src/processors/calendar-reminder.processor';
import { calendarEvents, notificationDispatchLog, notifications, pluginConfig } from '@lms/db-schema';
import { WorkerModule } from '../src/worker.module';

/**
 * NB-7 phía worker (issue #174): hàm luật phân phối dùng chung của
 * worker (`NotificationDeliveryService.deliverInApp`) cũng phải tôn
 * trọng chính sách admin cấp site — cùng thứ tự luật với notify() phía
 * API: chính sách admin TRƯỚC tuỳ chọn người dùng. Admin tắt một loại
 * → đường nền không phát, dispatch log ghi `skipped-admin-disabled`;
 * bật lại (hoặc không có ghi đè) → phát bình thường.
 */
describe('Worker NB-7: admin site policy gates background delivery', () => {
  let context: INestApplicationContext;
  let db: any;
  const suffix = (Date.now() % 100000) + 7;
  const uid = (slot: number) => `01970000-0000-7000-8000-${String(980000 + suffix * 10 + slot).padStart(12, '0')}`;
  const policyUser = uid(1);
  const freeUser = uid(2);

  async function mkUser(id: string, username: string) {
    await db.execute(sql`insert into users (id, username, email, first_name, last_name, suspended, deleted)
      values (${id}, ${username}, ${`${username}@x.io`}, 'Nb7', 'User', false, false)
      on conflict (id) do nothing`);
  }

  async function mkEvent(userId: string, name: string) {
    const [event] = await db.insert(calendarEvents).values({
      name, eventType: 'user', userId, timeStart: new Date(Date.now() + 3600_000),
    }).returning();
    return event.id as string;
  }

  async function setPolicy(value: string | null) {
    await db.delete(pluginConfig).where(and(
      eq(pluginConfig.plugin, 'notifications'),
      eq(pluginConfig.name, 'provider_calendar_reminder_enabled'),
      isNull(pluginConfig.tenantId),
    ));
    if (value !== null) {
      await db.insert(pluginConfig).values({
        plugin: 'notifications', name: 'provider_calendar_reminder_enabled', value, tenantId: null,
      });
    }
  }

  beforeAll(async () => {
    context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context.init();
    db = context.get(getDrizzleToken());
    await mkUser(policyUser, `nb7-policy-${suffix}`);
    await mkUser(freeUser, `nb7-free-${suffix}`);
  });

  afterAll(async () => {
    // Trả chính sách về mặc định (không ghi đè) cho các suite khác.
    await setPolicy(null);
    await context.close();
  });

  it('admin-disabled type: background delivery is skipped with a traceable log; re-enable restores delivery', async () => {
    const processor = context.get(CalendarReminderProcessor);
    await setPolicy('false');

    const eventId = await mkEvent(policyUser, `NB7 blocked exam ${suffix}`);
    const blocked = await processor.process({ data: { eventId, userId: policyUser, minutesBefore: 30 } } as never);
    expect(blocked.status).toBe('skipped-admin-disabled');
    const notes = await db.select().from(notifications)
      .where(and(eq(notifications.userIdTo, policyUser), eq(notifications.eventType, 'calendar_reminder')));
    expect(notes).toHaveLength(0);
    const logs = await db.select().from(notificationDispatchLog).where(and(
      eq(notificationDispatchLog.userId, policyUser),
      eq(notificationDispatchLog.provider, 'calendar_reminder'),
      eq(notificationDispatchLog.status, 'skipped-admin-disabled'),
    ));
    expect(logs.length).toBeGreaterThan(0);

    // Bật lại → cùng đường nền phát bình thường.
    await setPolicy('true');
    const event2 = await mkEvent(policyUser, `NB7 allowed exam ${suffix}`);
    const allowed = await processor.process({ data: { eventId: event2, userId: policyUser, minutesBefore: 30 } } as never);
    expect(allowed.status).toBe('notified');
    const notes2 = await db.select().from(notifications)
      .where(and(eq(notifications.userIdTo, policyUser), eq(notifications.eventType, 'calendar_reminder')));
    expect(notes2).toHaveLength(1);

    // Người dùng khác khi không còn ghi đè (xoá dòng) cũng phát bình thường.
    await setPolicy(null);
    const event3 = await mkEvent(freeUser, `NB7 default exam ${suffix}`);
    const dflt = await processor.process({ data: { eventId: event3, userId: freeUser, minutesBefore: 30 } } as never);
    expect(dflt.status).toBe('notified');
  });
});
