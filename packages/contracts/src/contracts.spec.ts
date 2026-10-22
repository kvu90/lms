import { describe, expect, it } from 'vitest';
import {
  courseCategoryTreeSchema, courseContentSchema, enrolInstanceSchema,
  healthStatusSchema, loginResponseSchema, problemDetailsSchema, userProfileSchema,
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
