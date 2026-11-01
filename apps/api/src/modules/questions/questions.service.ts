import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  cognitiveLevelSchema, extractRichTextPlainText, getTrueFalseStatements, richTextBlocksContainStatementList,
  richTextBlocksHaveContent, toRichTextDocument, TRUE_FALSE_STATEMENT_COUNT, uuidIdSchema,
  type RichTextDocument, type RichTextInput,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { FilesService } from '../files/files.service';
import { BEHAVIOURS, canTransition, gradeAnswer, gradedStateForFraction, usageState, type GradingData, type GradeOutcome, type QuestionState } from './domain/question-engine';
import {
  QuestionsRepository, type AnswerKeyRow, type AnswerRow, type AttemptRow, type EntryRow, type EssayOptionsRow,
  type MultichoiceOptionsRow, type QCategoryRow, type QuestionRow, type QuestionsTx,
  type ShortanswerOptionsRow, type StepRow, type StimulusRow, type UsageRow, type VersionRow,
} from '@lms/db/repositories/questions';

/** Một đáp án trong payload cấu trúc theo qtype (đầu vào của API): cờ `correct` đúng/sai NHỊ PHÂN — tỉ trọng fraction đã bỏ hẳn (quyết 12:04 ngày 26/10/2026). */
export interface QuestionAnswerInput {
  text: RichTextInput;
  correct?: boolean;
  feedback?: RichTextInput;
}

/** Options trong payload theo qtype — mỗi qtype chỉ dùng phần trường của nó (service kiểm chứng). */
export interface QuestionOptionsInput {
  shuffleAnswers?: boolean;
  answerNumbering?: string;
  showStandardInstruction?: boolean;
  correctFeedback?: RichTextInput;
  incorrectFeedback?: RichTextInput;
  useCase?: boolean;
  numericAnswer?: boolean;
  numericMaxLength?: number | null;
  numericAllowSign?: boolean;
  numericAllowDecimal?: boolean;
  responseFormat?: string;
  responseRequired?: boolean;
  responseFieldLines?: number;
  minWordLimit?: number | null;
  maxWordLimit?: number | null;
  graderInfo?: RichTextInput;
  responseTemplate?: RichTextInput;
}

/** Payload tạo/sửa câu hỏi: một payload cấu trúc, service tự bung ra bảng khi lưu. */
export interface QuestionContentInput {
  questionText?: RichTextInput;
  generalFeedback?: RichTextInput;
  /** Hướng dẫn (guidance) — ghi vào bản ghi phía đáp án `question_answer_keys` của version, KHÔNG còn nằm trên dòng version (quyết 12:12 ngày 26/10/2026). */
  guidance?: RichTextInput;
  defaultMark?: number;
  penalty?: number;
  stimulusId?: string | null;
  answers?: QuestionAnswerInput[];
  options?: QuestionOptionsInput;
  /**
   * Phía đáp án do người soạn gửi lên, ghi vào `question_answer_keys.solution`:
   * essay gửi lời giải mẫu dạng `{answer}`; truefalse TF-A gửi đáp án từng
   * mệnh đề dạng `{answers: [{statementId, value}]}`.
   */
  solution?: { answer: RichTextInput } | { answers: { statementId: string; value: boolean }[] };
}

export interface QuestionView {
  question: QuestionRow;
  entry: EntryRow;
  latestVersion: VersionRow;
  answers: AnswerRow[];
  /** Bản ghi phía đáp án của version (guidance + solution); luôn có mặt ở view — version không có dòng `question_answer_keys` thì cả hai trường đều null. */
  answerKey: { guidance: unknown; solution: unknown };
  options: Record<string, unknown> | null;
  stimulus: StimulusRow | null;
}
/** Gắn kết chương trình của một câu hỏi (issue #20 Chặng 2, mục A.6). */
export interface QuestionCurriculumLinksView {
  questionId: string;
  subjectIds: string[];
  outcomes: { outcomeId: string; cognitiveLevel: string }[];
}
export interface AttemptView extends AttemptRow {
  steps: { id: string; sequenceNumber: number; state: string; fraction: number | null; data: Record<string, string | null> }[];
}
export interface UsageView {
  usage: UsageRow;
  state: string;
  attempts: AttemptView[];
}

export const SUPPORTED_QTYPES = ['multichoice', 'truefalse', 'shortanswer', 'essay'] as const;
export type SupportedQtype = (typeof SUPPORTED_QTYPES)[number];

/**
 * Hình dạng solution LƯU TRỮ ở `question_answer_keys.solution`: lời giải
 * mẫu của essay (`{answer}`) hoặc đáp án Đúng/Sai từng mệnh đề của
 * truefalse TF-A (`{answers}` bám theo statementId của thân câu).
 */
type StoredSolution =
  | { answer: RichTextDocument }
  | { answers: { statementId: string; value: boolean }[] };

/** Nội dung đã chuẩn hoá, sẵn sàng ghi xuống question_answers + bảng options. */
interface NormalisedContent {
  answers: { answer: RichTextDocument; isCorrect: boolean; feedback: RichTextDocument | null }[];
  multichoice?: { shuffleAnswers: boolean; answerNumbering: string; correctFeedback: RichTextDocument | null; incorrectFeedback: RichTextDocument | null; showStandardInstruction: boolean };
  shortanswer?: { useCase: boolean; numericAnswer: boolean; numericMaxLength: number | null; numericAllowSign: boolean; numericAllowDecimal: boolean };
  essay?: { responseFormat: string; responseRequired: boolean; responseFieldLines: number; minWordLimit: number | null; maxWordLimit: number | null; graderInfo: RichTextDocument | null; responseTemplate: RichTextDocument | null };
  /** Nội dung phía đáp án ghi vào `question_answer_keys` cùng giao dịch với version: guidance (mọi qtype) + solution (essay: lời giải mẫu; truefalse TF-A: đáp án từng mệnh đề). Cả hai null thì không chèn dòng nào. */
  answerKey: { guidance: RichTextDocument | null; solution: StoredSolution | null };
}

/** Bóc lỗi vi phạm unique của PostgreSQL (23505) dù Drizzle có bọc qua cause hay không. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e !== null && typeof e === 'object') {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function badAnswerData(message: string): BadRequestException {
  return new BadRequestException({ message, code: 'question.bad_answer_data' });
}

/**
 * Facade của QuestionsModule (core_question của Moodle): BANK + ENGINE.
 *
 * Bất biến bank: sửa một câu hỏi KHÔNG BAO GIỜ thay đổi một version — nó tạo
 * version tiếp theo (với dòng answers/options riêng) và di chuyển con trỏ
 * latest của bank entry; usage tạo sau đó phân giải version mới,
 * attempt đã bắt đầu giữ version của chúng.
 *
 * Lưu trữ nội dung theo mô hình giaokhoa (quyết 12:04 + 12:12 ngày
 * 26/10/2026): đáp án nằm ở question_answers (cờ `isCorrect` nhị phân +
 * feedback theo đáp án — KHÔNG còn tỉ trọng), options ở bảng riêng của
 * qtype, questionText/generalFeedback là tài liệu Tiptap trên dòng
 * version, còn guidance + solution nằm ở bản ghi phía đáp án
 * `question_answer_keys` (1-1 với version, cùng giao dịch ghi). Câu hỏi
 * KHÔNG có tên — nhãn hiển thị là trích đoạn nội dung. API nhận MỘT
 * payload cấu trúc theo qtype; service bung payload ra các bảng khi lưu.
 *
 * Bất biến engine (questionusagebyactivity_test): một usage nhóm các attempt
 * theo (component, instanceId); bắt đầu một attempt PIN version latest hiện tại;
 * mọi chuyển đổi đều ghi một step (với step_data cho response);
 * deferredfeedback chấm khi kết thúc theo answers của version ĐÃ PIN
 * và options; trạng thái usage là tổng hợp của các attempt của nó.
 */
@Injectable()
/**
 * Ngân hàng câu hỏi và vòng đời làm bài (question engine).
 * Đối chiếu Moodle: lib/questionlib.php và question/engine.
 * Bất biến version: sửa câu hỏi tạo version mới, không sửa tại chỗ; attempt đã bắt đầu giữ nguyên
 * version đã pin nên điểm cũ không đổi; chấm điểm do question-engine domain thực hiện theo qtype và behaviour.
 */
export class QuestionsService {
  constructor(
    private readonly repo: QuestionsRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly outbox: OutboxService,
    private readonly files: FilesService,
  ) {}

  private async requireCap(actorId: string, capability: string, contextId: string): Promise<void> {
    // Context câu hỏi trong lõi này là context khoá học/hệ thống; các archetype
    // đã seed sống ở các cấp đó và evaluator đi dọc cây.
    await this.evaluator.requireCapability(actorId, capability, contextId);
  }
  // --- bank: cổng đọc (issue #55) -------------------------------------------
  // Đọc ngân hàng cũng là đọc NỘI DUNG THI (câu hỏi kèm đáp án): mọi đường
  // đọc câu hỏi/danh mục/phiên bản/ngữ liệu phải qua cổng capability
  // `question:useall` tại context của category chứa dữ liệu — cùng context
  // mà các đường ghi (question:add / question:editall /
  // question:managecategory) đã gác. Vai không có quyền nhận 404 mang mã
  // của chính tài nguyên "không tồn tại" — không oracle phân biệt "có
  // nhưng cấm" với "không có" (tiền lệ #44/#48). Các phương thức nội bộ
  // (getQuestion, listVersions...) KHÔNG gác: quiz/engine gọi ở tầng
  // service cho luồng làm bài của học sinh, luồng đó có cổng riêng của
  // hoạt động; cổng ở đây chỉ áp cho các phương thức *ForViewer mà
  // controller gọi.

  /** Actor có quyền dùng ngân hàng tại context này không (không ném). */
  private async canUseBank(actorId: string, contextId: string): Promise<boolean> {
    // Riêng tư bank personal (issue #123): context là context của một
    // bank personal thì chỉ chủ sở hữu (và site admin như bất biến hệ
    // thống) đọc được nội dung trong đó — capability kế thừa từ context
    // hệ thống của GV staff/manager KHÔNG mở bank riêng của đồng nghiệp.
    // Đây là cổng chung của mọi đường *ForViewer nên REST và MCP
    // (get_question dùng getQuestionForViewer) giữ parity tuyệt đối.
    const bank = await this.repo.getBankByContextId(contextId).catch(() => undefined);
    if (bank && bank.scope === 'personal' && bank.ownerId !== actorId) {
      const isAdmin = await this.evaluator.isSiteAdmin(actorId).catch(() => false);
      if (!isAdmin) return false;
    }
    return this.evaluator.hasCapability(actorId, 'question:useall', contextId).catch(() => false);
  }

  // --- riêng tư bank personal: cổng GHI (issue #123, vòng 2) ----------------
  // Sườn đọc đã gác bằng canUseBank/assert*Readable, nhưng các đường GHI
  // trước đây chỉ gác capability tại context: GV archetype editingteacher
  // kế thừa question:add/editall/managecategory từ context hệ thống xuống
  // context bank personal của đồng nghiệp nên sửa/xoá/chen được nội dung
  // trong bank riêng của người khác (phán quyết đánh giá PR #127
  // 6392040333). Cổng ghi dùng chung dưới đây áp cùng quy tắc chủ sở hữu
  // như tầng bank (isForeignPersonalBank ở QuestionBanksService): category
  // thuộc bank personal của người khác → tài nguyên "không tồn tại" đối
  // với actor (404 đúng mã not-found của chính tài nguyên đó, nhất quán
  // sườn đọc); site admin giữ toàn quyền như bất biến hiện hành.
  // Chỉ áp ở các method CÓ actorId mà controller gọi. Các đường nội bộ
  // tầng service không qua actor (quiz/engine cho attempt của học sinh)
  // không gọi các method này nên không đổi hành vi; MCP create_question
  // luôn gọi với actor = chủ token vào bank của chính chủ nên qua cổng
  // như thường.

  /** Bank chứa category: bankId tường minh trước, rồi bank sở hữu context của category. */
  private async bankOfCategory(category: QCategoryRow): Promise<{ scope: string; ownerId: string | null } | undefined> {
    if (category.bankId) {
      const byId = await this.repo.getBankById(category.bankId).catch(() => undefined);
      if (byId) return byId;
    }
    return this.repo.getBankByContextId(category.contextId).catch(() => undefined);
  }

  /** Ném notFound() khi category thuộc bank personal của người khác đối với actor. */
  private async assertCategoryNotForeignPersonal(
    actorId: string,
    category: QCategoryRow,
    notFound: () => NotFoundException,
  ): Promise<void> {
    const bank = await this.bankOfCategory(category);
    if (!bank || bank.scope !== 'personal' || bank.ownerId === actorId) return;
    const isAdmin = await this.evaluator.isSiteAdmin(actorId).catch(() => false);
    if (!isAdmin) throw notFound();
  }

  private categoryNotFound(id: string): NotFoundException {
    return new NotFoundException({ message: `Question category ${id} not found`, code: 'question.category_not_found' });
  }
  private questionNotFound(id: string): NotFoundException {
    return new NotFoundException({ message: `Question ${id} not found`, code: 'question.not_found' });
  }
  private stimulusNotFound(id: string): NotFoundException {
    return new NotFoundException({ message: `Stimulus ${id} not found`, code: 'stimulus.not_found' });
  }
  private usageNotFound(id: string): NotFoundException {
    return new NotFoundException({ message: `Question usage ${id} not found`, code: 'question.usage_not_found' });
  }

