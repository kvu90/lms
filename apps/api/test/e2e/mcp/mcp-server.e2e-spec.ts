import { VersioningType, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../src/app.module';
import { enableTrustedProxy } from '../../../src/common/client-ip';
import { ProblemDetailsFilter } from '../../../src/common/problem-details.filter';
import { McpDepsService } from '../../../src/modules/mcp/mcp-deps.service';
import { McpRateLimiter } from '../../../src/modules/mcp/mcp-rate-limit';
import { mountMcp, type McpMountDeps } from '../../../src/modules/mcp/mcp.mount';
import { QuestionBanksService } from '../../../src/modules/questions/question-banks.service';
import { QuestionsService } from '../../../src/modules/questions/questions.service';
import {
  adminToken, assignRole, createUserViaApi, http, login, roleIdByShortname,
  STRONG_PASSWORD, systemContextId, uniqueName,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from '../../support/course-enrolment-helpers';
import { createExamDraft } from '../../support/exam-pin-helpers';

/**
 * Lát MCP-0 (issue #110) — nền MCP server + nhập câu hỏi nháp bằng AI.
 * Bao phủ tiêu chí nghiệm thu Phần 4.3 của hồ sơ research:
 *  - một endpoint POST /mcp phục vụ cả hai kỷ nguyên (modern
 *    2026-07-28 + legacy 2025-11-25): tools/list + tools/call chạy ở
 *    cả hai; PRM chạy; không token → 401.
 *  - create_question đủ 4 qtype vào bank personal của chính chủ token,
 *    trạng thái draft, source_kind='ai' + source_ref='client:<id>'
 *    (kiểm bằng SQL); draft KHÔNG rút được vào usage/slot ngẫu
 *    nhiên/slot quiz/startAttempt; phát hành ready thì dùng được và
 *    chấm đúng (gồm truefalse chùm TF-A 4 mệnh đề qua dạng answers
 *    chuẩn của MCP: thân câu + 4 mệnh đề kèm giá trị Đúng/Sai).
 *  - validate: lỗi nghiệp vụ kèm fieldPath; trường lạ bị schema chặn;
 *    nội dung HTML lưu thành text thuần; ký tự điều khiển bị từ chối.
 *  - phân quyền: học viên / giáo viên khác bị từ chối (bank của người
 *    khác coi như không tồn tại), 0 bản ghi sinh ra.
 *  - idempotency: phát lại cùng key → kết quả cũ không nhân đôi; cùng
 *    key khác payload → question.idempotency_conflict; trùng hoàn toàn
 *    → verdict duplicate_exact không tạo bản sao.
 *  - mọi tools/call ghi outbox aggregate 'mcp' (worker relay mirror
 *    sang event_log — cùng cơ chế mọi aggregate khác).
 *  - rate limit tạo câu: vượt hạn → 429 + mã -32029 (app riêng, hạn 2).
 *  - submit_contribution (lát MCP-2, mở lại #110): câu của chính chủ
 *    (draft → ready) nộp vào bank trường thành contribution pending ở
 *    cả hai kỷ nguyên; approve qua REST → deep copy vào bank trường
 *    (derived_from trỏ câu gốc); chặn câu chưa ready / câu của người
 *    khác / đích bank personal / câu không tồn tại; idempotency replay
 *    + conflict; trần thiếu scope lms.banks.contribute → HTTP 403
 *    insufficient_scope (app riêng).
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'mcp-spec', version: '0.1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

interface McpReply {
  status: number;
  jsonrpcError?: { code: number; message: string };
  isError: boolean;
  structured?: Record<string, any>;
  text: string;
}

function parseMcpBody(raw: string): { result?: any; error?: { code: number; message: string } } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  // Legacy stateless trả khung SSE: lấy dòng data: đầu tiên.
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
  }
  throw new Error(`Unparseable MCP response: ${raw.slice(0, 300)}`);
}

async function mcpCall(
  app: INestApplication,
  token: string | null,
  method: string,
  params: Record<string, unknown>,
  era: 'modern' | 'legacy' = 'modern',
): Promise<McpReply> {
  let req = http(app).post('/mcp').set('Content-Type', 'application/json');
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  const bodyParams = { ...params };
  if (era === 'modern') {
    bodyParams._meta = MODERN_META;
    req = req.set('MCP-Protocol-Version', '2026-07-28').set('Mcp-Method', method);
    if (method === 'tools/call' && typeof params.name === 'string') req = req.set('Mcp-Name', params.name);
  } else {
    req = req.set('Accept', 'application/json, text/event-stream');
  }
  const res = await req.send({ jsonrpc: '2.0', id: 1, method, params: bodyParams });
  const parsed = parseMcpBody(res.text);
  if (parsed.error) return { status: res.status, jsonrpcError: parsed.error, isError: true, text: parsed.error.message };
  const result = parsed.result ?? {};
  return {
    status: res.status,
    isError: result.isError === true,
    structured: result.structuredContent as Record<string, any> | undefined,
    text: (result.content?.[0]?.text as string) ?? '',
  };
}

const callTool = (app: INestApplication, token: string, name: string, args: Record<string, unknown>, era: 'modern' | 'legacy' = 'modern') =>
  mcpCall(app, token, 'tools/call', { name, arguments: args }, era);

async function createMountedMcpApp(mountDeps?: (app: INestApplication) => McpMountDeps): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  enableTrustedProxy(app as NestExpressApplication);
  // Mount MCP trước init — đúng thứ tự như main.ts (trước prefix/route của Nest);
  // deps mặc định lấy qua facade McpDepsService của McpModule (issue #138).
  mountMcp(app as NestExpressApplication, mountDeps ? mountDeps(app) : app.get(McpDepsService).createMountDeps());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
}

describe('Máy chủ MCP (MCP-0, issue #110)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;
  let questions: QuestionsService;
  let banks: QuestionBanksService;

  let teacherA: { id: string; username: string; token: string };
  let teacherB: { id: string; username: string; token: string };
  let student: { id: string; username: string; token: string };
  let bankA = '';
  let catA = '';
  let schoolBankId = '';
  let contribQ1 = '';
  let contribQ2 = '';

  async function mkUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  /** Giáo viên = vai teacher tại hệ thống (nhóm staff được cấp bank cá nhân). */
  async function mkStaffUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await mkUser();
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    return u;
  }

  async function sqlOne<T>(sqlText: string, params: unknown[] = []): Promise<T> {
    const res = await pg.query(sqlText, params);
    return res.rows[0] as T;
  }

  /** Đếm câu theo thân câu của version mới nhất (câu hỏi không còn trường tên — không đếm theo tên được nữa). */
  async function countQuestionsWithText(text: string): Promise<number> {
    const row = await sqlOne<{ n: number }>(
      `select count(*)::int as n from question_versions v join question_bank_entries e on e.id = v.question_bank_entry_id
        where v.version = e.latest_version and v.question_text::text like $1`,
      [`%${text}%`],
    );
    return row.n;
  }

  beforeAll(async () => {
    app = await createMountedMcpApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    questions = app.get(QuestionsService);
    banks = app.get(QuestionBanksService);
    teacherA = await mkStaffUser();
    teacherB = await mkStaffUser();
    student = await mkUser();
    const banksRes = await callTool(app, teacherA.token, 'list_my_banks', {});
    // list_my_banks dùng đúng listBanks của REST: sau issue #123 bank
    // personal của giáo viên khác không còn xuất hiện trong danh sách;
    // bank GHI của MCP là bank personal CỦA CHÍNH chủ token (lọc theo
    // ownerId như trước).
    const personal = (banksRes.structured?.banks as any[]).find((b) => b.scope === 'personal' && b.kind === 'question' && b.ownerId === teacherA.id);
    bankA = personal.id as string;
    catA = personal.defaultCategoryId as string;
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('PRM công khai đúng RFC 9728; thiếu/sai token → 401', async () => {
    const prm = await http(app).get('/.well-known/oauth-protected-resource');
    expect(prm.status).toBe(200);
    expect(String(prm.body.resource)).toMatch(/\/mcp$/);
    expect(prm.body.scopes_supported).toContain('lms.questions.draft');
    expect(prm.body.scopes_supported).toContain('lms.banks.contribute');
    expect(prm.body.authorization_servers?.length).toBeGreaterThan(0);

    const noToken = await mcpCall(app, null, 'tools/call', { name: 'list_my_banks', arguments: {} });
    expect(noToken.status).toBe(401);
    const badToken = await mcpCall(app, 'not-a-token', 'tools/call', { name: 'list_my_banks', arguments: {} });
    expect(badToken.status).toBe(401);
  });

  it('tools/list ở cả hai kỷ nguyên: đúng danh mục tool hiện hành (5 của MCP-0 + 6 của MCP-1)', async () => {
    // Danh mục tool là MỘT sổ đăng ký dùng chung cho cả hai kỷ
    // nguyên (gác theo scope ở từng lần gọi, không gác theo kỷ
    // nguyên): MCP-1 (issue #163) thêm create_questions_batch,
    // create_stimulus_with_questions, publish_questions,
    // search_questions, check_duplicates, search_curriculum_outcomes
    // vào cùng danh mục 5 tool của MCP-0.
    const EXPECTED_TOOLS = [
      'check_duplicates', 'create_question', 'create_questions_batch',
      'create_stimulus_with_questions', 'get_question', 'list_categories',
      'list_my_banks', 'publish_questions', 'search_curriculum_outcomes',
      'search_questions', 'submit_contribution',
    ];
    const modern = await mcpCall(app, teacherA.token, 'tools/list', {});
    expect(modern.jsonrpcError).toBeUndefined();
    const modernList = await http(app).post('/mcp').set(bearer(teacherA.token))
      .set('MCP-Protocol-Version', '2026-07-28').set('Mcp-Method', 'tools/list')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: MODERN_META } });
    const modernNames = (parseMcpBody(modernList.text).result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(modernNames).toEqual(EXPECTED_TOOLS);
    void modern;

    const init = await mcpCall(app, teacherA.token, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-spec', version: '0.1' },
    }, 'legacy');
    expect(init.jsonrpcError).toBeUndefined();
    const legacyList = await http(app).post('/mcp').set(bearer(teacherA.token))
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const legacyNames = (parseMcpBody(legacyList.text).result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(legacyNames).toEqual(EXPECTED_TOOLS);
  });

  it('list_my_banks + list_categories: bank personal có quyền add; học viên không có bank nào', async () => {
    const res = await callTool(app, teacherA.token, 'list_my_banks', {});
    expect(res.isError).toBe(false);
    const personal = (res.structured!.banks as any[]).find((b) => b.id === bankA);
    expect(personal.capabilities.add).toBe(true);
    expect(personal.defaultCategoryId).toBe(catA);

    const cats = await callTool(app, teacherA.token, 'list_categories', { bankId: bankA });
    expect(cats.isError).toBe(false);
    const mine = (cats.structured!.categories as any[]).find((c) => c.id === catA);
    expect(mine).toBeTruthy();
    expect(typeof mine.questionCount).toBe('number');

    const stu = await callTool(app, student.token, 'list_my_banks', {});
    expect(stu.isError).toBe(false);
    expect(stu.structured!.banks).toEqual([]);
  });

  let draftMcId = '';
  it('create_question multichoice: vào draft, source_kind=ai (SQL), có vết outbox', async () => {
    const res = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'multichoice',
      questionText: 'Thủ đô của Pháp là gì?',
      answers: [
        { text: 'Paris', correct: true },
        { text: 'London', correct: false },
        { text: 'Berlin', correct: false },
        { text: 'Madrid', correct: false },
      ],
      idempotencyKey: uniqueName('key'),
    });
    expect(res.isError).toBe(false);
    expect(res.structured!.status).toBe('created');
    expect(res.structured!.questionStatus).toBe('draft');
    expect(res.structured!.duplicate).toBe('none');
    draftMcId = res.structured!.questionId as string;

    const row = await sqlOne<{ source_kind: string; source_ref: string; entry_status: string; version_status: string }>(
      `select q.source_kind, q.source_ref, e.status as entry_status, v.status as version_status
         from question q
         join question_bank_entries e on e.question_id = q.id
         join question_versions v on v.question_bank_entry_id = e.id and v.version = e.latest_version
        where q.id = $1`,
      [draftMcId],
    );
    expect(row.source_kind).toBe('ai');
    expect(row.source_ref).toBe('client:mcp-spec');
    expect(row.entry_status).toBe('draft');
    expect(row.version_status).toBe('draft');

    const audit = await sqlOne<{ n: number }>(
      `select count(*)::int as n from outbox_events where aggregate = 'mcp' and type = 'mcp_tool_called' and payload->>'questionId' = $1`,
      [draftMcId],
    );
    expect(audit.n).toBeGreaterThanOrEqual(1);
  });

  it('cổng draft 1+2: createUsage chặn draft; pool ngẫu nhiên không thấy draft', async () => {
    const err = await questions.createUsage(student.id, {
      component: 'mod_quiz', slots: [{ questionId: draftMcId }],
    }).catch((e: unknown) => e) as { getResponse?: () => { code?: string } };
    expect(err.getResponse?.().code).toBe('question.usage_draft_question');

    const usable = await questions.listUsableQuestionIdsInCategory(catA);
    expect(usable).not.toContain(draftMcId);
  });

  it('phát hành ready → dùng được: chấm multichoice đúng qua usage thật', async () => {
    await banks.setQuestionStatus(draftMcId, 'ready');
    const usable = await questions.listUsableQuestionIdsInCategory(catA);
    expect(usable).toContain(draftMcId);

    const created = await questions.createUsage(student.id, {
      component: 'mod_quiz', instanceId: '01900000-0000-7000-8000-0000000000a1', slots: [{ questionId: draftMcId }],
    });
    const usageId = created.usage.id as string;
    const attemptId = created.attempts[0]!.id as string;
    const start = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/start`).set(bearer(student.token));
    expect(start.status).toBeLessThan(300);
    const correct = await sqlOne<{ id: string }>(
      `select a.id from question_answers a join question_versions v on v.id = a.question_version_id
        where v.question_bank_entry_id = (select id from question_bank_entries where question_id = $1) and a.is_correct`,
      [draftMcId],
    );
    const submit = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/submit`)
      .set(bearer(student.token)).send({ response: correct.id });
    expect(submit.status).toBeLessThan(300);
    const finished = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set(bearer(student.token));
    expect(finished.body.attempts[0].state).toBe('gradedright');
    expect(finished.body.attempts[0].fraction).toBe(1);
  });

  async function gradeViaUsage(questionId: string, response: string): Promise<{ state: string; fraction: number | null }> {
    const created = await questions.createUsage(student.id, {
      component: 'mod_quiz', instanceId: '01900000-0000-7000-8000-0000000000a1', slots: [{ questionId }],
    });
    const usageId = created.usage.id as string;
    const attemptId = created.attempts[0]!.id as string;
    const start = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/start`).set(bearer(student.token));
    expect(start.status).toBeLessThan(300);
    const submit = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/submit`)
      .set(bearer(student.token)).send({ response });
    expect(submit.status).toBeLessThan(300);
    const finished = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set(bearer(student.token));
    return finished.body.attempts[0] as { state: string; fraction: number | null };
  }

  it('truefalse chùm TF-A qua dạng answers chuẩn: map Đúng/Sai đủ 4 mệnh đề chấm đúng (và ngược lại)', async () => {
    // TF-A (lát P5): thân câu + 4 mệnh đề, mỗi mệnh đề kèm giá trị
    // Đúng/Sai; tool MCP dựng statementList id s1..s4 theo thứ tự gửi.
    const res = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'truefalse',
      questionText: 'Xét các mệnh đề về Mặt Trời.',
      answers: [
        { text: 'Mặt Trời là một ngôi sao.', correct: true },
        { text: 'Mặt Trời quay quanh Trái Đất.', correct: false },
        { text: 'Ánh sáng Mặt Trời mất khoảng 8 phút tới Trái Đất.', correct: true },
        { text: 'Mặt Trời mọc ở phía tây.', correct: false },
      ],
      idempotencyKey: uniqueName('key'),
    });
    expect(res.isError).toBe(false);
    const qid = res.structured!.questionId as string;
    await banks.setQuestionStatus(qid, 'ready');
    // Trả lời khớp toàn bộ 4 mệnh đề → đúng trọn; trả lời ngược toàn bộ → sai trọn.
    const allRight = JSON.stringify({ s1: true, s2: false, s3: true, s4: false });
    const allWrong = JSON.stringify({ s1: false, s2: true, s3: false, s4: true });
    expect(await gradeViaUsage(qid, allRight)).toMatchObject({ state: 'gradedright', fraction: 1 });
    expect(await gradeViaUsage(qid, allWrong)).toMatchObject({ state: 'gradedwrong', fraction: 0 });
  });

  it('shortanswer + essay tạo được; essay chấm tay (needsgrading), shortanswer chấm đúng', async () => {
    const sa = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'shortanswer',
      questionText: 'Thủ đô của Việt Nam là gì?',
      answers: [{ text: 'Hà Nội', correct: true }],
      idempotencyKey: uniqueName('key'),
    });
    expect(sa.isError).toBe(false);
    const saId = sa.structured!.questionId as string;
    await banks.setQuestionStatus(saId, 'ready');
    expect(await gradeViaUsage(saId, 'Hà Nội')).toMatchObject({ state: 'gradedright', fraction: 1 });

    const essay = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'Hãy tả quê hương em.',
      idempotencyKey: uniqueName('key'),
    });
    expect(essay.isError).toBe(false);
    expect(essay.structured!.questionStatus).toBe('draft');
  });

  it('cổng draft 3: slot đề chặn câu chưa ready (exam.slot_question_not_ready), ready thì thêm được', async () => {
    // Khoá + quiz do teacherA quản (editingteacher tại context khoá).
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    await assignRole(app, admin, teacherA.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    await enrolUser(app, admin, course.id, instance.id, student.id);

    const draft0 = await createExamDraft(app, teacherA.token, uniqueName('mcpExam'));

    const draftRes = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'Câu draft cho slot đề.',
      idempotencyKey: uniqueName('key'),
    });
    const draftQ = draftRes.structured!.questionId as string;

    // Soạn slot đề với câu còn draft: bị chặn ở cổng resolve (chưa có
    // version ready nào để ghim) — mã cổng của họ Đề sau gộp (#226).
    draft0.slots.push({ questionId: draftQ });
    const denied = await http(app).put(`/api/v1/exams/${draft0.examId}/slots`).set(bearer(teacherA.token)).send({ slots: draft0.slots });
    expect(denied.status).toBe(400);
    expect(JSON.stringify(denied.body)).toContain('exam.slot_question_not_ready');

    await banks.setQuestionStatus(draftQ, 'ready');
    const allowed = await http(app).put(`/api/v1/exams/${draft0.examId}/slots`).set(bearer(teacherA.token)).send({ slots: draft0.slots });
    expect(allowed.status).toBeLessThan(300);
    void course; void sectionId;
  });

  it('cổng draft 2 (đường đề): slot theo category đã bỏ hẳn — soạn slot bắt buộc câu cụ thể (#226)', async () => {
    // Category riêng trong bank personal của teacherA, chỉ chứa 1 draft.
    const bankRow = await sqlOne<{ context_id: string }>('select context_id from question_banks where id = $1', [bankA]);
    const catRes = await http(app).post('/api/v1/questions/categories').set(bearer(teacherA.token))
      .send({ name: uniqueName('mcpPoolCat'), contextId: bankRow.context_id, bankId: bankA });
    expect(catRes.status).toBeLessThan(300);
    const poolCat = catRes.body.id as string;
    const draftRes = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: poolCat, qtype: 'essay',
      questionText: 'Draft duy nhất trong pool.',
      idempotencyKey: uniqueName('key'),
    });
    expect(draftRes.isError).toBe(false);
    expect(await questions.listUsableQuestionIdsInCategory(poolCat)).toEqual([]);

    // Mô hình gộp Đề: slot của đề luôn là câu CỤ THỂ đã ghim version —
    // không còn slot ngẫu nhiên theo category ở bề mặt soạn đề (rút
    // ngẫu nhiên chỉ qua sinh đề từ ma trận, xem quiz-matrix-flow).
    // Gửi slot chỉ có categoryId → schema chặn 400.
    const draft0 = await createExamDraft(app, teacherA.token, uniqueName('mcpExamCat'));
    const slot = await http(app).put(`/api/v1/exams/${draft0.examId}/slots`).set(bearer(teacherA.token))
      .send({ slots: [{ categoryId: poolCat, maxMark: 2 }] });
    expect(slot.status).toBe(400);
  });

  it('cổng draft 4: startAttempt follow_latest không lùi về version của câu draft', async () => {
    // Câu ready tạo qua REST, dựng usage, rồi hạ về draft: attempt bắt
    // đầu sau đó phải báo thiếu version thay vì phục vụ bản draft.
    const systemCtx = await systemContextId(app, admin);
    const catRes = await http(app).post('/api/v1/questions/categories').set(bearer(admin))
      .send({ name: uniqueName('mcpGateCat'), contextId: systemCtx });
    const qRes = await http(app).post('/api/v1/questions').set(bearer(admin)).send({
      categoryId: catRes.body.id, qtype: 'essay',
      questionText: 'Câu kiểm cổng startAttempt.',
    });
    expect(qRes.status).toBeLessThan(300);
    const qid = qRes.body.question.id as string;
    const created = await questions.createUsage(student.id, {
      component: 'mod_quiz', instanceId: '01900000-0000-7000-8000-0000000000a1', slots: [{ questionId: qid }],
    });
    await banks.setQuestionStatus(qid, 'draft');
    const start = await http(app)
      .post(`/api/v1/question-usages/${created.usage.id}/attempts/${created.attempts[0]!.id}/start`)
      .set(bearer(student.token));
    expect(start.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(start.body)).toContain('question.version_missing');
  });

  it('validate: lỗi nghiệp vụ kèm fieldPath; trường lạ/quá dài bị schema chặn; ký tự cấm bị từ chối', async () => {
    // Multichoice sai luật đáp án (chỉ 2 lựa chọn thay vì đúng 4) -> lỗi nghiệp vụ kèm fieldPath.
    const badAnswers = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'multichoice',
      questionText: 'Trắc nghiệm thiếu lựa chọn.',
      answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }],
      idempotencyKey: uniqueName('key'),
    });
    expect(badAnswers.isError).toBe(true);
    expect(badAnswers.structured!.error.code).toBe('question.bad_answer_data');
    expect(badAnswers.structured!.error.fieldPath).toBe('/answers');

    const essayAnswers = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'Essay không mang answers.',
      answers: [{ text: 'X', correct: true }],
      idempotencyKey: uniqueName('key'),
    });
    expect(essayAnswers.isError).toBe(true);
    expect(essayAnswers.structured!.error.code).toBe('question.bad_answer_data');

    const extraField = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'Trường lạ phải bị chặn.', hackField: 'x',
      idempotencyKey: uniqueName('key'),
    } as Record<string, unknown>);
    expect(extraField.isError).toBe(true);
    expect(await countQuestionsWithText('Trường lạ phải bị chặn.')).toBe(0);

    const tooLong = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'x'.repeat(20001),
      idempotencyKey: uniqueName('key'),
    });
    expect(tooLong.isError).toBe(true);

    const control = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'Ký tự điều khiển  ở đây.',
      idempotencyKey: uniqueName('key'),
    });
    expect(control.isError).toBe(true);
    expect(control.structured!.error.code).toBe('question.invalid_content');
    expect(control.structured!.error.fieldPath).toBe('/questionText');

    const zeroWidth = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'Zero-width ​trong thân câu.',
      idempotencyKey: uniqueName('key'),
    });
    expect(zeroWidth.isError).toBe(true);
    expect(zeroWidth.structured!.error.code).toBe('question.invalid_content');
    expect(zeroWidth.structured!.error.fieldPath).toBe('/questionText');
  });

  it('nội dung HTML/script được lưu thành TEXT thuần (không thành node HTML)', async () => {
    const rawText = '<script>alert(1)</script> Câu hỏi <b>đậm</b> & "ngoặc"';
    const res = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: rawText,
      idempotencyKey: uniqueName('key'),
    });
    expect(res.isError).toBe(false);
    const qid = res.structured!.questionId as string;
    const row = await sqlOne<{ question_text: unknown }>(
      `select v.question_text from question_versions v join question_bank_entries e on e.id = v.question_bank_entry_id where e.question_id = $1`,
      [qid],
    );
    const texts: string[] = [];
    const types = new Set<string>();
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.type === 'string') types.add(node.type);
      if (typeof node.text === 'string') texts.push(node.text);
      for (const child of node.content ?? []) walk(child);
    };
    walk(row.question_text);
    expect(texts.join('')).toBe(rawText);
    expect(types.has('html')).toBe(false);
  });

  it('idempotency: phát lại trả kết quả cũ; cùng key khác payload → conflict; trùng exact → verdict, không nhân đôi', async () => {
    const key = uniqueName('key');
    // Thân câu duy nhất theo lượt chạy (đếm theo thân câu nên phải
    // phân biệt được với dữ liệu của lượt chạy trước trên cùng DB).
    const idemText = `Câu kiểm idempotency ${uniqueName('mcpIdem')}.`;
    const payload = {
      bankId: bankA, categoryId: catA, qtype: 'multichoice',
      questionText: idemText,
      answers: [
        { text: 'Đúng', correct: true },
        { text: 'Sai', correct: false },
        { text: 'Sai khác 1', correct: false },
        { text: 'Sai khác 2', correct: false },
      ],
      idempotencyKey: key,
    };
    const first = await callTool(app, teacherA.token, 'create_question', payload);
    expect(first.isError).toBe(false);
    const qid = first.structured!.questionId as string;

    const replay = await callTool(app, teacherA.token, 'create_question', payload);
    expect(replay.isError).toBe(false);
    expect(replay.structured!.questionId).toBe(qid);
    expect(await countQuestionsWithText(idemText)).toBe(1);

    const conflict = await callTool(app, teacherA.token, 'create_question', { ...payload, questionText: `${idemText} khác.` });
    expect(conflict.isError).toBe(true);
    expect(conflict.structured!.error.code).toBe('question.idempotency_conflict');

    const dup = await callTool(app, teacherA.token, 'create_question', { ...payload, idempotencyKey: uniqueName('key') });
    expect(dup.isError).toBe(false);
    expect(dup.structured!.status).toBe('duplicate_exact');
    expect(dup.structured!.existingQuestionId).toBe(qid);
    expect(await countQuestionsWithText(idemText)).toBe(1);

    // Gần trùng: cùng thân câu, đáp án khác → vẫn tạo nhưng gắn cờ near.
    const near = await callTool(app, teacherA.token, 'create_question', {
      ...payload,
      answers: [
        { text: 'Đúng', correct: true },
        { text: 'Sai khác', correct: false },
        { text: 'Sai khác 1', correct: false },
        { text: 'Sai khác 2', correct: false },
      ],
      idempotencyKey: uniqueName('key'),
    });
    expect(near.isError).toBe(false);
    expect(near.structured!.status).toBe('created');
    expect(near.structured!.duplicate).toBe('near');
    expect(near.structured!.nearDuplicateOf).toBe(qid);
  });

  it('#316: chống trùng TF-A qua MCP gồm giá trị Đ/S từng mệnh đề — khác Đ/S thì tạo mới, giống hệt thì duplicate_exact', async () => {
    // Thân câu + mệnh đề duy nhất theo lượt chạy (chống trùng đếm theo
    // nội dung nên phải phân biệt được với dữ liệu của lượt chạy trước).
    const stem = `Nhận định MCP ${uniqueName('tf316')}`;
    const tfPayload = (values: boolean[]) => ({
      bankId: bankA, categoryId: catA, qtype: 'truefalse',
      questionText: stem,
      answers: [1, 2, 3, 4].map((i) => ({ text: `${stem} — ý ${i}`, correct: values[i - 1]! })),
      idempotencyKey: uniqueName('key'),
    });

    const first = await callTool(app, teacherA.token, 'create_question', tfPayload([true, true, true, true]));
    expect(first.isError, first.text).toBe(false);
    expect(first.structured!.status).toBe('created');
    const firstId = first.structured!.questionId as string;

    // Giống hệt cả chữ lẫn Đ/S từng mệnh đề → trùng hoàn toàn, trỏ về câu đã có.
    const identical = await callTool(app, teacherA.token, 'create_question', tfPayload([true, true, true, true]));
    expect(identical.isError, identical.text).toBe(false);
    expect(identical.structured!.status).toBe('duplicate_exact');
    expect(identical.structured!.existingQuestionId).toBe(firstId);

    // Cùng chữ, khác Đ/S ở ý 4 → KHÔNG trùng hoàn toàn: tạo câu mới
    // (chỉ gần trùng theo thân câu), và hash của payload phải khớp
    // hash của version đã lưu — chứng minh bằng lần tạo thứ hai y hệt
    // bản khác-Đ/S cũng bị bắt trùng hoàn toàn với chính nó.
    const flipped = await callTool(app, teacherA.token, 'create_question', tfPayload([true, true, true, false]));
    expect(flipped.isError, flipped.text).toBe(false);
    expect(flipped.structured!.status).toBe('created');
    expect(flipped.structured!.duplicate).toBe('near');
    const flippedId = flipped.structured!.questionId as string;
    const flippedAgain = await callTool(app, teacherA.token, 'create_question', tfPayload([true, true, true, false]));
    expect(flippedAgain.isError, flippedAgain.text).toBe(false);
    expect(flippedAgain.structured!.status).toBe('duplicate_exact');
    expect(flippedAgain.structured!.existingQuestionId).toBe(flippedId);
  });

  it('phạm vi ghi: học viên + giáo viên khác bị từ chối ở bank của teacherA, 0 bản ghi', async () => {
    const stu = await callTool(app, student.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'Học viên không được tạo.',
      idempotencyKey: uniqueName('key'),
    });
    expect(stu.isError).toBe(true);
    expect(stu.structured!.error.code).toBe('question.bank_not_found');

    const other = await callTool(app, teacherB.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'Giáo viên khác không ghi vào bank của người khác.',
      idempotencyKey: uniqueName('key'),
    });
    expect(other.isError).toBe(true);
    expect(other.structured!.error.code).toBe('question.bank_not_found');

    expect(await countQuestionsWithText('Học viên không được tạo.')).toBe(0);
    expect(await countQuestionsWithText('Giáo viên khác không ghi vào bank của người khác.')).toBe(0);

    // Bank trường (dùng chung) cũng KHÔNG phải đích ghi của MCP-0.
    const banksRes = await callTool(app, teacherA.token, 'list_my_banks', {});
    const school = (banksRes.structured!.banks as any[]).find((b) => b.scope === 'school');
    const intoSchool = await callTool(app, teacherA.token, 'create_question', {
      bankId: school.id, categoryId: school.defaultCategoryId, qtype: 'essay',
      questionText: 'Không ghi thẳng vào bank chung.',
      idempotencyKey: uniqueName('key'),
    });
    expect(intoSchool.isError).toBe(true);
    expect(intoSchool.structured!.error.code).toBe('question.bank_not_found');
  });

  it('get_question: projection không lộ source; cổng đọc bám đúng REST (gồm riêng tư bank personal #123)', async () => {
    const mine = await callTool(app, teacherA.token, 'get_question', { questionId: draftMcId });
    expect(mine.isError).toBe(false);
    expect(mine.structured!.question.id).toBe(draftMcId);
    expect(JSON.stringify(mine.structured)).not.toContain('source_kind');
    expect(JSON.stringify(mine.structured)).not.toContain('source_ref');

    // Cổng đọc là assertQuestionReadable của REST dùng chung: từ issue
    // #123, câu thuộc bank personal của người khác → not found ở MỌI
    // bề mặt (REST và MCP parity — MCP không tự thêm luật riêng);
    // học viên cũng not found như trước.
    const foreignTeacher = await callTool(app, teacherB.token, 'get_question', { questionId: draftMcId });
    expect(foreignTeacher.isError).toBe(true);
    expect(foreignTeacher.structured!.error.code).toBe('question.not_found');
    const stu = await callTool(app, student.token, 'get_question', { questionId: draftMcId });
    expect(stu.isError).toBe(true);
    expect(stu.structured!.error.code).toBe('question.not_found');
  });

  it('submit_contribution: câu MCP (draft → ready) nộp vào bank trường thành pending, cả hai kỷ nguyên + idempotency', async () => {
    // Bank trường lấy qua đúng đường khám phá của MCP + service bảo đảm tồn tại.
    const schoolBank = await banks.ensureSchoolBank(teacherA.id);
    schoolBankId = schoolBank.id;
    const banksRes = await callTool(app, teacherA.token, 'list_my_banks', {});
    expect((banksRes.structured!.banks as any[]).some((b) => b.id === schoolBankId && b.scope === 'school')).toBe(true);

    const mkReady = async (n: number): Promise<string> => {
      const res = await callTool(app, teacherA.token, 'create_question', {
        bankId: bankA, categoryId: catA, qtype: 'essay',
        questionText: `Câu đóng góp số ${n} của giáo viên A.`,
        idempotencyKey: uniqueName('key'),
      });
      expect(res.isError).toBe(false);
      const qid = res.structured!.questionId as string;
      await banks.setQuestionStatus(qid, 'ready');
      return qid;
    };
    contribQ1 = await mkReady(1);
    contribQ2 = await mkReady(2);

    const key1 = uniqueName('key');
    const sub1 = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: schoolBankId, questionIds: [contribQ1], note: 'Đóng góp từ MCP', idempotencyKey: key1,
    });
    expect(sub1.isError).toBe(false);
    expect(sub1.structured!.created).toBe(1);
    expect(sub1.structured!.failed).toBe(0);
    const r1 = (sub1.structured!.results as any[])[0];
    expect(r1.status).toBe('pending');
    expect(r1.contributionId).toBeTruthy();
    const row = await sqlOne<{ status: string; target_bank_id: string; proposer_id: string }>(
      'SELECT status, target_bank_id, proposer_id FROM question_bank_contributions WHERE id = $1', [r1.contributionId]);
    expect(row.status).toBe('pending');
    expect(row.target_bank_id).toBe(schoolBankId);
    expect(row.proposer_id).toBe(teacherA.id);

    // Kỷ nguyên legacy dùng chung factory tool — nộp được như modern.
    const sub2 = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: schoolBankId, questionIds: [contribQ2], idempotencyKey: uniqueName('key'),
    }, 'legacy');
    expect(sub2.isError).toBe(false);
    expect((sub2.structured!.results as any[])[0].status).toBe('pending');

    // Phát lại cùng key + cùng payload → kết quả cũ, không nhân đôi đề xuất.
    const replay = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: schoolBankId, questionIds: [contribQ1], note: 'Đóng góp từ MCP', idempotencyKey: key1,
    });
    expect(replay.isError).toBe(false);
    expect((replay.structured!.results as any[])[0].contributionId).toBe(r1.contributionId);
    const cnt = await sqlOne<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM question_bank_contributions WHERE question_id = $1', [contribQ1]);
    expect(Number(cnt.n)).toBe(1);

    // Cùng key, payload khác → idempotency_conflict.
    const conflict = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: schoolBankId, questionIds: [contribQ2], idempotencyKey: key1,
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.structured!.error.code).toBe('question.idempotency_conflict');
  });

  it('submit_contribution → approve qua REST → câu vào bank trường (deep copy + derived_from)', async () => {
    const pending = await sqlOne<{ id: string }>(
      "SELECT id FROM question_bank_contributions WHERE question_id = $1 AND status = 'pending'", [contribQ1]);
    const approve = await http(app)
      .post(`/api/v1/question-banks/${schoolBankId}/contributions/${pending.id}/approve`)
      .set(bearer(admin))
      .send({});
    expect(approve.status).toBeLessThan(300);
    const row = await sqlOne<{ status: string; result_question_id: string | null }>(
      'SELECT status, result_question_id FROM question_bank_contributions WHERE id = $1', [pending.id]);
    expect(row.status).toBe('approved');
    expect(row.result_question_id).toBeTruthy();
    const copied = await sqlOne<{ derived: string; bank: string }>(
      `SELECT q.derived_from_question_id AS derived, c.bank_id AS bank
         FROM question q JOIN question_categories c ON c.id = q.category
        WHERE q.id = $1`, [row.result_question_id]);
    expect(copied.derived).toBe(contribQ1);
    expect(copied.bank).toBe(schoolBankId);
  });

  it('submit_contribution: chặn câu chưa ready / câu của người khác / đích bank personal / câu không tồn tại', async () => {
    const draftRes = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'Câu nháp chưa phát hành.', idempotencyKey: uniqueName('key'),
    });
    const draftId = draftRes.structured!.questionId as string;
    const notReady = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: schoolBankId, questionIds: [draftId], idempotencyKey: uniqueName('key'),
    });
    expect(notReady.isError).toBe(false);
    const nr = (notReady.structured!.results as any[])[0];
    expect(nr.status).toBe('failed');
    expect(nr.code).toBe('question.contribution_source_not_ready');

    // Câu ready của giáo viên B — A không nộp thay được, 0 đề xuất sinh ra.
    const banksB = await callTool(app, teacherB.token, 'list_my_banks', {});
    const personalB = (banksB.structured!.banks as any[]).find((b) => b.scope === 'personal' && b.ownerId === teacherB.id);
    const qB = await callTool(app, teacherB.token, 'create_question', {
      bankId: personalB.id, categoryId: personalB.defaultCategoryId, qtype: 'essay',
      questionText: 'Câu ready của giáo viên B.', idempotencyKey: uniqueName('key'),
    });
    const qBId = qB.structured!.questionId as string;
    await banks.setQuestionStatus(qBId, 'ready');
    const foreign = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: schoolBankId, questionIds: [qBId], idempotencyKey: uniqueName('key'),
    });
    const fr = (foreign.structured!.results as any[])[0];
    expect(fr.status).toBe('failed');
    expect(fr.code).toBe('question.contribution_source_not_own');
    const cntB = await sqlOne<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM question_bank_contributions WHERE question_id = $1', [qBId]);
    expect(Number(cntB.n)).toBe(0);

    // Đích là bank personal của chính mình → cổng QB-4 chặn.
    const toPersonal = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: bankA, questionIds: [contribQ2], idempotencyKey: uniqueName('key'),
    });
    const tp = (toPersonal.structured!.results as any[])[0];
    expect(tp.status).toBe('failed');
    expect(tp.code).toBe('question.contribution_target_personal');

    // Câu không tồn tại.
    const ghost = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: schoolBankId, questionIds: ['01900000-0000-7000-8000-000000000099'], idempotencyKey: uniqueName('key'),
    });
    const gh = (ghost.structured!.results as any[])[0];
    expect(gh.status).toBe('failed');
    expect(gh.code).toBe('question.not_found');
  });

  it('submit_contribution đối xứng đề + ma trận (issue #228): examIds/matrixIds của chính chủ thành pending, của người khác bị chặn ở biên, payload rỗng bị schema chặn', async () => {
    // Bank đích dùng chung cho đề và cho ma trận (admin tạo qua REST).
    const examSchool = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: uniqueName('Bank đề trường MCP'), scope: 'school', bankKind: 'exam' });
    expect(examSchool.status, JSON.stringify(examSchool.body)).toBeLessThan(300);
    const examSchoolId = examSchool.body.id as string;
    const matrixSchool = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: uniqueName('Bank ma trận trường MCP'), scope: 'school', bankKind: 'matrix' });
    expect(matrixSchool.status, JSON.stringify(matrixSchool.body)).toBeLessThan(300);
    const matrixSchoolId = matrixSchool.body.id as string;

    // ── Đề ready của teacherA trong bank đề cá nhân ──
    const examBanks = await http(app).get('/api/v1/question-banks?kind=exam').set(bearer(teacherA.token));
    const myExamBank = (examBanks.body as any[]).find((b) => b.scope === 'personal' && b.ownerId === teacherA.id);
    const qRes = await http(app).post('/api/v1/questions').set(bearer(teacherA.token)).send({
      categoryId: catA, qtype: 'multichoice', questionText: 'Câu cho đề MCP?',
      answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Khác 1', correct: false }, { text: 'Khác 2', correct: false }],
    });
    expect(qRes.status, JSON.stringify(qRes.body)).toBe(201);
    const qid = (qRes.body as any).question.id as string;
    const paperRes = await http(app).post(`/api/v1/exams/banks/${myExamBank.id}/exams`).set(bearer(teacherA.token))
      .send({ name: 'Đề MCP của A', slots: [{ questionId: qid }] });
    expect(paperRes.status, JSON.stringify(paperRes.body)).toBe(201);
    const paperId = (paperRes.body as any).paper.id as string;
    const readyRes = await http(app).post(`/api/v1/exams/${paperId}/status`).set(bearer(teacherA.token)).send({ status: 'ready' });
    expect(readyRes.status, JSON.stringify(readyRes.body)).toBe(201);

    const subExam = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: examSchoolId, examIds: [paperId], idempotencyKey: uniqueName('key'),
    });
    expect(subExam.isError).toBe(false);
    expect(subExam.structured!.created).toBe(1);
    expect(subExam.structured!.failed).toBe(0);
    const er = (subExam.structured!.examResults as any[])[0];
    expect(er.status).toBe('pending');
    expect(er.contributionId).toBeTruthy();
    const erow = await sqlOne<{ status: string; mode: string }>(
      'SELECT status, mode FROM exam_contributions WHERE id = $1', [er.contributionId]);
    expect(erow.status).toBe('pending');
    expect(erow.mode).toBe('new');

    // ── Đề của teacherB: A không nộp thay được (cổng chủ sở hữu ở biên chạy trước mọi cổng nghiệp vụ) ──
    const examBanksB = await http(app).get('/api/v1/question-banks?kind=exam').set(bearer(teacherB.token));
    const bankB = (examBanksB.body as any[]).find((b) => b.scope === 'personal' && b.ownerId === teacherB.id);
    const paperB = await http(app).post(`/api/v1/exams/banks/${bankB.id}/exams`).set(bearer(teacherB.token))
      .send({ name: 'Đề của B', slots: [] });
    const paperBId = (paperB.body as any).paper.id as string;
    const foreignExam = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: examSchoolId, examIds: [paperBId], idempotencyKey: uniqueName('key'),
    });
    const fe = (foreignExam.structured!.examResults as any[])[0];
    expect(fe.status).toBe('failed');
    expect(fe.code).toBe('exam.contribution_source_not_own');
    const cntE = await sqlOne<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM exam_contributions WHERE exam_id = $1', [paperBId]);
    expect(Number(cntE.n)).toBe(0);

    // ── Ma trận ready của teacherA trong bank ma trận cá nhân ──
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const systemCtx = (contexts.body as any[]).find((c) => c.contextLevel === 10);
    const subj = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtx.id, name: uniqueName('Môn MCP'), slug: uniqueName('mon-mcp') });
    const curr = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin))
      .send({ subjectId: subj.body.id, grade: 10 });
    const matrixBanksRes = await http(app).get('/api/v1/question-banks?kind=matrix').set(bearer(teacherA.token));
    const myMatrixBank = (matrixBanksRes.body as any[]).find((b) => b.scope === 'personal' && b.ownerId === teacherA.id);
    const matrixRes = await http(app).post('/api/v1/exam-matrices').set(bearer(teacherA.token)).send({
      name: 'Ma trận MCP của A', subjectId: subj.body.id, curriculumId: curr.body.id, bankId: myMatrixBank.id, totalScore: 10,
    });
    expect(matrixRes.status, JSON.stringify(matrixRes.body)).toBeLessThan(300);
    const matrixId = (matrixRes.body as any).id as string;
    const mReady = await http(app).patch(`/api/v1/exam-matrices/${matrixId}`).set(bearer(teacherA.token)).send({ status: 'ready' });
    expect(mReady.status, JSON.stringify(mReady.body)).toBe(200);

    const subMatrix = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: matrixSchoolId, matrixIds: [matrixId], idempotencyKey: uniqueName('key'),
    });
    expect(subMatrix.isError).toBe(false);
    const mr = (subMatrix.structured!.matrixResults as any[])[0];
    expect(mr.status).toBe('pending');
    expect(mr.contributionId).toBeTruthy();
    const mrow = await sqlOne<{ status: string; content_hash: string }>(
      'SELECT status, content_hash FROM exam_matrix_contributions WHERE id = $1', [mr.contributionId]);
    expect(mrow.status).toBe('pending');
    expect(mrow.content_hash).toBeTruthy();

    // ── Ma trận của admin: A không nộp thay được ──
    const adminMatrix = await http(app).post('/api/v1/exam-matrices').set(bearer(admin)).send({
      name: 'Ma trận của admin', subjectId: subj.body.id, curriculumId: curr.body.id, totalScore: 10,
    });
    const adminMatrixId = (adminMatrix.body as any).id as string;
    const foreignM = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: matrixSchoolId, matrixIds: [adminMatrixId], idempotencyKey: uniqueName('key'),
    });
    const fm = (foreignM.structured!.matrixResults as any[])[0];
    expect(fm.status).toBe('failed');
    expect(fm.code).toBe('quiz.matrix_contribution_source_not_own');

    // ── Payload không có danh sách nào: schema chặn ở biên tool ──
    const empty = await callTool(app, teacherA.token, 'submit_contribution', {
      targetBankId: examSchoolId, idempotencyKey: uniqueName('key'),
    });
    expect(empty.isError).toBe(true);
  });

  it('legacy era: create_question chạy qua initialize + tools/call (SSE)', async () => {
    const init = await mcpCall(app, teacherA.token, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-spec', version: '0.1' },
    }, 'legacy');
    expect(init.jsonrpcError).toBeUndefined();
    const res = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay',
      questionText: 'Câu tạo qua kỷ nguyên legacy.',
      idempotencyKey: uniqueName('key'),
    }, 'legacy');
    expect(res.isError).toBe(false);
    expect(res.structured!.status).toBe('created');
    expect(res.structured!.questionStatus).toBe('draft');
  });
});

