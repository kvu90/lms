import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { QuizAttemptSummary, QuizView, RichTextDocument } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { GradesService } from '../grades/grades.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import { QuestionsService, type UsageView } from '../questions/questions.service';
import { UsersService } from '../users/users.service';
import { QuizRepository, type QuizAttemptRow, type QuizRow, type QuizSlotRow } from './quiz.repository';

export const QUIZ_COMPONENT = 'mod_quiz';
export const QUIZ_CAPABILITIES = {
  view: 'quiz:view',
  attempt: 'quiz:attempt',
  manage: 'quiz:manage',
  grade: 'quiz:grade',
  viewReports: 'quiz:viewreports',
  preview: 'quiz:preview',
} as const;

/** Một câu trong lượt làm như client nhận: nội dung của version ĐÃ PIN, không lộ fraction đáp án khi đang làm. */
export interface QuizAttemptQuestionView {
  slot: number;
  page: number;
  questionAttemptId: string;
  questionId: string;
  qtype: string;
  name: string;
  questionText: RichTextDocument;
  stimulus: { id: string; content: RichTextDocument } | null;
  answers: { id: string; text: RichTextDocument }[];
  options: Record<string, unknown> | null;
  maxMark: number;
  state: string;
  response: string | null;
  fraction: number | null;
  mark: number | null;
  rightAnswer: string | null;
}

/** View đầy đủ của một lượt làm quiz: tóm tắt lượt + đề + từng câu (đã nhóm sẵn theo trang qua trường page). */
export interface QuizAttemptView {
  attempt: QuizAttemptSummary;
  quiz: QuizView;
  questions: QuizAttemptQuestionView[];
  totalMax: number;
  pendingManualCount: number;
  closedDueToTimeLimit: boolean;
}

/** Một học sinh làm chưa trọn vẹn một câu trong thống kê câu sai của giáo viên. */
export interface QuizQuestionWrongStudent {
  userId: string;
  /** Tên hiển thị: "firstName lastName", trống cả hai thì lùi về username (cùng quy ước với messaging). */
  displayName: string;
  quizAttemptId: string;
  attemptNumber: number;
  /** Hệ số điểm của câu trong lượt đó (0 ≤ fraction < 1). */
  fraction: number;
  /** Điểm câu đạt được = fraction × maxMark. */
  mark: number;
}

/**
 * Thống kê một vị trí câu (slot) trong kết quả quiz cho giáo viên: bao
 * nhiêu học sinh làm chưa trọn vẹn câu này và đó là những ai. Đơn vị
 * gộp là SLOT (vị trí trong đề) — với slot cố định questionId/questionName
 * là của câu đã ghim; với slot ngẫu nhiên mỗi lượt rút một câu khác nhau
 * nên hai trường đó là null và thống kê hiểu theo vị trí. "Sai" nghĩa là
 * ĐÃ CHẤM mà fraction < 1 (sai hẳn hoặc đúng một phần); câu đang chờ
 * chấm tay chỉ đếm vào pendingCount, chưa kết luận sai/đúng. Chỉ tính
 * các lượt ĐÃ NỘP (finished/needsgrading), bỏ lượt preview của giáo viên.
 */
export interface QuizQuestionStat {
  slot: number;
  questionId: string | null;
  questionName: string | null;
  maxMark: number;
  /** Số lượt đã nộp có chứa slot này. */
  attemptsCount: number;
  /** Số câu đã có fraction (đã chấm xong). */
  gradedCount: number;
  /** Số câu đang chờ chấm tay ở slot này. */
  pendingCount: number;
  /** Số câu đã chấm mà fraction < 1. */
  wrongCount: number;
  /** Số câu đã chấm mà fraction = 0. */
  fullyWrongCount: number;
  wrongStudents: QuizQuestionWrongStudent[];
}

/** Một câu đang chờ chấm tay trong hàng đợi của giáo viên. */
export interface QuizNeedsGradingView {
  quizAttemptId: string;
  userId: string;
  attemptNumber: number;
  questionAttemptId: string;
  slot: number;
  questionId: string;
  maxMark: number;
  response: string | null;
}

/**
 * Hoạt động Quiz (Moodle mod_quiz) dựng trên question engine sẵn có.
 *
 * Nguyên tắc điểm (đúng Moodle): câu hỏi đứng độc lập trong ngân hàng —
 * `question_versions.default_mark` chỉ là gợi ý khi thêm slot; điểm thật
 * nằm ở `quiz_slots.max_mark` của từng đề. Bắt đầu lượt làm: engine tạo
 * question attempt với maxMark lấy từ slot; điểm câu = fraction × maxMark;
 * điểm lượt = tổng điểm các câu đã chấm; điểm BÀI = điểm lượt quy về thang
 * `quizzes.grade`, chọn theo grade_method khi có nhiều lượt, ghi vào sổ
 * điểm qua grade item 'mod' của course module (GradesService).
 *
 * Trạng thái lượt: inprogress → (nộp bài) → finished, hoặc needsgrading
 * khi còn essay chờ chấm tay; chấm tay xong câu cuối cùng thì lượt về
 * finished và điểm bài được ghi lại.
 */
@Injectable()
export class QuizService {
  private readonly logger = new Logger(QuizService.name);

  constructor(
    private readonly repo: QuizRepository,
    private readonly courses: CoursesService,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly questions: QuestionsService,
    private readonly banks: QuestionBanksService,
    private readonly grades: GradesService,
    private readonly users: UsersService,
    private readonly outbox: OutboxService,
  ) {}

  // --- helpers ---------------------------------------------------------------

