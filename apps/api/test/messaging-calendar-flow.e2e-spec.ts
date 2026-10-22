import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createP1TestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './p1-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './p2-helpers';
import { addGroupMember, createGroupViaApi, suspendUser } from './p4-helpers';

/**
 * P4 Messaging + Calendar flow tests.
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
 */
describe('P4 messaging & calendar', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createP1TestApp();
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

  it('conversations: two users exchange messages; unread counts track conversations and reading clears them (api_test mark_all_read)', async () => {
    const { a, b, aToken, bToken } = await twoUsers();
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [b.id] });
    expect(conv.status).toBe(201);
    const conversationId = conv.body.id as number;
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
    const messageId = sent.body.id as number;
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

  it('a suspended recipient receives neither messages nor notifications (§2#12 + P4 DoD)', async () => {
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

  it('notifications: provider dispatch honours (provider × channel × loggedin) preferences; disabling popup stores nothing (P4 DoD)', async () => {
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

  it('calendar group events are visible only to group members (and staff) of the course (P4 DoD)', async () => {
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
    const root = created.body.event as { id: number; rrule: string; repeatid: number };
    expect(root.rrule).toContain('FREQ=WEEKLY');
    expect(root.repeatid).toBe(root.id);
    const secondOccurrence = created.body.occurrences[1] as { id: number; timestart: string };

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
});
