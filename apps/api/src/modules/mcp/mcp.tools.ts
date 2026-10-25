import { HttpException } from '@nestjs/common';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import {
  createQuestionSchema,
  mcpCreateQuestionInputSchema,
  mcpCreateQuestionOutputSchema,
  mcpGetQuestionInputSchema,
  mcpGetQuestionOutputSchema,
  mcpListCategoriesInputSchema,
  mcpListCategoriesOutputSchema,
  mcpListMyBanksOutputSchema,
  type McpCreateQuestionInput,
  type McpCreateQuestionOutput,
} from '@lms/contracts';
import type { OutboxService } from '../../infra/events/outbox.service';
import type { QuestionBanksService } from '../questions/question-banks.service';
import type { QuestionsService } from '../questions/questions.service';
import { mcpRequestHash, normalizeContentStrings, scanContent, type ContentViolation } from './mcp-content';
import type { McpIdempotencyRepository } from './mcp-idempotency.repository';
import type { McpActor } from './mcp.context';

export interface McpToolDeps {
  questions: QuestionsService;
  banks: QuestionBanksService;
  idempotency: McpIdempotencyRepository;
  outbox: OutboxService;
  /** Origin công khai của API (PRM/`reviewUrl`); rỗng khi chưa cấu hình — reviewUrl khi đó là đường dẫn tương đối. */
  publicBaseUrl: string;
}

type ToolResult = CallToolResult;

function okResult(structured: Record<string, unknown>, summary: string): ToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: structured };
}

function errResult(code: string, message: string, fieldPath?: string): ToolResult {
  return {
    content: [{ type: 'text', text: fieldPath ? `${code} at ${fieldPath}: ${message}` : `${code}: ${message}` }],
    structuredContent: { error: { code, message, ...(fieldPath ? { fieldPath } : {}) } },
    isError: true,
  };
}

function errorShape(error: unknown): { code: string; message: string } {
  if (error instanceof HttpException) {
    const res = error.getResponse();
    if (typeof res === 'object' && res !== null) {
      const r = res as { code?: unknown; message?: unknown };
      return {
        code: typeof r.code === 'string' ? r.code : 'question.error',
        message: typeof r.message === 'string' ? r.message : error.message,
      };
    }
    return { code: 'question.error', message: String(res) };
  }
  return { code: 'mcp.internal_error', message: error instanceof Error ? error.message : 'Internal error' };
}

/** Mã lỗi nghiệp vụ của tầng service → trường payload gây lỗi, để model tự sửa đúng chỗ (research Phần 3.3). */
const FIELDPATH_BY_CODE: Record<string, string> = {
  'question.bad_answer_data': '/answers',
  'question.qtype_not_supported': '/qtype',
  'question.stimulus_category_mismatch': '/stimulusId',
  'question.category_not_found': '/categoryId',
  'question.invalid_category': '/categoryId',
};

/**
 * Ghi vết MỌI lần tools/call vào event_log qua outbox (cùng đường mirror
 * của hệ thống — research Phần 2.3): ai (user + client), tool nào, kết
 * quả gì, từ IP nào. Lỗi ghi vết KHÔNG được làm hỏng tool — chỉ log ra
 * console để vận hành thấy.
 */
async function auditCall(deps: McpToolDeps, actor: McpActor, tool: string, details: Record<string, unknown>): Promise<void> {
  try {
    // objectId: khoá chuẩn hoá của EventLogWriter cho aggregate lạ —
    // trỏ tới đối tượng chính của lần gọi (câu hỏi trước, bank sau).
    const objectId =
      (typeof details.questionId === 'string' ? details.questionId : null) ??
      (typeof details.existingQuestionId === 'string' ? details.existingQuestionId : null) ??
      (typeof details.bankId === 'string' ? details.bankId : null);
    await deps.outbox.enqueueStandalone({
      aggregate: 'mcp',
      type: 'mcp_tool_called',
      payload: {
        actorId: actor.userId,
        username: actor.username,
        clientId: actor.clientId,
        ip: actor.ip,
        era: actor.era,
        tool,
        ...(objectId ? { objectId } : {}),
        ...details,
      },
    });
  } catch (error) {
    console.error('[mcp] audit enqueue failed', error);
  }
}

