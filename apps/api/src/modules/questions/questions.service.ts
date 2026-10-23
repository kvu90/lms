import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { extractRichTextPlainText, toRichTextDocument, type RichTextDocument, type RichTextInput } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { BEHAVIOURS, canTransition, usageState, type GradingData, type QuestionState } from './domain/question-engine';
import {
  QuestionsRepository, type AnswerRow, type AttemptRow, type DbTx, type EntryRow, type QCategoryRow,
  type QuestionRow, type StimulusRow, type UsageRow, type VersionRow,
} from './questions.repository';

/** Một đáp án trong payload cấu trúc theo qtype (đầu vào của API). */
export interface QuestionAnswerInput {
  text: RichTextInput;
  fraction: number;
  feedback?: RichTextInput;
}

/** Options trong payload theo qtype — mỗi qtype chỉ dùng phần trường của nó (service kiểm chứng). */
export interface QuestionOptionsInput {
  single?: boolean;
  shuffleanswers?: boolean;
  answernumbering?: string;
  shownumcorrect?: boolean;
  showstandardinstruction?: boolean;
  correctfeedback?: RichTextInput;
  partiallycorrectfeedback?: RichTextInput;
  incorrectfeedback?: RichTextInput;
  usecase?: boolean;
  responseformat?: string;
  responserequired?: boolean;
  responsefieldlines?: number;
  minwordlimit?: number | null;
  maxwordlimit?: number | null;
  graderinfo?: RichTextInput;
  responsetemplate?: RichTextInput;
}

/** Payload tạo/sửa câu hỏi: một payload cấu trúc, service tự bung ra bảng khi lưu. */
export interface QuestionContentInput {
  questiontext?: RichTextInput;
  generalfeedback?: RichTextInput;
  guidance?: RichTextInput;
  defaultmark?: number;
  penalty?: number;
  stimulusId?: string | null;
  answers?: QuestionAnswerInput[];
  options?: QuestionOptionsInput;
  /** Dạng payload cũ (truefalse {correct}; shortanswer {answers, casesensitive?}) — vẫn nhận và ánh xạ sang answers/options. */
  answer?: Record<string, unknown>;
}

export interface QuestionView {
  question: QuestionRow;
  entry: EntryRow;
  latestVersion: VersionRow;
  answers: AnswerRow[];
  options: Record<string, unknown> | null;
  stimulus: StimulusRow | null;
}
export interface AttemptView extends AttemptRow {
  steps: { id: string; sequencenumber: number; state: string; fraction: number | null; data: Record<string, string | null> }[];
}
export interface UsageView {
  usage: UsageRow;
  state: string;
  attempts: AttemptView[];
}

export const SUPPORTED_QTYPES = ['multichoice', 'truefalse', 'shortanswer', 'essay'] as const;
export type SupportedQtype = (typeof SUPPORTED_QTYPES)[number];

/** Nội dung đã chuẩn hoá, sẵn sàng ghi xuống question_answers + bảng options. */
interface NormalisedContent {
  answers: { answer: RichTextDocument; fraction: number; feedback: RichTextDocument | null }[];
  multichoice?: { single: boolean; shuffleanswers: boolean; answernumbering: string; correctfeedback: RichTextDocument | null; partiallycorrectfeedback: RichTextDocument | null; incorrectfeedback: RichTextDocument | null; shownumcorrect: boolean; showstandardinstruction: boolean };
  truefalseCorrect?: boolean;
  truefalseShowStandardInstruction?: boolean;
  shortanswer?: { usecase: boolean };
  essay?: { responseformat: string; responserequired: boolean; responsefieldlines: number; minwordlimit: number | null; maxwordlimit: number | null; graderinfo: RichTextDocument | null; responsetemplate: RichTextDocument | null };
}

const FRACTION_SUM_TOLERANCE = 0.000001;

function badAnswerData(message: string): BadRequestException {
  return new BadRequestException({ message, code: 'question.bad_answer_data' });
}

