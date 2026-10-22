import { describe, expect, it } from 'vitest';
import {
  badgeSchema, calendarEventSchema, conversationSchema, courseCategoryTreeSchema, courseContentSchema, enrolInstanceSchema,
  gradebookSchema, healthStatusSchema, issuedBadgeSchema, learningPlanSchema, loginResponseSchema, messagePreferenceSchema, noteSchema, notificationSchema, problemDetailsSchema,
  questionUsageSchema, ratingAggregateSchema, userCompetencySchema, userProfileSchema,
  createExternalTokenSchema, createPaymentSchema, createPrivacyRequestSchema, createReportSchema,
  paymentWebhookSchema, restoreCourseSchema,
} from './index.js';

describe('contracts', () => {
  it('validates a ProblemDetails payload', () => {
    const parsed = problemDetailsSchema.parse({
      type: 'about:blank', title: 'Not Found', status: 404, code: 'http.not_found',
    });
    expect(parsed.status).toBe(404);
  });

  it('rejects an invalid health payload', () => {
    expect(() => healthStatusSchema.parse({ status: 'ok' })).toThrow();
  });

  it('validates a health payload', () => {
    const parsed = healthStatusSchema.parse({
      status: 'ok', timestamp: new Date().toISOString(),
      checks: { database: 'up', redis: 'up' },
    });
    expect(parsed.checks.database).toBe('up');
  });
});

describe('engagement contracts', () => {
  it('parses a conversation, a notification and a preference row', () => {
    const conv = conversationSchema.parse({ id: '01900000-0000-7000-8000-000000000001', type: 2, name: 'Study group', members: ['01900000-0000-7000-8000-000000000002', '01900000-0000-7000-8000-000000000003', '01900000-0000-7000-8000-000000000004'] });
    expect(conv.members).toHaveLength(3);
    const notif = notificationSchema.parse({
      id: '01900000-0000-7000-8000-000000000009', useridto: '01900000-0000-7000-8000-000000000003', subject: 'Badge awarded', fullmessage: 'You earned Finisher',
      eventtype: 'badge_awarded', timeread: null, timecreated: new Date().toISOString(),
    });
    expect(notif.timeread).toBeNull();
    const pref = messagePreferenceSchema.parse({ provider: 'badge_awarded', channel: 'popup', loggedin: true, loggedoff: false });
    expect(pref.loggedoff).toBe(false);
  });

  it('parses calendar events, badges and rejects impossible shapes', () => {
    const ev = calendarEventSchema.parse({
      id: '01900000-0000-7000-8000-000000000005', name: 'Deadline', eventtype: 'course', timestart: new Date().toISOString(),
      timeduration: 3600, repeatid: '01900000-0000-7000-8000-000000000005', isexception: false,
    });
    expect(ev.eventtype).toBe('course');
    expect(() => calendarEventSchema.parse({ ...ev, eventtype: 'global' })).toThrow();
    const badge = badgeSchema.parse({ id: '01900000-0000-7000-8000-000000000002', name: 'Finisher', type: 1, status: 1 });
    expect(badge.status).toBe(1);
    const issued = issuedBadgeSchema.parse({
      id: '01900000-0000-7000-8000-000000000003', badgeid: '01900000-0000-7000-8000-000000000002', userid: '01900000-0000-7000-8000-000000000007', uniquehash: 'a'.repeat(64), dateissued: new Date().toISOString(), dateexpire: null, revoked: false,
    });
    expect(issued.uniquehash).toHaveLength(64);
  });

  it('parses learning plans, user competencies, rating aggregates and notes', () => {
    const plan = learningPlanSchema.parse({ id: '01900000-0000-7000-8000-000000000004', name: 'Plan A', userid: '01900000-0000-7000-8000-000000000007', templateid: null, status: 1 });
    expect(plan.status).toBe(1);
    const uc = userCompetencySchema.parse({ id: '01900000-0000-7000-8000-000000000001', userid: '01900000-0000-7000-8000-000000000007', competencyid: '01900000-0000-7000-8000-000000000003', grade: 1, proficiency: true, status: 0 });
    expect(uc.proficiency).toBe(true);
    const agg = ratingAggregateSchema.parse({ count: 2, average: 2.5, sum: 5, min: 1, max: 4 });
    expect(agg.average).toBe(2.5);
    const note = noteSchema.parse({ id: '01900000-0000-7000-8000-000000000001', userid: '01900000-0000-7000-8000-000000000007', courseid: '01900000-0000-7000-8000-000000000003', createdby: '01900000-0000-7000-8000-000000000005', content: 'x', publishstate: 'public' });
    expect(note.publishstate).toBe('public');
    expect(() => noteSchema.parse({ ...note, publishstate: 'custom' })).toThrow();
  });
});

