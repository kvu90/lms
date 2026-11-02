import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from '@lms/db';
import { CalendarReminderProcessor } from '../../../src/processors/calendar-reminder.processor';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * NB-7 phía worker (issue #174): hàm luật phân phối dùng chung của
 * worker (`NotificationDeliveryService.deliverInApp`) cũng phải tôn
 * trọng chính sách admin cấp site — cùng thứ tự luật với notify() phía
 * API: chính sách admin TRƯỚC tuỳ chọn người dùng. Admin tắt một loại
 * → đường nền không phát, dispatch log ghi `skipped-admin-disabled`;
 * bật lại (hoặc không có ghi đè) → phát bình thường.
 *
 * Từ lát 2 của issue #294, spec này boot WorkerModule qua harness
 * role thường (`test/ordinary-worker-module.ts`): module chạy bằng
 * role NOSUPERUSER/NOBYPASSRLS như production, fixture và đọc kiểm
 * chứng đi qua kết nối quản trị của harness — khẳng định nghiệp vụ
 * của spec không đổi.
 */
describe('Worker NB-7: chính sách site của admin làm cổng gửi nền', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: any;
  const suffix = (Date.now() % 100000) + 7;
  const uid = (slot: number) => `01970000-0000-7000-8000-${String(980000 + suffix * 10 + slot).padStart(12, '0')}`;
  const policyUser = uid(1);
  const freeUser = uid(2);

  async function mkUser(id: string, username: string) {
    await sql`insert into users (id, username, email, first_name, last_name, suspended, deleted)
      values (${id}, ${username}, ${`${username}@x.io`}, 'Nb7', 'User', false, false)
      on conflict (id) do nothing`.execute(db);
  }

  async function mkEvent(userId: string, name: string) {
    const event = await db.insertInto('calendar_events').values({
      name, event_type: 'user', user_id: userId, time_start: new Date(Date.now() + 3600_000),
    }).returningAll().executeTakeFirstOrThrow();
    return event.id as string;
  }

  async function setPolicy(value: string | null) {
    await db.deleteFrom('plugin_config')
      .where('plugin', '=', 'notifications')
      .where('name', '=', 'provider_calendar_reminder_enabled')
      .where('tenant_id', 'is', null)
      .execute();
    if (value !== null) {
      await db.insertInto('plugin_config').values({
        plugin: 'notifications', name: 'provider_calendar_reminder_enabled', value, tenant_id: null,
      }).execute();
    }
  }

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    await mkUser(policyUser, `nb7-policy-${suffix}`);
    await mkUser(freeUser, `nb7-free-${suffix}`);
  });

  afterAll(async () => {
    // Trả chính sách về mặc định (không ghi đè) cho các suite khác.
    await setPolicy(null);
    await harness.close();
  });

  it('loại bị admin tắt: gửi nền bị bỏ qua kèm log truy vết được; bật lại thì khôi phục gửi', async () => {
    const processor = context.get(CalendarReminderProcessor);
    await setPolicy('false');

    const eventId = await mkEvent(policyUser, `NB7 blocked exam ${suffix}`);
    const blocked = await processor.process({ data: { eventId, userId: policyUser, minutesBefore: 30 } } as never);
    expect(blocked.status).toBe('skipped-admin-disabled');
    const notes = await db.selectFrom('notifications').selectAll()
      .where('user_id_to', '=', policyUser).where('event_type', '=', 'calendar_reminder')
      .execute();
    expect(notes).toHaveLength(0);
    const logs = await db.selectFrom('notification_dispatch_log').selectAll()
      .where('user_id', '=', policyUser)
      .where('provider', '=', 'calendar_reminder')
      .where('status', '=', 'skipped-admin-disabled')
      .execute();
    expect(logs.length).toBeGreaterThan(0);

    // Bật lại → cùng đường nền phát bình thường.
    await setPolicy('true');
    const event2 = await mkEvent(policyUser, `NB7 allowed exam ${suffix}`);
    const allowed = await processor.process({ data: { eventId: event2, userId: policyUser, minutesBefore: 30 } } as never);
    expect(allowed.status).toBe('notified');
    const notes2 = await db.selectFrom('notifications').selectAll()
      .where('user_id_to', '=', policyUser).where('event_type', '=', 'calendar_reminder')
      .execute();
    expect(notes2).toHaveLength(1);

    // Người dùng khác khi không còn ghi đè (xoá dòng) cũng phát bình thường.
    await setPolicy(null);
    const event3 = await mkEvent(freeUser, `NB7 default exam ${suffix}`);
    const dflt = await processor.process({ data: { eventId: event3, userId: freeUser, minutesBefore: 30 } } as never);
    expect(dflt.status).toBe('notified');
  });
});
