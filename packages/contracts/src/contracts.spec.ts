import { describe, expect, it } from 'vitest';
import {
  badgeSchema, calendarEventSchema, conversationSchema, courseCategoryTreeSchema, courseContentSchema, courseGroupingSchema, enrolInstanceSchema,
  myActivityGradesSchema, courseActivityGridSchema, healthStatusSchema, issuedBadgeSchema, learningPlanSchema, loginResponseSchema, notificationPreferenceSchema, noteSchema, notificationSchema, problemDetailsSchema,
  questionUsageSchema, ratingAggregateSchema, userCompetencySchema, userProfileSchema,
  createExternalTokenSchema, createPaymentSchema, createPrivacyRequestSchema, createReportSchema,
  paymentWebhookSchema, restoreCourseSchema,
  createGradeItemSchema,
  richTextDocumentSchema, richTextInputSchema, toRichTextDocument, extractRichTextPlainText, emptyRichTextDocument,
  createQuestionSchema, updateQuestionSchema, questionViewSchema, questionVersionSchema,
  createStimulusSchema, updateStimulusSchema, stimulusViewSchema,
  searchMessagesQuerySchema, messageSearchResultSchema,
  updateConversationStateSchema, conversationMemberStateSchema, listConversationsQuerySchema,
  createExamMatrixCellSchema, createExamMatrixSchema, examMatrixCellViewSchema,
  conversationGroupTreeSchema,
  classOverviewSchema,
  classPublicViewSchema, classSchema, updateClassSchema,
} from './index.js';

