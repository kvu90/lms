import { describe, expect, it } from 'vitest';
import {
  badgeSchema, calendarEventSchema, conversationSchema, courseCategoryTreeSchema, courseContentSchema, courseGroupingSchema, createResourceSchema, enrolInstanceSchema, updateResourceSchema,
  myActivityGradesSchema, courseActivityGridSchema, healthStatusSchema, issuedBadgeSchema, learningPlanSchema, loginResponseSchema, notificationPreferenceSchema, noteSchema, notificationSchema, problemDetailsSchema,
  questionUsageSchema, ratingAggregateSchema, userCompetencySchema, userProfileSchema,
  createExternalTokenSchema, createPaymentSchema, createPrivacyRequestSchema, createReportSchema,
  paymentWebhookSchema, restoreCourseSchema,
  createGradeItemSchema,
  richTextDocumentSchema, richTextInputSchema, toRichTextDocument, extractRichTextPlainText, emptyRichTextDocument,
  createQuestionSchema, updateQuestionSchema, questionViewSchema, questionVersionSchema, questionAnswerViewSchema, questionAnswerKeyViewSchema,
  createStimulusSchema, updateStimulusSchema, stimulusViewSchema,
  mcpCreateQuestionInputSchema, mcpAnswerInputSchema, mcpBatchQuestionItemSchema, mcpStimulusQuestionItemSchema, mcpQuestionOptionsInputSchema,
  searchMessagesQuerySchema, messageSearchResultSchema, markNotificationsReadSchema,
  updateConversationStateSchema, conversationMemberStateSchema, listConversationsQuerySchema,
  createExamMatrixCellSchema, createExamMatrixSchema, examMatrixCellViewSchema,
  createExamContributionSchema, withdrawExamSchema, withdrawExamMatrixSchema,
  examMatrixViewSchema, examMatrixContributionViewSchema,
  mcpSubmitContributionInputSchema, mcpSubmitContributionOutputSchema,
  conversationGroupTreeSchema,
  classOverviewSchema,
  classListItemSchema,
  classPublicViewSchema, classSchema, updateClassSchema,
  createCouponSchema, purchasePlanSchema, updateCouponSchema,
  exportGradesSchema, exportGradesVneduSchema, gradeExportProviderSchema,
  createRefundSchema, paymentRefundStatusSchema, rejectRefundSchema, resolvePaymentReviewSchema, settleRefundSchema,
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

  it('khoá thân yêu cầu mark-read (R6-A2, #344): phạm vi chỉ nhận "all", thiếu hoặc lạ đều bị chặn', () => {
    // Phạm vi đánh dấu đã đọc nằm trong thân yêu cầu thay cho hậu tố
    // `-all` trong tên path cũ: chỉ `all` là phạm vi đã chốt — thiếu
    // scope, scope lạ hay scope dạng nhóm đều bị từ chối ở biên hợp
    // đồng, không suy diễn ngầm thành `all`.
    expect(markNotificationsReadSchema.parse({ scope: 'all' })).toEqual({ scope: 'all' });
    expect(() => markNotificationsReadSchema.parse({})).toThrow();
    expect(() => markNotificationsReadSchema.parse({ scope: 'group' })).toThrow();
    expect(() => markNotificationsReadSchema.parse({ scope: 'all', eventType: 'x' })).toThrow();
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
      canCreateFreeGroup: true,
    });
    expect(tree.classes[0]!.courses[0]!.groups[0]!.conversationId).toBeNull();
    // Cờ tạo nhóm tự do là trường BẮT BUỘC do server tính theo cổng
    // tạo nhóm (chỉ quản trị viên hệ thống/chủ trung tâm mới true):
    // thiếu cờ thì schema từ chối, tránh client tự suy quyền từ vai.
    expect(tree.canCreateFreeGroup).toBe(true);
    expect(() => conversationGroupTreeSchema.parse({ classes: [], coursesOutsideClasses: [], freeGroups: [] })).toThrow();
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

  it('chỉ cho phép URL tài nguyên ngoài dùng scheme http/https (gác XSS qua href của trang học)', () => {
    // URL https/http hợp lệ (kể cả đích nhúng video) đi qua nguyên vẹn
    // ở cả đường tạo lẫn đường sửa.
    expect(createResourceSchema.parse({
      sectionId: '01900000-0000-7000-8000-000000000100', name: 'Video bài giảng', kind: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', completionMode: 'none',
    }).url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(updateResourceSchema.parse({ url: 'http://example.com/tai-lieu' }).url).toBe('http://example.com/tai-lieu');
    // Scheme thực thi khi người xem bấm liên kết phải bị schema từ
    // chối — kể cả biến thể bọc khoảng trắng ở đầu và khác chữ hoa.
    for (const bad of [
      'javascript:alert(document.domain)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      '/duong-dan-tuong-doi',
      'example.com/khong-scheme',
    ]) {
      expect(createResourceSchema.safeParse({ sectionId: '01900000-0000-7000-8000-000000000100', name: 'Liên kết', kind: 'url', url: bad, completionMode: 'none' }).success).toBe(false);
      expect(updateResourceSchema.safeParse({ url: bad }).success).toBe(false);
    }
    // update cho phép url null (xoá nguồn URL khi chuyển loại) — hành
    // vi cũ không đổi.
    expect(updateResourceSchema.parse({ url: null }).url).toBeNull();
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
  it('accepts an empty TOTP setup payload and a 6-digit current code, rejects malformed codes and unknown fields', async () => {
    const { mfaTotpSetupSchema } = await import('./identity.js');
    // Thân không bắt buộc: client hiện tại gọi setup không kèm thân vẫn hợp lệ.
    expect(mfaTotpSetupSchema.parse(undefined)).toBeUndefined();
    expect(mfaTotpSetupSchema.parse({})).toEqual({});
    expect(mfaTotpSetupSchema.parse({ currentCode: '123456' })).toEqual({ currentCode: '123456' });
    // Mã hiện tại phải đúng khuôn mã TOTP 6 chữ số; trường lạ bị chặn (strict).
    expect(() => mfaTotpSetupSchema.parse({ currentCode: '12345' })).toThrow();
    expect(() => mfaTotpSetupSchema.parse({ currentCode: '12ab56' })).toThrow();
    expect(() => mfaTotpSetupSchema.parse({ currentCode: '123456', other: 'x' })).toThrow();
  });

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
    // Trạng thái chờ đối soát của pipeline VietQR/SePay (issue #189):
    // tiền về thiếu một trong ba điều kiện khớp thì payment mang
    // needs_review — schema phải parse được trạng thái này.
    expect(paymentSchema.parse({ id: '01900000-0000-7000-8000-000000000001', accountId: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000001', amount: 50000, currency: 'VND', status: 'needs_review', gateway: 'sepay' }).status).toBe('needs_review');
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

describe('question payload contracts (port giaokhoa: cờ đúng/sai, không tên, không tỉ trọng + stimulus)', () => {
  const categoryId = '01900000-0000-7000-8000-000000000001';
  const stimulusId = '01900000-0000-7000-8000-000000000099';
  const mcAnswers = [
    { text: 'Hà Nội', correct: true, feedback: 'Đúng' },
    { text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Huế' }] }] } },
    { text: 'Đà Nẵng' },
    { text: 'Cần Thơ' },
  ];

  it('accepts a multichoice payload: exactly 4 choices, exactly one correct, questionText as string or document', () => {
    const parsed = createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: 'Thủ đô của Việt Nam là?',
      stimulusId,
      answers: mcAnswers,
      options: { shuffleAnswers: true, answerNumbering: 'abc', correctFeedback: 'Chính xác' },
    });
    expect(parsed.answers).toHaveLength(4);
    expect(parsed.answers?.filter((a) => a.correct === true)).toHaveLength(1);
    expect(parsed.options?.shuffleAnswers).toBe(true);
    const withDocText = createQuestionSchema.parse({
      categoryId, qtype: 'essay',
      questionText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hãy phân tích...' }] }] },
      options: { responseFormat: 'editor', responseRequired: true, responseFieldLines: 15, minWordLimit: null, maxWordLimit: 500, graderInfo: 'Chấm theo rubric' },
      solution: { answer: 'Lời giải mẫu...' },
    });
    expect(withDocText.options?.maxWordLimit).toBe(500);
    expect(withDocText.solution).toEqual({ answer: 'Lời giải mẫu...' });
  });

  it('locks the multichoice answer shape: 4 choices with exactly one correct (D-3 + bỏ tỉ trọng)', () => {
    // Hai đáp án đúng -> từ chối (mô hình cũ cho tổng fraction, mô hình mới đúng MỘT đáp án đúng).
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: '?',
      answers: mcAnswers.map((a, i) => (i === 1 ? { ...a, correct: true } : a)),
    })).toThrow();
    // Không đáp án đúng nào -> từ chối.
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: '?',
      answers: mcAnswers.map((a) => ({ text: a.text })),
    })).toThrow();
    // 3 hoặc 5 lựa chọn -> từ chối (khoá đúng 4 như giaokhoa).
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: '?', answers: mcAnswers.slice(0, 3),
    })).toThrow();
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: '?', answers: [...mcAnswers, { text: 'Hải Phòng' }],
    })).toThrow();
    // Thiếu hẳn answers -> từ chối.
    expect(() => createQuestionSchema.parse({ categoryId, qtype: 'multichoice', questionText: '?' })).toThrow();
    // Tỉ trọng fraction trong đáp án -> từ chối (strictObject).
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: '?',
      answers: mcAnswers.map((a, i) => (i === 0 ? { text: a.text, fraction: 1 } : a)),
    })).toThrow();
  });

  it('locks truefalse to the TF-A cluster shape: stem + exactly 4 statements in the text, per-statement answers via solution (D-1)', () => {
    const tfDoc = (statementIds: string[]) => ({
      type: 'doc' as const,
      content: [
        { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Cho hình vuông ABCD. Xét các mệnh đề:' }] },
        {
          type: 'statementList' as const,
          content: statementIds.map((id, i) => ({
            type: 'statement' as const,
            attrs: { id },
            content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: `Mệnh đề ${i + 1}` }] }],
          })),
        },
      ],
    });
    const ids = ['s1', 's2', 's3', 's4'];
    const solution = { answers: ids.map((statementId, i) => ({ statementId, value: i % 2 === 0 })) };
    const tf = createQuestionSchema.parse({
      categoryId, qtype: 'truefalse', questionText: tfDoc(ids), solution,
    });
    expect(tf.answers).toBeUndefined();
    expect(tf.solution).toEqual(solution);
    // Thiếu một mệnh đề (3 ý) hoặc thừa (5 ý) -> từ chối: khoá đúng 4.
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'truefalse', questionText: tfDoc(ids.slice(0, 3)),
      solution: { answers: solution.answers.slice(0, 3) },
    })).toThrow();
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'truefalse', questionText: tfDoc([...ids, 's5']),
      solution: { answers: [...solution.answers, { statementId: 's5', value: true }] },
    })).toThrow();
    // Solution thiếu một ý / trỏ ý không có trong thân câu -> từ chối.
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'truefalse', questionText: tfDoc(ids),
      solution: { answers: solution.answers.slice(0, 3) },
    })).toThrow();
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'truefalse', questionText: tfDoc(ids),
      solution: { answers: [...solution.answers.slice(0, 3), { statementId: 's9', value: true }] },
    })).toThrow();
    // Thiếu hẳn solution -> từ chối (mỗi mệnh đề phải có đáp án Đ/S).
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'truefalse', questionText: tfDoc(ids),
    })).toThrow();
    // Đường hai phía cũ (answers Đúng/Sai) đã bỏ hẳn ở TF-A.
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'truefalse', questionText: 'Trái đất quay quanh mặt trời.',
      answers: [{ text: 'Đúng', correct: true }, { text: 'Sai' }],
    })).toThrow();
    // Thân câu dạng chuỗi thuần không mang được mệnh đề -> từ chối.
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'truefalse', questionText: 'Trái đất quay quanh mặt trời.', solution,
    })).toThrow();
    // statementList lạc vào thân câu của qtype khác -> từ chối.
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: tfDoc(ids), answers: mcAnswers,
    })).toThrow();
  });

  it('locks shortanswer to listed accepted answers only (no wildcard semantics, no partial answers)', () => {
    const sa = createQuestionSchema.parse({
      categoryId, qtype: 'shortanswer', questionText: '2 + 2 = ?',
      answers: [{ text: '4' }, { text: 'bốn' }],
      options: { useCase: false },
    });
    expect(sa.answers).toHaveLength(2);
    // Không có đáp án chấp nhận nào -> từ chối.
    expect(() => createQuestionSchema.parse({ categoryId, qtype: 'shortanswer', questionText: '?', answers: [] })).toThrow();
    expect(() => createQuestionSchema.parse({ categoryId, qtype: 'shortanswer', questionText: '?' })).toThrow();
    // Đáp án liệt kê mà đánh dấu không chấp nhận (correct: false) -> từ chối:
    // mọi đáp án liệt kê đều được chấp nhận, khớp chính xác sau chuẩn hoá (D-2).
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'shortanswer', questionText: '?', answers: [{ text: '4', correct: false }],
    })).toThrow();
    // Dạng payload cũ answer:{answers} đã bỏ hẳn.
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'shortanswer', questionText: '?', answer: { answers: ['4', 'bốn'], casesensitive: false },
    })).toThrow();
  });

  it('rejects answer rows on essay, a question name anywhere, and the removed multichoice options (D-5)', () => {
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'essay', questionText: '?', answers: [{ text: 'x' }],
    })).toThrow();
    // Câu hỏi không có trường tên (strictObject từ chối name ở tạo/sửa).
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: '?', name: 'Thủ đô', answers: mcAnswers,
    })).toThrow();
    expect(() => updateQuestionSchema.parse({ name: 'X' })).toThrow();
    // Options đã bỏ: single / showNumCorrect / partiallyCorrectFeedback.
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: '?', answers: mcAnswers, options: { single: true },
    })).toThrow();
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: '?', answers: mcAnswers, options: { showNumCorrect: true },
    })).toThrow();
    expect(() => createQuestionSchema.parse({
      categoryId, qtype: 'multichoice', questionText: '?', answers: mcAnswers, options: { partiallyCorrectFeedback: 'Gần đúng' },
    })).toThrow();
    // Payload sửa: đáp án mang fraction -> từ chối; stimulusId null gỡ gắn vẫn hợp lệ.
    expect(() => updateQuestionSchema.parse({ answers: [{ text: 'x', fraction: 0.5 }] })).toThrow();
    expect(updateQuestionSchema.parse({ stimulusId: null }).stimulusId).toBeNull();
    expect(updateQuestionSchema.parse({ answers: [{ text: 'x', correct: true }] }).answers).toHaveLength(1);
  });

  it('rejects an unknown qtype and unknown payload fields', () => {
    expect(() => createQuestionSchema.parse({ categoryId, qtype: 'matching', questionText: '?' })).toThrow();
    expect(() => createQuestionSchema.parse({ categoryId, qtype: 'essay', questionText: '?', evil: 1 })).toThrow();
    expect(() => createQuestionSchema.parse({ categoryId, qtype: 'multichoice', questionText: '?', answers: mcAnswers, options: { bogus: true } })).toThrow();
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
  it('parses a question view: no name, answers carry isCorrect, answerKey carries guidance + solution', () => {
    const questionText = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Thủ đô của Việt Nam là?' }] }] };
    const guidanceDoc = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Nhớ lại bản đồ hành chính' }] }] };
    const view = questionViewSchema.parse({
      question: { id: '01900000-0000-7000-8000-000000000004', category: '01900000-0000-7000-8000-000000000001', qtype: 'multichoice' },
      entry: { id: '01900000-0000-7000-8000-000000000006', questionCategoryId: '01900000-0000-7000-8000-000000000001', questionId: '01900000-0000-7000-8000-000000000004', latestVersion: 1 },
      latestVersion: {
        id: '01900000-0000-7000-8000-000000000008', questionBankEntryId: '01900000-0000-7000-8000-000000000006', questionId: '01900000-0000-7000-8000-000000000004', version: 1,
        questionText, generalFeedback: null, defaultMark: 1, penalty: 0, stimulusId: '01900000-0000-7000-8000-000000000099',
      },
      answers: [
        { id: '01900000-0000-7000-8000-000000000011', questionVersionId: '01900000-0000-7000-8000-000000000008', answer: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hà Nội' }] }] }, isCorrect: true, feedback: null, sortOrder: 0 },
        { id: '01900000-0000-7000-8000-000000000012', questionVersionId: '01900000-0000-7000-8000-000000000008', answer: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Huế' }] }] }, isCorrect: false, feedback: null, sortOrder: 1 },
      ],
      answerKey: { guidance: guidanceDoc, solution: { correctAnswerId: '01900000-0000-7000-8000-000000000011' } },
      options: { shuffleAnswers: false, answerNumbering: 'abc' },
      stimulus: {
        id: '01900000-0000-7000-8000-000000000099', categoryId: '01900000-0000-7000-8000-000000000001', createdBy: null,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Đoạn văn ngữ liệu' }] }] },
      },
    });
    expect(view.answers).toHaveLength(2);
    expect(view.answers.filter((a) => a.isCorrect)).toHaveLength(1);
    expect(view.answerKey.guidance).toEqual(guidanceDoc);
    expect(view.answerKey.solution).toEqual({ correctAnswerId: '01900000-0000-7000-8000-000000000011' });
    expect(view.latestVersion.questionText).toEqual(questionText);
    expect(view.latestVersion.stimulusId).toBe('01900000-0000-7000-8000-000000000099');
    expect(view.stimulus?.id).toBe('01900000-0000-7000-8000-000000000099');
    expect(extractRichTextPlainText(view.stimulus!.content)).toBe('Đoạn văn ngữ liệu');
    expect(questionViewSchema.parse({ ...view, stimulus: null }).stimulus).toBeNull();
    // Essay: answerKey.solution mang lời giải mẫu dạng tài liệu.
    const essayKey = questionAnswerKeyViewSchema.parse({
      guidance: null,
      solution: { answer: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lời giải mẫu' }] }] } },
    });
    expect(essayKey.solution).toBeDefined();
  });

  it('rejects the old view shapes: fraction answers, guidance on the version, missing answerKey', () => {
    // Đáp án kiểu cũ (fraction, không isCorrect) -> từ chối.
    expect(() => questionAnswerViewSchema.parse({
      id: '01900000-0000-7000-8000-000000000011', questionVersionId: '01900000-0000-7000-8000-000000000008',
      answer: { type: 'doc', content: [{ type: 'paragraph' }] }, fraction: 1, feedback: null, sortOrder: 0,
    })).toThrow();
    // guidance không còn là trường của version: parse version mang guidance thì guidance bị loại khỏi kết quả.
    const version = questionVersionSchema.parse({
      id: '01900000-0000-7000-8000-000000000008', questionBankEntryId: '01900000-0000-7000-8000-000000000006', questionId: '01900000-0000-7000-8000-000000000004', version: 1,
      questionText: { type: 'doc', content: [{ type: 'paragraph' }] }, generalFeedback: null,
      guidance: { type: 'doc', content: [{ type: 'paragraph' }] }, defaultMark: 1, penalty: 0, stimulusId: null,
    });
    expect('guidance' in version).toBe(false);
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

describe('class list item contracts (danh sách lớp kèm cờ quyền theo người gọi)', () => {
  const classView = {
    id: '01900000-0000-7000-8000-0000000000c1', tenantId: '01900000-0000-7000-8000-0000000000a1',
    name: 'Lớp 10A1', code: '10A1', schoolYear: '2026-2027',
    ownerId: '01900000-0000-7000-8000-0000000000b1', cohortId: '01900000-0000-7000-8000-0000000000d1',
    allowSelfReport: true, joinCode: null, joinAutoApprove: false, onLeave: 'suspend', status: 'active',
    description: '', feeCost: null, feeCurrency: 'VND', feePaymentAccountId: null,
    createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
  };

  it('parses a list item carrying the four caller capability flags (cờ hiển thị do server suy)', () => {
    const parsed = classListItemSchema.parse({ ...classView, canCreate: true, canUpdate: true, canDelete: false, canManageRoster: true });
    expect(parsed.canCreate).toBe(true);
    expect(parsed.canUpdate).toBe(true);
    expect(parsed.canDelete).toBe(false);
    expect(parsed.canManageRoster).toBe(true);
    // Mọi trường của ClassView gốc giữ nguyên trong hình dạng danh sách.
    expect(parsed.name).toBe('Lớp 10A1');
    expect(parsed.joinCode).toBeNull();
  });

  it('rejects a list item missing a flag (dòng danh sách thiếu cờ thì web không có căn cứ vẽ theo vai)', () => {
    expect(() => classListItemSchema.parse({ ...classView, canCreate: true, canUpdate: true, canDelete: true })).toThrow();
    expect(() => classListItemSchema.parse({ ...classView, canCreate: 'yes', canUpdate: true, canDelete: true, canManageRoster: true })).toThrow();
  });

  it('keeps plain ClassView free of the flags (chi tiết/tạo/sửa lớp không mang cờ danh sách)', () => {
    const parsed = classSchema.parse(classView);
    expect('canCreate' in parsed).toBe(false);
    expect('canManageRoster' in parsed).toBe(false);
  });
});

describe('mcp question contracts (biên AI: không fraction, không tên)', () => {
  const bankId = '01900000-0000-7000-8000-000000000050';
  const categoryId = '01900000-0000-7000-8000-000000000001';

  it('accepts a create_question input with correct-flag answers and no name', () => {
    const parsed = mcpCreateQuestionInputSchema.parse({
      bankId, categoryId, qtype: 'multichoice', questionText: 'Thủ đô của Việt Nam là?',
      answers: [
        { text: 'Hà Nội', correct: true },
        { text: 'Huế' },
        { text: 'Đà Nẵng' },
        { text: 'Cần Thơ' },
      ],
      idempotencyKey: 'key-1',
    });
    expect(parsed.answers?.filter((a) => a.correct === true)).toHaveLength(1);
  });

  it('rejects fraction on an MCP answer and a question name on MCP create/batch/stimulus inputs', () => {
    expect(() => mcpAnswerInputSchema.parse({ text: 'Hà Nội', fraction: 1 })).toThrow();
    expect(() => mcpCreateQuestionInputSchema.parse({
      bankId, categoryId, qtype: 'essay', name: 'Tự luận', questionText: '?', idempotencyKey: 'k',
    })).toThrow();
    expect(() => mcpBatchQuestionItemSchema.parse({
      clientItemId: 'i1', qtype: 'essay', name: 'Tự luận', questionText: '?',
    })).toThrow();
    expect(() => mcpStimulusQuestionItemSchema.parse({
      qtype: 'essay', name: 'Tự luận', questionText: '?',
    })).toThrow();
    // Options đã bỏ ở biên MCP (D-5): partiallyCorrectFeedback bị từ chối.
    expect(() => mcpQuestionOptionsInputSchema.parse({ partiallyCorrectFeedback: 'Gần đúng' })).toThrow();
    expect(() => mcpQuestionOptionsInputSchema.parse({ single: true })).toThrow();
  });
});

describe('bank sync contracts (issue #228: đóng góp đề khuôn QB-4 + truy vết rút + MCP đối xứng)', () => {
  const bankId = '01900000-0000-7000-8000-000000000050';
  const examId = '01900000-0000-7000-8000-000000000060';
  const matrixId = '01900000-0000-7000-8000-000000000070';
  const questionId = '01900000-0000-7000-8000-000000000080';

  it('createExamContributionSchema: mode chỉ nhận new/update, mode lạ và khoá lạ bị từ chối', () => {
    // Không gửi mode = mode 'new' ở tầng service (payload cũ nguyên vẹn).
    expect(createExamContributionSchema.parse({ examId }).examId).toBe(examId);
    const update = createExamContributionSchema.parse({ examId, mode: 'update', targetExamId: examId, withDossier: true });
    expect(update.mode).toBe('update');
    expect(update.targetExamId).toBe(examId);
    expect(update.withDossier).toBe(true);
    expect(() => createExamContributionSchema.parse({ examId, mode: 'replace' })).toThrow();
    expect(() => createExamContributionSchema.parse({ examId, targetExamId: 'khong-phai-uuid' })).toThrow();
    expect(() => createExamContributionSchema.parse({ examId, unknownField: 1 })).toThrow();
  });

  it('withdrawExamSchema/withdrawExamMatrixSchema: lý do rút bắt buộc, chuỗi toàn khoảng trắng không tính là lý do', () => {
    expect(withdrawExamSchema.parse({ reason: '  Đề trùng nội dung  ' }).reason).toBe('Đề trùng nội dung');
    expect(() => withdrawExamSchema.parse({ reason: '' })).toThrow();
    expect(() => withdrawExamSchema.parse({ reason: '   ' })).toThrow();
    expect(withdrawExamMatrixSchema.parse({ reason: 'Sai cấu trúc' }).reason).toBe('Sai cấu trúc');
    expect(() => withdrawExamMatrixSchema.parse({ reason: '  ' })).toThrow();
  });

  it('mcpSubmitContributionInputSchema: ít nhất một trong ba danh sách phải có phần tử', () => {
    // Payload cũ chỉ-câu-hỏi vẫn hợp lệ nguyên vẹn.
    expect(mcpSubmitContributionInputSchema.parse({ targetBankId: bankId, questionIds: [questionId], idempotencyKey: 'k1' }).questionIds).toEqual([questionId]);
    // Chỉ đề / chỉ ma trận cũng hợp lệ (đối xứng ba thực thể).
    expect(mcpSubmitContributionInputSchema.parse({ targetBankId: bankId, examIds: [examId], idempotencyKey: 'k2' }).examIds).toEqual([examId]);
    expect(mcpSubmitContributionInputSchema.parse({ targetBankId: bankId, matrixIds: [matrixId], idempotencyKey: 'k3' }).matrixIds).toEqual([matrixId]);
    // Không danh sách nào / trần 50 phần tử / thiếu khoá idempotency đều bị từ chối.
    expect(() => mcpSubmitContributionInputSchema.parse({ targetBankId: bankId, idempotencyKey: 'k4' })).toThrow();
    expect(() => mcpSubmitContributionInputSchema.parse({ targetBankId: bankId, examIds: [], idempotencyKey: 'k5' })).toThrow();
    expect(() => mcpSubmitContributionInputSchema.parse({
      targetBankId: bankId,
      examIds: Array.from({ length: 51 }, () => examId),
      idempotencyKey: 'k6',
    })).toThrow();
    expect(() => mcpSubmitContributionInputSchema.parse({ targetBankId: bankId, examIds: [examId] })).toThrow();
  });

  it('mcpSubmitContributionOutputSchema: bản ghi idempotency cũ (chưa có examResults/matrixResults) vẫn hợp lệ với mặc định rỗng', () => {
    const legacy = mcpSubmitContributionOutputSchema.parse({
      targetBankId: bankId,
      results: [{ questionId, status: 'pending', contributionId: examId, code: null, message: null }],
      created: 1,
      failed: 0,
    });
    expect(legacy.examResults).toEqual([]);
    expect(legacy.matrixResults).toEqual([]);
  });

  it('examMatrixViewSchema: mang đủ bộ ba truy vết rút (thiếu là sai hình dạng)', () => {
    const view = {
      id: matrixId, name: 'Ma trận mẫu', subjectId: examId, curriculumId: examId, contextId: examId,
      presetKind: 'cv7991_periodic', targetFormPercents: null, targetLevelPercents: null, levelSet: 'three',
      scopeNote: null, scopeNodeIds: null, totalScore: 10, createdBy: null,
      bankId: bankId, status: 'hidden', isTemplate: false, derivedFromMatrixId: null,
      derivedFromBankId: null, originalAuthorId: null, copyCount: 0,
      withdrawnReason: 'Sai cấu trúc', withdrawnBy: examId, withdrawnAt: '2026-10-27T00:00:00.000Z',
      version: 1, cells: [], warnings: [],
    };
    expect(examMatrixViewSchema.parse(view).withdrawnReason).toBe('Sai cấu trúc');
    const { withdrawnReason: _omit, ...missingField } = view;
    expect(() => examMatrixViewSchema.parse(missingField)).toThrow();
  });

  it('examMatrixContributionViewSchema: mang vết chống trùng contentHash + nearDuplicateOf', () => {
    const row = {
      id: examId, matrixId, matrixName: 'Ma trận mẫu', targetBankId: bankId,
      proposerId: examId, proposerName: null, note: '', contentHash: 'abc123', nearDuplicateOf: matrixId,
      status: 'pending', rejectReason: null, reviewerId: null, resultMatrixId: null,
      createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
    };
    expect(examMatrixContributionViewSchema.parse(row).nearDuplicateOf).toBe(matrixId);
    const { contentHash: _omit, ...missingHash } = row;
    expect(() => examMatrixContributionViewSchema.parse(missingHash)).toThrow();
  });
});

describe('coupon + purchase plan contracts (phần còn lại của lát 2, #189)', () => {
  it('coupon phần trăm chỉ hợp lệ trong khoảng 1–99; cố định là số nguyên dương', () => {
    // Ràng buộc nghiệp vụ của hình dạng theo đặc tả coupon: phần trăm
    // giảm luôn nhỏ hơn giá gói nên số tiền phải trả không bao giờ về
    // 0 — percent = 100 bị từ chối ngay ở biên hình dạng.
    expect(createCouponSchema.parse({ code: 'SALE10', discountType: 'percent', discountValue: 10 }).discountValue).toBe(10);
    expect(() => createCouponSchema.parse({ code: 'FREE', discountType: 'percent', discountValue: 100 })).toThrow();
    expect(() => createCouponSchema.parse({ code: 'ZERO', discountType: 'percent', discountValue: 0 })).toThrow();
    expect(createCouponSchema.parse({ code: 'FIX500K', discountType: 'fixed', discountValue: 500000 }).discountValue).toBe(500000);
    expect(() => createCouponSchema.parse({ code: 'NEG', discountType: 'fixed', discountValue: -5 })).toThrow();
    expect(() => createCouponSchema.parse({ code: 'FLOAT', discountType: 'fixed', discountValue: 1.5 })).toThrow();
  });

  it('coupon: cửa sổ hiệu lực phải có đầu trước cuối; trường mặc định đúng đặc tả', () => {
    expect(() => createCouponSchema.parse({
      code: 'BADWIN', discountType: 'fixed', discountValue: 1000,
      startsAt: '2026-12-01T00:00:00+07:00', endsAt: '2026-11-01T00:00:00+07:00',
    })).toThrow();
    const parsed = createCouponSchema.parse({ code: 'PLAIN', discountType: 'fixed', discountValue: 1000 });
    expect(parsed.appliesTo).toBe('all');
    expect(parsed.isActive).toBe(true);
    // Mã coupon rỗng sau khi cắt khoảng trắng là hình dạng sai.
    expect(() => createCouponSchema.parse({ code: '   ', discountType: 'fixed', discountValue: 1000 })).toThrow();
    // Trường lạ bị từ chối (strictObject) — client không nhét được
    // mức giảm ngoài hai trường đã định.
    expect(() => createCouponSchema.parse({ code: 'X', discountType: 'fixed', discountValue: 1000, amount: 1 })).toThrow();
  });

  it('payload mua gói: nhận couponCode tuỳ chọn, tuyệt đối không nhận amount', () => {
    expect(purchasePlanSchema.parse({ component: 'teacher_plan' }).couponCode).toBeUndefined();
    expect(purchasePlanSchema.parse({ component: 'tenant_plan', couponCode: 'SALE10' }).couponCode).toBe('SALE10');
    expect(() => purchasePlanSchema.parse({ component: 'teacher_plan', amount: 1 })).toThrow();
    expect(() => purchasePlanSchema.parse({ component: 'teacher_plan', couponCode: '' })).toThrow();
  });

  it('payload cập nhật coupon: cho phép tắt coupon và xoá giới hạn lượt dùng về null', () => {
    expect(updateCouponSchema.parse({ isActive: false }).isActive).toBe(false);
    expect(updateCouponSchema.parse({ maxRedemptions: null }).maxRedemptions).toBeNull();
    expect(() => updateCouponSchema.parse({ code: 'NEWCODE' })).toThrow();
  });
});

describe('grade export contracts (chuẩn đường dẫn module điểm, #342)', () => {
  const vneduPayload = {
    regularItemIds: ['01900000-0000-7000-8000-000000000011'],
    midtermItemId: '01900000-0000-7000-8000-000000000012',
    finalItemId: '01900000-0000-7000-8000-000000000013',
    semester: 1 as const,
  };

  it('accepts the canonical export payload with the provider carried in the body', () => {
    const parsed = exportGradesSchema.parse({ provider: 'vnedu', ...vneduPayload });
    expect(parsed.provider).toBe('vnedu');
    expect(parsed.regularItemIds).toEqual(vneduPayload.regularItemIds);
    expect(parsed.semester).toBe(1);
  });

  it('rejects the canonical export payload when the provider is missing', () => {
    expect(() => exportGradesSchema.parse(vneduPayload)).toThrow();
  });

  it('rejects providers outside the closed provider set', () => {
    expect(gradeExportProviderSchema.parse('vnedu')).toBe('vnedu');
    expect(() => exportGradesSchema.parse({ provider: 'smas', ...vneduPayload })).toThrow();
    expect(() => gradeExportProviderSchema.parse('')).toThrow();
  });

  it('rejects unknown extra fields in the canonical export payload', () => {
    expect(() => exportGradesSchema.parse({ provider: 'vnedu', ...vneduPayload, format: 'pdf' })).toThrow();
  });

  it('keeps the legacy vnedu payload shape provider-less for the alias path', () => {
    const parsed = exportGradesVneduSchema.parse(vneduPayload);
    expect(parsed.midtermItemId).toBe(vneduPayload.midtermItemId);
    expect(() => exportGradesVneduSchema.parse({ provider: 'vnedu', ...vneduPayload })).toThrow();
  });
});

describe('refund lifecycle + review queue contracts (lát 3, #189)', () => {
  it('tạo yêu cầu hoàn: lý do là BẮT BUỘC (kể cả lý do toàn khoảng trắng), amount là số nguyên dương', () => {
    // Ràng buộc nghiệp vụ của vòng đời hoàn: mọi khoản chi hoàn đều
    // phải có lý do để lại vết kiểm toán — thiếu lý do hoặc lý do
    // rỗng sau khi cắt khoảng trắng bị từ chối ngay ở biên hình dạng.
    expect(createRefundSchema.parse({ amount: 50000, reason: 'Học viên chuyển lớp' }).amount).toBe(50000);
    expect(() => createRefundSchema.parse({ amount: 50000 })).toThrow();
    expect(() => createRefundSchema.parse({ amount: 50000, reason: '   ' })).toThrow();
    expect(() => createRefundSchema.parse({ amount: 0, reason: 'x' })).toThrow();
    expect(() => createRefundSchema.parse({ amount: 1.5, reason: 'x' })).toThrow();
    // Client không tự chọn cấp duyệt hay trạng thái — cấp duyệt do
    // service quyết từ ngưỡng cấu hình + luật hoàn đủ (strictObject).
    expect(() => createRefundSchema.parse({ amount: 50000, reason: 'x', approvalLevel: 1 })).toThrow();
    expect(() => createRefundSchema.parse({ amount: 50000, reason: 'x', status: 'settled' })).toThrow();
  });

  it('vòng đời hoàn có đúng bốn trạng thái đã chốt; từ chối bắt buộc lý do; xác nhận chi chỉ mang mã lệnh chi', () => {
    expect(paymentRefundStatusSchema.options).toEqual(['requested', 'approved', 'settled', 'rejected']);
    expect(() => rejectRefundSchema.parse({})).toThrow();
    expect(() => rejectRefundSchema.parse({ reason: ' ' })).toThrow();
    expect(rejectRefundSchema.parse({ reason: 'Thiếu chứng từ' }).reason).toBe('Thiếu chứng từ');
    expect(settleRefundSchema.parse({}).externalTransactionId).toBeUndefined();
    expect(settleRefundSchema.parse({ externalTransactionId: 'FT123' }).externalTransactionId).toBe('FT123');
    expect(() => settleRefundSchema.parse({ externalTransactionId: '' })).toThrow();
  });

  it('xử lý hàng đợi needs_review: quyết định thuộc đúng tập matched/rejected và lý do bắt buộc', () => {
    expect(resolvePaymentReviewSchema.parse({ decision: 'matched', reason: 'Đã đối chiếu sao kê' }).decision).toBe('matched');
    expect(resolvePaymentReviewSchema.parse({ decision: 'rejected', reason: 'Không có khoản tiền này' }).decision).toBe('rejected');
    expect(() => resolvePaymentReviewSchema.parse({ decision: 'ignored', reason: 'x' })).toThrow();
    expect(() => resolvePaymentReviewSchema.parse({ decision: 'matched' })).toThrow();
    expect(() => resolvePaymentReviewSchema.parse({ decision: 'matched', reason: '' })).toThrow();
  });
});