describe('MCP rate limit (app riêng, hạn tạo = 2/giờ)', () => {
  let app2: INestApplication;
  let admin2: string;

  beforeAll(async () => {
    app2 = await createMountedMcpApp((a) => {
      // Deps chuẩn từ facade của McpModule, chỉ ghi đè rate limiter
      // bằng hạn chặt cho ca kiểm giới hạn (issue #138).
      const base = a.get(McpDepsService).createMountDeps();
      return {
        ...base,
        rateLimiter: new McpRateLimiter({ read: 1000, create: 2, publish: 10 }),
      } satisfies McpMountDeps;
    });
    admin2 = await adminToken(app2);
  });
  afterAll(async () => { await app2.close(); });

  it('create_question thứ 3 trong giờ → HTTP 429 + mã -32029', async () => {
    const u = await createUserViaApi(app2, admin2);
    await assignRole(app2, admin2, u.id, await roleIdByShortname(app2, admin2, 'teacher'), await systemContextId(app2, admin2));
    const session = await login(app2, u.username, STRONG_PASSWORD);
    const banksRes = await callTool(app2, session.accessToken, 'list_my_banks', {});
    const personal = (banksRes.structured!.banks as any[]).find((b) => b.scope === 'personal' && b.ownerId === u.id);
    const mk = (n: number) => callTool(app2, session.accessToken, 'create_question', {
      bankId: personal.id, categoryId: personal.defaultCategoryId, qtype: 'essay',
      questionText: `Câu rate ${n}.`,
      idempotencyKey: uniqueName('key'),
    });
    expect((await mk(1)).isError).toBe(false);
    expect((await mk(2)).isError).toBe(false);
    const third = await mk(3);
    expect(third.status).toBe(429);
    expect(third.jsonrpcError?.code).toBe(-32029);
  });
});

