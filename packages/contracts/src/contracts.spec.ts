import { describe, expect, it } from 'vitest';
import {
  badgeSchema, calendarEventSchema, conversationSchema, courseCategoryTreeSchema, courseContentSchema, enrolInstanceSchema,
  gradebookSchema, healthStatusSchema, issuedBadgeSchema, learningPlanSchema, loginResponseSchema, messagePreferenceSchema, noteSchema, notificationSchema, problemDetailsSchema,
  questionUsageSchema, ratingAggregateSchema, userCompetencySchema, userProfileSchema,
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

describe('engagement contracts (P4)', () => {
  it('parses a conversation, a notification and a preference row', () => {
    const conv = conversationSchema.parse({ id: 1, type: 2, name: 'Study group', members: [2, 3, 4] });
    expect(conv.members).toHaveLength(3);
    const notif = notificationSchema.parse({
      id: 9, useridto: 3, subject: 'Badge awarded', fullmessage: 'You earned Finisher',
      eventtype: 'badge_awarded', timeread: null, timecreated: new Date().toISOString(),
    });
    expect(notif.timeread).toBeNull();
    const pref = messagePreferenceSchema.parse({ provider: 'badge_awarded', channel: 'popup', loggedin: true, loggedoff: false });
    expect(pref.loggedoff).toBe(false);
  });

  it('parses calendar events, badges and rejects impossible shapes', () => {
    const ev = calendarEventSchema.parse({
      id: 5, name: 'Deadline', eventtype: 'course', timestart: new Date().toISOString(),
      timeduration: 3600, repeatid: 5, isexception: false,
    });
    expect(ev.eventtype).toBe('course');
    expect(() => calendarEventSchema.parse({ ...ev, eventtype: 'global' })).toThrow();
    const badge = badgeSchema.parse({ id: 2, name: 'Finisher', type: 1, status: 1 });
    expect(badge.status).toBe(1);
    const issued = issuedBadgeSchema.parse({
      id: 3, badgeid: 2, userid: 7, uniquehash: 'a'.repeat(64), dateissued: new Date().toISOString(), dateexpire: null, revoked: false,
    });
    expect(issued.uniquehash).toHaveLength(64);
  });

  it('parses learning plans, user competencies, rating aggregates and notes', () => {
    const plan = learningPlanSchema.parse({ id: 4, name: 'Plan A', userid: 7, templateid: null, status: 1 });
    expect(plan.status).toBe(1);
    const uc = userCompetencySchema.parse({ id: 1, userid: 7, competencyid: 3, grade: 1, proficiency: true, status: 0 });
    expect(uc.proficiency).toBe(true);
    const agg = ratingAggregateSchema.parse({ count: 2, average: 2.5, sum: 5, min: 1, max: 4 });
    expect(agg.average).toBe(2.5);
    const note = noteSchema.parse({ id: 1, userid: 7, courseid: 3, createdby: 5, content: 'x', publishstate: 'public' });
    expect(note.publishstate).toBe('public');
    expect(() => noteSchema.parse({ ...note, publishstate: 'custom' })).toThrow();
  });
});

describe('course contracts (P2)', () => {
  it('parses a nested category tree and a course content payload with a locked module', () => {
    const tree = courseCategoryTreeSchema.parse([
      {
        id: 1, name: 'Science', idnumber: null, description: '', parent: 0, sortorder: 0, path: '/1', depth: 1, visible: true,
        children: [{ id: 2, name: 'Physics', idnumber: null, description: '', parent: 1, sortorder: 0, path: '/1/2', depth: 2, visible: true, children: [] }],
      },
    ]);
    expect(tree[0]?.children[0]?.name).toBe('Physics');
    const content = courseContentSchema.parse({
      course: {
        id: 10, category: 2, fullname: 'Physics 101', shortname: 'PHY101', idnumber: '', summary: '',
        format: 'topics', visible: true, startdate: null, enddate: null, groupmode: 0, enablecompletion: true,
      },
      contextId: 55, customFields: [],
      sections: [{
        id: 100, course: 10, section: 0, name: 'General', summary: '', visible: true, availability: null,
        modules: [{
          id: 1001, course: 10, section: 100, component: 'mod_quiz', instanceid: 2, name: 'Locked quiz',
          visible: true, groupmode: 0, availability: null, completion: 2, completionview: true,
          availabilityResult: { available: false, visible: true, failedDescriptions: ['Available from 2100'] },
        }],
      }],
    });
    expect(content.sections[0]?.modules[0]?.availabilityResult?.available).toBe(false);
    expect(enrolInstanceSchema.parse({
      id: 1, courseid: 10, enrol: 'cohort', status: 0, name: null, roleid: 5, customint1: 3, customint2: 0, customtext1: 'suspend',
    }).enrol).toBe('cohort');
  });
});

describe('assessment contracts (P3)', () => {
  const item = {
    id: 5, courseid: 10, categoryid: 1, itemname: 'Quiz 1', itemtype: 'manual', itemmodule: null,
    iteminstance: 0, grademax: 100, grademin: 0, gradepass: 50, weightoverride: false,
    aggregationcoef: 0, extracredit: false, multiplicator: 1, plusfactor: 0, hidden: false, locked: false,
  };
  it('parses a gradebook tree with letters on grades and a course total', () => {
    const book = gradebookSchema.parse({
      courseId: 10, userId: 7,
      categories: [{
        category: {
          id: 1, courseid: 10, parent: null, fullname: '', aggregation: 'natural', droplow: 0,
          keephigh: 0, aggregateonlygraded: false, depth: 1, path: '/1', hidden: false,
        },
        total: {
          item: { ...item, id: 9, itemname: 'Course total', itemtype: 'course', iteminstance: 10 },
          grade: {
            id: 3, itemid: 9, userid: 7, rawgrade: null, finalgrade: 100, hidden: false, locked: false,
            overridden: false, excluded: false, frozen: false, feedback: null, aggregationweight: null, letter: 'B',
          },
        },
        items: [{
          item,
          grade: {
            id: 2, itemid: 5, userid: 7, rawgrade: 70, finalgrade: 70, hidden: false, locked: false,
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
      usage: { id: 1, component: 'mod_quiz', instanceid: 3, preferredbehaviour: 'deferredfeedback' },
      state: 'finished',
      attempts: [{
        id: 11, questionusageid: 1, slot: 1, behaviour: 'deferredfeedback', questionid: 4,
        questionversionid: 8, maxmark: 1, state: 'gradedright', fraction: 1,
        steps: [
          { id: 1, sequencenumber: 0, state: 'todo', fraction: null, data: {} },
          { id: 2, sequencenumber: 1, state: 'complete', fraction: null, data: { answer: 'true' } },
          { id: 3, sequencenumber: 2, state: 'gradedright', fraction: 1, data: {} },
        ],
      }],
    });
    expect(usage.attempts[0]?.questionversionid).toBe(8);
    expect(usage.attempts[0]?.steps).toHaveLength(3);
  });
});

describe('identity contracts (P1)', () => {
  it('parses a login response and a profile without email (identity field hidden)', () => {
    expect(loginResponseSchema.parse({
      accessToken: 'a', refreshToken: 'r', expiresIn: 900,
      user: { id: 1, username: 'admin', forcePasswordChange: false },
    }).user.username).toBe('admin');
    const profile = userProfileSchema.parse({
      id: 2, username: 'u', firstname: 'F', lastname: 'L', suspended: false, deleted: false,
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
    expect(searchDocumentSchema.parse({ id: 1, area: 'courses', itemid: 2, contextid: 3, title: 'T', content: 'C' }).area).toBe('courses');
    expect(externalTokenCreatedSchema.parse({ token: 'a'.repeat(64), id: 1, userid: 2, serviceid: 3 }).token).toHaveLength(64);
    expect(() => externalTokenCreatedSchema.parse({ token: 'short', id: 1, userid: 2, serviceid: 3 })).toThrow();
  });

  it('rejects a backup id mapping that keeps the original id, and a payment with a float amount', async () => {
    const { backupIdMappingSchema, paymentSchema } = await import('./platform.js');
    expect(backupIdMappingSchema.parse({ id: 1, jobid: 2, itemtype: 'cm', oldid: 10, newid: 99 }).newid).toBe(99);
    expect(() => backupIdMappingSchema.parse({ id: 1, jobid: 2, itemtype: 'cm', oldid: 10, newid: 10 })).toThrow();
    expect(() => paymentSchema.parse({ id: 1, accountid: 1, userid: 1, amount: 10.5, currency: 'VND', status: 'pending', gateway: 'manual' })).toThrow();
    expect(paymentSchema.parse({ id: 1, accountid: 1, userid: 1, amount: 50000, currency: 'VND', status: 'succeeded', gateway: 'manual' }).amount).toBe(50000);
  });

  it('parses report, content bank, insight and privacy request shapes', async () => {
    const { reportSchema, contentBankContentSchema, insightSchema, privacyRequestSchema } = await import('./platform.js');
    expect(reportSchema.parse({ id: 1, name: 'R', datasource: 'grades', columns: ['userId'], createdby: 1 }).datasource).toBe('grades');
    expect(contentBankContentSchema.parse({ id: 1, name: 'C', contenttype: 'file-based', contextid: 2, creatorid: 3, visibility: 'draft', fileid: null }).visibility).toBe('draft');
    expect(insightSchema.parse({ id: 1, modelid: 1, userid: 2, recipientid: 3, contextid: 4, courseid: 5, heading: 'Student at risk' }).heading).toContain('risk');
    expect(privacyRequestSchema.parse({ id: 1, userid: 2, type: 'delete', status: 'pending' }).type).toBe('delete');
    expect(() => privacyRequestSchema.parse({ id: 1, userid: 2, type: 'merge', status: 'pending' })).toThrow();
  });
});