  /** Category của một câu hỏi + cổng đọc tại context của category đó. */
  private async assertQuestionReadable(actorId: string, questionId: string): Promise<QuestionRow> {
    const q = await this.repo.getQuestion(questionId);
    if (!q) throw this.questionNotFound(questionId);
    const category = await this.repo.getCategory(q.category);
    if (!category || !(await this.canUseBank(actorId, category.contextId))) throw this.questionNotFound(questionId);
    return q;
  }

  /** Category theo id + cổng đọc tại context của nó (404 dùng mã category). */
  private async assertCategoryReadable(actorId: string, categoryId: string): Promise<QCategoryRow> {
    const category = await this.repo.getCategory(categoryId);
    if (!category) throw this.categoryNotFound(categoryId);
    if (!(await this.canUseBank(actorId, category.contextId))) throw this.categoryNotFound(categoryId);
    return category;
  }

  // --- bank: categories ------------------------------------------------------

  /**
   * Tạo category câu hỏi trong context. Context phải TỒN TẠI thật: trước
   * đây context không hợp lệ bị nuốt lặng lẽ về context hệ thống rồi lỗi
   * capability ở đó báo sai nguyên nhân (issue #55 mục 2) — nay trả 400
   * nói đúng là context không tồn tại. Khi gắn bank (QB-1), context của
   * category phải chính là context của bank — category sống trong bank
   * thì quyền quản lý đọc tại context bank như mọi bề mặt bank khác.
   */
  async createCategory(actorId: string, input: { name: string; contextId: string; info?: string; parent?: string; bankId?: string }): Promise<QCategoryRow> {
    const ctx = await this.contexts.getContext(input.contextId).catch(() => undefined);
    if (!ctx) {
      throw new BadRequestException({
        message: `Context ${input.contextId} does not exist; a question category must be created in an existing context`,
        code: 'question.category_context_not_found',
      });
    }
    let attachedBank: Awaited<ReturnType<QuestionsRepository['getBankById']>>;
    if (input.bankId !== undefined) {
      attachedBank = await this.repo.getBankById(input.bankId);
      if (!attachedBank) throw new NotFoundException({ message: `Question bank ${input.bankId} not found`, code: 'question.bank_not_found' });
    }
    // Cổng ghi bank personal (issue #123 vòng 2): tạo category gắn vào
    // bank personal của người khác — tường minh qua bankId hay ngầm qua
    // context của bank đó — → 404 như bank không tồn tại.
    for (const candidate of [attachedBank, await this.repo.getBankByContextId(ctx.id).catch(() => undefined)]) {
      if (candidate && candidate.scope === 'personal' && candidate.ownerId !== actorId
        && !(await this.evaluator.isSiteAdmin(actorId).catch(() => false))) {
        throw new NotFoundException({ message: `Question bank ${candidate.id} not found`, code: 'question.bank_not_found' });
      }
    }
    await this.requireCap(actorId, 'question:managecategory', ctx.id);
    if (attachedBank) {
      if (attachedBank.contextId !== ctx.id) {
        throw new BadRequestException({ message: 'A category attached to a bank must live in the bank context', code: 'question.category_bank_context_mismatch' });
      }
    }
    return this.repo.insertCategory({
      name: input.name, contextId: ctx.id, info: input.info ?? '', parent: input.parent ?? null,
      bankId: input.bankId ?? null,
      stamp: `qcat-${Date.now().toString(36)}`,
    });
  }
  /**
   * Liệt kê category.
   */
  async listCategories(contextId?: string): Promise<QCategoryRow[]> { return this.repo.listCategories(contextId); }
  /**
   * Lấy category; ném questions.category_not_found khi vắng.
   */
  async getCategory(id: string): Promise<QCategoryRow> {
    const row = await this.repo.getCategory(id);
    if (!row) throw new NotFoundException({ message: `Question category ${id} not found`, code: 'question.category_not_found' });
    return row;
  }

  /**
   * Liệt kê category CHO MỘT NGƯỜI ĐỌC (cổng issue #55): có contextId thì
   * phải có `question:useall` tại đúng context đó (không có → 404 như
   * context không có category nào của mình); không có contextId thì chỉ
   * trả các category nằm trong context người đọc dùng được.
   */
  async listCategoriesForViewer(actorId: string, contextId?: string): Promise<QCategoryRow[]> {
    if (contextId !== undefined) {
      if (!(await this.canUseBank(actorId, contextId))) throw this.categoryNotFound(contextId);
      return this.repo.listCategories(contextId);
    }
    const rows = await this.repo.listCategories();
    const allowedByContext = new Map<string, boolean>();
    const out: QCategoryRow[] = [];
    for (const row of rows) {
      let ok = allowedByContext.get(row.contextId);
      if (ok === undefined) {
        ok = await this.canUseBank(actorId, row.contextId);
        allowedByContext.set(row.contextId, ok);
      }
      if (ok) out.push(row);
    }
    return out;
  }

  /** Câu hỏi trong category CHO NGƯỜI ĐỌC (cổng tại context của category). */
  async listQuestionsForViewer(actorId: string, categoryId: string): Promise<QuestionView[]> {
    await this.assertCategoryReadable(actorId, categoryId);
    return this.listQuestions(categoryId);
  }

  // --- bank: stimuli -----------------------------------------------------------

  /**
   * Tạo ngữ liệu (stimulus) trong một category. Quyền theo context của
   * category như câu hỏi: ai có quyền thêm câu hỏi ở category đó thì tạo
   * được ngữ liệu ở đó.
   */
  async createStimulus(actorId: string, input: { categoryId: string; content: RichTextInput }): Promise<StimulusRow> {
    const category = await this.getCategory(input.categoryId);
    await this.assertCategoryNotForeignPersonal(actorId, category, () => this.categoryNotFound(input.categoryId));
    await this.requireCap(actorId, 'question:add', category.contextId);
    const row = await this.repo.insertStimulus({
      categoryId: category.id, createdBy: actorId, content: toRichTextDocument(input.content) as never,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'stimulus', type: 'stimulus_created', payload: { stimulusId: row.id, categoryId: category.id } });
    return row;
  }
  /**
   * Lấy ngữ liệu; ném stimulus.not_found khi vắng.
   */
  async getStimulus(id: string): Promise<StimulusRow> {
    const row = await this.repo.getStimulus(id);
    if (!row) throw new NotFoundException({ message: `Stimulus ${id} not found`, code: 'stimulus.not_found' });
    return row;
  }
  /**
   * Ngữ liệu trong một category.
   */
  async listStimuli(categoryId: string): Promise<StimulusRow[]> { return this.repo.listStimuliInCategory(categoryId); }

  /** Ngữ liệu trong category CHO NGƯỜI ĐỌC (cổng tại context của category). */
  async listStimuliForViewer(actorId: string, categoryId: string): Promise<StimulusRow[]> {
    await this.assertCategoryReadable(actorId, categoryId);
    return this.repo.listStimuliInCategory(categoryId);
  }

  /** Một ngữ liệu CHO NGƯỜI ĐỌC (cổng tại context của category chứa nó). */
  async getStimulusForViewer(actorId: string, id: string): Promise<StimulusRow> {
    const row = await this.repo.getStimulus(id);
    if (!row) throw this.stimulusNotFound(id);
    const category = await this.repo.getCategory(row.categoryId);
    if (!category || !(await this.canUseBank(actorId, category.contextId))) throw this.stimulusNotFound(id);
    return row;
  }

  private async requireStimulusMutable(stimulus: StimulusRow): Promise<void> {
    const refs = await this.repo.countVersionsReferencingStimulus(stimulus.id);
    if (refs > 0) {
      throw new BadRequestException({
        message: 'Stimulus is already referenced by a question version and can no longer be changed or deleted; create a new stimulus instead',
        code: 'stimulus_in_use',
      });
    }
  }
  /**
   * Sửa nội dung ngữ liệu — bị cấm khi đã có version câu hỏi tham chiếu
   * (stimulus bất biến từ thời điểm đó).
   */
  async updateStimulus(actorId: string, id: string, input: { content: RichTextInput }): Promise<StimulusRow> {
    const stimulus = await this.getStimulus(id);
    const category = await this.getCategory(stimulus.categoryId);
    await this.assertCategoryNotForeignPersonal(actorId, category, () => this.stimulusNotFound(id));
    await this.requireCap(actorId, 'question:editall', category.contextId);
    await this.requireStimulusMutable(stimulus);
    await this.repo.updateStimulus(id, { content: toRichTextDocument(input.content) as never });
    await this.outbox.enqueueStandalone({ aggregate: 'stimulus', type: 'stimulus_updated', payload: { stimulusId: id } });
    return this.getStimulus(id);
  }
  /**
   * Xoá ngữ liệu — bị cấm khi đã có version câu hỏi tham chiếu.
   */
  async deleteStimulus(actorId: string, id: string): Promise<void> {
    const stimulus = await this.getStimulus(id);
    const category = await this.getCategory(stimulus.categoryId);
    await this.assertCategoryNotForeignPersonal(actorId, category, () => this.stimulusNotFound(id));
    await this.requireCap(actorId, 'question:editall', category.contextId);
    await this.requireStimulusMutable(stimulus);
    await this.repo.deleteStimulus(id);
    await this.outbox.enqueueStandalone({ aggregate: 'stimulus', type: 'stimulus_deleted', payload: { stimulusId: id } });
  }

  // --- bank: questions -----------------------------------------------------------

  private assertSupportedQtype(qtype: string): asserts qtype is SupportedQtype {
    if (!(SUPPORTED_QTYPES as readonly string[]).includes(qtype)) {
      throw new BadRequestException({ message: `qtype ${qtype} is not one of the standard Moodle qtypes supported by the core (multichoice, truefalse, shortanswer, essay)`, code: 'question.qtype_not_supported' });
    }
  }

  private docOrNull(input: RichTextInput | undefined): RichTextDocument | null {
    return input === undefined ? null : toRichTextDocument(input);
  }