describe('MCP submit_contribution thiếu scope (app riêng, trần không có lms.banks.contribute)', () => {
  let app3: INestApplication;

  beforeAll(async () => {
    app3 = await createMountedMcpApp((a) => {
      // Deps chuẩn từ facade của McpModule (issue #138), chỉ thu hẹp
      // trần scope để kiểm cổng insufficient_scope của submit_contribution.
      const deps = a.get(McpDepsService).createMountDeps();
      return { ...deps, grantedScopes: ['lms.questions.read', 'lms.questions.draft'] };
    });
  });
  afterAll(async () => { await app3.close(); });

  it('tools/call submit_contribution → HTTP 403 + WWW-Authenticate insufficient_scope kèm scope cần', async () => {
    const admin3 = await adminToken(app3);
    const u = await createUserViaApi(app3, admin3);
    await assignRole(app3, admin3, u.id, await roleIdByShortname(app3, admin3, 'teacher'), await systemContextId(app3, admin3));
    const session = await login(app3, u.username, STRONG_PASSWORD);
    const res = await http(app3).post('/mcp').set(bearer(session.accessToken))
      .set('MCP-Protocol-Version', '2026-07-28').set('Mcp-Method', 'tools/call').set('Mcp-Name', 'submit_contribution')
      .send({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'submit_contribution',
          arguments: {
            targetBankId: '01900000-0000-7000-8000-000000000001',
            questionIds: ['01900000-0000-7000-8000-000000000002'],
            idempotencyKey: 'k-thieu-scope',
          },
          _meta: MODERN_META,
        },
      });
    expect(res.status).toBe(403);
    expect(String(res.headers['www-authenticate'])).toContain('insufficient_scope');
    expect(String(res.headers['www-authenticate'])).toContain('lms.banks.contribute');
    expect(parseMcpBody(res.text).error?.code).toBe(-32003);
  });
});
