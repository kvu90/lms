import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { QuizAttemptSummary, QuizView } from '@lms/contracts';
import { TenantContextService } from '../tenants/tenant-context.service';
import { TenantsService } from '../tenants/tenants.service';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import {
  QuestionsService,
  type QuestionView,
  type UsageView,
} from '../questions/questions.service';
import {
  QuizRepository,
  type ExamMatrixCellRow,
  type ExamMatrixRow,
  type ExamAttemptRow,
  type ExamPinRow,
} from './quiz.repository';
import type { PinRow, EffectiveSlotRow } from './quiz.service';

export const QUIZ_COMPONENT = 'mod_quiz';

export const QUIZ_CAPABILITIES = {
  view: 'quiz:view',
  attempt: 'quiz:attempt',
  manage: 'quiz:manage',
  manageOverrides: 'quiz:manageoverrides',
  /**
   * Quyền ma trận đã về area `matrix:*` ở đợt đồng bộ khuôn ngân
   * hàng (issue #228, lát S3) — KHÔNG còn neo vào quiz:*: viewMatrix
   * = matrix:use (xem/dùng), addMatrix = matrix:add (tạo mới: tạo
   * tay, nhập file, copy vào bank đích), manageMatrix = matrix:edit
   * (sửa ma trận và các ô đã có). Khoá nội bộ giữ nguyên tên để các
   * điểm gác không đổi hình dạng.
   */
  viewMatrix: 'matrix:use',
  addMatrix: 'matrix:add',
  manageMatrix: 'matrix:edit',
  grade: 'quiz:grade',
  gradePaper: 'quiz:gradepaper',
  viewReports: 'quiz:viewreports',
  preview: 'quiz:preview',
} as const;

/**
 * Tầng thấp dùng chung của QuizService (không phải một cụm ca sử dụng):
 * các primitive tải pin/ma trận, cổng quyền theo context, view pin, và
 * các phép tính điểm/chấm từ usage mà nhiều cụm cùng dùng. Tách riêng
 * tầng này giữ đồ thị phụ thuộc giữa các service cụm không có vòng:
 * cụm ghim, cụm ma trận, cụm sinh đề và cụm lượt làm đều chỉ trỏ xuống
 * tầng này (cụm lượt làm là trung gian cho hai phép gọi chéo còn lại:
 * cụm ghim gọi chấm lại qua `pushGrade`, cụm sinh đề gọi chốt lượt
 * qua `finalizeAttempt`).
 *
 * Các method vốn là `private` của QuizService cũ nhưng được cụm khác
 * gọi nay để public trong nội bộ module (không phải bề mặt API của
 * module): toàn bộ method của service này đều thuộc diện đó, trừ các
 * method vốn đã public. Bề mặt công khai ra ngoài module không đổi —
 * vẫn đi qua facade QuizService.
 *
 * Hai hằng `QUIZ_COMPONENT`/`QUIZ_CAPABILITIES` chuyển về đây cùng
 * với nhóm cổng quyền (nơi dùng thật), facade re-export lại để bề mặt
 * import cũ không đổi.
 */

export class QuizSharedService {
  constructor(
    private readonly repo: QuizRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly questions: QuestionsService,
    private readonly banks: QuestionBanksService,
    private readonly tenantContext: TenantContextService,
    private readonly tenants: TenantsService,
  ) {}