  /**
   * Chuẩn hoá phần đáp án/options của payload thành nội dung ghi xuống
   * bảng, theo luật mô hình giaokhoa (quyết 12:04 + các điểm quyết D
   * ngày 26/10/2026 — cùng luật mà `createQuestionSchema` của contracts
   * kiểm ở cửa HTTP; service kiểm LẠI ở đây vì các đường nội bộ (MCP,
   * nhân bản) không đi qua schema HTTP):
   *  - multichoice: đúng 4 lựa chọn (D-3) và đúng MỘT đáp án đúng.
   *  - truefalse (TF-A, điểm quyết D-1): KHÔNG có dòng answers. Thân
   *    câu (`questionText`, hoặc thân câu đã lưu khi sửa mà không gửi
   *    thân mới) phải là tài liệu chốt đuôi bằng đúng 4 mệnh đề; đáp
   *    án từng mệnh đề đi qua `solution.answers` phủ đúng tập mệnh đề
   *    đó và được sắp lại theo đúng thứ tự mệnh đề trong thân câu khi
   *    ghi vào `question_answer_keys.solution`. Đường sửa chỉ gửi
   *    thân câu mới mà không gửi `solution` thì phía đáp án kế thừa
   *    của version trước do `updateQuestion` ghép sau bước này — NHƯNG
   *    chỉ khi tập statementId của thân mới == tập solution cũ phủ,
   *    khác thì `updateQuestion` từ chối 400 (bề mặt soạn luôn gửi kèm
   *    đáp án cùng thân câu nên không đi qua đường kế thừa này).
   *  - shortanswer: ít nhất 1 đáp án được chấp nhận; MỌI dòng liệt kê
   *    đều là đáp án được chấp nhận (dòng `correct: false` bị từ chối —
   *    đáp án sai không có chỗ trong danh sách này).
   *  - essay: không có dòng đáp án; options mang cấu hình trả lời +
   *    graderInfo + responseTemplate; giới hạn từ phải hợp lệ
   *    (min ≤ max). Lời giải mẫu đi qua `solution.answer`.
   * guidance đi vào `answerKey` (bản ghi phía đáp án) cho MỌI qtype.
   *
   * @param qtype - dạng câu đã qua `assertSupportedQtype`.
   * @param input - payload cấu trúc của người soạn.
   * @returns Nội dung đã chuẩn hoá, sẵn sàng cho `writeVersionContent`.
   * @throws BadRequestException `question.bad_answer_data` khi phần đáp
   *   án/options vi phạm luật của qtype.
   */
  private normaliseContent(qtype: SupportedQtype, input: QuestionContentInput, existingQuestionText?: RichTextDocument | null): NormalisedContent {
    const options = input.options ?? {};
    const answerKey: NormalisedContent['answerKey'] = {
      guidance: this.docOrNull(input.guidance),
      solution: qtype === 'essay' && input.solution !== undefined && 'answer' in input.solution
        ? { answer: toRichTextDocument(input.solution.answer) }
        : null,
    };
    if (qtype === 'truefalse') {
      if (input.answers && input.answers.length > 0) {
        throw badAnswerData('truefalse (TF-A) questions do not carry answer rows; per-statement answers go through solution.answers');
      }
      // Thân câu hiệu lực: payload gửi thân mới thì dùng thân mới; đường
      // sửa không gửi thân thì kiểm trên thân đã lưu của version trước.
      const doc = input.questionText !== undefined
        ? (typeof input.questionText === 'string' ? null : toRichTextDocument(input.questionText))
        : (existingQuestionText ?? null);
      const statements = doc ? getTrueFalseStatements(doc) : null;
      if (!doc || !statements) {
        throw badAnswerData('truefalse question text must be a document ending with a statement list (statementList)');
      }
      const stemBlocks = doc.content.slice(0, -1);
      if (!richTextBlocksHaveContent(stemBlocks) || richTextBlocksContainStatementList(stemBlocks)) {
        throw badAnswerData('truefalse stem must carry content before the statement list');
      }
      if (statements.length !== TRUE_FALSE_STATEMENT_COUNT) {
        throw badAnswerData(`truefalse requires exactly ${TRUE_FALSE_STATEMENT_COUNT} statements`);
      }
      if (new Set(statements.map((s) => s.id)).size !== statements.length) {
        throw badAnswerData('truefalse statements must have unique ids');
      }
      if (statements.some((s) => !richTextBlocksHaveContent(s.content) || richTextBlocksContainStatementList(s.content))) {
        throw badAnswerData('every truefalse statement must carry content');
      }
      const solutionAnswers = input.solution !== undefined && 'answers' in input.solution ? input.solution.answers : null;
      if (!solutionAnswers) {
        // Đường sửa không gửi solution: để null, updateQuestion kế thừa
        // phía đáp án của version trước. Đường tạo mới (không có thân
        // đã lưu) thì đáp án là bắt buộc — thiếu là payload lỗi.
        if (existingQuestionText === undefined || existingQuestionText === null) {
          throw badAnswerData('truefalse requires solution.answers with a Đúng/Sai value for every statement');
        }
        return { answers: [], answerKey };
      }
      const statementIds = new Set(statements.map((s) => s.id));
      const covered = new Set(solutionAnswers.map((a) => a.statementId));
      if (solutionAnswers.length !== statements.length || covered.size !== solutionAnswers.length
        || [...covered].some((id) => !statementIds.has(id))) {
        throw badAnswerData('truefalse solution.answers must cover exactly the statements of the question text');
      }
      return {
        answers: [],
        answerKey: {
          guidance: answerKey.guidance,
          // Ghi theo đúng thứ tự mệnh đề trong thân câu: phía đọc/chấm
          // bám statementId, thứ tự chỉ để trình bày nhất quán.
          solution: {
            answers: statements.map((s) => ({
              statementId: s.id,
              value: solutionAnswers.find((a) => a.statementId === s.id)!.value === true,
            })),
          },
        },
      };
    }
    if (qtype === 'essay') {
      if (input.answers && input.answers.length > 0) throw badAnswerData('essay questions do not carry answers; the response is graded manually');
      const min = options.minWordLimit ?? null;
      const max = options.maxWordLimit ?? null;
      if (min !== null && max !== null && min > max) throw badAnswerData('essay minWordLimit must not exceed maxWordLimit');
      return {
        answers: [],
        essay: {
          responseFormat: options.responseFormat ?? 'editor',
          responseRequired: options.responseRequired ?? true,
          responseFieldLines: options.responseFieldLines ?? 15,
          minWordLimit: min, maxWordLimit: max,
          graderInfo: this.docOrNull(options.graderInfo),
          responseTemplate: this.docOrNull(options.responseTemplate),
        },
        answerKey,
      };
    }
    const rawAnswers = input.answers;
    if (!rawAnswers || rawAnswers.length === 0) {
      throw badAnswerData(`${qtype} requires at least one answer in the structured answers list`);
    }
    const answers = rawAnswers.map((a) => ({
      answer: toRichTextDocument(a.text),
      isCorrect: a.correct === true,
      feedback: a.feedback === undefined ? null : toRichTextDocument(a.feedback),
    }));
    const correctCount = answers.filter((a) => a.isCorrect).length;
    if (qtype === 'shortanswer') {
      if (answers.some((a) => !a.isCorrect)) {
        throw badAnswerData('shortanswer answers are all accepted answers; a listed answer cannot be marked incorrect');
      }
      return {
        answers,
        shortanswer: {
          useCase: options.useCase ?? false,
          numericAnswer: options.numericAnswer ?? false,
          numericMaxLength: options.numericMaxLength ?? null,
          numericAllowSign: options.numericAllowSign ?? true,
          numericAllowDecimal: options.numericAllowDecimal ?? true,
        },
        answerKey,
      };
    }
    // multichoice
    if (answers.length !== 4) throw badAnswerData('multichoice requires exactly four choices');
    if (correctCount !== 1) throw badAnswerData('multichoice requires exactly one correct answer');
    return {
      answers,
      multichoice: {
        shuffleAnswers: options.shuffleAnswers ?? false,
        answerNumbering: options.answerNumbering ?? 'abc',
        correctFeedback: this.docOrNull(options.correctFeedback),
        incorrectFeedback: this.docOrNull(options.incorrectFeedback),
        showStandardInstruction: options.showStandardInstruction ?? true,
      },
      answerKey,
    };
  }

  /**
   * Ghi answers + options + bản ghi phía đáp án của một version trong
   * cùng giao dịch tạo version. Bản ghi phía đáp án
   * (`question_answer_keys`) chỉ được chèn khi có guidance hoặc
   * solution — version không có dòng nào thì phía đọc quy về cả hai
   * null (xem `answerKeyOf`).
   */
  private async writeVersionContent(tx: QuestionsTx, qtype: SupportedQtype, versionId: string, content: NormalisedContent): Promise<void> {
    const inserted: AnswerRow[] = [];
    for (const [index, a] of content.answers.entries()) {
      inserted.push(await this.repo.insertAnswer({
        questionVersionId: versionId, answer: a.answer as never, isCorrect: a.isCorrect,
        feedback: a.feedback as never, sortOrder: index,
      }, tx));
    }
    if (content.multichoice) {
      await this.repo.insertMultichoiceOptions({ questionVersionId: versionId, ...content.multichoice } as never, tx);
    }
    if (content.shortanswer) {
      await this.repo.insertShortanswerOptions({
        questionVersionId: versionId, useCase: content.shortanswer.useCase,
        numericAnswer: content.shortanswer.numericAnswer, numericMaxLength: content.shortanswer.numericMaxLength,
        numericAllowSign: content.shortanswer.numericAllowSign, numericAllowDecimal: content.shortanswer.numericAllowDecimal,
      }, tx);
    }
    if (content.essay) {
      await this.repo.insertEssayOptions({ questionVersionId: versionId, ...content.essay } as never, tx);
    }
    if (content.answerKey.guidance !== null || content.answerKey.solution !== null) {
      await this.repo.insertAnswerKey({
        questionVersionId: versionId,
        guidance: content.answerKey.guidance as never,
        solution: content.answerKey.solution as never,
      }, tx);
    }
  }

  /**
   * Nhân bản answers + options + bản ghi phía đáp án của một version
   * sang version khác (khi sửa câu hỏi mà không đổi phần đáp án, và khi
   * deep copy câu hỏi giữa các bank): nội dung phía đáp án (guidance +
   * solution) đi cùng answers/options như một khối — bản copy thiếu
   * guidance/solution của bản gốc là mất dữ liệu.
   */
  private async cloneVersionContent(tx: QuestionsTx, qtype: SupportedQtype, fromVersionId: string, toVersionId: string, skipAnswerKey = false): Promise<void> {
    const answers = await this.repo.listAnswers(fromVersionId);
    const idMap = new Map<string, string>();
    for (const a of answers) {
      const row = await this.repo.insertAnswer({
        questionVersionId: toVersionId, answer: a.answer as never, isCorrect: a.isCorrect,
        feedback: a.feedback as never, sortOrder: a.sortOrder,
      }, tx);
      idMap.set(a.id, row.id);
    }
    if (qtype === 'multichoice') {
      const o = await this.repo.getMultichoiceOptions(fromVersionId);
      if (o) await this.repo.insertMultichoiceOptions({
        questionVersionId: toVersionId, shuffleAnswers: o.shuffleAnswers,
        answerNumbering: o.answerNumbering, correctFeedback: o.correctFeedback as never,
        incorrectFeedback: o.incorrectFeedback as never,
        showStandardInstruction: o.showStandardInstruction,
      }, tx);
    } else if (qtype === 'shortanswer') {
      const o = await this.repo.getShortanswerOptions(fromVersionId);
      if (o) await this.repo.insertShortanswerOptions({
        questionVersionId: toVersionId, useCase: o.useCase,
        numericAnswer: o.numericAnswer, numericMaxLength: o.numericMaxLength,
        numericAllowSign: o.numericAllowSign, numericAllowDecimal: o.numericAllowDecimal,
      }, tx);
    } else if (qtype === 'essay') {
      const o = await this.repo.getEssayOptions(fromVersionId);
      if (o) await this.repo.insertEssayOptions({
        questionVersionId: toVersionId, responseFormat: o.responseFormat, responseRequired: o.responseRequired,
        responseFieldLines: o.responseFieldLines, minWordLimit: o.minWordLimit, maxWordLimit: o.maxWordLimit,
        graderInfo: o.graderInfo as never, responseTemplate: o.responseTemplate as never,
      }, tx);
    }
    if (!skipAnswerKey) {
      const key = await this.repo.getAnswerKey(fromVersionId);
      if (key) {
        await this.repo.insertAnswerKey({
          questionVersionId: toVersionId, guidance: key.guidance as never, solution: key.solution as never,
        }, tx);
      }
    }
  }

  /**
   * Nhân bản answers + options giữa hai version trong một giao dịch do
   * caller quản lý — điểm dùng chung cho deep copy của lớp bank (QB-2/QB-4:
   * copy câu hỏi và duyệt đóng góp tạo version mới từ nội dung version nguồn).
   */
  async cloneVersionContentTx(tx: QuestionsTx, qtype: SupportedQtype, fromVersionId: string, toVersionId: string): Promise<void> {
    await this.cloneVersionContent(tx, qtype, fromVersionId, toVersionId);
  }

  /** Dựng options dạng bản ghi phẳng cho view/API từ bảng options của qtype. */
  private async optionsView(qtype: string, versionId: string): Promise<Record<string, unknown> | null> {
    if (qtype === 'multichoice') return this.optionsFromRow(qtype, await this.repo.getMultichoiceOptions(versionId));
    if (qtype === 'shortanswer') return this.optionsFromRow(qtype, await this.repo.getShortanswerOptions(versionId));
    if (qtype === 'essay') return this.optionsFromRow(qtype, await this.repo.getEssayOptions(versionId));
    return null;
  }

  /**
   * Ánh xạ một dòng options đã nạp thành bản ghi phẳng của view theo
   * qtype — phần thuần của optionsView, tách ra để loader theo lô
   * (loadQuestionViews) dùng CHUNG đúng một ánh xạ với đường đọc đơn;
   * version không có dòng options thì view mang `options: null`.
   */
  private optionsFromRow(
    qtype: string,
    row: MultichoiceOptionsRow | ShortanswerOptionsRow | EssayOptionsRow | undefined,
  ): Record<string, unknown> | null {
    if (!row) return null;
    if (qtype === 'multichoice') {
      const o = row as MultichoiceOptionsRow;
      return {
        shuffleAnswers: o.shuffleAnswers, answerNumbering: o.answerNumbering,
        correctFeedback: o.correctFeedback, incorrectFeedback: o.incorrectFeedback,
        showStandardInstruction: o.showStandardInstruction,
      };
    }
    if (qtype === 'shortanswer') {
      const o = row as ShortanswerOptionsRow;
      return {
        useCase: o.useCase,
        numericAnswer: o.numericAnswer, numericMaxLength: o.numericMaxLength,
        numericAllowSign: o.numericAllowSign, numericAllowDecimal: o.numericAllowDecimal,
      };
    }
    if (qtype === 'essay') {
      const o = row as EssayOptionsRow;
      return {
        responseFormat: o.responseFormat, responseRequired: o.responseRequired,
        responseFieldLines: o.responseFieldLines, minWordLimit: o.minWordLimit,
        maxWordLimit: o.maxWordLimit, graderInfo: o.graderInfo, responseTemplate: o.responseTemplate,
      };
    }
    return null;
  }

  /**
   * Bản ghi phía đáp án của một version dưới dạng view: version không
   * có dòng `question_answer_keys` (không guidance, không solution)
   * thì trả cả hai null — view LUÔN mang trường `answerKey` để bề mặt
   * tiêu thụ không phải phân biệt "không có dòng" với "có dòng rỗng".
   */
  async answerKeyOf(versionId: string): Promise<{ guidance: unknown; solution: unknown }> {
    const key: AnswerKeyRow | undefined = await this.repo.getAnswerKey(versionId);
    return { guidance: key?.guidance ?? null, solution: key?.solution ?? null };
  }

  /** Lắp view đầy đủ của một version: answers, bản ghi phía đáp án, options và stimulus đã gắn. */
  private async assembleView(question: QuestionRow, entry: EntryRow, version: VersionRow): Promise<QuestionView> {
    const answers = await this.repo.listAnswers(version.id);
    const answerKey = await this.answerKeyOf(version.id);
    const options = await this.optionsView(question.qtype, version.id);
    const stimulus = version.stimulusId ? (await this.repo.getStimulus(version.stimulusId)) ?? null : null;
    return { question, entry, latestVersion: version, answers, answerKey, options, stimulus };
  }