  /**
   * Lấy quiz; ném quiz.not_found khi vắng.
   */
  async getQuiz(id: string): Promise<QuizRow> {
    const row = await this.repo.getQuiz(id);
    if (!row) throw new NotFoundException({ message: `Quiz ${id} not found`, code: 'quiz.not_found' });
    return row;
  }
  private async getAttemptRow(id: string): Promise<QuizAttemptRow> {
    const row = await this.repo.getAttempt(id);
    if (!row) throw new NotFoundException({ message: `Quiz attempt ${id} not found`, code: 'quiz.attempt_not_found' });
    return row;
  }
  /** Context của course module chứa quiz — mọi capability quiz:* kiểm tại đây. */
  private async cmContextId(quiz: QuizRow): Promise<string> {
    if (quiz.cmId) {
      const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.MODULE, quiz.cmId);
      if (ctx) return ctx.id;
    }
    const courseCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, quiz.course);
    if (!courseCtx) throw new NotFoundException({ message: `No context for quiz ${quiz.id}`, code: 'quiz.context_missing' });
    return courseCtx.id;
  }
  private async requireCap(actorId: string, quiz: QuizRow, capability: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, capability, await this.cmContextId(quiz));
  }
  private async hasCap(actorId: string, quiz: QuizRow, capability: string): Promise<boolean> {
    return this.evaluator.hasCapability(actorId, capability, await this.cmContextId(quiz));
  }

  /**
   * View của quiz kèm slots và tổng điểm slot. Slot cố định mang thêm
   * thông tin bank nguồn + kỷ luật version (QB-3): chế độ ghim, version
   * đang ghim, version ready mới nhất và cờ có bản mới để UI hiển thị
   * "Câu thuộc Ngân hàng [tên] · đang ghim v[n] · đã có v[m]".
   */
  async quizView(quiz: QuizRow): Promise<QuizView> {
    const slots = await this.repo.listSlots(quiz.id);
    const slotViews: QuizView['slots'] = [];
    for (const s of slots) {
      const base = {
        id: s.id, quizId: s.quizId, slot: s.slot, page: s.page,
        questionId: s.questionId, categoryId: s.categoryId, maxMark: s.maxMark,
        versionMode: null as 'pinned' | 'follow_latest' | null,
        pinnedVersion: null as number | null,
        latestVersion: null as number | null,
        hasNewerVersion: false,
        bankId: null as string | null,
        bankName: null as string | null,
        bankScope: null as string | null,
        questionStatus: null as string | null,
      };
      if (s.questionId) {
        const info = await this.banks.getQuestionBankInfo(s.questionId);
        base.versionMode = s.versionMode === 'pinned' ? 'pinned' : 'follow_latest';
        base.pinnedVersion = s.versionMode === 'pinned' ? s.pinnedVersionNumber : null;
        base.latestVersion = info?.latestReadyVersionNumber ?? info?.latestVersion ?? null;
        base.hasNewerVersion = s.versionMode === 'pinned'
          && s.pinnedVersionNumber !== null
          && base.latestVersion !== null
          && base.latestVersion > s.pinnedVersionNumber;
        base.bankId = info?.bank?.id ?? null;
        base.bankName = info?.bank?.name ?? null;
        base.bankScope = info?.bank?.scope ?? null;
        base.questionStatus = info?.entryStatus ?? null;
      }
      slotViews.push(base);
    }
    return {
      id: quiz.id,
      courseId: quiz.course,
      cmId: quiz.cmId,
      name: quiz.name,
      intro: quiz.intro,
      timeOpen: quiz.timeOpen?.toISOString() ?? null,
      timeClose: quiz.timeClose?.toISOString() ?? null,
      timeLimitSeconds: quiz.timeLimit,
      attemptsAllowed: quiz.attemptsAllowed,
      gradeMethod: (['highest', 'average', 'first', 'last'].includes(quiz.gradeMethod) ? quiz.gradeMethod : 'highest') as QuizView['gradeMethod'],
      grade: quiz.grade,
      shuffleAnswers: quiz.shuffleAnswers,
      slots: slotViews,
      sumGrades: slots.reduce((sum, s) => sum + s.maxMark, 0),
    };
  }

  /** Tổng maxMark của một usage (mẫu số điểm lượt — lấy từ question attempt đã pin, không phải slot hiện tại). */
  private usageTotalMax(usage: UsageView): number {
    return usage.attempts.reduce((sum, a) => sum + a.maxMark, 0);
  }
  /** Điểm một lượt đã quy về thang điểm của quiz (null khi chưa chốt hoặc đề rỗng). */
  private attemptGradeValue(quiz: QuizRow, row: QuizAttemptRow, totalMax: number): number | null {
    if (row.sumGrades === null || totalMax <= 0) return null;
    return (row.sumGrades / totalMax) * quiz.grade;
  }
  private async attemptSummary(quiz: QuizRow, row: QuizAttemptRow): Promise<QuizAttemptSummary> {
    let grade: number | null = null;
    if (row.sumGrades !== null) {
      const usage = await this.questions.getUsage(row.usageId);
      grade = this.attemptGradeValue(quiz, row, this.usageTotalMax(usage));
    }
    return {
      id: row.id, quizId: row.quizId, userId: row.userId, attemptNumber: row.attemptNumber,
      usageId: row.usageId, state: row.state, preview: row.preview,
      timeStart: row.timeStart.toISOString(), timeFinish: row.timeFinish?.toISOString() ?? null,
      sumGrades: row.sumGrades, grade,
    };
  }

  /**
   * Đồng bộ tổng điểm của một lượt từ usage của engine: tổng các câu ĐÃ có
   * fraction (essay chưa chấm đóng góp 0) + số câu còn chờ chấm tay.
   */
  private syncFromUsage(usage: UsageView): { sumGrades: number; pendingManual: number } {
    let sum = 0;
    let pending = 0;
    for (const a of usage.attempts) {
      if (a.state === 'needsgrading') pending += 1;
      else if (a.fraction !== null && a.fraction !== undefined) sum += a.fraction * a.maxMark;
    }
    return { sumGrades: sum, pendingManual: pending };
  }

  // --- CRUD quiz ---------------------------------------------------------------

  /**
   * Tạo quiz: bản ghi quiz + course module (component mod_quiz, completion
   * tự động theo điểm) + grade item 'mod' mang thang điểm của bài. Quyền
   * tạo hoạt động do CoursesService kiểm (course:manageactivities);
   * các thao tác về sau kiểm quiz:manage tại context của module.
   */
  async createQuiz(actorId: string, courseId: string, input: {
    sectionId: string; name: string; intro?: string;
    timeOpen?: string | null; timeClose?: string | null; timeLimitSeconds?: number | null;
    attemptsAllowed?: number; gradeMethod?: string; grade?: number; shuffleAnswers?: boolean;
  }): Promise<QuizView> {
    await this.courses.getCourse(courseId);
    const timeOpen = input.timeOpen ? new Date(input.timeOpen) : null;
    const timeClose = input.timeClose ? new Date(input.timeClose) : null;
    if (timeOpen && timeClose && timeClose <= timeOpen) {
      throw new BadRequestException({ message: 'timeClose must be after timeOpen', code: 'quiz.bad_window' });
    }
    const quiz = await this.repo.insertQuiz({
      course: courseId, cmId: null, name: input.name, intro: input.intro ?? '',
      timeOpen, timeClose, timeLimit: input.timeLimitSeconds ?? null,
      attemptsAllowed: input.attemptsAllowed ?? 0,
      gradeMethod: input.gradeMethod ?? 'highest',
      grade: input.grade ?? 10,
      shuffleAnswers: input.shuffleAnswers ?? false,
    });
    try {
      const cm = await this.courses.createCm(actorId, courseId, {
        sectionId: input.sectionId, component: QUIZ_COMPONENT, instanceId: quiz.id, name: input.name,
        completion: 2, completionUseGrade: true,
      });
      await this.repo.updateQuiz(quiz.id, { cmId: cm.id });
      await this.grades.createItem(actorId, courseId, {
        itemName: input.name, itemType: 'mod', cmId: cm.id, gradeMax: quiz.grade,
      });
    } catch (err) {
      // Dọn dẹp best-effort để không để lại quiz mồ côi không có cm.
      await this.repo.deleteQuiz(quiz.id).catch(() => undefined);
      throw err;
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_created', payload: { quizId: quiz.id, courseId, actorId } });
    return this.quizView(await this.getQuiz(quiz.id));
  }

  /**
   * Sửa cài đặt quiz (quiz:manage); tên và thang điểm được đồng bộ
   * sang course module và grade item của hoạt động.
   */
  async updateQuiz(actorId: string, quizId: string, input: {
    name?: string; intro?: string;
    timeOpen?: string | null; timeClose?: string | null; timeLimitSeconds?: number | null;
    attemptsAllowed?: number; gradeMethod?: string; grade?: number; shuffleAnswers?: boolean;
  }): Promise<QuizView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    const patch: Partial<QuizRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.intro !== undefined) patch.intro = input.intro;
    if (input.timeOpen !== undefined) patch.timeOpen = input.timeOpen ? new Date(input.timeOpen) : null;
    if (input.timeClose !== undefined) patch.timeClose = input.timeClose ? new Date(input.timeClose) : null;
    if (input.timeLimitSeconds !== undefined) patch.timeLimit = input.timeLimitSeconds;
    if (input.attemptsAllowed !== undefined) patch.attemptsAllowed = input.attemptsAllowed;
    if (input.gradeMethod !== undefined) patch.gradeMethod = input.gradeMethod;
    if (input.grade !== undefined) patch.grade = input.grade;
    if (input.shuffleAnswers !== undefined) patch.shuffleAnswers = input.shuffleAnswers;
    const nextOpen = patch.timeOpen !== undefined ? patch.timeOpen : quiz.timeOpen;
    const nextClose = patch.timeClose !== undefined ? patch.timeClose : quiz.timeClose;
    if (nextOpen && nextClose && nextClose <= nextOpen) {
      throw new BadRequestException({ message: 'timeClose must be after timeOpen', code: 'quiz.bad_window' });
    }
    if (Object.keys(patch).length) await this.repo.updateQuiz(quiz.id, patch);
    const updated = await this.getQuiz(quiz.id);
    if (updated.cmId && input.name !== undefined) {
      await this.courses.updateCm(actorId, updated.cmId, { name: input.name });
    }
    if (updated.cmId && (input.grade !== undefined || input.name !== undefined)) {
      const item = await this.grades.getItemForCm(updated.course, updated.cmId);
      if (item) {
        await this.grades.updateItem(actorId, item.id, {
          ...(input.grade !== undefined ? { gradeMax: input.grade } : {}),
          ...(input.name !== undefined ? { itemName: input.name } : {}),
        });
      }
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_updated', payload: { quizId: quiz.id, courseId: quiz.course, actorId } });
    return this.quizView(updated);
  }

  /**
   * Xoá quiz cùng slots, attempts, usages của engine, course module và
   * grade item của hoạt động (quiz:manage).
   */
  async deleteQuiz(actorId: string, quizId: string): Promise<void> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    const attempts = await this.repo.listAttempts(quiz.id);
    for (const a of attempts) await this.questions.deleteUsage(a.usageId);
    if (quiz.cmId) {
      const item = await this.grades.getItemForCm(quiz.course, quiz.cmId).catch(() => undefined);
      if (item) await this.grades.deleteItem(actorId, item.id).catch(() => undefined);
    }
    await this.repo.deleteQuiz(quiz.id);
    if (quiz.cmId) await this.courses.deleteCm(actorId, quiz.cmId);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_deleted', payload: { quizId: quiz.id, courseId: quiz.course, actorId } });
  }

  /**
   * Các quiz trong khoá học (cho trang khoá học/danh sách hoạt động).
   */
  async listQuizzes(courseId: string): Promise<QuizView[]> {
    const rows = await this.repo.listQuizzesInCourse(courseId);
    const out: QuizView[] = [];
    for (const r of rows) out.push(await this.quizView(r));
    return out;
  }

  // --- slots -------------------------------------------------------------------

  /**
   * Thêm slot vào cuối đề (quiz:manage): câu cố định (maxMark mặc
   * định lấy từ default_mark hiện tại của câu) hoặc slot ngẫu nhiên theo
   * category (maxMark phải được cho hoặc mặc định 1).
   *
   * Kỷ luật version (QB-3): câu từ bank tổ/trường MẶC ĐỊNH ghim cứng
   * (pinned) vào version hiện tại; `follow_latest` phải được chọn tường
   * minh. Câu đã rút (hidden) không thêm mới vào đề được.
   */
  async addSlot(actorId: string, quizId: string, input: { questionId?: string; categoryId?: string; maxMark?: number; page?: number; versionMode?: string }): Promise<QuizView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    if (!!input.questionId === !!input.categoryId) {
      throw new BadRequestException({ message: 'A slot needs exactly one of questionId (fixed) or categoryId (random)', code: 'quiz.slot_bad_source' });
    }
    if (input.versionMode !== undefined && input.versionMode !== 'pinned' && input.versionMode !== 'follow_latest') {
      throw new BadRequestException({ message: `Unknown slot version mode ${input.versionMode}`, code: 'quiz.slot_bad_version_mode' });
    }
    const slots = await this.repo.listSlots(quiz.id);
    let maxMark = input.maxMark;
    let versionMode = 'follow_latest';
    let pinnedVersionId: string | null = null;
    let pinnedVersionNumber: number | null = null;
    if (input.questionId) {
      const view = await this.questions.getQuestion(input.questionId);
      maxMark = maxMark ?? view.latestVersion.defaultMark;
      const info = await this.banks.getQuestionBankInfo(input.questionId);
      if (info?.entryStatus === 'hidden') {
        throw new BadRequestException({ message: 'Question has been withdrawn from its bank and cannot be added to a quiz', code: 'quiz.slot_question_withdrawn' });
      }
      // Mặc định pinned chỉ khi câu thật sự nằm trong bank tổ/trường
      // (category gắn bank tường minh); category cũ suy bank theo
      // context giữ hành vi follow_latest như trước feat.
      const sharedBank = info?.bankExplicit && info.bank && (info.bank.scope === 'team' || info.bank.scope === 'school');
      versionMode = input.versionMode ?? (sharedBank ? 'pinned' : 'follow_latest');
      if (versionMode === 'pinned') {
        pinnedVersionId = info?.latestReadyVersionId ?? info?.latestVersionId ?? view.latestVersion.id;
        pinnedVersionNumber = info?.latestReadyVersionNumber ?? info?.latestVersion ?? view.latestVersion.version;
      }
    } else {
      await this.questions.getCategory(input.categoryId!);
      maxMark = maxMark ?? 1;
    }
    const nextSlot = slots.length ? Math.max(...slots.map((s) => s.slot)) + 1 : 1;
    const lastPage = slots.length ? slots[slots.length - 1]!.page : 1;
    await this.repo.insertSlot({
      quizId: quiz.id, slot: nextSlot, page: input.page ?? lastPage,
      questionId: input.questionId ?? null, categoryId: input.categoryId ?? null, maxMark,
      versionMode, pinnedVersionId, pinnedVersionNumber,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_slot_added', payload: { quizId: quiz.id, courseId: quiz.course, actorId } });
    return this.quizView(quiz);
  }

  /**
   * Sửa một slot (quiz:manage): điểm, trang hoặc vị trí trong đề —
   * đổi vị trí là hoán đổi số slot với slot đang giữ số đó (giữ bất biến
   * duy nhất của cặp quiz+slot).
   */
  async updateSlot(actorId: string, quizId: string, slotId: string, input: { maxMark?: number; page?: number; slot?: number; versionMode?: string }): Promise<QuizView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    const slot = await this.repo.getSlot(slotId);
    if (!slot || slot.quizId !== quiz.id) throw new NotFoundException({ message: `Quiz slot ${slotId} not found`, code: 'quiz.slot_not_found' });
    const patch: Partial<QuizSlotRow> = {};
    if (input.maxMark !== undefined) patch.maxMark = input.maxMark;
    if (input.page !== undefined) patch.page = input.page;
    if (input.versionMode !== undefined) {
      // Đổi chế độ version (QB-3): chuyển sang pinned thì ghim vào
      // version ready hiện tại; chuyển về follow_latest thì bỏ ghim.
      if (input.versionMode !== 'pinned' && input.versionMode !== 'follow_latest') {
        throw new BadRequestException({ message: `Unknown slot version mode ${input.versionMode}`, code: 'quiz.slot_bad_version_mode' });
      }
      if (!slot.questionId) {
        throw new BadRequestException({ message: 'Random slots do not carry a version mode', code: 'quiz.slot_random_no_version_mode' });
      }
      patch.versionMode = input.versionMode;
      if (input.versionMode === 'pinned') {
        const info = await this.banks.getQuestionBankInfo(slot.questionId);
        patch.pinnedVersionId = info?.latestReadyVersionId ?? info?.latestVersionId ?? null;
        patch.pinnedVersionNumber = info?.latestReadyVersionNumber ?? info?.latestVersion ?? null;
      } else {
        patch.pinnedVersionId = null;
        patch.pinnedVersionNumber = null;
      }
    }
    if (input.slot !== undefined && input.slot !== slot.slot) {
      const slots = await this.repo.listSlots(quiz.id);
      const other = slots.find((s) => s.slot === input.slot);
      // Hoán đổi qua số âm tạm thời (số slot luôn dương) để không đụng
      // ràng buộc duy nhất của cặp (quiz, slot) giữa hai lần cập nhật.
      await this.repo.updateSlot(slot.id, { slot: -slot.slot });
      if (other) await this.repo.updateSlot(other.id, { slot: slot.slot });
      patch.slot = input.slot;
    }
    if (Object.keys(patch).length) await this.repo.updateSlot(slot.id, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_slot_updated', payload: { quizId: quiz.id, slotId, courseId: quiz.course, actorId } });
    return this.quizView(quiz);
  }

  /**
   * Nâng version đã ghim của một slot lên version ready mới nhất (QB-3):
   * chỉ áp dụng cho slot pinned; ghi nhật ký quiz_slot_version_events +
   * sự kiện outbox (ai nâng, từ version nào lên version nào, khi nào).
   * Lượt làm đã bắt đầu không bị ảnh hưởng — chúng giữ version đã pin
   * trong engine.
   */
  async upgradeSlotVersion(actorId: string, quizId: string, slotId: string): Promise<QuizView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    const slot = await this.repo.getSlot(slotId);
    if (!slot || slot.quizId !== quiz.id) throw new NotFoundException({ message: `Quiz slot ${slotId} not found`, code: 'quiz.slot_not_found' });
    if (!slot.questionId || slot.versionMode !== 'pinned') {
      throw new BadRequestException({ message: 'Only a pinned fixed slot can be upgraded', code: 'quiz.slot_not_pinned' });
    }
    const info = await this.banks.getQuestionBankInfo(slot.questionId);
    const targetId = info?.latestReadyVersionId ?? null;
    const targetNumber = info?.latestReadyVersionNumber ?? null;
    if (!info || targetId === null || targetNumber === null || (slot.pinnedVersionNumber !== null && targetNumber <= slot.pinnedVersionNumber)) {
      throw new BadRequestException({ message: 'The slot already pins the latest ready version', code: 'quiz.slot_no_newer_version' });
    }
    await this.repo.updateSlot(slot.id, { pinnedVersionId: targetId, pinnedVersionNumber: targetNumber });
    await this.repo.insertSlotVersionEvent({
      quizId: quiz.id, slotId: slot.id, questionId: slot.questionId,
      fromVersion: slot.pinnedVersionNumber, toVersion: targetNumber, actorId,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'quiz_slot_version_upgraded',
      payload: { quizId: quiz.id, slotId: slot.id, questionId: slot.questionId, fromVersion: slot.pinnedVersionNumber, toVersion: targetNumber, actorId },
    });
    return this.quizView(quiz);
  }

  /**
   * Xoá một slot khỏi đề (quiz:manage); các slot sau nó được đánh số
   * lại liên tục. Lượt làm đã bắt đầu không bị ảnh hưởng (attempt của
   * engine đã pin câu và maxMark tại thời điểm bắt đầu).
   */
  async removeSlot(actorId: string, quizId: string, slotId: string): Promise<QuizView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    const slot = await this.repo.getSlot(slotId);
    if (!slot || slot.quizId !== quiz.id) throw new NotFoundException({ message: `Quiz slot ${slotId} not found`, code: 'quiz.slot_not_found' });
    await this.repo.deleteSlot(slot.id);
    const rest = await this.repo.listSlots(quiz.id);
    let n = 1;
    for (const s of rest) {
      if (s.slot !== n) await this.repo.updateSlot(s.id, { slot: n });
      n += 1;
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_slot_removed', payload: { quizId: quiz.id, slotId, courseId: quiz.course, actorId } });
    return this.quizView(quiz);
  }

  // --- thông tin cho người xem ---------------------------------------------------

  /**
   * Mở cổng xem quiz: người xem cần một trong các capability của hoạt
   * động tại context của module (học sinh: view/attempt; giáo viên:
   * manage/grade/viewreports/preview).
   */
  private async requireAnyViewCap(actorId: string, quiz: QuizRow): Promise<void> {
    const ctx = await this.cmContextId(quiz);
    for (const cap of [QUIZ_CAPABILITIES.view, QUIZ_CAPABILITIES.attempt, QUIZ_CAPABILITIES.manage, QUIZ_CAPABILITIES.grade, QUIZ_CAPABILITIES.viewReports, QUIZ_CAPABILITIES.preview]) {
      if (await this.evaluator.hasCapability(actorId, cap, ctx)) return;
    }
    await this.evaluator.requireCapability(actorId, QUIZ_CAPABILITIES.view, ctx);
  }

  /** Học sinh còn được bắt đầu lượt mới hay không, và vì sao không. */
  private async attemptEligibility(quiz: QuizRow, userId: string, now: Date): Promise<{ canAttempt: boolean; reason: string | null; inProgressAttemptId: string | null }> {
    const mine = await this.repo.listAttemptsForUser(quiz.id, userId);
    const inProgress = mine.find((a) => a.state === 'inprogress');
    if (inProgress) return { canAttempt: true, reason: null, inProgressAttemptId: inProgress.id };
    if (quiz.timeOpen && now < quiz.timeOpen) return { canAttempt: false, reason: 'not_yet_open', inProgressAttemptId: null };
    if (quiz.timeClose && now > quiz.timeClose) return { canAttempt: false, reason: 'closed', inProgressAttemptId: null };
    if (quiz.attemptsAllowed > 0 && mine.length >= quiz.attemptsAllowed) return { canAttempt: false, reason: 'no_more_attempts', inProgressAttemptId: null };
    const slots = await this.repo.listSlots(quiz.id);
    if (!slots.length) return { canAttempt: false, reason: 'no_questions', inProgressAttemptId: null };
    return { canAttempt: true, reason: null, inProgressAttemptId: null };
  }

  /**
   * Điểm bài hiện tại của một học sinh theo grade_method của quiz (null
   * khi chưa có lượt nào chốt điểm).
   */
  async currentGradeForUser(quiz: QuizRow, userId: string): Promise<number | null> {
    const finished = (await this.repo.listAttemptsForUser(quiz.id, userId)).filter((a) => a.state === 'finished' && a.sumGrades !== null);
    if (!finished.length) return null;
    const values: number[] = [];
    for (const a of finished) {
      const usage = await this.questions.getUsage(a.usageId);
      const v = this.attemptGradeValue(quiz, a, this.usageTotalMax(usage));
      if (v !== null) values.push(v);
    }
    if (!values.length) return null;
    switch (quiz.gradeMethod) {
      case 'first': return values[0]!;
      case 'last': return values[values.length - 1]!;
      case 'average': return values.reduce((s, v) => s + v, 0) / values.length;
      default: return Math.max(...values);
    }
  }

  /**
   * Trang thông tin quiz cho người xem: cấu hình + slots, các lượt của
   * chính người xem, điểm bài hiện tại và các cờ quyền để client hiển thị
   * đúng thao tác.
   */
  async getQuizForUser(actorId: string, quizId: string): Promise<{
    quiz: QuizView;
    myAttempts: QuizAttemptSummary[];
    myGrade: number | null;
    canAttempt: boolean;
    attemptBlockedReason: string | null;
    inProgressAttemptId: string | null;
    permissions: { manage: boolean; grade: boolean; viewReports: boolean; preview: boolean; attempt: boolean };
  }> {
    const quiz = await this.getQuiz(quizId);
    await this.requireAnyViewCap(actorId, quiz);
    const view = await this.quizView(quiz);
    const mine = await this.repo.listAttemptsForUser(quiz.id, actorId, true);
    const summaries: QuizAttemptSummary[] = [];
    for (const a of mine) summaries.push(await this.attemptSummary(quiz, a));
    const eligibility = await this.attemptEligibility(quiz, actorId, new Date());
    const [manage, grade, viewReports, preview, attempt] = await Promise.all([
      this.hasCap(actorId, quiz, QUIZ_CAPABILITIES.manage),
      this.hasCap(actorId, quiz, QUIZ_CAPABILITIES.grade),
      this.hasCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports),
      this.hasCap(actorId, quiz, QUIZ_CAPABILITIES.preview),
      this.hasCap(actorId, quiz, QUIZ_CAPABILITIES.attempt),
    ]);
    return {
      quiz: view,
      myAttempts: summaries,
      myGrade: await this.currentGradeForUser(quiz, actorId),
      canAttempt: attempt && eligibility.canAttempt,
      attemptBlockedReason: eligibility.canAttempt ? null : eligibility.reason,
      inProgressAttemptId: eligibility.inProgressAttemptId,
      permissions: { manage, grade, viewReports, preview, attempt },
    };
  }

  // --- lượt làm ------------------------------------------------------------------

  /** Chọn câu cho một slot ngẫu nhiên: rút ngẫu nhiên trong category, tránh trùng câu đã chọn trong cùng lượt khi còn lựa chọn. Câu đã rút khỏi bank (hidden — QB-3) không bao giờ được rút. */
  private async pickRandomQuestion(categoryId: string, alreadyChosen: Set<string>): Promise<string> {
    const ids = await this.questions.listUsableQuestionIdsInCategory(categoryId);
    if (!ids.length) {
      throw new BadRequestException({ message: `Question category ${categoryId} has no questions for a random slot`, code: 'quiz.random_slot_empty' });
    }
    const fresh = ids.filter((id) => !alreadyChosen.has(id));
    const pool = fresh.length ? fresh : ids;
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  /**
   * Bắt đầu lượt làm mới (hoặc trả về lượt đang dở để tiếp tục): kiểm cửa
   * sổ mở–đóng và số lần cho phép phía server, rút câu cho slot ngẫu
   * nhiên, tạo usage của engine với maxMark lấy từ TỪNG SLOT, pin phiên
   * bản câu ngay lúc bắt đầu. Preview của giáo viên (quiz:preview)
   * bỏ qua cửa sổ/giới hạn và không ghi điểm về sau.
   */
  async startAttempt(actorId: string, quizId: string, opts: { preview?: boolean } = {}): Promise<QuizAttemptView> {
    const quiz = await this.getQuiz(quizId);
    const preview = opts.preview === true;
    if (preview) {
      await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.preview);
    } else {
      await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.attempt);
      await this.courses.assertCourseAccess(actorId, quiz.course);
    }
    const existing = await this.repo.listAttemptsForUser(quiz.id, actorId, true);
    const inProgress = existing.find((a) => a.state === 'inprogress' && a.preview === preview);
    if (inProgress) {
      // Tiếp tục lượt dở cũng chịu mốc quá hạn: đã quá hạn thì chốt
      // lượt phía server ngay tại tương tác này thay vì trả lượt sống.
      if (this.isOverdue(quiz, inProgress)) return this.finalizeAttempt(quiz, inProgress, true);
      return this.buildAttemptView(quiz, inProgress, false);
    }

    const now = new Date();
    if (!preview) {
      if (quiz.timeOpen && now < quiz.timeOpen) {
        throw new ForbiddenException({ message: 'This quiz is not open yet', code: 'quiz.not_yet_open' });
      }
      if (quiz.timeClose && now > quiz.timeClose) {
        throw new ForbiddenException({ message: 'This quiz is closed', code: 'quiz.closed' });
      }
      const mine = existing.filter((a) => !a.preview);
      if (quiz.attemptsAllowed > 0 && mine.length >= quiz.attemptsAllowed) {
        throw new ForbiddenException({ message: 'No more attempts are allowed for this quiz', code: 'quiz.no_more_attempts' });
      }
    }
    const slots = await this.repo.listSlots(quiz.id);
    if (!slots.length) throw new BadRequestException({ message: 'This quiz has no questions yet', code: 'quiz.no_questions' });

    const chosen = new Set<string>();
    const effective: { quizSlot: QuizSlotRow; questionId: string }[] = [];
    for (const s of slots) {
      let questionId = s.questionId;
      if (!questionId) {
        questionId = await this.pickRandomQuestion(s.categoryId!, chosen);
      }
      chosen.add(questionId);
      effective.push({ quizSlot: s, questionId });
    }
    // Moodle dùng MỘT dãy số lượt cho mỗi (quiz, user) — preview chỉ là
    // cờ trên lượt, không phải dãy riêng: ràng buộc duy nhất của
    // quiz_attempts là (quiz_id, user_id, attempt_number) không phân
    // biệt preview, đánh số riêng theo cờ sẽ va chạm khi một người vừa
    // preview vừa làm thật.
    const attemptNumber = existing.length + 1;
    const usage = await this.questions.createUsage(actorId, {
      component: QUIZ_COMPONENT, instanceId: quiz.id, contextId: await this.cmContextId(quiz),
      slots: effective.map((e) => ({
        questionId: e.questionId, maxMark: e.quizSlot.maxMark,
        // Slot ghim cứng (QB-3) truyền version đã ghim xuống engine;
        // slot follow_latest / ngẫu nhiên để engine tự phân giải bản
        // ready mới nhất lúc bắt đầu như hành vi chuẩn.
        pinnedVersionId: e.quizSlot.versionMode === 'pinned' ? (e.quizSlot.pinnedVersionId ?? undefined) : undefined,
      })),
    });
    try {
      await this.questions.startUsage(actorId, usage.usage.id);
      const row = await this.repo.insertAttempt({
        quizId: quiz.id, userId: actorId, attemptNumber, usageId: usage.usage.id,
        state: 'inprogress', preview, timeStart: now,
      });
      await this.outbox.enqueueStandalone({
        aggregate: 'quiz', type: 'quiz_attempt_started',
        payload: { quizId: quiz.id, courseId: quiz.course, attemptId: row.id, usageId: row.usageId, userId: actorId, attemptNumber, preview, actorId },
      });
      return this.buildAttemptView(quiz, row, false);
    } catch (err) {
      // Dọn dẹp bù (cùng mẫu createQuiz): usage của engine đã tạo nhưng
      // lượt không thành hình vì bất kỳ bước nào sau đó — xoá usage để
      // không để lại question_usages mồ côi (hàng quiz_attempts, nếu đã
      // chèn, cascade theo usage). Kiến trúc engine không nhận giao dịch
      // ngoài nên không bọc transaction chung được.
      await this.questions.deleteUsage(usage.usage.id).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Mốc quá hạn của một lượt (null khi không mốc nào áp dụng): mốc SỚM
   * NHẤT giữa hạn theo giới hạn thời lượng tính từ lúc bắt đầu và giờ
   * đóng của quiz. Chỉ xét giới hạn thời lượng là không đủ — một lượt
   * bắt đầu trước giờ đóng vẫn phải bị chốt khi quiz đã đóng, nếu không
   * học sinh cứ trả lời tiếp và được tính điểm sau timeClose.
   */
  private attemptDeadline(quiz: QuizRow, row: QuizAttemptRow): Date | null {
    let deadline: number | null = null;
    if (quiz.timeLimit) deadline = row.timeStart.getTime() + quiz.timeLimit * 1000;
    if (quiz.timeClose) {
      const close = quiz.timeClose.getTime();
      deadline = deadline === null ? close : Math.min(deadline, close);
    }
    return deadline === null ? null : new Date(deadline);
  }
  private isOverdue(quiz: QuizRow, row: QuizAttemptRow): boolean {
    const deadline = this.attemptDeadline(quiz, row);
    return deadline !== null && new Date() > deadline;
  }

  /**
   * Dựng view đầy đủ của một lượt: từng câu lấy nội dung của version ĐÃ
   * PIN trong engine; đáp án chỉ lộ fraction/đáp án đúng sau khi lượt đã
   * nộp (state khác inprogress).
   */
  async buildAttemptView(quiz: QuizRow, row: QuizAttemptRow, closedDueToTimeLimit: boolean): Promise<QuizAttemptView> {
    const usage = await this.questions.getUsage(row.usageId);
    const slots = await this.repo.listSlots(quiz.id);
    const pageBySlot = new Map(slots.map((s) => [s.slot, s.page]));
    const submitted = row.state !== 'inprogress';
    const questions: QuizAttemptQuestionView[] = [];
    for (const a of usage.attempts) {
      const qv = await this.questions.getQuestion(a.questionId);
      let questionText = qv.latestVersion.questionText as RichTextDocument;
      let answers: { id: string; text: RichTextDocument }[] = qv.answers.map((x) => ({ id: x.id, text: x.answer as RichTextDocument }));
      let options = qv.options;
      let stimulus: QuizAttemptQuestionView['stimulus'] = qv.stimulus ? { id: qv.stimulus.id, content: qv.stimulus.content as RichTextDocument } : null;
      if (a.questionVersionId) {
        const pinned = await this.questions.getVersionContent(a.questionId, a.questionVersionId);
        questionText = pinned.version.questionText as RichTextDocument;
        answers = pinned.answers.map((x) => ({ id: x.id, text: x.answer as RichTextDocument }));
        options = pinned.options;
        if (pinned.version.stimulusId) {
          const st = await this.questions.getStimulus(pinned.version.stimulusId).catch(() => undefined);
          stimulus = st ? { id: st.id, content: st.content as RichTextDocument } : null;
        } else {
          stimulus = null;
        }
      }
      const lastResponse = [...a.steps].reverse().find((s) => s.data.answer !== undefined)?.data.answer ?? null;
      questions.push({
        slot: a.slot,
        page: pageBySlot.get(a.slot) ?? 1,
        questionAttemptId: a.id,
        questionId: a.questionId,
        qtype: qv.question.qtype,
        name: qv.question.name,
        questionText,
        stimulus,
        answers,
        options,
        maxMark: a.maxMark,
        state: a.state,
        response: lastResponse,
        fraction: submitted ? a.fraction : null,
        mark: submitted && a.fraction !== null ? a.fraction * a.maxMark : null,
        rightAnswer: submitted ? a.rightAnswer : null,
      });
    }
    const { pendingManual } = this.syncFromUsage(usage);
    return {
      attempt: await this.attemptSummary(quiz, row),
      quiz: await this.quizView(quiz),
      questions,
      totalMax: this.usageTotalMax(usage),
      pendingManualCount: pendingManual,
      closedDueToTimeLimit,
    };
  }

  /** Quyền xem một lượt: chủ lượt, hoặc người có quiz:grade/viewreports tại module. */
  private async requireAttemptReadable(actorId: string, quiz: QuizRow, row: QuizAttemptRow): Promise<void> {
    if (row.userId === actorId) return;
    const ctx = await this.cmContextId(quiz);
    for (const cap of [QUIZ_CAPABILITIES.grade, QUIZ_CAPABILITIES.viewReports, QUIZ_CAPABILITIES.manage]) {
      if (await this.evaluator.hasCapability(actorId, cap, ctx)) return;
    }
    throw new ForbiddenException({ message: 'This attempt belongs to another user', code: 'quiz.attempt_forbidden' });
  }

  /**
   * Đọc một lượt làm (chủ lượt hoặc giáo viên). Nếu lượt đang dở mà đã
   * quá hạn làm bài, lần tương tác này chốt lượt phía server trước khi
   * trả kết quả.
   */
  async getAttemptView(actorId: string, attemptId: string): Promise<QuizAttemptView> {
    const row = await this.getAttemptRow(attemptId);
    const quiz = await this.getQuiz(row.quizId);
    await this.requireAttemptReadable(actorId, quiz, row);
    if (row.state === 'inprogress' && row.userId === actorId && this.isOverdue(quiz, row)) {
      return this.finalizeAttempt(quiz, await this.getAttemptRow(attemptId), true);
    }
    return this.buildAttemptView(quiz, row, false);
  }

  /**
   * Lưu câu trả lời của một câu trong lượt đang làm (ủy quyền engine ghi
   * step). Quá hạn làm bài: lượt bị chốt phía server ngay tại tương tác
   * này và view đã nộp được trả về thay vì ghi thêm đáp án.
   */
  async submitResponse(actorId: string, attemptId: string, input: { questionAttemptId: string; response?: string | null }): Promise<QuizAttemptView> {
    const row = await this.getAttemptRow(attemptId);
    const quiz = await this.getQuiz(row.quizId);
    if (row.userId !== actorId) {
      throw new ForbiddenException({ message: 'Only the attempt owner can answer', code: 'quiz.attempt_forbidden' });
    }
    if (row.state !== 'inprogress') {
      throw new BadRequestException({ message: 'This attempt is already submitted', code: 'quiz.attempt_already_submitted' });
    }
    if (this.isOverdue(quiz, row)) {
      return this.finalizeAttempt(quiz, row, true);
    }
    const usage = await this.questions.getUsage(row.usageId);
    if (!usage.attempts.some((a) => a.id === input.questionAttemptId)) {
      throw new NotFoundException({ message: `Question attempt ${input.questionAttemptId} is not part of this quiz attempt`, code: 'quiz.question_attempt_not_found' });
    }
    await this.questions.submitResponse(actorId, input.questionAttemptId, input.response ?? null);
    return this.buildAttemptView(quiz, await this.getAttemptRow(attemptId), false);
  }

  /**
   * Chốt một lượt phía server: engine chấm toàn bộ usage, tổng điểm được
   * đồng bộ, lượt về finished (hoặc needsgrading khi còn essay), sự kiện
   * quiz_attempt_finished được phát và — khi đã chốt hẳn — điểm bài theo
   * grade_method được ghi vào sổ điểm.
   */
  private async finalizeAttempt(quiz: QuizRow, row: QuizAttemptRow, closedDueToTimeLimit: boolean): Promise<QuizAttemptView> {
    if (row.state !== 'inprogress') return this.buildAttemptView(quiz, row, false);
    const finishedUsage = await this.questions.finishUsage(row.userId, row.usageId);
    const { sumGrades, pendingManual } = this.syncFromUsage(finishedUsage);
    const state = pendingManual > 0 ? 'needsgrading' : 'finished';
    await this.repo.updateAttempt(row.id, { state, timeFinish: new Date(), sumGrades });
    const updated = await this.getAttemptRow(row.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'quiz_attempt_finished',
      payload: {
        quizId: quiz.id, courseId: quiz.course, attemptId: row.id, usageId: row.usageId,
        userId: row.userId, attemptNumber: row.attemptNumber, preview: row.preview,
        sumGrades, needsGrading: pendingManual > 0, closedDueToTimeLimit, actorId: row.userId,
      },
    });
    if (state === 'finished' && !row.preview) await this.pushGrade(quiz, row.userId);
    return this.buildAttemptView(quiz, updated, closedDueToTimeLimit);
  }

  /**
   * Học sinh nộp bài: chốt lượt hiện tại của chính mình.
   */
  async submitAttempt(actorId: string, attemptId: string): Promise<QuizAttemptView> {
    const row = await this.getAttemptRow(attemptId);
    const quiz = await this.getQuiz(row.quizId);
    if (row.userId !== actorId) {
      throw new ForbiddenException({ message: 'Only the attempt owner can submit', code: 'quiz.attempt_forbidden' });
    }
    return this.finalizeAttempt(quiz, row, this.isOverdue(quiz, row));
  }

  /**
   * Ghi điểm bài hiện tại của một học sinh vào sổ điểm qua grade item của
   * hoạt động (bỏ qua lặng lẽ nếu item chưa tồn tại — quiz tạo trước khi
   * cơ chế item có hiệu lực; việc nộp bài không được hỏng vì sổ điểm).
   */
  private async pushGrade(quiz: QuizRow, userId: string): Promise<void> {
    if (!quiz.cmId) return;
    const value = await this.currentGradeForUser(quiz, userId);
    if (value === null) return;
    const item = await this.grades.getItemForCm(quiz.course, quiz.cmId).catch(() => undefined);
    if (!item) {
      this.logger.warn(`quiz ${quiz.id}: no grade item for cm ${quiz.cmId}; grade ${value} for user ${userId} not recorded`);
      return;
    }
    try {
      await this.grades.recordActivityGrade(item.id, userId, value);
    } catch (err) {
      // Sổ điểm từ chối ghi (vd item bị khoá — grades.item_locked) KHÔNG
      // được phép làm hỏng việc nộp bài/chấm của học sinh: lượt đã chốt
      // thành công ở tầng quiz, lỗi ghi điểm chỉ được log cảnh báo tại
      // đây (đúng ý đồ của hàm này) chứ không truyền ra response.
      this.logger.warn(`quiz ${quiz.id}: could not record grade ${value} for user ${userId} on item ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- báo cáo + chấm tay ---------------------------------------------------------

  /**
   * Trang kết quả của giáo viên (quiz:viewreports): mọi lượt làm,
   * điểm bài hiện tại theo từng học sinh, hàng đợi essay chờ chấm tay,
   * và thống kê câu sai theo từng slot (câu sai nhiều nhất xếp trước).
   */
  async getResults(actorId: string, quizId: string): Promise<{
    quiz: QuizView;
    attempts: QuizAttemptSummary[];
    gradesByUser: { userId: string; grade: number | null }[];
    needsGrading: QuizNeedsGradingView[];
    questionStats: QuizQuestionStat[];
  }> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports);
    const rows = (await this.repo.listAttempts(quiz.id)).filter((a) => !a.preview);
    const attempts: QuizAttemptSummary[] = [];
    for (const r of rows) attempts.push(await this.attemptSummary(quiz, r));
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const gradesByUser: { userId: string; grade: number | null }[] = [];
    for (const userId of userIds) gradesByUser.push({ userId, grade: await this.currentGradeForUser(quiz, userId) });
    const needsGrading: QuizNeedsGradingView[] = [];
    for (const r of rows.filter((a) => a.state === 'needsgrading')) {
      const usage = await this.questions.getUsage(r.usageId);
      for (const a of usage.attempts) {
        if (a.state !== 'needsgrading') continue;
        const lastResponse = [...a.steps].reverse().find((s) => s.data.answer !== undefined)?.data.answer ?? null;
        needsGrading.push({
          quizAttemptId: r.id, userId: r.userId, attemptNumber: r.attemptNumber,
          questionAttemptId: a.id, slot: a.slot, questionId: a.questionId,
          maxMark: a.maxMark, response: lastResponse,
        });
      }
    }
    const questionStats = await this.questionStats(rows);
    return { quiz: await this.quizView(quiz), attempts, gradesByUser, needsGrading, questionStats };
  }

  /**
   * Gộp thống kê câu sai từ các lượt đã nộp (finished/needsgrading) của
   * một quiz: duyệt usage của engine theo từng lượt, gộp theo slot. Tên
   * học sinh sai được tra một lượt theo lô ở cuối; tên câu chỉ điền khi
   * MỌI lượt ở slot dùng cùng một câu (slot cố định). Xếp wrongCount
   * giảm dần để câu sai nhiều nhất lên đầu, hoà thì theo số slot.
   */
  private async questionStats(rows: QuizAttemptRow[]): Promise<QuizQuestionStat[]> {
    const submitted = rows.filter((r) => r.state === 'finished' || r.state === 'needsgrading');
    interface SlotAcc {
      questionIds: Set<string>;
      maxMark: number;
      attemptsCount: number;
      gradedCount: number;
      pendingCount: number;
      wrongCount: number;
      fullyWrongCount: number;
      wrong: { userId: string; quizAttemptId: string; attemptNumber: number; fraction: number; mark: number }[];
    }
    const bySlot = new Map<number, SlotAcc>();
    for (const r of submitted) {
      const usage = await this.questions.getUsage(r.usageId);
      for (const a of usage.attempts) {
        let acc = bySlot.get(a.slot);
        if (!acc) {
          acc = {
            questionIds: new Set(), maxMark: a.maxMark, attemptsCount: 0,
            gradedCount: 0, pendingCount: 0, wrongCount: 0, fullyWrongCount: 0, wrong: [],
          };
          bySlot.set(a.slot, acc);
        }
        acc.questionIds.add(a.questionId);
        acc.attemptsCount += 1;
        if (a.state === 'needsgrading') {
          acc.pendingCount += 1;
        } else if (a.fraction !== null && a.fraction !== undefined) {
          acc.gradedCount += 1;
          if (a.fraction < 1) {
            acc.wrongCount += 1;
            if (a.fraction === 0) acc.fullyWrongCount += 1;
            acc.wrong.push({
              userId: r.userId, quizAttemptId: r.id, attemptNumber: r.attemptNumber,
              fraction: a.fraction, mark: a.fraction * a.maxMark,
            });
          }
        }
      }
    }
    const wrongUserIds = [...new Set([...bySlot.values()].flatMap((acc) => acc.wrong.map((w) => w.userId)))];
    const nameById = new Map<string, string>();
    if (wrongUserIds.length) {
      for (const u of await this.users.getUsersByIds(wrongUserIds)) {
        const full = `${u.firstName} ${u.lastName}`.trim();
        nameById.set(u.id, full || u.username);
      }
    }
    const questionNameById = new Map<string, string>();
    const stats: QuizQuestionStat[] = [];
    for (const [slot, acc] of bySlot) {
      const questionId = acc.questionIds.size === 1 ? [...acc.questionIds][0]! : null;
      let questionName: string | null = null;
      if (questionId) {
        if (!questionNameById.has(questionId)) {
          const view = await this.questions.getQuestion(questionId).catch(() => undefined);
          questionNameById.set(questionId, view?.question.name ?? '');
        }
        questionName = questionNameById.get(questionId) || null;
      }
      stats.push({
        slot, questionId, questionName, maxMark: acc.maxMark,
        attemptsCount: acc.attemptsCount, gradedCount: acc.gradedCount,
        pendingCount: acc.pendingCount, wrongCount: acc.wrongCount,
        fullyWrongCount: acc.fullyWrongCount,
        wrongStudents: acc.wrong.map((w) => ({
          userId: w.userId,
          displayName: nameById.get(w.userId) ?? w.userId,
          quizAttemptId: w.quizAttemptId, attemptNumber: w.attemptNumber,
          fraction: w.fraction, mark: w.mark,
        })),
      });
    }
    return stats.sort((x, y) => y.wrongCount - x.wrongCount || x.slot - y.slot);
  }

  /**
   * Chấm tay một câu essay đang chờ (quiz:grade): điểm đi qua bước
   * chấm của question engine (ghi step + fraction), tổng điểm của lượt
   * được đồng bộ lại; khi câu cuối cùng được chấm, lượt về finished và
   * điểm bài được ghi lại vào sổ điểm.
   */
  async manualGrade(actorId: string, attemptId: string, input: { questionAttemptId: string; mark: number; comment?: string }): Promise<QuizAttemptView> {
    const row = await this.getAttemptRow(attemptId);
    const quiz = await this.getQuiz(row.quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.grade);
    const usage = await this.questions.getUsage(row.usageId);
    if (!usage.attempts.some((a) => a.id === input.questionAttemptId)) {
      throw new NotFoundException({ message: `Question attempt ${input.questionAttemptId} is not part of this quiz attempt`, code: 'quiz.question_attempt_not_found' });
    }
    await this.questions.manualGradeAttempt(actorId, input.questionAttemptId, input.mark, input.comment);
    const after = await this.questions.getUsage(row.usageId);
    const { sumGrades, pendingManual } = this.syncFromUsage(after);
    const wasSubmitted = row.state === 'needsgrading' || row.state === 'finished';
    const nextState = row.state === 'inprogress' ? row.state : (pendingManual > 0 ? 'needsgrading' : 'finished');
    await this.repo.updateAttempt(row.id, { sumGrades, ...(wasSubmitted ? { state: nextState } : {}) });
    const updated = await this.getAttemptRow(row.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'quiz_attempt_regraded',
      payload: {
        quizId: quiz.id, courseId: quiz.course, attemptId: row.id, usageId: row.usageId,
        userId: row.userId, questionAttemptId: input.questionAttemptId, mark: input.mark,
        sumGrades, state: updated.state, actorId,
      },
    });
    if (updated.state === 'finished' && !row.preview) await this.pushGrade(quiz, row.userId);
    return this.buildAttemptView(quiz, updated, false);
  }

  /**
   * Các lượt làm của một quiz cho chủ nhân hoặc giáo viên — dùng cho
   * trang thông tin (lượt của tôi) và báo cáo.
   */
  async listAttemptSummaries(actorId: string, quizId: string): Promise<QuizAttemptSummary[]> {
    const quiz = await this.getQuiz(quizId);
    await this.requireAnyViewCap(actorId, quiz);
    const canSeeAll = await this.hasCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports);
    const rows = canSeeAll
      ? (await this.repo.listAttempts(quiz.id)).filter((a) => !a.preview)
      : await this.repo.listAttemptsForUser(quiz.id, actorId, true);
    const out: QuizAttemptSummary[] = [];
    for (const r of rows) out.push(await this.attemptSummary(quiz, r));
    return out;
  }
}