describe('course contracts', () => {
  it('parses a nested category tree and a course content payload with a locked module', () => {
    const tree = courseCategoryTreeSchema.parse([
      {
        id: '01900000-0000-7000-8000-000000000001', name: 'Science', idnumber: null, description: '', parent: null, sortorder: 0, path: '/1', depth: 1, visible: true,
        children: [{ id: '01900000-0000-7000-8000-000000000002', name: 'Physics', idnumber: null, description: '', parent: '01900000-0000-7000-8000-000000000001', sortorder: 0, path: '/1/2', depth: 2, visible: true, children: [] }],
      },
    ]);
    expect(tree[0]?.children[0]?.name).toBe('Physics');
    const content = courseContentSchema.parse({
      course: {
        id: '01900000-0000-7000-8000-000000000010', category: '01900000-0000-7000-8000-000000000002', fullname: 'Physics 101', shortname: 'PHY101', idnumber: '', summary: '',
        format: 'topics', visible: true, startdate: null, enddate: null, groupmode: 0, enablecompletion: true,
      },
      contextId: '01900000-0000-7000-8000-000000000055', customFields: [],
      sections: [{
        id: '01900000-0000-7000-8000-000000000100', course: '01900000-0000-7000-8000-000000000010', section: 0, name: 'General', summary: '', visible: true, availability: null,
        modules: [{
          id: '01900000-0000-7000-8000-000000001001', course: '01900000-0000-7000-8000-000000000010', section: '01900000-0000-7000-8000-000000000100', component: 'mod_quiz', instanceid: '01900000-0000-7000-8000-000000000002', name: 'Locked quiz',
          visible: true, groupmode: 0, availability: null, completion: 2, completionview: true,
          availabilityResult: { available: false, visible: true, failedDescriptions: ['Available from 2100'] },
        }],
      }],
    });
    expect(content.sections[0]?.modules[0]?.availabilityResult?.available).toBe(false);
    expect(enrolInstanceSchema.parse({
      id: '01900000-0000-7000-8000-000000000001', courseid: '01900000-0000-7000-8000-000000000010', enrol: 'cohort', status: 0, name: null, roleid: '01900000-0000-7000-8000-000000000005', customint1: '01900000-0000-7000-8000-000000000003', customint2: null, customtext1: 'suspend',
    }).enrol).toBe('cohort');
  });
});

describe('assessment contracts', () => {
  const item = {
    id: '01900000-0000-7000-8000-000000000005', courseid: '01900000-0000-7000-8000-000000000010', categoryid: '01900000-0000-7000-8000-000000000001', itemname: 'Quiz 1', itemtype: 'manual', itemmodule: null,
    iteminstance: null, grademax: 100, grademin: 0, gradepass: 50, weightoverride: false,
    aggregationcoef: 0, extracredit: false, multiplicator: 1, plusfactor: 0, hidden: false, locked: false,
  };
  it('parses a gradebook tree with letters on grades and a course total', () => {
    const book = gradebookSchema.parse({
      courseId: '01900000-0000-7000-8000-000000000010', userId: '01900000-0000-7000-8000-000000000007',
      categories: [{
        category: {
          id: '01900000-0000-7000-8000-000000000001', courseid: '01900000-0000-7000-8000-000000000010', parent: null, fullname: '', aggregation: 'natural', droplow: 0,
          keephigh: 0, aggregateonlygraded: false, depth: 1, path: '/1', hidden: false,
        },
        total: {
          item: { ...item, id: '01900000-0000-7000-8000-000000000009', itemname: 'Course total', itemtype: 'course', iteminstance: '01900000-0000-7000-8000-000000000010' },
          grade: {
            id: '01900000-0000-7000-8000-000000000003', itemid: '01900000-0000-7000-8000-000000000009', userid: '01900000-0000-7000-8000-000000000007', rawgrade: null, finalgrade: 100, hidden: false, locked: false,
            overridden: false, excluded: false, frozen: false, feedback: null, aggregationweight: null, letter: 'B',
          },
        },
        items: [{
          item,
          grade: {
            id: '01900000-0000-7000-8000-000000000002', itemid: '01900000-0000-7000-8000-000000000005', userid: '01900000-0000-7000-8000-000000000007', rawgrade: 70, finalgrade: 70, hidden: false, locked: false,
            overridden: false, excluded: false, frozen: false, feedback: 'ok', aggregationweight: 52.6, letter: null,
          },
        }],
        children: [],
      }],
      courseTotal: null,
    });
    expect(book.categories[0]?.total?.grade?.letter).toBe('B');
    expect(book.categories[0]?.items[0]?.grade?.finalgrade).toBe(70);
    expect(() => gradebookSchema.parse({ courseId: 'x' })).toThrow();
  });

  it('parses a question usage with attempts, pinned versions and steps', () => {
    const usage = questionUsageSchema.parse({
      usage: { id: '01900000-0000-7000-8000-000000000001', component: 'mod_quiz', instanceid: '01900000-0000-7000-8000-000000000003', preferredbehaviour: 'deferredfeedback' },
      state: 'finished',
      attempts: [{
        id: '01900000-0000-7000-8000-000000000011', questionusageid: '01900000-0000-7000-8000-000000000001', slot: 1, behaviour: 'deferredfeedback', questionid: '01900000-0000-7000-8000-000000000004',
        questionversionid: '01900000-0000-7000-8000-000000000008', maxmark: 1, state: 'gradedright', fraction: 1,
        steps: [
          { id: '01900000-0000-7000-8000-000000000001', sequencenumber: 0, state: 'todo', fraction: null, data: {} },
          { id: '01900000-0000-7000-8000-000000000002', sequencenumber: 1, state: 'complete', fraction: null, data: { answer: 'true' } },
          { id: '01900000-0000-7000-8000-000000000003', sequencenumber: 2, state: 'gradedright', fraction: 1, data: {} },
        ],
      }],
    });
    expect(usage.attempts[0]?.questionversionid).toBe('01900000-0000-7000-8000-000000000008');
    expect(usage.attempts[0]?.steps).toHaveLength(3);
  });
});

