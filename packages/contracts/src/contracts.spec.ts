import { describe, expect, it } from 'vitest';
import {
  badgeSchema, calendarEventSchema, conversationSchema, courseCategoryTreeSchema, courseContentSchema, courseGroupingSchema, enrolInstanceSchema,
  gradebookSchema, healthStatusSchema, issuedBadgeSchema, learningPlanSchema, loginResponseSchema, messagePreferenceSchema, noteSchema, notificationSchema, problemDetailsSchema,
  questionUsageSchema, ratingAggregateSchema, userCompetencySchema, userProfileSchema,
  createExternalTokenSchema, createPaymentSchema, createPrivacyRequestSchema, createReportSchema,
  paymentWebhookSchema, restoreCourseSchema,
  createGradeItemSchema, createGradeOutcomeSchema, gradeOutcomeSchema,
  richTextDocumentSchema, richTextInputSchema, toRichTextDocument, extractRichTextPlainText, emptyRichTextDocument,
  createQuestionSchema, updateQuestionSchema, questionViewSchema, questionVersionSchema,
  createStimulusSchema, updateStimulusSchema, stimulusViewSchema,
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
      id: '01900000-0000-7000-8000-000000000009', userIdTo: '01900000-0000-7000-8000-000000000003', subject: 'Badge awarded', fullMessage: 'You earned Finisher',
      eventType: 'badge_awarded', timeRead: null, createdAt: new Date().toISOString(),
    });
    expect(notif.timeRead).toBeNull();
    const pref = messagePreferenceSchema.parse({ provider: 'badge_awarded', component: 'core_badges', group: 'people', channel: 'popup', state: 'loggedin', enabled: true });
    expect(pref.enabled).toBe(true);
    expect(pref.group).toBe('people');
  });

  it('parses calendar events, badges and rejects impossible shapes', () => {
    const ev = calendarEventSchema.parse({
      id: '01900000-0000-7000-8000-000000000005', name: 'Deadline', eventType: 'course', timeStart: new Date().toISOString(),
      timeDuration: 3600, repeatId: '01900000-0000-7000-8000-000000000005', isException: false,
    });
    expect(ev.eventType).toBe('course');
    expect(() => calendarEventSchema.parse({ ...ev, eventType: 'global' })).toThrow();
    const badge = badgeSchema.parse({ id: '01900000-0000-7000-8000-000000000002', name: 'Finisher', type: 1, status: 1 });
    expect(badge.status).toBe(1);
    const issued = issuedBadgeSchema.parse({
      id: '01900000-0000-7000-8000-000000000003', badgeId: '01900000-0000-7000-8000-000000000002', userId: '01900000-0000-7000-8000-000000000007', uniqueHash: 'a'.repeat(64), dateIssued: new Date().toISOString(), dateExpire: null, revoked: false,
    });
    expect(issued.uniqueHash).toHaveLength(64);
  });

  it('parses learning plans, user competencies, rating aggregates and notes', () => {
    const plan = learningPlanSchema.parse({ id: '01900000-0000-7000-8000-000000000004', name: 'Plan A', userId: '01900000-0000-7000-8000-000000000007', templateId: null, status: 1 });
    expect(plan.status).toBe(1);
    const uc = userCompetencySchema.parse({ id: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000007', competencyId: '01900000-0000-7000-8000-000000000003', grade: 1, proficiency: true, status: 0 });
    expect(uc.proficiency).toBe(true);
    const agg = ratingAggregateSchema.parse({ count: 2, average: 2.5, sum: 5, min: 1, max: 4 });
    expect(agg.average).toBe(2.5);
    const note = noteSchema.parse({ id: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000007', courseId: '01900000-0000-7000-8000-000000000003', createdBy: '01900000-0000-7000-8000-000000000005', content: 'x', publishState: 'public' });
    expect(note.publishState).toBe('public');
    expect(() => noteSchema.parse({ ...note, publishState: 'custom' })).toThrow();
  });
});

describe('course contracts', () => {
  it('parses a nested category tree and a course content payload with a locked module', () => {
    const tree = courseCategoryTreeSchema.parse([
      {
        id: '01900000-0000-7000-8000-000000000001', name: 'Science', idNumber: null, description: '', parent: null, sortOrder: 0, path: '/1', depth: 1, visible: true,
        children: [{ id: '01900000-0000-7000-8000-000000000002', name: 'Physics', idNumber: null, description: '', parent: '01900000-0000-7000-8000-000000000001', sortOrder: 0, path: '/1/2', depth: 2, visible: true, children: [] }],
      },
    ]);
    expect(tree[0]?.children[0]?.name).toBe('Physics');
    const content = courseContentSchema.parse({
      course: {
        id: '01900000-0000-7000-8000-000000000010', category: '01900000-0000-7000-8000-000000000002', fullName: 'Physics 101', shortName: 'PHY101', idNumber: '', summary: '',
        format: 'topics', visible: true, startDate: null, endDate: null, groupMode: 0, enableCompletion: true,
      },
      contextId: '01900000-0000-7000-8000-000000000055', customFields: [],
      sections: [{
        id: '01900000-0000-7000-8000-000000000100', course: '01900000-0000-7000-8000-000000000010', section: 0, name: 'General', summary: '', visible: true, availability: null,
        modules: [{
          id: '01900000-0000-7000-8000-000000001001', course: '01900000-0000-7000-8000-000000000010', section: '01900000-0000-7000-8000-000000000100', component: 'mod_quiz', instanceId: '01900000-0000-7000-8000-000000000002', name: 'Locked quiz',
          visible: true, groupMode: 0, availability: null, completion: 2, completionView: true, completionManual: false,
          availabilityResult: { available: false, visible: true, failedDescriptions: ['Available from 2100'] },
        }],
      }],
    });
    expect(content.sections[0]?.modules[0]?.availabilityResult?.available).toBe(false);
    expect(enrolInstanceSchema.parse({
      id: '01900000-0000-7000-8000-000000000001', courseId: '01900000-0000-7000-8000-000000000010', enrol: 'cohort', status: 0, name: null, roleId: '01900000-0000-7000-8000-000000000005', customInt1: '01900000-0000-7000-8000-000000000003', customInt2: null, customText1: 'suspend', cost: 0, currency: '',
    }).enrol).toBe('cohort');
    expect(enrolInstanceSchema.parse({
      id: '01900000-0000-7000-8000-000000000001', courseId: '01900000-0000-7000-8000-000000000010', enrol: 'fee', status: 0, name: null, roleId: null, customInt1: null, customInt2: null, customText1: 'suspend', cost: 150000, currency: 'VND',
    }).cost).toBe(150000);
    expect(courseGroupingSchema.parse({
      id: '01900000-0000-7000-8000-000000000020', courseId: '01900000-0000-7000-8000-000000000010', name: 'Nhóm A', idNumber: 'GA', description: '',
    }).name).toBe('Nhóm A');
  });
});

describe('assessment contracts', () => {
  const item = {
    id: '01900000-0000-7000-8000-000000000005', courseId: '01900000-0000-7000-8000-000000000010', categoryId: '01900000-0000-7000-8000-000000000001', itemName: 'Quiz 1', itemType: 'manual', itemModule: null,
    itemInstance: null, gradeMax: 100, gradeMin: 0, gradePass: 50, weightOverride: false,
    aggregationCoef: 0, extraCredit: false, multiplicator: 1, plusFactor: 0, hidden: false, locked: false,
  };
  it('parses a gradebook tree with letters on grades and a course total', () => {
    const book = gradebookSchema.parse({
      courseId: '01900000-0000-7000-8000-000000000010', userId: '01900000-0000-7000-8000-000000000007',
      categories: [{
        category: {
          id: '01900000-0000-7000-8000-000000000001', courseId: '01900000-0000-7000-8000-000000000010', parent: null, fullName: '', aggregation: 'natural', dropLow: 0,
          keepHigh: 0, aggregateOnlyGraded: false, depth: 1, path: '/1', hidden: false,
        },
        total: {
          item: { ...item, id: '01900000-0000-7000-8000-000000000009', itemName: 'Course total', itemType: 'course', itemInstance: '01900000-0000-7000-8000-000000000010' },
          grade: {
            id: '01900000-0000-7000-8000-000000000003', itemId: '01900000-0000-7000-8000-000000000009', userId: '01900000-0000-7000-8000-000000000007', rawGrade: null, finalGrade: 100, hidden: false, locked: false,
            overridden: false, excluded: false, frozen: false, feedback: null, aggregationWeight: null, letter: 'B',
          },
        },
        items: [{
          item,
          grade: {
            id: '01900000-0000-7000-8000-000000000002', itemId: '01900000-0000-7000-8000-000000000005', userId: '01900000-0000-7000-8000-000000000007', rawGrade: 70, finalGrade: 70, hidden: false, locked: false,
            overridden: false, excluded: false, frozen: false, feedback: 'ok', aggregationWeight: 52.6, letter: null,
          },
        }],
        children: [],
      }],
      courseTotal: null,
    });
    expect(book.categories[0]?.total?.grade?.letter).toBe('B');
    expect(book.categories[0]?.items[0]?.grade?.finalGrade).toBe(70);
    expect(() => gradebookSchema.parse({ courseId: 'x' })).toThrow();
  });


  it('parses grade outcomes and calculated/outcome grade item payloads, and rejects bad shapes', () => {
    const outcome = gradeOutcomeSchema.parse({
      id: '01900000-0000-7000-8000-000000000020', courseId: null,
      scaleId: '01900000-0000-7000-8000-000000000021', name: 'Teamwork', description: '',
    });
    expect(outcome.courseId).toBeNull(); // site outcome
    expect(createGradeOutcomeSchema.parse({ name: 'Teamwork', scaleId: outcome.scaleId }).name).toBe('Teamwork');
    expect(() => createGradeOutcomeSchema.parse({ name: 'Teamwork' })).toThrow();
    const calc = createGradeItemSchema.parse({
      itemName: 'Average', itemType: 'calculated', idNumber: 'avg', calculation: '=average([[quiz1]],[[quiz2]])',
    });
    expect(calc.calculation).toContain('[[quiz1]]');
    const withOutcome = createGradeItemSchema.parse({ itemName: 'Outcome item', outcomeId: outcome.id });
    expect(withOutcome.outcomeId).toBe(outcome.id);
    expect(() => createGradeItemSchema.parse({ itemName: 'X', outcomeId: 'not-a-uuid' })).toThrow();
  });

  it('parses a question usage with attempts, pinned versions and steps', () => {
    const usage = questionUsageSchema.parse({
      usage: { id: '01900000-0000-7000-8000-000000000001', component: 'mod_quiz', instanceId: '01900000-0000-7000-8000-000000000003', preferredBehaviour: 'deferredfeedback' },
      state: 'finished',
      attempts: [{
        id: '01900000-0000-7000-8000-000000000011', questionUsageId: '01900000-0000-7000-8000-000000000001', slot: 1, behaviour: 'deferredfeedback', questionId: '01900000-0000-7000-8000-000000000004',
        questionVersionId: '01900000-0000-7000-8000-000000000008', maxMark: 1, state: 'gradedright', fraction: 1,
        steps: [
          { id: '01900000-0000-7000-8000-000000000001', sequenceNumber: 0, state: 'todo', fraction: null, data: {} },
          { id: '01900000-0000-7000-8000-000000000002', sequenceNumber: 1, state: 'complete', fraction: null, data: { answer: 'true' } },
          { id: '01900000-0000-7000-8000-000000000003', sequenceNumber: 2, state: 'gradedright', fraction: 1, data: {} },
        ],
      }],
    });
    expect(usage.attempts[0]?.questionVersionId).toBe('01900000-0000-7000-8000-000000000008');
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
      id: '01900000-0000-7000-8000-000000000002', username: 'u', firstName: 'F', lastName: 'L', suspended: false, deleted: false,
      isGuest: false, forcePasswordChange: false, lastLogin: null, createdAt: '2026-01-01T00:00:00.000Z',
      customFields: [{ shortName: 'dept', name: 'Dept', type: 'select', value: 'Sales' }],
    });
    expect(profile.email).toBeUndefined();
    expect(profile.customFields[0]?.value).toBe('Sales');
  });
});

