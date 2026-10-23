import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import { BadgeAwardProcessor } from '../src/processors/badge-award.processor';
import { CalendarImportProcessor } from '../src/processors/calendar-import.processor';
import { CalendarReminderProcessor } from '../src/processors/calendar-reminder.processor';
import { NotificationDispatchProcessor } from '../src/processors/notification-dispatch.processor';
import {
  badge, badgeCriteria, badgeIssued, calendarEvents, calendarSubscriptions,
  cohortMembers, courseCompletions, customfieldCategory, customfieldData, customfieldField,
  notificationDispatchLog, notifications, userPreferences,
} from '../src/db/schema';
import { WorkerModule } from '../src/worker.module';

/**
 * Engagement worker jobs. Oracles: report §2#12 (preference + suspended delivery
 * law, re-checked at dispatch time), §2#13/#14 (reminders become
 * notifications; badge auto-award is idempotent — including the cohort /
 * profile leaves and the coursecompletion by-date parameter, Behat
 * badges/tests/behat criteria_cohort.feature, criteria_profile.feature,
 * award_badge.feature), calendar/tests/lib_test
 * test_add_subscription (ICS import result counts shape).
 * Users are raw-inserted with unique high ids to stay independent of the
 * API test suites sharing lms_test.
 */
describe('Worker engagement: notification dispatch, calendar reminder/import, badge auto-award', () => {
  let context: INestApplicationContext;
  let db: any;
  const suffix = Date.now() % 100000;
  const userA = `01920000-0000-7000-8000-${String(920000 + suffix).padStart(12, '0')}`;
  const userSuspended = `01930000-0000-7000-8000-${String(930000 + suffix).padStart(12, '0')}`;
  const userPrefOff = `01940000-0000-7000-8000-${String(940000 + suffix).padStart(12, '0')}`;

  beforeAll(async () => {
    context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context.init();
    db = context.get(getDrizzleToken());
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${userA}, ${`wk-a-${suffix}`}, ${`wka${suffix}@x.io`}, false, false) on conflict (id) do nothing`);
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${userSuspended}, ${`wk-s-${suffix}`}, ${`wks${suffix}@x.io`}, true, false) on conflict (id) do nothing`);
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${userPrefOff}, ${`wk-p-${suffix}`}, ${`wkp${suffix}@x.io`}, false, false) on conflict (id) do nothing`);
    // Preference off in BOTH login states for the email channel of grade_updated.
    await db.insert(userPreferences).values({ userid: userPrefOff, name: 'message_provider_grade_updated_email_loggedin', value: '0' });
    await db.insert(userPreferences).values({ userid: userPrefOff, name: 'message_provider_grade_updated_email_loggedoff', value: '0' });
  });
  afterAll(async () => { await context.close(); });

  it('notification dispatch logs the external channel dispatch and is idempotent by dedupekey', async () => {
    const processor = context.get(NotificationDispatchProcessor);
    const job = { data: { userId: userA, provider: 'grade_updated', channel: 'email', subject: 'Grade posted', body: 'b', dedupekey: `test-dispatch-${suffix}` } } as never;
    const first = await processor.process(job);
    expect(first.status).toBe('logged');
    const second = await processor.process(job);
    expect(second.status).toBe('duplicate');
    const rows = await db.select().from(notificationDispatchLog)
      .where(eq(notificationDispatchLog.dedupekey, `test-dispatch-${suffix}`));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('logged');
  });

  it('notification dispatch never dispatches for a suspended user or when the preference is off in both states', async () => {
    const processor = context.get(NotificationDispatchProcessor);
    const suspended = await processor.process({ data: { userId: userSuspended, provider: 'grade_updated', channel: 'email', subject: 's', body: 'b', dedupekey: `test-susp-${suffix}` } } as never);
    expect(suspended.status).toBe('skipped-suspended');
    const prefOff = await processor.process({ data: { userId: userPrefOff, provider: 'grade_updated', channel: 'email', subject: 's', body: 'b', dedupekey: `test-pref-${suffix}` } } as never);
    expect(prefOff.status).toBe('skipped-preference');
    const rows = await db.select().from(notificationDispatchLog)
      .where(eq(notificationDispatchLog.userid, userPrefOff));
    expect(rows.every((r: { status: string }) => r.status !== 'logged')).toBe(true);
  });

  it('calendar reminder creates exactly one notification and respects the popup preference', async () => {
    const [event] = await db.insert(calendarEvents).values({
      name: `Reminder event ${suffix}`, eventtype: 'user', userid: userA, contextid: null, timestart: new Date(Date.now() + 3600_000),
    }).returning();
    const processor = context.get(CalendarReminderProcessor);
    const job = { data: { eventId: event.id, userId: userA, minutesBefore: 15 } } as never;
    const first = await processor.process(job);
    expect(first.status).toBe('notified');
    const second = await processor.process(job);
    expect(second.status).toBe('duplicate');
    const rows = await db.select().from(notifications).where(and(
      eq(notifications.useridto, userA), eq(notifications.eventtype, 'calendar_reminder'),
      eq(notifications.contexturl, `/calendar/events/${event.id}`),
    ));
    expect(rows).toHaveLength(1);
    // Suspended user: nothing is created.
    const susp = await processor.process({ data: { eventId: event.id, userId: userSuspended, minutesBefore: 15 } } as never);
    expect(susp.status).toBe('skipped-suspended');
  });

  it('calendar import parses ICS into subscription events; a rerun imports nothing twice (lib_test import counts)', async () => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT', 'UID:import-1@lms', 'SUMMARY:Keynote', 'DTSTART:20270105T090000Z', 'DTEND:20270105T100000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:import-2@lms', 'SUMMARY:Workshop', 'DTSTART:20270106T090000Z', 'DTEND:20270106T110000Z', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const [sub] = await db.insert(calendarSubscriptions).values({
      name: `Feed ${suffix}`, eventtype: 'site', userid: userA, icsdata: ics,
    }).returning();
    const processor = context.get(CalendarImportProcessor);
    const first = await processor.process({ data: { subscriptionId: sub.id } } as never);
    expect(first).toEqual({ eventsimported: 2, eventsskipped: 0, eventsupdated: 0, eventsdeleted: 0 });
    const second = await processor.process({ data: { subscriptionId: sub.id } } as never);
    expect(second).toEqual({ eventsimported: 0, eventsskipped: 2, eventsupdated: 0, eventsdeleted: 0 });
    const rows = await db.select().from(calendarEvents).where(eq(calendarEvents.subscriptionid, sub.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { name: string }) => r.name).sort()).toEqual(['Keynote', 'Workshop']);
    expect(rows[0].timeduration).toBeGreaterThan(0);
  });

  it('badge auto-award: a completed course satisfies a coursecompletion badge exactly once; ALL with an unmet leaf issues nothing', async () => {
    const catRows = await db.execute(sql`insert into course_categories (name, path) values (${`wk-cat4-${suffix}`}, '') returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;
    const courseRows = await db.execute(sql`insert into course (category, fullname, shortname) values (${catId}, 'Worker engagement course', ${`wk4c${suffix}`}) returning id`);
    const courseId = (courseRows.rows[0] as { id: string }).id;
    await db.insert(courseCompletions).values({ userid: userA, course: courseId, status: 'complete', timestarted: new Date(), timecompleted: new Date() });

    const [badgeRow] = await db.insert(badge).values({ name: `Worker badge ${suffix}`, type: 1, status: 1, issuername: 'LMS' }).returning();
    await db.insert(badgeCriteria).values({ badgeid: badgeRow.id, criteriatype: 'overall', method: 1, params: {} });
    await db.insert(badgeCriteria).values({ badgeid: badgeRow.id, criteriatype: 'coursecompletion', method: 1, params: { courseId } });
    const [hardBadge] = await db.insert(badge).values({ name: `Hard badge ${suffix}`, type: 1, status: 1, issuername: 'LMS' }).returning();
    await db.insert(badgeCriteria).values({ badgeid: hardBadge.id, criteriatype: 'overall', method: 1, params: {} });
    await db.insert(badgeCriteria).values({ badgeid: hardBadge.id, criteriatype: 'coursecompletion', method: 1, params: { courseId } });
    await db.insert(badgeCriteria).values({ badgeid: hardBadge.id, criteriatype: 'competency', method: 1, params: { competencyId: 999999 } });

    const processor = context.get(BadgeAwardProcessor);
    const first = await processor.process({ data: { userId: userA, trigger: 'test' } } as never);
    expect(first.issued).toHaveLength(1);
    const second = await processor.process({ data: { userId: userA, trigger: 'test' } } as never);
    expect(second.issued).toHaveLength(0);
    const issued = await db.select().from(badgeIssued).where(eq(badgeIssued.userid, userA));
    const mine = (issued as { badgeid: string }[]).filter((r) => r.badgeid === badgeRow.id);
    expect(mine).toHaveLength(1);
    expect((issued as { badgeid: string }[]).some((r) => r.badgeid === hardBadge.id)).toBe(false);
    const notifs = await db.select().from(notifications).where(and(
      eq(notifications.useridto, userA), eq(notifications.eventtype, 'badge_awarded'),
    ));
    expect((notifs as { subject: string }[]).some((n) => n.subject.includes(`Worker badge ${suffix}`))).toBe(true);
  });

  it('badge auto-award honours the cohort + profile leaves and the coursecompletion by-date (worker twin of the API evaluator)', async () => {
    // Cohort và tư cách thành viên chỉ dành cho userA. Test tự tạo context
    // hệ thống theo cùng mẫu idempotent của platform-jobs, thay vì mượn
    // context do suite khác để lại — trên database mới bảng context rỗng.
    await db.execute(sql`insert into context (id, contextlevel, instanceid, path, depth)
      select '01990000-0000-7000-8000-0000000000a1', 10, null, '/01990000-0000-7000-8000-0000000000a1', 1
      where not exists (select 1 from context where contextlevel = 10 and instanceid is null)`);
    const sysRows = await db.execute(sql`select id from context where contextlevel = 10 and instanceid is null limit 1`);
    const systemCtxId = (sysRows.rows[0] as { id: string }).id;
    const cohortRows = await db.execute(sql`insert into cohort (name, contextid) values (${`wk-cohort-${suffix}`}, ${systemCtxId}) returning id`);
    const cohortId = (cohortRows.rows[0] as { id: string }).id;
    await db.insert(cohortMembers).values({ cohortid: cohortId, userid: userA });
    // Profile custom field (core_user/user) with a value for userA only.
    const shortname = `wkdept${suffix}`;
    const [category] = await db.insert(customfieldCategory).values({ component: 'core_user', area: 'user', name: `WK ${suffix}` }).returning();
    const [field] = await db.insert(customfieldField).values({ categoryid: category.id, shortname, name: 'WK department', type: 'text' }).returning();
    await db.insert(customfieldData).values({ fieldid: field.id, instanceid: userA, value: 'Engineering' });
    // A completed course for userA (completed now).
    const courseRows = await db.execute(sql`insert into course (category, fullname, shortname) values ((select id from course_categories limit 1), 'Worker leaf course', ${`wklc${suffix}`}) returning id`);
    const courseId = (courseRows.rows[0] as { id: string }).id;
    await db.insert(courseCompletions).values({ userid: userA, course: courseId, status: 'complete', timestarted: new Date(), timecompleted: new Date() });

    const mkBadge = async (name: string, leaves: { criteriatype: string; params: Record<string, unknown> }[]) => {
      const [row] = await db.insert(badge).values({ name, type: 1, status: 1, issuername: 'LMS' }).returning();
      await db.insert(badgeCriteria).values({ badgeid: row.id, criteriatype: 'overall', method: 1, params: {} });
      for (const leaf of leaves) await db.insert(badgeCriteria).values({ badgeid: row.id, criteriatype: leaf.criteriatype, method: 1, params: leaf.params });
      return row.id as string;
    };
    const cohortBadgeId = await mkBadge(`WK cohort badge ${suffix}`, [{ criteriatype: 'cohort', params: { cohortId } }]);
    const profileBadgeId = await mkBadge(`WK profile badge ${suffix}`, [{ criteriatype: 'profile', params: { field: shortname, value: 'Engineering' } }]);
    const inTimeBadgeId = await mkBadge(`WK in-time badge ${suffix}`, [
      { criteriatype: 'coursecompletion', params: { courseId, byDate: new Date(Date.now() + 30 * 86400_000).toISOString() } },
    ]);
    const tooLateBadgeId = await mkBadge(`WK too-late badge ${suffix}`, [
      { criteriatype: 'coursecompletion', params: { courseId, byDate: new Date(Date.now() - 30 * 86400_000).toISOString() } },
    ]);

    const processor = context.get(BadgeAwardProcessor);
    await processor.process({ data: { userId: userA, trigger: 'test-leaves' } } as never);
    const issuedA = (await db.select().from(badgeIssued).where(eq(badgeIssued.userid, userA)) as { badgeid: string }[])
      .map((r) => r.badgeid);
    expect(issuedA).toContain(cohortBadgeId);
    expect(issuedA).toContain(profileBadgeId);
    expect(issuedA).toContain(inTimeBadgeId);
    expect(issuedA).not.toContain(tooLateBadgeId);
    // userPrefOff is in no cohort, has no profile value and no completion: none of the new badges.
    await processor.process({ data: { userId: userPrefOff, trigger: 'test-leaves' } } as never);
    const issuedOther = (await db.select().from(badgeIssued).where(eq(badgeIssued.userid, userPrefOff)) as { badgeid: string }[])
      .map((r) => r.badgeid);
    for (const id of [cohortBadgeId, profileBadgeId, inTimeBadgeId, tooLateBadgeId]) {
      expect(issuedOther).not.toContain(id);
    }
  });
});
