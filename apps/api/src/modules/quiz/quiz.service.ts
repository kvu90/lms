import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { ExamMatrixCellView, ExamMatrixView, MatrixCellAvailability, QuizAttemptSummary, QuizOverrideView, QuizView, RichTextDocument } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { CurriculumService } from '../curriculum/curriculum.service';
import { GradesService } from '../grades/grades.service';
import { GroupsService } from '../groups/groups.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import { QuestionsService, type QuestionView, type UsageView } from '../questions/questions.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import type { CreateExamMatrixCellDto, CreateExamMatrixDto, CreateQuizOverrideDto, GenerateFromMatrixDto, SwapQuizSlotDto, UpdateExamMatrixCellDto, UpdateExamMatrixDto, UpdateQuizOverrideDto } from './dto/quiz.dto';
import { effectiveTfScale, isValidTfScale, MATRIX_PRESETS, matrixWarnings } from './domain/matrix';
import { ipMatchesSubnetList, isValidSubnetList } from './domain/subnet';
import { QuizRepository, type ExamMatrixCellRow, type ExamMatrixRow, type QuizAttemptRow, type QuizOverrideRow, type QuizRow, type QuizSlotRow } from './quiz.repository';

export const QUIZ_COMPONENT = 'mod_quiz';
export const QUIZ_CAPABILITIES = {
  view: 'quiz:view',
  attempt: 'quiz:attempt',
  manage: 'quiz:manage',
  manageOverrides: 'quiz:manageoverrides',
  viewMatrix: 'quiz:viewmatrix',
  manageMatrix: 'quiz:managematrix',
  grade: 'quiz:grade',
  viewReports: 'quiz:viewreports',
  preview: 'quiz:preview',
} as const;

/**
 * Bốn cửa sổ xem lại của Moodle (mod/quiz display options): mỗi khía
 * cạnh xem lại là một bitmask trên bốn cửa sổ này. Hằng số theo mã
 * nguồn mod/quiz: DURING = 0x10000, IMMEDIATELY_AFTER = 0x01000,
 * LATER_WHILE_OPEN = 0x00100, AFTER_CLOSE = 0x00010. Cửa sổ "ngay sau
 * nộp" kéo dài 2 phút kể từ lúc lượt được chốt (khoảng ngắn theo
 * Moodle).
 */
export const REVIEW_WINDOW = {
  during: 0x10000,
  immediatelyAfter: 0x01000,
  laterWhileOpen: 0x00100,
  afterClose: 0x00010,
} as const;

/** Khoảng cửa sổ "ngay sau nộp" tính bằng mili-giây. */
export const REVIEW_IMMEDIATELY_AFTER_MS = 2 * 60 * 1000;

/** Nhãn hiển thị của các dạng câu trong tài liệu đặc tả. */
export const QTYPE_LABELS: Record<string, string> = {
  multichoice: 'Trắc nghiệm',
  truefalse: 'Đúng–Sai',
  shortanswer: 'Trả lời ngắn',
  essay: 'Tự luận',
};

/** Nhãn hiển thị của các mức nhận thức trong tài liệu đặc tả. */
export const LEVEL_LABELS: Record<string, string> = {
  biet: 'Biết',
  hieu: 'Hiểu',
  van_dung: 'Vận dụng',
  van_dung_cao: 'Vận dụng cao',
};

/** View model bản đặc tả (mục C.6) — nguồn duy nhất cho cả JSON lẫn hai định dạng xuất file. */
export interface MatrixSpecification {
  matrix: { id: string; name: string; presetKind: string; totalScore: number; levelSet: string };
  subject: { id: string; name: string };
  curriculum: { id: string; grade: number };
  purpose: string;
  structure: { qtype: string; questionCount: number; score: number; percent: number }[];
  topics: {
    topicId: string | null;
    topicTitle: string;
    nodes: {
      nodeId: string;
      nodeTitle: string;
      outcomes: {
        outcomeId: string;
        content: string;
        sourceKind: string;
        sourceRef: string | null;
        /** Nguyên văn YCCĐ chương trình (bản thân outcome khi là 'program', hoặc outcome gốc khi là 'derived'). */
        programContent: string | null;
        /** Bản tách mức của tổ chuyên môn khi outcome của ô là bản 'derived'. */
        derivedContent: string | null;
        cells: {
          cellId: string;
          cognitiveLevel: string;
          qtype: string;
          questionCount: number;
          cellScore: number;
          minutes: number | null;
          slotNumbers: number[] | null;
          drawNote: string | null;
          /** Để dành cho nhãn năng lực (điểm nối curriculum ↔ competency) — chưa có cơ chế gắn mã ở chặng này. */
          competencyRefs: string[];
        }[];
      }[];
    }[];
  }[];
  totals: {
    byForm: { qtype: string; questionCount: number; score: number; percent: number }[];
    totalScore: number;
    totalQuestions: number;
  };
  quiz: { id: string; name: string } | null;
}

/** Bung view model đặc tả thành các dòng phẳng cho bảng xuất file (một dòng = một ô ma trận). */
export function flattenSpecification(spec: MatrixSpecification): {
  index: number; topicTitle: string; nodeTitle: string; outcomeText: string;
  levelLabel: string; qtypeLabel: string; questionCount: number; cellScore: number; slotText: string;
}[] {
  const rows: {
    index: number; topicTitle: string; nodeTitle: string; outcomeText: string;
    levelLabel: string; qtypeLabel: string; questionCount: number; cellScore: number; slotText: string;
  }[] = [];
  let index = 0;
  for (const topic of spec.topics) {
    for (const node of topic.nodes) {
      for (const outcome of node.outcomes) {
        for (const cell of outcome.cells) {
          index += 1;
          const slotText = cell.slotNumbers && cell.slotNumbers.length
            ? (cell.drawNote ? `${cell.drawNote} (vị trí ${cell.slotNumbers.join(', ')})` : cell.slotNumbers.join(', '))
            : (cell.drawNote ?? '');
          rows.push({
            index,
            topicTitle: topic.topicTitle,
            nodeTitle: node.nodeTitle,
            outcomeText: outcome.derivedContent
              ? `${outcome.programContent ?? ''}\n(Tách mức: ${outcome.derivedContent})`
              : (outcome.programContent ?? outcome.content),
            levelLabel: LEVEL_LABELS[cell.cognitiveLevel] ?? cell.cognitiveLevel,
            qtypeLabel: QTYPE_LABELS[cell.qtype] ?? cell.qtype,
            questionCount: cell.qtype === 'truefalse' ? cell.questionCount * 4 : cell.questionCount,
            cellScore: cell.cellScore,
            slotText,
          });
        }
      }
    }
  }
  return rows;
}