describe('platform contracts (platform services)', () => {
  it('parses a search document and an external token creation (raw token only at creation)', async () => {
    const { searchDocumentSchema, externalTokenCreatedSchema } = await import('./platform.js');
    expect(searchDocumentSchema.parse({ id: '01900000-0000-7000-8000-000000000001', area: 'courses', itemId: '01900000-0000-7000-8000-000000000002', contextId: '01900000-0000-7000-8000-000000000003', title: 'T', content: 'C' }).area).toBe('courses');
    expect(externalTokenCreatedSchema.parse({ token: 'a'.repeat(64), id: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000002', serviceId: '01900000-0000-7000-8000-000000000003' }).token).toHaveLength(64);
    expect(() => externalTokenCreatedSchema.parse({ token: 'short', id: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000002', serviceId: '01900000-0000-7000-8000-000000000003' })).toThrow();
  });

  it('rejects a backup id mapping that keeps the original id, and a payment with a float amount', async () => {
    const { backupIdMappingSchema, paymentSchema } = await import('./platform.js');
    expect(backupIdMappingSchema.parse({ id: '01900000-0000-7000-8000-000000000001', jobId: '01900000-0000-7000-8000-000000000002', itemType: 'cm', oldId: '01900000-0000-7000-8000-000000000010', newId: '01900000-0000-7000-8000-000000000099' }).newId).toBe('01900000-0000-7000-8000-000000000099');
    expect(() => backupIdMappingSchema.parse({ id: '01900000-0000-7000-8000-000000000001', jobId: '01900000-0000-7000-8000-000000000002', itemType: 'cm', oldId: '01900000-0000-7000-8000-000000000010', newId: '01900000-0000-7000-8000-000000000010' })).toThrow();
    expect(() => paymentSchema.parse({ id: '01900000-0000-7000-8000-000000000001', accountId: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000001', amount: 10.5, currency: 'VND', status: 'pending', gateway: 'manual' })).toThrow();
    expect(paymentSchema.parse({ id: '01900000-0000-7000-8000-000000000001', accountId: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000001', amount: 50000, currency: 'VND', status: 'succeeded', gateway: 'manual' }).amount).toBe(50000);
  });

  it('parses report, content bank, insight and privacy request shapes', async () => {
    const { reportSchema, contentBankContentSchema, insightSchema, privacyRequestSchema } = await import('./platform.js');
    expect(reportSchema.parse({ id: '01900000-0000-7000-8000-000000000001', name: 'R', dataSource: 'grades', columns: ['userId'], createdBy: '01900000-0000-7000-8000-000000000001' }).dataSource).toBe('grades');
    expect(contentBankContentSchema.parse({ id: '01900000-0000-7000-8000-000000000001', name: 'C', contentType: 'file-based', contextId: '01900000-0000-7000-8000-000000000002', creatorId: '01900000-0000-7000-8000-000000000003', visibility: 'draft', fileId: null }).visibility).toBe('draft');
    expect(insightSchema.parse({ id: '01900000-0000-7000-8000-000000000001', modelId: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000002', recipientId: '01900000-0000-7000-8000-000000000003', contextId: '01900000-0000-7000-8000-000000000004', courseId: '01900000-0000-7000-8000-000000000005', heading: 'Student at risk' }).heading).toContain('risk');
    expect(privacyRequestSchema.parse({ id: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000002', type: 'delete', status: 'pending' }).type).toBe('delete');
    expect(() => privacyRequestSchema.parse({ id: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000002', type: 'merge', status: 'pending' })).toThrow();
  });
});

describe('platform request schemas (Zod — single source of truth for API and React forms)', () => {
  it('rejects a non-integer or non-positive payment amount and unknown fields', () => {
    expect(createPaymentSchema.safeParse({ accountId: '01900000-0000-7000-8000-000000000001', amount: 10.5, currency: 'VND' }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ accountId: '01900000-0000-7000-8000-000000000001', amount: 0, currency: 'VND' }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ accountId: '01900000-0000-7000-8000-000000000001', amount: 1000, currency: 'VND' }).success).toBe(true);
    expect(createPaymentSchema.safeParse({ accountId: '01900000-0000-7000-8000-000000000001', amount: 1000, currency: 'VND', evil: 1 }).success).toBe(false);
  });

  it('accepts only the three explicit restore modes and the registered report datasources', () => {
    expect(restoreCourseSchema.safeParse({ backupJobId: '01900000-0000-7000-8000-000000000001', mode: 'merge', targetCourseId: '01900000-0000-7000-8000-000000000002' }).success).toBe(true);
    expect(restoreCourseSchema.safeParse({ backupJobId: '01900000-0000-7000-8000-000000000001', mode: 'overwrite' }).success).toBe(false);
    expect(createReportSchema.safeParse({ name: 'R', dataSource: 'grades' }).success).toBe(true);
    expect(createReportSchema.safeParse({ name: 'R', dataSource: 'users' }).success).toBe(false);
  });

  it('keeps the privacy self-service schema free of the admin-only userId field', () => {
    expect(createPrivacyRequestSchema.safeParse({ type: 'export' }).success).toBe(true);
    expect(createPrivacyRequestSchema.safeParse({ type: 'export', userId: '01900000-0000-7000-8000-000000000005' }).success).toBe(false);
    expect(createExternalTokenSchema.safeParse({ userId: '01900000-0000-7000-8000-000000000001', serviceId: '01900000-0000-7000-8000-000000000002' }).success).toBe(true);
    expect(paymentWebhookSchema.safeParse({ gateway: 'manual', externalTransactionId: 'x', paymentId: '01900000-0000-7000-8000-000000000001', status: 'succeeded' }).success).toBe(true);
  });
});

describe('rich text contracts', () => {
  const doc = {
    type: 'doc' as const,
    content: [
      { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Xin chào', marks: [{ type: 'bold' as const }] }] },
      { type: 'paragraph' as const },
    ],
  };

  it('accepts a plain-text document with basic marks and an empty paragraph', () => {
    const parsed = richTextDocumentSchema.parse(doc);
    expect(parsed.content[0]?.content?.[0]?.marks?.[0]?.type).toBe('bold');
    expect(richTextInputSchema.parse('chuỗi thuần')).toBe('chuỗi thuần');
    expect(richTextInputSchema.parse(doc)).toEqual(doc);
  });

  it('rejects nodes outside the plain-text slice (image, heading) and unknown marks', () => {
    expect(() => richTextDocumentSchema.parse({ type: 'doc', content: [{ type: 'image', attrs: { src: 'x.png' } }] })).toThrow();
    expect(() => richTextDocumentSchema.parse({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'T' }] }] })).toThrow();
    expect(() => richTextDocumentSchema.parse({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'highlight' }] }] }] })).toThrow();
    expect(() => richTextDocumentSchema.parse({ type: 'doc', content: [] })).toThrow();
  });

  it('wraps strings into a one-paragraph document and the empty string into the empty document', () => {
    expect(toRichTextDocument('Một cộng một bằng mấy?')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Một cộng một bằng mấy?' }] }],
    });
    expect(toRichTextDocument('')).toEqual(emptyRichTextDocument);
    expect(toRichTextDocument(doc)).toEqual(doc);
    expect(() => toRichTextDocument({ type: 'doc', content: [{ type: 'image' }] } as never)).toThrow();
  });

  it('extracts plain text joining paragraphs with newlines, empty paragraph as an empty line', () => {
    const multi = {
      type: 'doc' as const,
      content: [
        { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Dòng ' }, { type: 'text' as const, text: 'một' }] },
        { type: 'paragraph' as const },
        { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Dòng ba' }] },
      ],
    };
    expect(extractRichTextPlainText(multi)).toBe('Dòng một\n\nDòng ba');
    expect(extractRichTextPlainText(emptyRichTextDocument)).toBe('');
  });
});

describe('question payload contracts (Moodle qtypes + stimulus)', () => {
  const categoryId = '01900000-0000-7000-8000-000000000001';
  const stimulusId = '01900000-0000-7000-8000-000000000099';

  it('accepts a multichoice payload with answers and options, questionText as string or document', () => {
    const parsed = createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', name: 'Thủ đô', questionText: 'Thủ đô của Việt Nam là?',
      stimulusId,
      answers: [
        { text: 'Hà Nội', fraction: 1, feedback: 'Đúng' },
        { text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Huế' }] }] }, fraction: 0 },
      ],
      options: { single: true, shuffleAnswers: true, answerNumbering: 'abc', showNumCorrect: true, correctFeedback: 'Chính xác' },
    });
    expect(parsed.answers).toHaveLength(2);
    expect(parsed.options?.single).toBe(true);
    const withDocText = createQuestionSchema.parse({
      categoryId, qtype: 'essay', name: 'Tự luận',
      questionText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hãy phân tích...' }] }] },
      options: { responseFormat: 'editor', responseRequired: true, responseFieldLines: 15, minWordLimit: null, maxWordLimit: 500, graderInfo: 'Chấm theo rubric' },
    });
    expect(withDocText.options?.maxWordLimit).toBe(500);
  });

  it('keeps the legacy free-form answer payload working for truefalse and shortanswer', () => {
    const tf = createQuestionSchema.parse({
      categoryId, qtype: 'truefalse', name: 'Đúng sai', questionText: 'Trái đất quay quanh mặt trời.', answer: { correct: true },
    });
    expect(tf.answer).toEqual({ correct: true });
    const sa = createQuestionSchema.parse({
      categoryId, qtype: 'shortanswer', name: 'Điền đáp án', questionText: '2 + 2 = ?', answer: { answers: ['4', 'bốn'], casesensitive: false },
    });
    expect(sa.answer).toEqual({ answers: ['4', 'bốn'], casesensitive: false });
    expect(updateQuestionSchema.parse({ stimulusId: null }).stimulusId).toBeNull();
    expect(updateQuestionSchema.parse({ answers: [{ text: 'x', fraction: 0.5 }] }).answers).toHaveLength(1);
  });

  it('rejects an unknown qtype and unknown payload fields', () => {
    expect(() => createQuestionSchema.parse({ categoryId, qtype: 'matching', name: 'X', questionText: '?' })).toThrow();
    expect(() => createQuestionSchema.parse({ categoryId, qtype: 'essay', name: 'X', questionText: '?', evil: 1 })).toThrow();
    expect(() => createQuestionSchema.parse({ categoryId, qtype: 'multichoice', name: 'X', questionText: '?', options: { bogus: true } })).toThrow();
  });

  it('accepts stimulus create/update payloads and parses a stimulus view', () => {
    const created = createStimulusSchema.parse({ categoryId, content: 'Đọc đoạn văn sau và trả lời câu hỏi.' });
    expect(created.categoryId).toBe(categoryId);
    expect(updateStimulusSchema.parse({ content: { type: 'doc', content: [{ type: 'paragraph' }] } }).content).toBeDefined();
    const view = stimulusViewSchema.parse({
      id: stimulusId, categoryId: categoryId, createdBy: null,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Đoạn văn' }] }] },
    });
    expect(view.createdBy).toBeNull();
    expect(extractRichTextPlainText(view.content)).toBe('Đoạn văn');
  });
});

describe('question view contracts', () => {
  it('parses a question view whose version carries a Tiptap document, answers and options', () => {
    const questionText = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Thủ đô của Việt Nam là?' }] }] };
    const view = questionViewSchema.parse({
      question: { id: '01900000-0000-7000-8000-000000000004', category: '01900000-0000-7000-8000-000000000001', qtype: 'multichoice', name: 'Thủ đô' },
      entry: { id: '01900000-0000-7000-8000-000000000006', questionCategoryId: '01900000-0000-7000-8000-000000000001', questionId: '01900000-0000-7000-8000-000000000004', latestVersion: 1 },
      latestVersion: {
        id: '01900000-0000-7000-8000-000000000008', questionBankEntryId: '01900000-0000-7000-8000-000000000006', questionId: '01900000-0000-7000-8000-000000000004', version: 1,
        questionText, generalFeedback: null, guidance: null, defaultMark: 1, penalty: 0, stimulusId: '01900000-0000-7000-8000-000000000099',
      },
      answers: [
        { id: '01900000-0000-7000-8000-000000000011', questionVersionId: '01900000-0000-7000-8000-000000000008', answer: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hà Nội' }] }] }, fraction: 1, feedback: null, sortOrder: 0 },
        { id: '01900000-0000-7000-8000-000000000012', questionVersionId: '01900000-0000-7000-8000-000000000008', answer: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Huế' }] }] }, fraction: 0, feedback: null, sortOrder: 1 },
      ],
      options: { single: true, shuffleAnswers: false, answerNumbering: 'abc' },
      stimulus: {
        id: '01900000-0000-7000-8000-000000000099', categoryId: '01900000-0000-7000-8000-000000000001', createdBy: null,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Đoạn văn ngữ liệu' }] }] },
      },
    });
    expect(view.answers).toHaveLength(2);
    expect(view.latestVersion.questionText).toEqual(questionText);
    expect(view.latestVersion.stimulusId).toBe('01900000-0000-7000-8000-000000000099');
    expect(view.stimulus?.id).toBe('01900000-0000-7000-8000-000000000099');
    expect(extractRichTextPlainText(view.stimulus!.content)).toBe('Đoạn văn ngữ liệu');
    expect(questionViewSchema.parse({ ...view, stimulus: null }).stimulus).toBeNull();
  });

  it('rejects the old version shape (string questionText carrying answerdata)', () => {
    expect(() => questionVersionSchema.parse({
      id: '01900000-0000-7000-8000-000000000008', questionBankEntryId: '01900000-0000-7000-8000-000000000006', questionId: '01900000-0000-7000-8000-000000000004', version: 1,
      questionText: 'chuỗi cũ', defaultMark: 1, answerdata: { correct: true },
    })).toThrow();
  });
});