describe('contracts', () => {
  it('validates a ProblemDetails payload', () => {
    const parsed = problemDetailsSchema.parse({
      type: 'about:blank', title: 'Not Found', status: 404, code: 'http.not_found',
    });
    expect(parsed.status).toBe(404);
  });

  it('ProblemDetails của ghi nhập ma trận bị từ chối mang lỗi cứng định vị (I-2, #233)', () => {
    // Luật nghiệp vụ của hình dạng: từ chối ghi phải mang đủ vị trí
    // (sheet/dòng/cột) + mã lỗi cho từng lỗi cứng để web hiển thị lại
    // bảng lỗi như bước xem trước — một lỗi thiếu mã là hình dạng sai.
    const parsed = problemDetailsSchema.parse({
      type: 'about:blank', title: 'Unprocessable Entity', status: 422, code: 'quiz.matrix_import_invalid',
      matrixImportIssues: [
        { sheet: 'Ma trận', row: 15, column: 'F', code: 'quiz.matrix_import_cell_value_invalid', message: 'Ô F15 phải là số nguyên ≥ 0.' },
        { sheet: null, row: null, column: null, code: 'quiz.matrix_import_matrix_empty', message: 'Ma trận rỗng.' },
      ],
    });
    expect(parsed.matrixImportIssues).toHaveLength(2);
    expect(parsed.matrixImportIssues![0]).toMatchObject({ row: 15, column: 'F' });
    expect(() => problemDetailsSchema.parse({
      type: 'about:blank', title: 'Unprocessable Entity', status: 422, code: 'quiz.matrix_import_invalid',
      matrixImportIssues: [{ sheet: 'Ma trận', row: 15, column: 'F', message: 'thiếu mã lỗi' }],
    })).toThrow();
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
    const conv = conversationSchema.parse({ id: '01900000-0000-7000-8000-000000000001', type: 2, name: 'Study group', members: ['01900000-0000-7000-8000-000000000002', '01900000-0000-7000-8000-000000000003', '01900000-0000-7000-8000-000000000004'], component: null, itemType: null, itemId: null });
    expect(conv.members).toHaveLength(3);
    const notif = notificationSchema.parse({
      id: '01900000-0000-7000-8000-000000000009', userIdTo: '01900000-0000-7000-8000-000000000003', subject: 'Badge awarded', fullMessage: 'You earned Finisher',
      eventType: 'badge_awarded', timeRead: null, createdAt: new Date().toISOString(),
    });
    expect(notif.timeRead).toBeNull();
    const pref = notificationPreferenceSchema.parse({
      provider: 'badge_awarded', component: 'core_badges', group: 'people',
      label: { vi: 'Huy hiệu mới', en: 'New badge' }, description: { vi: 'Khi bạn được trao một huy hiệu.', en: 'When you are awarded a badge.' },
      teacherOnly: false, mandatoryInApp: false, popupEnabled: true, emailFrequency: 'immediate', emailAvailable: false, siteEnabled: true,
    });
    expect(pref.popupEnabled).toBe(true);
    expect(pref.group).toBe('people');
    // NB-7: trường chính sách admin cấp site là một phần của hợp đồng
    // dòng tuỳ chọn — thiếu nó thì parse phải hỏng, để web không âm
    // thầm mất tín hiệu "admin đã tắt ở cấp site".
    expect(() =>
      notificationPreferenceSchema.parse({
        provider: 'badge_awarded', component: 'core_badges', group: 'people',
        label: { vi: 'Huy hiệu mới', en: 'New badge' }, description: { vi: 'Khi bạn được trao một huy hiệu.', en: 'When you are awarded a badge.' },
        teacherOnly: false, mandatoryInApp: false, popupEnabled: true, emailFrequency: 'immediate', emailAvailable: false,
      }),
    ).toThrow();
  });

  it('khoá hình dạng tìm tin trong conversation (M4): q bắt buộc có độ dài xác định, trần kết quả 50', () => {
    // Tìm tin chỉ tồn tại trong bề mặt nhắn tin: q rỗng bị schema
    // chặn ngay (tầng service còn chặn q toàn khoảng trắng bằng 400).
    expect(searchMessagesQuerySchema.parse({ q: 'học bài' })).toEqual({ q: 'học bài' });
    expect(() => searchMessagesQuerySchema.parse({ q: '' })).toThrow();
    expect(() => searchMessagesQuerySchema.parse({ q: 'x'.repeat(201) })).toThrow();
    expect(() => searchMessagesQuerySchema.parse({ q: 'ok', limit: 51 })).toThrow();
    const result = messageSearchResultSchema.parse({
      id: '01900000-0000-7000-8000-000000000001', conversationId: '01900000-0000-7000-8000-000000000002',
      userIdFrom: '01900000-0000-7000-8000-000000000003', seq: 7, excerpt: '…học bài…', createdAt: new Date().toISOString(),
    });
    expect(result.seq).toBe(7);
  });

  it('khoá hình dạng trạng thái hội thoại (M5): ba cờ độc lập từng phần, lạ bị chặn', () => {
    // PATCH state là TỪNG PHẦN: gửi một cờ thì chỉ cờ đó đổi — schema
    // giữ nguyên đúng các trường đã gửi, không tự điền cờ còn lại
    // (điền mặc định sẽ ghi đè trạng thái phía server khi client chỉ
    // định đổi một cờ).
    expect(updateConversationStateSchema.parse({ muted: true })).toEqual({ muted: true });
    expect(updateConversationStateSchema.parse({ pinned: false, archived: true })).toEqual({ pinned: false, archived: true });
    expect(updateConversationStateSchema.parse({})).toEqual({});
    // Giá trị không phải boolean và khoá lạ bị chặn ở biên hợp đồng.
    expect(() => updateConversationStateSchema.parse({ pinned: 'yes' })).toThrow();
    expect(() => updateConversationStateSchema.parse({ starred: true })).toThrow();
    // Query danh sách: archived chỉ nhận boolean thật.
    expect(listConversationsQuerySchema.parse({})).toEqual({});
    expect(listConversationsQuerySchema.parse({ archived: true })).toEqual({ archived: true });
    expect(() => listConversationsQuerySchema.parse({ archived: 'true' })).toThrow();
    // Hình dạng trạng thái trả về: cờ boolean suy từ mốc, mốc nullable.
    const state = conversationMemberStateSchema.parse({
      conversationId: '01900000-0000-7000-8000-000000000001', pinned: true, pinnedAt: new Date().toISOString(),
      archived: false, archivedAt: null, muted: false,
    });
    expect(state.pinned).toBe(true);
    expect(state.archivedAt).toBeNull();
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

  it('cây nhóm nhắn tin (MSG-T1): phân loại conversation bằng component/itemType/itemId và vai tại nút chỉ thuộc tập đã chốt', () => {
    // Phân loại KHÔNG đoán theo tên: chat khoá mang đúng cặp
    // core_course/course + itemId của khoá; hội thoại cá nhân thì cả
    // ba trường null. itemId không phải UUID thì schema từ chối.
    const courseChat = conversationSchema.parse({
      id: '01900000-0000-7000-8000-000000000001', type: 2, name: null, members: [],
      component: 'core_course', itemType: 'course', itemId: '01900000-0000-7000-8000-000000000003',
    });
    expect(courseChat.itemType).toBe('course');
    expect(() => conversationSchema.parse({ ...courseChat, itemId: 'khong-phai-uuid' })).toThrow();

    const tree = conversationGroupTreeSchema.parse({
      classes: [{
        classId: '01900000-0000-7000-8000-000000000010', name: 'Lớp 10A1', myRole: 'teaching',
        conversationId: null, unread: 3,
        courses: [{
          courseId: '01900000-0000-7000-8000-000000000003', name: 'Toán 10', myRole: 'teaching',
          conversationId: '01900000-0000-7000-8000-000000000001', unread: 3,
          groups: [{ groupId: '01900000-0000-7000-8000-000000000020', name: 'Tổ 1', myRole: 'staff', conversationId: null, unread: 0 }],
        }],
      }],
      coursesOutsideClasses: [],
      freeGroups: [{ conversationId: '01900000-0000-7000-8000-000000000030', name: 'Nhóm ôn thi', myRole: 'learning', unread: 0 }],
    });
    expect(tree.classes[0]!.courses[0]!.groups[0]!.conversationId).toBeNull();
    // Vai ngoài tập chốt (teaching/learning/staff) và unread âm đều bị từ chối.
    expect(() => conversationGroupTreeSchema.parse({ ...tree, freeGroups: [{ conversationId: '01900000-0000-7000-8000-000000000030', name: 'X', myRole: 'owner', unread: 0 }] })).toThrow();
    expect(() => conversationGroupTreeSchema.parse({ ...tree, freeGroups: [{ conversationId: '01900000-0000-7000-8000-000000000030', name: 'X', myRole: 'staff', unread: -1 }] })).toThrow();
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
    id: '01900000-0000-7000-8000-000000000005', courseId: '01900000-0000-7000-8000-000000000010', itemName: 'Quiz 1', itemType: 'mod', itemModule: 'mod_quiz',
    itemInstance: '01900000-0000-7000-8000-000000000003', gradeMax: 100, gradeMin: 0, gradePass: 50,
    multiplicator: 1, plusFactor: 0, hidden: false, locked: false, sortOrder: 0, postingPolicy: 'auto',
  };
  const grade = {
    id: '01900000-0000-7000-8000-000000000002', itemId: '01900000-0000-7000-8000-000000000005', userId: '01900000-0000-7000-8000-000000000007', rawGrade: 70, finalGrade: 70, hidden: false, locked: false,
    overridden: false, excluded: false, frozen: false, feedback: 'ok', aggregationWeight: null,
  };
  it('parses per-activity grades with publication states (no course total anywhere)', () => {
    const mine = myActivityGradesSchema.parse({
      courseId: '01900000-0000-7000-8000-000000000010', userId: '01900000-0000-7000-8000-000000000007',
      activities: [{ item, grade, publication: { policy: 'auto', published: true } }],
    });
    expect(mine.activities[0]?.grade?.finalGrade).toBe(70);
    expect(mine.activities[0]?.publication.published).toBe(true);
    expect(() => myActivityGradesSchema.parse({ courseId: 'x' })).toThrow();
  });

  it('parses the read-only student x activity grid for teachers', () => {
    const grid = courseActivityGridSchema.parse({
      courseId: '01900000-0000-7000-8000-000000000010',
      items: [item],
      publications: { [item.id]: { policy: 'manual', published: false } },
      rows: [{ userId: '01900000-0000-7000-8000-000000000007', displayName: 'Nguyễn Văn A', grades: { [item.id]: 70 } }],
    });
    expect(grid.rows[0]?.grades[item.id]).toBe(70);
    expect(grid.publications[item.id]?.published).toBe(false);
  });

  it('parses grade item payloads (manual/mod) and rejects shapes of the removed aggregate model', () => {
    const manual = createGradeItemSchema.parse({ itemName: 'Kiểm tra 15 phút', gradeMax: 10, multiplicator: 0.5 });
    expect(manual.multiplicator).toBe(0.5);
    // Mô hình tổng hợp đã gỡ (issue #224): strictObject từ chối các trường chết.
    expect(() => createGradeItemSchema.parse({ itemName: 'X', calculation: '=average([[a]])' })).toThrow();
    expect(() => createGradeItemSchema.parse({ itemName: 'X', outcomeId: '01900000-0000-7000-8000-000000000020' })).toThrow();
    expect(() => createGradeItemSchema.parse({ itemName: 'X', categoryId: '01900000-0000-7000-8000-000000000001' })).toThrow();
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

  it('matrix cells anchor a knowledge unit, never an outcome (issue #249, CV 7991)', () => {
    const nodeId = '01900000-0000-7000-8000-000000000030';
    const cell = createExamMatrixCellSchema.parse({
      curriculumNodeId: nodeId, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 2, cellScore: 2,
    });
    expect(cell.curriculumNodeId).toBe(nodeId);
    // Mô hình cũ neo YCCĐ ở ô đã bỏ hẳn: strictObject từ chối learningOutcomeId.
    expect(() => createExamMatrixCellSchema.parse({
      learningOutcomeId: nodeId, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 2, cellScore: 2,
    })).toThrow();
    const view = examMatrixCellViewSchema.parse({
      id: '01900000-0000-7000-8000-000000000031', matrixId: '01900000-0000-7000-8000-000000000032',
      curriculumNodeId: nodeId, cognitiveLevel: 'hieu', qtype: 'truefalse', questionCount: 1, cellScore: 4,
      minutes: null, tfScale: null, position: 1,
    });
    expect(view.curriculumNodeId).toBe(nodeId);
    // Phạm vi đã dạy của ma trận cũng theo ĐVK (scopeNodeIds), không theo YCCĐ.
    const matrix = createExamMatrixSchema.parse({
      name: 'Ma trận', subjectId: '01900000-0000-7000-8000-000000000033',
      curriculumId: '01900000-0000-7000-8000-000000000034', scopeNodeIds: [nodeId],
    });
    expect(matrix.scopeNodeIds).toEqual([nodeId]);
    expect(() => createExamMatrixSchema.parse({
      name: 'Ma trận', subjectId: '01900000-0000-7000-8000-000000000033',
      curriculumId: '01900000-0000-7000-8000-000000000034', scopeOutcomeIds: [nodeId],
    })).toThrow();
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
    expect(contentBankContentSchema.parse({ id: '01900000-0000-7000-8000-000000000001', name: 'C', contentType: 'file-based', contextId: '01900000-0000-7000-8000-000000000002', creatorId: '01900000-0000-7000-8000-000000000003', visibility: 'draft', fileId: null, resourceType: 'question_set', scope: 'org', spaceId: '01900000-0000-7000-8000-000000000004', subjectId: null, grade: 6, level: 'lower_secondary', curriculumNodeId: null, outcomeIds: null, questionCategoryId: null, externalUrl: null, description: null, keywords: null, targetAudience: null, lessonPosition: null, techFormat: null, sizeBytes: null, durationSeconds: null, language: 'vi', originalAuthor: null, sourceKind: null, sourceCitation: null, license: null, derivedFromId: null, reviewStatus: 'pending', reviewedBy: null, reviewNote: null, reviewChecklist: null }).reviewStatus).toBe('pending');
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

  it('rejects nodes outside the slice (heading, orderedList), malformed math/image and unknown marks', () => {
    expect(() => richTextDocumentSchema.parse({ type: 'doc', content: [{ type: 'image' }] })).toThrow();
    expect(() => richTextDocumentSchema.parse({ type: 'doc', content: [{ type: 'image', attrs: { src: '' } }] })).toThrow();
    expect(() => richTextDocumentSchema.parse({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'inlineMath' }] }] })).toThrow();
    expect(() => richTextDocumentSchema.parse({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'inlineMath', attrs: { latex: 'x', extra: 1 } }] }] })).toThrow();
    expect(() => richTextDocumentSchema.parse({ type: 'doc', content: [{ type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] })).toThrow();
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

  it('accepts a document with inline/block math, a bullet list and an image', () => {
    const rich = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph' as const,
          content: [
            { type: 'text' as const, text: 'Giải phương trình ' },
            { type: 'inlineMath' as const, attrs: { latex: 'x^2 - 1 = 0' } },
            { type: 'text' as const, text: ' sau đây.' },
          ],
        },
        { type: 'blockMath' as const, attrs: { latex: '\\frac{a}{b}' } },
        {
          type: 'bulletList' as const,
          content: [
            { type: 'listItem' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Bước một' }] }] },
            {
              type: 'listItem' as const,
              content: [
                { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Bước hai' }] },
                {
                  type: 'bulletList' as const,
                  content: [
                    { type: 'listItem' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Bước hai chấm một' }] }] },
                  ],
                },
              ],
            },
          ],
        },
        { type: 'image' as const, attrs: { src: 'file-123', alt: 'Đồ thị hàm số', title: null } },
      ],
    };
    expect(richTextDocumentSchema.parse(rich)).toEqual(rich);
    expect(richTextInputSchema.parse(rich)).toEqual(rich);
  });

  it('extracts plain text with math contributing its LaTeX and list items on their own lines', () => {
    const rich = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph' as const,
          content: [
            { type: 'text' as const, text: 'Hàm số ' },
            { type: 'inlineMath' as const, attrs: { latex: 'y = ax + b' } },
            { type: 'text' as const, text: ' là hàm bậc nhất.' },
          ],
        },
        { type: 'blockMath' as const, attrs: { latex: 'a \\neq 0' } },
        {
          type: 'bulletList' as const,
          content: [
            { type: 'listItem' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Mục một' }] }] },
            { type: 'listItem' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Mục hai' }] }] },
          ],
        },
        { type: 'image' as const, attrs: { src: 'file-9', alt: 'Hình minh hoạ' } },
        { type: 'image' as const, attrs: { src: 'file-10' } },
      ],
    };
    expect(extractRichTextPlainText(rich)).toBe(
      'Hàm số y = ax + b là hàm bậc nhất.\na \\neq 0\nMục một\nMục hai\nHình minh hoạ\n',
    );
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

describe('class overview contracts (CLASS-2, #184)', () => {
  const overview = {
    class: {
      id: '01900000-0000-7000-8000-0000000000c1', tenantId: '01900000-0000-7000-8000-0000000000a1',
      name: 'Lớp 10A1', code: '10A1', schoolYear: '2026-2027',
      ownerId: '01900000-0000-7000-8000-0000000000b1', cohortId: '01900000-0000-7000-8000-0000000000d1',
      allowSelfReport: true, joinCode: null, joinAutoApprove: false, onLeave: 'suspend', status: 'active',
      description: '', feeCost: null, feeCurrency: 'VND', feePaymentAccountId: null,
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    },
    viewerRole: 'member',
    canManageRoster: false,
    canShare: false,
    rosterCount: 32,
    courses: [{
      id: '01900000-0000-7000-8000-000000000010', category: '01900000-0000-7000-8000-000000000002',
      fullName: 'Toán 10', shortName: 'TOAN10', idNumber: '', summary: '', format: 'topics', visible: true,
      startDate: null, endDate: null, groupMode: 0, enableCompletion: true,
    }],
  };

  it('parses a member overview (dashboard theo vai của học sinh)', () => {
    const parsed = classOverviewSchema.parse(overview);
    expect(parsed.viewerRole).toBe('member');
    expect(parsed.courses[0]?.fullName).toBe('Toán 10');
    expect(parsed.rosterCount).toBe(32);
  });

  it('rejects a viewerRole outside the closed owner/staff/member set (vai lạ không được lọt vào dashboard)', () => {
    expect(() => classOverviewSchema.parse({ ...overview, viewerRole: 'teacher' })).toThrow();
    expect(() => classOverviewSchema.parse({ ...overview, viewerRole: 'admin' })).toThrow();
  });

  it('rejects a negative rosterCount (số học sinh của lớp không thể âm)', () => {
    expect(() => classOverviewSchema.parse({ ...overview, rosterCount: -1 })).toThrow();
  });
});

describe('class fee contracts (CLASS-3, #184)', () => {
  const classView = {
    id: '01900000-0000-7000-8000-0000000000c1', tenantId: '01900000-0000-7000-8000-0000000000a1',
    name: 'Lớp 10A1', code: '10A1', schoolYear: '2026-2027',
    ownerId: '01900000-0000-7000-8000-0000000000b1', cohortId: '01900000-0000-7000-8000-0000000000d1',
    allowSelfReport: true, joinCode: null, joinAutoApprove: false, onLeave: 'suspend', status: 'active',
    description: '', feeCost: 1500000, feeCurrency: 'VND', feePaymentAccountId: null,
    createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
  };

  it('parses a class view carrying the fee package (học phí là số nguyên đơn vị nhỏ nhất)', () => {
    const parsed = classSchema.parse(classView);
    expect(parsed.feeCost).toBe(1500000);
    expect(parsed.feeCurrency).toBe('VND');
    expect(parsed.feePaymentAccountId).toBeNull();
  });

  it('rejects a fractional feeCost (tiền không có phần lẻ ở đơn vị nhỏ nhất — cùng bất biến payments)', () => {
    expect(() => classSchema.parse({ ...classView, feeCost: 1500000.5 })).toThrow();
    expect(updateClassSchema.safeParse({ feeCost: 100.5 }).success).toBe(false);
  });

  it('rejects a negative fee in the update contract (đặt học phí âm là lỗi nhập liệu, tắt thu phí là null/0)', () => {
    expect(updateClassSchema.safeParse({ feeCost: -1 }).success).toBe(false);
    expect(updateClassSchema.safeParse({ feeCost: 0 }).success).toBe(true);
    expect(updateClassSchema.safeParse({ feeCost: null }).success).toBe(true);
    expect(updateClassSchema.safeParse({ feeCurrency: 'VND' }).success).toBe(true);
    expect(updateClassSchema.safeParse({ feeCurrency: 'VN' }).success).toBe(false);
  });

  it('parses the public package view and rejects unknown class status (gói công khai không mang trạng thái lạ)', () => {
    const pub = {
      classId: classView.id, name: classView.name, code: '10A1', schoolYear: '2026-2027',
      description: '', ownerName: 'Nguyễn Văn A', status: 'active',
      feeCost: 1500000, feeCurrency: 'VND', feeEnabled: true, isMember: false, canPurchase: true,
    };
    const parsed = classPublicViewSchema.parse(pub);
    expect(parsed.canPurchase).toBe(true);
    expect(() => classPublicViewSchema.parse({ ...pub, status: 'deleted' })).toThrow();
    expect(() => classPublicViewSchema.parse({ ...pub, feeCost: 1.5 })).toThrow();
  });
});