/** Cài đặt thi HIỆU LỰC của một người dùng sau khi hợp nhất override (user > nhóm > quiz) — xem resolveEffectiveSettings. */
export interface EffectiveQuizSettings {
  timeOpen: Date | null;
  timeClose: Date | null;
  /** Giới hạn thời lượng (giây); null = không giới hạn. */
  timeLimit: number | null;
  /** Số lượt tối đa; 0 = không giới hạn. */
  attemptsAllowed: number;
  /** Các băm mật khẩu chấp nhận được (rỗng = đề không yêu cầu mật khẩu với người này). */
  passwordHashes: string[];
  passwordRequired: boolean;
  /** Danh sách subnet của quiz (override không mang subnet như Moodle); null = không giới hạn. */
  subnet: string | null;
}

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
  /** Nhận xét riêng cho đáp án đã chọn (cổng review_specific_feedback của Moodle); null khi cửa sổ hiện tại không cho xem hoặc câu không có nhận xét riêng khớp lựa chọn. */
  feedback: RichTextDocument | null;
  /** Nhận xét chung của câu (cổng review_general_feedback). */
  generalFeedback: RichTextDocument | null;
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
    private readonly passwords: PasswordService,
    private readonly groups: GroupsService,
    private readonly curriculum: CurriculumService,
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
        matrixCellId: s.matrixCellId, clusterId: s.clusterId,
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
      hasPassword: quiz.passwordHash !== null,
      subnet: quiz.subnet,
      delay1Seconds: quiz.delay1,
      delay2Seconds: quiz.delay2,
      reviewAttempt: quiz.reviewAttempt,
      reviewCorrectness: quiz.reviewCorrectness,
      reviewMarks: quiz.reviewMarks,
      reviewSpecificFeedback: quiz.reviewSpecificFeedback,
      reviewGeneralFeedback: quiz.reviewGeneralFeedback,
      reviewRightAnswer: quiz.reviewRightAnswer,
      reviewOverallFeedback: quiz.reviewOverallFeedback,
      matrixId: quiz.matrixId,
      tfScale: quiz.tfScale,
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
   * Ngoại lệ Chặng 3 (mục C.4): các slot thuộc một CHÙM Đ–S (cluster_id)
   * không cộng tuyến tính — điểm chùm tra thang lũy tiến theo SỐ Ý ĐÚNG
   * (fraction = 1) trên tổng max_mark danh nghĩa của chùm; thang hiệu
   * lực là thang của quiz (chụp từ ô khi generate) hoặc mặc định QĐ 764.
   * Engine và question_attempts.max_mark không đổi — chùm hoá chỉ nằm ở
   * tầng tổng hợp này. Chùm còn câu chờ chấm tay thì phần đã chấm tính
   * tuyến tính như thường (không xảy ra với truefalse tự chấm).
   */
  private syncFromUsage(usage: UsageView, quiz?: QuizRow, slots?: QuizSlotRow[]): { sumGrades: number; pendingManual: number } {
    let sum = 0;
    let pending = 0;
    const clusterBySlot = new Map<number, string>();
    if (quiz && slots) {
      for (const s of slots) if (s.clusterId) clusterBySlot.set(s.slot, s.clusterId);
    }
    const clusterMembers = new Map<string, UsageView['attempts']>();
    for (const a of usage.attempts) {
      const clusterId = clusterBySlot.get(a.slot);
      if (clusterId) {
        const list = clusterMembers.get(clusterId) ?? [];
        list.push(a);
        clusterMembers.set(clusterId, list);
        continue;
      }
      if (a.state === 'needsgrading') pending += 1;
      else if (a.fraction !== null && a.fraction !== undefined) sum += a.fraction * a.maxMark;
    }
    if (clusterMembers.size && quiz) {
      const scale = effectiveTfScale(quiz.tfScale);
      for (const members of clusterMembers.values()) {
        const pendingMembers = members.filter((a) => a.state === 'needsgrading');
        if (pendingMembers.length) {
          pending += pendingMembers.length;
          for (const a of members) {
            if (a.state !== 'needsgrading' && a.fraction !== null && a.fraction !== undefined) sum += a.fraction * a.maxMark;
          }
          continue;
        }
        const correct = members.filter((a) => a.fraction === 1).length;
        const totalMax = members.reduce((s, a) => s + a.maxMark, 0);
        sum += (scale[Math.min(correct, 4)]! / 100) * totalMax;
      }
    }
    return { sumGrades: sum, pendingManual: pending };
  }

  // --- CRUD quiz ---------------------------------------------------------------

  /** Kiểm tra định dạng danh sách subnet khi lưu cài đặt; sai định dạng là lỗi của người soạn, không để lọt xuống tầng kiểm tra lúc thi. */
  private assertValidSubnet(subnet: string | null | undefined): void {
    if (subnet !== undefined && subnet !== null && !isValidSubnetList(subnet)) {
      throw new BadRequestException({ message: 'Subnet must be a comma-separated list of IPs or CIDR ranges', code: 'quiz.subnet_invalid' });
    }
  }

  /** Băm mật khẩu vào thi (argon2 qua PasswordService dùng chung) — không bao giờ lưu dạng rõ. */
  private async hashQuizPassword(password: string | null | undefined): Promise<string | null> {
    if (password === undefined || password === null) return null;
    return this.passwords.hash(password);
  }

  /** Kiểm tra thang Đ–S khi lưu (đúng 5 mức, đơn điệu không giảm, cuối = 100) — thang sai là lỗi soạn đề, chặn ở biên. */
  private assertValidTfScale(scale: number[] | null | undefined): void {
    if (scale !== undefined && scale !== null && !isValidTfScale(scale)) {
      throw new BadRequestException({ message: 'tfScale must be 5 percentages (0..100), non-decreasing, ending at 100', code: 'quiz.tf_scale_invalid' });
    }
  }

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
    password?: string | null; subnet?: string | null;
    delay1Seconds?: number | null; delay2Seconds?: number | null;
    reviewAttempt?: number; reviewCorrectness?: number; reviewMarks?: number;
    reviewSpecificFeedback?: number; reviewGeneralFeedback?: number;
    reviewRightAnswer?: number; reviewOverallFeedback?: number;
    tfScale?: number[] | null;
  }): Promise<QuizView> {
    await this.courses.getCourse(courseId);
    const timeOpen = input.timeOpen ? new Date(input.timeOpen) : null;
    const timeClose = input.timeClose ? new Date(input.timeClose) : null;
    if (timeOpen && timeClose && timeClose <= timeOpen) {
      throw new BadRequestException({ message: 'timeClose must be after timeOpen', code: 'quiz.bad_window' });
    }
    this.assertValidSubnet(input.subnet);
    this.assertValidTfScale(input.tfScale);
    const quiz = await this.repo.insertQuiz({
      course: courseId, cmId: null, name: input.name, intro: input.intro ?? '',
      timeOpen, timeClose, timeLimit: input.timeLimitSeconds ?? null,
      attemptsAllowed: input.attemptsAllowed ?? 0,
      gradeMethod: input.gradeMethod ?? 'highest',
      grade: input.grade ?? 10,
      shuffleAnswers: input.shuffleAnswers ?? false,
      passwordHash: await this.hashQuizPassword(input.password),
      subnet: input.subnet ?? null,
      delay1: input.delay1Seconds ?? null,
      delay2: input.delay2Seconds ?? null,
      tfScale: input.tfScale ?? null,
      ...(input.reviewAttempt !== undefined ? { reviewAttempt: input.reviewAttempt } : {}),
      ...(input.reviewCorrectness !== undefined ? { reviewCorrectness: input.reviewCorrectness } : {}),
      ...(input.reviewMarks !== undefined ? { reviewMarks: input.reviewMarks } : {}),
      ...(input.reviewSpecificFeedback !== undefined ? { reviewSpecificFeedback: input.reviewSpecificFeedback } : {}),
      ...(input.reviewGeneralFeedback !== undefined ? { reviewGeneralFeedback: input.reviewGeneralFeedback } : {}),
      ...(input.reviewRightAnswer !== undefined ? { reviewRightAnswer: input.reviewRightAnswer } : {}),
      ...(input.reviewOverallFeedback !== undefined ? { reviewOverallFeedback: input.reviewOverallFeedback } : {}),
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
    password?: string | null; subnet?: string | null;
    delay1Seconds?: number | null; delay2Seconds?: number | null;
    reviewAttempt?: number; reviewCorrectness?: number; reviewMarks?: number;
    reviewSpecificFeedback?: number; reviewGeneralFeedback?: number;
    reviewRightAnswer?: number; reviewOverallFeedback?: number;
    tfScale?: number[] | null;
  }): Promise<QuizView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    this.assertValidSubnet(input.subnet);
    this.assertValidTfScale(input.tfScale);
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
    if (input.password !== undefined) patch.passwordHash = await this.hashQuizPassword(input.password);
    if (input.subnet !== undefined) patch.subnet = input.subnet;
    if (input.delay1Seconds !== undefined) patch.delay1 = input.delay1Seconds;
    if (input.delay2Seconds !== undefined) patch.delay2 = input.delay2Seconds;
    if (input.reviewAttempt !== undefined) patch.reviewAttempt = input.reviewAttempt;
    if (input.reviewCorrectness !== undefined) patch.reviewCorrectness = input.reviewCorrectness;
    if (input.reviewMarks !== undefined) patch.reviewMarks = input.reviewMarks;
    if (input.reviewSpecificFeedback !== undefined) patch.reviewSpecificFeedback = input.reviewSpecificFeedback;
    if (input.reviewGeneralFeedback !== undefined) patch.reviewGeneralFeedback = input.reviewGeneralFeedback;
    if (input.reviewRightAnswer !== undefined) patch.reviewRightAnswer = input.reviewRightAnswer;
    if (input.reviewOverallFeedback !== undefined) patch.reviewOverallFeedback = input.reviewOverallFeedback;
    if (input.tfScale !== undefined) patch.tfScale = input.tfScale;
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

  // --- ghi đè cài đặt thi (overrides, Chặng 2) -----------------------------------

  /** View của một override: tên đích được tra cứu để client hiển thị, mật khẩu chỉ lộ cờ hasPassword. */
  private async overrideView(row: QuizOverrideRow): Promise<QuizOverrideView> {
    let groupName: string | null = null;
    let userName: string | null = null;
    if (row.groupId) {
      const group = await this.groups.getGroup(row.groupId).catch(() => undefined);
      groupName = group?.name ?? null;
    }
    if (row.userId) {
      const [user] = await this.users.getUsersByIds([row.userId]);
      if (user) userName = `${user.firstName} ${user.lastName}`.trim() || user.username;
    }
    return {
      id: row.id, quizId: row.quizId,
      groupId: row.groupId, groupName,
      userId: row.userId, userName,
      timeOpen: row.timeOpen?.toISOString() ?? null,
      timeClose: row.timeClose?.toISOString() ?? null,
      timeLimitSeconds: row.timeLimit,
      attempts: row.attempts,
      hasPassword: row.passwordHash !== null,
    };
  }

  private async getOverrideRow(quiz: QuizRow, overrideId: string): Promise<QuizOverrideRow> {
    const row = await this.repo.getOverride(overrideId);
    if (!row || row.quizId !== quiz.id) {
      throw new NotFoundException({ message: `Quiz override ${overrideId} not found`, code: 'quiz.override_not_found' });
    }
    return row;
  }

  /** Danh sách ghi đè của quiz (quiz:manageoverrides). */
  async listOverrides(actorId: string, quizId: string): Promise<QuizOverrideView[]> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
    const rows = await this.repo.listOverrides(quiz.id);
    const out: QuizOverrideView[] = [];
    for (const r of rows) out.push(await this.overrideView(r));
    return out;
  }

  /**
   * Tạo ghi đè (quiz:manageoverrides): đích phải là đúng MỘT nhóm của
   * khoá chứa quiz hoặc đúng MỘT người dùng có quyền vào khoá; mỗi đích
   * tối đa một ghi đè cho một quiz (trùng đích bị từ chối thay vì đè
   * lặng lẽ như Moodle upsert).
   */
  async createOverride(actorId: string, quizId: string, input: CreateQuizOverrideDto): Promise<QuizOverrideView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
    if (!!input.groupId === !!input.userId) {
      throw new BadRequestException({ message: 'An override needs exactly one target: groupId or userId', code: 'quiz.override_target' });
    }
    const timeOpen = input.timeOpen ? new Date(input.timeOpen) : null;
    const timeClose = input.timeClose ? new Date(input.timeClose) : null;
    if (timeOpen && timeClose && timeClose <= timeOpen) {
      throw new BadRequestException({ message: 'timeClose must be after timeOpen', code: 'quiz.bad_window' });
    }
    if (input.groupId) {
      const group = await this.groups.getGroup(input.groupId);
      if (group.courseId !== quiz.course) {
        throw new BadRequestException({ message: 'Group does not belong to the course of this quiz', code: 'quiz.override_group_mismatch' });
      }
    }
    if (input.userId) {
      await this.users.getUser(input.userId);
      await this.courses.assertCourseAccess(input.userId, quiz.course);
    }
    const existing = await this.repo.listOverrides(quiz.id);
    if (existing.some((o) => o.groupId === (input.groupId ?? null) && o.userId === (input.userId ?? null))) {
      throw new BadRequestException({ message: 'An override already exists for this target', code: 'quiz.override_exists' });
    }
    const row = await this.repo.insertOverride({
      quizId: quiz.id,
      groupId: input.groupId ?? null,
      userId: input.userId ?? null,
      timeOpen, timeClose,
      timeLimit: input.timeLimitSeconds ?? null,
      attempts: input.attempts ?? null,
      passwordHash: await this.hashQuizPassword(input.password),
    });
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_override_created', payload: { quizId: quiz.id, courseId: quiz.course, overrideId: row.id, actorId } });
    return this.overrideView(row);
  }

  /** Sửa một ghi đè (quiz:manageoverrides); trường không gửi giữ nguyên, `null` ở trường ghi đè = quay về kế thừa. */
  async updateOverride(actorId: string, quizId: string, overrideId: string, input: UpdateQuizOverrideDto): Promise<QuizOverrideView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
    const row = await this.getOverrideRow(quiz, overrideId);
    const patch: Partial<QuizOverrideRow> = {};
    if (input.timeOpen !== undefined) patch.timeOpen = input.timeOpen ? new Date(input.timeOpen) : null;
    if (input.timeClose !== undefined) patch.timeClose = input.timeClose ? new Date(input.timeClose) : null;
    if (input.timeLimitSeconds !== undefined) patch.timeLimit = input.timeLimitSeconds;
    if (input.attempts !== undefined) patch.attempts = input.attempts;
    if (input.password !== undefined) patch.passwordHash = await this.hashQuizPassword(input.password);
    const nextOpen = patch.timeOpen !== undefined ? patch.timeOpen : row.timeOpen;
    const nextClose = patch.timeClose !== undefined ? patch.timeClose : row.timeClose;
    if (nextOpen && nextClose && nextClose <= nextOpen) {
      throw new BadRequestException({ message: 'timeClose must be after timeOpen', code: 'quiz.bad_window' });
    }
    if (Object.keys(patch).length) await this.repo.updateOverride(row.id, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_override_updated', payload: { quizId: quiz.id, courseId: quiz.course, overrideId: row.id, actorId } });
    return this.overrideView(await this.getOverrideRow(quiz, overrideId));
  }

  /** Xoá một ghi đè (quiz:manageoverrides) — đích của ghi đè quay về cài đặt tầng dưới ngay. */
  async deleteOverride(actorId: string, quizId: string, overrideId: string): Promise<void> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
    const row = await this.getOverrideRow(quiz, overrideId);
    await this.repo.deleteOverride(row.id);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_override_deleted', payload: { quizId: quiz.id, courseId: quiz.course, overrideId: row.id, actorId } });
  }

  // --- ma trận đề (Chặng 3) ---------------------------------------------------------

  private async getMatrixRow(id: string): Promise<ExamMatrixRow> {
    const row = await this.repo.getMatrix(id);
    if (!row) throw new NotFoundException({ message: `Exam matrix ${id} not found`, code: 'quiz.matrix_not_found' });
    return row;
  }
  private async requireMatrixCap(actorId: string, matrix: ExamMatrixRow, capability: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, capability, matrix.contextId);
  }
  private matrixCellView(row: ExamMatrixCellRow): ExamMatrixCellView {
    return {
      id: row.id, matrixId: row.matrixId, learningOutcomeId: row.learningOutcomeId,
      cognitiveLevel: row.cognitiveLevel as ExamMatrixCellView['cognitiveLevel'],
      qtype: row.qtype as ExamMatrixCellView['qtype'],
      questionCount: row.questionCount, cellScore: row.cellScore,
      minutes: row.minutes, tfScale: row.tfScale, position: row.position,
    };
  }
  private async matrixView(row: ExamMatrixRow): Promise<ExamMatrixView> {
    const cells = await this.repo.listMatrixCells(row.id);
    return {
      id: row.id, name: row.name, subjectId: row.subjectId, curriculumId: row.curriculumId,
      contextId: row.contextId,
      presetKind: row.presetKind as ExamMatrixView['presetKind'],
      targetFormPercents: row.targetFormPercents, targetLevelPercents: row.targetLevelPercents,
      levelSet: row.levelSet as ExamMatrixView['levelSet'],
      scopeNote: row.scopeNote, scopeOutcomeIds: row.scopeOutcomeIds,
      totalScore: row.totalScore, createdBy: row.createdBy,
      cells: cells.map((c) => this.matrixCellView(c)),
      warnings: matrixWarnings({
        cells, targetFormPercents: row.targetFormPercents,
        targetLevelPercents: row.targetLevelPercents, totalScore: row.totalScore,
      }),
    };
  }

  /**
   * Tạo ma trận (quiz:managematrix tại context của môn): tỉ lệ mục tiêu
   * không được cho thì CHỤP từ preset tại lúc tạo — về sau preset có đổi
   * thì ma trận đã tạo không đổi theo.
   */
  async createMatrix(actorId: string, input: CreateExamMatrixDto): Promise<ExamMatrixView> {
    const subject = await this.curriculum.getSubject(actorId, input.subjectId);
    const curriculum = await this.curriculum.getCurriculum(actorId, input.curriculumId);
    if (curriculum.subjectId !== subject.id) {
      throw new BadRequestException({ message: 'Curriculum does not belong to the subject', code: 'quiz.matrix_curriculum_mismatch' });
    }
    await this.evaluator.requireCapability(actorId, QUIZ_CAPABILITIES.manageMatrix, subject.contextId);
    const presetKind = input.presetKind ?? 'custom';
    const preset = presetKind === 'custom' ? undefined : MATRIX_PRESETS[presetKind];
    const row = await this.repo.insertMatrix({
      name: input.name, subjectId: subject.id, curriculumId: curriculum.id,
      contextId: subject.contextId, presetKind,
      targetFormPercents: input.targetFormPercents !== undefined ? input.targetFormPercents : (preset?.targetFormPercents ?? null),
      targetLevelPercents: input.targetLevelPercents !== undefined ? input.targetLevelPercents : (preset?.targetLevelPercents ?? null),
      levelSet: input.levelSet ?? 'three',
      scopeNote: input.scopeNote ?? null,
      scopeOutcomeIds: input.scopeOutcomeIds ?? null,
      totalScore: input.totalScore ?? 10,
      createdBy: actorId,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_created', payload: { matrixId: row.id, subjectId: subject.id, actorId } });
    return this.matrixView(row);
  }

  /** Đọc một ma trận kèm ô và cảnh báo lệch tỉ lệ (quiz:viewmatrix). */
  async getMatrix(actorId: string, matrixId: string): Promise<ExamMatrixView> {
    const row = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.viewMatrix);
    return this.matrixView(row);
  }

  /** Các ma trận của một môn (quiz:viewmatrix tại context của môn). */
  async listMatrices(actorId: string, subjectId: string): Promise<ExamMatrixView[]> {
    const subject = await this.curriculum.getSubject(actorId, subjectId);
    await this.evaluator.requireCapability(actorId, QUIZ_CAPABILITIES.viewMatrix, subject.contextId);
    const rows = await this.repo.listMatricesBySubject(subject.id);
    const out: ExamMatrixView[] = [];
    for (const r of rows) out.push(await this.matrixView(r));
    return out;
  }

  /** Sửa ma trận (quiz:managematrix); thu hẹp bộ mức khi đã có ô dùng mức bị loại thì bị từ chối. */
  async updateMatrix(actorId: string, matrixId: string, input: UpdateExamMatrixDto): Promise<ExamMatrixView> {
    const row = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.manageMatrix);
    if (input.levelSet === 'three' && row.levelSet !== 'three') {
      const cells = await this.repo.listMatrixCells(row.id);
      if (cells.some((c) => c.cognitiveLevel === 'van_dung_cao')) {
        throw new BadRequestException({ message: 'Cells already use van_dung_cao; remove them before switching to the three-level set', code: 'quiz.matrix_level_in_use' });
      }
    }
    const patch: Partial<ExamMatrixRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.presetKind !== undefined) patch.presetKind = input.presetKind;
    if (input.targetFormPercents !== undefined) patch.targetFormPercents = input.targetFormPercents;
    if (input.targetLevelPercents !== undefined) patch.targetLevelPercents = input.targetLevelPercents;
    if (input.levelSet !== undefined) patch.levelSet = input.levelSet;
    if (input.scopeNote !== undefined) patch.scopeNote = input.scopeNote;
    if (input.scopeOutcomeIds !== undefined) patch.scopeOutcomeIds = input.scopeOutcomeIds;
    if (input.totalScore !== undefined) patch.totalScore = input.totalScore;
    if (Object.keys(patch).length) await this.repo.updateMatrix(row.id, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_updated', payload: { matrixId: row.id, actorId } });
    return this.matrixView(await this.getMatrixRow(matrixId));
  }

  /** Xoá ma trận (quiz:managematrix); đề đã sinh từ ma trận giữ nguyên, chỉ mất vết matrix_id (FK set null). */
  async deleteMatrix(actorId: string, matrixId: string): Promise<void> {
    const row = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.manageMatrix);
    await this.repo.deleteMatrix(row.id);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_deleted', payload: { matrixId: row.id, actorId } });
  }

  private async getMatrixCellRow(matrix: ExamMatrixRow, cellId: string): Promise<ExamMatrixCellRow> {
    const row = await this.repo.getMatrixCell(cellId);
    if (!row || row.matrixId !== matrix.id) {
      throw new NotFoundException({ message: `Exam matrix cell ${cellId} not found`, code: 'quiz.matrix_cell_not_found' });
    }
    return row;
  }

  /**
   * Thêm ô vào ma trận (quiz:managematrix): outcome phải thuộc chương
   * trình của ma trận, mức phải thuộc bộ mức của ma trận, và khi ma
   * trận có phạm vi đã dạy (scope_outcome_ids) thì outcome phải nằm
   * trong phạm vi.
   */
  async createMatrixCell(actorId: string, matrixId: string, input: CreateExamMatrixCellDto): Promise<ExamMatrixView> {
    const matrix = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    this.assertValidTfScale(input.tfScale);
    if (matrix.levelSet === 'three' && input.cognitiveLevel === 'van_dung_cao') {
      throw new BadRequestException({ message: 'van_dung_cao is not part of the three-level set of this matrix', code: 'quiz.matrix_level_not_in_set' });
    }
    if (matrix.scopeOutcomeIds && matrix.scopeOutcomeIds.length && !matrix.scopeOutcomeIds.includes(input.learningOutcomeId)) {
      throw new BadRequestException({ message: 'Outcome is outside the taught scope of this matrix', code: 'quiz.matrix_cell_out_of_scope' });
    }
    const outcome = await this.curriculum.getOutcome(actorId, input.learningOutcomeId);
    const node = await this.curriculum.getNode(actorId, outcome.nodeId);
    if (node.curriculumId !== matrix.curriculumId) {
      throw new BadRequestException({ message: 'Outcome does not belong to the curriculum of this matrix', code: 'quiz.matrix_cell_outcome_mismatch' });
    }
    const cells = await this.repo.listMatrixCells(matrix.id);
    if (cells.some((c) => c.learningOutcomeId === input.learningOutcomeId && c.cognitiveLevel === input.cognitiveLevel && c.qtype === input.qtype)) {
      throw new BadRequestException({ message: 'A cell already exists for this outcome, level and question type', code: 'quiz.matrix_cell_exists' });
    }
    const position = input.position ?? (cells.length ? Math.max(...cells.map((c) => c.position)) + 1 : 1);
    await this.repo.insertMatrixCell({
      matrixId: matrix.id, learningOutcomeId: input.learningOutcomeId,
      cognitiveLevel: input.cognitiveLevel, qtype: input.qtype,
      questionCount: input.questionCount, cellScore: input.cellScore,
      minutes: input.minutes ?? null, tfScale: input.tfScale ?? null, position,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_cell_created', payload: { matrixId: matrix.id, actorId } });
    return this.matrixView(await this.getMatrixRow(matrixId));
  }

  /** Sửa một ô (quiz:managematrix) — khoá outcome/mức/dạng không đổi qua sửa; muốn đổi thì xoá ô tạo lại. */
  async updateMatrixCell(actorId: string, matrixId: string, cellId: string, input: UpdateExamMatrixCellDto): Promise<ExamMatrixView> {
    const matrix = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    const cell = await this.getMatrixCellRow(matrix, cellId);
    this.assertValidTfScale(input.tfScale);
    const patch: Partial<ExamMatrixCellRow> = {};
    if (input.questionCount !== undefined) patch.questionCount = input.questionCount;
    if (input.cellScore !== undefined) patch.cellScore = input.cellScore;
    if (input.minutes !== undefined) patch.minutes = input.minutes;
    if (input.tfScale !== undefined) patch.tfScale = input.tfScale;
    if (input.position !== undefined) patch.position = input.position;
    if (Object.keys(patch).length) await this.repo.updateMatrixCell(cell.id, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_cell_updated', payload: { matrixId: matrix.id, cellId: cell.id, actorId } });
    return this.matrixView(await this.getMatrixRow(matrixId));
  }

  /** Xoá một ô khỏi ma trận (quiz:managematrix). */
  async deleteMatrixCell(actorId: string, matrixId: string, cellId: string): Promise<ExamMatrixView> {
    const matrix = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    const cell = await this.getMatrixCellRow(matrix, cellId);
    await this.repo.deleteMatrixCell(cell.id);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_cell_deleted', payload: { matrixId: matrix.id, cellId: cell.id, actorId } });
    return this.matrixView(await this.getMatrixRow(matrixId));
  }

  /**
   * Ứng viên thô của một ô: câu ready gắn đúng outcome + mức, đúng
   * dạng (qua question_learning_outcomes / Curriculum Chặng 2). Chưa
   * xét quyền dùng ngân hàng của người gọi.
   */
  private async cellCandidates(cell: ExamMatrixCellRow): Promise<QuestionView[]> {
    return this.questions.listQuestionsByCurriculumFilter({
      outcomeId: cell.learningOutcomeId, cognitiveLevel: cell.cognitiveLevel,
      qtype: cell.qtype, status: 'ready',
    });
  }

  /**
   * Ứng viên một NGƯỜI DÙNG được dùng: ứng viên thô lọc theo quyền
   * question:useall tại context của category chứa câu (cùng quy tắc
   * quyền ngân hàng hiện hành).
   */
  private async cellCandidatesForUser(actorId: string, cell: ExamMatrixCellRow): Promise<QuestionView[]> {
    const all = await this.cellCandidates(cell);
    const out: QuestionView[] = [];
    const usableByContext = new Map<string, boolean>();
    for (const view of all) {
      const category = await this.questions.getCategory(view.entry.questionCategoryId);
      let usable = usableByContext.get(category.contextId);
      if (usable === undefined) {
        usable = await this.evaluator.hasCapability(actorId, 'question:useall', category.contextId);
        usableByContext.set(category.contextId, usable);
      }
      if (usable) out.push(view);
    }
    return out;
  }

  /**
   * Các chùm Đ–S hợp lệ từ danh sách ứng viên truefalse: nhóm theo
   * stimulus, chỉ giữ nhóm ĐÚNG 4 câu (một chùm = một stimulus + 4 câu
   * cùng outcome/mức — ứng viên đã lọc sẵn theo outcome/mức của ô).
   */
  private tfClustersOf(candidates: QuestionView[]): QuestionView[][] {
    const byStimulus = new Map<string, QuestionView[]>();
    for (const view of candidates) {
      if (!view.stimulus) continue;
      const list = byStimulus.get(view.stimulus.id) ?? [];
      list.push(view);
      byStimulus.set(view.stimulus.id, list);
    }
    return [...byStimulus.values()].filter((list) => list.length === 4);
  }

  /** Số đơn vị khả dụng của một ô cho một người dùng: ô thường đếm câu; ô truefalse đếm CHÙM. */
  private async cellAvailableCount(actorId: string, cell: ExamMatrixCellRow): Promise<number> {
    const candidates = await this.cellCandidatesForUser(actorId, cell);
    return cell.qtype === 'truefalse' ? this.tfClustersOf(candidates).length : candidates.length;
  }

  /**
   * Khả dụng ngân hàng theo từng ô cho người gọi (quiz:viewmatrix):
   * cần / có / thiếu. Generate khoá cứng khi bất kỳ ô nào thiếu.
   */
  async matrixAvailability(actorId: string, matrixId: string): Promise<{ matrixId: string; cells: MatrixCellAvailability[]; sufficient: boolean }> {
    const matrix = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.viewMatrix);
    const cells = await this.repo.listMatrixCells(matrix.id);
    const out: MatrixCellAvailability[] = [];
    for (const cell of cells) {
      const available = await this.cellAvailableCount(actorId, cell);
      out.push({ cellId: cell.id, required: cell.questionCount, available, deficit: Math.max(0, cell.questionCount - available) });
    }
    return { matrixId: matrix.id, cells: out, sufficient: out.every((c) => c.deficit === 0) };
  }

  /** Trộn ngẫu nhiên một bản sao của mảng (Fisher–Yates) cho các phép rút câu. */
  private shuffled<T>(items: T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** Chi tiết thiếu câu theo từng ô cho lỗi cứng của generate (mục C.3 bước 1). */
  private async matrixDeficits(actorId: string, cells: ExamMatrixCellRow[]): Promise<{
    deficits: { cellId: string; learningOutcomeId: string; cognitiveLevel: string; qtype: string; required: number; available: number; deficit: number }[];
    pools: Map<string, { candidates: QuestionView[]; clusters: QuestionView[][] }>;
  }> {
    const deficits: { cellId: string; learningOutcomeId: string; cognitiveLevel: string; qtype: string; required: number; available: number; deficit: number }[] = [];
    const pools = new Map<string, { candidates: QuestionView[]; clusters: QuestionView[][] }>();
    for (const cell of cells) {
      const candidates = await this.cellCandidatesForUser(actorId, cell);
      const clusters = cell.qtype === 'truefalse' ? this.tfClustersOf(candidates) : [];
      pools.set(cell.id, { candidates, clusters });
      const available = cell.qtype === 'truefalse' ? clusters.length : candidates.length;
      if (available < cell.questionCount) {
        deficits.push({
          cellId: cell.id, learningOutcomeId: cell.learningOutcomeId,
          cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype,
          required: cell.questionCount, available, deficit: cell.questionCount - available,
        });
      }
    }
    return { deficits, pools };
  }

  /**
   * Sinh đề từ ma trận (mục C.3): thiếu câu ở BẤT KỲ ô nào → 422
   * `quiz.matrix_insufficient_questions` kèm chi tiết từng ô, không
   * sinh một phần. Đủ câu → tạo quiz bằng cơ chế Chặng 1 (course module
   * + grade item, quyền khoá do đường đó kiểm), ghi matrix_id + chụp
   * thang Đ–S hiệu lực vào quiz, rồi tạo slots: fixed rút câu ngay
   * (không lặp trong toàn đề), per_student chỉ ghi ô nguồn để rút lúc
   * bắt đầu từng lượt. Ô truefalse sinh 4 slot/chùm cùng cluster_id,
   * mỗi slot mang điểm danh nghĩa = điểm chùm / 4. Tạo slots lỗi giữa
   * chừng thì xoá quiz bù như createQuiz vẫn làm với cm.
   */
  async generateQuizFromMatrix(actorId: string, matrixId: string, input: GenerateFromMatrixDto): Promise<QuizView> {
    const matrix = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    const cells = await this.repo.listMatrixCells(matrix.id);
    if (!cells.length) {
      throw new BadRequestException({ message: 'This matrix has no cells yet', code: 'quiz.matrix_empty' });
    }
    const { deficits, pools } = await this.matrixDeficits(actorId, cells);
    if (deficits.length) {
      // Chi tiết từng ô đi qua mảng message → ProblemDetailsFilter đưa
      // ra wire ở trường `errors` (filter không chuyển trường tự do).
      throw new UnprocessableEntityException({
        message: deficits.map((d) => `cell ${d.cellId} (outcome ${d.learningOutcomeId}, ${d.cognitiveLevel}/${d.qtype}): required ${d.required}, available ${d.available}, deficit ${d.deficit}`),
        code: 'quiz.matrix_insufficient_questions',
      });
    }
    const totalMinutes = cells.reduce((s, c) => s + (c.minutes ?? 0), 0);
    const timeLimitSeconds = input.timeLimitSeconds !== undefined && input.timeLimitSeconds !== null
      ? input.timeLimitSeconds
      : (totalMinutes > 0 ? totalMinutes * 60 : null);
    // Thang Đ–S hiệu lực của đề: thang riêng đầu tiên có đặt trong các
    // ô (mọi chùm trong đề dùng chung một thang — mục C.4).
    const cellScale = cells.find((c) => c.tfScale !== null)?.tfScale ?? null;
    const created = await this.createQuiz(actorId, input.courseId, {
      sectionId: input.sectionId, name: input.name,
      timeLimitSeconds, grade: matrix.totalScore, tfScale: cellScale,
    });
    const quiz = await this.getQuiz(created.id);
    try {
      await this.repo.updateQuiz(quiz.id, { matrixId: matrix.id });
      const chosen = new Set<string>();
      let slotNo = 0;
      let page = 0;
      for (const cell of cells) {
        page += 1;
        const pool = pools.get(cell.id)!;
        const perUnit = cell.cellScore / cell.questionCount;
        if (cell.qtype === 'truefalse') {
          const pickedClusters = input.drawMode === 'fixed' ? this.shuffled(pool.clusters).slice(0, cell.questionCount) : [];
          for (let u = 0; u < cell.questionCount; u++) {
            const clusterId = randomUUID();
            const members = input.drawMode === 'fixed' ? pickedClusters[u]! : [];
            for (let k = 0; k < 4; k++) {
              const member = members[k];
              await this.repo.insertSlot({
                quizId: quiz.id, slot: ++slotNo, page,
                questionId: member ? member.question.id : null,
                categoryId: null,
                matrixCellId: cell.id,
                clusterId, maxMark: perUnit / 4,
              });
              if (member) chosen.add(member.question.id);
            }
          }
        } else {
          let picked: QuestionView[] = [];
          if (input.drawMode === 'fixed') {
            const fresh = this.shuffled(pool.candidates.filter((v) => !chosen.has(v.question.id)));
            picked = fresh.slice(0, cell.questionCount);
            if (picked.length < cell.questionCount) {
              // Pool giao nhau giữa các ô: phần còn thiếu rút nốt từ pool
              // của chính ô (chỉ tránh trùng trong nội bộ ô).
              const rest = this.shuffled(pool.candidates.filter((v) => !picked.some((p) => p.question.id === v.question.id)));
              picked = [...picked, ...rest.slice(0, cell.questionCount - picked.length)];
            }
          }
          for (let u = 0; u < cell.questionCount; u++) {
            const member = picked[u];
            await this.repo.insertSlot({
              quizId: quiz.id, slot: ++slotNo, page,
              questionId: member ? member.question.id : null,
              categoryId: null, matrixCellId: cell.id,
              clusterId: null, maxMark: perUnit,
            });
            if (member) chosen.add(member.question.id);
          }
        }
      }
    } catch (err) {
      await this.deleteQuiz(actorId, quiz.id).catch(() => undefined);
      throw err;
    }
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'quiz_generated_from_matrix',
      payload: { quizId: quiz.id, courseId: quiz.course, matrixId: matrix.id, drawMode: input.drawMode, actorId },
    });
    return this.quizView(await this.getQuiz(quiz.id));
  }

  /** Đề đã có lượt làm thật thì cấu trúc slots đóng băng (đúng ngữ nghĩa Chặng 1: attempt đã pin câu). */
  private async assertNoRealAttempts(quiz: QuizRow): Promise<void> {
    const attempts = await this.repo.listAttempts(quiz.id);
    if (attempts.some((a) => !a.preview)) {
      throw new BadRequestException({ message: 'This quiz already has real attempts; its slots are frozen', code: 'quiz.slots_frozen' });
    }
  }

  /**
   * Đổi câu/ô của một slot sinh từ ma trận (quiz:manage; chỉ khi chưa
   * có lượt thật): slot cố định đổi sang một ứng viên KHÁC CÙNG Ô và
   * không trùng câu trong đề; slot per_student đổi ô nguồn (ô đích
   * phải cùng ma trận; slot thuộc chùm thì đổi cả 4 slot của chùm và ô
   * đích phải là ô truefalse). Slot thuộc chùm không đổi lẻ từng câu.
   */
  async swapSlot(actorId: string, quizId: string, slotId: string, input: SwapQuizSlotDto): Promise<QuizView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    const slot = await this.repo.getSlot(slotId);
    if (!slot || slot.quizId !== quiz.id) throw new NotFoundException({ message: `Quiz slot ${slotId} not found`, code: 'quiz.slot_not_found' });
    await this.assertNoRealAttempts(quiz);
    if (slot.clusterId && slot.questionId) {
      throw new BadRequestException({ message: 'A cluster member cannot be swapped on its own; regenerate the quiz or uncluster first', code: 'quiz.slot_cluster_swap' });
    }
    if (slot.questionId) {
      if (!input.questionId) {
        throw new BadRequestException({ message: 'questionId is required to swap a fixed slot', code: 'quiz.swap_question_required' });
      }
      if (slot.matrixCellId) {
        const cell = await this.repo.getMatrixCell(slot.matrixCellId);
        if (!cell) throw new NotFoundException({ message: `Matrix cell ${slot.matrixCellId} not found`, code: 'quiz.matrix_cell_not_found' });
        const candidates = await this.cellCandidates(cell);
        if (!candidates.some((v) => v.question.id === input.questionId)) {
          throw new BadRequestException({ message: 'The candidate question is not in the pool of this slot\'s matrix cell', code: 'quiz.swap_candidate_out_of_cell' });
        }
      } else {
        await this.questions.getQuestion(input.questionId);
      }
      const slots = await this.repo.listSlots(quiz.id);
      if (slots.some((s) => s.id !== slot.id && s.questionId === input.questionId)) {
        throw new BadRequestException({ message: 'The candidate question is already in this quiz', code: 'quiz.swap_candidate_duplicate' });
      }
      await this.repo.updateSlot(slot.id, { questionId: input.questionId });
    } else if (slot.matrixCellId) {
      if (!input.matrixCellId) {
        throw new BadRequestException({ message: 'matrixCellId is required to swap the source cell of a per-student slot', code: 'quiz.swap_cell_required' });
      }
      const target = await this.repo.getMatrixCell(input.matrixCellId);
      if (!target || !quiz.matrixId || target.matrixId !== quiz.matrixId) {
        throw new BadRequestException({ message: 'The target cell does not belong to the matrix of this quiz', code: 'quiz.swap_cell_mismatch' });
      }
      const slots = await this.repo.listSlots(quiz.id);
      const targets = slot.clusterId ? slots.filter((s) => s.clusterId === slot.clusterId) : [slot];
      if (slot.clusterId && target.qtype !== 'truefalse') {
        throw new BadRequestException({ message: 'A cluster slot can only move to a truefalse cell', code: 'quiz.swap_cell_mismatch' });
      }
      const perUnit = target.cellScore / target.questionCount;
      for (const s of targets) {
        await this.repo.updateSlot(s.id, { matrixCellId: target.id, maxMark: slot.clusterId ? perUnit / 4 : perUnit });
      }
    } else {
      throw new BadRequestException({ message: 'Only matrix-generated slots can be swapped', code: 'quiz.swap_not_supported' });
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_slot_swapped', payload: { quizId: quiz.id, courseId: quiz.course, slotId, actorId } });
    return this.quizView(quiz);
  }

  /**
   * Rút lại các slot do ma trận sinh (quiz:manage; chỉ khi chưa có
   * lượt thật): slot cố định rút câu mới từ pool của ô (theo quyền của
   * người gọi), slot thuộc chùm rút lại cả chùm; slot per_student giữ
   * nguyên ô nguồn nên không đổi.
   */
  async regenerateQuiz(actorId: string, quizId: string): Promise<QuizView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    if (!quiz.matrixId) {
      throw new BadRequestException({ message: 'This quiz was not generated from a matrix', code: 'quiz.regenerate_not_from_matrix' });
    }
    await this.assertNoRealAttempts(quiz);
    const slots = await this.repo.listSlots(quiz.id);
    const fixed = slots.filter((s) => s.matrixCellId && s.questionId);
    const cellIds = [...new Set(fixed.map((s) => s.matrixCellId!))];
    const cells: ExamMatrixCellRow[] = [];
    for (const id of cellIds) {
      const cell = await this.repo.getMatrixCell(id);
      if (cell) cells.push(cell);
    }
    const { deficits, pools } = await this.matrixDeficits(actorId, cells);
    if (deficits.length) {
      throw new UnprocessableEntityException({
        message: deficits.map((d) => `cell ${d.cellId} (outcome ${d.learningOutcomeId}, ${d.cognitiveLevel}/${d.qtype}): required ${d.required}, available ${d.available}, deficit ${d.deficit}`),
        code: 'quiz.matrix_insufficient_questions',
      });
    }
    const chosen = new Set<string>();
    // Slot không do ma trận sinh (dựng tay thêm vào) giữ nguyên câu —
    // các câu đó cũng bị loại khỏi pool rút lại để không trùng.
    for (const s of slots) if (!s.matrixCellId && s.questionId) chosen.add(s.questionId);
    const clusterGroups = new Map<string, QuizSlotRow[]>();
    for (const s of fixed) {
      if (!s.clusterId) continue;
      const list = clusterGroups.get(s.clusterId) ?? [];
      list.push(s);
      clusterGroups.set(s.clusterId, list);
    }
    const clusteredSlotIds = new Set([...clusterGroups.values()].flatMap((g) => g.map((s) => s.id)));
    for (const group of clusterGroups.values()) {
      const pool = pools.get(group[0]!.matrixCellId!)!;
      const picked = this.shuffled(pool.clusters)[0]!;
      const ordered = [...group].sort((a, b) => a.slot - b.slot);
      for (let i = 0; i < ordered.length; i++) {
        await this.repo.updateSlot(ordered[i]!.id, { questionId: picked[i]!.question.id });
        chosen.add(picked[i]!.question.id);
      }
    }
    for (const s of fixed) {
      if (clusteredSlotIds.has(s.id)) continue;
      const pool = pools.get(s.matrixCellId!)!;
      const fresh = pool.candidates.filter((v) => !chosen.has(v.question.id));
      const candidates = fresh.length ? fresh : pool.candidates;
      const picked = candidates[Math.floor(Math.random() * candidates.length)]!;
      await this.repo.updateSlot(s.id, { questionId: picked.question.id });
      chosen.add(picked.question.id);
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_regenerated', payload: { quizId: quiz.id, courseId: quiz.course, matrixId: quiz.matrixId, actorId } });
    return this.quizView(quiz);
  }

  /**
   * Gom 4 slot truefalse cùng một stimulus thành một chùm Đ–S cho đề
   * dựng tay (quiz:manage; chỉ khi chưa có lượt thật). Điểm của chùm
   * tính theo thang của quiz ở tầng tổng hợp, các slot giữ max_mark
   * danh nghĩa như cũ (tổng max của chùm không đổi).
   */
  async clusterSlots(actorId: string, quizId: string, input: { slotIds: string[] }): Promise<QuizView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    await this.assertNoRealAttempts(quiz);
    if (input.slotIds.length !== 4 || new Set(input.slotIds).size !== 4) {
      throw new BadRequestException({ message: 'A true/false cluster needs exactly 4 distinct slots', code: 'quiz.cluster_size' });
    }
    const slots = await this.repo.listSlots(quiz.id);
    const picked = input.slotIds.map((id) => slots.find((s) => s.id === id));
    if (picked.some((s) => !s)) {
      throw new NotFoundException({ message: 'One of the slots does not belong to this quiz', code: 'quiz.slot_not_found' });
    }
    if (picked.some((s) => s!.clusterId)) {
      throw new BadRequestException({ message: 'One of the slots is already in a cluster; uncluster it first', code: 'quiz.cluster_exists' });
    }
    if (picked.some((s) => !s!.questionId)) {
      throw new BadRequestException({ message: 'Only fixed true/false question slots can be clustered', code: 'quiz.cluster_not_fixed' });
    }
    let stimulusId: string | null = null;
    for (const s of picked) {
      const view = await this.questions.getQuestion(s!.questionId!);
      if (view.question.qtype !== 'truefalse' || !view.stimulus) {
        throw new BadRequestException({ message: 'Cluster members must be true/false questions sharing one stimulus', code: 'quiz.cluster_not_truefalse_cluster' });
      }
      if (stimulusId === null) stimulusId = view.stimulus.id;
      else if (view.stimulus.id !== stimulusId) {
        throw new BadRequestException({ message: 'Cluster members must share the same stimulus', code: 'quiz.cluster_stimulus_mismatch' });
      }
    }
    const clusterId = randomUUID();
    for (const s of picked) await this.repo.updateSlot(s!.id, { clusterId });
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_slots_clustered', payload: { quizId: quiz.id, courseId: quiz.course, clusterId, actorId } });
    return this.quizView(quiz);
  }

  /** Gỡ chùm khỏi các slot (quiz:manage; chỉ khi chưa có lượt thật) — điểm quay về cộng tuyến tính. */
  async unclusterSlots(actorId: string, quizId: string, input: { slotIds: string[] }): Promise<QuizView> {
    const quiz = await this.getQuiz(quizId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    await this.assertNoRealAttempts(quiz);
    const slots = await this.repo.listSlots(quiz.id);
    for (const id of input.slotIds) {
      const slot = slots.find((s) => s.id === id);
      if (!slot) throw new NotFoundException({ message: `Quiz slot ${id} not found`, code: 'quiz.slot_not_found' });
      if (slot.clusterId) await this.repo.updateSlot(slot.id, { clusterId: null });
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_slots_unclustered', payload: { quizId: quiz.id, courseId: quiz.course, actorId } });
    return this.quizView(quiz);
  }

  // --- bản đặc tả (Chặng 3, mục C.6) ------------------------------------------------

  /**
   * Dựng view model bản đặc tả theo Mẫu 2 của phụ lục CV 7991: hàng
   * Chủ đề → Nội dung/đơn vị kiến thức → YCCĐ (nguyên văn chương trình
   * `source_kind='program'` + bản tách mức của tổ chuyên môn khi YCCĐ
   * của ô là bản `derived`), cột số câu/điểm theo dạng × mức từ các ô;
   * khi đã sinh đề (quizId của đề sinh từ chính ma trận này) thì thêm
   * vị trí slot thật — đề per_student ghi rõ rút ngẫu nhiên theo ô.
   * Chân bảng: tổng theo dạng (điểm + %). Trường nhãn năng lực để dành
   * trong view model (competencyRefs) — chặng này chưa có cơ chế gắn
   * mã năng lực vào outcome nên luôn rỗng.
   */
  async getMatrixSpecification(actorId: string, matrixId: string, quizId?: string): Promise<MatrixSpecification> {
    const matrix = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.viewMatrix);
    const subject = await this.curriculum.getSubject(actorId, matrix.subjectId);
    const curriculum = await this.curriculum.getCurriculum(actorId, matrix.curriculumId);
    const cells = await this.repo.listMatrixCells(matrix.id);
    let quiz: QuizRow | null = null;
    let slots: QuizSlotRow[] = [];
    if (quizId) {
      quiz = await this.getQuiz(quizId);
      if (quiz.matrixId !== matrix.id) {
        throw new BadRequestException({ message: 'The quiz was not generated from this matrix', code: 'quiz.spec_quiz_mismatch' });
      }
      slots = await this.repo.listSlots(quiz.id);
    }
    const nodeCache = new Map<string, Awaited<ReturnType<CurriculumService['getNode']>>>();
    const getNode = async (id: string) => {
      let node = nodeCache.get(id);
      if (!node) {
        node = await this.curriculum.getNode(actorId, id);
        nodeCache.set(id, node);
      }
      return node;
    };
    interface OutcomeAcc {
      outcomeId: string; content: string; sourceKind: string; sourceRef: string | null;
      programContent: string | null; derivedContent: string | null;
      cells: MatrixSpecification['topics'][number]['nodes'][number]['outcomes'][number]['cells'];
    }
    const topicMap = new Map<string, { topicId: string | null; topicTitle: string; nodes: Map<string, { nodeId: string; nodeTitle: string; outcomes: Map<string, OutcomeAcc> }> }>();
    const byForm = new Map<string, { qtype: string; questionCount: number; score: number }>();
    let totalQuestions = 0;
    for (const cell of cells) {
      const outcome = await this.curriculum.getOutcome(actorId, cell.learningOutcomeId);
      const node = await getNode(outcome.nodeId);
      // Chủ đề = node tổ tiên có kind 'topic'; không có thì lấy node gốc cao nhất của chuỗi.
      let topic = node;
      let cursor = node;
      while (cursor.parentId) {
        const parent = await getNode(cursor.parentId);
        if (parent.kind === 'topic' && topic.kind !== 'topic') topic = parent;
        cursor = parent;
      }
      if (topic.kind !== 'topic') topic = cursor;
      const topicKey = topic.id;
      let topicAcc = topicMap.get(topicKey);
      if (!topicAcc) {
        topicAcc = { topicId: topic.id, topicTitle: topic.title, nodes: new Map() };
        topicMap.set(topicKey, topicAcc);
      }
      let nodeAcc = topicAcc.nodes.get(node.id);
      if (!nodeAcc) {
        nodeAcc = { nodeId: node.id, nodeTitle: node.title, outcomes: new Map() };
        topicAcc.nodes.set(node.id, nodeAcc);
      }
      let outcomeAcc = nodeAcc.outcomes.get(outcome.id);
      if (!outcomeAcc) {
        let programContent: string | null = null;
        let derivedContent: string | null = null;
        if (outcome.sourceKind === 'derived' && outcome.derivedFromId) {
          const parent = await this.curriculum.getOutcome(actorId, outcome.derivedFromId).catch(() => undefined);
          programContent = parent?.content ?? null;
          derivedContent = outcome.content;
        } else {
          programContent = outcome.content;
        }
        outcomeAcc = {
          outcomeId: outcome.id, content: outcome.content, sourceKind: outcome.sourceKind,
          sourceRef: outcome.sourceRef, programContent, derivedContent, cells: [],
        };
        nodeAcc.outcomes.set(outcome.id, outcomeAcc);
      }
      const cellSlots = slots.filter((s) => s.matrixCellId === cell.id);
      const perStudent = cellSlots.length > 0 && cellSlots.every((s) => s.questionId === null);
      outcomeAcc.cells.push({
        cellId: cell.id, cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype,
        questionCount: cell.questionCount, cellScore: cell.cellScore, minutes: cell.minutes,
        slotNumbers: quiz ? cellSlots.map((s) => s.slot).sort((a, b) => a - b) : null,
        drawNote: quiz && perStudent ? 'Rút ngẫu nhiên theo ô' : null,
        competencyRefs: [],
      });
      const formAcc = byForm.get(cell.qtype) ?? { qtype: cell.qtype, questionCount: 0, score: 0 };
      formAcc.questionCount += cell.qtype === 'truefalse' ? cell.questionCount * 4 : cell.questionCount;
      formAcc.score += cell.cellScore;
      byForm.set(cell.qtype, formAcc);
      totalQuestions += cell.qtype === 'truefalse' ? cell.questionCount * 4 : cell.questionCount;
    }
    const totalScore = cells.reduce((s, c) => s + c.cellScore, 0);
    const formTotals = [...byForm.values()].map((f) => ({
      ...f, percent: totalScore > 0 ? Math.round((f.score / totalScore) * 1000) / 10 : 0,
    }));
    const purpose = matrix.presetKind === 'qd764_graduation'
      ? `Đề thi tốt nghiệp THPT môn ${subject.name} (lớp ${curriculum.grade}) xây dựng theo cấu trúc định dạng đề thi của Quyết định 764/QĐ-BGDĐT, bám sát yêu cầu cần đạt của Chương trình GDPT 2018.`
      : matrix.presetKind === 'cv7991_periodic'
        ? `Đề kiểm tra định kỳ môn ${subject.name} (lớp ${curriculum.grade}) xây dựng theo hướng dẫn của Công văn 7991/BGDĐT-GDTrH, bám sát yêu cầu cần đạt của Chương trình GDPT 2018.`
        : `Đề kiểm tra môn ${subject.name} (lớp ${curriculum.grade}) do tổ chuyên môn xây dựng theo ma trận riêng, bám sát yêu cầu cần đạt của Chương trình GDPT 2018.`;
    return {
      matrix: { id: matrix.id, name: matrix.name, presetKind: matrix.presetKind, totalScore: matrix.totalScore, levelSet: matrix.levelSet },
      subject: { id: subject.id, name: subject.name },
      curriculum: { id: curriculum.id, grade: curriculum.grade },
      purpose,
      structure: formTotals,
      topics: [...topicMap.values()].map((t) => ({
        topicId: t.topicId, topicTitle: t.topicTitle,
        nodes: [...t.nodes.values()].map((n) => ({
          nodeId: n.nodeId, nodeTitle: n.nodeTitle,
          outcomes: [...n.outcomes.values()],
        })),
      })),
      totals: { byForm: formTotals, totalScore, totalQuestions },
      quiz: quiz ? { id: quiz.id, name: quiz.name } : null,
    };
  }

  /**
   * Xuất bản đặc tả ra file (xlsx qua exceljs — cùng hạ tầng với xuất
   * điểm vnEdu; docx qua gói docx): cùng một view model, hai định dạng
   * nộp/lưu hồ sơ. Định dạng khác → 400 quiz.spec_export_format.
   */
  async exportMatrixSpecification(actorId: string, matrixId: string, format: string, quizId?: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    if (format !== 'xlsx' && format !== 'docx') {
      throw new BadRequestException({ message: 'Specification export format must be xlsx or docx', code: 'quiz.spec_export_format' });
    }
    const spec = await this.getMatrixSpecification(actorId, matrixId, quizId);
    const flat = flattenSpecification(spec);
    if (format === 'xlsx') {
      const ExcelJS = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Bản đặc tả');
      ws.columns = [
        { width: 6 }, { width: 24 }, { width: 28 }, { width: 46 },
        { width: 12 }, { width: 14 }, { width: 9 }, { width: 9 }, { width: 16 },
      ];
      ws.mergeCells('A1:I1');
      ws.getCell('A1').value = `BẢN ĐẶC TẢ ĐỀ KIỂM TRA — ${spec.subject.name.toUpperCase()} LỚP ${spec.curriculum.grade}`;
      ws.getCell('A1').font = { bold: true, size: 14 };
      ws.mergeCells('A2:I2');
      ws.getCell('A2').value = `Ma trận: ${spec.matrix.name}`;
      ws.mergeCells('A3:I3');
      ws.getCell('A3').value = spec.purpose;
      ws.getCell('A3').alignment = { wrapText: true, vertical: 'top' };
      ws.addRow([]);
      const header = ws.addRow(['STT', 'Chủ đề', 'Nội dung / Đơn vị kiến thức', 'Yêu cầu cần đạt', 'Mức', 'Dạng câu hỏi', 'Số câu', 'Điểm', 'Số thứ tự câu trong đề']);
      header.font = { bold: true };
      for (const row of flat) {
        ws.addRow([
          row.index, row.topicTitle, row.nodeTitle, row.outcomeText, row.levelLabel,
          row.qtypeLabel, row.questionCount, row.cellScore, row.slotText,
        ]);
      }
      ws.addRow([]);
      ws.addRow(['', '', '', 'Tổng theo dạng câu hỏi', '', '', '', '', '']);
      for (const f of spec.totals.byForm) {
        ws.addRow(['', '', '', QTYPE_LABELS[f.qtype] ?? f.qtype, '', '', f.questionCount, f.score, `${f.percent}%`]);
      }
      ws.addRow(['', '', '', 'Tổng cộng', '', '', spec.totals.totalQuestions, spec.totals.totalScore, '']);
      const buffer = Buffer.from(await wb.xlsx.writeBuffer());
      return { filename: `ban-dac-ta-${spec.matrix.id.slice(0, 8)}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer };
    }
    const docx = await import('docx');
    const cellOf = (text: string) => new docx.TableCell({ children: [new docx.Paragraph(text)] });
    const table = new docx.Table({
      rows: [
        new docx.TableRow({
          children: ['STT', 'Chủ đề', 'Nội dung / Đơn vị kiến thức', 'Yêu cầu cần đạt', 'Mức', 'Dạng câu hỏi', 'Số câu', 'Điểm', 'Số thứ tự câu trong đề'].map(cellOf),
        }),
        ...flat.map((row) => new docx.TableRow({
          children: [
            String(row.index), row.topicTitle, row.nodeTitle, row.outcomeText, row.levelLabel,
            row.qtypeLabel, String(row.questionCount), String(row.cellScore), row.slotText,
          ].map(cellOf),
        })),
      ],
    });
    const doc = new docx.Document({
      sections: [{
        children: [
          new docx.Paragraph({ children: [new docx.TextRun({ text: `BẢN ĐẶC TẢ ĐỀ KIỂM TRA — ${spec.subject.name.toUpperCase()} LỚP ${spec.curriculum.grade}`, bold: true })] }),
          new docx.Paragraph(`Ma trận: ${spec.matrix.name}`),
          new docx.Paragraph(spec.purpose),
          table,
          new docx.Paragraph(`Tổng cộng: ${spec.totals.totalQuestions} câu — ${spec.totals.totalScore} điểm.`),
          ...spec.totals.byForm.map((f) => new docx.Paragraph(`${QTYPE_LABELS[f.qtype] ?? f.qtype}: ${f.questionCount} câu, ${f.score} điểm (${f.percent}%).`)),
        ],
      }],
    });
    const buffer = await docx.Packer.toBuffer(doc);
    return { filename: `ban-dac-ta-${spec.matrix.id.slice(0, 8)}.docx`, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer };
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

  /**
   * Bộ phân giải cài đặt hiệu lực (Chặng 2, mục B.3 của hồ sơ thiết kế —
   * đối chiếu cơ chế hợp nhất override của Moodle): hợp nhất THEO TỪNG
   * TRƯỜNG theo thứ tự override người dùng > override nhóm > cài đặt
   * của quiz. Nhiều override nhóm: lấy giá trị RỘNG NHẤT cho từng
   * trường — time_open sớm nhất, time_close muộn nhất, time_limit dài
   * nhất, attempts lớn nhất; một trường để null trong override nhóm
   * nghĩa là nhóm đó không giới hạn ở trường đó nên thắng (không giới
   * hạn là giá trị rộng nhất), 0 ở attempts cũng là không giới hạn.
   * Mật khẩu KHÔNG hợp nhất từng trường: override người dùng có mật
   * khẩu thì chỉ mật khẩu đó có hiệu lực; không thì TẬP mật khẩu của
   * các nhóm áp dụng (nhập đúng một trong các mật khẩu là được); không
   * nữa thì mật khẩu của quiz.
   */
  async resolveEffectiveSettings(quiz: QuizRow, userId: string): Promise<EffectiveQuizSettings> {
    const overrides = await this.repo.listOverrides(quiz.id);
    const userOverride = overrides.find((o) => o.userId === userId);
    let groupOverrides: QuizOverrideRow[] = [];
    if (overrides.some((o) => o.groupId !== null)) {
      const myGroupIds = new Set((await this.groups.groupsOfUser(quiz.course, userId)).map((g) => g.id));
      groupOverrides = overrides.filter((o) => o.groupId !== null && myGroupIds.has(o.groupId));
    }
    const hasGroups = groupOverrides.length > 0;
    // Giá trị hợp nhất của nhóm cho một trường ngày giờ: undefined = không có override nhóm nào;
    // null = có nhóm không giới hạn trường này (thắng); ngược lại lấy mốc rộng nhất.
    const mergeDate = (pick: (o: QuizOverrideRow) => Date | null, widest: 'min' | 'max'): Date | null | undefined => {
      if (!hasGroups) return undefined;
      if (groupOverrides.some((o) => pick(o) === null)) return null;
      const values = groupOverrides.map((o) => pick(o)!.getTime());
      return new Date(widest === 'min' ? Math.min(...values) : Math.max(...values));
    };
    const mergeLimit = (): number | null | undefined => {
      if (!hasGroups) return undefined;
      if (groupOverrides.some((o) => o.timeLimit === null)) return null;
      return Math.max(...groupOverrides.map((o) => o.timeLimit!));
    };
    const mergeAttempts = (): number | undefined => {
      if (!hasGroups) return undefined;
      if (groupOverrides.some((o) => o.attempts === null || o.attempts === 0)) return 0;
      return Math.max(...groupOverrides.map((o) => o.attempts!));
    };
    const pickField = <T>(userValue: T | null | undefined, groupValue: T | null | undefined, quizValue: T): T => {
      if (userValue !== undefined && userValue !== null) return userValue;
      if (groupValue !== undefined) return groupValue as T;
      return quizValue;
    };
    let passwordHashes: string[] = [];
    if (userOverride?.passwordHash) {
      passwordHashes = [userOverride.passwordHash];
    } else {
      const groupHashes = groupOverrides.map((o) => o.passwordHash).filter((h): h is string => h !== null);
      if (groupHashes.length) passwordHashes = groupHashes;
      else if (quiz.passwordHash) passwordHashes = [quiz.passwordHash];
    }
    return {
      timeOpen: pickField(userOverride?.timeOpen, mergeDate((o) => o.timeOpen, 'min'), quiz.timeOpen),
      timeClose: pickField(userOverride?.timeClose, mergeDate((o) => o.timeClose, 'max'), quiz.timeClose),
      timeLimit: pickField(userOverride?.timeLimit, mergeLimit(), quiz.timeLimit),
      attemptsAllowed: pickField(userOverride?.attempts, mergeAttempts(), quiz.attemptsAllowed),
      passwordHashes,
      passwordRequired: passwordHashes.length > 0,
      subnet: quiz.subnet,
    };
  }

  /**
   * Mốc sớm nhất người dùng được bắt đầu lượt mới theo độ trễ bắt buộc
   * (delay1/delay2 của quiz — KHÔNG nằm trong override như Moodle):
   * sau lượt chốt thứ nhất tính delay1 từ time_finish của lượt đó; từ
   * lượt thứ ba trở đi tính delay2 từ time_finish của lượt chốt gần
   * nhất. null = không bị trễ (chưa có lượt chốt hoặc quiz không đặt).
   */
  private nextAttemptNotBefore(quiz: QuizRow, finishedAttempts: QuizAttemptRow[]): Date | null {
    const finished = finishedAttempts
      .filter((a) => !a.preview && a.state !== 'inprogress' && a.timeFinish !== null)
      .sort((x, y) => x.timeFinish!.getTime() - y.timeFinish!.getTime());
    if (!finished.length) return null;
    const delaySeconds = finished.length === 1 ? quiz.delay1 : quiz.delay2;
    if (delaySeconds === null || delaySeconds === undefined) return null;
    return new Date(finished[finished.length - 1]!.timeFinish!.getTime() + delaySeconds * 1000);
  }

  /** Học sinh còn được bắt đầu lượt mới hay không, và vì sao không (mọi kiểm tra đều trên cài đặt HIỆU LỰC của chính học sinh). */
  private async attemptEligibility(quiz: QuizRow, userId: string, now: Date): Promise<{
    canAttempt: boolean; reason: string | null; inProgressAttemptId: string | null;
    nextAttemptAt: string | null; passwordRequired: boolean;
  }> {
    const mine = await this.repo.listAttemptsForUser(quiz.id, userId);
    const inProgress = mine.find((a) => a.state === 'inprogress');
    const effective = await this.resolveEffectiveSettings(quiz, userId);
    if (inProgress) return { canAttempt: true, reason: null, inProgressAttemptId: inProgress.id, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
    if (effective.timeOpen && now < effective.timeOpen) return { canAttempt: false, reason: 'not_yet_open', inProgressAttemptId: null, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
    if (effective.timeClose && now > effective.timeClose) return { canAttempt: false, reason: 'closed', inProgressAttemptId: null, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
    if (effective.attemptsAllowed > 0 && mine.length >= effective.attemptsAllowed) return { canAttempt: false, reason: 'no_more_attempts', inProgressAttemptId: null, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
    const notBefore = this.nextAttemptNotBefore(quiz, mine);
    if (notBefore && now < notBefore) return { canAttempt: false, reason: 'delay_not_elapsed', inProgressAttemptId: null, nextAttemptAt: notBefore.toISOString(), passwordRequired: effective.passwordRequired };
    const slots = await this.repo.listSlots(quiz.id);
    if (!slots.length) return { canAttempt: false, reason: 'no_questions', inProgressAttemptId: null, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
    return { canAttempt: true, reason: null, inProgressAttemptId: null, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
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
    /** Cài đặt thi hiệu lực của chính người xem sau hợp nhất override — client hiển thị cửa sổ/giới hạn/mật khẩu theo các giá trị này, không theo cài đặt gốc của quiz. */
    effective: {
      timeOpen: string | null; timeClose: string | null;
      timeLimitSeconds: number | null; attemptsAllowed: number;
      passwordRequired: boolean; nextAttemptAt: string | null;
    };
    permissions: { manage: boolean; manageOverrides: boolean; grade: boolean; viewReports: boolean; preview: boolean; attempt: boolean };
  }> {
    const quiz = await this.getQuiz(quizId);
    await this.requireAnyViewCap(actorId, quiz);
    const view = await this.quizView(quiz);
    const mine = await this.repo.listAttemptsForUser(quiz.id, actorId, true);
    const summaries: QuizAttemptSummary[] = [];
    for (const a of mine) summaries.push(await this.attemptSummary(quiz, a));
    const eligibility = await this.attemptEligibility(quiz, actorId, new Date());
    const effective = await this.resolveEffectiveSettings(quiz, actorId);
    const [manage, manageOverrides, grade, viewReports, preview, attempt] = await Promise.all([
      this.hasCap(actorId, quiz, QUIZ_CAPABILITIES.manage),
      this.hasCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides),
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
      effective: {
        timeOpen: effective.timeOpen?.toISOString() ?? null,
        timeClose: effective.timeClose?.toISOString() ?? null,
        timeLimitSeconds: effective.timeLimit,
        attemptsAllowed: effective.attemptsAllowed,
        passwordRequired: effective.passwordRequired,
        nextAttemptAt: eligibility.nextAttemptAt,
      },
      permissions: { manage, manageOverrides, grade, viewReports, preview, attempt },
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
  async startAttempt(actorId: string, quizId: string, opts: { preview?: boolean; password?: string; clientIp?: string } = {}): Promise<QuizAttemptView> {
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
      if (await this.isOverdue(quiz, inProgress)) return this.finalizeAttempt(quiz, inProgress, true);
      return this.buildAttemptView(quiz, inProgress, false);
    }

    const now = new Date();
    if (!preview) {
      // Mọi cổng đều xét trên cài đặt HIỆU LỰC của người này (override
      // đã hợp nhất) — preview của giáo viên bỏ qua tất cả.
      const effective = await this.resolveEffectiveSettings(quiz, actorId);
      if (effective.timeOpen && now < effective.timeOpen) {
        throw new ForbiddenException({ message: 'This quiz is not open yet', code: 'quiz.not_yet_open' });
      }
      if (effective.timeClose && now > effective.timeClose) {
        throw new ForbiddenException({ message: 'This quiz is closed', code: 'quiz.closed' });
      }
      const mine = existing.filter((a) => !a.preview);
      if (effective.attemptsAllowed > 0 && mine.length >= effective.attemptsAllowed) {
        throw new ForbiddenException({ message: 'No more attempts are allowed for this quiz', code: 'quiz.no_more_attempts' });
      }
      const notBefore = this.nextAttemptNotBefore(quiz, mine);
      if (notBefore && now < notBefore) {
        throw new ForbiddenException({ message: 'You must wait before starting another attempt', code: 'quiz.delay_not_elapsed' });
      }
      if (effective.passwordRequired) {
        if (opts.password === undefined || opts.password === '') {
          throw new ForbiddenException({ message: 'A password is required to start this quiz', code: 'quiz.password_required' });
        }
        let matched = false;
        for (const hash of effective.passwordHashes) {
          if (await this.passwords.verify(hash, opts.password)) { matched = true; break; }
        }
        if (!matched) {
          throw new ForbiddenException({ message: 'The quiz password is incorrect', code: 'quiz.password_incorrect' });
        }
      }
      this.assertSubnetAllowed(quiz, opts.clientIp);
    }
    const slots = await this.repo.listSlots(quiz.id);
    if (!slots.length) throw new BadRequestException({ message: 'This quiz has no questions yet', code: 'quiz.no_questions' });

    const chosen = new Set<string>();
    const resolvedSlots: { quizSlot: QuizSlotRow; questionId: string }[] = [];
    // Slot nguồn ô ma trận (per_student) rút câu từ pool của ô lúc bắt
    // đầu lượt; slot thuộc một chùm Đ–S rút CẢ CHÙM (4 câu cùng
    // stimulus) cho đủ 4 slot của chùm, không rút lẻ từng câu.
    const cellPoolCache = new Map<string, { cell: ExamMatrixCellRow; candidates: QuestionView[] }>();
    const poolForCell = async (cellId: string) => {
      let entry = cellPoolCache.get(cellId);
      if (!entry) {
        const cell = await this.repo.getMatrixCell(cellId);
        if (!cell) throw new BadRequestException({ message: `Matrix cell ${cellId} no longer exists`, code: 'quiz.matrix_cell_missing' });
        entry = { cell, candidates: await this.cellCandidates(cell) };
        cellPoolCache.set(cellId, entry);
      }
      return entry;
    };
    const clusterAssignment = new Map<string, string>();
    const usedStimuli = new Set<string>();
    const clusterGroups = new Map<string, QuizSlotRow[]>();
    for (const s of slots) {
      if (s.matrixCellId && s.clusterId && !s.questionId) {
        const list = clusterGroups.get(s.clusterId) ?? [];
        list.push(s);
        clusterGroups.set(s.clusterId, list);
      }
    }
    for (const group of clusterGroups.values()) {
      const { candidates } = await poolForCell(group[0]!.matrixCellId!);
      const clusters = this.tfClustersOf(candidates)
        .filter((c) => !usedStimuli.has(c[0]!.stimulus!.id));
      if (!clusters.length) {
        throw new UnprocessableEntityException({ message: 'The question bank no longer has a full true/false cluster for a matrix cell of this quiz', code: 'quiz.matrix_insufficient_questions' });
      }
      const picked = clusters[Math.floor(Math.random() * clusters.length)]!;
      usedStimuli.add(picked[0]!.stimulus!.id);
      group.sort((a, b) => a.slot - b.slot).forEach((s, i) => {
        clusterAssignment.set(s.id, picked[i]!.question.id);
      });
    }
    for (const s of slots) {
      let questionId = s.questionId;
      if (!questionId && clusterAssignment.has(s.id)) {
        questionId = clusterAssignment.get(s.id)!;
      }
      if (!questionId && s.matrixCellId) {
        const { candidates } = await poolForCell(s.matrixCellId);
        const fresh = candidates.filter((v) => !chosen.has(v.question.id));
        const pool = fresh.length ? fresh : candidates;
        if (!pool.length) {
          throw new UnprocessableEntityException({ message: 'The question bank no longer has questions for a matrix cell of this quiz', code: 'quiz.matrix_insufficient_questions' });
        }
        questionId = pool[Math.floor(Math.random() * pool.length)]!.question.id;
      }
      if (!questionId) {
        questionId = await this.pickRandomQuestion(s.categoryId!, chosen);
      }
      chosen.add(questionId);
      resolvedSlots.push({ quizSlot: s, questionId });
    }
    // Moodle dùng MỘT dãy số lượt cho mỗi (quiz, user) — preview chỉ là
    // cờ trên lượt, không phải dãy riêng: ràng buộc duy nhất của
    // quiz_attempts là (quiz_id, user_id, attempt_number) không phân
    // biệt preview, đánh số riêng theo cờ sẽ va chạm khi một người vừa
    // preview vừa làm thật.
    const attemptNumber = existing.length + 1;
    const usage = await this.questions.createUsage(actorId, {
      component: QUIZ_COMPONENT, instanceId: quiz.id, contextId: await this.cmContextId(quiz),
      slots: resolvedSlots.map((e) => ({
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

  /** Cổng subnet: quiz có đặt subnet thì IP khách thật phải khớp một mục trong danh sách (kiểm cả khi bắt đầu lượt và khi nộp từng đáp án). */
  private assertSubnetAllowed(quiz: QuizRow, clientIp: string | undefined): void {
    if (!quiz.subnet) return;
    if (!clientIp || !ipMatchesSubnetList(clientIp, quiz.subnet)) {
      throw new ForbiddenException({ message: 'Your network address is not allowed for this quiz', code: 'quiz.subnet_denied' });
    }
  }

  /**
   * Mốc quá hạn của một lượt (null khi không mốc nào áp dụng): mốc SỚM
   * NHẤT giữa hạn theo giới hạn thời lượng tính từ lúc bắt đầu và giờ
   * đóng của quiz. Chỉ xét giới hạn thời lượng là không đủ — một lượt
   * bắt đầu trước giờ đóng vẫn phải bị chốt khi quiz đã đóng, nếu không
   * học sinh cứ trả lời tiếp và được tính điểm sau timeClose. Cả hai
   * mốc đều là giá trị HIỆU LỰC của CHỦ LƯỢT (override áp cho người đó),
   * không phải giá trị gốc của quiz và không chụp tại lúc bắt đầu.
   */
  private async attemptDeadline(quiz: QuizRow, row: QuizAttemptRow): Promise<Date | null> {
    const effective = await this.resolveEffectiveSettings(quiz, row.userId);
    let deadline: number | null = null;
    if (effective.timeLimit) deadline = row.timeStart.getTime() + effective.timeLimit * 1000;
    if (effective.timeClose) {
      const close = effective.timeClose.getTime();
      deadline = deadline === null ? close : Math.min(deadline, close);
    }
    return deadline === null ? null : new Date(deadline);
  }
  private async isOverdue(quiz: QuizRow, row: QuizAttemptRow): Promise<boolean> {
    const deadline = await this.attemptDeadline(quiz, row);
    return deadline !== null && new Date() > deadline;
  }

  /**
   * Cửa sổ xem lại hiện tại của một lượt ĐÃ NỘP xét cho chủ lượt:
   * ngay sau nộp (2 phút từ time_finish) → sau đó khi đề (theo giờ đóng
   * HIỆU LỰC của chủ lượt) còn mở → sau khi đóng. Đề không có giờ đóng
   * thì không bao giờ sang cửa sổ sau-đóng (như Moodle).
   */
  private async reviewWindowBit(quiz: QuizRow, row: QuizAttemptRow, now: Date): Promise<number> {
    const finish = row.timeFinish?.getTime() ?? now.getTime();
    if (now.getTime() < finish + REVIEW_IMMEDIATELY_AFTER_MS) return REVIEW_WINDOW.immediatelyAfter;
    const effective = await this.resolveEffectiveSettings(quiz, row.userId);
    if (!effective.timeClose || now <= effective.timeClose) return REVIEW_WINDOW.laterWhileOpen;
    return REVIEW_WINDOW.afterClose;
  }

  /**
   * Dựng view đầy đủ của một lượt: từng câu lấy nội dung của version ĐÃ
   * PIN trong engine. Với CHỦ LƯỢT (không có quyền chấm/báo cáo), các
   * khía cạnh sau nộp (đúng/sai, điểm câu, đáp án đúng, nhận xét) chỉ lộ
   * khi bitmask review_* của quiz cho phép tại cửa sổ hiện tại — cổng
   * nằm ở tầng server, client không nhận được dữ liệu bị tắt. Người có
   * quiz:grade/viewreports/manage và lượt preview không bị giới hạn.
   */
  async buildAttemptView(quiz: QuizRow, row: QuizAttemptRow, closedDueToTimeLimit: boolean, viewerId?: string): Promise<QuizAttemptView> {
    const usage = await this.questions.getUsage(row.usageId);
    const slots = await this.repo.listSlots(quiz.id);
    const pageBySlot = new Map(slots.map((s) => [s.slot, s.page]));
    const submitted = row.state !== 'inprogress';
    const viewer = viewerId ?? row.userId;
    let privileged = row.preview || viewer !== row.userId;
    if (!privileged) {
      privileged = (await this.hasCap(viewer, quiz, QUIZ_CAPABILITIES.grade))
        || (await this.hasCap(viewer, quiz, QUIZ_CAPABILITIES.viewReports))
        || (await this.hasCap(viewer, quiz, QUIZ_CAPABILITIES.manage));
    }
    // Cổng review chỉ áp cho chủ lượt thường sau khi nộp; đang làm thì
    // các khía cạnh vốn đã ẩn theo trạng thái inprogress như trước.
    let windowBit = 0;
    let hideContent = false;
    if (submitted && !privileged) {
      windowBit = await this.reviewWindowBit(quiz, row, new Date());
      hideContent = (quiz.reviewAttempt & windowBit) === 0;
    }
    const showAspects = submitted && (privileged || !hideContent);
    const aspectOn = (mask: number): boolean => privileged ? submitted : (showAspects && (mask & windowBit) !== 0);
    const questions: QuizAttemptQuestionView[] = [];
    for (const a of usage.attempts) {
      if (hideContent && !privileged) break;
      const qv = await this.questions.getQuestion(a.questionId);
      let questionText = qv.latestVersion.questionText as RichTextDocument;
      let answers: { id: string; text: RichTextDocument }[] = qv.answers.map((x) => ({ id: x.id, text: x.answer as RichTextDocument }));
      let options = qv.options;
      let stimulus: QuizAttemptQuestionView['stimulus'] = qv.stimulus ? { id: qv.stimulus.id, content: qv.stimulus.content as RichTextDocument } : null;
      let feedbackByAnswerId = new Map(qv.answers.map((x) => [x.id, (x.feedback ?? null) as RichTextDocument | null]));
      let generalFeedback = (qv.latestVersion.generalFeedback ?? null) as RichTextDocument | null;
      if (a.questionVersionId) {
        const pinned = await this.questions.getVersionContent(a.questionId, a.questionVersionId);
        questionText = pinned.version.questionText as RichTextDocument;
        answers = pinned.answers.map((x) => ({ id: x.id, text: x.answer as RichTextDocument }));
        options = pinned.options;
        feedbackByAnswerId = new Map(pinned.answers.map((x) => [x.id, (x.feedback ?? null) as RichTextDocument | null]));
        generalFeedback = (pinned.version.generalFeedback ?? null) as RichTextDocument | null;
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
        fraction: submitted && aspectOn(quiz.reviewCorrectness) ? a.fraction : null,
        mark: (submitted && aspectOn(quiz.reviewMarks) && a.fraction !== null) ? a.fraction * a.maxMark : null,
        rightAnswer: aspectOn(quiz.reviewRightAnswer) ? a.rightAnswer : null,
        feedback: aspectOn(quiz.reviewSpecificFeedback) && lastResponse !== null
          ? (feedbackByAnswerId.get(lastResponse) ?? null)
          : null,
        generalFeedback: aspectOn(quiz.reviewGeneralFeedback) ? generalFeedback : null,
      });
    }
    const { pendingManual } = this.syncFromUsage(usage, quiz, slots);
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
    if (row.state === 'inprogress' && row.userId === actorId && await this.isOverdue(quiz, row)) {
      return this.finalizeAttempt(quiz, await this.getAttemptRow(attemptId), true);
    }
    return this.buildAttemptView(quiz, row, false, actorId);
  }

  /**
   * Lưu câu trả lời của một câu trong lượt đang làm (ủy quyền engine ghi
   * step). Quá hạn làm bài: lượt bị chốt phía server ngay tại tương tác
   * này và view đã nộp được trả về thay vì ghi thêm đáp án.
   */
  async submitResponse(actorId: string, attemptId: string, input: { questionAttemptId: string; response?: string | null }, clientIp?: string): Promise<QuizAttemptView> {
    const row = await this.getAttemptRow(attemptId);
    const quiz = await this.getQuiz(row.quizId);
    if (row.userId !== actorId) {
      throw new ForbiddenException({ message: 'Only the attempt owner can answer', code: 'quiz.attempt_forbidden' });
    }
    if (row.state !== 'inprogress') {
      throw new BadRequestException({ message: 'This attempt is already submitted', code: 'quiz.attempt_already_submitted' });
    }
    // Lượt preview của giáo viên không chịu subnet (như mọi cổng khác).
    if (!row.preview) this.assertSubnetAllowed(quiz, clientIp);
    if (await this.isOverdue(quiz, row)) {
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
    const { sumGrades, pendingManual } = this.syncFromUsage(finishedUsage, quiz, await this.repo.listSlots(quiz.id));
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
    return this.finalizeAttempt(quiz, row, await this.isOverdue(quiz, row));
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
    const { sumGrades, pendingManual } = this.syncFromUsage(after, quiz, await this.repo.listSlots(quiz.id));
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
    return this.buildAttemptView(quiz, updated, false, actorId);
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
