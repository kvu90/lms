import { VersioningType, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { enableTrustedProxy } from '../src/common/client-ip';
import { ProblemDetailsFilter } from '../src/common/problem-details.filter';
import { OutboxService } from '../src/infra/events/outbox.service';
import { McpBridgeAuth } from '../src/modules/mcp/mcp-bridge-auth';
import { McpIdempotencyRepository } from '../src/modules/mcp/mcp-idempotency.repository';
import { McpRateLimiter } from '../src/modules/mcp/mcp-rate-limit';
import { mountMcp, resolveMcpDeps, type McpMountDeps } from '../src/modules/mcp/mcp.mount';
import { QuestionBanksService } from '../src/modules/questions/question-banks.service';
import { QuestionsRepository } from '../src/modules/questions/questions.repository';
import { QuestionsService } from '../src/modules/questions/questions.service';
import { UsersService } from '../src/modules/users/users.service';
import {
  adminToken, assignRole, createUserViaApi, http, login, roleIdByShortname,
  STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

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
 *    chấm đúng (gồm truefalse cả hai chiều correct qua dạng answers
 *    chuẩn của MCP).
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
  // Mount MCP trước init — đúng thứ tự như main.ts (trước prefix/route của Nest).
  mountMcp(app as NestExpressApplication, mountDeps ? mountDeps(app) : resolveMcpDeps(app as NestExpressApplication));
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
}

describe('MCP server (MCP-0, issue #110)', () => {
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

  beforeAll(async () => {
    app = await createMountedMcpApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    questions = app.get(QuestionsService, { strict: false });
    banks = app.get(QuestionBanksService, { strict: false });
    teacherA = await mkStaffUser();
    teacherB = await mkStaffUser();
    student = await mkUser();
    const banksRes = await callTool(app, teacherA.token, 'list_my_banks', {});
    // list_my_banks theo đúng semantics REST (question:useall kế thừa
    // theo cây context) có thể gồm bank của giáo viên khác — bank GHI
    // của MCP là bank personal CỦA CHÍNH chủ token (lọc theo ownerId).
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
    expect(prm.body.authorization_servers?.length).toBeGreaterThan(0);

    const noToken = await mcpCall(app, null, 'tools/call', { name: 'list_my_banks', arguments: {} });
    expect(noToken.status).toBe(401);
    const badToken = await mcpCall(app, 'not-a-token', 'tools/call', { name: 'list_my_banks', arguments: {} });
    expect(badToken.status).toBe(401);
  });

  it('tools/list ở cả hai kỷ nguyên: đúng 4 tools', async () => {
    const modern = await mcpCall(app, teacherA.token, 'tools/list', {});
    expect(modern.jsonrpcError).toBeUndefined();
    const modernList = await http(app).post('/mcp').set(bearer(teacherA.token))
      .set('MCP-Protocol-Version', '2026-07-28').set('Mcp-Method', 'tools/list')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: MODERN_META } });
    const modernNames = (parseMcpBody(modernList.text).result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(modernNames).toEqual(['create_question', 'get_question', 'list_categories', 'list_my_banks']);
    void modern;

    const init = await mcpCall(app, teacherA.token, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-spec', version: '0.1' },
    }, 'legacy');
    expect(init.jsonrpcError).toBeUndefined();
    const legacyList = await http(app).post('/mcp').set(bearer(teacherA.token))
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const legacyNames = (parseMcpBody(legacyList.text).result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(legacyNames).toEqual(['create_question', 'get_question', 'list_categories', 'list_my_banks']);
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
    const name = uniqueName('mcpMc');
    const res = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'multichoice', name,
      questionText: 'Thủ đô của Pháp là gì?',
      answers: [{ text: 'Paris', fraction: 1 }, { text: 'London', fraction: 0 }],
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
        where v.question_bank_entry_id = (select id from question_bank_entries where question_id = $1) and a.fraction = 1`,
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

  it('truefalse qua dạng answers chuẩn: correct=false chấm đúng khi trả lời False (và ngược lại)', async () => {
    const mkTf = async (text: string, trueFraction: number) => {
      const res = await callTool(app, teacherA.token, 'create_question', {
        bankId: bankA, categoryId: catA, qtype: 'truefalse', name: uniqueName('mcpTf'),
        questionText: text,
        answers: [
          { text: 'True', fraction: trueFraction },
          { text: 'False', fraction: trueFraction === 1 ? 0 : 1 },
        ],
        idempotencyKey: uniqueName('key'),
      });
      expect(res.isError).toBe(false);
      const qid = res.structured!.questionId as string;
      await banks.setQuestionStatus(qid, 'ready');
      return qid;
    };
    // Mệnh đề SAI ("Mặt Trời quay quanh Trái Đất") — đáp án đúng là False.
    const tfFalse = await mkTf('Mặt Trời quay quanh Trái Đất.', 0);
    expect(await gradeViaUsage(tfFalse, 'false')).toMatchObject({ state: 'gradedright', fraction: 1 });
    expect(await gradeViaUsage(tfFalse, 'true')).toMatchObject({ state: 'gradedwrong', fraction: 0 });
    // Mệnh đề ĐÚNG — đáp án đúng là True.
    const tfTrue = await mkTf('Trái Đất quay quanh Mặt Trời.', 1);
    expect(await gradeViaUsage(tfTrue, 'true')).toMatchObject({ state: 'gradedright', fraction: 1 });
  });

  it('shortanswer + essay tạo được; essay chấm tay (needsgrading), shortanswer chấm đúng', async () => {
    const sa = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'shortanswer', name: uniqueName('mcpSa'),
      questionText: 'Thủ đô của Việt Nam là gì?',
      answers: [{ text: 'Hà Nội', fraction: 1 }],
      idempotencyKey: uniqueName('key'),
    });
    expect(sa.isError).toBe(false);
    const saId = sa.structured!.questionId as string;
    await banks.setQuestionStatus(saId, 'ready');
    expect(await gradeViaUsage(saId, 'Hà Nội')).toMatchObject({ state: 'gradedright', fraction: 1 });

    const essay = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: uniqueName('mcpEssay'),
      questionText: 'Hãy tả quê hương em.',
      idempotencyKey: uniqueName('key'),
    });
    expect(essay.isError).toBe(false);
    expect(essay.structured!.questionStatus).toBe('draft');
  });

  it('cổng draft 3: slot quiz chặn draft (quiz.slot_question_draft), ready thì thêm được', async () => {
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

    const quizRes = await http(app).post(`/api/v1/courses/${course.id}/quizzes`).set(bearer(teacherA.token))
      .send({ sectionId, name: uniqueName('mcpQuiz'), grade: 10, gradeMethod: 'highest' });
    expect(quizRes.status).toBe(201);
    const quizId = quizRes.body.id as string;

    const draftRes = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: uniqueName('mcpSlotDraft'),
      questionText: 'Câu draft cho slot quiz.',
      idempotencyKey: uniqueName('key'),
    });
    const draftQ = draftRes.structured!.questionId as string;

    const denied = await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set(bearer(teacherA.token)).send({ questionId: draftQ });
    expect(denied.status).toBe(400);
    expect(JSON.stringify(denied.body)).toContain('quiz.slot_question_draft');

    await banks.setQuestionStatus(draftQ, 'ready');
    const allowed = await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set(bearer(teacherA.token)).send({ questionId: draftQ });
    expect(allowed.status).toBeLessThan(300);
  });

  it('cổng draft 2 (đường quiz): slot ngẫu nhiên trên category chỉ có draft → quiz.random_slot_empty', async () => {
    // Category riêng trong bank personal của teacherA, chỉ chứa 1 draft.
    const bankRow = await sqlOne<{ context_id: string }>('select context_id from question_banks where id = $1', [bankA]);
    const catRes = await http(app).post('/api/v1/questions/categories').set(bearer(teacherA.token))
      .send({ name: uniqueName('mcpPoolCat'), contextId: bankRow.context_id, bankId: bankA });
    expect(catRes.status).toBeLessThan(300);
    const poolCat = catRes.body.id as string;
    const draftRes = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: poolCat, qtype: 'essay', name: uniqueName('mcpPoolDraft'),
      questionText: 'Draft duy nhất trong pool.',
      idempotencyKey: uniqueName('key'),
    });
    expect(draftRes.isError).toBe(false);
    expect(await questions.listUsableQuestionIdsInCategory(poolCat)).toEqual([]);

    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    await assignRole(app, admin, teacherA.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const quizRes = await http(app).post(`/api/v1/courses/${course.id}/quizzes`).set(bearer(teacherA.token))
      .send({ sectionId, name: uniqueName('mcpQuizRandom'), grade: 10, gradeMethod: 'highest' });
    expect(quizRes.status).toBeLessThan(300);
    const quizId = quizRes.body.id as string;
    const slot = await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set(bearer(teacherA.token)).send({ categoryId: poolCat, maxMark: 2 });
    expect(slot.status).toBeLessThan(300);
    const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set(bearer(student.token)).send({});
    expect(start.status).toBe(400);
    expect(JSON.stringify(start.body)).toContain('quiz.random_slot_empty');
  });

  it('cổng draft 4: startAttempt follow_latest không lùi về version của câu draft', async () => {
    // Câu ready tạo qua REST, dựng usage, rồi hạ về draft: attempt bắt
    // đầu sau đó phải báo thiếu version thay vì phục vụ bản draft.
    const systemCtx = await systemContextId(app, admin);
    const catRes = await http(app).post('/api/v1/questions/categories').set(bearer(admin))
      .send({ name: uniqueName('mcpGateCat'), contextId: systemCtx });
    const qRes = await http(app).post('/api/v1/questions').set(bearer(admin)).send({
      categoryId: catRes.body.id, qtype: 'truefalse', name: uniqueName('mcpGateQ'),
      questionText: 'Câu kiểm cổng startAttempt.', answer: { correct: true },
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
    const badFraction = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'multichoice', name: uniqueName('mcpBad'),
      questionText: 'Tổng fraction sai.',
      answers: [{ text: 'A', fraction: 0.5 }, { text: 'B', fraction: 0.4 }],
      idempotencyKey: uniqueName('key'),
    });
    expect(badFraction.isError).toBe(true);
    expect(badFraction.structured!.error.code).toBe('question.bad_answer_data');
    expect(badFraction.structured!.error.fieldPath).toBe('/answers');

    const essayAnswers = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: uniqueName('mcpBad'),
      questionText: 'Essay không mang answers.',
      answers: [{ text: 'X', fraction: 1 }],
      idempotencyKey: uniqueName('key'),
    });
    expect(essayAnswers.isError).toBe(true);
    expect(essayAnswers.structured!.error.code).toBe('question.bad_answer_data');

    const badName = uniqueName('mcpBadField');
    const extraField = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: badName,
      questionText: 'Trường lạ phải bị chặn.', hackField: 'x',
      idempotencyKey: uniqueName('key'),
    } as Record<string, unknown>);
    expect(extraField.isError).toBe(true);
    const extraCount = await sqlOne<{ n: number }>('select count(*)::int as n from question where name = $1', [badName]);
    expect(extraCount.n).toBe(0);

    const tooLong = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: uniqueName('mcpBad'),
      questionText: 'x'.repeat(20001),
      idempotencyKey: uniqueName('key'),
    });
    expect(tooLong.isError).toBe(true);

    const control = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: uniqueName('mcpBad'),
      questionText: 'Ký tự điều khiển  ở đây.',
      idempotencyKey: uniqueName('key'),
    });
    expect(control.isError).toBe(true);
    expect(control.structured!.error.code).toBe('question.invalid_content');
    expect(control.structured!.error.fieldPath).toBe('/questionText');

    const zeroWidth = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: `Tên​lạ`,
      questionText: 'Zero-width trong tên.',
      idempotencyKey: uniqueName('key'),
    });
    expect(zeroWidth.isError).toBe(true);
    expect(zeroWidth.structured!.error.code).toBe('question.invalid_content');
    expect(zeroWidth.structured!.error.fieldPath).toBe('/name');
  });

  it('nội dung HTML/script được lưu thành TEXT thuần (không thành node HTML)', async () => {
    const rawText = '<script>alert(1)</script> Câu hỏi <b>đậm</b> & "ngoặc"';
    const res = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: uniqueName('mcpHtml'),
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
    const payload = {
      bankId: bankA, categoryId: catA, qtype: 'multichoice', name: uniqueName('mcpIdem'),
      questionText: 'Câu kiểm idempotency.',
      answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai', fraction: 0 }],
      idempotencyKey: key,
    };
    const first = await callTool(app, teacherA.token, 'create_question', payload);
    expect(first.isError).toBe(false);
    const qid = first.structured!.questionId as string;

    const replay = await callTool(app, teacherA.token, 'create_question', payload);
    expect(replay.isError).toBe(false);
    expect(replay.structured!.questionId).toBe(qid);
    const count = await sqlOne<{ n: number }>('select count(*)::int as n from question where name = $1', [payload.name]);
    expect(count.n).toBe(1);

    const conflict = await callTool(app, teacherA.token, 'create_question', { ...payload, name: uniqueName('mcpIdemOther') });
    expect(conflict.isError).toBe(true);
    expect(conflict.structured!.error.code).toBe('question.idempotency_conflict');

    const dup = await callTool(app, teacherA.token, 'create_question', { ...payload, idempotencyKey: uniqueName('key') });
    expect(dup.isError).toBe(false);
    expect(dup.structured!.status).toBe('duplicate_exact');
    expect(dup.structured!.existingQuestionId).toBe(qid);
    const count2 = await sqlOne<{ n: number }>('select count(*)::int as n from question where name = $1', [payload.name]);
    expect(count2.n).toBe(1);

    // Gần trùng: cùng thân câu, đáp án khác → vẫn tạo nhưng gắn cờ near.
    const near = await callTool(app, teacherA.token, 'create_question', {
      ...payload,
      name: uniqueName('mcpNear'),
      answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai khác', fraction: 0 }],
      idempotencyKey: uniqueName('key'),
    });
    expect(near.isError).toBe(false);
    expect(near.structured!.status).toBe('created');
    expect(near.structured!.duplicate).toBe('near');
    expect(near.structured!.nearDuplicateOf).toBe(qid);
  });

  it('phạm vi ghi: học viên + giáo viên khác bị từ chối ở bank của teacherA, 0 bản ghi', async () => {
    const nameStu = uniqueName('mcpStuHack');
    const stu = await callTool(app, student.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: nameStu,
      questionText: 'Học viên không được tạo.',
      idempotencyKey: uniqueName('key'),
    });
    expect(stu.isError).toBe(true);
    expect(stu.structured!.error.code).toBe('question.bank_not_found');

    const nameB = uniqueName('mcpBHack');
    const other = await callTool(app, teacherB.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: nameB,
      questionText: 'Giáo viên khác không ghi vào bank của người khác.',
      idempotencyKey: uniqueName('key'),
    });
    expect(other.isError).toBe(true);
    expect(other.structured!.error.code).toBe('question.bank_not_found');

    const created = await sqlOne<{ n: number }>('select count(*)::int as n from question where name in ($1, $2)', [nameStu, nameB]);
    expect(created.n).toBe(0);

    // Bank trường (dùng chung) cũng KHÔNG phải đích ghi của MCP-0.
    const banksRes = await callTool(app, teacherA.token, 'list_my_banks', {});
    const school = (banksRes.structured!.banks as any[]).find((b) => b.scope === 'school');
    const intoSchool = await callTool(app, teacherA.token, 'create_question', {
      bankId: school.id, categoryId: school.defaultCategoryId, qtype: 'essay', name: uniqueName('mcpSchoolHack'),
      questionText: 'Không ghi thẳng vào bank chung.',
      idempotencyKey: uniqueName('key'),
    });
    expect(intoSchool.isError).toBe(true);
    expect(intoSchool.structured!.error.code).toBe('question.bank_not_found');
  });

  it('get_question: projection không lộ source; cổng đọc bám đúng REST (useall theo cây context)', async () => {
    const mine = await callTool(app, teacherA.token, 'get_question', { questionId: draftMcId });
    expect(mine.isError).toBe(false);
    expect(mine.structured!.question.id).toBe(draftMcId);
    expect(JSON.stringify(mine.structured)).not.toContain('source_kind');
    expect(JSON.stringify(mine.structured)).not.toContain('source_ref');

    // Cổng đọc là assertQuestionReadable của REST: question:useall tại
    // context category, KẾ THỪA xuống từ vai teacher tại context hệ
    // thống — giáo viên khác đọc được (giống hệt REST, MCP không tự
    // thêm luật riêng); học viên không có useall → not found.
    const foreignTeacher = await callTool(app, teacherB.token, 'get_question', { questionId: draftMcId });
    expect(foreignTeacher.isError).toBe(false);
    const stu = await callTool(app, student.token, 'get_question', { questionId: draftMcId });
    expect(stu.isError).toBe(true);
    expect(stu.structured!.error.code).toBe('question.not_found');
  });

  it('legacy era: create_question chạy qua initialize + tools/call (SSE)', async () => {
    const init = await mcpCall(app, teacherA.token, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-spec', version: '0.1' },
    }, 'legacy');
    expect(init.jsonrpcError).toBeUndefined();
    const res = await callTool(app, teacherA.token, 'create_question', {
      bankId: bankA, categoryId: catA, qtype: 'essay', name: uniqueName('mcpLegacy'),
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
      const questionsRepo = a.get(QuestionsRepository, { strict: false });
      return {
        bridgeAuth: new McpBridgeAuth(process.env.JWT_SECRET!, a.get(UsersService)),
        rateLimiter: new McpRateLimiter({ read: 1000, create: 2 }),
        publicBaseUrl: null,
        issuer: null,
        toolDeps: {
          questions: a.get(QuestionsService, { strict: false }),
          banks: a.get(QuestionBanksService, { strict: false }),
          questionsRepo,
          idempotency: new McpIdempotencyRepository(questionsRepo.dbHandle),
          outbox: a.get(OutboxService, { strict: false }),
          publicBaseUrl: '',
        },
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
      name: `${uniqueName('mcpRate')}${n}`, questionText: `Câu rate ${n}.`,
      idempotencyKey: uniqueName('key'),
    });
    expect((await mk(1)).isError).toBe(false);
    expect((await mk(2)).isError).toBe(false);
    const third = await mk(3);
    expect(third.status).toBe(429);
    expect(third.jsonrpcError?.code).toBe(-32029);
  });
});