describe('identity contracts', () => {
  it('parses a login response and a profile without email (identity field hidden)', () => {
    expect(loginResponseSchema.parse({
      accessToken: 'a', refreshToken: 'r', expiresIn: 900,
      user: { id: '01900000-0000-7000-8000-000000000001', username: 'admin', forcePasswordChange: false },
    }).user.username).toBe('admin');
    const profile = userProfileSchema.parse({
      id: '01900000-0000-7000-8000-000000000002', username: 'u', firstname: 'F', lastname: 'L', suspended: false, deleted: false,
      isGuest: false, forcePasswordChange: false, lastlogin: null, timecreated: '2026-01-01T00:00:00.000Z',
      customFields: [{ shortname: 'dept', name: 'Dept', type: 'select', value: 'Sales' }],
    });
    expect(profile.email).toBeUndefined();
    expect(profile.customFields[0]?.value).toBe('Sales');
  });
});

describe('platform contracts (platform services)', () => {
  it('parses a search document and an external token creation (raw token only at creation)', async () => {
    const { searchDocumentSchema, externalTokenCreatedSchema } = await import('./platform.js');
    expect(searchDocumentSchema.parse({ id: '01900000-0000-7000-8000-000000000001', area: 'courses', itemid: '01900000-0000-7000-8000-000000000002', contextid: '01900000-0000-7000-8000-000000000003', title: 'T', content: 'C' }).area).toBe('courses');
    expect(externalTokenCreatedSchema.parse({ token: 'a'.repeat(64), id: '01900000-0000-7000-8000-000000000001', userid: '01900000-0000-7000-8000-000000000002', serviceid: '01900000-0000-7000-8000-000000000003' }).token).toHaveLength(64);
    expect(() => externalTokenCreatedSchema.parse({ token: 'short', id: '01900000-0000-7000-8000-000000000001', userid: '01900000-0000-7000-8000-000000000002', serviceid: '01900000-0000-7000-8000-000000000003' })).toThrow();
  });

  it('rejects a backup id mapping that keeps the original id, and a payment with a float amount', async () => {
    const { backupIdMappingSchema, paymentSchema } = await import('./platform.js');
    expect(backupIdMappingSchema.parse({ id: '01900000-0000-7000-8000-000000000001', jobid: '01900000-0000-7000-8000-000000000002', itemtype: 'cm', oldid: '01900000-0000-7000-8000-000000000010', newid: '01900000-0000-7000-8000-000000000099' }).newid).toBe('01900000-0000-7000-8000-000000000099');
    expect(() => backupIdMappingSchema.parse({ id: '01900000-0000-7000-8000-000000000001', jobid: '01900000-0000-7000-8000-000000000002', itemtype: 'cm', oldid: '01900000-0000-7000-8000-000000000010', newid: '01900000-0000-7000-8000-000000000010' })).toThrow();
    expect(() => paymentSchema.parse({ id: '01900000-0000-7000-8000-000000000001', accountid: '01900000-0000-7000-8000-000000000001', userid: '01900000-0000-7000-8000-000000000001', amount: 10.5, currency: 'VND', status: 'pending', gateway: 'manual' })).toThrow();
    expect(paymentSchema.parse({ id: '01900000-0000-7000-8000-000000000001', accountid: '01900000-0000-7000-8000-000000000001', userid: '01900000-0000-7000-8000-000000000001', amount: 50000, currency: 'VND', status: 'succeeded', gateway: 'manual' }).amount).toBe(50000);
  });

  it('parses report, content bank, insight and privacy request shapes', async () => {
    const { reportSchema, contentBankContentSchema, insightSchema, privacyRequestSchema } = await import('./platform.js');
    expect(reportSchema.parse({ id: '01900000-0000-7000-8000-000000000001', name: 'R', datasource: 'grades', columns: ['userId'], createdby: '01900000-0000-7000-8000-000000000001' }).datasource).toBe('grades');
    expect(contentBankContentSchema.parse({ id: '01900000-0000-7000-8000-000000000001', name: 'C', contenttype: 'file-based', contextid: '01900000-0000-7000-8000-000000000002', creatorid: '01900000-0000-7000-8000-000000000003', visibility: 'draft', fileid: null }).visibility).toBe('draft');
    expect(insightSchema.parse({ id: '01900000-0000-7000-8000-000000000001', modelid: '01900000-0000-7000-8000-000000000001', userid: '01900000-0000-7000-8000-000000000002', recipientid: '01900000-0000-7000-8000-000000000003', contextid: '01900000-0000-7000-8000-000000000004', courseid: '01900000-0000-7000-8000-000000000005', heading: 'Student at risk' }).heading).toContain('risk');
    expect(privacyRequestSchema.parse({ id: '01900000-0000-7000-8000-000000000001', userid: '01900000-0000-7000-8000-000000000002', type: 'delete', status: 'pending' }).type).toBe('delete');
    expect(() => privacyRequestSchema.parse({ id: '01900000-0000-7000-8000-000000000001', userid: '01900000-0000-7000-8000-000000000002', type: 'merge', status: 'pending' })).toThrow();
  });
});