/**
 * Dịch truefalse dạng answers chuẩn của MCP (đúng hai đáp án "True" /
 * "False", fraction 1/0) sang dạng payload cũ `{correct}` mà
 * QuestionsService hiện suy luận — đây là ÁNH XẠ ĐỊNH DẠNG ở biên MCP,
 * không phải validator nghiệp vụ: tính hợp lệ của đáp án vẫn do service
 * quyết khi nó dựng hai đáp án + options truefalse từ `correct`.
 */
function deriveTruefalseAnswer(answers: McpCreateQuestionInput['answers']): { correct: boolean } | null {
  const list = answers ?? [];
  if (list.length !== 2) return null;
  const norm = (s: string): string => s.trim().toLowerCase();
  const trueAns = list.find((a) => norm(a.text) === 'true');
  const falseAns = list.find((a) => norm(a.text) === 'false');
  if (!trueAns || !falseAns) return null;
  const pairOk = (trueAns.fraction === 1 && falseAns.fraction === 0) || (trueAns.fraction === 0 && falseAns.fraction === 1);
  if (!pairOk) return null;
  return { correct: trueAns.fraction === 1 };
}

/** Đăng ký 4 tool của lát MCP-0 lên một McpServer vừa dựng cho đúng một actor (mỗi request một server). */
export function registerMcpTools(server: McpServer, actor: McpActor, deps: McpToolDeps): void {
  server.registerTool(
    'list_my_banks',
    {
      title: 'List my question banks',
      description:
        'List the question banks this teacher can use (personal, team, school), with per-bank capabilities and the default category id of each bank. Call this first to discover bankId/categoryId before creating questions.',
      inputSchema: {},
      outputSchema: mcpListMyBanksOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => {
      const banks = await deps.banks.listBanks(actor.userId, 'question');
      const out = {
        banks: banks.map((b) => ({
          id: b.id,
          name: b.name,
          scope: b.scope,
          kind: b.bankKind,
          ownerId: b.ownerId ?? null,
          capabilities: b.capabilities,
          defaultCategoryId: b.defaultCategoryId,
          categoryCount: b.categoryIds.length,
        })),
      };
      await auditCall(deps, actor, 'list_my_banks', { result: 'ok', count: out.banks.length });
      return okResult(out, `Found ${out.banks.length} question bank(s) you can use.`);
    },
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List categories of a bank',
      description:
        'List the categories (with question counts) that belong to one question bank. create_question needs a categoryId from this list — the category must belong to the same bank you write to.',
      inputSchema: mcpListCategoriesInputSchema,
      outputSchema: mcpListCategoriesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { bankId } = args as { bankId: string };
      let bank;
      try {
        bank = await deps.banks.getBankOrThrow(bankId);
      } catch {
        return errResult('question.bank_not_found', `Question bank ${bankId} not found`, '/bankId');
      }
      try {
        await deps.banks.getBank(actor.userId, bankId);
      } catch (error) {
        const { code, message } = errorShape(error);
        await auditCall(deps, actor, 'list_categories', { result: 'error', code, bankId });
        return errResult(code, message, '/bankId');
      }
      const all = await deps.questions.listCategories();
      const categories: { id: string; name: string; parentId: string | null; questionCount: number }[] = [];
      for (const cat of all) {
        if (await deps.banks.categoryBelongsToBank(cat, bank)) {
          // Chỉ cần SỐ câu trong category: đi qua facade service
          // (listQuestionIdsInCategory) thay vì repository — ranh giới
          // đóng gói của QuestionsModule (issue #138, mục 8.1 của #134).
          const questionIds = await deps.questions.listQuestionIdsInCategory(cat.id);
          categories.push({ id: cat.id, name: cat.name, parentId: cat.parent ?? null, questionCount: questionIds.length });
        }
      }
      await auditCall(deps, actor, 'list_categories', { result: 'ok', bankId, count: categories.length });
      return okResult({ bankId, categories }, `Bank has ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}.`);
    },
  );

  server.registerTool(
    'create_question',
    {
      title: 'Create a draft question in my personal bank',
      description:
        'Create ONE question (multichoice, truefalse, shortanswer or essay) in the teacher\'s OWN personal question bank. Content is plain text only — no HTML. Answers: multichoice needs at least 2 answers whose positive fractions sum to 1; truefalse takes exactly two answers "True"/"False" with fractions 1 and 0; shortanswer takes acceptable answers with fraction 1 for full credit; essay takes no answers. The question is stored as a DRAFT (source: AI) and must be reviewed and published by the teacher in the web UI before it can be used in any quiz. Retrying with the same idempotencyKey and the same payload is safe and returns the original result; the same key with a different payload is an error. If an identical question already exists in the bank, the result is duplicate_exact with the existing questionId and nothing is created.',
      inputSchema: mcpCreateQuestionInputSchema,
      outputSchema: mcpCreateQuestionOutputSchema,
    },
    async (rawArgs) => {
      const args = rawArgs as McpCreateQuestionInput;

      // ── Lớp 3: nội dung (quét ký tự cấm → chuẩn hoá NFC) ──────────
      const violations: ContentViolation[] = [];
      scanContent(args, violations, '', new Set(['/bankId', '/categoryId', '/stimulusId', '/idempotencyKey']));
      if (violations.length > 0) {
        const first = violations[0]!;
        await auditCall(deps, actor, 'create_question', { result: 'invalid_content', fieldPath: first.fieldPath });
        return errResult('question.invalid_content', first.message, first.fieldPath);
      }
      const clean = normalizeContentStrings(args);
      if (!clean.name.trim()) return errResult('question.invalid_content', 'Question name must not be blank', '/name');
      if (!clean.questionText.trim()) return errResult('question.invalid_content', 'Question text must not be blank', '/questionText');

      const { idempotencyKey, bankId, categoryId } = clean;

      // ── Lớp 4: phạm vi ghi — CHỈ bank cá nhân của chính chủ token ─
      let bank;
      try {
        bank = await deps.banks.getBankOrThrow(bankId);
      } catch {
        return errResult('question.bank_not_found', `Question bank ${bankId} not found`, '/bankId');
      }
      if (bank.scope !== 'personal' || bank.ownerId !== actor.userId || bank.bankKind !== 'question') {
        // Bank của người khác / bank chung: coi như không tồn tại (không lộ thông tin).
        await auditCall(deps, actor, 'create_question', { result: 'bank_not_found', bankId });
        return errResult('question.bank_not_found', `Question bank ${bankId} not found`, '/bankId');
      }
      let category;
      try {
        category = await deps.questions.getCategory(categoryId);
      } catch {
        return errResult('question.category_not_found', `Category ${categoryId} not found`, '/categoryId');
      }
      if (!(await deps.banks.categoryBelongsToBank(category, bank))) {
        return errResult('question.category_not_found', `Category ${categoryId} does not belong to bank ${bankId}`, '/categoryId');
      }
      const caps = await deps.banks.bankCapabilities(actor.userId, bank);
      if (!caps.add) {
        await auditCall(deps, actor, 'create_question', { result: 'forbidden', bankId });
        return errResult('question.forbidden', 'You do not have permission to add questions to this bank');
      }

      // ── Lớp 5a: idempotency ────────────────────────────────────────
      const { idempotencyKey: _key, ...hashPayload } = clean;
      const requestHash = mcpRequestHash('create_question', hashPayload);
      const existing = await deps.idempotency.find(actor.userId, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          await auditCall(deps, actor, 'create_question', { result: 'idempotency_conflict', bankId });
          return errResult(
            'question.idempotency_conflict',
            'This idempotencyKey was already used with a different payload. Use a new key for a different question.',
          );
        }
        const stored = existing.responseJson as unknown as McpCreateQuestionOutput;
        await auditCall(deps, actor, 'create_question', { result: 'idempotent_replay', bankId, questionId: stored.questionId ?? stored.existingQuestionId });
        return okResult({ ...stored }, 'Idempotent replay: this create was already processed; returning the original result.');
      }

      // ── Dịch định dạng truefalse (answers chuẩn → payload cũ) ─────
      let legacyAnswer: { correct: boolean } | undefined;
      if (clean.qtype === 'truefalse') {
        const derived = deriveTruefalseAnswer(clean.answers);
        if (!derived) {
          return errResult(
            'question.bad_answer_data',
            'truefalse questions take exactly two answers, "True" and "False", with fractions 1 and 0',
            '/answers',
          );
        }
        legacyAnswer = derived;
      }

      // ── Lớp 5b: chống trùng ở cổng tạo (cùng cơ chế QB-4) ─────────
      const dup = await deps.banks.findDuplicatesForPayload(bank, {
        qtype: clean.qtype,
        questionText: clean.questionText,
        answers: (clean.answers ?? []).map((a) => ({ text: a.text, fraction: a.fraction })),
      });
      if (dup.exactId) {
        const response: McpCreateQuestionOutput = {
          status: 'duplicate_exact',
          questionId: null,
          existingQuestionId: dup.exactId,
          entryId: null,
          version: null,
          questionStatus: null,
          duplicate: 'exact',
          nearDuplicateOf: null,
          reviewUrl: null,
        };
        await deps.idempotency.store({ userId: actor.userId, key: idempotencyKey, tool: 'create_question', requestHash, response: { ...response } });
        await auditCall(deps, actor, 'create_question', { result: 'duplicate_exact', bankId, existingQuestionId: dup.exactId });
        return okResult({ ...response }, `An identical question already exists in this bank (${dup.exactId}); nothing was created.`);
      }

      // ── Lớp 2: ĐÚNG đường của REST — parse bằng createQuestionSchema
      // rồi gọi QuestionsService (capability question:add tại context
      // category do service tự kiểm lại). ─────────────────────────────
      const serviceInput = {
        categoryId,
        qtype: clean.qtype,
        name: clean.name,
        questionText: clean.questionText,
        generalFeedback: clean.generalFeedback,
        guidance: clean.guidance,
        defaultMark: clean.defaultMark,
        penalty: clean.penalty,
        stimulusId: clean.stimulusId,
        answers: clean.qtype === 'truefalse' ? undefined : clean.answers,
        options: clean.options,
        ...(legacyAnswer ? { answer: legacyAnswer } : {}),
        sourceKind: 'ai' as const,
        sourceRef: `client:${actor.clientId}`,
      };
      let view;
      try {
        const parsed = createQuestionSchema.parse(serviceInput);
        view = await deps.questions.createQuestion(actor.userId, parsed);
      } catch (error) {
        const { code, message } = errorShape(error);
        await auditCall(deps, actor, 'create_question', { result: 'error', code, bankId });
        return errResult(code, message, FIELDPATH_BY_CODE[code]);
      }

      // Câu nạp qua MCP LUÔN vào draft chờ giáo viên duyệt (REST mặc
      // định ready) — lật cả entry + version mới nhất về draft.
      await deps.banks.setQuestionStatus(view.question.id, 'draft');

      const response: McpCreateQuestionOutput = {
        status: 'created',
        questionId: view.question.id,
        existingQuestionId: null,
        entryId: view.entry.id,
        version: view.latestVersion.version,
        questionStatus: 'draft',
        duplicate: dup.nearId ? 'near' : 'none',
        nearDuplicateOf: dup.nearId,
        reviewUrl: `${deps.publicBaseUrl}/questions`,
      };
      await deps.idempotency.store({ userId: actor.userId, key: idempotencyKey, tool: 'create_question', requestHash, response: { ...response } });
      await auditCall(deps, actor, 'create_question', {
        result: 'created',
        bankId,
        questionId: view.question.id,
        nearDuplicateOf: dup.nearId,
      });
      return okResult(
        { ...response },
        dup.nearId
          ? `Created draft question ${view.question.id}. Note: a similar question already exists (${dup.nearId}). Review and publish it in the web UI before use.`
          : `Created draft question ${view.question.id}. Review and publish it in the web UI before use.`,
      );
    },
  );

  server.registerTool(
    'get_question',
    {
      title: 'Get one question',
      description:
        'Fetch one question (with its answers and options) by id, using the standard question projection. Only questions the teacher is allowed to view are returned; anything else is reported as not found.',
      inputSchema: mcpGetQuestionInputSchema,
      outputSchema: mcpGetQuestionOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { questionId } = args as { questionId: string };
      try {
        const view = await deps.questions.getQuestionForViewer(actor.userId, questionId);
        const projected = mcpGetQuestionOutputSchema.parse(view);
        await auditCall(deps, actor, 'get_question', { result: 'ok', questionId });
        return okResult(projected as unknown as Record<string, unknown>, `Question "${view.question.name}" (${view.question.qtype}).`);
      } catch (error) {
        const { code, message } = errorShape(error);
        await auditCall(deps, actor, 'get_question', { result: 'error', code, questionId });
        return errResult(code, message);
      }
    },
  );
}
