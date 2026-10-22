import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { BEHAVIOURS, canTransition, usageState, type QuestionState } from './domain/question-engine';
import { QuestionsRepository, type AttemptRow, type EntryRow, type QCategoryRow, type QuestionRow, type UsageRow, type VersionRow } from './questions.repository';

export interface QuestionView {
  question: QuestionRow;
  entry: EntryRow;
  latestVersion: VersionRow;
}
export interface AttemptView extends AttemptRow {
  steps: { id: number; sequencenumber: number; state: string; fraction: number | null; data: Record<string, string | null> }[];
}
export interface UsageView {
  usage: UsageRow;
  state: string;
  attempts: AttemptView[];
}

const SUPPORTED_QTYPES = ['truefalse', 'shortanswer'];

/**
 * QuestionsModule facade (Moodle core_question): BANK + ENGINE.
 *
 * Bank invariants: editing a question NEVER mutates a version — it creates
 * the next version and moves the bank entry's latest pointer; usages created
 * later resolve the new version, attempts already started keep theirs.
 *
 * Engine invariants (questionusagebyactivity_test): a usage groups attempts
 * per (component, instanceid); starting an attempt PINS the current latest
 * version; every transition writes a step (with step_data for responses);
 * deferredfeedback grades at finish against the PINNED version's answer
 * data; the usage state is a rollup of its attempts.
 */
@Injectable()
export class QuestionsService {
  constructor(
    private readonly repo: QuestionsRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly outbox: OutboxService,
  ) {}

  private async requireCap(actorId: number, capability: string, contextId: number): Promise<void> {
    // Question contexts in this core are course/system contexts; the seeded
    // archetypes live at those levels and the evaluator walks the tree.
    await this.evaluator.requireCapability(actorId, capability, contextId);
  }
  private async contextOrSystem(contextId: number) {
    const ctx = await this.contexts.getContext(contextId).catch(() => undefined);
    return ctx ?? (await this.contexts.ensureSystemContext());
  }

  // --- bank ------------------------------------------------------------------

  async createCategory(actorId: number, input: { name: string; contextid: number; info?: string; parent?: number }): Promise<QCategoryRow> {
    const ctx = await this.contextOrSystem(input.contextid);
    await this.requireCap(actorId, 'moodle/question:managecategory', ctx.id);
    return this.repo.insertCategory({
      name: input.name, contextid: ctx.id, info: input.info ?? '', parent: input.parent ?? null,
      stamp: `qcat-${Date.now().toString(36)}`,
    });
  }
  async listCategories(contextId?: number): Promise<QCategoryRow[]> { return this.repo.listCategories(contextId); }
  async getCategory(id: number): Promise<QCategoryRow> {
    const row = await this.repo.getCategory(id);
    if (!row) throw new NotFoundException({ message: `Question category ${id} not found`, code: 'question.category_not_found' });
    return row;
  }

  private validateAnswer(qtype: string, answer: Record<string, unknown>): Record<string, unknown> {
    if (!SUPPORTED_QTYPES.includes(qtype)) {
      throw new BadRequestException({ message: `qtype ${qtype} is a plugin type; the core supports data-level truefalse/shortanswer`, code: 'question.qtype_not_supported' });
    }
    if (qtype === 'truefalse' && typeof answer.correct !== 'boolean') {
      throw new BadRequestException({ message: 'truefalse answer data requires {correct: boolean}', code: 'question.bad_answer_data' });
    }
    if (qtype === 'shortanswer' && (!Array.isArray(answer.answers) || answer.answers.length === 0)) {
      throw new BadRequestException({ message: 'shortanswer answer data requires {answers: string[]}', code: 'question.bad_answer_data' });
    }
    return answer;
  }

  async createQuestion(actorId: number, input: {
    categoryId: number; qtype: string; name: string; questiontext: string;
    defaultmark?: number; answer: Record<string, unknown>;
  }): Promise<QuestionView> {
    const category = await this.getCategory(input.categoryId);
    await this.requireCap(actorId, 'moodle/question:add', category.contextid);
    const answer = this.validateAnswer(input.qtype, input.answer);
    let view!: QuestionView;
    await this.repo.dbHandle.transaction(async (tx) => {
      void tx;
      const q = await this.repo.insertQuestion({
        category: category.id, qtype: input.qtype, name: input.name, createdby: actorId, modifiedby: actorId,
      });
      const entry = await this.repo.insertEntry({ questioncategoryid: category.id, questionid: q.id, latestversion: 1 });
      const version = await this.repo.insertVersion({
        questionbankentryid: entry.id, questionid: q.id, version: 1,
        questiontext: input.questiontext, defaultmark: input.defaultmark ?? 1, answerdata: answer as never,
      });
      view = { question: q, entry, latestVersion: version };
    });
    await this.outbox.enqueueStandalone({ aggregate: 'question', type: 'question_created', payload: { questionId: view.question.id, version: 1 } });
    return view;
  }

  async getQuestion(id: number): Promise<QuestionView> {
    const q = await this.repo.getQuestion(id);
    if (!q) throw new NotFoundException({ message: `Question ${id} not found`, code: 'question.not_found' });
    const entry = await this.repo.getEntryByQuestion(id);
    if (!entry) throw new NotFoundException({ message: `Question ${id} has no bank entry`, code: 'question.entry_missing' });
    const latest = await this.repo.getVersionByNumber(entry.id, entry.latestversion);
    if (!latest) throw new NotFoundException({ message: `Question ${id} latest version missing`, code: 'question.version_missing' });
    return { question: q, entry, latestVersion: latest };
  }
  async listQuestions(categoryId: number): Promise<QuestionView[]> {
    const rows = await this.repo.listQuestionsInCategory(categoryId);
    const out: QuestionView[] = [];
    for (const q of rows) out.push(await this.getQuestion(q.id));
    return out;
  }
  async listVersions(questionId: number): Promise<VersionRow[]> {
    const entry = await this.repo.getEntryByQuestion(questionId);
    if (!entry) throw new NotFoundException({ message: `Question ${questionId} has no bank entry`, code: 'question.entry_missing' });
    return this.repo.listVersions(entry.id);
  }