describe('platform request schemas (Zod — single source of truth for API and React forms)', () => {
  it('rejects a non-integer or non-positive payment amount and unknown fields', () => {
    expect(createPaymentSchema.safeParse({ accountid: '01900000-0000-7000-8000-000000000001', amount: 10.5, currency: 'VND' }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ accountid: '01900000-0000-7000-8000-000000000001', amount: 0, currency: 'VND' }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ accountid: '01900000-0000-7000-8000-000000000001', amount: 1000, currency: 'VND' }).success).toBe(true);
    expect(createPaymentSchema.safeParse({ accountid: '01900000-0000-7000-8000-000000000001', amount: 1000, currency: 'VND', evil: 1 }).success).toBe(false);
  });

  it('accepts only the three explicit restore modes and the registered report datasources', () => {
    expect(restoreCourseSchema.safeParse({ backupJobId: '01900000-0000-7000-8000-000000000001', mode: 'merge', targetCourseId: '01900000-0000-7000-8000-000000000002' }).success).toBe(true);
    expect(restoreCourseSchema.safeParse({ backupJobId: '01900000-0000-7000-8000-000000000001', mode: 'overwrite' }).success).toBe(false);
    expect(createReportSchema.safeParse({ name: 'R', datasource: 'grades' }).success).toBe(true);
    expect(createReportSchema.safeParse({ name: 'R', datasource: 'users' }).success).toBe(false);
  });

  it('keeps the privacy self-service schema free of the admin-only userid field', () => {
    expect(createPrivacyRequestSchema.safeParse({ type: 'export' }).success).toBe(true);
    expect(createPrivacyRequestSchema.safeParse({ type: 'export', userid: '01900000-0000-7000-8000-000000000005' }).success).toBe(false);
    expect(createExternalTokenSchema.safeParse({ userid: '01900000-0000-7000-8000-000000000001', serviceid: '01900000-0000-7000-8000-000000000002' }).success).toBe(true);
    expect(paymentWebhookSchema.safeParse({ gateway: 'manual', externalTransactionId: 'x', paymentId: '01900000-0000-7000-8000-000000000001', status: 'succeeded' }).success).toBe(true);
  });
});
