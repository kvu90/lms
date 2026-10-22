import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { addGroupMember, createGroupViaApi, suspendUser } from './engagement-helpers';

/**
 * Messaging + Calendar flow tests.
 * Oracles (Moodle MOODLE_503_STABLE, read 2026-10-22):
 *  - public/message/tests/api_test.php: test_count_blocked_users,
 *    test_mark_all_read_for_user_touser(_with_fromuser), create_conversation
 *    individual/group types.
 *  - Report §2#12 invariants: message ≠ notification; a sent message is
 *    owned by core_message (sender cannot edit/delete); suspended or
 *    blocking users receive nothing; preferences gate dispatch per
 *    (provider × channel × loggedin/loggedoff).
 *  - public/calendar/tests/lib_test.php: test_add_subscription (ICS import
 *    counts), test_get_legacy_events_with_overrides (group-scoped
 *    visibility), test_update_subscription; report §2#13 visibility law.
 *  - public/calendar/tests/behat/export.feature: a user exports their
 *    calendar as an ICS file and via a secret export URL (calendar key);
 *    the file/URL carry only the events that user may see, and resetting
 *    the key kills the old URL.
 */
describe('Messaging & calendar', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  async function twoUsers() {
    const a = await createUserViaApi(app, admin);
    const b = await createUserViaApi(app, admin);
    const aLogin = await login(app, a.username, STRONG_PASSWORD);
    const bLogin = await login(app, b.username, STRONG_PASSWORD);
    return { a, b, aToken: aLogin.accessToken, bToken: bLogin.accessToken };
  }

  /**
   * Bộ phân tích ICS tối thiểu trong test — cùng quy ước với parser phía
   * worker (apps/worker/src/domain/ics.ts): tách VEVENT, đọc
   * UID/SUMMARY/DESCRIPTION/DTSTART/DTEND dạng UTC, gỡ escape \, và \n.
   * Dùng để chứng minh file export parse lại được (round-trip).
   */
  function parseExportedIcs(text: string) {
    const parseDate = (value: string) => new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
    const events: { uid: string; summary: string; description: string; start: Date; end?: Date }[] = [];
    let current: Record<string, string> | null = null;
    for (const rawLine of text.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim();
      if (line === 'BEGIN:VEVENT') { current = {}; continue; }
      if (line === 'END:VEVENT') {
        if (current?.DTSTART) {
          events.push({
            uid: current.UID ?? '', summary: current.SUMMARY ?? '', description: current.DESCRIPTION ?? '',
            start: parseDate(current.DTSTART), end: current.DTEND ? parseDate(current.DTEND) : undefined,
          });
        }
        current = null;
        continue;
      }
      if (!current) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).split(';')[0]!.toUpperCase();
      current[key] = line.slice(colon + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');
    }
    return events;
  }

  it('conversations: two users exchange messages; unread counts track conversations and reading clears them (api_test mark_all_read)', async () => {
    const { a, b, aToken, bToken } = await twoUsers();
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [b.id] });
    expect(conv.status).toBe(201);
    const conversationId = conv.body.id as string;
    // Re-creating the same individual conversation returns the same one.
    const again = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${bToken}`)
      .send({ type: 1, memberIds: [a.id] });
    expect(again.body.id).toBe(conversationId);

    const sent = await http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Hello from A' });
    expect(sent.status).toBe(201);
    await http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Second message' });

    const unreadB = await http(app).get('/api/v1/messages/unread-count').set('Authorization', `Bearer ${bToken}`);
    expect(unreadB.body.conversations).toBe(1);
    const view = await http(app).get(`/api/v1/messages/conversations/${conversationId}`).set('Authorization', `Bearer ${bToken}`);
    expect(view.body.messages).toHaveLength(2);
    expect(view.body.messages[0].fullmessage).toBe('Hello from A');

    await http(app).post(`/api/v1/messages/conversations/${conversationId}/read`).set('Authorization', `Bearer ${bToken}`).send({});
    const after = await http(app).get('/api/v1/messages/unread-count').set('Authorization', `Bearer ${bToken}`);
    expect(after.body.conversations).toBe(0);
    // The sender never counts their own messages as unread.
    const unreadA = await http(app).get('/api/v1/messages/unread-count').set('Authorization', `Bearer ${aToken}`);
    expect(unreadA.body.conversations).toBe(0);
  });

  it('a sent message is immutable: the sender cannot edit or delete it through the API (§2#12)', async () => {
    const { b, aToken } = await twoUsers();
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [b.id] });
    const sent = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Permanent words' });
    const messageId = sent.body.id as string;
    const patch = await http(app).patch(`/api/v1/messages/messages/${messageId}`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Edited!' });
    expect(patch.status).toBe(403);
    expect(patch.body.code).toBe('messaging.message_immutable');
    const del = await http(app).delete(`/api/v1/messages/messages/${messageId}`).set('Authorization', `Bearer ${aToken}`);
    expect(del.status).toBe(403);
    expect(del.body.code).toBe('messaging.message_immutable');
  });

  it('blocked contacts cannot send: the recipient block list stops delivery (api_test test_count_blocked_users)', async () => {
    const { a, b, aToken, bToken } = await twoUsers();
    const blocked = await http(app).post(`/api/v1/messages/contacts/${a.id}/block`).set('Authorization', `Bearer ${bToken}`).send({});
    expect(blocked.body.blocked).toContain(a.id);
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [b.id] });
    const sent = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'You should not get this' });
    expect(sent.status).toBe(403);
    expect(sent.body.code).toBe('messaging.contact_blocked');
    // Unblocking restores delivery.
    await http(app).delete(`/api/v1/messages/contacts/${a.id}/block`).set('Authorization', `Bearer ${bToken}`);
    const ok = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Now it works' });
    expect(ok.status).toBe(201);
  });

  it('a suspended recipient receives neither messages nor notifications (§2#12 DoD)', async () => {
    const { a, b, aToken, bToken } = await twoUsers();
    void bToken;
    await suspendUser(app, admin, b.id);
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [b.id] });
    const sent = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Anyone there?' });
    expect(sent.status).toBe(403);
    expect(sent.body.code).toBe('messaging.recipient_suspended');

    const notify = await http(app).post('/api/v1/notifications/send').set('Authorization', `Bearer ${admin}`)
      .send({ userId: b.id, provider: 'grade_updated', subject: 'Grade posted', body: 'Your grade is in' });
    expect(notify.status).toBe(201);
    expect(notify.body.skipped).toBe('suspended');
    expect(notify.body.notificationId).toBeNull();
    const bLogin = await login(app, a.username, STRONG_PASSWORD).catch(() => null);
    void bLogin;
    const listAsAdmin = await http(app).get('/api/v1/notifications/dispatch-log').set('Authorization', `Bearer ${admin}`);
    void listAsAdmin;
  });

  it('notifications: provider dispatch honours (provider × channel × loggedin) preferences; disabling popup stores nothing (DoD)', async () => {
    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    // Baseline: default preferences deliver the in-app notification.
    const first = await http(app).post('/api/v1/notifications/send').set('Authorization', `Bearer ${admin}`)
      .send({ userId: user.id, provider: 'badge_awarded', subject: 'Badge!', body: 'You earned a badge' });
    expect(first.body.channels.popup).toBe('delivered');
    expect(first.body.channels.email).toBe('queued');
    let list = await http(app).get('/api/v1/notifications').set('Authorization', `Bearer ${accessToken}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].eventtype).toBe('badge_awarded');
    // Notifications are NOT messages: no conversation was created.
    const convs = await http(app).get('/api/v1/messages/conversations').set('Authorization', `Bearer ${accessToken}`);
    expect(convs.body).toHaveLength(0);

    // Turn popup off for badge_awarded (loggedin): nothing is stored, the
    // dispatch log records the suppression, email stays queued.
    const pref = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${accessToken}`)
      .send({ provider: 'badge_awarded', channel: 'popup', state: 'loggedin', enabled: false });
    expect(pref.status).toBe(200);
    const second = await http(app).post('/api/v1/notifications/send').set('Authorization', `Bearer ${admin}`)
      .send({ userId: user.id, provider: 'badge_awarded', subject: 'Badge 2', body: 'Another badge' });
    expect(second.body.channels.popup).toBe('skipped-preference');
    expect(second.body.channels.email).toBe('queued');
    list = await http(app).get('/api/v1/notifications').set('Authorization', `Bearer ${accessToken}`);
    expect(list.body).toHaveLength(1);
    const log = await http(app).get('/api/v1/notifications/dispatch-log').set('Authorization', `Bearer ${accessToken}`);
    const entries = log.body as { provider: string; channel: string; status: string }[];
    expect(entries.some((e) => e.provider === 'badge_awarded' && e.channel === 'popup' && e.status === 'delivered')).toBe(true);
    expect(entries.some((e) => e.provider === 'badge_awarded' && e.channel === 'popup' && e.status === 'skipped-preference')).toBe(true);

    // Read flow: unread count drops after read-all.
    const unread = await http(app).get('/api/v1/notifications/unread-count').set('Authorization', `Bearer ${accessToken}`);
    expect(unread.body.unread).toBe(1);
    await http(app).post('/api/v1/notifications/read-all').set('Authorization', `Bearer ${accessToken}`).send({});
    const after = await http(app).get('/api/v1/notifications/unread-count').set('Authorization', `Bearer ${accessToken}`);
    expect(after.body.unread).toBe(0);
    // Preferences listing reflects the toggle.
    const prefs = await http(app).get('/api/v1/messages/preferences').set('Authorization', `Bearer ${accessToken}`);
    const popupPref = (prefs.body as { provider: string; channel: string; state: string; enabled: boolean }[])
      .find((p) => p.provider === 'badge_awarded' && p.channel === 'popup' && p.state === 'loggedin');
    expect(popupPref?.enabled).toBe(false);
  });

  it('calendar visibility: site events for all, user events owner-only, course events enrolled-only, category events for category learners', async () => {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    const outsider = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    const soon = new Date(Date.now() + 3600_000).toISOString();

    const site = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Site day', eventtype: 'site', timestart: soon });
    expect(site.status).toBe(201);
    const courseEv = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Course lecture', eventtype: 'course', courseid: course.id, timestart: soon });
    expect(courseEv.status).toBe(201);
    const catEv = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Category fair', eventtype: 'category', categoryid: category.id, timestart: soon });
    expect(catEv.status).toBe(201);
    const userEv = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${studentToken}`)
      .send({ name: 'My dentist', eventtype: 'user', timestart: soon });
    expect(userEv.status).toBe(201);

    const names = async (token: string) => {
      const res = await http(app).get('/api/v1/calendar/events').set('Authorization', `Bearer ${token}`);
      return (res.body as { name: string }[]).map((e) => e.name);
    };
    const studentNames = await names(studentToken);
    expect(studentNames).toContain('Site day');
    expect(studentNames).toContain('Course lecture');
    expect(studentNames).toContain('Category fair');
    expect(studentNames).toContain('My dentist');
    const outsiderNames = await names(outsiderToken);
    expect(outsiderNames).toContain('Site day');
    expect(outsiderNames).not.toContain('Course lecture');
    expect(outsiderNames).not.toContain('Category fair');
    expect(outsiderNames).not.toContain('My dentist');
  });

  it('calendar group events are visible only to group members (and staff) of the course (DoD)', async () => {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const member = await createUserViaApi(app, admin);
    const nonMember = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, member.id);
    await enrolUser(app, admin, course.id, instance.id, nonMember.id);
    const group = await createGroupViaApi(app, admin, course.id, 'Team Alpha');
    await addGroupMember(app, admin, course.id, group.id, member.id);
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const ev = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Alpha standup', eventtype: 'group', courseid: course.id, groupid: group.id, timestart: soon });
    expect(ev.status).toBe(201);

    const memberToken = (await login(app, member.username, STRONG_PASSWORD)).accessToken;
    const nonMemberToken = (await login(app, nonMember.username, STRONG_PASSWORD)).accessToken;
    const forMember = await http(app).get('/api/v1/calendar/events').query({ eventtype: 'group' }).set('Authorization', `Bearer ${memberToken}`);
    expect((forMember.body as { name: string }[]).map((e) => e.name)).toContain('Alpha standup');
    const forNonMember = await http(app).get('/api/v1/calendar/events').query({ eventtype: 'group' }).set('Authorization', `Bearer ${nonMemberToken}`);
    expect((forNonMember.body as { name: string }[]).map((e) => e.name)).not.toContain('Alpha standup');
  });

  it('calendar series: weekly repeat creates one series; an exception replaces its occurrence in listings', async () => {
    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const start = new Date(Date.now() + 86400_000);
    const created = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Weekly yoga', eventtype: 'user', timestart: start.toISOString(), repeat: { freq: 'WEEKLY', count: 3 } });
    expect(created.status).toBe(201);
    expect(created.body.occurrences).toHaveLength(3);
    const root = created.body.event as { id: string; rrule: string; repeatid: string };
    expect(root.rrule).toContain('FREQ=WEEKLY');
    expect(root.repeatid).toBe(root.id);
    const secondOccurrence = created.body.occurrences[1] as { id: string; timestart: string };

    const moved = new Date(new Date(secondOccurrence.timestart).getTime() + 7200_000).toISOString();
    const exception = await http(app).post(`/api/v1/calendar/events/${secondOccurrence.id}/exception`).set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Yoga (moved)', timestart: moved });
    expect(exception.status).toBe(201);
    expect(exception.body.isexception).toBe(true);

    const list = await http(app).get('/api/v1/calendar/events').query({ eventtype: 'user' }).set('Authorization', `Bearer ${accessToken}`);
    const names = (list.body as { name: string }[]).map((e) => e.name);
    expect(names.filter((n) => n === 'Weekly yoga')).toHaveLength(2); // occurrences 1 and 3
    expect(names).toContain('Yoga (moved)');
    // Deleting the root deletes the whole series.
    const del = await http(app).delete(`/api/v1/calendar/events/${root.id}`).set('Authorization', `Bearer ${accessToken}`);
    expect(del.body.seriesDeleted).toBe(4); // 3 occurrences + 1 exception
  });

  it('calendar subscriptions: creating one queues an ICS import; reminders can be scheduled for visible events', async () => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:sub-test-1@lms',
      'SUMMARY:Imported keynote', 'DTSTART:20270105T090000Z', 'DTEND:20270105T100000Z',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const sub = await http(app).post('/api/v1/calendar/subscriptions').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Conf feed', eventtype: 'site', icsdata: ics });
    expect(sub.status).toBe(201);
    const subs = await http(app).get('/api/v1/calendar/subscriptions').set('Authorization', `Bearer ${admin}`);
    expect((subs.body as { name: string }[]).some((s) => s.name === 'Conf feed')).toBe(true);

    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const ev = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Deadline', eventtype: 'user', timestart: new Date(Date.now() + 7200_000).toISOString() });
    const remind = await http(app).post(`/api/v1/calendar/events/${ev.body.event.id}/remind`).set('Authorization', `Bearer ${accessToken}`)
      .send({ minutesBefore: 30 });
    expect(remind.status).toBe(201);
    expect(remind.body.delayMs).toBeGreaterThan(0);
    // A stranger cannot remind themselves about someone else's private event.
    const stranger = await createUserViaApi(app, admin);
    const strangerToken = (await login(app, stranger.username, STRONG_PASSWORD)).accessToken;
    const forbidden = await http(app).post(`/api/v1/calendar/events/${ev.body.event.id}/remind`).set('Authorization', `Bearer ${strangerToken}`)
      .send({ minutesBefore: 30 });
    expect(forbidden.status).toBe(403);
  });

  it('calendar export (ICS download): only the events the exporter may see, in a parseable VCALENDAR (behat/export.feature)', async () => {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const member = await createUserViaApi(app, admin);
    const other = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, member.id);
    await enrolUser(app, admin, course.id, instance.id, other.id);
    const group = await createGroupViaApi(app, admin, course.id, 'Export Team');
    await addGroupMember(app, admin, course.id, group.id, member.id);
    const memberToken = (await login(app, member.username, STRONG_PASSWORD)).accessToken;
    const otherToken = (await login(app, other.username, STRONG_PASSWORD)).accessToken;
    const soon = new Date(Date.now() + 3600_000);
    const soonIso = soon.toISOString();

    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Export site day', eventtype: 'site', timestart: soonIso });
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Export course lecture', eventtype: 'course', courseid: course.id, timestart: soonIso });
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Export alpha standup', eventtype: 'group', courseid: course.id, groupid: group.id, timestart: soonIso });
    const dentist = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'Export my dentist', eventtype: 'user', timestart: soonIso, timeduration: 3600, description: 'Checkup, cleaning', location: 'Clinic' });
    expect(dentist.status).toBe(201);
    const dentistId = dentist.body.event.id as string;
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Export B secret plan', eventtype: 'user', timestart: soonIso });
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'Export later event', eventtype: 'user', timestart: new Date(Date.now() + 30 * 86400_000).toISOString() });
    const series = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'Export weekly series', eventtype: 'user', timestart: new Date(Date.now() + 1800_000).toISOString(), repeat: { freq: 'WEEKLY', count: 2 } });
    expect(series.status).toBe(201);

    // Download requires login.
    const anonymous = await http(app).get('/api/v1/calendar/export.ics');
    expect(anonymous.status).toBe(401);

    const download = await http(app).get('/api/v1/calendar/export.ics').set('Authorization', `Bearer ${memberToken}`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('text/calendar');
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['content-disposition']).toContain('.ics');
    expect(download.text).toContain('BEGIN:VCALENDAR');
    expect(download.text).toContain('VERSION:2.0');
    expect(download.text).toContain('END:VCALENDAR');

    // Round-trip through an ICS parser with the worker parser's conventions.
    const parsed = parseExportedIcs(download.text);
    const summaries = parsed.map((e) => e.summary);
    expect(summaries).toContain('Export site day');
    expect(summaries).toContain('Export course lecture');
    expect(summaries).toContain('Export alpha standup');
    expect(summaries).toContain('Export my dentist');
    expect(summaries).toContain('Export later event');
    // The other user's private event never leaks into my export.
    expect(summaries).not.toContain('Export B secret plan');
    // The series is exported as its materialised occurrences, one VEVENT each.
    expect(summaries.filter((n) => n === 'Export weekly series')).toHaveLength(2);
    // UID is stable per event id; DTEND = DTSTART + timeduration.
    const dentistParsed = parsed.find((e) => e.summary === 'Export my dentist')!;
    expect(dentistParsed.uid).toBe(`${dentistId}@lms`);
    expect(dentistParsed.start.getTime()).toBe(Math.floor(soon.getTime() / 1000) * 1000);
    expect(dentistParsed.end!.getTime() - dentistParsed.start.getTime()).toBe(3600_000);
    expect(dentistParsed.description).toBe('Checkup, cleaning');
    expect(download.text).toContain('DTSTAMP:');

    // The other enrolled user: sees site/course + own private event, but
    // NOT the group event (not a member) and NOT the member's private event.
    const otherDownload = await http(app).get('/api/v1/calendar/export.ics').set('Authorization', `Bearer ${otherToken}`);
    const otherSummaries = parseExportedIcs(otherDownload.text).map((e) => e.summary);
    expect(otherSummaries).toContain('Export site day');
    expect(otherSummaries).toContain('Export course lecture');
    expect(otherSummaries).toContain('Export B secret plan');
    expect(otherSummaries).not.toContain('Export alpha standup');
    expect(otherSummaries).not.toContain('Export my dentist');
    expect(otherSummaries).not.toContain('Export later event');

    // A from/to query narrows the export exactly like the listing.
    const ranged = await http(app).get('/api/v1/calendar/export.ics')
      .query({ from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 2 * 3600_000).toISOString() })
      .set('Authorization', `Bearer ${memberToken}`);
    const rangedSummaries = parseExportedIcs(ranged.text).map((e) => e.summary);
    expect(rangedSummaries).toContain('Export my dentist');
    expect(rangedSummaries).not.toContain('Export later event');
    expect(rangedSummaries.filter((n) => n === 'Export weekly series')).toHaveLength(1);
  });

  it('calendar export URL: a secret per-user token downloads without login; rotating or revoking it kills the old URL (behat/export.feature)', async () => {
    const { aToken, bToken } = await twoUsers();
    const soon = new Date(Date.now() + 3600_000).toISOString();
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${aToken}`)
      .send({ name: 'Token export A private', eventtype: 'user', timestart: soon });
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${bToken}`)
      .send({ name: 'Token export B private', eventtype: 'user', timestart: soon });

    // Creating a token requires login; the status endpoint starts empty.
    const anonymousCreate = await http(app).post('/api/v1/calendar/export-token').send({});
    expect(anonymousCreate.status).toBe(401);
    const before = await http(app).get('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`);
    expect(before.body.hasToken).toBe(false);

    const created = await http(app).post('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`).send({});
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    // A long random token — never a UUID, never the user's own id.
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(created.body.exportUrl).toBe(`/api/v1/calendar/export/${token}.ics`);

    // The token (or its hash) never appears in any other response.
    const status = await http(app).get('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`);
    expect(status.body.hasToken).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain(token);
    const listing = await http(app).get('/api/v1/calendar/events').set('Authorization', `Bearer ${aToken}`);
    expect(JSON.stringify(listing.body)).not.toContain(token);

    // The public URL works with no Authorization header at all and carries
    // only the token owner's visible events.
    const viaUrl = await http(app).get(created.body.exportUrl as string);
    expect(viaUrl.status).toBe(200);
    expect(viaUrl.headers['content-type']).toContain('text/calendar');
    const viaSummaries = parseExportedIcs(viaUrl.text).map((e) => e.summary);
    expect(viaSummaries).toContain('Token export A private');
    expect(viaSummaries).not.toContain('Token export B private');

    // A well-formed but unknown token is rejected.
    const unknown = await http(app).get(`/api/v1/calendar/export/${'0'.repeat(64)}.ics`);
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('calendar.export_token_invalid');

    // Rotating the token kills the old URL immediately; the new one works.
    const rotated = await http(app).post('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`).send({});
    expect(rotated.status).toBe(201);
    const newToken = rotated.body.token as string;
    expect(newToken).not.toBe(token);
    const oldUrl = await http(app).get(created.body.exportUrl as string);
    expect(oldUrl.status).toBe(401);
    expect(oldUrl.body.code).toBe('calendar.export_token_invalid');
    const newUrl = await http(app).get(rotated.body.exportUrl as string);
    expect(newUrl.status).toBe(200);
    expect(parseExportedIcs(newUrl.text).map((e) => e.summary)).toContain('Token export A private');

    // Revoking kills the current URL too, and the status reflects it.
    const revoked = await http(app).delete('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`);
    expect(revoked.body.revoked).toBe(true);
    const afterRevoke = await http(app).get(rotated.body.exportUrl as string);
    expect(afterRevoke.status).toBe(401);
    const afterStatus = await http(app).get('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`);
    expect(afterStatus.body.hasToken).toBe(false);
  });
});