  /**
   * Lắp view cho một TẬP câu hỏi bằng loader theo lô (issue #488):
   * mọi thành phần của view — entry, version mới nhất, answers, bản
   * ghi phía đáp án, options theo dạng, ngữ liệu — được nạp bằng số
   * lượt truy vấn HẰNG SỐ theo số câu (mỗi bảng một lượt cho cả tập)
   * rồi lắp trong bộ nhớ, thay cho vòng lặp gọi getQuestion từng câu.
   * Bất biến giữ nguyên so với đường từng câu:
   * - Thứ tự view khớp đúng thứ tự dòng câu đầu vào.
   * - Câu đầu tiên (theo thứ tự vào) thiếu entry hoặc thiếu version
   *   mới nhất thì ném đúng NotFoundException cùng mã như getQuestion
   *   (`question.entry_missing` / `question.version_missing`).
   * - Hình dạng từng view do cùng các ánh xạ với assembleView dựng
   *   (options qua optionsFromRow, answerKey mặc định cả hai null khi
   *   version không có dòng phía đáp án, stimulus null khi version
   *   không gắn hoặc không còn dòng ngữ liệu).
   */
  private async loadQuestionViews(rows: QuestionRow[]): Promise<QuestionView[]> {
    if (!rows.length) return [];
    const entries = await this.repo.getEntriesByQuestions(rows.map((q) => q.id));
    const entryByQuestion = new Map(entries.map((e) => [e.questionId, e]));
    const versions = await this.repo.getLatestVersionsByEntries(entries);
    const versionByEntry = new Map(versions.map((v) => [v.questionBankEntryId, v]));
    for (const q of rows) {
      const entry = entryByQuestion.get(q.id);
      if (!entry) throw new NotFoundException({ message: `Question ${q.id} has no bank entry`, code: 'question.entry_missing' });
      if (!versionByEntry.has(entry.id)) throw new NotFoundException({ message: `Question ${q.id} latest version missing`, code: 'question.version_missing' });
    }
    const versionIds = versions.map((v) => v.id);
    const answers = await this.repo.listAnswersByVersions(versionIds);
    const answersByVersion = new Map<string, AnswerRow[]>();
    for (const a of answers) {
      const list = answersByVersion.get(a.questionVersionId);
      if (list) list.push(a); else answersByVersion.set(a.questionVersionId, [a]);
    }
    const keys = await this.repo.listAnswerKeysByVersions(versionIds);
    const keyByVersion = new Map(keys.map((k) => [k.questionVersionId, k]));
    const qtypeByVersion = new Map<string, string>();
    for (const q of rows) {
      const entry = entryByQuestion.get(q.id)!;
      const version = versionByEntry.get(entry.id)!;
      qtypeByVersion.set(version.id, q.qtype);
    }
    const idsFor = (qtype: string): string[] => versionIds.filter((id) => qtypeByVersion.get(id) === qtype);
    const mcOptions = await this.repo.listMultichoiceOptionsByVersions(idsFor('multichoice'));
    const mcByVersion = new Map(mcOptions.map((o) => [o.questionVersionId, o]));
    const saOptions = await this.repo.listShortanswerOptionsByVersions(idsFor('shortanswer'));
    const saByVersion = new Map(saOptions.map((o) => [o.questionVersionId, o]));
    const essayOptions = await this.repo.listEssayOptionsByVersions(idsFor('essay'));
    const essayByVersion = new Map(essayOptions.map((o) => [o.questionVersionId, o]));
    const stimulusIds = [...new Set(versions.map((v) => v.stimulusId).filter((id): id is string => id !== null))];
    const stimuli = await this.repo.listStimuliByIds(stimulusIds);
    const stimulusById = new Map(stimuli.map((s) => [s.id, s]));
    return rows.map((q) => {
      const entry = entryByQuestion.get(q.id)!;
      const version = versionByEntry.get(entry.id)!;
      const key = keyByVersion.get(version.id);
      const optionsRow = q.qtype === 'multichoice' ? mcByVersion.get(version.id)
        : q.qtype === 'shortanswer' ? saByVersion.get(version.id)
        : q.qtype === 'essay' ? essayByVersion.get(version.id)
        : undefined;
      return {
        question: q, entry, latestVersion: version,
        answers: answersByVersion.get(version.id) ?? [],
        answerKey: { guidance: key?.guidance ?? null, solution: key?.solution ?? null },
        options: this.optionsFromRow(q.qtype, optionsRow),
        stimulus: version.stimulusId ? stimulusById.get(version.stimulusId) ?? null : null,
      };
    });
  }

  /** Kiểm chứng stimulus được gắn: phải tồn tại và cùng category với câu hỏi (phạm vi chia sẻ). */
  private async resolveStimulus(stimulusId: string, categoryId: string): Promise<StimulusRow> {
    const stimulus = await this.getStimulus(stimulusId);
    if (stimulus.categoryId !== categoryId) {
      throw new BadRequestException({
        message: 'Stimulus belongs to a different question category; a stimulus is shared only within its own category',
        code: 'question.stimulus_category_mismatch',
      });
    }
    return stimulus;
  }

  /**
   * Lõi ghi một câu hỏi TRONG một giao dịch đang mở: question + entry +
   * version 1 + nội dung theo qtype. Tách ra để đường tạo đơn
   * (createQuestion) và đường tạo nhóm nguyên tử
   * (createStimulusWithQuestions) dùng CHUNG một đường ghi — không có
   * biến thể nghiệp vụ thứ hai. Nội dung phải đã qua normaliseContent
   * ở caller (chạy trước khi mở giao dịch để lỗi payload không giữ
   * giao dịch mở).
   */
  private async insertQuestionGraph(
    tx: QuestionsTx,
    actorId: string,
    category: QCategoryRow,
    input: { qtype: string; sourceKind?: string; sourceRef?: string } & QuestionContentInput,
    content: NormalisedContent,
    stimulusId: string | null,
  ): Promise<{ q: QuestionRow; entry: EntryRow; version: VersionRow }> {
    const q = await this.repo.insertQuestion({
      category: category.id, qtype: input.qtype, createdBy: actorId, modifiedBy: actorId,
      sourceKind: input.sourceKind ?? 'manual', sourceRef: input.sourceRef ?? null,
    }, tx);
    const entry = await this.repo.insertEntry({ questionCategoryId: category.id, questionId: q.id, latestVersion: 1 }, tx);
    const version = await this.repo.insertVersion({
      questionBankEntryId: entry.id, questionId: q.id, version: 1,
      questionText: toRichTextDocument(input.questionText ?? '') as never,
      generalFeedback: this.docOrNull(input.generalFeedback) as never,
      defaultMark: input.defaultMark ?? 1, penalty: input.penalty ?? 0,
      stimulusId,
    }, tx);
    await this.writeVersionContent(tx, input.qtype as SupportedQtype, version.id, content);
    return { q, entry, version };
  }

  /**
   * Tạo câu hỏi kèm version 1 và entry. Đáp án/options của payload được
   * bung ra question_answers + bảng options của qtype trong cùng giao dịch.
   */
  async createQuestion(actorId: string, input: {
    categoryId: string; qtype: string;
    /** Nguồn ngoài hệ thống (truy vết nội bộ); vắng thì mặc định 'manual' — giáo viên tự soạn. */
    sourceKind?: string; sourceRef?: string;
  } & QuestionContentInput): Promise<QuestionView> {
    const category = await this.getCategory(input.categoryId);
    await this.assertCategoryNotForeignPersonal(actorId, category, () => this.categoryNotFound(input.categoryId));
    await this.requireCap(actorId, 'question:add', category.contextId);
    this.assertSupportedQtype(input.qtype);
    const content = this.normaliseContent(input.qtype, input);
    const stimulus = input.stimulusId ? await this.resolveStimulus(input.stimulusId, category.id) : null;
    let created!: { q: QuestionRow; entry: EntryRow; version: VersionRow };
    await this.repo.transaction(async (tx) => {
      created = await this.insertQuestionGraph(tx, actorId, category, input, content, stimulus?.id ?? null);
    });
    await this.outbox.enqueueStandalone({ aggregate: 'question', type: 'question_created', payload: { questionId: created.q.id, version: 1 } });
    return this.assembleView(created.q, created.entry, created.version);
  }

  /**
   * Tạo MỘT ngữ liệu + NHÓM câu hỏi bám ngữ liệu đó trong đúng MỘT
   * giao dịch (đường của tool MCP create_stimulus_with_questions, lát
   * MCP-1 issue #163): hoặc cả nhóm tồn tại, hoặc không gì tồn tại —
   * khác hẳn việc client gọi create_stimulus rồi create_question rời
   * rạc (câu mồ côi khi rớt giữa chừng). Cổng quyền + chuẩn hoá nội
   * dung của TỪNG câu chạy TRƯỚC khi mở giao dịch theo đúng đường của
   * createQuestion/createStimulus; phần ghi dùng chung lõi
   * insertQuestionGraph. Ngữ liệu mới thuộc cùng category nên không
   * cần resolveStimulus — mọi câu trong nhóm bám thẳng stimulus vừa tạo.
   */
  async createStimulusWithQuestions(
    actorId: string,
    input: {
      categoryId: string;
      content: RichTextInput;
      questions: ({
        qtype: string;
        sourceKind?: string; sourceRef?: string;
      } & QuestionContentInput)[];
    },
  ): Promise<{ stimulus: StimulusRow; questions: QuestionView[] }> {
    const category = await this.getCategory(input.categoryId);
    await this.assertCategoryNotForeignPersonal(actorId, category, () => this.categoryNotFound(input.categoryId));
    await this.requireCap(actorId, 'question:add', category.contextId);
    // Chuẩn hoá + kiểm qtype của cả nhóm TRƯỚC giao dịch: một câu lỗi
    // là cả nhóm dừng tại đây, chưa có dòng nào được ghi.
    const prepared = input.questions.map((question) => {
      this.assertSupportedQtype(question.qtype);
      return { question, content: this.normaliseContent(question.qtype, question) };
    });
    let stimulus!: StimulusRow;
    const created: { q: QuestionRow; entry: EntryRow; version: VersionRow }[] = [];
    await this.repo.transaction(async (tx) => {
      stimulus = await this.repo.insertStimulus({
        categoryId: category.id, createdBy: actorId, content: toRichTextDocument(input.content) as never,
      }, tx);
      for (const { question, content } of prepared) {
        created.push(await this.insertQuestionGraph(tx, actorId, category, question, content, stimulus.id));
      }
    });
    await this.outbox.enqueueStandalone({ aggregate: 'stimulus', type: 'stimulus_created', payload: { stimulusId: stimulus.id, categoryId: category.id } });
    for (const item of created) {
      await this.outbox.enqueueStandalone({ aggregate: 'question', type: 'question_created', payload: { questionId: item.q.id, version: 1 } });
    }
    const questions = await Promise.all(created.map((item) => this.assembleView(item.q, item.entry, item.version)));
    return { stimulus, questions };
  }

  /**
   * Lấy câu hỏi ở version mới nhất, kèm answers/options/stimulus.
   */
  async getQuestion(id: string): Promise<QuestionView> {
    const q = await this.repo.getQuestion(id);
    if (!q) throw new NotFoundException({ message: `Question ${id} not found`, code: 'question.not_found' });
    const entry = await this.repo.getEntryByQuestion(id);
    if (!entry) throw new NotFoundException({ message: `Question ${id} has no bank entry`, code: 'question.entry_missing' });
    const latest = await this.repo.getVersionByNumber(entry.id, entry.latestVersion);
    if (!latest) throw new NotFoundException({ message: `Question ${id} latest version missing`, code: 'question.version_missing' });
    return this.assembleView(q, entry, latest);
  }
  /**
   * Câu hỏi trong category — view lắp theo lô bằng loadQuestionViews
   * (issue #488); hình dạng và thứ tự giữ nguyên như đường lắp từng
   * câu trước đây.
   */
  async listQuestions(categoryId: string): Promise<QuestionView[]> {
    const rows = await this.repo.listQuestionsInCategory(categoryId);
    return this.loadQuestionViews(rows);
  }
  /**
   * Lịch sử version của câu hỏi.
   */
  async listVersions(questionId: string): Promise<VersionRow[]> {
    const entry = await this.repo.getEntryByQuestion(questionId);
    if (!entry) throw new NotFoundException({ message: `Question ${questionId} has no bank entry`, code: 'question.entry_missing' });
    return this.repo.listVersions(entry.id);
  }

  /** Chi tiết câu hỏi CHO NGƯỜI ĐỌC (cổng tại context của category chứa câu). */
  async getQuestionForViewer(actorId: string, id: string): Promise<QuestionView> {
    await this.assertQuestionReadable(actorId, id);
    const view = await this.getQuestion(id);
    return this.resolveQuestionImages(view);
  }

  /**
   * Phát URL ký cho ảnh nhúng trong mọi tài liệu của một QuestionView (thân
   * câu, phản hồi chung, đáp án + phản hồi của đáp án, ngữ liệu). Cổng đọc
   * câu hỏi của bề mặt này (assertQuestionReadable) là cổng uỷ quyền cho các
   * URL ký đó — xem FilesService.resolveQuestionImageUrls.
   */
  private async resolveQuestionImages(view: QuestionView): Promise<QuestionView> {
    const [questionText, generalFeedback, stimulusContent] = await Promise.all([
      this.files.resolveQuestionImageUrls(view.latestVersion.questionText),
      this.files.resolveQuestionImageUrls(view.latestVersion.generalFeedback),
      view.stimulus ? this.files.resolveQuestionImageUrls(view.stimulus.content) : Promise.resolve(null),
    ]);
    const answers = await Promise.all(view.answers.map(async (a) => ({
      ...a,
      answer: await this.files.resolveQuestionImageUrls(a.answer),
      feedback: await this.files.resolveQuestionImageUrls(a.feedback),
    })));
    // Guidance + lời giải mẫu của essay cũng là tài liệu rich text có
    // thể nhúng ảnh — phát URL ký cùng cổng đọc với thân câu (guidance
    // hiện cho học sinh lúc làm bài qua attempt view, cổng của nó nằm ở
    // bề mặt quiz; ở đây mới chỉ là đường đọc ngân hàng có cổng
    // question:useall).
    const guidance = await this.files.resolveQuestionImageUrls(view.answerKey.guidance as never);
    let solution: unknown = view.answerKey.solution;
    const solutionAnswer = (solution as { answer?: unknown } | null)?.answer;
    if (solutionAnswer !== undefined) {
      solution = { ...(solution as Record<string, unknown>), answer: await this.files.resolveQuestionImageUrls(solutionAnswer as never) };
    }
    return {
      ...view,
      latestVersion: { ...view.latestVersion, questionText, generalFeedback },
      answers,
      answerKey: { guidance, solution },
      stimulus: view.stimulus && stimulusContent ? { ...view.stimulus, content: stimulusContent } : view.stimulus,
    };
  }

