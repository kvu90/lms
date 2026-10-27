import { HttpException } from '@nestjs/common';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import {
  TRUE_FALSE_STATEMENT_COUNT,
  createQuestionSchema,
  extractRichTextPlainText,
  mcpCheckDuplicatesInputSchema,
  mcpCheckDuplicatesOutputSchema,
  mcpCreateQuestionInputSchema,
  mcpCreateQuestionOutputSchema,
  mcpCreateQuestionsBatchInputSchema,
  mcpCreateQuestionsBatchOutputSchema,
  mcpCreateStimulusWithQuestionsInputSchema,
  mcpCreateStimulusWithQuestionsOutputSchema,
  mcpGetQuestionInputSchema,
  mcpGetQuestionOutputSchema,
  mcpListCategoriesInputSchema,
  mcpListCategoriesOutputSchema,
  mcpListMyBanksOutputSchema,
  mcpPublishQuestionsInputSchema,
  mcpPublishQuestionsOutputSchema,
  mcpSearchCurriculumOutcomesInputSchema,
  mcpSearchCurriculumOutcomesOutputSchema,
  mcpSearchQuestionsInputSchema,
  mcpSearchQuestionsOutputSchema,
  mcpSubmitContributionInputSchema,
  mcpSubmitContributionOutputSchema,
  type McpBatchItemResult,
  type McpCheckDuplicatesInput,
  type McpCreateQuestionInput,
  type McpCreateQuestionOutput,
  type McpCreateQuestionsBatchInput,
  type McpCreateQuestionsBatchOutput,
  type McpCreateStimulusWithQuestionsInput,
  type McpPublishQuestionsOutput,
  type McpSubmitContributionInput,
  type McpSubmitContributionOutput,
  type RichTextDocument,
} from '@lms/contracts';
import type { OutboxService } from '../../infra/events/outbox.service';
import type { CurriculumService } from '../curriculum/curriculum.service';
import type { QuestionBanksService } from '../questions/question-banks.service';
import type { QuestionsService } from '../questions/questions.service';
import { truefalseHashAnswers } from '../questions/domain/question-engine';
import { mcpRequestHash, normalizeContentStrings, scanContent, type ContentViolation } from './mcp-content';
import type { McpIdempotencyRepository } from './mcp-idempotency.repository';
import type { McpActor } from './mcp.context';

export interface McpToolDeps {
  questions: QuestionsService;
  banks: QuestionBanksService;
  /** Tra YCCĐ cho tool search_curriculum_outcomes (lát MCP-1) — cùng facade CurriculumService mà REST dùng. */
  curriculum: CurriculumService;
  idempotency: McpIdempotencyRepository;
  outbox: OutboxService;
  /** Origin công khai của API (PRM/`reviewUrl`); rỗng khi chưa cấu hình — reviewUrl khi đó là đường dẫn tương đối. */
  publicBaseUrl: string;
}

type BankRow = Awaited<ReturnType<QuestionBanksService['getBankOrThrow']>>;

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

/**
 * Lỗi schema Zod của payload tạo câu: schema mới kiểm luật đáp án theo
 * qtype ngay tại parse (multichoice đúng 4 lựa chọn + đúng một đáp án
 * đúng, shortanswer không đáp án sai...) nên lỗi này là lỗi nghiệp vụ
 * của payload, KHÔNG phải lỗi nội bộ — dịch sang
 * `question.bad_answer_data` kèm fieldPath từ issue đầu tiên. Chỉ dùng
 * ở hai đường tạo (lõi đơn + nhóm ngữ liệu); đường đọc giữ nguyên
 * `errorShape` để lỗi parse view vẫn là lỗi nội bộ.
 */
function asZodIssue(error: unknown): { message: string; fieldPath: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const first = issues[0] as { path?: unknown; message?: unknown };
  if (!Array.isArray(first.path) || typeof first.message !== 'string') return null;
  return { message: first.message, fieldPath: `/${first.path.join('/')}` };
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
 * Dịch câu đúng/sai chùm TF-A ở biên MCP sang hình payload tạo của
 * REST (lát P5, điểm quyết D-1): đầu vào MCP là thân câu (chuỗi thuần)
 * + đúng 4 mệnh đề, mỗi mệnh đề `{text, correct}` với `correct` là giá
 * trị Đúng/Sai của chính mệnh đề đó. Đầu ra là tài liệu thân câu
 * (paragraph thân + statementList chốt đuôi, id mệnh đề `s1`..`s4`
 * theo quy ước của các test TF-A) + `solution.answers` phủ đúng tập
 * mệnh đề; `answers` rỗng vì TF-A KHÔNG có dòng answers. Trả `null`
 * khi sai hình (sai số mệnh đề, mệnh đề rỗng, thiếu giá trị Đúng/Sai)
 * — caller dịch thành `question.bad_answer_data`, không tự đoán giá trị
 * cho mệnh đề thiếu.
 */
function buildTruefalseContent(
  questionText: string,
  answers: McpCreateQuestionInput['answers'],
): { questionText: RichTextDocument; solution: { answers: { statementId: string; value: boolean }[] } } | null {
  const list = answers ?? [];
  if (list.length !== TRUE_FALSE_STATEMENT_COUNT) return null;
  const statements = list.map((a, index) => ({ id: `s${index + 1}`, text: a.text, value: a.correct }));
  if (statements.some((s) => !s.text.trim() || typeof s.value !== 'boolean')) return null;
  // Kiểm tra trên đã loại mọi value thiếu — ép kiểu có căn cứ để dựng tài liệu.
  const checked = statements as { id: string; text: string; value: boolean }[];
  const doc: RichTextDocument = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: questionText }] },
      {
        type: 'statementList',
        content: checked.map((s) => ({
          type: 'statement',
          attrs: { id: s.id },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: s.text }] }],
        })),
      },
    ],
  };
  return {
    questionText: doc,
    solution: { answers: checked.map((s) => ({ statementId: s.id, value: s.value })) },
  };
}

/**
 * Đáp án kèm cờ đúng/sai cụ thể cho một payload MCP — đúng cách
 * QuestionsService lưu `isCorrect` (`correct === true` mới là đúng):
 * multichoice vắng `correct` = không đúng; shortanswer vắng `correct`
 * = được chấp nhận (mọi đáp án liệt kê của shortanswer đều được chấp
 * nhận — ghi chú hợp đồng MCP). Dùng CHUNG cho băm chống trùng và cho
 * payload gửi service, để hai đường không bao giờ lệch nhau.
 */
function normalizeMcpAnswers(
  qtype: string,
  answers: McpCreateQuestionInput['answers'],
): { text: string; correct: boolean; feedback?: string }[] {
  return (answers ?? []).map((a) => ({
    text: a.text,
    correct: a.correct ?? (qtype === 'shortanswer'),
    ...(a.feedback !== undefined ? { feedback: a.feedback } : {}),
  }));
}