/**
 * QuestionsModule facade (Moodle core_question): BANK + ENGINE.
 *
 * Bank invariants: editing a question NEVER mutates a version — it creates
 * the next version (with its own answers/options rows) and moves the bank
 * entry's latest pointer; usages created later resolve the new version,
 * attempts already started keep theirs.
 *
 * Content storage mirrors Moodle: answers live in question_answers
 * (fraction + per-answer feedback), options in the per-qtype table, and
 * questiontext/generalfeedback are Tiptap documents on the version row.
 * The API accepts ONE structured payload per qtype; the service spreads
 * it into those tables when saving.
 *
 * Engine invariants (questionusagebyactivity_test): a usage groups attempts
 * per (component, instanceid); starting an attempt PINS the current latest
 * version; every transition writes a step (with step_data for responses);
 * deferredfeedback grades at finish against the PINNED version's answers
 * and options; the usage state is a rollup of its attempts.
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
  ) {}

  private async requireCap(actorId: string, capability: string, contextId: string): Promise<void> {
    // Question contexts in this core are course/system contexts; the seeded
    // archetypes live at those levels and the evaluator walks the tree.
    await this.evaluator.requireCapability(actorId, capability, contextId);
  }
  private async contextOrSystem(contextId: string) {
    const ctx = await this.contexts.getContext(contextId).catch(() => undefined);
    return ctx ?? (await this.contexts.ensureSystemContext());
  }

  // --- bank: categories ------------------------------------------------------

  /**
   * Tạo category câu hỏi trong context.
   */
  async createCategory(actorId: string, input: { name: string; contextid: string; info?: string; parent?: string }): Promise<QCategoryRow> {
    const ctx = await this.contextOrSystem(input.contextid);
    await this.requireCap(actorId, 'moodle/question:managecategory', ctx.id);
    return this.repo.insertCategory({
      name: input.name, contextid: ctx.id, info: input.info ?? '', parent: input.parent ?? null,
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

  // --- bank: stimuli -----------------------------------------------------------

  /**
   * Tạo ngữ liệu (stimulus) trong một category. Quyền theo context của
   * category như câu hỏi: ai có quyền thêm câu hỏi ở category đó thì tạo
   * được ngữ liệu ở đó.
   */
  async createStimulus(actorId: string, input: { categoryId: string; content: RichTextInput }): Promise<StimulusRow> {
    const category = await this.getCategory(input.categoryId);
    await this.requireCap(actorId, 'moodle/question:add', category.contextid);
    const row = await this.repo.insertStimulus({
      categoryid: category.id, createdby: actorId, content: toRichTextDocument(input.content) as never,
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
    const category = await this.getCategory(stimulus.categoryid);
    await this.requireCap(actorId, 'moodle/question:editall', category.contextid);
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
    const category = await this.getCategory(stimulus.categoryid);
    await this.requireCap(actorId, 'moodle/question:editall', category.contextid);
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
   * Chuẩn hoá phần đáp án/options của payload thành nội dung ghi xuống bảng.
   * Kiểm chứng theo ngữ nghĩa qtype chuẩn Moodle:
   *  - multichoice: ít nhất 2 lựa chọn; tổng fraction dương phải bằng 1
   *    (quy tắc của form multichoice của Moodle: tổng tỷ trọng đúng = 100%).
   *  - truefalse: đáp án đúng/sai suy từ payload cũ {correct} — hai dòng
   *    'True'/'False' với fraction 1 ở phía đúng, 0 ở phía sai.
   *  - shortanswer: ít nhất 1 đáp án mẫu; fraction trong [0, 1]; usecase
   *    lấy từ options hoặc từ trường casesensitive của payload cũ.
   *  - essay: không có đáp án; options mang cấu hình trả lời + graderinfo
   *    + responsetemplate; giới hạn từ phải hợp lệ (min ≤ max).
   */
  private normaliseContent(qtype: SupportedQtype, input: QuestionContentInput): NormalisedContent {
    const options = input.options ?? {};
    if (qtype === 'essay') {
      if (input.answers && input.answers.length > 0) throw badAnswerData('essay questions do not carry answers; the response is graded manually');
      const min = options.minwordlimit ?? null;
      const max = options.maxwordlimit ?? null;
      if (min !== null && max !== null && min > max) throw badAnswerData('essay minwordlimit must not exceed maxwordlimit');
      return {
        answers: [],
        essay: {
          responseformat: options.responseformat ?? 'editor',
          responserequired: options.responserequired ?? true,
          responsefieldlines: options.responsefieldlines ?? 15,
          minwordlimit: min, maxwordlimit: max,
          graderinfo: this.docOrNull(options.graderinfo),
          responsetemplate: this.docOrNull(options.responsetemplate),
        },
      };
    }
    if (qtype === 'truefalse') {
      const correct = input.answer?.correct;
      if (typeof correct !== 'boolean') throw badAnswerData('truefalse requires answer data {correct: boolean}');
      return {
        answers: [
          { answer: toRichTextDocument('True'), fraction: correct ? 1 : 0, feedback: null },
          { answer: toRichTextDocument('False'), fraction: correct ? 0 : 1, feedback: null },
        ],
        truefalseCorrect: correct,
        truefalseShowStandardInstruction: options.showstandardinstruction ?? true,
      };
    }
    // multichoice / shortanswer dùng danh sách answers — từ payload cấu trúc
    // mới hoặc ánh xạ từ payload cũ của shortanswer.
    let rawAnswers: QuestionAnswerInput[] | undefined = input.answers;
    let usecase = options.usecase ?? false;
    if (!rawAnswers && qtype === 'shortanswer' && input.answer) {
      const legacy = input.answer.answers;
      if (!Array.isArray(legacy) || legacy.length === 0) throw badAnswerData('shortanswer answer data requires {answers: string[]}');
      rawAnswers = legacy.map((text) => ({ text: String(text), fraction: 1 }));
      usecase = input.answer.casesensitive === true;
    }
    if (!rawAnswers || rawAnswers.length === 0) {
      throw badAnswerData(`${qtype} requires at least one answer in the structured answers list`);
    }
    const answers = rawAnswers.map((a) => ({
      answer: toRichTextDocument(a.text),
      fraction: a.fraction,
      feedback: a.feedback === undefined ? null : toRichTextDocument(a.feedback),
    }));
    if (qtype === 'shortanswer') {
      for (const a of answers) {
        if (!(a.fraction >= 0 && a.fraction <= 1)) throw badAnswerData('shortanswer answer fractions must be within [0, 1]');
      }
      if (!answers.some((a) => a.fraction > 0)) throw badAnswerData('shortanswer requires at least one answer with a positive fraction');
      return { answers, shortanswer: { usecase } };
    }
    // multichoice
    if (answers.length < 2) throw badAnswerData('multichoice requires at least two choices');
    for (const a of answers) {
      if (!(a.fraction >= -1 && a.fraction <= 1)) throw badAnswerData('multichoice answer fractions must be within [-1, 1]');
    }
    const positiveSum = answers.filter((a) => a.fraction > 0).reduce((sum, a) => sum + a.fraction, 0);
    if (Math.abs(positiveSum - 1) > FRACTION_SUM_TOLERANCE) {
      throw badAnswerData('multichoice positive fractions must add up to 1 (100%)');
    }
    return {
      answers,
      multichoice: {
        single: options.single ?? true,
        shuffleanswers: options.shuffleanswers ?? false,
        answernumbering: options.answernumbering ?? 'abc',
        correctfeedback: this.docOrNull(options.correctfeedback),
        partiallycorrectfeedback: this.docOrNull(options.partiallycorrectfeedback),
        incorrectfeedback: this.docOrNull(options.incorrectfeedback),
        shownumcorrect: options.shownumcorrect ?? false,
        showstandardinstruction: options.showstandardinstruction ?? true,
      },
    };
  }

  /** Ghi answers + options của một version trong cùng giao dịch tạo version. */
  private async writeVersionContent(tx: DbTx, qtype: SupportedQtype, versionId: string, content: NormalisedContent): Promise<void> {
    const inserted: AnswerRow[] = [];
    for (const [index, a] of content.answers.entries()) {
      inserted.push(await this.repo.insertAnswer({
        questionversionid: versionId, answer: a.answer as never, fraction: a.fraction,
        feedback: a.feedback as never, sortorder: index,
      }, tx));
    }
    if (content.multichoice) {
      await this.repo.insertMultichoiceOptions({ questionversionid: versionId, ...content.multichoice } as never, tx);
    }
    if (content.truefalseCorrect !== undefined) {
      const trueRow = inserted[0]!;
      const falseRow = inserted[1]!;
      await this.repo.insertTruefalseOptions({
        questionversionid: versionId, trueanswer: trueRow.id, falseanswer: falseRow.id,
        showstandardinstruction: content.truefalseShowStandardInstruction ?? true,
      }, tx);
    }
    if (content.shortanswer) {
      await this.repo.insertShortanswerOptions({ questionversionid: versionId, usecase: content.shortanswer.usecase }, tx);
    }
    if (content.essay) {
      await this.repo.insertEssayOptions({ questionversionid: versionId, ...content.essay } as never, tx);
    }
  }

  /** Nhân bản answers + options của một version sang version khác (khi sửa câu hỏi mà không đổi phần đáp án). */
  private async cloneVersionContent(tx: DbTx, qtype: SupportedQtype, fromVersionId: string, toVersionId: string): Promise<void> {
    const answers = await this.repo.listAnswers(fromVersionId);
    const idMap = new Map<string, string>();
    for (const a of answers) {
      const row = await this.repo.insertAnswer({
        questionversionid: toVersionId, answer: a.answer as never, fraction: a.fraction,
        feedback: a.feedback as never, sortorder: a.sortorder,
      }, tx);
      idMap.set(a.id, row.id);
    }
    if (qtype === 'multichoice') {
      const o = await this.repo.getMultichoiceOptions(fromVersionId);
      if (o) await this.repo.insertMultichoiceOptions({
        questionversionid: toVersionId, single: o.single, shuffleanswers: o.shuffleanswers,
        answernumbering: o.answernumbering, correctfeedback: o.correctfeedback as never,
        partiallycorrectfeedback: o.partiallycorrectfeedback as never, incorrectfeedback: o.incorrectfeedback as never,
        shownumcorrect: o.shownumcorrect, showstandardinstruction: o.showstandardinstruction,
      }, tx);
    } else if (qtype === 'truefalse') {
      const o = await this.repo.getTruefalseOptions(fromVersionId);
      if (o) await this.repo.insertTruefalseOptions({
        questionversionid: toVersionId, trueanswer: idMap.get(o.trueanswer)!, falseanswer: idMap.get(o.falseanswer)!,
        showstandardinstruction: o.showstandardinstruction,
      }, tx);
    } else if (qtype === 'shortanswer') {
      const o = await this.repo.getShortanswerOptions(fromVersionId);
      if (o) await this.repo.insertShortanswerOptions({ questionversionid: toVersionId, usecase: o.usecase }, tx);
    } else if (qtype === 'essay') {
      const o = await this.repo.getEssayOptions(fromVersionId);
      if (o) await this.repo.insertEssayOptions({
        questionversionid: toVersionId, responseformat: o.responseformat, responserequired: o.responserequired,
        responsefieldlines: o.responsefieldlines, minwordlimit: o.minwordlimit, maxwordlimit: o.maxwordlimit,
        graderinfo: o.graderinfo as never, responsetemplate: o.responsetemplate as never,
      }, tx);
    }
  }

  /** Dựng options dạng bản ghi phẳng cho view/API từ bảng options của qtype. */
  private async optionsView(qtype: string, versionId: string): Promise<Record<string, unknown> | null> {
    if (qtype === 'multichoice') {
      const o = await this.repo.getMultichoiceOptions(versionId);
      if (!o) return null;
      return {
        single: o.single, shuffleanswers: o.shuffleanswers, answernumbering: o.answernumbering,
        correctfeedback: o.correctfeedback, partiallycorrectfeedback: o.partiallycorrectfeedback,
        incorrectfeedback: o.incorrectfeedback, shownumcorrect: o.shownumcorrect,
        showstandardinstruction: o.showstandardinstruction,
      };
    }
    if (qtype === 'truefalse') {
      const o = await this.repo.getTruefalseOptions(versionId);
      if (!o) return null;
      return { trueanswer: o.trueanswer, falseanswer: o.falseanswer, showstandardinstruction: o.showstandardinstruction };
    }
    if (qtype === 'shortanswer') {
      const o = await this.repo.getShortanswerOptions(versionId);
      if (!o) return null;
      return { usecase: o.usecase };
    }
    if (qtype === 'essay') {
      const o = await this.repo.getEssayOptions(versionId);
      if (!o) return null;
      return {
        responseformat: o.responseformat, responserequired: o.responserequired,
        responsefieldlines: o.responsefieldlines, minwordlimit: o.minwordlimit,
        maxwordlimit: o.maxwordlimit, graderinfo: o.graderinfo, responsetemplate: o.responsetemplate,
      };
    }
    return null;
  }

  /** Lắp view đầy đủ của một version: answers, options và stimulus đã gắn. */
  private async assembleView(question: QuestionRow, entry: EntryRow, version: VersionRow): Promise<QuestionView> {
    const answers = await this.repo.listAnswers(version.id);
    const options = await this.optionsView(question.qtype, version.id);
    const stimulus = version.stimulusid ? (await this.repo.getStimulus(version.stimulusid)) ?? null : null;
    return { question, entry, latestVersion: version, answers, options, stimulus };
  }

  /** Kiểm chứng stimulus được gắn: phải tồn tại và cùng category với câu hỏi (phạm vi chia sẻ). */
  private async resolveStimulus(stimulusId: string, categoryId: string): Promise<StimulusRow> {
    const stimulus = await this.getStimulus(stimulusId);
    if (stimulus.categoryid !== categoryId) {
      throw new BadRequestException({
        message: 'Stimulus belongs to a different question category; a stimulus is shared only within its own category',
        code: 'question.stimulus_category_mismatch',
      });
    }
    return stimulus;
  }

  /**
   * Tạo câu hỏi kèm version 1 và entry. Đáp án/options của payload được
   * bung ra question_answers + bảng options của qtype trong cùng giao dịch.
   */
  async createQuestion(actorId: string, input: {
    categoryId: string; qtype: string; name: string;
  } & QuestionContentInput): Promise<QuestionView> {
    const category = await this.getCategory(input.categoryId);
    await this.requireCap(actorId, 'moodle/question:add', category.contextid);
    this.assertSupportedQtype(input.qtype);
    const content = this.normaliseContent(input.qtype, input);
    const stimulus = input.stimulusId ? await this.resolveStimulus(input.stimulusId, category.id) : null;
    let created!: { q: QuestionRow; entry: EntryRow; version: VersionRow };
    await this.repo.dbHandle.transaction(async (tx) => {
      const q = await this.repo.insertQuestion({
        category: category.id, qtype: input.qtype, name: input.name, createdby: actorId, modifiedby: actorId,
      }, tx);
      const entry = await this.repo.insertEntry({ questioncategoryid: category.id, questionid: q.id, latestversion: 1 }, tx);
      const version = await this.repo.insertVersion({
        questionbankentryid: entry.id, questionid: q.id, version: 1,
        questiontext: toRichTextDocument(input.questiontext ?? '') as never,
        generalfeedback: this.docOrNull(input.generalfeedback) as never,
        guidance: this.docOrNull(input.guidance) as never,
        defaultmark: input.defaultmark ?? 1, penalty: input.penalty ?? 0,
        stimulusid: stimulus?.id ?? null,
      }, tx);
      await this.writeVersionContent(tx, input.qtype as SupportedQtype, version.id, content);
      created = { q, entry, version };
    });
    await this.outbox.enqueueStandalone({ aggregate: 'question', type: 'question_created', payload: { questionId: created.q.id, version: 1 } });
    return this.assembleView(created.q, created.entry, created.version);
  }

  /**
   * Lấy câu hỏi ở version mới nhất, kèm answers/options/stimulus.
   */
  async getQuestion(id: string): Promise<QuestionView> {
    const q = await this.repo.getQuestion(id);
    if (!q) throw new NotFoundException({ message: `Question ${id} not found`, code: 'question.not_found' });
    const entry = await this.repo.getEntryByQuestion(id);
    if (!entry) throw new NotFoundException({ message: `Question ${id} has no bank entry`, code: 'question.entry_missing' });
    const latest = await this.repo.getVersionByNumber(entry.id, entry.latestversion);
    if (!latest) throw new NotFoundException({ message: `Question ${id} latest version missing`, code: 'question.version_missing' });
    return this.assembleView(q, entry, latest);
  }
  /**
   * Câu hỏi trong category.
   */
  async listQuestions(categoryId: string): Promise<QuestionView[]> {
    const rows = await this.repo.listQuestionsInCategory(categoryId);
    const out: QuestionView[] = [];
    for (const q of rows) out.push(await this.getQuestion(q.id));
    return out;
  }
  /**
   * Lịch sử version của câu hỏi.
   */
  async listVersions(questionId: string): Promise<VersionRow[]> {
    const entry = await this.repo.getEntryByQuestion(questionId);
    if (!entry) throw new NotFoundException({ message: `Question ${questionId} has no bank entry`, code: 'question.entry_missing' });
    return this.repo.listVersions(entry.id);
  }
  /**
   * Nội dung một version cụ thể (answers + options) — dùng cho hiển thị và kiểm chứng theo version.
   */
  async getVersionContent(questionId: string, versionId: string): Promise<{ version: VersionRow; answers: AnswerRow[]; options: Record<string, unknown> | null }> {
    const q = await this.repo.getQuestion(questionId);
    if (!q) throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
    const version = await this.repo.getVersion(versionId);
    if (!version || version.questionid !== questionId) {
      throw new NotFoundException({ message: `Question version ${versionId} not found`, code: 'question.version_missing' });
    }
    const answers = await this.repo.listAnswers(version.id);
    const options = await this.optionsView(q.qtype, version.id);
    return { version, answers, options };
  }

  /** Editing creates a NEW version; existing versions (and attempts pinned to them) are untouched. */
  /**
   * Sửa câu hỏi = tạo version mới và nâng latestversion của entry. Phần
   * đáp án/options không được gửi lên thì nhân bản nguyên từ version trước
   * sang version mới; stimulusId = null gỡ gắn ngữ liệu, không gửi thì giữ.
   */
  async updateQuestion(actorId: string, questionId: string, input: {
    name?: string;
  } & QuestionContentInput): Promise<QuestionView> {
    const { question: q, entry, latestVersion } = await this.getQuestion(questionId);
    const category = await this.getCategory(q.category);
    await this.requireCap(actorId, 'moodle/question:editall', category.contextid);
    this.assertSupportedQtype(q.qtype);
    const hasNewContent = input.answers !== undefined || input.answer !== undefined || input.options !== undefined;
    const content = hasNewContent ? this.normaliseContent(q.qtype, input) : null;
    let stimulusId = latestVersion.stimulusid;
    if (input.stimulusId !== undefined) {
      stimulusId = input.stimulusId === null ? null : (await this.resolveStimulus(input.stimulusId, category.id)).id;
    }
    const nextVersion = entry.latestversion + 1;
    let version!: VersionRow;
    await this.repo.dbHandle.transaction(async (tx) => {
      version = await this.repo.insertVersion({
        questionbankentryid: entry.id, questionid: q.id, version: nextVersion,
        questiontext: (input.questiontext !== undefined ? toRichTextDocument(input.questiontext) : latestVersion.questiontext) as never,
        generalfeedback: (input.generalfeedback !== undefined ? toRichTextDocument(input.generalfeedback) : latestVersion.generalfeedback) as never,
        guidance: (input.guidance !== undefined ? toRichTextDocument(input.guidance) : latestVersion.guidance) as never,
        defaultmark: input.defaultmark ?? latestVersion.defaultmark,
        penalty: input.penalty ?? latestVersion.penalty,
        stimulusid: stimulusId,
      }, tx);
      if (content) await this.writeVersionContent(tx, q.qtype as SupportedQtype, version.id, content);
      else await this.cloneVersionContent(tx, q.qtype as SupportedQtype, latestVersion.id, version.id);
    });
    await this.repo.updateEntry(entry.id, { latestversion: nextVersion });
    await this.repo.updateQuestion(q.id, { name: input.name ?? q.name, modifiedby: actorId });
    await this.outbox.enqueueStandalone({ aggregate: 'question', type: 'question_updated', payload: { questionId: q.id, version: nextVersion } });
    return this.getQuestion(q.id);
  }

  // --- engine ------------------------------------------------------------------

  /**
   * Tạo usage mới cho một component (vd quiz) với behaviour cho trước.
   */
  async createUsage(actorId: string, input: {
    component: string; instanceid?: string; contextid?: string; preferredbehaviour?: string;
    slots: { questionId: string; maxmark?: number }[];
  }): Promise<UsageView> {
    const behaviour = input.preferredbehaviour ?? 'deferredfeedback';
    if (!BEHAVIOURS[behaviour]) {
      throw new BadRequestException({ message: `Unknown question behaviour ${behaviour}`, code: 'question.unknown_behaviour' });
    }
    if (!input.slots.length) throw new BadRequestException({ message: 'A usage needs at least one question slot', code: 'question.usage_empty' });
    const usage = await this.repo.insertUsage({
      component: input.component, instanceid: input.instanceid ?? null,
      owningcontextid: input.contextid ?? null, preferredbehaviour: behaviour, userid: actorId,
    });
    let slot = 1;
    for (const s of input.slots) {
      const view = await this.getQuestion(s.questionId);
      await this.repo.insertAttempt({
        questionusageid: usage.id, slot: slot++, behaviour,
        questionid: s.questionId, questionversionid: null,
        maxmark: s.maxmark ?? view.latestVersion.defaultmark,
        questionsummary: extractRichTextPlainText(view.latestVersion.questiontext as RichTextDocument), userid: actorId,
        state: 'notstarted',
      });
    }
    await this.outbox.enqueueStandalone({ aggregate: 'question', type: 'question_usage_created', payload: { usageId: usage.id, component: input.component, instanceid: input.instanceid ?? 0 } });
    return this.getUsage(usage.id);
  }

  /**
   * Lấy usage kèm các attempt và trạng thái tổng.
   */
  async getUsage(id: string): Promise<UsageView> {
    const usage = await this.repo.getUsage(id);
    if (!usage) throw new NotFoundException({ message: `Question usage ${id} not found`, code: 'question.usage_not_found' });
    const attempts = await this.repo.listAttempts(id);
    const views: AttemptView[] = [];
    for (const a of attempts) {
      const steps = await this.repo.listSteps(a.id);
      const stepViews = [];
      for (const s of steps) {
        const dataRows = await this.repo.listStepData(s.id);
        stepViews.push({
          id: s.id, sequencenumber: s.sequencenumber, state: s.state, fraction: s.fraction,
          data: Object.fromEntries(dataRows.map((d) => [d.name, d.value])),
        });
      }
      views.push({ ...a, steps: stepViews });
    }
    return { usage, state: usageState(attempts.map((a) => a.state)), attempts: views };
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
    await this.repo.dbHandle.transaction(async (tx) => {
      const step = await this.repo.insertStep({
        questionattemptid: attempt.id, sequencenumber: seq, state, fraction, userid: userId,
      }, tx as never);
      if (data) {
        for (const [name, value] of Object.entries(data)) {
          await this.repo.insertStepData({ attemptstepid: step.id, name, value }, tx as never);
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

  /** Dựng dữ liệu chấm của một version đã pin từ question_answers + options. */
  private async gradingDataFor(version: VersionRow, qtype: string): Promise<GradingData> {
    const answers = await this.repo.listAnswers(version.id);
    const data: GradingData = {
      answers: answers.map((a) => ({
        id: a.id,
        text: extractRichTextPlainText(a.answer as RichTextDocument),
        fraction: a.fraction,
      })),
    };
    if (qtype === 'multichoice') {
      const o = await this.repo.getMultichoiceOptions(version.id);
      data.multichoice = { single: o?.single ?? true };
    } else if (qtype === 'truefalse') {
      const o = await this.repo.getTruefalseOptions(version.id);
      if (o) data.truefalse = { trueanswerId: o.trueanswer, falseanswerId: o.falseanswer };
    } else if (qtype === 'shortanswer') {
      const o = await this.repo.getShortanswerOptions(version.id);
      data.shortanswer = { usecase: o?.usecase ?? false };
    }
    return data;
  }

  /** Start an attempt: PIN the bank entry's current latest version. */
  /**
   * Bắt đầu attempt cho một slot: pin version hiện tại của câu hỏi.
   */
  async startAttempt(userId: string, attemptId: string): Promise<AttemptView> {
    const attempt = await this.getAttempt(attemptId);
    await this.transition(attempt, 'todo');
    const { entry, latestVersion } = await this.getQuestion(attempt.questionid);
    void entry;
    await this.repo.updateAttempt(attempt.id, { state: 'todo', questionversionid: latestVersion.id, userid: userId });
    const updated = await this.getAttempt(attempt.id);
    await this.appendStep(updated, userId, 'todo', null);
    const usage = await this.getUsage(attempt.questionusageid);
    return usage.attempts.find((a) => a.id === attemptId)!;
  }

  /** Submit a response (deferredfeedback: stored as a step, NOT graded yet). */
  /**
   * Nộp câu trả lời: ghi step, chấm theo behaviour, cập nhật trạng thái/fraction.
   */
  async submitResponse(userId: string, attemptId: string, response: string | null): Promise<AttemptView> {
    const attempt = await this.getAttempt(attemptId);
    const behaviour = BEHAVIOURS[attempt.behaviour];
    if (!behaviour) throw new BadRequestException({ message: `Unknown behaviour ${attempt.behaviour}`, code: 'question.unknown_behaviour' });
    const to = behaviour.stateAfterSubmit(response);
    await this.transition(attempt, to);
    await this.repo.updateAttempt(attempt.id, { state: to, responsesummary: response ?? '', userid: userId });
    const updated = await this.getAttempt(attempt.id);
    await this.appendStep(updated, userId, to, null, { answer: response ?? '' });
    const usage = await this.getUsage(attempt.questionusageid);
    return usage.attempts.find((a) => a.id === attemptId)!;
  }

  /** Finish one attempt: grade against the PINNED version (never the latest). */
  /**
   * Kết thúc một attempt: chấm theo answers/options của version ĐÃ PIN
   * (essay về needsgrading với fraction null, chờ chấm tay).
   */
  async finishAttempt(userId: string, attemptId: string): Promise<AttemptView> {
    const attempt = await this.getAttempt(attemptId);
    if (attempt.state === 'notstarted') {
      throw new BadRequestException({ message: 'Cannot finish an attempt that was never started', code: 'question.not_started' });
    }
    if (['gradedright', 'gradedpartial', 'gradedwrong', 'gaveup', 'needsgrading'].includes(attempt.state)) {
      const usage = await this.getUsage(attempt.questionusageid);
      return usage.attempts.find((a) => a.id === attemptId)!;
    }
    const behaviour = BEHAVIOURS[attempt.behaviour];
    if (!behaviour) throw new BadRequestException({ message: `Unknown behaviour ${attempt.behaviour}`, code: 'question.unknown_behaviour' });
    if (!attempt.questionversionid) throw new BadRequestException({ message: 'Attempt has no pinned version', code: 'question.no_version' });
    const version = await this.repo.getVersion(attempt.questionversionid);
    if (!version) throw new NotFoundException({ message: 'Pinned question version missing', code: 'question.version_missing' });
    const q = await this.repo.getQuestion(attempt.questionid);
    const response = await this.latestResponse(attempt.id);
    const gradingData = await this.gradingDataFor(version, q?.qtype ?? '');
    const outcome = behaviour.gradeAtFinish(q?.qtype ?? '', gradingData, response);
    let state: QuestionState;
    let fraction: number | null;
    if (outcome === null) { state = 'gaveup'; fraction = 0; }
    else { state = outcome.state; fraction = outcome.fraction; }
    await this.transition(attempt, state);
    await this.repo.updateAttempt(attempt.id, {
      state, fraction, rightanswer: outcome?.rightAnswer ?? attempt.rightanswer, userid: userId,
    });
    const updated = await this.getAttempt(attempt.id);
    await this.appendStep(updated, userId, state, fraction);
    const usage = await this.getUsage(attempt.questionusageid);
    return usage.attempts.find((a) => a.id === attemptId)!;
  }

  /** Finish every attempt in a usage (deferredfeedback grading point) and emit the usage event. */
  /**
   * Kết thúc toàn bộ usage: mọi attempt về trạng thái finished.
   */
  async finishUsage(userId: string, usageId: string): Promise<UsageView> {
    const before = await this.getUsage(usageId);
    for (const a of before.attempts) {
      if (a.state !== 'notstarted') await this.finishAttempt(userId, a.id);
    }
    const after = await this.getUsage(usageId);
    await this.outbox.enqueueStandalone({
      aggregate: 'question', type: 'question_usage_finished',
      payload: { usageId, state: after.state, attempts: after.attempts.map((a) => ({ attemptId: a.id, state: a.state, fraction: a.fraction })) },
    });
    return after;
  }

  /** Start all attempts of a usage (questionusagebyactivity_test::start_all_questions). */
  /**
   * Bắt đầu usage (ủy quyền nội bộ).
   */
  async startUsage(userId: string, usageId: string): Promise<UsageView> {
    const view = await this.getUsage(usageId);
    for (const a of view.attempts) {
      if (a.state === 'notstarted') await this.startAttempt(userId, a.id);
    }
    return this.getUsage(usageId);
  }

  /** Ném lỗi 403 chuẩn hoá của module (hàm hỗ trợ nội bộ). */
  forbidden(msg: string): never { throw new ForbiddenException({ message: msg, code: 'question.forbidden' }); }
}