  /** Lịch sử version CHO NGƯỜI ĐỌC (cùng cổng với chi tiết câu hỏi). */
  async listVersionsForViewer(actorId: string, questionId: string): Promise<VersionRow[]> {
    await this.assertQuestionReadable(actorId, questionId);
    return this.listVersions(questionId);
  }
  /**
   * Nội dung một version cụ thể (answers + options) — dùng cho hiển thị và kiểm chứng theo version.
   */
  /**
   * Nội dung một version CỤ THỂ (answers + options + bản ghi phía đáp
   * án) — bề mặt quiz dựng attempt view từ version ĐÃ PIN bằng hàm
   * này: guidance của bản ghi phía đáp án hiện kèm câu hỏi trong lúc
   * làm (điểm quyết D-4), solution chỉ lộ theo cổng xem lại của lần
   * ghim ở tầng quiz.
   */
  async getVersionContent(questionId: string, versionId: string): Promise<{ version: VersionRow; answers: AnswerRow[]; answerKey: { guidance: unknown; solution: unknown }; options: Record<string, unknown> | null }> {
    const q = await this.repo.getQuestion(questionId);
    if (!q) throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
    const version = await this.repo.getVersion(versionId);
    if (!version || version.questionId !== questionId) {
      throw new NotFoundException({ message: `Question version ${versionId} not found`, code: 'question.version_missing' });
    }
    const answers = await this.repo.listAnswers(version.id);
    const answerKey = await this.answerKeyOf(version.id);
    const options = await this.optionsView(q.qtype, version.id);
    return { version, answers, answerKey, options };
  }

  /** Sửa tạo một version MỚI; version hiện có (và attempt pin vào chúng) không bị chạm. */
  /**
   * Sửa câu hỏi = tạo version mới và nâng latestVersion của entry. Phần
   * đáp án/options không được gửi lên thì nhân bản nguyên từ version trước
   * sang version mới; stimulusId = null gỡ gắn ngữ liệu, không gửi thì giữ.
   */
  /**
   * Sửa câu hỏi = tạo version mới và nâng latestVersion của entry. Phần
   * đáp án/options không được gửi lên thì nhân bản nguyên từ version
   * trước sang version mới; stimulusId = null gỡ gắn ngữ liệu, không
   * gửi thì giữ. Guidance/solution (bản ghi phía đáp án) không được gửi
   * lên thì KẾ THỪA từ version trước — cùng ngữ nghĩa kế thừa từng
   * trường của thân câu; gửi lên thì thay bằng giá trị mới trong cùng
   * giao dịch tạo version. Ngoại lệ TF-A: solution cũ chỉ kế thừa khi
   * tập statementId của thân mới == tập statementId solution cũ phủ;
   * thân mới đổi tập id mà không gửi solution thì từ chối 400
   * (`question.bad_answer_data`) thay vì ghi version mang solution
   * lệch tập — engine dựng danh sách ý từ solution nên lệch tập sẽ
   * chấm sai âm thầm.
   *
   * @param actorId - người sửa; phải có `question:editall` tại context
   *   của category chứa câu (và không phải bank personal của người khác).
   * @param input - payload sửa theo `QuestionContentInput`; luật phía
   *   đáp án kiểm theo qtype ĐÃ LƯU của câu qua `normaliseContent`.
   * @returns View đầy đủ của version mới nhất sau khi sửa.
   */
  async updateQuestion(actorId: string, questionId: string, input: QuestionContentInput): Promise<QuestionView> {
    const { question: q, entry, latestVersion } = await this.getQuestion(questionId);
    const category = await this.getCategory(q.category);
    await this.assertCategoryNotForeignPersonal(actorId, category, () => this.questionNotFound(questionId));
    await this.requireCap(actorId, 'question:editall', category.contextId);
    this.assertSupportedQtype(q.qtype);
    // Câu truefalse TF-A không có answers/options: thân câu (nơi chứa
    // mệnh đề) hoặc solution (đáp án từng mệnh đề) đổi là nội dung mới.
    const hasNewContent = input.answers !== undefined || input.options !== undefined
      || (q.qtype === 'truefalse' && (input.questionText !== undefined || input.solution !== undefined));
    const content = hasNewContent ? this.normaliseContent(q.qtype, input, latestVersion.questionText as RichTextDocument) : null;
    const touchesAnswerKey = input.guidance !== undefined || input.solution !== undefined;
    // Kế thừa phía đáp án của version trước cho các trường payload
    // không nhắc tới (chỉ khi version mới có nội dung đáp án mới hoặc
    // payload chủ động đổi phía đáp án).
    const prevKey = (content || touchesAnswerKey) ? await this.answerKeyOf(latestVersion.id) : null;
    if (content) {
      if (input.guidance === undefined) content.answerKey.guidance = prevKey!.guidance as RichTextDocument | null;
      if (input.solution === undefined) {
        // TF-A — chặn kế thừa solution lệch tập mệnh đề (khe S6):
        // thân mới đổi tập statementId (xoá/thêm mệnh đề) mà giữ
        // solution cũ thì engine dựng danh sách ý từ solution nên các
        // ý mới không khớp, chấm sai âm thầm. Chỉ kế thừa khi tập id
        // cũ == tập id mới; khác thì từ chối rõ ràng, bắt người sửa
        // gửi kèm solution.answers phủ đúng tập mới. Thân không đổi
        // thì tập id không đổi nên kế thừa an toàn (đường sửa chỉ đổi
        // stem/guidance của read-gate vẫn đi qua đây).
        if (q.qtype === 'truefalse' && input.questionText !== undefined) {
          const newStatements = getTrueFalseStatements(toRichTextDocument(input.questionText));
          const prevAnswers = (prevKey!.solution as { answers?: { statementId: string }[] } | null)?.answers;
          if (prevAnswers && newStatements) {
            const prevIds = new Set(prevAnswers.map((a) => a.statementId));
            const newIds = new Set(newStatements.map((s) => s.id));
            if (prevIds.size !== newIds.size || [...prevIds].some((id) => !newIds.has(id))) {
              throw badAnswerData('truefalse solution inheritance requires the new question text to carry exactly the statements covered by the previous solution; send solution.answers covering the new statements');
            }
          }
        }
        content.answerKey.solution = prevKey!.solution as StoredSolution | null;
      }
    }
    let stimulusId = latestVersion.stimulusId;
    if (input.stimulusId !== undefined) {
      stimulusId = input.stimulusId === null ? null : (await this.resolveStimulus(input.stimulusId, category.id)).id;
    }
    const nextVersion = entry.latestVersion + 1;
    let version!: VersionRow;
    await this.repo.transaction(async (tx) => {
      version = await this.repo.insertVersion({
        questionBankEntryId: entry.id, questionId: q.id, version: nextVersion,
        questionText: (input.questionText !== undefined ? toRichTextDocument(input.questionText) : latestVersion.questionText) as never,
        generalFeedback: (input.generalFeedback !== undefined ? toRichTextDocument(input.generalFeedback) : latestVersion.generalFeedback) as never,
        defaultMark: input.defaultMark ?? latestVersion.defaultMark,
        penalty: input.penalty ?? latestVersion.penalty,
        stimulusId: stimulusId,
      }, tx);
      if (content) {
        await this.writeVersionContent(tx, q.qtype as SupportedQtype, version.id, content);
      } else if (touchesAnswerKey) {
        // Chỉ đổi phía đáp án: nhân bản answers/options, bỏ qua bản ghi
        // phía đáp án cũ rồi ghi bản ghi mới (trường không gửi lên lấy
        // lại từ bản ghi trước).
        await this.cloneVersionContent(tx, q.qtype as SupportedQtype, latestVersion.id, version.id, true);
        const guidance = input.guidance !== undefined ? this.docOrNull(input.guidance) : (prevKey!.guidance as RichTextDocument | null);
        const solution: StoredSolution | null = input.solution !== undefined
          ? (q.qtype === 'essay' && 'answer' in input.solution
            ? { answer: toRichTextDocument(input.solution.answer) }
            : q.qtype === 'truefalse' && 'answers' in input.solution
              ? { answers: input.solution.answers.map((a) => ({ statementId: a.statementId, value: a.value === true })) }
              : null)
          : (prevKey!.solution as StoredSolution | null);
        if (guidance !== null || solution !== null) {
          await this.repo.insertAnswerKey({ questionVersionId: version.id, guidance: guidance as never, solution: solution as never }, tx);
        }
      } else {
        await this.cloneVersionContent(tx, q.qtype as SupportedQtype, latestVersion.id, version.id);
      }
      // Câu nhập từ Ngân hàng hệ thống bị sửa ở trung tâm thì thành bản
      // phái sinh (issue #585): đổi cờ trong CÙNG transaction với việc
      // tạo version mới — phiên bản nguyên trạng vẫn đọc lại được theo
      // số hiệu version đã nhập, chỉ kind đổi từ `pristine` sang
      // `derived`. Điều kiện kind = 'pristine' giữ tính idempotent.
      await this.repo.markSystemImportDerived(q.id, tx);
    });
    await this.repo.updateEntry(entry.id, { latestVersion: nextVersion });
    await this.repo.updateQuestion(q.id, { modifiedBy: actorId });
    await this.outbox.enqueueStandalone({ aggregate: 'question', type: 'question_updated', payload: { questionId: q.id, version: nextVersion } });
    return this.getQuestion(q.id);
  }

  // --- bank: curriculum links (issue #20 Chặng 2, mục A.6) ----------------------
  // Gắn kết ở CẤP DANH TÍNH câu hỏi: sửa câu (version mới) không làm mất
  // gắn kết. Quyền ghi = capability sửa câu hỏi (question:editall) tại
  // context của category chứa câu — như mọi thao tác ghi câu hiện hành.

  /** Câu hỏi + kiểm tra quyền sửa câu tại context của category chứa nó. */
  private async questionForEdit(actorId: string, questionId: string): Promise<QuestionRow> {
    const q = await this.repo.getQuestion(questionId);
    if (!q) throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
    const category = await this.getCategory(q.category);
    await this.assertCategoryNotForeignPersonal(actorId, category, () => this.questionNotFound(questionId));
    await this.requireCap(actorId, 'question:editall', category.contextId);
    return q;
  }

  /** Gắn kết chương trình của câu hỏi CHO NGƯỜI ĐỌC (cùng cổng với chi tiết câu). */
  async getCurriculumLinksForViewer(actorId: string, questionId: string): Promise<QuestionCurriculumLinksView> {
    await this.assertQuestionReadable(actorId, questionId);
    return this.getCurriculumLinks(questionId);
  }

  /** Đọc toàn bộ gắn kết chương trình của một câu hỏi. */
  async getCurriculumLinks(questionId: string): Promise<QuestionCurriculumLinksView> {
    const q = await this.repo.getQuestion(questionId);
    if (!q) throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
    const subjectLinks = await this.repo.listQuestionSubjectLinks(questionId);
    const outcomeLinks = await this.repo.listQuestionOutcomeLinks(questionId);
    return {
      questionId,
      subjectIds: subjectLinks.map((l) => l.subjectId),
      outcomes: outcomeLinks.map((l) => ({ outcomeId: l.learningOutcomeId, cognitiveLevel: l.cognitiveLevel })),
    };
  }