/**
 * Dữ kiện băm chống trùng QB-4 cho một payload MCP chưa lưu — phải
 * khớp đúng cặp (thân câu thuần + đáp án kèm cờ) mà version ĐÃ lưu
 * sinh hash, nếu không trùng exact không bao giờ khớp:
 * - multichoice/shortanswer/essay: thân câu như gửi + đáp án đã chuẩn
 *   hoá cờ (essay không có đáp án nên mảng rỗng khớp version đã lưu);
 * - truefalse TF-A: dữ kiện băm là từng mệnh đề kèm giá trị Đúng/Sai
 *   của chính mệnh đề đó (issue #316), ghép từ tài liệu + solution do
 *   `buildTruefalseContent` dựng bằng ĐÚNG hàm dùng chung
 *   `truefalseHashAnswers` với đường version đã lưu — hai câu TF-A
 *   cùng chữ nhưng khác Đ/S ở một mệnh đề cho hash khác nhau ở cả
 *   hai đường.
 * Trả `null` khi câu TF-A sai hình (caller đã chặn trước bằng lỗi
 * `bad_answer_data` ở đường tạo; đường soi trùng không ghi thì quy
 * về verdict `none`).
 */
function duplicateCheckInput(
  qtype: string,
  questionText: string,
  answers: McpCreateQuestionInput['answers'],
): { questionText: string; answers: { text: string; correct: boolean }[] } | null {
  if (qtype === 'truefalse') {
    const built = buildTruefalseContent(questionText, answers);
    if (!built) return null;
    return {
      questionText: extractRichTextPlainText(built.questionText),
      answers: truefalseHashAnswers(built.questionText, built.solution).map((a) => ({ text: a.textPlain, correct: a.isCorrect })),
    };
  }
  return { questionText, answers: normalizeMcpAnswers(qtype, answers).map((a) => ({ text: a.text, correct: a.correct })) };
}

type CategoryRow = Awaited<ReturnType<QuestionsService['getCategory']>>;

type GateOutcome =
  | { kind: 'ok'; bank: BankRow; category: CategoryRow }
  | { kind: 'error'; code: string; message: string; fieldPath?: string };

/**
 * Lớp 4 dùng chung của mọi tool GHI câu (create_question, batch, nhóm
 * ngữ liệu): đích ghi CHỈ là bank CÁ NHÂN của chính chủ token (bank
 * của người khác/bank chung coi như không tồn tại — không lộ thông
 * tin), category phải thuộc bank đó, và capability `add` tại context
 * của bank phải đạt — cùng cổng mà create_question của MCP-0 đã giữ.
 */
async function gatePersonalBankWrite(
  deps: McpToolDeps,
  actor: McpActor,
  tool: string,
  bankId: string,
  categoryId: string,
): Promise<GateOutcome> {
  let bank: BankRow;
  try {
    bank = await deps.banks.getBankOrThrow(bankId);
  } catch {
    return { kind: 'error', code: 'question.bank_not_found', message: `Question bank ${bankId} not found`, fieldPath: '/bankId' };
  }
  if (bank.scope !== 'personal' || bank.ownerId !== actor.userId || bank.bankKind !== 'question') {
    await auditCall(deps, actor, tool, { result: 'bank_not_found', bankId });
    return { kind: 'error', code: 'question.bank_not_found', message: `Question bank ${bankId} not found`, fieldPath: '/bankId' };
  }
  let category: CategoryRow;
  try {
    category = await deps.questions.getCategory(categoryId);
  } catch {
    return { kind: 'error', code: 'question.category_not_found', message: `Category ${categoryId} not found`, fieldPath: '/categoryId' };
  }
  if (!(await deps.banks.categoryBelongsToBank(category, bank))) {
    return {
      kind: 'error',
      code: 'question.category_not_found',
      message: `Category ${categoryId} does not belong to bank ${bankId}`,
      fieldPath: '/categoryId',
    };
  }
  const caps = await deps.banks.bankCapabilities(actor.userId, bank);
  if (!caps.add) {
    await auditCall(deps, actor, tool, { result: 'forbidden', bankId });
    return { kind: 'error', code: 'question.forbidden', message: 'You do not have permission to add questions to this bank' };
  }
  return { kind: 'ok', bank, category };
}

/** Hình một câu ở biên MCP sau lớp nội dung (dùng chung cho create đơn, batch và nhóm ngữ liệu). Câu hỏi không có trường tên — nhãn hiển thị là trích đoạn nội dung. */
interface DraftItemPayload {
  qtype: McpCreateQuestionInput['qtype'];
  questionText: string;
  generalFeedback?: string;
  guidance?: string;
  defaultMark?: number;
  penalty?: number;
  stimulusId?: string;
  answers?: McpCreateQuestionInput['answers'];
  options?: McpCreateQuestionInput['options'];
}

type CreateCoreOutcome =
  | { kind: 'ok'; response: McpCreateQuestionOutput; replayed: boolean }
  | { kind: 'error'; code: string; message: string; fieldPath?: string };

/**
 * Lõi tạo MỘT câu draft (lớp 5 của khuôn validate 5 lớp): idempotency
 * theo khoá được truyền → chống trùng QB-4 → ĐÚNG đường REST
 * (createQuestionSchema + QuestionsService) → lật draft. Cổng bank
 * (lớp 4) do caller chạy trước qua gatePersonalBankWrite. create_question
 * truyền khoá của chính nó; batch truyền khoá suy từ (khoá lô +
 * clientItemId) nên idempotency có ngữ nghĩa TỪNG CÂU như đặc tả.
 */