  /** Tenant cho ma trận không gắn bank: tenant hiệu lực của request; ngoài request rơi về tenant-zero. */
  public async matrixTenantId(): Promise<string> {
    return this.tenantContext.currentTenantId() ?? (await this.tenants.fallbackTenantId());
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * Lấy pin đã LÀM GIÀU; ném exam.pin_not_found khi vắng. Hàng
   * exam_pins được gộp với các trường suy từ exam version đã ghim
   * (thang điểm, tên hiển thị, ma trận, thang Đ–S) và exam (kind)
   * thành một "bài kiểm tra trong khoá" thống nhất cho các tầng trên.
   */
  async getPin(id: string): Promise<PinRow> {
    const row = await this.repo.getPin(id);
    if (!row) throw new NotFoundException({ message: `Exam pin ${id} not found`, code: 'exam.pin_not_found' });
    return this.enrichPin(row);
  }

  /** Hàng pin thô (chưa làm giàu) cho các seam cần đúng bản ghi đã ghim (vd in đề theo pin). */
  async getPinRow(id: string): Promise<ExamPinRow | undefined> {
    return this.repo.getPin(id);
  }

  public async enrichPin(row: ExamPinRow): Promise<PinRow> {
    const version = await this.repo.getExamVersion(row.examVersionId);
    if (!version) throw new NotFoundException({ message: `Exam version ${row.examVersionId} not found`, code: 'exam.version_not_found' });
    const exam = await this.repo.getExam(row.examId);
    if (!exam) throw new NotFoundException({ message: `Exam ${row.examId} not found`, code: 'exam.not_found' });
    return {
      ...row,
      course: row.courseId,
      grade: version.totalScore,
      tfScale: version.tfScale,
      matrixId: version.matrixId,
      name: row.name ?? version.name,
      examVersionNumber: version.version,
      examStatus: exam.status,
      examLatestVersion: exam.latestVersion,
    };
  }

  /**
   * Slots HIỆU LỰC của một pin — không còn bảng slots riêng của bài:
   * - Đề snapshot: đọc thẳng exam_slots của version đã ghim (page suy
   *   từ thứ tự xuất hiện của section, như lúc triển khai trước đây).
   */
  async effectiveSlots(pin: PinRow): Promise<EffectiveSlotRow[]> {
    const slots = await this.repo.listExamSlots(pin.examVersionId);
    const pageBySection = new Map<string, number>();
    return slots.map((sl) => {
      if (!pageBySection.has(sl.section)) pageBySection.set(sl.section, pageBySection.size + 1);
      return {
        id: sl.id, pinId: pin.id, slot: sl.position, page: pageBySection.get(sl.section)!,
        questionId: sl.questionId, categoryId: null, maxMark: sl.maxMark,
        matrixCellId: sl.matrixCellId,
        versionMode: 'pinned' as const,
        pinnedVersionId: sl.pinnedVersionId, pinnedVersionNumber: sl.pinnedVersionNumber,
      };
    });
  }

  public async getAttemptRow(id: string): Promise<ExamAttemptRow> {
    const row = await this.repo.getAttempt(id);
    if (!row) throw new NotFoundException({ message: `Quiz attempt ${id} not found`, code: 'quiz.attempt_not_found' });
    return row;
  }

  /** Context của course module chứa quiz — mọi capability quiz:* kiểm tại đây. */
  public async cmContextId(quiz: PinRow): Promise<string> {
    if (quiz.cmId) {
      const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.MODULE, quiz.cmId);
      if (ctx) return ctx.id;
    }
    const courseCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, quiz.course);
    if (!courseCtx) throw new NotFoundException({ message: `No context for quiz ${quiz.id}`, code: 'quiz.context_missing' });
    return courseCtx.id;
  }

  public async requireCap(actorId: string, quiz: PinRow, capability: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, capability, await this.cmContextId(quiz));
  }

  public async hasCap(actorId: string, quiz: PinRow, capability: string): Promise<boolean> {
    return this.evaluator.hasCapability(actorId, capability, await this.cmContextId(quiz));
  }

  /**
   * View của quiz kèm slots và tổng điểm slot. Slot cố định mang thêm
   * thông tin bank nguồn + kỷ luật version (QB-3): chế độ ghim, version
   * đang ghim, version ready mới nhất và cờ có bản mới để UI hiển thị
   * "Câu thuộc Ngân hàng [tên] · đang ghim v[n] · đã có v[m]".
   */
  async pinView(quiz: PinRow): Promise<QuizView> {
    const slots = await this.effectiveSlots(quiz);
    const slotViews: QuizView['slots'] = [];
    for (const s of slots) {
      const base = {
        id: s.id, pinId: s.pinId, slot: s.slot, page: s.page,
        questionId: s.questionId, categoryId: s.categoryId, maxMark: s.maxMark,
        matrixCellId: s.matrixCellId,
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
      targetGroupId: quiz.targetGroupId,
      hasPassword: quiz.passwordHash !== null,
      subnet: quiz.subnet,
      reviewAttempt: quiz.reviewAttempt,
      reviewCorrectness: quiz.reviewCorrectness,
      reviewMarks: quiz.reviewMarks,
      reviewSpecificFeedback: quiz.reviewSpecificFeedback,
      reviewGeneralFeedback: quiz.reviewGeneralFeedback,
      reviewRightAnswer: quiz.reviewRightAnswer,
      reviewOverallFeedback: quiz.reviewOverallFeedback,
      matrixId: quiz.matrixId,
      examId: quiz.examId,
      examVersionId: quiz.examVersionId,
      examVersionNumber: quiz.examVersionNumber,
      latestExamVersionNumber: quiz.examLatestVersion,
      // Huy hiệu bản đề mới (issue #254): chỉ khi đề đang ready và bản
      // mới nhất mới hơn bản đang ghim thì mới có đích cập nhật.
      hasNewerExamVersion: quiz.examStatus === 'ready' && quiz.examLatestVersion > quiz.examVersionNumber,
      versionMode: quiz.versionMode === 'float_latest_ready' ? 'float_latest_ready' as const : 'pinned' as const,
      tfScale: quiz.tfScale,
      preset: (quiz.preset as QuizView['preset']) ?? null,
      lateEntryMinutes: quiz.lateEntryMinutes,
      monitorEvents: quiz.monitorEvents,
      slots: slotViews,
      sumGrades: slots.reduce((sum, s) => sum + s.maxMark, 0),
      variants: quiz.variants ?? [],
    };
  }

  /** Tổng maxMark của một usage (mẫu số điểm lượt — lấy từ question attempt đã pin, không phải slot hiện tại). */
  public usageTotalMax(usage: UsageView): number {
    return usage.attempts.reduce((sum, a) => sum + a.maxMark, 0);
  }

  /** Điểm một lượt đã quy về thang điểm của quiz (null khi chưa chốt hoặc đề rỗng). */
  public attemptGradeValue(quiz: PinRow, row: ExamAttemptRow, totalMax: number): number | null {
    if (row.sumGrades === null || totalMax <= 0) return null;
    return (row.sumGrades / totalMax) * quiz.grade;
  }

  public async attemptSummary(quiz: PinRow, row: ExamAttemptRow): Promise<QuizAttemptSummary> {
    let grade: number | null = null;
    if (row.sumGrades !== null) {
      const usage = await this.questions.getUsage(row.usageId);
      grade = this.attemptGradeValue(quiz, row, this.usageTotalMax(usage));
    }
    return {
      id: row.id, pinId: row.pinId, userId: row.userId, attemptNumber: row.attemptNumber,
      usageId: row.usageId, state: row.state, preview: row.preview,
      timeStart: row.timeStart.toISOString(), timeFinish: row.timeFinish?.toISOString() ?? null,
      sumGrades: row.sumGrades, grade,
      makeup: row.makeup,
      appliedSettings: row.appliedSettings ?? null,
    };
  }

  /**
   * Đồng bộ tổng điểm của một lượt từ usage của engine: tổng tuyến
   * tính các câu ĐÃ có fraction (mỗi câu đóng góp fraction × maxMark
   * của chính nó; essay chưa chấm đóng góp 0) + số câu còn chờ chấm
   * tay. Câu truefalse TF-A tự mang fraction đã tra thang Đ–S ở tầng
   * engine (thang của lần ghim truyền vào lúc chốt usage) nên KHÔNG
   * còn ngoại lệ chùm ở tầng tổng hợp này — mô hình chùm gom nhiều
   * slot đã bỏ hẳn theo điểm quyết D-1.
   */
  public syncFromUsage(usage: UsageView): { sumGrades: number; pendingManual: number } {
    let sum = 0;
    let pending = 0;
    for (const a of usage.attempts) {
      if (a.state === 'needsgrading') pending += 1;
      else if (a.fraction !== null && a.fraction !== undefined) sum += a.fraction * a.maxMark;
    }
    return { sumGrades: sum, pendingManual: pending };
  }

  public async getMatrixRow(id: string): Promise<ExamMatrixRow> {
    const row = await this.repo.getMatrix(id);
    if (!row) throw new NotFoundException({ message: `Exam matrix ${id} not found`, code: 'quiz.matrix_not_found' });
    return row;
  }

  /**
   * ĐIỂM NEO QUYỀN DUY NHẤT của ma trận (MB-0, điểm E-8 của hồ sơ ngân
   * hàng đề/ma trận): mọi kiểm tra quyền trên ma trận đều đi qua đây.
   * Nguồn quyền chốt là BANK — ma trận nằm trong bank nào thì quyền
   * theo bank đó; context môn (matrix.contextId) chỉ là PHẠM VI DỮ
   * LIỆU. MB-1 (issue #111) đã cắm bank, với hai lưu ý thực thi:
   * - Quyền tại bank đọc từ HAI VAI CHUYÊN DỤNG tại context bank
   *   (QuestionBanksService.bankLocalMatrixCaps: matrix:use ↔ thành
   *   viên + phụ trách; matrix:add và matrix:edit ↔ phụ trách),
   *   KHÔNG qua PermissionEvaluator — evaluator kế thừa mặc định
   *   archetype từ mọi context tổ tiên nên giáo viên có vai ở context
   *   hệ thống sẽ lọt cổng bank kín của tổ dù không phải thành viên.
   * - Ma trận chưa thuộc bank nào (hoặc bank đã bị xoá) giữ hành vi
   *   Chặng 3: PermissionEvaluator tại context môn.
   */
  public async requireMatrixCap(actorId: string, matrix: ExamMatrixRow, capability: string): Promise<void> {
    if (matrix.bankId) {
      const bank = await this.banks.findBankById(matrix.bankId);
      if (bank) {
        // Ma trận thuộc bank personal của người khác → 404 như ma trận
        // không tồn tại (issue #123), trước mọi cổng capability.
        if (await this.banks.isForeignPersonalBank(actorId, bank)) {
          throw new NotFoundException({ message: `Exam matrix ${matrix.id} not found`, code: 'quiz.matrix_not_found' });
        }
        await this.banks.syncBankMembership(bank);
        const caps = await this.banks.bankLocalMatrixCaps(actorId, bank);
        const ok = capability === QUIZ_CAPABILITIES.viewMatrix ? caps.view
          : capability === QUIZ_CAPABILITIES.addMatrix ? caps.add
          : caps.manage;
        if (!ok) {
          throw new ForbiddenException({ message: `Missing capability ${capability} in matrix bank ${bank.id}`, code: 'access.capability_denied' });
        }
        return;
      }
    }
    await this.evaluator.requireCapability(actorId, capability, matrix.contextId);
  }

  /**
   * Ứng viên thô của một ô: câu ready gắn BẤT KỲ YCCĐ nào thuộc ĐVK
   * của ô ở đúng mức của ô, đúng dạng (qua
   * question_learning_outcomes / Curriculum Chặng 2 — mức nằm trên
   * dòng nối câu × YCCĐ; issue #249). Chưa xét quyền dùng ngân hàng
   * của người gọi.
   */
  public async cellCandidates(cell: Pick<ExamMatrixCellRow, 'curriculumNodeId' | 'cognitiveLevel' | 'qtype'>): Promise<QuestionView[]> {
    return this.questions.listQuestionsByCurriculumFilter({
      nodeId: cell.curriculumNodeId, cognitiveLevel: cell.cognitiveLevel,
      qtype: cell.qtype, status: 'ready',
    });
  }

  /**
   * Ứng viên một NGƯỜI DÙNG được dùng: ứng viên thô lọc theo quyền
   * question:useall tại context của category chứa câu (cùng quy tắc
   * quyền ngân hàng hiện hành).
   */
  public async cellCandidatesForUser(actorId: string, cell: Pick<ExamMatrixCellRow, 'curriculumNodeId' | 'cognitiveLevel' | 'qtype'>): Promise<QuestionView[]> {
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
   * Số câu khả dụng của một ô cho một người dùng: mọi qtype đều đếm
   * theo CÂU — câu truefalse TF-A tự nó đã là một chùm 4 ý hoàn chỉnh
   * trong một câu, không còn phép gom chùm từ 4 câu rời theo ngữ liệu
   * như mô hình cũ.
   */

  /**
   * Mở cổng xem quiz: người xem cần một trong các capability của hoạt
   * động tại context của module (học sinh: view/attempt; giáo viên:
   * manage/grade/viewreports/preview).
   */
  public async requireAnyViewCap(actorId: string, quiz: PinRow): Promise<void> {
    const ctx = await this.cmContextId(quiz);
    for (const cap of [QUIZ_CAPABILITIES.view, QUIZ_CAPABILITIES.attempt, QUIZ_CAPABILITIES.manage, QUIZ_CAPABILITIES.grade, QUIZ_CAPABILITIES.viewReports, QUIZ_CAPABILITIES.preview]) {
      if (await this.evaluator.hasCapability(actorId, cap, ctx)) return;
    }
    await this.evaluator.requireCapability(actorId, QUIZ_CAPABILITIES.view, ctx);
  }

  /** Quyền xem một lượt: chủ lượt, hoặc người có quiz:grade/viewreports tại module. */
  public async requireAttemptReadable(actorId: string, quiz: PinRow, row: ExamAttemptRow): Promise<void> {
    if (row.userId === actorId) return;
    const ctx = await this.cmContextId(quiz);
    for (const cap of [QUIZ_CAPABILITIES.grade, QUIZ_CAPABILITIES.viewReports, QUIZ_CAPABILITIES.manage]) {
      if (await this.evaluator.hasCapability(actorId, cap, ctx)) return;
    }
    throw new ForbiddenException({ message: 'This attempt belongs to another user', code: 'quiz.attempt_forbidden' });
  }
}