  /** Gắn câu hỏi vào một môn học (mức môn); gắn trùng → 409. */
  async attachSubject(actorId: string, questionId: string, subjectId: string): Promise<QuestionCurriculumLinksView> {
    await this.questionForEdit(actorId, questionId);
    const subject = await this.repo.getSubjectRow(subjectId);
    if (!subject) throw new NotFoundException({ message: `Subject ${subjectId} not found`, code: 'curriculum.subject_not_found' });
    if (await this.repo.getQuestionSubjectLink(questionId, subjectId)) {
      throw new ConflictException({ message: 'Question is already linked to this subject', code: 'question.subject_link_exists' });
    }
    try {
      await this.repo.insertQuestionSubjectLink({ questionId, subjectId });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ message: 'Question is already linked to this subject', code: 'question.subject_link_exists' });
      }
      throw err;
    }
    return this.getCurriculumLinks(questionId);
  }

  /** Gỡ gắn môn của một câu hỏi; không có dòng gắn → 404. */
  async detachSubject(actorId: string, questionId: string, subjectId: string): Promise<QuestionCurriculumLinksView> {
    await this.questionForEdit(actorId, questionId);
    if (!(await this.repo.deleteQuestionSubjectLink(questionId, subjectId))) {
      throw new NotFoundException({ message: 'Question is not linked to this subject', code: 'question.subject_link_not_found' });
    }
    return this.getCurriculumLinks(questionId);
  }

  /**
   * Gắn câu hỏi vào một YCCĐ kèm mức độ nhận thức của cặp (mức nằm trên
   * dòng nối — mục A.2). KHÔNG có quy tắc nhất quán môn ở cửa này (vòng
   * sửa F1 của review độc lập Chặng 2): `question_subjects` chỉ là khai
   * báo tường minh, và môn của câu khi lọc/đếm là hợp nhất khai báo
   * tường minh với môn suy ngược từ các YCCĐ đã gắn (xem
   * `filterQuestionsByCurriculumLinks`) — nên gắn YCCĐ thuộc bất kỳ môn
   * nào cũng được, bất kể câu đã khai môn gì hay chưa.
   */
  async attachOutcome(actorId: string, questionId: string, outcomeId: string, cognitiveLevel: string): Promise<QuestionCurriculumLinksView> {
    await this.questionForEdit(actorId, questionId);
    const chain = await this.repo.getOutcomeChain(outcomeId);
    if (!chain) throw new NotFoundException({ message: `Learning outcome ${outcomeId} not found`, code: 'curriculum.outcome_not_found' });
    if (await this.repo.getQuestionOutcomeLink(questionId, outcomeId)) {
      throw new ConflictException({ message: 'Question is already linked to this learning outcome', code: 'question.outcome_link_exists' });
    }
    try {
      await this.repo.insertQuestionOutcomeLink({ questionId, learningOutcomeId: outcomeId, cognitiveLevel });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ message: 'Question is already linked to this learning outcome', code: 'question.outcome_link_exists' });
      }
      throw err;
    }
    return this.getCurriculumLinks(questionId);
  }

  /** Đổi mức độ nhận thức của một dòng nối câu–YCCĐ đã gắn. */
  async updateOutcomeLink(actorId: string, questionId: string, outcomeId: string, cognitiveLevel: string): Promise<QuestionCurriculumLinksView> {
    await this.questionForEdit(actorId, questionId);
    if (!(await this.repo.getQuestionOutcomeLink(questionId, outcomeId))) {
      throw new NotFoundException({ message: 'Question is not linked to this learning outcome', code: 'question.outcome_link_not_found' });
    }
    await this.repo.updateQuestionOutcomeLink(questionId, outcomeId, cognitiveLevel);
    return this.getCurriculumLinks(questionId);
  }

  /** Gỡ gắn YCCĐ của một câu hỏi; không có dòng gắn → 404. */
  async detachOutcome(actorId: string, questionId: string, outcomeId: string): Promise<QuestionCurriculumLinksView> {
    await this.questionForEdit(actorId, questionId);
    if (!(await this.repo.deleteQuestionOutcomeLink(questionId, outcomeId))) {
      throw new NotFoundException({ message: 'Question is not linked to this learning outcome', code: 'question.outcome_link_not_found' });
    }
    return this.getCurriculumLinks(questionId);
  }

  /** Kiểm chứng hình dạng bộ lọc chương trình (dùng chung cho bản nội bộ và bản có cổng đọc). */
  private validateCurriculumFilter(filter: {
    subjectId?: string; outcomeId?: string; nodeId?: string; cognitiveLevel?: string; qtype?: string; status?: string;
  }): void {
    for (const [field, value] of [['subjectId', filter.subjectId], ['outcomeId', filter.outcomeId], ['nodeId', filter.nodeId]] as const) {
      if (value !== undefined && !uuidIdSchema.safeParse(value).success) {
        throw new BadRequestException({ message: `${field} must be a uuid`, code: 'question.invalid_filter' });
      }
    }
    if (filter.cognitiveLevel !== undefined && !cognitiveLevelSchema.safeParse(filter.cognitiveLevel).success) {
      throw new BadRequestException({ message: `cognitiveLevel ${filter.cognitiveLevel} is not a known cognitive level`, code: 'question.invalid_cognitive_level' });
    }
  }

  /**
   * Lọc ngân hàng theo gắn kết chương trình + dạng + trạng thái (mục
   * A.6) — phục vụ UI soạn câu và đếm ứng viên ma trận. Trả view đầy đủ
   * như các endpoint liệt kê hiện hành của ngân hàng.
   */
  async listQuestionsByCurriculumFilter(filter: {
    subjectId?: string; outcomeId?: string; nodeId?: string; cognitiveLevel?: string; qtype?: string; status?: string;
  }): Promise<QuestionView[]> {
    this.validateCurriculumFilter(filter);
    const rows = await this.repo.filterQuestionsByCurriculumLinks(filter);
    return this.loadQuestionViews(rows);
  }

  /**
   * Số câu khớp bộ lọc chương trình, NHÓM THEO category của bank
   * entry, đếm bằng `count()` tại SQL (issue #488) — cho các đường chỉ
   * cần số đếm như đếm ứng viên ô ma trận: không nạp danh sách câu,
   * không lắp view. Điều kiện lọc và cổng kiểm chứng bộ lọc giống hệt
   * listQuestionsByCurriculumFilter.
   */
  async countQuestionsByCurriculumFilterByCategory(filter: {
    subjectId?: string; outcomeId?: string; nodeId?: string; cognitiveLevel?: string; qtype?: string; status?: string;
  }): Promise<{ categoryId: string; count: number }[]> {
    this.validateCurriculumFilter(filter);
    return this.repo.countQuestionsByCurriculumFilterPerCategory(filter);
  }

  /**
   * Bản có cổng đọc của bộ lọc chương trình (issue #55): chỉ trả các câu
   * nằm trong category mà người đọc có `question:useall` tại context của
   * category — câu ngoài quyền bị loại khỏi danh sách, không lộ cả sự
   * tồn tại qua bộ lọc.
   */
  async listQuestionsByCurriculumFilterForViewer(actorId: string, filter: {
    subjectId?: string; outcomeId?: string; nodeId?: string; cognitiveLevel?: string; qtype?: string; status?: string;
  }): Promise<QuestionView[]> {
    this.validateCurriculumFilter(filter);
    const rows = await this.repo.filterQuestionsByCurriculumLinks(filter);
    const readableByCategory = new Map<string, boolean>();
    const included: QuestionRow[] = [];
    for (const q of rows) {
      let ok = readableByCategory.get(q.category);
      if (ok === undefined) {
        const category = await this.repo.getCategory(q.category);
        ok = category !== undefined && (await this.canUseBank(actorId, category.contextId));
        readableByCategory.set(q.category, ok);
      }
      if (ok) included.push(q);
    }
    return this.loadQuestionViews(included);
  }

  // --- engine ------------------------------------------------------------------

  /**
   * Tạo usage mới cho một component (vd quiz) với behaviour cho trước.
   */
  async createUsage(actorId: string, input: {
    component: string; instanceId?: string; contextId?: string; preferredBehaviour?: string;
    slots: { questionId: string; maxMark?: number; pinnedVersionId?: string }[];
  }): Promise<UsageView> {
    const behaviour = input.preferredBehaviour ?? 'deferredfeedback';
    if (!BEHAVIOURS[behaviour]) {
      throw new BadRequestException({ message: `Unknown question behaviour ${behaviour}`, code: 'question.unknown_behaviour' });
    }
    if (!input.slots.length) throw new BadRequestException({ message: 'A usage needs at least one question slot', code: 'question.usage_empty' });
    const usage = await this.repo.insertUsage({
      component: input.component, instanceId: input.instanceId ?? null,
      owningContextId: input.contextId ?? null, preferredBehaviour: behaviour, userId: actorId,
    });
    let slot = 1;
    for (const s of input.slots) {
      const view = await this.getQuestion(s.questionId);
      void view;
      // Câu còn draft (nạp qua MCP chờ duyệt) không được rút vào đề ở
      // MỌI cổng dùng câu — cổng usage này trước đây không kiểm trạng
      // thái nên draft lọt vào đề thật (MCP-0, issue #110). Câu hidden
      // vẫn cho qua theo ngữ nghĩa QB-3: đề đã ghim giữ nguyên phục vụ.
      const usageEntry = await this.repo.getEntryByQuestion(s.questionId);
      if (usageEntry?.status === 'draft') {
        throw new BadRequestException({ message: 'Draft questions cannot be used in a quiz until they are reviewed and published', code: 'question.usage_draft_question' });
      }
      if (s.pinnedVersionId) {
        // Slot ghim cứng (QB-3): version mang sẵn trên attempt, startAttempt tôn trọng tuyệt đối.
        const pinned = await this.repo.getVersion(s.pinnedVersionId);
        if (!pinned || pinned.questionId !== s.questionId) {
          throw new BadRequestException({ message: `Pinned version ${s.pinnedVersionId} does not belong to question ${s.questionId}`, code: 'question.pinned_version_mismatch' });
        }
      }
      await this.repo.insertAttempt({
        questionUsageId: usage.id, slot: slot++, behaviour,
        questionId: s.questionId, questionVersionId: s.pinnedVersionId ?? null,
        maxMark: s.maxMark ?? view.latestVersion.defaultMark,
        questionSummary: extractRichTextPlainText(view.latestVersion.questionText as RichTextDocument), userId: actorId,
        state: 'notstarted',
      });
    }
    await this.outbox.enqueueStandalone({ aggregate: 'question', type: 'question_usage_created', payload: { usageId: usage.id, component: input.component, instanceId: input.instanceId ?? 0, userId: actorId, actorId } });
    return this.getUsage(usage.id);
  }

  /**
   * Id các câu hỏi trong một category (dạng nhẹ cho hoạt động cần rút câu,
   * vd slot ngẫu nhiên của quiz — không nạp nội dung từng câu).
   */
  async listQuestionIdsInCategory(categoryId: string): Promise<string[]> {
    const rows = await this.repo.listQuestionsInCategory(categoryId);
    return rows.map((r) => r.id);
  }
  /**
   * Id câu hỏi còn DÙNG ĐƯỢC trong category (loại câu đã rút — trạng thái
   * hidden, QB-3): slot ngẫu nhiên của quiz chỉ rút trong tập này.
   */
  async listUsableQuestionIdsInCategory(categoryId: string): Promise<string[]> {
    const rows = await this.repo.listQuestionsInCategory(categoryId);
    const out: string[] = [];
    for (const r of rows) {
      const entry = await this.repo.getEntryByQuestion(r.id);
      // Chỉ câu `ready` mới được rút ngẫu nhiên vào đề: draft (câu nạp
      // qua MCP chờ duyệt — MCP-0, issue #110) và hidden (đã rút) đều
      // bị loại; trước đây điều kiện chỉ loại hidden nên draft lọt.
      if (entry && entry.status === 'ready') out.push(r.id);
    }
    return out;
  }
  /**
   * Xoá một usage cùng mọi attempt/step của nó (hoạt động sở hữu usage
   * chịu trách nhiệm gọi khi instance bị xoá).
   */
  async deleteUsage(usageId: string): Promise<void> {
    await this.repo.deleteUsage(usageId);
  }

  /**
   * Cổng tạo usage qua HTTP (issue #55): usage thô trên câu ngân hàng là
   * đường đọc nội dung câu kèm đáp án (làm thử → finish → đáp án đúng),
   * nên người tạo phải có `question:useall` tại context của category của
   * MỌI câu trong slot; thiếu một câu → 404 như câu không tồn tại. Chỉ
   * áp ở controller: quiz tạo usage ở tầng service bằng actor là học
   * sinh cho lượt làm thật, luồng đó do cổng của hoạt động quiz gác.
   */
  async assertCanCreateUsage(actorId: string, questionIds: string[]): Promise<void> {
    const allowedByContext = new Map<string, boolean>();
    for (const questionId of questionIds) {
      const q = await this.repo.getQuestion(questionId);
      if (!q) throw this.questionNotFound(questionId);
      const category = await this.repo.getCategory(q.category);
      if (!category) throw this.questionNotFound(questionId);
      let ok = allowedByContext.get(category.contextId);
      if (ok === undefined) {
        ok = await this.canUseBank(actorId, category.contextId);
        allowedByContext.set(category.contextId, ok);
      }
      if (!ok) throw this.questionNotFound(questionId);
    }
  }

  /**
   * Lấy usage CHO NGƯỜI ĐỌC (issue #55): usage chứa bài làm và — sau khi
   * chốt — đáp án đúng của từng attempt, nên chỉ chủ sở hữu usage hoặc
   * người có `question:useall` ở context hệ thống (đội ngân hàng) mới
   * đọc được qua HTTP; người khác nhận 404 như usage không tồn tại.
   */
  async getUsageForViewer(actorId: string, id: string): Promise<UsageView> {
    const usage = await this.repo.getUsage(id);
    if (!usage) throw this.usageNotFound(id);
    if (usage.userId !== actorId) {
      const system = await this.contexts.ensureSystemContext();
      if (!(await this.canUseBank(actorId, system.id))) throw this.usageNotFound(id);
    }
    return this.getUsage(id);
  }

  /**
   * Lấy usage kèm các attempt và trạng thái tổng.
   */
  async getUsage(id: string): Promise<UsageView> {
    const usages = await this.getUsages([id]);
    const view = usages.get(id);
    if (!view) throw new NotFoundException({ message: `Question usage ${id} not found`, code: 'question.usage_not_found' });
    return view;
  }

  /**
   * Lấy NHIỀU usage kèm attempt và step trong số truy vấn cố định
   * (DL-03, issue #489): bốn lượt nạp theo lô (usage, attempt, step,
   * dữ liệu step) rồi lắp view bằng đúng bộ dựng của đường đọc lẻ, nên
   * hình dạng và thứ tự (attempt theo slot, step theo số thứ tự) của
   * từng view khớp hệt `getUsage`. Usage không tồn tại thì vắng mặt
   * trong map — caller cần lỗi "không thấy" thì tự kiểm như
   * `getUsage` đang làm.
   */
  async getUsages(ids: string[]): Promise<Map<string, UsageView>> {
    const uniqueIds = [...new Set(ids)];
    const views = new Map<string, UsageView>();
    if (!uniqueIds.length) return views;
    const usages = await this.repo.getUsagesByIds(uniqueIds);
    const attempts = await this.repo.listAttemptsForUsages(uniqueIds);
    const steps = await this.repo.listStepsForAttempts(attempts.map((a) => a.id));
    const dataRows = await this.repo.listStepDataForSteps(steps.map((s) => s.id));
    const attemptsByUsage = new Map<string, AttemptRow[]>();
    for (const a of attempts) {
      const list = attemptsByUsage.get(a.questionUsageId) ?? [];
      list.push(a);
      attemptsByUsage.set(a.questionUsageId, list);
    }
    const stepsByAttempt = new Map<string, StepRow[]>();
    for (const s of steps) {
      const list = stepsByAttempt.get(s.questionAttemptId) ?? [];
      list.push(s);
      stepsByAttempt.set(s.questionAttemptId, list);
    }
    const dataByStep = new Map<string, Map<string, string | null>>();
    for (const d of dataRows) {
      const byName = dataByStep.get(d.attemptStepId) ?? new Map<string, string | null>();
      byName.set(d.name, d.value);
      dataByStep.set(d.attemptStepId, byName);
    }
    for (const usage of usages) {
      views.set(usage.id, this.buildUsageView(usage, attemptsByUsage.get(usage.id) ?? [], stepsByAttempt, dataByStep));
    }
    return views;
  }

  /** Lắp một UsageView từ các dòng đã nạp sẵn — dùng chung cho đường lẻ và đường theo lô. */
  private buildUsageView(
    usage: UsageRow,
    attempts: AttemptRow[],
    stepsByAttempt: Map<string, StepRow[]>,
    dataByStep: Map<string, Map<string, string | null>>,
  ): UsageView {
    const views: AttemptView[] = attempts.map((a) => ({
      ...a,
      steps: (stepsByAttempt.get(a.id) ?? []).map((s) => ({
        id: s.id, sequenceNumber: s.sequenceNumber, state: s.state, fraction: s.fraction,
        data: Object.fromEntries(dataByStep.get(s.id) ?? []),
      })),
    }));
    return { usage, state: usageState(attempts.map((a) => a.state)), attempts: views };
  }

  /**
   * Tổng điểm tối đa (tổng maxMark các attempt) của NHIỀU usage trong
   * một truy vấn (DL-03, issue #489): các đường đọc điểm chỉ cần con
   * số tổng này để quy điểm lượt về thang bài, không cần nạp cả cây
   * usage — thay cho vòng lặp `getUsage` theo từng lượt trước đây.
   * Usage không có attempt thì vắng mặt trong map (tổng coi như 0 ở
   * phía caller, khớp `usageTotalMax` trên view rỗng).
   */
  async usageTotalMaxes(usageIds: string[]): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    const uniqueIds = [...new Set(usageIds)];
    if (!uniqueIds.length) return totals;
    const attempts = await this.repo.listAttemptsForUsages(uniqueIds);
    for (const a of attempts) {
      totals.set(a.questionUsageId, (totals.get(a.questionUsageId) ?? 0) + a.maxMark);
    }
    return totals;
  }
  /**
   * Lấy một attempt.
   */
  async getAttempt(id: string): Promise<AttemptRow> {
    const row = await this.repo.getAttempt(id);
    if (!row) throw new NotFoundException({ message: `Question attempt ${id} not found`, code: 'question.attempt_not_found' });
    return row;
  }

  private async appendStep(attempt: AttemptRow, userId: string, state: QuestionState, fraction: number | null, data?: Record<string, string>): Promise<void> {
    const steps = await this.repo.listSteps(attempt.id);
    const seq = steps.length;
    await this.repo.transaction(async (tx) => {
      const step = await this.repo.insertStep({
        questionAttemptId: attempt.id, sequenceNumber: seq, state, fraction, userId: userId,
      }, tx);
      if (data) {
        for (const [name, value] of Object.entries(data)) {
          await this.repo.insertStepData({ attemptStepId: step.id, name, value }, tx);
        }
      }
    });
  }
  private async transition(attempt: AttemptRow, to: QuestionState): Promise<void> {
    if (!canTransition(attempt.state, to)) {
      throw new BadRequestException({ message: `Cannot move a question attempt from ${attempt.state} to ${to}`, code: 'question.bad_transition' });
    }
  }
  private async latestResponse(attemptId: string): Promise<string | null> {
    const steps = await this.repo.listSteps(attemptId);
    let response: string | null = null;
    for (const s of steps) {
      const data = await this.repo.listStepData(s.id);
      const answer = data.find((d) => d.name === 'answer');
      if (answer) response = answer.value;
    }
    return response;
  }

  /**
   * Dựng dữ liệu chấm của một version đã pin: multichoice/shortanswer
   * từ question_answers (cờ isCorrect) + options của qtype; truefalse
   * TF-A từ đáp án từng mệnh đề ở `question_answer_keys.solution` của
   * chính version đó, kèm thang Đ–S của lần ghim khi caller truyền vào
   * (đường usage thường không gắn lần ghim thì engine dùng mặc định
   * QĐ 764).
   */
  private async gradingDataFor(version: VersionRow, qtype: string, tfScale?: readonly number[] | null): Promise<GradingData> {
    const answers = await this.repo.listAnswers(version.id);
    const data: GradingData = {
      answers: answers.map((a) => ({
        id: a.id,
        text: extractRichTextPlainText(a.answer as RichTextDocument),
        isCorrect: a.isCorrect,
      })),
    };
    if (qtype === 'truefalse') {
      const key = await this.repo.getAnswerKey(version.id);
      const solution = key?.solution as { answers?: { statementId: string; value: boolean }[] } | null | undefined;
      data.truefalseStatements = (solution?.answers ?? []).map((a) => ({
        statementId: a.statementId,
        value: a.value === true,
      }));
      if (tfScale) data.tfScale = tfScale;
    } else if (qtype === 'shortanswer') {
      const o = await this.repo.getShortanswerOptions(version.id);
      data.shortanswer = {
        useCase: o?.useCase ?? false,
        numericAnswer: o?.numericAnswer ?? false,
        numericMaxLength: o?.numericMaxLength ?? null,
        numericAllowSign: o?.numericAllowSign ?? true,
        numericAllowDecimal: o?.numericAllowDecimal ?? true,
      };
    }
    return data;
  }

  // --- cổng thao tác usage (issue #60) ---------------------------------------

  /**
   * Cổng chủ sở hữu của các thao tác usage/attempt: chỉ chủ sở hữu
   * (`question_usages.user_id`) mới được start/submit/finish qua bất kỳ
   * kênh nào. Lệch chủ sở hữu ném 404 KHÔNG-oracle — cùng status, cùng mã
   * và cùng câu chữ như khi tài nguyên không tồn tại. Caller nội bộ hợp
   * lệ duy nhất (QuizService) luôn hành động với tư cách chủ sở hữu của
   * lượt (bắt đầu/nộp/chốt lượt đều truyền id của chủ lượt) nên không bị
   * ảnh hưởng; chấm tay đi qua `manualGradeAttempt` riêng, không qua đây.
   */
  private async requireOwnedUsage(userId: string, usageId: string): Promise<void> {
    const usage = await this.repo.getUsage(usageId);
    if (!usage || usage.userId !== userId) {
      throw new NotFoundException({ message: `Question usage ${usageId} not found`, code: 'question.usage_not_found' });
    }
  }
  private async requireOwnedAttempt(userId: string, attempt: AttemptRow): Promise<void> {
    const usage = await this.repo.getUsage(attempt.questionUsageId);
    if (!usage || usage.userId !== userId) {
      throw new NotFoundException({ message: `Question attempt ${attempt.id} not found`, code: 'question.attempt_not_found' });
    }
  }

  /**
   * Khoá kênh HTTP thô đối với usage gắn lượt quiz đang `inprogress`
   * (chính sách kênh, chỉ controller gọi — KHÔNG áp dụng trong các hàm
   * thao tác của service, vì chính luồng quiz chốt lượt bằng các hàm đó
   * trong lúc `quiz_attempts` vẫn `inprogress`): thao tác phải đi qua
   * luồng quiz để đáp án đúng/fraction chỉ lộ sau khi nộp qua quiz. Chỉ
   * người đã qua cổng chủ sở hữu mới chạm được lỗi này nên không lộ thông
   * tin cho người ngoài (người ngoài nhận 404 trước).
   */
  private async requireNotLockedByQuizAttempt(usageId: string): Promise<void> {
    const link = await this.repo.findQuizAttemptByUsageId(usageId);
    if (link && link.state === 'inprogress') {
      throw new ForbiddenException({
        message: 'This usage belongs to a quiz attempt in progress; answer and submit through the quiz',
        code: 'question.usage_managed_by_quiz',
      });
    }
  }
  /** Cổng kênh HTTP cho route cấp usage: chủ sở hữu + không bị khoá bởi lượt quiz đang làm. */
  async assertUsageManipulableViaHttp(actorId: string, usageId: string): Promise<void> {
    await this.requireOwnedUsage(actorId, usageId);
    await this.requireNotLockedByQuizAttempt(usageId);
  }
  /** Cổng kênh HTTP cho route cấp attempt: attempt phải thuộc đúng usage trên đường dẫn, chủ sở hữu, không bị khoá bởi lượt quiz đang làm. */
  async assertAttemptManipulableViaHttp(actorId: string, usageId: string, attemptId: string): Promise<void> {
    const attempt = await this.repo.getAttempt(attemptId);
    if (!attempt || attempt.questionUsageId !== usageId) {
      throw new NotFoundException({ message: `Question attempt ${attemptId} not found`, code: 'question.attempt_not_found' });
    }
    const usage = await this.repo.getUsage(usageId);
    if (!usage || usage.userId !== actorId) {
      throw new NotFoundException({ message: `Question attempt ${attemptId} not found`, code: 'question.attempt_not_found' });
    }
    await this.requireNotLockedByQuizAttempt(usageId);
  }

  /** Bắt đầu một attempt: PIN version latest hiện tại của bank entry. */
  /**
   * Bắt đầu attempt cho một slot: pin version hiện tại của câu hỏi.
   */
  async startAttempt(userId: string, attemptId: string): Promise<AttemptView> {
    const attempt = await this.getAttempt(attemptId);
    await this.requireOwnedAttempt(userId, attempt);
    await this.transition(attempt, 'todo');
    // Kỷ luật version (QB-3): attempt đã mang version ghim cứng từ
    // createUsage (slot pinned của quiz) thì tôn trọng tuyệt đối; ngược
    // lại follow_latest — chỉ nhận version `ready` mới nhất (bỏ qua bản
    // draft ở đầu); không có bản ready nào thì lùi về version mới nhất
    // TRỪ KHI câu đang ở draft: câu draft (nạp qua MCP chờ duyệt —
    // MCP-0, issue #110) không có version nào được phép phục vụ.
    let pinnedVersionId = attempt.questionVersionId;
    if (!pinnedVersionId) {
      const { entry } = await this.getQuestion(attempt.questionId);
      const versions = await this.repo.listVersions(entry.id);
      const ready = versions.filter((v) => v.status === 'ready');
      const chosen = ready.length ? ready[ready.length - 1]! : (entry.status === 'draft' ? undefined : versions[versions.length - 1]);
      if (!chosen) throw new NotFoundException({ message: `Question ${attempt.questionId} latest version missing`, code: 'question.version_missing' });
      pinnedVersionId = chosen.id;
    }
    await this.repo.updateAttempt(attempt.id, { state: 'todo', questionVersionId: pinnedVersionId, userId: userId });
    const updated = await this.getAttempt(attempt.id);
    await this.appendStep(updated, userId, 'todo', null);
    const usage = await this.getUsage(attempt.questionUsageId);
    return usage.attempts.find((a) => a.id === attemptId)!;
  }

  /** Nộp một response (deferredfeedback: lưu thành một step, CHƯA chấm). */
  /**
   * Nộp câu trả lời: ghi step, chấm theo behaviour, cập nhật trạng thái/fraction.
   */
  async submitResponse(userId: string, attemptId: string, response: string | null): Promise<AttemptView> {
    const attempt = await this.getAttempt(attemptId);
    await this.requireOwnedAttempt(userId, attempt);
    const behaviour = BEHAVIOURS[attempt.behaviour];
    if (!behaviour) throw new BadRequestException({ message: `Unknown behaviour ${attempt.behaviour}`, code: 'question.unknown_behaviour' });
    const to = behaviour.stateAfterSubmit(response);
    await this.transition(attempt, to);
    await this.repo.updateAttempt(attempt.id, { state: to, responseSummary: response ?? '', userId: userId });
    const updated = await this.getAttempt(attempt.id);
    await this.appendStep(updated, userId, to, null, { answer: response ?? '' });
    const usage = await this.getUsage(attempt.questionUsageId);
    return usage.attempts.find((a) => a.id === attemptId)!;
  }

  /** Kết thúc một attempt: chấm theo version ĐÃ PIN (không bao giờ là latest). */
  /**
   * Kết thúc một attempt: chấm theo answers/options của version ĐÃ PIN
   * (essay về needsgrading với fraction null, chờ chấm tay).
   */
  async finishAttempt(userId: string, attemptId: string, tfScale?: readonly number[] | null): Promise<AttemptView> {
    const attempt = await this.getAttempt(attemptId);
    await this.requireOwnedAttempt(userId, attempt);
    if (attempt.state === 'notstarted') {
      throw new BadRequestException({ message: 'Cannot finish an attempt that was never started', code: 'question.not_started' });
    }
    if (['gradedright', 'gradedpartial', 'gradedwrong', 'gaveup', 'needsgrading'].includes(attempt.state)) {
      const usage = await this.getUsage(attempt.questionUsageId);
      return usage.attempts.find((a) => a.id === attemptId)!;
    }
    const behaviour = BEHAVIOURS[attempt.behaviour];
    if (!behaviour) throw new BadRequestException({ message: `Unknown behaviour ${attempt.behaviour}`, code: 'question.unknown_behaviour' });
    if (!attempt.questionVersionId) throw new BadRequestException({ message: 'Attempt has no pinned version', code: 'question.no_version' });
    const version = await this.repo.getVersion(attempt.questionVersionId);
    if (!version) throw new NotFoundException({ message: 'Pinned question version missing', code: 'question.version_missing' });
    const q = await this.repo.getQuestion(attempt.questionId);
    const response = await this.latestResponse(attempt.id);
    const gradingData = await this.gradingDataFor(version, q?.qtype ?? '', tfScale);
    const outcome = behaviour.gradeAtFinish(q?.qtype ?? '', gradingData, response);
    let state: QuestionState;
    let fraction: number | null;
    if (outcome === null) { state = 'gaveup'; fraction = 0; }
    else { state = outcome.state; fraction = outcome.fraction; }
    await this.transition(attempt, state);
    await this.repo.updateAttempt(attempt.id, {
      state, fraction, rightAnswer: outcome?.rightAnswer ?? attempt.rightAnswer, userId: userId,
    });
    const updated = await this.getAttempt(attempt.id);
    await this.appendStep(updated, userId, state, fraction);
    const usage = await this.getUsage(attempt.questionUsageId);
    return usage.attempts.find((a) => a.id === attemptId)!;
  }

  /** Kết thúc mọi attempt trong một usage (điểm chấm của deferredfeedback) và phát sự kiện usage. */
  /**
   * Kết thúc toàn bộ usage: mọi attempt về trạng thái finished.
   */
  async finishUsage(userId: string, usageId: string, opts?: { tfScale?: readonly number[] | null }): Promise<UsageView> {
    await this.requireOwnedUsage(userId, usageId);
    const before = await this.getUsage(usageId);
    for (const a of before.attempts) {
      if (a.state !== 'notstarted') await this.finishAttempt(userId, a.id, opts?.tfScale);
    }
    const after = await this.getUsage(usageId);
    await this.outbox.enqueueStandalone({
      aggregate: 'question', type: 'question_usage_finished',
      payload: { usageId, userId, actorId: userId, state: after.state, attempts: after.attempts.map((a) => ({ attemptId: a.id, state: a.state, fraction: a.fraction })) },
    });
    return after;
  }

  /**
   * Chấm tay một attempt đang ở needsgrading (Moodle manual grading, dùng
   * cho essay): người chấm cho ĐIỂM TUYỆT ĐỐI theo maxMark của attempt;
   * fraction = mark / maxMark, trạng thái graded* suy từ fraction. Việc
   * chấm được ghi thành một step mang theo mark (và comment nếu có) trong
   * step data — đúng cách Moodle ghi bước chấm tay vào lịch sử attempt.
   */
  async manualGradeAttempt(graderId: string, attemptId: string, mark: number, comment?: string): Promise<AttemptView> {
    const attempt = await this.getAttempt(attemptId);
    if (attempt.state !== 'needsgrading') {
      throw new BadRequestException({ message: `Question attempt ${attemptId} is not waiting for manual grading (state ${attempt.state})`, code: 'question.not_needs_grading' });
    }
    if (!(mark >= 0) || attempt.maxMark <= 0 || mark > attempt.maxMark + 1e-9) {
      throw new BadRequestException({ message: `Manual mark must be between 0 and the attempt max mark (${attempt.maxMark})`, code: 'question.manual_mark_out_of_range' });
    }
    const fraction = Math.min(1, Math.max(0, mark / attempt.maxMark));
    const state = gradedStateForFraction(fraction);
    await this.transition(attempt, state);
    await this.repo.updateAttempt(attempt.id, { state, fraction, userId: attempt.userId ?? graderId });
    const updated = await this.getAttempt(attempt.id);
    const data: Record<string, string> = { mark: String(mark) };
    if (comment) data.comment = comment;
    data.gradedBy = graderId;
    await this.appendStep(updated, graderId, state, fraction, data);
    const usage = await this.getUsage(attempt.questionUsageId);
    return usage.attempts.find((a) => a.id === attemptId)!;
  }

  /**
   * Tính thử kết quả chấm lại của một question attempt theo dữ kiện chấm
   * của một version ĐÍCH (issue #254 — đường chấm lại theo đáp án): chấm
   * lại CHÍNH response đã lưu trong các step của attempt bằng
   * `gradeAnswer` với dữ liệu chấm của version đích — KHÔNG ghi gì xuống
   * DB. Dry-run ở tầng quiz và đường áp thật dùng chung đúng phép tính
   * này (qua {@link regradeAttemptWithVersion}) nên điểm xem trước khớp
   * tuyệt đối điểm sau khi áp.
   *
   * Điều kiện (ném BadRequestException): attempt phải ĐÃ được chấm tự
   * động (trạng thái gradedright/gradedpartial/gradedwrong/gaveup —
   * essay chờ chấm tay hoặc đã chấm tay không thuộc đường này), version
   * đích phải thuộc đúng câu của attempt và đang ở trạng thái `ready`.
   *
   * @param attemptId - Question attempt cần tính thử.
   * @param toVersionId - Version đích (bản đã sửa đáp án) để chấm lại theo.
   * @param tfScale - Thang Đ–S của lần ghim (cấu hình của lần ghim, như lúc chốt usage).
   * @returns Version đang ghim, version đích, fraction/trạng thái hiện tại và sau chấm lại.
   */
  async previewRegradeAttempt(attemptId: string, toVersionId: string, tfScale?: readonly number[] | null): Promise<{
    fromVersionId: string; toVersionId: string;
    oldFraction: number | null; oldState: string;
    newFraction: number | null; newState: string;
  }> {
    const attempt = await this.getAttempt(attemptId);
    const computed = await this.computeRegradeOutcome(attempt, toVersionId, tfScale);
    return {
      fromVersionId: attempt.questionVersionId!,
      toVersionId,
      oldFraction: attempt.fraction,
      oldState: attempt.state,
      newFraction: computed.outcome.fraction,
      newState: computed.outcome.state,
    };
  }

  /**
   * Chấm lại thật một question attempt theo version đích (issue #254):
   * cùng phép tính với {@link previewRegradeAttempt}, sau đó GHI —
   * fraction/trạng thái/rightAnswer mới và attempt CHUYỂN GHIM sang
   * version đích (từ đây attempt đứng trên bản đã sửa đáp án). Việc
   * chấm lại được ghi thành một step hiệu chỉnh mang step-data
   * `regradedBy`/`fromVersionId`/`toVersionId` trong lịch sử attempt.
   * Đây là bước HIỆU CHỈNH chứ không phải chuyển trạng thái vòng đời
   * (đúng ngữ nghĩa regrade của Moodle: append step vào attempt đã
   * graded) nên KHÔNG đi qua máy chuyển trạng thái `canTransition` —
   * các trạng thái graded* vốn không có cạnh ra trong máy đó.
   *
   * @param graderId - Người thực hiện chấm lại (ghi vào step).
   * @param attemptId - Question attempt cần chấm lại.
   * @param toVersionId - Version đích (bản đã sửa đáp án, phải `ready`).
   * @param tfScale - Thang Đ–S của lần ghim.
   * @returns Attempt sau chấm lại kèm fraction trước/sau để tầng gọi đồng bộ điểm.
   */
  async regradeAttemptWithVersion(graderId: string, attemptId: string, toVersionId: string, tfScale?: readonly number[] | null): Promise<{
    attempt: AttemptView; fromVersionId: string; oldFraction: number | null; newFraction: number | null;
  }> {
    const attempt = await this.getAttempt(attemptId);
    const computed = await this.computeRegradeOutcome(attempt, toVersionId, tfScale);
    const fromVersionId = attempt.questionVersionId!;
    const oldFraction = attempt.fraction;
    await this.repo.updateAttempt(attempt.id, {
      state: computed.outcome.state,
      fraction: computed.outcome.fraction,
      rightAnswer: computed.outcome.rightAnswer,
      questionVersionId: toVersionId,
    });
    const updated = await this.getAttempt(attempt.id);
    await this.appendStep(updated, graderId, computed.outcome.state, computed.outcome.fraction, {
      regradedBy: graderId, fromVersionId, toVersionId,
    });
    const usage = await this.getUsage(attempt.questionUsageId);
    return {
      attempt: usage.attempts.find((a) => a.id === attemptId)!,
      fromVersionId, oldFraction, newFraction: computed.outcome.fraction,
    };
  }

  /**
   * Phép tính chấm lại dùng chung cho xem thử và áp thật: kiểm điều
   * kiện của đường chấm lại theo đáp án rồi chấm response đã lưu theo
   * dữ kiện chấm của version đích. Response trống (lượt bỏ trống câu)
   * giữ ngữ nghĩa như lúc chốt usage: gaveup với fraction 0.
   */
  private async computeRegradeOutcome(attempt: AttemptRow, toVersionId: string, tfScale?: readonly number[] | null): Promise<{ outcome: GradeOutcome }> {
    if (!['gradedright', 'gradedpartial', 'gradedwrong', 'gaveup'].includes(attempt.state)) {
      throw new BadRequestException({
        message: `Question attempt ${attempt.id} is not auto-graded yet (state ${attempt.state}); only auto-graded attempts can be regraded against a corrected version`,
        code: 'question.attempt_not_graded',
      });
    }
    if (!attempt.questionVersionId) {
      throw new BadRequestException({ message: 'Attempt has no pinned version', code: 'question.no_version' });
    }
    const q = await this.repo.getQuestion(attempt.questionId);
    if (q?.qtype === 'essay') {
      throw new BadRequestException({
        message: 'Essay attempts are graded manually and cannot be regraded against an answer key',
        code: 'question.regrade_not_supported',
      });
    }
    const version = await this.repo.getVersion(toVersionId);
    if (!version || version.questionId !== attempt.questionId) {
      throw new NotFoundException({ message: `Question version ${toVersionId} not found for question ${attempt.questionId}`, code: 'question.version_not_found' });
    }
    if (version.status !== 'ready') {
      throw new BadRequestException({
        message: `Question version ${toVersionId} is not ready (status ${version.status}); regrading needs the corrected ready version`,
        code: 'question.regrade_version_not_ready',
      });
    }
    const rawResponse = await this.latestResponse(attempt.id);
    if (rawResponse === null || rawResponse.trim() === '') {
      return { outcome: { fraction: 0, state: 'gaveup', rightAnswer: attempt.rightAnswer ?? '' } };
    }
    // Dịch response sang version đích trước khi chấm: response của
    // multichoice lưu ID DÒNG ĐÁP ÁN của version đã ghim, mà mỗi
    // version sinh id dòng mới — chấm thẳng theo id sẽ không bao giờ
    // khớp. Lựa chọn của học sinh được hiểu theo NỘI DUNG đáp án đã
    // chọn: tra id cũ → text → id của dòng mang cùng text ở version
    // đích (đáp án đã bị xoá/đổi chữ ở version đích thì lựa chọn đó
    // không còn tương ứng — tính như chọn đáp án không đúng).
    // shortanswer (văn bản thuần) và truefalse TF-A (bản đồ
    // statementId → Đ/S, statementId nằm trong thân câu và được giữ
    // qua các version) không cần dịch.
    const response = q?.qtype === 'multichoice'
      ? await this.translateMultichoiceResponse(attempt.questionVersionId, version.id, rawResponse)
      : rawResponse;
    const gradingData = await this.gradingDataFor(version, q?.qtype ?? '', tfScale);
    return { outcome: gradeAnswer(q?.qtype ?? '', gradingData, response) };
  }

  /**
   * Dịch response multichoice (danh sách id dòng đáp án đã chọn, ngăn
   * bằng dấu phẩy) từ version nguồn sang version đích theo nội dung
   * text của đáp án (chuẩn hoá NFC + cắt khoảng trắng hai đầu, cùng
   * chuẩn so khớp nội dung của hệ). Id không tra được ở version nguồn
   * hoặc text không còn ở version đích bị loại khỏi danh sách đã dịch.
   */
  private async translateMultichoiceResponse(fromVersionId: string, toVersionId: string, response: string): Promise<string> {
    const [fromAnswers, toAnswers] = await Promise.all([
      this.repo.listAnswers(fromVersionId),
      this.repo.listAnswers(toVersionId),
    ]);
    const normalise = (value: string): string => value.normalize('NFC').trim();
    const toIdByText = new Map<string, string>();
    for (const a of toAnswers) {
      const text = normalise(extractRichTextPlainText(a.answer as RichTextDocument));
      if (!toIdByText.has(text)) toIdByText.set(text, a.id);
    }
    const fromById = new Map(fromAnswers.map((a) => [a.id, a]));
    const mapped: string[] = [];
    for (const id of response.split(',').map((x) => x.trim()).filter((x) => x !== '')) {
      const from = fromById.get(id);
      if (!from) continue;
      const toId = toIdByText.get(normalise(extractRichTextPlainText(from.answer as RichTextDocument)));
      if (toId) mapped.push(toId);
    }
    return mapped.join(',');
  }

  /** Bắt đầu mọi attempt của một usage (questionusagebyactivity_test::start_all_questions). */
  /**
   * Bắt đầu usage (ủy quyền nội bộ).
   */
  async startUsage(userId: string, usageId: string): Promise<UsageView> {
    await this.requireOwnedUsage(userId, usageId);
    const view = await this.getUsage(usageId);
    for (const a of view.attempts) {
      if (a.state === 'notstarted') await this.startAttempt(userId, a.id);
    }
    return this.getUsage(usageId);
  }

  /** Ném lỗi 403 chuẩn hoá của module (hàm hỗ trợ nội bộ). */
  forbidden(msg: string): never { throw new ForbiddenException({ message: msg, code: 'question.forbidden' }); }
}