  /** Editing creates a NEW version; existing versions (and attempts pinned to them) are untouched. */
  async updateQuestion(actorId: number, questionId: number, input: {
    name?: string; questiontext?: string; defaultmark?: number; answer?: Record<string, unknown>;
  }): Promise<QuestionView> {
    const { question: q, entry, latestVersion } = await this.getQuestion(questionId);
    const category = await this.getCategory(q.category);
    await this.requireCap(actorId, 'moodle/question:editall', category.contextid);
    const answer = input.answer !== undefined ? this.validateAnswer(q.qtype, input.answer) : (latestVersion.answerdata as Record<string, unknown>);
    const nextVersion = entry.latestversion + 1;
    const version = await this.repo.insertVersion({
      questionbankentryid: entry.id, questionid: q.id, version: nextVersion,
      questiontext: input.questiontext ?? latestVersion.questiontext,
      defaultmark: input.defaultmark ?? latestVersion.defaultmark,
      answerdata: answer as never,
    });
    await this.repo.updateEntry(entry.id, { latestversion: nextVersion });
    await this.repo.updateQuestion(q.id, { name: input.name ?? q.name, modifiedby: actorId });
    await this.outbox.enqueueStandalone({ aggregate: 'question', type: 'question_updated', payload: { questionId: q.id, version: nextVersion } });
    return { question: (await this.repo.getQuestion(q.id))!, entry: (await this.repo.getEntryByQuestion(q.id))!, latestVersion: version };
  }

  // --- engine ------------------------------------------------------------------

  async createUsage(actorId: number, input: {
    component: string; instanceid?: number; contextid?: number; preferredbehaviour?: string;
    slots: { questionId: number; maxmark?: number }[];
  }): Promise<UsageView> {
    const behaviour = input.preferredbehaviour ?? 'deferredfeedback';
    if (!BEHAVIOURS[behaviour]) {
      throw new BadRequestException({ message: `Unknown question behaviour ${behaviour}`, code: 'question.unknown_behaviour' });
    }
    if (!input.slots.length) throw new BadRequestException({ message: 'A usage needs at least one question slot', code: 'question.usage_empty' });
    const usage = await this.repo.insertUsage({
      component: input.component, instanceid: input.instanceid ?? 0,
      owningcontextid: input.contextid ?? null, preferredbehaviour: behaviour, userid: actorId,
    });
    let slot = 1;
    for (const s of input.slots) {
      const view = await this.getQuestion(s.questionId);
      await this.repo.insertAttempt({
        questionusageid: usage.id, slot: slot++, behaviour,
        questionid: s.questionId, questionversionid: null,
        maxmark: s.maxmark ?? view.latestVersion.defaultmark,
        questionsummary: view.latestVersion.questiontext, userid: actorId,
        state: 'notstarted',
      });
    }
    await this.outbox.enqueueStandalone({ aggregate: 'question', type: 'question_usage_created', payload: { usageId: usage.id, component: input.component, instanceid: input.instanceid ?? 0 } });
    return this.getUsage(usage.id);
  }

  async getUsage(id: number): Promise<UsageView> {
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
  async getAttempt(id: number): Promise<AttemptRow> {
    const row = await this.repo.getAttempt(id);
    if (!row) throw new NotFoundException({ message: `Question attempt ${id} not found`, code: 'question.attempt_not_found' });
    return row;
  }

  private async appendStep(attempt: AttemptRow, userId: number, state: QuestionState, fraction: number | null, data?: Record<string, string>): Promise<void> {
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
  private async latestResponse(attemptId: number): Promise<string | null> {
    const steps = await this.repo.listSteps(attemptId);
    let response: string | null = null;
    for (const s of steps) {
      const data = await this.repo.listStepData(s.id);
      const answer = data.find((d) => d.name === 'answer');
      if (answer) response = answer.value;
    }
    return response;
  }

  /** Start an attempt: PIN the bank entry's current latest version. */
  async startAttempt(userId: number, attemptId: number): Promise<AttemptView> {
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
  async submitResponse(userId: number, attemptId: number, response: string | null): Promise<AttemptView> {
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
  async finishAttempt(userId: number, attemptId: number): Promise<AttemptView> {
    const attempt = await this.getAttempt(attemptId);
    if (attempt.state === 'notstarted') {
      throw new BadRequestException({ message: 'Cannot finish an attempt that was never started', code: 'question.not_started' });
    }
    if (['gradedright', 'gradedpartial', 'gradedwrong', 'gaveup'].includes(attempt.state)) {
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
    const outcome = behaviour.gradeAtFinish(q?.qtype ?? '', version.answerdata as Record<string, unknown>, response);
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
  async finishUsage(userId: number, usageId: number): Promise<UsageView> {
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
  async startUsage(userId: number, usageId: number): Promise<UsageView> {
    const view = await this.getUsage(usageId);
    for (const a of view.attempts) {
      if (a.state === 'notstarted') await this.startAttempt(userId, a.id);
    }
    return this.getUsage(usageId);
  }

  forbidden(msg: string): never { throw new ForbiddenException({ message: msg, code: 'question.forbidden' }); }
}