async function createDraftQuestionCore(
  deps: McpToolDeps,
  actor: McpActor,
  opts: { tool: string; bank: BankRow; categoryId: string; item: DraftItemPayload; idempotencyKey: string },
): Promise<CreateCoreOutcome> {
  const { tool, bank, categoryId, idempotencyKey } = opts;
  // Chỉ các trường nội dung câu tham gia băm idempotency (caller có
  // thể truyền object rộng hơn — vd payload create_question còn mang
  // bankId/idempotencyKey — các trường đó không thuộc danh tính câu).
  const item: DraftItemPayload = {
    qtype: opts.item.qtype,
    questionText: opts.item.questionText,
    generalFeedback: opts.item.generalFeedback,
    guidance: opts.item.guidance,
    defaultMark: opts.item.defaultMark,
    penalty: opts.item.penalty,
    stimulusId: opts.item.stimulusId,
    answers: opts.item.answers,
    options: opts.item.options,
  };

  // ── Lớp 5a: idempotency ────────────────────────────────────────
  const requestHash = mcpRequestHash(tool, { bankId: bank.id, categoryId, ...item });
  const existing = await deps.idempotency.find(actor.userId, idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      await auditCall(deps, actor, tool, { result: 'idempotency_conflict', bankId: bank.id });
      return {
        kind: 'error',
        code: 'question.idempotency_conflict',
        message: 'This idempotencyKey was already used with a different payload. Use a new key for a different question.',
      };
    }
    const stored = existing.responseJson as unknown as McpCreateQuestionOutput;
    await auditCall(deps, actor, tool, { result: 'idempotent_replay', bankId: bank.id, questionId: stored.questionId ?? stored.existingQuestionId });
    return { kind: 'ok', response: stored, replayed: true };
  }

  // ── Dịch TF-A ở biên (thân + 4 mệnh đề → tài liệu + solution) ─
  // Sai hình thì lỗi ngay tại đây, trước khi băm chống trùng.
  let tfContent: ReturnType<typeof buildTruefalseContent> | undefined;
  if (item.qtype === 'truefalse') {
    const built = buildTruefalseContent(item.questionText, item.answers);
    if (!built) {
      return {
        kind: 'error',
        code: 'question.bad_answer_data',
        message: 'truefalse (TF-A) questions take a stem plus exactly four statements, each with a true/false value',
        fieldPath: '/answers',
      };
    }
    tfContent = built;
  }

  // ── Lớp 5b: chống trùng ở cổng tạo (cùng cơ chế QB-4) ─────────
  // TF-A sai hình đã bị chặn ở trên nên duplicateCheckInput không null
  // tại đây; các qtype khác luôn có dữ kiện băm.
  const dupInput = duplicateCheckInput(item.qtype, item.questionText, item.answers);
  if (!dupInput) {
    return {
      kind: 'error',
      code: 'question.bad_answer_data',
      message: 'truefalse (TF-A) questions take a stem plus exactly four statements, each with a true/false value',
      fieldPath: '/answers',
    };
  }
  const dup = await deps.banks.findDuplicatesForPayload(bank, {
    qtype: item.qtype,
    questionText: dupInput.questionText,
    answers: dupInput.answers,
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
    await deps.idempotency.store({ userId: actor.userId, key: idempotencyKey, tool, requestHash, response: { ...response } });
    await auditCall(deps, actor, tool, { result: 'duplicate_exact', bankId: bank.id, existingQuestionId: dup.exactId });
    return { kind: 'ok', response, replayed: false };
  }

  // ── Lớp 2: ĐÚNG đường của REST — parse bằng createQuestionSchema
  // rồi gọi QuestionsService (capability question:add tại context
  // category do service tự kiểm lại). ─────────────────────────────
  const serviceInput = {
    categoryId,
    qtype: item.qtype,
    // TF-A: thân câu là tài liệu đã dựng (paragraph thân + statementList),
    // đáp án từng mệnh đề đi qua solution; các qtype khác gửi chuỗi thuần
    // + đáp án đã chuẩn hoá cờ đúng/sai.
    questionText: tfContent ? tfContent.questionText : item.questionText,
    generalFeedback: item.generalFeedback,
    guidance: item.guidance,
    defaultMark: item.defaultMark,
    penalty: item.penalty,
    stimulusId: item.stimulusId,
    answers: item.qtype === 'truefalse' ? undefined : normalizeMcpAnswers(item.qtype, item.answers),
    options: item.options,
    ...(tfContent ? { solution: tfContent.solution } : {}),
    sourceKind: 'ai' as const,
    sourceRef: `client:${actor.clientId}`,
  };
  let view;
  try {
    const parsed = createQuestionSchema.parse(serviceInput);
    view = await deps.questions.createQuestion(actor.userId, parsed);
  } catch (error) {
    const zod = asZodIssue(error);
    if (zod) {
      await auditCall(deps, actor, tool, { result: 'error', code: 'question.bad_answer_data', bankId: bank.id });
      return { kind: 'error', code: 'question.bad_answer_data', message: zod.message, fieldPath: zod.fieldPath };
    }
    const { code, message } = errorShape(error);
    await auditCall(deps, actor, tool, { result: 'error', code, bankId: bank.id });
    return { kind: 'error', code, message, fieldPath: FIELDPATH_BY_CODE[code] };
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
  await deps.idempotency.store({ userId: actor.userId, key: idempotencyKey, tool, requestHash, response: { ...response } });
  await auditCall(deps, actor, tool, {
    result: 'created',
    bankId: bank.id,
    questionId: view.question.id,
    nearDuplicateOf: dup.nearId,
  });
  return { kind: 'ok', response, replayed: false };
}

/** Đăng ký các tool MCP lên một McpServer vừa dựng cho đúng một actor (mỗi request một server). */
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
        'Create ONE question (multichoice, truefalse, shortanswer or essay) in the teacher\'s OWN personal question bank. Content is plain text only — no HTML. Answers: multichoice needs exactly 4 choices with exactly one marked correct; truefalse takes a stem plus exactly 4 statements, each with a true/false value (the question is a 4-statement true/false cluster); shortanswer takes acceptable answers (every listed answer is accepted); essay takes no answers. The question is stored as a DRAFT (source: AI) and must be reviewed and published by the teacher in the web UI before it can be used in any quiz. Retrying with the same idempotencyKey and the same payload is safe and returns the original result; the same key with a different payload is an error. If an identical question already exists in the bank, the result is duplicate_exact with the existing questionId and nothing is created.',
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
      if (!clean.questionText.trim()) return errResult('question.invalid_content', 'Question text must not be blank', '/questionText');

      const { idempotencyKey, bankId, categoryId } = clean;

      // ── Lớp 4 (cổng bank cá nhân) + lớp 5 (lõi tạo) dùng chung ───
      const gate = await gatePersonalBankWrite(deps, actor, 'create_question', bankId, categoryId);
      if (gate.kind === 'error') return errResult(gate.code, gate.message, gate.fieldPath);
      const outcome = await createDraftQuestionCore(deps, actor, {
        tool: 'create_question',
        bank: gate.bank,
        categoryId,
        item: clean,
        idempotencyKey,
      });
      if (outcome.kind === 'error') return errResult(outcome.code, outcome.message, outcome.fieldPath);
      const response = outcome.response;
      if (outcome.replayed) {
        return okResult({ ...response }, 'Idempotent replay: this create was already processed; returning the original result.');
      }
      if (response.status === 'duplicate_exact') {
        return okResult({ ...response }, `An identical question already exists in this bank (${response.existingQuestionId}); nothing was created.`);
      }
      return okResult(
        { ...response },
        response.nearDuplicateOf
          ? `Created draft question ${response.questionId}. Note: a similar question already exists (${response.nearDuplicateOf}). Review and publish it in the web UI before use.`
          : `Created draft question ${response.questionId}. Review and publish it in the web UI before use.`,
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
        // Câu hỏi không có trường tên — tóm tắt bằng trích đoạn nội dung.
        const excerpt = extractRichTextPlainText(view.latestVersion.questionText as never).replace(/\s+/g, ' ').slice(0, 120);
        return okResult(projected as unknown as Record<string, unknown>, `Question (${view.question.qtype}): ${excerpt}.`);
      } catch (error) {
        const { code, message } = errorShape(error);
        await auditCall(deps, actor, 'get_question', { result: 'error', code, questionId });
        return errResult(code, message);
      }
    },
  );

  server.registerTool(
    'submit_contribution',
    {
      title: 'Submit my questions to a shared bank for review',
      description:
        'Propose one or more of YOUR OWN ready questions for inclusion in a shared question bank (team, school or course bank). Each accepted proposal becomes a PENDING contribution in the target bank; a human moderator of that bank must approve it before the question is copied in — this tool cannot write into a shared bank directly. Questions must belong to you and already be in ready status (drafts are rejected per question). The target must not be a personal bank. Results are per question: pending with a contributionId, or failed with the business error code. Retrying with the same idempotencyKey and the same payload returns the original result; the same key with a different payload is an error.',
      inputSchema: mcpSubmitContributionInputSchema,
      outputSchema: mcpSubmitContributionOutputSchema,
    },
    async (rawArgs) => {
      const args = rawArgs as McpSubmitContributionInput;

      // ── Lớp 3: nội dung (ghi chú đóng góp — quét ký tự cấm → NFC) ──
      const violations: ContentViolation[] = [];
      scanContent(args, violations, '', new Set(['/targetBankId', '/idempotencyKey']));
      if (violations.length > 0) {
        const first = violations[0]!;
        await auditCall(deps, actor, 'submit_contribution', { result: 'invalid_content', fieldPath: first.fieldPath });
        return errResult('question.invalid_content', first.message, first.fieldPath);
      }
      const clean = normalizeContentStrings(args);
      const { idempotencyKey, targetBankId, questionIds } = clean;
      const note = clean.note ?? '';

      // ── Trần scope (phòng thủ tầng tool; cổng chính ở mount trả HTTP
      // 403 insufficient_scope — research Phần 2.2/3.2): scope OAuth
      // chỉ là TRẦN, quyền nghiệp vụ thật do proposeContribution kiểm
      // bằng capability tại context như đường REST. ─────────────────
      if (!actor.scopes.includes('lms.banks.contribute')) {
        await auditCall(deps, actor, 'submit_contribution', { result: 'insufficient_scope', bankId: targetBankId });
        return errResult('insufficient_scope', 'This tool requires the OAuth scope "lms.banks.contribute"');
      }

      // ── Bank đích phải tồn tại (mọi cổng đích còn lại — personal,
      // trùng, quyền share — do proposeContribution giữ như REST). ──
      try {
        await deps.banks.getBankOrThrow(targetBankId);
      } catch {
        await auditCall(deps, actor, 'submit_contribution', { result: 'bank_not_found', bankId: targetBankId });
        return errResult('question.bank_not_found', `Question bank ${targetBankId} not found`, '/targetBankId');
      }

      // ── Idempotency (cùng khuôn create_question / đặc tả 2026-07-28)
      const { idempotencyKey: _key, ...hashPayload } = clean;
      const requestHash = mcpRequestHash('submit_contribution', hashPayload);
      const existing = await deps.idempotency.find(actor.userId, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          await auditCall(deps, actor, 'submit_contribution', { result: 'idempotency_conflict', bankId: targetBankId });
          return errResult(
            'question.idempotency_conflict',
            'This idempotencyKey was already used with a different payload. Use a new key for a different submission.',
          );
        }
        const stored = existing.responseJson as unknown as McpSubmitContributionOutput;
        await auditCall(deps, actor, 'submit_contribution', { result: 'idempotent_replay', bankId: targetBankId });
        return okResult({ ...stored }, 'Idempotent replay: this submission was already processed; returning the original result.');
      }

      // ── Từng câu: cổng chủ sở hữu ở biên MCP (câu phải của chính chủ
      // token), rồi ĐÚNG đường QB-4 — proposeContribution tự kiểm
      // question:share tại context bank nguồn, trạng thái ready, đích
      // không phải bank personal, trùng trong bank đích. ─────────────
      const results: McpSubmitContributionOutput['results'] = [];
      for (const questionId of questionIds) {
        // Qua facade QuestionsService (sau tái cấu trúc module #138):
        // câu không tồn tại → service ném question.not_found.
        let createdBy: string | null;
        try {
          createdBy = (await deps.questions.getQuestion(questionId)).question.createdBy;
        } catch {
          results.push({ questionId, status: 'failed', contributionId: null, code: 'question.not_found', message: `Question ${questionId} not found` });
          continue;
        }
        if (createdBy !== actor.userId) {
          results.push({
            questionId, status: 'failed', contributionId: null,
            code: 'question.contribution_source_not_own',
            message: 'Only your own questions can be submitted as a contribution',
          });
          continue;
        }
        try {
          const contribution = await deps.banks.proposeContribution(actor.userId, targetBankId, { questionId, note });
          results.push({ questionId, status: 'pending', contributionId: contribution.id, code: null, message: null });
        } catch (error) {
          const { code, message } = errorShape(error);
          results.push({ questionId, status: 'failed', contributionId: null, code, message });
        }
      }

      const created = results.filter((r) => r.status === 'pending').length;
      const response: McpSubmitContributionOutput = {
        targetBankId,
        results,
        created,
        failed: results.length - created,
      };
      await deps.idempotency.store({ userId: actor.userId, key: idempotencyKey, tool: 'submit_contribution', requestHash, response: { ...response } });
      await auditCall(deps, actor, 'submit_contribution', {
        result: created === results.length ? 'ok' : created > 0 ? 'partial' : 'failed',
        bankId: targetBankId,
        requested: results.length,
        created,
        failed: response.failed,
        contributionIds: results.filter((r) => r.contributionId).map((r) => r.contributionId),
      });
      return okResult(
        { ...response },
        created === results.length
          ? `Submitted ${created} question(s) to bank ${targetBankId}; each is a pending contribution awaiting moderator approval.`
          : `Submitted ${created} of ${results.length} question(s) to bank ${targetBankId}; see per-question results for the failures.`,
      );
    },
  );

  // ══ Lát MCP-1 (issue #163) ═══════════════════════════════════════

  server.registerTool(
    'create_questions_batch',
    {
      title: 'Create many draft questions in my personal bank (per-item results)',
      description:
        'Create MANY draft questions in the teacher\'s OWN personal bank in one call. Results are PER ITEM: an item that duplicates an existing question exactly returns duplicate_exact, an invalid item returns failed with the business code and fieldPath, and the other items still run. Optional shared stimuli can be declared once in "stimuli" (each with a short "ref") and referenced from items via stimulusRef; an item may instead reference an existing stimulusId — never both. Every item is idempotent on its own key derived from the batch idempotencyKey plus the item\'s clientItemId: retrying the same batch is safe and replays per-item results. All created questions are DRAFTS (source: AI) awaiting teacher review.',
      inputSchema: mcpCreateQuestionsBatchInputSchema,
      outputSchema: mcpCreateQuestionsBatchOutputSchema,
    },
    async (rawArgs) => {
      const args = rawArgs as McpCreateQuestionsBatchInput;

      // ── Lớp 3: quét nội dung theo TỪNG item/ngữ liệu (đường dẫn
      // fieldPath giữ nguyên chỉ số thật trong payload gốc). ───────
      const violations: ContentViolation[] = [];
      (args.stimuli ?? []).forEach((stimulus, index) => {
        scanContent(stimulus, violations, `/stimuli/${index}`, new Set([`/stimuli/${index}/ref`]));
      });
      args.items.forEach((item, index) => {
        scanContent(item, violations, `/items/${index}`, new Set([
          `/items/${index}/clientItemId`,
          `/items/${index}/stimulusId`,
          `/items/${index}/stimulusRef`,
        ]));
      });
      if (violations.length > 0) {
        const first = violations[0]!;
        await auditCall(deps, actor, 'create_questions_batch', { result: 'invalid_content', fieldPath: first.fieldPath });
        return errResult('question.invalid_content', first.message, first.fieldPath);
      }
      const clean = normalizeContentStrings(args);
      const { bankId, categoryId, idempotencyKey } = clean;

      // ── Lớp 4: cổng bank cá nhân cho cả lô ───────────────────────
      const gate = await gatePersonalBankWrite(deps, actor, 'create_questions_batch', bankId, categoryId);
      if (gate.kind === 'error') return errResult(gate.code, gate.message, gate.fieldPath);

      // ── Ngữ liệu khai trong lô: tạo trước, có idempotency riêng
      // theo (khoá lô) để phát lại cả lô không nhân đôi ngữ liệu. ──
      const stimuliResults: McpCreateQuestionsBatchOutput['stimuli'] = [];
      const stimulusIdByRef = new Map<string, string>();
      const declaredStimuli = clean.stimuli ?? [];
      if (declaredStimuli.length > 0) {
        const stimuliKey = `${idempotencyKey}:stimuli`;
        const stimuliHash = mcpRequestHash('create_questions_batch:stimuli', declaredStimuli);
        const storedStimuli = await deps.idempotency.find(actor.userId, stimuliKey);
        let storedMap: Record<string, string> | null = null;
        if (storedStimuli) {
          if (storedStimuli.requestHash !== stimuliHash) {
            return errResult(
              'question.idempotency_conflict',
              'This idempotencyKey was already used with different stimuli. Use a new key for a different batch.',
            );
          }
          storedMap = (storedStimuli.responseJson as { byRef?: Record<string, string> }).byRef ?? {};
        }
        for (const stimulus of declaredStimuli) {
          const replayedId = storedMap?.[stimulus.ref];
          if (replayedId) {
            stimulusIdByRef.set(stimulus.ref, replayedId);
            stimuliResults.push({ ref: stimulus.ref, stimulusId: replayedId, status: 'created', code: null, message: null });
            continue;
          }
          try {
            const row = await deps.questions.createStimulus(actor.userId, { categoryId, content: stimulus.content });
            stimulusIdByRef.set(stimulus.ref, row.id);
            stimuliResults.push({ ref: stimulus.ref, stimulusId: row.id, status: 'created', code: null, message: null });
          } catch (error) {
            const { code, message } = errorShape(error);
            stimuliResults.push({ ref: stimulus.ref, stimulusId: null, status: 'failed', code, message });
          }
        }
        if (!storedMap) {
          const byRef: Record<string, string> = {};
          for (const [ref, id] of stimulusIdByRef) byRef[ref] = id;
          await deps.idempotency.store({
            userId: actor.userId,
            key: stimuliKey,
            tool: 'create_questions_batch:stimuli',
            requestHash: stimuliHash,
            response: { byRef },
          });
        }
      }

      // ── Từng item qua lõi tạo (idempotency suy từ khoá lô) ──────
      const results: McpBatchItemResult[] = [];
      for (const item of clean.items) {
        const failedItem = (code: string, message: string, fieldPath?: string): McpBatchItemResult => ({
          clientItemId: item.clientItemId,
          status: 'failed',
          questionId: null,
          existingQuestionId: null,
          entryId: null,
          version: null,
          questionStatus: null,
          duplicate: 'none',
          nearDuplicateOf: null,
          reviewUrl: null,
          code,
          message,
          fieldPath: fieldPath ?? null,
        });
        if (!item.questionText.trim()) {
          results.push(failedItem('question.invalid_content', 'Question text must not be blank', '/questionText'));
          continue;
        }
        if (item.stimulusId && item.stimulusRef) {
          results.push(failedItem('question.stimulus_ref_conflict', 'Use either stimulusId or stimulusRef for an item, not both', '/stimulusRef'));
          continue;
        }
        let stimulusId = item.stimulusId;
        if (item.stimulusRef) {
          stimulusId = stimulusIdByRef.get(item.stimulusRef);
          if (!stimulusId) {
            results.push(failedItem('question.stimulus_unavailable', `Stimulus ref "${item.stimulusRef}" was not created in this batch`, '/stimulusRef'));
            continue;
          }
        }
        const outcome = await createDraftQuestionCore(deps, actor, {
          tool: 'create_questions_batch',
          bank: gate.bank,
          categoryId,
          item: { ...item, stimulusId },
          idempotencyKey: `${idempotencyKey}:${item.clientItemId}`,
        });
        if (outcome.kind === 'error') {
          results.push(failedItem(outcome.code, outcome.message, outcome.fieldPath));
          continue;
        }
        const r = outcome.response;
        results.push({
          clientItemId: item.clientItemId,
          status: r.status,
          questionId: r.questionId,
          existingQuestionId: r.existingQuestionId,
          entryId: r.entryId,
          version: r.version,
          questionStatus: r.questionStatus,
          duplicate: r.duplicate,
          nearDuplicateOf: r.nearDuplicateOf,
          reviewUrl: r.reviewUrl,
          code: null,
          message: null,
          fieldPath: null,
        });
      }

      const createdCount = results.filter((r) => r.status === 'created').length;
      const response: McpCreateQuestionsBatchOutput = {
        bankId,
        categoryId,
        stimuli: stimuliResults,
        results,
        created: createdCount,
        failed: results.filter((r) => r.status === 'failed').length,
      };
      await auditCall(deps, actor, 'create_questions_batch', {
        result: response.failed === 0 ? 'ok' : createdCount > 0 ? 'partial' : 'failed',
        bankId,
        requested: results.length,
        created: createdCount,
        failed: response.failed,
        questionIds: results.filter((r) => r.questionId).map((r) => r.questionId),
      });
      return okResult(
        { ...response },
        `Batch done: ${createdCount} draft question(s) created, ${response.failed} failed, ${results.length - createdCount - response.failed} duplicate(s) skipped. Review and publish drafts in the web UI before use.`,
      );
    },
  );

  server.registerTool(
    'create_stimulus_with_questions',
    {
      title: 'Create a stimulus and its questions atomically',
      description:
        'Create ONE shared stimulus (reading passage / context text) plus a group of questions that all reference it, in the teacher\'s OWN personal bank. Unlike the batch tool this is ATOMIC: the stimulus and every question are written in a single transaction — if any question is invalid or duplicates an existing question exactly, NOTHING is created and the call fails. All questions become DRAFTS (source: AI) attached to the new stimulus. Retrying with the same idempotencyKey and payload returns the original result.',
      inputSchema: mcpCreateStimulusWithQuestionsInputSchema,
      outputSchema: mcpCreateStimulusWithQuestionsOutputSchema,
    },
    async (rawArgs) => {
      const args = rawArgs as McpCreateStimulusWithQuestionsInput;

      // ── Lớp 3: nội dung ──────────────────────────────────────────
      const violations: ContentViolation[] = [];
      scanContent(args, violations, '', new Set(['/bankId', '/categoryId', '/idempotencyKey']));
      if (violations.length > 0) {
        const first = violations[0]!;
        await auditCall(deps, actor, 'create_stimulus_with_questions', { result: 'invalid_content', fieldPath: first.fieldPath });
        return errResult('question.invalid_content', first.message, first.fieldPath);
      }
      const clean = normalizeContentStrings(args);
      const { bankId, categoryId, idempotencyKey } = clean;
      if (!clean.stimulusContent.trim()) {
        return errResult('question.invalid_content', 'Stimulus content must not be blank', '/stimulusContent');
      }
      for (const [index, question] of clean.questions.entries()) {
        if (!question.questionText.trim()) {
          return errResult('question.invalid_content', 'Question text must not be blank', `/questions/${index}`);
        }
      }

      // ── Lớp 4: cổng bank cá nhân ─────────────────────────────────
      const gate = await gatePersonalBankWrite(deps, actor, 'create_stimulus_with_questions', bankId, categoryId);
      if (gate.kind === 'error') return errResult(gate.code, gate.message, gate.fieldPath);

      // ── Idempotency của cả nhóm ──────────────────────────────────
      const { idempotencyKey: _key, ...hashPayload } = clean;
      const requestHash = mcpRequestHash('create_stimulus_with_questions', hashPayload);
      const existing = await deps.idempotency.find(actor.userId, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          await auditCall(deps, actor, 'create_stimulus_with_questions', { result: 'idempotency_conflict', bankId });
          return errResult(
            'question.idempotency_conflict',
            'This idempotencyKey was already used with a different payload. Use a new key for a different group.',
          );
        }
        const stored = existing.responseJson as unknown as { stimulusId: string; results: McpCreateQuestionOutput[]; created: number };
        await auditCall(deps, actor, 'create_stimulus_with_questions', { result: 'idempotent_replay', bankId });
        return okResult({ ...stored }, 'Idempotent replay: this group was already created; returning the original result.');
      }

      // ── Kiểm trước TOÀN BỘ nhóm (truefalse + trùng exact) trước
      // khi ghi bất cứ thứ gì — nguyên tử bắt đầu từ biên MCP. ──────
      const nearByIndex = new Map<number, string | null>();
      for (const [index, question] of clean.questions.entries()) {
        // TF-A sai hình chặn ngay tại đây (trước khi ghi bất cứ thứ gì);
        // các qtype khác luôn có dữ kiện băm chống trùng.
        const dupInput = duplicateCheckInput(question.qtype, question.questionText, question.answers);
        if (!dupInput) {
          return errResult(
            'question.bad_answer_data',
            'truefalse (TF-A) questions take a stem plus exactly four statements, each with a true/false value',
            `/questions/${index}/answers`,
          );
        }
        const dup = await deps.banks.findDuplicatesForPayload(gate.bank, {
          qtype: question.qtype,
          questionText: dupInput.questionText,
          answers: dupInput.answers,
        });
        if (dup.exactId) {
          await auditCall(deps, actor, 'create_stimulus_with_questions', { result: 'duplicate_exact', bankId, existingQuestionId: dup.exactId });
          return errResult(
            'question.duplicate_exact',
            `Question ${index + 1} of the group is identical to an existing question (${dup.exactId}); nothing was created.`,
            `/questions/${index}`,
          );
        }
        nearByIndex.set(index, dup.nearId);
      }

      // ── Ghi nguyên tử ở tầng service (một giao dịch: ngữ liệu +
      // mọi câu qua cùng lõi ghi của createQuestion). ──────────────
      let group;
      try {
        const serviceQuestions = clean.questions.map((question) => {
          const tfContent = question.qtype === 'truefalse' ? buildTruefalseContent(question.questionText, question.answers) : null;
          const parsed = createQuestionSchema.parse({
            categoryId,
            qtype: question.qtype,
            questionText: tfContent ? tfContent.questionText : question.questionText,
            generalFeedback: question.generalFeedback,
            guidance: question.guidance,
            defaultMark: question.defaultMark,
            penalty: question.penalty,
            answers: question.qtype === 'truefalse' ? undefined : normalizeMcpAnswers(question.qtype, question.answers),
            options: question.options,
            ...(tfContent ? { solution: tfContent.solution } : {}),
            sourceKind: 'ai' as const,
            sourceRef: `client:${actor.clientId}`,
          });
          const { categoryId: _categoryId, stimulusId: _stimulusId, ...rest } = parsed as typeof parsed & { stimulusId?: string };
          return rest;
        });
        group = await deps.questions.createStimulusWithQuestions(actor.userId, {
          categoryId,
          content: clean.stimulusContent,
          questions: serviceQuestions,
        });
      } catch (error) {
        const zod = asZodIssue(error);
        if (zod) {
          await auditCall(deps, actor, 'create_stimulus_with_questions', { result: 'error', code: 'question.bad_answer_data', bankId });
          return errResult('question.bad_answer_data', zod.message, zod.fieldPath);
        }
        const { code, message } = errorShape(error);
        await auditCall(deps, actor, 'create_stimulus_with_questions', { result: 'error', code, bankId });
        return errResult(code, message, FIELDPATH_BY_CODE[code]);
      }

      // Câu MCP luôn vào draft (như create_question).
      const results: McpCreateQuestionOutput[] = [];
      for (const [index, view] of group.questions.entries()) {
        await deps.banks.setQuestionStatus(view.question.id, 'draft');
        const nearId = nearByIndex.get(index) ?? null;
        results.push({
          status: 'created',
          questionId: view.question.id,
          existingQuestionId: null,
          entryId: view.entry.id,
          version: view.latestVersion.version,
          questionStatus: 'draft',
          duplicate: nearId ? 'near' : 'none',
          nearDuplicateOf: nearId,
          reviewUrl: `${deps.publicBaseUrl}/questions`,
        });
      }
      const response = { stimulusId: group.stimulus.id, results, created: results.length };
      await deps.idempotency.store({ userId: actor.userId, key: idempotencyKey, tool: 'create_stimulus_with_questions', requestHash, response: { ...response } });
      await auditCall(deps, actor, 'create_stimulus_with_questions', {
        result: 'created',
        bankId,
        questionId: results[0]?.questionId ?? null,
        created: results.length,
        questionIds: results.map((r) => r.questionId),
      });
      return okResult(
        { ...response },
        `Created stimulus ${group.stimulus.id} with ${results.length} draft question(s) attached. Review and publish them in the web UI before use.`,
      );
    },
  );

  server.registerTool(
    'publish_questions',
    {
      title: 'Publish my draft questions (draft → ready)',
      description:
        'Publish one or more of YOUR OWN draft questions from your personal bank to ready status, through the same business path the web UI uses. Results are per question: published, or failed with the reason (question not yours / not found, or not currently a draft). Only questions in your own personal bank can be published this way. Retrying with the same idempotencyKey and the same question list returns the original result.',
      inputSchema: mcpPublishQuestionsInputSchema,
      outputSchema: mcpPublishQuestionsOutputSchema,
    },
    async (rawArgs) => {
      const args = rawArgs as { questionIds: string[]; idempotencyKey: string };

      // ── Trần scope (phòng thủ tầng tool; cổng chính ở mount). ────
      if (!actor.scopes.includes('lms.questions.write')) {
        await auditCall(deps, actor, 'publish_questions', { result: 'insufficient_scope' });
        return errResult('insufficient_scope', 'This tool requires the OAuth scope "lms.questions.write"');
      }
      const { questionIds, idempotencyKey } = args;

      // ── Idempotency của cả lượt publish ──────────────────────────
      const requestHash = mcpRequestHash('publish_questions', { questionIds });
      const existing = await deps.idempotency.find(actor.userId, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          await auditCall(deps, actor, 'publish_questions', { result: 'idempotency_conflict' });
          return errResult(
            'question.idempotency_conflict',
            'This idempotencyKey was already used with a different payload. Use a new key for a different publish run.',
          );
        }
        const stored = existing.responseJson as unknown as McpPublishQuestionsOutput;
        await auditCall(deps, actor, 'publish_questions', { result: 'idempotent_replay' });
        return okResult({ ...stored }, 'Idempotent replay: this publish run was already processed; returning the original result.');
      }

      // ── Từng câu: của chính chủ + trong bank cá nhân của chủ +
      // đang draft → setQuestionStatus('ready') như đường web. ─────
      const results: McpPublishQuestionsOutput['results'] = [];
      for (const questionId of questionIds) {
        let view;
        try {
          view = await deps.questions.getQuestion(questionId);
        } catch {
          results.push({ questionId, status: 'failed', code: 'question.not_found', message: `Question ${questionId} not found` });
          continue;
        }
        if (view.question.createdBy !== actor.userId) {
          results.push({ questionId, status: 'failed', code: 'question.not_found', message: `Question ${questionId} not found` });
          continue;
        }
        let bank: BankRow | null = null;
        try {
          const category = await deps.questions.getCategory(view.question.category);
          bank = await deps.banks.findBankForCategory(category);
        } catch {
          bank = null;
        }
        if (!bank || bank.scope !== 'personal' || bank.ownerId !== actor.userId || bank.bankKind !== 'question') {
          results.push({ questionId, status: 'failed', code: 'question.not_found', message: `Question ${questionId} not found` });
          continue;
        }
        const caps = await deps.banks.bankCapabilities(actor.userId, bank);
        if (!caps.edit) {
          results.push({ questionId, status: 'failed', code: 'question.forbidden', message: 'You do not have permission to edit questions in this bank' });
          continue;
        }
        if (view.entry.status !== 'draft') {
          results.push({
            questionId,
            status: 'failed',
            code: 'question.publish_not_draft',
            message: `Question ${questionId} is not a draft (current status: ${view.entry.status}); only drafts can be published`,
          });
          continue;
        }
        try {
          await deps.banks.setQuestionStatus(questionId, 'ready');
          results.push({ questionId, status: 'published', code: null, message: null });
        } catch (error) {
          const { code, message } = errorShape(error);
          results.push({ questionId, status: 'failed', code, message });
        }
      }

      const published = results.filter((r) => r.status === 'published').length;
      const response: McpPublishQuestionsOutput = { results, published, failed: results.length - published };
      await deps.idempotency.store({ userId: actor.userId, key: idempotencyKey, tool: 'publish_questions', requestHash, response: { ...response } });
      await auditCall(deps, actor, 'publish_questions', {
        result: published === results.length ? 'ok' : published > 0 ? 'partial' : 'failed',
        questionId: questionIds[0] ?? null,
        requested: results.length,
        published,
        failed: response.failed,
        questionIds,
      });
      return okResult(
        { ...response },
        published === results.length
          ? `Published ${published} question(s); they are now ready to use.`
          : `Published ${published} of ${results.length} question(s); see per-question results for the failures.`,
      );
    },
  );

  server.registerTool(
    'search_questions',
    {
      title: 'Search questions in a bank (metadata only)',
      description:
        'Search the questions of one bank you can view by a text fragment (matched against question text, case-insensitive), optionally filtered by qtype. Returns METADATA only (id, qtype, status, category, whether it is yours) — use get_question for full content. Use this to find existing questions before creating new ones.',
      inputSchema: mcpSearchQuestionsInputSchema,
      outputSchema: mcpSearchQuestionsOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (rawArgs) => {
      const args = rawArgs as { bankId: string; query: string; qtype?: string; limit?: number };
      const { bankId } = args;
      let bank: BankRow;
      try {
        bank = await deps.banks.getBankOrThrow(bankId);
      } catch {
        return errResult('question.bank_not_found', `Question bank ${bankId} not found`, '/bankId');
      }
      try {
        await deps.banks.getBank(actor.userId, bankId);
      } catch (error) {
        const { code, message } = errorShape(error);
        await auditCall(deps, actor, 'search_questions', { result: 'error', code, bankId });
        return errResult(code, message, '/bankId');
      }
      const needle = normalizeContentStrings(args.query).trim().toLowerCase();
      if (!needle) return errResult('question.invalid_content', 'Search query must not be blank', '/query');
      const limit = args.limit ?? 20;
      const matches: {
        id: string; qtype: string; status: string;
        categoryId: string; categoryName: string; mine: boolean;
      }[] = [];
      const all = await deps.questions.listCategories();
      for (const cat of all) {
        if (!(await deps.banks.categoryBelongsToBank(cat, bank))) continue;
        let views;
        try {
          views = await deps.questions.listQuestionsForViewer(actor.userId, cat.id);
        } catch {
          continue; // Category không đọc được → vắng khỏi kết quả như không tồn tại.
        }
        for (const view of views) {
          if (args.qtype && view.question.qtype !== args.qtype) continue;
          // Câu hỏi không có trường tên — chỉ soi trong thân câu.
          const plainText = extractRichTextPlainText(view.latestVersion.questionText as never);
          const haystack = plainText.normalize('NFC').toLowerCase();
          if (!haystack.includes(needle)) continue;
          matches.push({
            id: view.question.id,
            qtype: view.question.qtype,
            status: view.entry.status,
            categoryId: cat.id,
            categoryName: cat.name,
            mine: view.question.createdBy === actor.userId,
          });
        }
      }
      const truncated = matches.length > limit;
      const questions = matches.slice(0, limit);
      await auditCall(deps, actor, 'search_questions', { result: 'ok', bankId, count: questions.length, truncated });
      return okResult(
        { bankId, questions, truncated },
        truncated
          ? `Found more than ${limit} matching question(s); showing the first ${limit}. Narrow the query to see the rest.`
          : `Found ${questions.length} matching question(s).`,
      );
    },
  );

  server.registerTool(
    'check_duplicates',
    {
      title: 'Check questions for duplicates without creating anything',
      description:
        'Check candidate questions against one bank for exact or near duplicates using the same content-hash mechanism as the create gate (QB-4). Nothing is written. Verdicts are per item: exact (an identical question exists — creating would be skipped), near (a similar question exists), or none. Run this before create_questions_batch to skip duplicates up front.',
      inputSchema: mcpCheckDuplicatesInputSchema,
      outputSchema: mcpCheckDuplicatesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (rawArgs) => {
      const args = rawArgs as McpCheckDuplicatesInput;
      const { bankId } = args;

      const violations: ContentViolation[] = [];
      args.items.forEach((item, index) => {
        scanContent(item, violations, `/items/${index}`, new Set([`/items/${index}/clientItemId`]));
      });
      if (violations.length > 0) {
        const first = violations[0]!;
        await auditCall(deps, actor, 'check_duplicates', { result: 'invalid_content', fieldPath: first.fieldPath });
        return errResult('question.invalid_content', first.message, first.fieldPath);
      }
      const clean = normalizeContentStrings(args);

      let bank: BankRow;
      try {
        bank = await deps.banks.getBankOrThrow(bankId);
      } catch {
        return errResult('question.bank_not_found', `Question bank ${bankId} not found`, '/bankId');
      }
      try {
        await deps.banks.getBank(actor.userId, bankId);
      } catch (error) {
        const { code, message } = errorShape(error);
        await auditCall(deps, actor, 'check_duplicates', { result: 'error', code, bankId });
        return errResult(code, message, '/bankId');
      }

      const results = [];
      for (const item of clean.items) {
        // Đường soi trùng không ghi gì: câu TF-A sai hình không băm
        // được thì quy về `none` (không phải trùng của câu nào đã có).
        const dupInput = duplicateCheckInput(item.qtype, item.questionText, item.answers);
        const dup = dupInput
          ? await deps.banks.findDuplicatesForPayload(bank, {
              qtype: item.qtype,
              questionText: dupInput.questionText,
              answers: dupInput.answers,
            })
          : { exactId: null, nearId: null };
        results.push({
          clientItemId: item.clientItemId,
          verdict: dup.exactId ? ('exact' as const) : dup.nearId ? ('near' as const) : ('none' as const),
          existingQuestionId: dup.exactId,
          nearDuplicateOf: dup.nearId,
        });
      }
      await auditCall(deps, actor, 'check_duplicates', { result: 'ok', bankId, count: results.length });
      return okResult(
        { bankId, results },
        `Checked ${results.length} candidate(s): ${results.filter((r) => r.verdict === 'exact').length} exact duplicate(s), ${results.filter((r) => r.verdict === 'near').length} near duplicate(s).`,
      );
    },
  );

  server.registerTool(
    'search_curriculum_outcomes',
    {
      title: 'Search official curriculum outcomes (YCCĐ)',
      description:
        'Search the OFFICIAL learning outcomes (yêu cầu cần đạt) of the national curriculum by keyword, optionally filtered by subject and grade level. Only subjects you are allowed to view are searched. Use the returned outcome ids and content to anchor the questions you author — always base questions on a real outcome from this tool instead of inventing outcome codes. Formal question-to-outcome linking still happens in exam matrices/quizzes, not here.',
      inputSchema: mcpSearchCurriculumOutcomesInputSchema,
      outputSchema: mcpSearchCurriculumOutcomesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (rawArgs) => {
      const args = rawArgs as { query: string; subjectId?: string; gradeLevel?: number; limit?: number };
      const violations: ContentViolation[] = [];
      scanContent({ query: args.query }, violations, '', new Set());
      if (violations.length > 0) {
        const first = violations[0]!;
        await auditCall(deps, actor, 'search_curriculum_outcomes', { result: 'invalid_content', fieldPath: first.fieldPath });
        return errResult('question.invalid_content', first.message, first.fieldPath);
      }
      const query = normalizeContentStrings(args.query).trim();
      if (!query) return errResult('question.invalid_content', 'Search query must not be blank', '/query');
      try {
        const outcomes = await deps.curriculum.searchOutcomes(actor.userId, {
          query,
          subjectId: args.subjectId,
          gradeLevel: args.gradeLevel,
          limit: args.limit,
        });
        await auditCall(deps, actor, 'search_curriculum_outcomes', { result: 'ok', count: outcomes.length });
        return okResult(
          { outcomes },
          outcomes.length > 0
            ? `Found ${outcomes.length} curriculum outcome(s). Anchor your questions to these exact outcomes.`
            : 'No curriculum outcome matches this query in the subjects you can view.',
        );
      } catch (error) {
        const { code, message } = errorShape(error);
        await auditCall(deps, actor, 'search_curriculum_outcomes', { result: 'error', code });
        return errResult(code, message);
      }
    },
  );
}
