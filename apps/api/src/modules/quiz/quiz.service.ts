import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { ExamMatrixCellView, ExamMatrixView, MatrixCellAvailability, MatrixImportCellAvailability, PaperSlotLayout, PinRegradeLogEntry, PinRegradeResult, PinVersionUpdatePreview, PinVersionUpdateSlotDiff, QuestionSolution, QuizAttemptSummary, ExamPinOverrideView, QuizView, RichTextDocument } from '@lms/contracts';
import { extractRichTextPlainText, getTrueFalseStatements, TRUE_FALSE_STATEMENT_COUNT } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import { TenantsService } from '../tenants/tenants.service';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { CurriculumService } from '../curriculum/curriculum.service';
import { FilesService } from '../files/files.service';
import { GradesService } from '../grades/grades.service';
import { GroupsService } from '../groups/groups.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import { QuestionsService, type QuestionView, type UsageView } from '../questions/questions.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import type { CreateExamMatrixCellDto, CreateExamMatrixDto, CreateExamPinOverrideDto, UpdateExamMatrixCellDto, UpdateExamMatrixDto, UpdateExamPinOverrideDto } from './dto/quiz.dto';
import { effectiveTfScale, EXAM_KIND_PRESETS, isValidTfScale, MATRIX_PRESETS, matrixWarnings, tfScaleLabel, type ExamKind } from './domain/matrix';
import { ipMatchesSubnetList, isValidSubnetList } from './domain/subnet';
import { QuizRepository, type ExamMatrixCellRow, type ExamMatrixRow, type ExamAttemptEventRow, type ExamAttemptRow, type ExamPinFeedbackRow, type ExamPinOverrideRow, type ExamPinRow } from './quiz.repository';

export const QUIZ_COMPONENT = 'mod_quiz';
export const QUIZ_CAPABILITIES = {
  view: 'quiz:view',
  attempt: 'quiz:attempt',
  manage: 'quiz:manage',
  manageOverrides: 'quiz:manageoverrides',
  viewMatrix: 'quiz:viewmatrix',
  manageMatrix: 'quiz:managematrix',
  grade: 'quiz:grade',
  gradePaper: 'quiz:gradepaper',
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
      /** YCCĐ thuộc ĐVK của các ô (cột YCCĐ của bản đặc tả, Phụ lục 2 CV 7991) — ô ma trận neo ĐVK, KHÔNG neo YCCĐ (issue #249). Chỉ gồm dòng HIỆN HÀNH: dòng program đã rút và derived có gốc đã rút đều bị loại (issue #161). */
      outcomes: {
        outcomeId: string;
        content: string;
        sourceKind: string;
        sourceRef: string | null;
        /** Nguyên văn YCCĐ chương trình (bản thân outcome khi là 'program', hoặc outcome gốc khi là 'derived'). */
        programContent: string | null;
        /** Bản tách mức của tổ chuyên môn khi YCCĐ là bản 'derived'. */
        derivedContent: string | null;
        /**
         * Vị trí của dòng trong bản ghi chương trình (đợt neo lại
         * định danh theo vị trí, issue #161): với derived là vị trí
         * của dòng GỐC; null khi dòng không mang vị trí chương trình.
         */
        position: number | null;
        /**
         * Mã YCCĐ vị trí `<recordId>.<position 2 số>` do BACKEND tính
         * từ sổ đăng ký + position (một nguồn sự thật cho vị trí —
         * web không tự suy); với derived là mã của dòng gốc; null khi
         * node không thuộc bản ghi dataset nào.
         */
        code: string | null;
      }[];
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
  totals: {
    byForm: { qtype: string; questionCount: number; score: number; percent: number }[];
    totalScore: number;
    totalQuestions: number;
  };
  quiz: { id: string; name: string } | null;
}

/** Một slot tối thiểu cho builder đặc tả: ô nguồn + vị trí + câu đã ghim (null = slot rút tại lượt làm, đề per_student). */
export interface SpecificationSlot {
  matrixCellId: string | null;
  slot: number;
  questionId: string | null;
}

/** Bung view model đặc tả thành các dòng phẳng cho bảng xuất file (một dòng = một ô ma trận; cột YCCĐ = mọi YCCĐ thuộc ĐVK của ô). */
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
      // Dòng văn của outcome program được tiền tố bằng mã YCCĐ vị
      // trí (P2, sổ mục B) khi có mã; derived trình bày nguyên văn
      // gốc (tiền tố mã của gốc) kèm bản tách mức như trước.
      const outcomeText = node.outcomes.map((outcome) => {
        const prefix = outcome.code ? `${outcome.code} ` : '';
        return outcome.derivedContent
          ? `${prefix}${outcome.programContent ?? ''}\n(Tách mức: ${outcome.derivedContent})`
          : `${prefix}${outcome.programContent ?? outcome.content}`;
      }).join('\n');
      for (const cell of node.cells) {
        index += 1;
        const slotText = cell.slotNumbers && cell.slotNumbers.length
          ? (cell.drawNote ? `${cell.drawNote} (vị trí ${cell.slotNumbers.join(', ')})` : cell.slotNumbers.join(', '))
          : (cell.drawNote ?? '');
        rows.push({
          index,
          topicTitle: topic.topicTitle,
          nodeTitle: node.nodeTitle,
          outcomeText,
          levelLabel: LEVEL_LABELS[cell.cognitiveLevel] ?? cell.cognitiveLevel,
          qtypeLabel: QTYPE_LABELS[cell.qtype] ?? cell.qtype,
          questionCount: cell.questionCount,
          cellScore: cell.cellScore,
          slotText,
        });
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
  /** Truy vết nguồn: id override người dùng đã áp (null = không có) và các override nhóm đã hợp nhất — ghi vào snapshot của attempt. */
  userOverrideId: string | null;
  groupOverrideIds: string[];
}

/** Một câu trong lượt làm như client nhận: nội dung của version ĐÃ PIN, không lộ fraction đáp án khi đang làm. */
export interface QuizAttemptQuestionView {
  slot: number;
  page: number;
  questionAttemptId: string;
  questionId: string;
  qtype: string;
  /** Trích đoạn nội dung thân câu (text thuần, cắt 120 ký tự) — câu hỏi không có trường tên (quyết 12:04 ngày 26/10/2026) nên bề mặt cần nhãn hiển thị dùng trích đoạn này. */
  questionExcerpt: string;
  questionText: RichTextDocument;
  /**
   * Hướng dẫn (guidance) của version đã pin — hiện KÈM câu hỏi ngay
   * trong lúc làm bài như khối "Hướng dẫn" của loigiaihay (điểm quyết
   * D-4): KHÔNG qua cổng xem lại; chỉ vắng khi version không có hướng
   * dẫn. Hướng dẫn ≠ lời giải: nó gợi ý cách làm, không chứa đáp án.
   */
  guidance: RichTextDocument | null;
  /**
   * Lời giải/đáp án đúng dạng cấu trúc của version đã pin, suy từ phía
   * đáp án: multichoice = `{correctAnswerId}` của dòng đáp án đúng;
   * truefalse TF-A = `{statements}` đáp án Đúng/Sai của TỪNG mệnh đề
   * (lưu ở bản ghi phía đáp án); shortanswer = `{acceptedAnswers}` các
   * đáp án được chấp nhận; essay = lời giải mẫu `{answer}` lưu ở bản
   * ghi phía đáp án. Chỉ lộ khi cổng `reviewRightAnswer` của lần ghim
   * cho phép tại cửa sổ hiện tại — cùng cổng với `rightAnswer` dạng
   * chữ. Đúng/sai TỪNG Ý của câu TF-A ở phía học sinh suy từ trường
   * này + response của chính học sinh + fraction của câu.
   */
  solution: QuestionSolution | null;
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
  /**
   * Nhận xét của giáo viên khi chấm tay câu này (step chấm tay của
   * engine mang data.comment — xem manualGradeAttempt). Nó là phản hồi
   * gắn với chính đáp án của học sinh nên đi cùng cổng
   * review_specific_feedback như feedback theo đáp án; null khi câu
   * chưa được chấm tay kèm nhận xét hoặc cửa sổ hiện tại không cho xem.
   */
  manualComment: string | null;
}

/** View đầy đủ của một lượt làm quiz: tóm tắt lượt + đề + từng câu (đã nhóm sẵn theo trang qua trường page). */
export interface QuizAttemptView {
  attempt: QuizAttemptSummary;
  quiz: QuizView;
  questions: QuizAttemptQuestionView[];
  totalMax: number;
  pendingManualCount: number;
  closedDueToTimeLimit: boolean;
  /** Nhận xét tổng quát theo dải điểm (tầng feedback thứ tư) — chỉ khi lượt đã chốt và cửa sổ cho xem overall feedback. */
  overallFeedback: string | null;
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
  /** Số câu đã chấm đúng trọn vẹn (fraction = 1) — bộ thống kê Azota (issue #224). */
  correctCount: number;
  /** Học sinh làm đúng trọn vẹn câu này (kèm tên hiển thị) — bộ Azota. */
  correctStudents: { userId: string; displayName: string }[];
}

/**
 * Tổng quan kết quả MỘT bài kiểm tra cho giáo viên (bộ thống kê Azota —
 * issue #224): tham gia (bao nhiêu HS ghi danh, bao nhiêu đã nộp, ai
 * chưa nộp), điểm trung bình của bài và phổ điểm theo 10 dải phần trăm
 * của thang điểm bài. Điểm từng HS nằm ở gradesByUser/attempts của
 * getResults; thống kê theo câu nằm ở questionStats.
 */
export interface QuizResultsSummary {
  enrolledCount: number;
  /** Số học sinh có ít nhất một lượt ĐÃ NỘP (finished/needsgrading). */
  submittedCount: number;
  /** Học sinh ghi danh mà chưa nộp lượt nào (kể cả đang làm dở). */
  notSubmittedStudents: { userId: string; displayName: string }[];
  /** Điểm trung bình của bài trên các HS đã có điểm; null khi chưa ai có điểm. */
  averageGrade: number | null;
  /** Thang điểm của bài (quizzes.grade). */
  gradeMax: number;
  /** Phổ điểm: 10 dải [0–10%), …, [90–100%] theo % của gradeMax. */
  distribution: { fromPct: number; toPct: number; count: number }[];
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

/**
 * Hàng pin đã LÀM GIÀU: exam_pins + các trường suy từ exam version
 * đã ghim (thang điểm/tên/mặc định/ma trận/thang Đ–S) và exam
 * (kind + công thức recipe qua version). `course`/`grade`/`name`
 * giữ tên quen thuộc của mô hình quiz cũ cho các tầng trên.
 */
export type PinRow = ExamPinRow & {
  course: string;
  grade: number;
  tfScale: number[] | null;
  matrixId: string | null;
  name: string;
  /** Số version của exam version đang ghim (hiển thị "đang ghim bản đề v[n]"). */
  examVersionNumber: number;
  /** Trạng thái hiện tại của đề (draft | ready | hidden) — điều kiện tồn tại đích cập nhật version. */
  examStatus: string;
  /** Số version mới nhất của đề (mọi trạng thái). */
  examLatestVersion: number;
};

/** Slot hiệu lực suy ra từ exam version đã ghim (không còn bảng quiz_slots). */
export interface EffectiveSlotRow {
  id: string;
  pinId: string;
  slot: number;
  page: number;
  questionId: string | null;
  categoryId: string | null;
  maxMark: number;
  matrixCellId: string | null;
  versionMode: 'pinned' | 'follow_latest';
  pinnedVersionId: string | null;
  pinnedVersionNumber: number | null;
}

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
    private readonly enrol: EnrolService,
    private readonly passwords: PasswordService,
    private readonly groups: GroupsService,
    private readonly curriculum: CurriculumService,
    private readonly outbox: OutboxService,
    private readonly tenantContext: TenantContextService,
    private readonly tenants: TenantsService,
    private readonly files: FilesService,
  ) {}

  /** Tenant cho ma trận không gắn bank: tenant hiệu lực của request; ngoài request rơi về tenant-zero. */
  private async matrixTenantId(): Promise<string> {
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

  private async enrichPin(row: ExamPinRow): Promise<PinRow> {
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

  /** Pin đã có lượt làm thật thì exam version đã ghim bị khoá (lượt đã pin câu theo version đó). */
  async assertPinUnlocked(pin: PinRow): Promise<void> {
    const attempts = await this.repo.listAttempts(pin.id);
    if (attempts.some((a) => !a.preview)) {
      throw new BadRequestException({ message: 'This pin already has real attempts; its pinned exam version is locked', code: 'exam.pin_locked' });
    }
  }

  private async getAttemptRow(id: string): Promise<ExamAttemptRow> {
    const row = await this.repo.getAttempt(id);
    if (!row) throw new NotFoundException({ message: `Quiz attempt ${id} not found`, code: 'quiz.attempt_not_found' });
    return row;
  }
  /** Context của course module chứa quiz — mọi capability quiz:* kiểm tại đây. */
  private async cmContextId(quiz: PinRow): Promise<string> {
    if (quiz.cmId) {
      const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.MODULE, quiz.cmId);
      if (ctx) return ctx.id;
    }
    const courseCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, quiz.course);
    if (!courseCtx) throw new NotFoundException({ message: `No context for quiz ${quiz.id}`, code: 'quiz.context_missing' });
    return courseCtx.id;
  }
  private async requireCap(actorId: string, quiz: PinRow, capability: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, capability, await this.cmContextId(quiz));
  }
  private async hasCap(actorId: string, quiz: PinRow, capability: string): Promise<boolean> {
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
  private usageTotalMax(usage: UsageView): number {
    return usage.attempts.reduce((sum, a) => sum + a.maxMark, 0);
  }
  /** Điểm một lượt đã quy về thang điểm của quiz (null khi chưa chốt hoặc đề rỗng). */
  private attemptGradeValue(quiz: PinRow, row: ExamAttemptRow, totalMax: number): number | null {
    if (row.sumGrades === null || totalMax <= 0) return null;
    return (row.sumGrades / totalMax) * quiz.grade;
  }
  private async attemptSummary(quiz: PinRow, row: ExamAttemptRow): Promise<QuizAttemptSummary> {
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
  private syncFromUsage(usage: UsageView): { sumGrades: number; pendingManual: number } {
    let sum = 0;
    let pending = 0;
    for (const a of usage.attempts) {
      if (a.state === 'needsgrading') pending += 1;
      else if (a.fraction !== null && a.fraction !== undefined) sum += a.fraction * a.maxMark;
    }
    return { sumGrades: sum, pendingManual: pending };
  }

  /**
   * Tổng điểm của usage GIẢ ĐỊNH một question attempt mang fraction
   * khác (issue #254): cùng phép cộng, cùng thứ tự với
   * {@link syncFromUsage} — dùng để tính điểm sau chấm lại ở bước
   * dry-run sao cho khớp tuyệt đối với tổng mà đường áp thật đồng bộ
   * lại từ usage sau khi engine đã chấm lại.
   */
  private sumWithFraction(usage: UsageView, questionAttemptId: string, fraction: number | null): number {
    let sum = 0;
    for (const a of usage.attempts) {
      if (a.state === 'needsgrading') continue;
      const f = a.id === questionAttemptId ? fraction : a.fraction;
      if (f !== null && f !== undefined) sum += f * a.maxMark;
    }
    return sum;
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
   * Tạo một lần GHIM đề vào khoá (thực thể duy nhất thay quiz +
   * deployment): bản ghi exam_pins neo (exam, exam version) + course
   * module (component mod_quiz, completion tự động theo điểm) + grade
   * item 'mod' mang thang điểm của exam version. Cổng exam:deploy tại
   * bank của đề + trạng thái ready của đề do ExamsService kiểm trước
   * khi gọi; quyền tạo hoạt động do CoursesService kiểm
   * (course:manageactivities); các thao tác về sau kiểm quiz:manage
   * tại context của module.
   */
  /** Nhóm đích của lần ghim phải thuộc đúng khoá của lần ghim (chốt bổ sung 26/10 — ghim neo KHOÁ HỌC, nhóm là của khoá đó). */
  private async assertTargetGroup(courseId: string, targetGroupId: string | null | undefined): Promise<void> {
    if (targetGroupId === undefined || targetGroupId === null) return;
    const group = await this.groups.getGroup(targetGroupId).catch(() => null);
    if (!group || group.courseId !== courseId) {
      throw new BadRequestException({ message: 'Target group does not belong to this course', code: 'exam.pin_target_group_invalid' });
    }
  }

  /** Người dùng có thuộc phạm vi đích của lần ghim không: ghim toàn khoá (targetGroupId null) thì mọi học sinh của khoá đều thuộc; ghim theo nhóm thì chỉ thành viên nhóm đích. */
  private async isInTargetGroup(quiz: PinRow, userId: string): Promise<boolean> {
    if (!quiz.targetGroupId) return true;
    const mine = await this.groups.groupsOfUser(quiz.course, userId);
    return mine.some((g) => g.id === quiz.targetGroupId);
  }

  /**
   * Cổng chế độ tham chiếu version của lần ghim (issue #254): chế độ
   * trôi `float_latest_ready` CHỈ hợp lệ cho lần ghim luyện tập — cụ
   * thể hoá theo preset của pin: preset `regular` (thường xuyên/luyện
   * tập) mới được trôi; preset kiểm tra chính thức (`periodic`, `mock`)
   * hoặc pin không theo preset nào đều bị chặn. Lý do: kiểm tra chính
   * thức đòi mọi học sinh trong cùng cửa sổ làm đúng cùng một version
   * câu hỏi, còn luyện tập cần học sinh luôn gặp bản câu hỏi mới nhất
   * đã duyệt. Vi phạm ném `exam.version_mode_not_allowed` — chặn ở API,
   * không dựa vào việc ẩn tuỳ chọn ở giao diện.
   */
  private assertVersionModeAllowed(preset: string | null | undefined, versionMode: string | null | undefined): void {
    if (versionMode === 'float_latest_ready' && preset !== 'regular') {
      throw new BadRequestException({
        message: 'float_latest_ready is only allowed for practice pins (preset regular); official exam pins (periodic/mock or no preset) must stay pinned',
        code: 'exam.version_mode_not_allowed',
      });
    }
  }

  async createPinRecord(actorId: string, courseId: string, input: {
    sectionId: string; examId: string; examVersionId: string;
    name?: string; intro?: string;
    timeOpen?: string | null; timeClose?: string | null; timeLimitSeconds?: number | null;
    attemptsAllowed?: number; gradeMethod?: string; shuffleAnswers?: boolean;
    password?: string | null; subnet?: string | null;
    reviewAttempt?: number; reviewCorrectness?: number; reviewMarks?: number;
    reviewSpecificFeedback?: number; reviewGeneralFeedback?: number;
    reviewRightAnswer?: number; reviewOverallFeedback?: number;
    preset?: ExamKind | null; lateEntryMinutes?: number | null; monitorEvents?: boolean;
    variantCount?: number; targetGroupId?: string | null;
    versionMode?: 'pinned' | 'float_latest_ready';
  }): Promise<QuizView> {
    await this.courses.getCourse(courseId);
    await this.assertTargetGroup(courseId, input.targetGroupId);
    const version = await this.repo.getExamVersion(input.examVersionId);
    if (!version || version.examId !== input.examId) {
      throw new NotFoundException({ message: `Exam version ${input.examVersionId} not found for exam ${input.examId}`, code: 'exam.version_not_found' });
    }
    const timeOpen = input.timeOpen ? new Date(input.timeOpen) : null;
    const timeClose = input.timeClose ? new Date(input.timeClose) : null;
    if (timeOpen && timeClose && timeClose <= timeOpen) {
      throw new BadRequestException({ message: 'timeClose must be after timeOpen', code: 'quiz.bad_window' });
    }
    this.assertValidSubnet(input.subnet);
    this.assertVersionModeAllowed(input.preset ?? null, input.versionMode ?? 'pinned');
    // Preset theo hình thức thi: trường gửi kèm THẮNG preset, preset
    // chỉ điền các trường còn trống (bảng preset ở domain/matrix.ts).
    const preset = input.preset ? EXAM_KIND_PRESETS[input.preset] : null;
    const name = input.name ?? version.name;
    const variantCount = input.variantCount ?? 1;
    const pin = await this.repo.insertPin({
      examId: input.examId, examVersionId: input.examVersionId, courseId, cmId: null,
      name: input.name ?? null, intro: input.intro ?? '',
      timeOpen, timeClose, timeLimit: input.timeLimitSeconds ?? null,
      attemptsAllowed: input.attemptsAllowed ?? preset?.attemptsAllowed ?? 0,
      gradeMethod: input.gradeMethod ?? 'highest',
      shuffleAnswers: input.shuffleAnswers ?? preset?.shuffleAnswers ?? false,
      passwordHash: await this.hashQuizPassword(input.password),
      subnet: input.subnet ?? null,
      preset: input.preset ?? null,
      versionMode: input.versionMode ?? 'pinned',
      lateEntryMinutes: input.lateEntryMinutes !== undefined ? input.lateEntryMinutes : (preset?.lateEntryMinutes ?? null),
      monitorEvents: input.monitorEvents ?? preset?.monitorEvents ?? false,
      variantCount,
      variants: this.makeVariants(`${input.examId}:${input.examVersionId}:${courseId}:${Date.now()}`, variantCount),
      targetGroupId: input.targetGroupId ?? null,
      resultsPublishedAt: null,
      createdBy: actorId,
      ...(input.reviewAttempt !== undefined ? { reviewAttempt: input.reviewAttempt } : {}),
      ...(input.reviewCorrectness !== undefined ? { reviewCorrectness: input.reviewCorrectness } : (preset ? { reviewCorrectness: preset.reviewCorrectness } : {})),
      ...(input.reviewMarks !== undefined ? { reviewMarks: input.reviewMarks } : (preset ? { reviewMarks: preset.reviewMarks } : {})),
      ...(input.reviewSpecificFeedback !== undefined ? { reviewSpecificFeedback: input.reviewSpecificFeedback } : (preset ? { reviewSpecificFeedback: preset.reviewSpecificFeedback } : {})),
      ...(input.reviewGeneralFeedback !== undefined ? { reviewGeneralFeedback: input.reviewGeneralFeedback } : (preset ? { reviewGeneralFeedback: preset.reviewGeneralFeedback } : {})),
      ...(input.reviewRightAnswer !== undefined ? { reviewRightAnswer: input.reviewRightAnswer } : (preset ? { reviewRightAnswer: preset.reviewRightAnswer } : {})),
      ...(input.reviewOverallFeedback !== undefined ? { reviewOverallFeedback: input.reviewOverallFeedback } : (preset ? { reviewOverallFeedback: preset.reviewOverallFeedback } : {})),
    });
    try {
      const cm = await this.courses.createCm(actorId, courseId, {
        sectionId: input.sectionId, component: QUIZ_COMPONENT, instanceId: pin.id, name,
        completion: 2, completionUseGrade: true,
      });
      await this.repo.updatePin(pin.id, { cmId: cm.id });
      await this.grades.createItem(actorId, courseId, {
        itemName: name, itemType: 'mod', cmId: cm.id, gradeMax: version.totalScore,
      });
    } catch (err) {
      // Dọn dẹp best-effort để không để lại pin mồ côi không có cm.
      await this.repo.deletePin(pin.id).catch(() => undefined);
      throw err;
    }
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_pin', type: 'exam_pinned',
      payload: { examId: input.examId, examVersionId: input.examVersionId, pinId: pin.id, courseId, actorId },
    });
    return this.pinView(await this.getPin(pin.id));
  }

  /** Sinh danh sách mã đề cho một lần ghim: 001, 002… kèm seed hoán vị riêng từng mã (hạt giống suy xác định từ nguồn hạt để in lại khớp — chuyển từ tầng deployment EB-2 cũ). */
  private makeVariants(seedSource: string, count: number): { code: string; seed: number }[] {
    let h = 2166136261;
    for (const ch of seedSource) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return Array.from({ length: count }, (_, i) => ({
      code: String(i + 1).padStart(3, '0'),
      seed: (h + i * 2654435761) % 2147483647,
    }));
  }

  /**
   * Sửa CẤU HÌNH TỔ CHỨC của một pin (quiz:manage): giờ mở/đóng, thời
   * lượng, số lượt, mật khẩu, luật xem lại, preset (chỉ nhãn — không
   * áp lại preset), số mã đề. Tên và thang điểm được đồng bộ sang
   * course module và grade item; thang điểm suy từ exam version nên
   * chỉ đổi khi đổi version đã ghim — và đổi version bị khoá khi pin
   * đã có lượt làm thật (exam.pin_locked), số mã đề cũng vậy.
   */
  async updatePin(actorId: string, pinId: string, input: {
    name?: string; intro?: string;
    timeOpen?: string | null; timeClose?: string | null; timeLimitSeconds?: number | null;
    attemptsAllowed?: number; gradeMethod?: string; shuffleAnswers?: boolean;
    password?: string | null; subnet?: string | null;
    reviewAttempt?: number; reviewCorrectness?: number; reviewMarks?: number;
    reviewSpecificFeedback?: number; reviewGeneralFeedback?: number;
    reviewRightAnswer?: number; reviewOverallFeedback?: number;
    preset?: ExamKind | null; lateEntryMinutes?: number | null; monitorEvents?: boolean;
    examVersionId?: string; variantCount?: number; targetGroupId?: string | null;
    versionMode?: 'pinned' | 'float_latest_ready';
  }): Promise<QuizView> {
    const pin = await this.getPin(pinId);
    await this.requireCap(actorId, pin, QUIZ_CAPABILITIES.manage);
    this.assertValidSubnet(input.subnet);
    // Cổng chế độ tham chiếu version (issue #254) xét trên cặp
    // (preset, versionMode) HIỆU LỰC SAU khi sửa: bật float cho pin
    // không phải luyện tập bị chặn, và đổi preset rời `regular` trong
    // lúc pin đang float cũng bị chặn — muốn đổi phải tắt float trước.
    this.assertVersionModeAllowed(
      input.preset !== undefined ? input.preset : pin.preset,
      input.versionMode !== undefined ? input.versionMode : pin.versionMode,
    );
    const patch: Partial<ExamPinRow> = {};
    if (input.versionMode !== undefined) patch.versionMode = input.versionMode;
    if (input.name !== undefined) patch.name = input.name;
    if (input.intro !== undefined) patch.intro = input.intro;
    if (input.timeOpen !== undefined) patch.timeOpen = input.timeOpen ? new Date(input.timeOpen) : null;
    if (input.timeClose !== undefined) patch.timeClose = input.timeClose ? new Date(input.timeClose) : null;
    if (input.timeLimitSeconds !== undefined) patch.timeLimit = input.timeLimitSeconds;
    if (input.attemptsAllowed !== undefined) patch.attemptsAllowed = input.attemptsAllowed;
    if (input.gradeMethod !== undefined) patch.gradeMethod = input.gradeMethod;
    if (input.shuffleAnswers !== undefined) patch.shuffleAnswers = input.shuffleAnswers;
    if (input.password !== undefined) patch.passwordHash = await this.hashQuizPassword(input.password);
    if (input.subnet !== undefined) patch.subnet = input.subnet;
    if (input.reviewAttempt !== undefined) patch.reviewAttempt = input.reviewAttempt;
    if (input.reviewCorrectness !== undefined) patch.reviewCorrectness = input.reviewCorrectness;
    if (input.reviewMarks !== undefined) patch.reviewMarks = input.reviewMarks;
    if (input.reviewSpecificFeedback !== undefined) patch.reviewSpecificFeedback = input.reviewSpecificFeedback;
    if (input.reviewGeneralFeedback !== undefined) patch.reviewGeneralFeedback = input.reviewGeneralFeedback;
    if (input.reviewRightAnswer !== undefined) patch.reviewRightAnswer = input.reviewRightAnswer;
    if (input.reviewOverallFeedback !== undefined) patch.reviewOverallFeedback = input.reviewOverallFeedback;
    // Sửa chỉ đổi NHÃN hình thức — không áp lại preset (giáo viên đã
    // tinh chỉnh từng trường sau khi chọn preset lúc tạo).
    if (input.preset !== undefined) patch.preset = input.preset;
    if (input.lateEntryMinutes !== undefined) patch.lateEntryMinutes = input.lateEntryMinutes;
    if (input.targetGroupId !== undefined) {
      await this.assertTargetGroup(pin.course, input.targetGroupId);
      patch.targetGroupId = input.targetGroupId;
    }
    if (input.monitorEvents !== undefined) patch.monitorEvents = input.monitorEvents;
    let newVersion: Awaited<ReturnType<QuizRepository['getExamVersion']>> | undefined;
    if (input.examVersionId !== undefined && input.examVersionId !== pin.examVersionId) {
      await this.assertPinUnlocked(pin);
      const v = await this.repo.getExamVersion(input.examVersionId);
      if (!v || v.examId !== pin.examId) {
        throw new NotFoundException({ message: `Exam version ${input.examVersionId} not found for exam ${pin.examId}`, code: 'exam.version_not_found' });
      }
      newVersion = v;
      patch.examVersionId = input.examVersionId;
    }
    if (input.variantCount !== undefined && input.variantCount !== pin.variantCount) {
      await this.assertPinUnlocked(pin);
      patch.variantCount = input.variantCount;
      patch.variants = this.makeVariants(`${pin.examId}:${patch.examVersionId ?? pin.examVersionId}:${pin.courseId}:${Date.now()}`, input.variantCount);
    }
    const nextOpen = patch.timeOpen !== undefined ? patch.timeOpen : pin.timeOpen;
    const nextClose = patch.timeClose !== undefined ? patch.timeClose : pin.timeClose;
    if (nextOpen && nextClose && nextClose <= nextOpen) {
      throw new BadRequestException({ message: 'timeClose must be after timeOpen', code: 'quiz.bad_window' });
    }
    if (Object.keys(patch).length) await this.repo.updatePin(pin.id, patch);
    const updated = await this.getPin(pin.id);
    if (updated.cmId && input.name !== undefined) {
      await this.courses.updateCm(actorId, updated.cmId, { name: updated.name });
    }
    if (updated.cmId && (newVersion || input.name !== undefined)) {
      const item = await this.grades.getItemForCm(updated.course, updated.cmId);
      if (item) {
        await this.grades.updateItem(actorId, item.id, {
          ...(newVersion ? { gradeMax: newVersion.totalScore } : {}),
          ...(input.name !== undefined ? { itemName: updated.name } : {}),
        });
      }
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_updated', payload: { pinId: pin.id, courseId: pin.course, actorId } });
    return this.pinView(updated);
  }

  /**
   * Xoá pin cùng attempts, usages của engine, course module và
   * grade item của hoạt động (quiz:manage). Đề trong bank không bị
   * ảnh hưởng — xoá pin chỉ gỡ lần tổ chức trong khoá này.
   */
  async deletePin(actorId: string, pinId: string): Promise<void> {
    const pin = await this.getPin(pinId);
    await this.requireCap(actorId, pin, QUIZ_CAPABILITIES.manage);
    const attempts = await this.repo.listAttempts(pin.id);
    for (const a of attempts) await this.questions.deleteUsage(a.usageId);
    if (pin.cmId) {
      const item = await this.grades.getItemForCm(pin.course, pin.cmId).catch(() => undefined);
      if (item) await this.grades.deleteItem(actorId, item.id).catch(() => undefined);
    }
    await this.repo.deletePin(pin.id);
    if (pin.cmId) await this.courses.deleteCm(actorId, pin.cmId);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_deleted', payload: { pinId: pin.id, courseId: pin.course, actorId } });
  }

  // --- cập nhật version của pin + chấm lại theo đáp án (issue #254) --------------

  /** Pin đã có lượt làm THẬT (không tính lượt preview của giáo viên) hay chưa — điều kiện của luật khoá exam.pin_locked. */
  private async pinHasRealAttempts(pinId: string): Promise<boolean> {
    const attempts = await this.repo.listAttempts(pinId);
    return attempts.some((a) => !a.preview);
  }

  /**
   * Diff slot-theo-VỊ-TRÍ giữa exam version đang ghim và exam version
   * đích: mỗi vị trí thuộc đúng một loại thay đổi (thêm/bớt slot, đổi
   * câu, đổi version câu đã ghim, đổi điểm slot, hoặc không đổi). Đây
   * là dữ kiện giáo viên xem TRƯỚC khi quyết định áp cập nhật — diff
   * không ghi gì và không đổi trạng thái nào.
   */
  private async diffExamVersionSlots(fromVersionId: string, toVersionId: string): Promise<PinVersionUpdateSlotDiff[]> {
    const [fromSlots, toSlots] = await Promise.all([
      this.repo.listExamSlots(fromVersionId),
      this.repo.listExamSlots(toVersionId),
    ]);
    const fromByPos = new Map(fromSlots.map((s) => [s.position, s]));
    const toByPos = new Map(toSlots.map((s) => [s.position, s]));
    const positions = [...new Set([...fromByPos.keys(), ...toByPos.keys()])].sort((a, b) => a - b);
    return positions.map((position) => {
      const from = fromByPos.get(position);
      const to = toByPos.get(position);
      const change: PinVersionUpdateSlotDiff['change'] = !from
        ? 'added'
        : !to
          ? 'removed'
          : from.questionId !== to.questionId
            ? 'question_changed'
            : from.pinnedVersionNumber !== to.pinnedVersionNumber
              ? 'question_version_changed'
              : from.maxMark !== to.maxMark
                ? 'mark_changed'
                : 'unchanged';
      return {
        position, change,
        fromQuestionId: from?.questionId ?? null,
        toQuestionId: to?.questionId ?? null,
        fromPinnedVersionNumber: from?.pinnedVersionNumber ?? null,
        toPinnedVersionNumber: to?.pinnedVersionNumber ?? null,
        fromMaxMark: from?.maxMark ?? null,
        toMaxMark: to?.maxMark ?? null,
      };
    });
  }

  /**
   * Xem trước thao tác cập nhật pin lên bản ready mới nhất của đề
   * (quiz:manage; issue #254): đích là exam version có số lớn nhất của
   * đề — chỉ tồn tại khi đề đang `ready` và bản đó mới hơn bản đang
   * ghim. Kèm diff từng slot và cờ `blockedByAttempts` để giáo viên
   * biết trước rằng thao tác áp sẽ bị chặn khi pin đã có lượt làm thật.
   */
  async getPinVersionUpdatePreview(actorId: string, pinId: string): Promise<PinVersionUpdatePreview> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    const versions = await this.repo.listExamVersions(quiz.examId);
    const target = versions.find((v) => v.version === quiz.examLatestVersion);
    const available = quiz.examStatus === 'ready' && !!target && target.id !== quiz.examVersionId;
    return {
      pinId: quiz.id,
      fromExamVersionId: quiz.examVersionId,
      fromVersionNumber: quiz.examVersionNumber,
      toExamVersionId: available ? target!.id : null,
      toVersionNumber: available ? target!.version : null,
      examStatus: quiz.examStatus,
      available,
      blockedByAttempts: await this.pinHasRealAttempts(quiz.id),
      slotDiffs: available ? await this.diffExamVersionSlots(quiz.examVersionId, target!.id) : [],
    };
  }

  /**
   * Áp cập nhật pin lên exam version mới nhất của đề (quiz:manage;
   * issue #254) — thao tác TƯỜNG MINH sau bước xem diff:
   * 1. Luật khoá dùng chung với updatePin: pin đã có lượt làm thật thì
   *    bị chặn `exam.pin_locked` (cập nhật chỉ áp cho người chưa làm;
   *    lượt đã có giữ nguyên version và điểm — sửa hệ quả điểm của
   *    chúng chỉ qua đường chấm lại theo đáp án).
   * 2. Đích phải thuộc đúng đề của pin, là version MỚI NHẤT của đề và
   *    đề phải đang `ready` (`exam.version_not_ready` /
   *    `exam.version_not_latest`).
   * 3. Đổi examVersionId của pin, đồng bộ gradeMax của grade item như
   *    updatePin, ghi vết vào exam_pin_version_updates (ai/khi nào/từ
   *    version nào lên version nào) và phát sự kiện
   *    `exam_pin_version_updated`.
   */
  async applyPinVersionUpdate(actorId: string, pinId: string, toExamVersionId: string): Promise<QuizView> {
    const pin = await this.getPin(pinId);
    await this.requireCap(actorId, pin, QUIZ_CAPABILITIES.manage);
    await this.assertPinUnlocked(pin);
    if (pin.examStatus !== 'ready') {
      throw new BadRequestException({
        message: `Exam ${pin.examId} is not ready (status ${pin.examStatus}); there is no ready version to update this pin to`,
        code: 'exam.version_not_ready',
      });
    }
    const target = await this.repo.getExamVersion(toExamVersionId);
    if (!target || target.examId !== pin.examId) {
      throw new NotFoundException({ message: `Exam version ${toExamVersionId} not found for exam ${pin.examId}`, code: 'exam.version_not_found' });
    }
    if (target.id === pin.examVersionId) {
      throw new BadRequestException({ message: 'This pin already uses the requested exam version', code: 'exam.pin_version_unchanged' });
    }
    if (target.version !== pin.examLatestVersion) {
      throw new BadRequestException({
        message: `Exam version ${toExamVersionId} is not the latest version of exam ${pin.examId}; pins only update to the latest ready version`,
        code: 'exam.version_not_latest',
      });
    }
    await this.repo.updatePin(pin.id, { examVersionId: target.id });
    await this.repo.insertPinVersionUpdate({
      pinId: pin.id, actorId, fromExamVersionId: pin.examVersionId, toExamVersionId: target.id,
    });
    const updated = await this.getPin(pin.id);
    if (updated.cmId) {
      const item = await this.grades.getItemForCm(updated.course, updated.cmId);
      if (item) await this.grades.updateItem(actorId, item.id, { gradeMax: target.totalScore });
    }
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'exam_pin_version_updated',
      payload: { pinId: pin.id, courseId: pin.course, fromExamVersionId: pin.examVersionId, toExamVersionId: target.id, actorId },
    });
    return this.pinView(updated);
  }

  /**
   * Chấm lại theo đáp án cho một câu của pin (quiz:grade; issue #254) —
   * đường DUY NHẤT để sửa hệ quả điểm khi đáp án của một câu đã được
   * dùng chấm các lượt đã nộp bị sai: giáo viên tạo version mới của câu
   * với đáp án đúng rồi chấm lại theo version đó.
   *
   * Ứng viên: lượt làm THẬT đã nộp (finished/needsgrading) có question
   * attempt của câu này đã được chấm tự động và đang ghim version khác
   * version đích. Lượt đang làm dở không bị đụng (chưa có điểm để sửa;
   * chúng vẫn chấm theo version đã ghim khi bắt đầu, đúng kỷ luật
   * ghim). Essay nằm ngoài đường này (chấm tay có đường riêng).
   *
   * `dryRun` chỉ tính và trả điểm đổi của từng học sinh; áp thật chạy
   * đúng cùng phép tính ở engine nên kết quả khớp tuyệt đối. Khi áp:
   * chấm lại qua engine (attempt chuyển ghim sang version đích + step
   * hiệu chỉnh) → đồng bộ tổng điểm/trạng thái của lượt → ghi điểm vào
   * sổ nếu lượt đã finished → ghi log exam_attempt_regrades +
   * exam_attempt_regrade_items (chỉ các lượt điểm thật sự đổi mới có
   * mục) → phát sự kiện `exam_attempt_answer_key_regraded` (tên riêng,
   * không dùng lại sự kiện chấm tay `exam_attempt_regraded`).
   */
  async regradePinQuestion(actorId: string, pinId: string, input: { questionId: string; toVersionId: string; dryRun: boolean }): Promise<PinRegradeResult> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.grade);
    // Kiểm đích TRƯỚC khi quét ứng viên — kể cả khi không có ứng viên
    // nào, version đích sai (không thuộc câu / chưa ready) vẫn phải báo
    // lỗi rõ thay vì trả danh sách đổi rỗng gây hiểu nhầm là "không ai đổi điểm".
    const questionView = await this.questions.getQuestion(input.questionId);
    if (questionView.question.qtype === 'essay') {
      throw new BadRequestException({
        message: 'Essay questions are graded manually and cannot be regraded against an answer key',
        code: 'question.regrade_not_supported',
      });
    }
    const { version: targetVersion } = await this.questions.getVersionContent(input.questionId, input.toVersionId);
    if (targetVersion.status !== 'ready') {
      throw new BadRequestException({
        message: `Question version ${input.toVersionId} is not ready (status ${targetVersion.status}); regrading needs the corrected ready version`,
        code: 'question.regrade_version_not_ready',
      });
    }
    type Candidate = {
      attempt: ExamAttemptRow;
      qa: UsageView['attempts'][number];
      oldFraction: number | null; newFraction: number | null;
      oldSumGrades: number; newSumGrades: number; changed: boolean;
    };
    const candidates: Candidate[] = [];
    const submitted = (await this.repo.listAttempts(quiz.id))
      .filter((a) => !a.preview && (a.state === 'finished' || a.state === 'needsgrading'));
    for (const attempt of submitted) {
      const usage = await this.questions.getUsage(attempt.usageId);
      const qa = usage.attempts.find((x) => x.questionId === input.questionId);
      if (!qa || qa.questionVersionId === input.toVersionId) continue;
      if (!['gradedright', 'gradedpartial', 'gradedwrong', 'gaveup'].includes(qa.state)) continue;
      const preview = await this.questions.previewRegradeAttempt(qa.id, input.toVersionId, quiz.tfScale);
      const oldSumGrades = this.syncFromUsage(usage).sumGrades;
      candidates.push({
        attempt, qa,
        oldFraction: qa.fraction, newFraction: preview.newFraction,
        oldSumGrades,
        // Tổng điểm sau chấm lại tính bằng ĐÚNG phép cộng của
        // syncFromUsage trên usage giả định (chỉ fraction của câu này
        // được thay) — cùng thứ tự cộng với đường áp thật nên dry-run
        // và áp thật cho ra cùng một con số tuyệt đối.
        newSumGrades: this.sumWithFraction(usage, qa.id, preview.newFraction),
        changed: preview.newFraction !== qa.fraction,
      });
    }
    const changes = candidates.map((c) => ({
      examAttemptId: c.attempt.id,
      userId: c.attempt.userId,
      attemptNumber: c.attempt.attemptNumber,
      questionAttemptId: c.qa.id,
      oldFraction: c.oldFraction,
      newFraction: c.newFraction,
      oldSumGrades: c.oldSumGrades,
      newSumGrades: c.newSumGrades,
      changed: c.changed,
    }));
    const result: PinRegradeResult = {
      dryRun: input.dryRun,
      pinId: quiz.id,
      questionId: input.questionId,
      fromVersionIds: [...new Set(candidates.map((c) => c.qa.questionVersionId).filter((v): v is string => v !== null))],
      toVersionId: input.toVersionId,
      changes,
    };
    if (input.dryRun || candidates.length === 0) return result;
    // Áp thật: nhóm ứng viên theo version nguồn — mỗi version nguồn một
    // dòng log chấm lại (pin trôi có thể có nhiều version nguồn).
    const byFromVersion = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const key = c.qa.questionVersionId!;
      byFromVersion.set(key, [...(byFromVersion.get(key) ?? []), c]);
    }
    let changedCount = 0;
    for (const [fromVersionId, group] of byFromVersion) {
      const regrade = await this.repo.insertRegrade({
        pinId: quiz.id, questionId: input.questionId, fromVersionId, toVersionId: input.toVersionId, actorId,
      });
      for (const c of group) {
        await this.questions.regradeAttemptWithVersion(actorId, c.qa.id, input.toVersionId, quiz.tfScale);
        const afterUsage = await this.questions.getUsage(c.attempt.usageId);
        const { sumGrades, pendingManual } = this.syncFromUsage(afterUsage);
        const nextState = pendingManual > 0 ? 'needsgrading' : 'finished';
        await this.repo.updateAttempt(c.attempt.id, { sumGrades, state: nextState });
        if (c.changed) {
          changedCount += 1;
          await this.repo.insertRegradeItem({
            regradeId: regrade.id, examAttemptId: c.attempt.id, questionAttemptId: c.qa.id,
            userId: c.attempt.userId, oldFraction: c.oldFraction, newFraction: c.newFraction,
            oldSumGrades: c.oldSumGrades, newSumGrades: sumGrades,
          });
        }
        const updated = await this.getAttemptRow(c.attempt.id);
        if (updated.state === 'finished') await this.pushGrade(quiz, c.attempt.userId);
      }
    }
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'exam_attempt_answer_key_regraded',
      payload: {
        pinId: quiz.id, courseId: quiz.course, questionId: input.questionId,
        toVersionId: input.toVersionId, actorId,
        candidateCount: candidates.length, changedCount,
      },
    });
    return result;
  }

  /**
   * Nhật ký chấm lại theo đáp án của pin cho giáo viên (quiz:viewreports;
   * issue #254): mỗi lần áp thật một dòng kèm điểm đổi của từng lượt —
   * căn cứ truy vết khi học sinh/phụ huynh hỏi vì sao điểm thay đổi.
   */
  async listPinRegrades(actorId: string, pinId: string): Promise<PinRegradeLogEntry[]> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports);
    const attempts = await this.repo.listAttempts(quiz.id);
    const numberByAttempt = new Map(attempts.map((a) => [a.id, a.attemptNumber]));
    const out: PinRegradeLogEntry[] = [];
    for (const r of await this.repo.listRegrades(quiz.id)) {
      const items = await this.repo.listRegradeItems(r.id);
      out.push({
        id: r.id, pinId: r.pinId, questionId: r.questionId,
        fromVersionId: r.fromVersionId, toVersionId: r.toVersionId,
        actorId: r.actorId, createdAt: r.createdAt.toISOString(),
        items: items.map((i) => ({
          examAttemptId: i.examAttemptId, userId: i.userId,
          attemptNumber: numberByAttempt.get(i.examAttemptId) ?? 0,
          oldFraction: i.oldFraction, newFraction: i.newFraction,
          oldSumGrades: i.oldSumGrades, newSumGrades: i.newSumGrades,
        })),
      });
    }
    return out;
  }

  /**
   * Lịch sử sửa điểm của CHÍNH học sinh trong một pin (issue #254): các
   * lần chấm lại theo đáp án đã đổi điểm của mình — câu nào, khi nào,
   * điểm trước/sau. Đi qua CÙNG cổng công bố như mọi đường đọc điểm:
   * pin chưa công bố kết quả thì trả danh sách rỗng (không lộ điểm qua
   * kênh phụ), trừ người có quyền xem báo cáo của pin.
   */
  async listMyPinRegrades(actorId: string, pinId: string): Promise<PinRegradeLogEntry[]> {
    const quiz = await this.getPin(pinId);
    if (!quiz.resultsPublishedAt && !(await this.hasCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports))) {
      return [];
    }
    const rows = await this.repo.listRegradeItemsForUser(quiz.id, actorId);
    const attempts = await this.repo.listAttemptsForUser(quiz.id, actorId, true);
    const numberByAttempt = new Map(attempts.map((a) => [a.id, a.attemptNumber]));
    const byRegrade = new Map<string, PinRegradeLogEntry>();
    for (const { regrade, item } of rows) {
      let entry = byRegrade.get(regrade.id);
      if (!entry) {
        entry = {
          id: regrade.id, pinId: regrade.pinId, questionId: regrade.questionId,
          fromVersionId: regrade.fromVersionId, toVersionId: regrade.toVersionId,
          actorId: regrade.actorId, createdAt: regrade.createdAt.toISOString(),
          items: [],
        };
        byRegrade.set(regrade.id, entry);
      }
      entry.items.push({
        examAttemptId: item.examAttemptId, userId: item.userId,
        attemptNumber: numberByAttempt.get(item.examAttemptId) ?? 0,
        oldFraction: item.oldFraction, newFraction: item.newFraction,
        oldSumGrades: item.oldSumGrades, newSumGrades: item.newSumGrades,
      });
    }
    return [...byRegrade.values()];
  }

  /**
   * Các pin trong khoá học (cho trang khoá học/danh sách hoạt động).
   * H9 (rà soát #134): QuizView kèm slots (questionId, pinnedVersion,
   * bank) là cấu trúc đề — chỉ người qua cổng truy cập khoá mới liệt kê
   * được; trước đây handler không nhận actor nên người ngoài khoá cũng
   * khảo sát được thành phần đề của bất kỳ khoá nào.
   */
  async listPins(actorId: string, courseId: string): Promise<QuizView[]> {
    await this.courses.assertCourseAccess(actorId, courseId);
    const rows = await this.repo.listPinsInCourse(courseId);
    // Phạm vi nhóm đích: người không có quyền quản lý tại khoá chỉ
    // thấy lần ghim toàn khoá + lần ghim của nhóm mình thuộc về.
    const canManage = await this.evaluator.hasCapability(actorId, QUIZ_CAPABILITIES.manage, await this.courses.courseContextId(courseId));
    const myGroupIds = canManage ? null : new Set((await this.groups.groupsOfUser(courseId, actorId)).map((g) => g.id));
    const out: QuizView[] = [];
    for (const r of rows) {
      if (myGroupIds && r.targetGroupId && !myGroupIds.has(r.targetGroupId)) continue;
      out.push(await this.pinView(await this.enrichPin(r)));
    }
    return out;
  }

  /** View của một override: tên đích được tra cứu để client hiển thị, mật khẩu chỉ lộ cờ hasPassword. */
  private async overrideView(row: ExamPinOverrideRow): Promise<ExamPinOverrideView> {
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
      id: row.id, pinId: row.pinId,
      groupId: row.groupId, groupName,
      userId: row.userId, userName,
      timeOpen: row.timeOpen?.toISOString() ?? null,
      timeClose: row.timeClose?.toISOString() ?? null,
      timeLimitSeconds: row.timeLimit,
      attempts: row.attempts,
      hasPassword: row.passwordHash !== null,
      reason: row.reason,
    };
  }

  private async getOverrideRow(quiz: PinRow, overrideId: string): Promise<ExamPinOverrideRow> {
    const row = await this.repo.getOverride(overrideId);
    if (!row || row.pinId !== quiz.id) {
      throw new NotFoundException({ message: `Quiz override ${overrideId} not found`, code: 'quiz.override_not_found' });
    }
    return row;
  }

  // --- công bố kết quả + bề mặt theo id của pin --------------------------------

  /** Công bố kết quả của pin (trạng thái công bố của #224 sống trên exam_pins.results_published_at; quiz:manage). */
  async publishResults(actorId: string, pinId: string): Promise<QuizView> {
    const pin = await this.getPin(pinId);
    await this.requireCap(actorId, pin, QUIZ_CAPABILITIES.manage);
    await this.repo.updatePin(pin.id, { resultsPublishedAt: new Date() });
    return this.pinView(await this.getPin(pin.id));
  }

  /** Thu hồi công bố kết quả của pin (quiz:manage). */
  async unpublishResults(actorId: string, pinId: string): Promise<QuizView> {
    const pin = await this.getPin(pinId);
    await this.requireCap(actorId, pin, QUIZ_CAPABILITIES.manage);
    await this.repo.updatePin(pin.id, { resultsPublishedAt: null });
    return this.pinView(await this.getPin(pin.id));
  }

  /** Sửa override theo id (route /exam-pin-overrides/:overrideId): pin suy từ chính override. */
  async updatePinOverride(actorId: string, overrideId: string, dto: UpdateExamPinOverrideDto): Promise<ExamPinOverrideView> {
    const row = await this.repo.getOverride(overrideId);
    if (!row) throw new NotFoundException({ message: `Exam pin override ${overrideId} not found`, code: 'quiz.override_not_found' });
    return this.updateOverride(actorId, row.pinId, overrideId, dto);
  }

  /** Xoá override theo id (route /exam-pin-overrides/:overrideId). */
  async deletePinOverride(actorId: string, overrideId: string): Promise<void> {
    const row = await this.repo.getOverride(overrideId);
    if (!row) throw new NotFoundException({ message: `Exam pin override ${overrideId} not found`, code: 'quiz.override_not_found' });
    await this.deleteOverride(actorId, row.pinId, overrideId);
  }

  /** Xoá feedback theo id (route /exam-pin-feedbacks/:feedbackId): pin suy từ chính feedback. */
  async deletePinFeedback(actorId: string, feedbackId: string): Promise<void> {
    const row = await this.repo.getFeedback(feedbackId);
    if (!row) throw new NotFoundException({ message: `Exam pin feedback ${feedbackId} not found`, code: 'quiz.feedback_not_found' });
    await this.deleteFeedback(actorId, row.pinId, feedbackId);
  }

  /** Danh sách ghi đè của quiz (quiz:manageoverrides). */
  async listOverrides(actorId: string, pinId: string): Promise<ExamPinOverrideView[]> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
    const rows = await this.repo.listOverrides(quiz.id);
    const out: ExamPinOverrideView[] = [];
    for (const r of rows) out.push(await this.overrideView(r));
    return out;
  }

  /**
   * Tạo ghi đè (quiz:manageoverrides): đích phải là đúng MỘT nhóm của
   * khoá chứa quiz hoặc đúng MỘT người dùng có quyền vào khoá; mỗi đích
   * tối đa một ghi đè cho một quiz (trùng đích bị từ chối thay vì đè
   * lặng lẽ như Moodle upsert).
   */
  async createOverride(actorId: string, pinId: string, input: CreateExamPinOverrideDto): Promise<ExamPinOverrideView> {
    const quiz = await this.getPin(pinId);
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
    // Lý do BẮT BUỘC khi override người dùng cộng thời gian (đi theo
    // KHGD cá nhân của HS hoà nhập) hoặc mở cửa sổ riêng (cửa sổ kiểm
    // tra bù) — truy vết quyết định theo hồ sơ thi trực tuyến VN.
    if (input.userId && (input.timeLimitSeconds != null || input.timeOpen != null) && !input.reason) {
      throw new BadRequestException({ message: 'A reason is required for a user override that extends time or opens a separate window', code: 'quiz.override_reason_required' });
    }
    const row = await this.repo.insertOverride({
      pinId: quiz.id,
      groupId: input.groupId ?? null,
      userId: input.userId ?? null,
      timeOpen, timeClose,
      timeLimit: input.timeLimitSeconds ?? null,
      attempts: input.attempts ?? null,
      passwordHash: await this.hashQuizPassword(input.password),
      reason: input.reason ?? null,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_override_created', payload: { pinId: quiz.id, courseId: quiz.course, overrideId: row.id, actorId } });
    return this.overrideView(row);
  }

  /** Sửa một ghi đè (quiz:manageoverrides); trường không gửi giữ nguyên, `null` ở trường ghi đè = quay về kế thừa. */
  async updateOverride(actorId: string, pinId: string, overrideId: string, input: UpdateExamPinOverrideDto): Promise<ExamPinOverrideView> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
    const row = await this.getOverrideRow(quiz, overrideId);
    const patch: Partial<ExamPinOverrideRow> = {};
    if (input.timeOpen !== undefined) patch.timeOpen = input.timeOpen ? new Date(input.timeOpen) : null;
    if (input.timeClose !== undefined) patch.timeClose = input.timeClose ? new Date(input.timeClose) : null;
    if (input.timeLimitSeconds !== undefined) patch.timeLimit = input.timeLimitSeconds;
    if (input.attempts !== undefined) patch.attempts = input.attempts;
    if (input.password !== undefined) patch.passwordHash = await this.hashQuizPassword(input.password);
    if (input.reason !== undefined) patch.reason = input.reason;
    const nextOpen = patch.timeOpen !== undefined ? patch.timeOpen : row.timeOpen;
    const nextClose = patch.timeClose !== undefined ? patch.timeClose : row.timeClose;
    if (nextOpen && nextClose && nextClose <= nextOpen) {
      throw new BadRequestException({ message: 'timeClose must be after timeOpen', code: 'quiz.bad_window' });
    }
    // Cùng quy tắc reason như đường tạo, áp trên TRẠNG THÁI HỢP NHẤT
    // sau PATCH: override người dùng mà trạng thái cuối còn cộng giờ
    // hoặc mở cửa sổ riêng thì phải có reason. Thiếu cổng này, PATCH
    // vòng qua được cổng lúc tạo (tạo override lành tính chỉ-đổi-số-lượt
    // rồi sửa cộng giờ lặng lẽ, không truy vết quyết định).
    const nextTimeLimit = patch.timeLimit !== undefined ? patch.timeLimit : row.timeLimit;
    const nextReason = patch.reason !== undefined ? patch.reason : row.reason;
    if (row.userId && (nextTimeLimit != null || nextOpen != null) && !nextReason) {
      throw new BadRequestException({ message: 'A reason is required for a user override that extends time or opens a separate window', code: 'quiz.override_reason_required' });
    }
    if (Object.keys(patch).length) await this.repo.updateOverride(row.id, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_override_updated', payload: { pinId: quiz.id, courseId: quiz.course, overrideId: row.id, actorId } });
    return this.overrideView(await this.getOverrideRow(quiz, overrideId));
  }

  /** Xoá một ghi đè (quiz:manageoverrides) — đích của ghi đè quay về cài đặt tầng dưới ngay. */
  async deleteOverride(actorId: string, pinId: string, overrideId: string): Promise<void> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
    const row = await this.getOverrideRow(quiz, overrideId);
    await this.repo.deleteOverride(row.id);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_override_deleted', payload: { pinId: quiz.id, courseId: quiz.course, overrideId: row.id, actorId } });
  }

  // --- ma trận đề (Chặng 3) ---------------------------------------------------------

  private async getMatrixRow(id: string): Promise<ExamMatrixRow> {
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
   *   (QuestionBanksService.bankLocalMatrixCaps: quiz:viewmatrix ↔
   *   thành viên + phụ trách; quiz:managematrix ↔ phụ trách), KHÔNG
   *   qua PermissionEvaluator — evaluator kế thừa mặc định archetype
   *   từ mọi context tổ tiên nên giáo viên có vai ở context hệ thống
   *   sẽ lọt cổng bank kín của tổ dù không phải thành viên.
   * - Ma trận chưa thuộc bank nào (hoặc bank đã bị xoá) giữ hành vi
   *   Chặng 3: PermissionEvaluator tại context môn.
   */
  private async requireMatrixCap(actorId: string, matrix: ExamMatrixRow, capability: string): Promise<void> {
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
        const ok = capability === QUIZ_CAPABILITIES.viewMatrix ? caps.view : caps.manage;
        if (!ok) {
          throw new ForbiddenException({ message: `Missing capability ${capability} in matrix bank ${bank.id}`, code: 'access.capability_denied' });
        }
        return;
      }
    }
    await this.evaluator.requireCapability(actorId, capability, matrix.contextId);
  }
  private matrixCellView(row: ExamMatrixCellRow): ExamMatrixCellView {
    return {
      id: row.id, matrixId: row.matrixId, curriculumNodeId: row.curriculumNodeId,
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
      scopeNote: row.scopeNote, scopeNodeIds: row.scopeNodeIds,
      totalScore: row.totalScore, createdBy: row.createdBy,
      bankId: row.bankId, status: row.status as ExamMatrixView['status'],
      isTemplate: row.isTemplate, derivedFromMatrixId: row.derivedFromMatrixId,
      version: row.version,
      cells: cells.map((c) => this.matrixCellView(c)),
      warnings: matrixWarnings({
        cells, targetFormPercents: row.targetFormPercents,
        targetLevelPercents: row.targetLevelPercents, totalScore: row.totalScore,
      }),
    };
  }

  /** View đầy đủ của một dòng ma trận (ô + cảnh báo) — bản công khai cho lớp bank (MB-1) dùng sau khi đã tự gác quyền. */
  async viewMatrixRow(row: ExamMatrixRow): Promise<ExamMatrixView> {
    return this.matrixView(row);
  }

  /**
   * Tạo ma trận: quyền ghi MỘT nguồn duy nhất (E-8) — khi gắn vào một
   * bank ma trận (MB-1) thì gác quiz:managematrix tại CONTEXT CỦA BANK
   * (bank phải tồn tại và đúng bank_kind='matrix'); không gắn bank thì
   * giữ hành vi Chặng 3: quiz:managematrix tại context của môn. Tỉ lệ
   * mục tiêu không được cho thì CHỤP từ preset tại lúc tạo — về sau
   * preset có đổi thì ma trận đã tạo không đổi theo.
   */
  async createMatrix(actorId: string, input: CreateExamMatrixDto): Promise<ExamMatrixView> {
    const subject = await this.curriculum.getSubject(actorId, input.subjectId);
    const curriculum = await this.curriculum.getCurriculum(actorId, input.curriculumId);
    if (curriculum.subjectId !== subject.id) {
      throw new BadRequestException({ message: 'Curriculum does not belong to the subject', code: 'quiz.matrix_curriculum_mismatch' });
    }
    let bankTenantId: string | null | undefined;
    if (input.bankId) {
      const bank = await this.banks.findBankById(input.bankId);
      bankTenantId = bank?.tenantId;
      if (!bank) throw new NotFoundException({ message: `Matrix bank ${input.bankId} not found`, code: 'quiz.matrix_bank_not_found' });
      if (bank.bankKind !== 'matrix') {
        throw new BadRequestException({ message: 'Target bank is not a matrix bank', code: 'quiz.matrix_bank_kind_mismatch' });
      }
      await this.banks.syncBankMembership(bank);
      // Ghi vào bank = quyền phụ trách bank (bank-local, xem requireMatrixCap).
      const caps = await this.banks.bankLocalMatrixCaps(actorId, bank);
      if (!caps.manage) {
        throw new ForbiddenException({ message: `Missing capability ${QUIZ_CAPABILITIES.manageMatrix} in matrix bank ${bank.id}`, code: 'access.capability_denied' });
      }
    } else {
      await this.evaluator.requireCapability(actorId, QUIZ_CAPABILITIES.manageMatrix, subject.contextId);
    }
    // Khuôn ma trận duy nhất là CV 7991 (bỏ hẳn chọn preset): tỉ lệ
    // tham chiếu chụp từ hằng cấu hình khi GV không cho tỉ lệ riêng.
    const presetKind = 'cv7991_periodic';
    const preset = MATRIX_PRESETS[presetKind];
    const row = await this.repo.insertMatrix({
      tenantId: bankTenantId !== undefined ? bankTenantId : await this.matrixTenantId(),
      name: input.name, subjectId: subject.id, curriculumId: curriculum.id,
      contextId: subject.contextId, presetKind,
      targetFormPercents: input.targetFormPercents !== undefined ? input.targetFormPercents : (preset?.targetFormPercents ?? null),
      targetLevelPercents: input.targetLevelPercents !== undefined ? input.targetLevelPercents : (preset?.targetLevelPercents ?? null),
      levelSet: input.levelSet ?? 'three',
      scopeNote: input.scopeNote ?? null,
      scopeNodeIds: input.scopeNodeIds ?? null,
      totalScore: input.totalScore ?? 10,
      createdBy: actorId,
      // Trường ngân hàng (MB-0/MB-1): bankId đã gác quyền tại context
      // bank ở trên; copy mẫu/đóng góp đi qua MatrixBanksService.
      bankId: input.bankId ?? null,
      status: input.status ?? 'draft',
      isTemplate: input.isTemplate ?? false,
      derivedFromMatrixId: input.derivedFromMatrixId ?? null,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_created', payload: { matrixId: row.id, subjectId: subject.id, actorId } });
    return this.matrixView(row);
  }

  /**
   * Chữ ký nội dung chuẩn hoá của một ma trận (dự thảo nhập hoặc bản
   * ghi đã lưu): tên + môn + chương trình + bộ mức + tổng điểm + ghi
   * chú phạm vi + tập ĐVK phạm vi (không thứ tự) + toàn bộ ô (không
   * thứ tự; điểm ô làm tròn 4 chữ số thập phân như đường parse của
   * lát I-1). Hai nội dung cho cùng một chữ ký là TRÙNG TOÀN BỘ theo
   * nghĩa nghiệp vụ của đường nhập file — cơ sở cho chống ghi trùng
   * của {@link createMatrixFromImport}.
   */
  private importedMatrixSignature(input: {
    name: string; subjectId: string; curriculumId: string;
    levelSet: string; totalScore: number; scopeNote: string | null;
    scopeNodeIds: string[] | null;
    cells: { curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number; cellScore: number }[];
  }): string {
    const norm = (n: number) => Math.round(n * 10000) / 10000;
    return JSON.stringify({
      name: input.name, subjectId: input.subjectId, curriculumId: input.curriculumId,
      levelSet: input.levelSet, totalScore: norm(input.totalScore), scopeNote: input.scopeNote,
      scopeNodeIds: [...(input.scopeNodeIds ?? [])].sort(),
      cells: input.cells
        .map((c) => [c.curriculumNodeId, c.cognitiveLevel, c.qtype, c.questionCount, norm(c.cellScore)].join('|'))
        .sort(),
    });
  }

  /**
   * Ghi NGUYÊN TỬ một ma trận từ kết quả parse HỢP LỆ của đường nhập
   * file (lát I-2, issue #233) — đầu ghi duy nhất của luồng nhập:
   *
   * 1. Đối chiếu cặp môn/chương trình như {@link createMatrix}; cổng
   *    `quiz:managematrix` tại context môn đã được chạy lại ở bước
   *    parse của chính request ghi (MatrixImportService.previewImport)
   *    nên tới đây người gọi đã có quyền tạo ma trận tại môn đó.
   * 2. Bank đích = bank ma trận CÁ NHÂN của người nhập (tạo lười như
   *    đường copy mẫu); quyền ghi tại bank chốt bằng bộ quyền
   *    bank-local như nhánh gắn bank của createMatrix; `tenant_id`
   *    của ma trận suy từ bank (schema đã chốt: tenant suy từ bank
   *    chủ). Ma trận vào bank ở trạng thái `draft`, không phải mẫu —
   *    cùng vị thế với ma trận tạo tay, muốn lên bank chung phải đi
   *    đường copy/đóng góp hiện có.
   * 3. CHỐNG GHI TRÙNG: đối chiếu chữ ký nội dung với các ma trận
   *    chính người nhập đã có trong bank đích — trùng toàn bộ thì trả
   *    ngay ma trận đã có, KHÔNG tạo bản thứ hai (gửi lại cùng một
   *    file do double submit/retry không nhân đôi dữ liệu). Phạm vi
   *    không đổi schema nên không có khoá duy nhất ở DB: hai request
   *    trùng chạy ĐỒNG THỜI tuyệt đối vẫn là cửa sổ đua lý thuyết —
   *    ghi nhận thẳng, xử lý khi có quyết định đổi schema riêng.
   * 4. Ghi ma trận + toàn bộ ô trong MỘT transaction: bất kỳ lỗi nào
   *    giữa chừng (khoá ngoại, ràng buộc duy nhất của ô, check của
   *    DB) đều rollback toàn bộ — không để lại ma trận mồ côi hay ô
   *    ghi dở. Sự kiện outbox `exam_matrix_created` phát SAU khi
   *    transaction đã commit, như createMatrix.
   *
   * @param actorId - Người nhập (chủ bank đích).
   * @param input - Dự thảo đã parse hợp lệ: thông tin chung + phạm vi
   *   (ĐVK theo thứ tự hàng trong file) + các ô kèm `position` = số
   *   thứ tự hàng của ĐVK trong file (hồ sơ import: position của ô là
   *   STT của hàng).
   * @returns View ma trận (mới tạo, hoặc bản đã có khi trùng nội dung).
   * @throws BadRequestException khi chương trình không thuộc môn.
   * @throws ForbiddenException khi người nhập không có quyền phụ
   *   trách bank cá nhân của mình (bộ quyền bank-local).
   */
  async createMatrixFromImport(actorId: string, input: {
    name: string; subjectId: string; curriculumId: string;
    levelSet: 'three' | 'four'; totalScore: number; scopeNote: string | null;
    scopeNodeIds: string[];
    cells: { curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number; cellScore: number; position: number }[];
  }): Promise<ExamMatrixView> {
    const subject = await this.curriculum.getSubject(actorId, input.subjectId);
    const curriculum = await this.curriculum.getCurriculum(actorId, input.curriculumId);
    if (curriculum.subjectId !== subject.id) {
      throw new BadRequestException({ message: 'Curriculum does not belong to the subject', code: 'quiz.matrix_curriculum_mismatch' });
    }
    const bank = await this.banks.ensurePersonalBank(actorId, 'matrix');
    await this.banks.syncBankMembership(bank);
    const caps = await this.banks.bankLocalMatrixCaps(actorId, bank);
    if (!caps.manage) {
      throw new ForbiddenException({ message: `Missing capability ${QUIZ_CAPABILITIES.manageMatrix} in matrix bank ${bank.id}`, code: 'access.capability_denied' });
    }
    // Bước chống ghi trùng: chỉ đối chiếu ma trận của CHÍNH người
    // nhập trong bank đích có cùng định danh thô (tên/môn/chương
    // trình) rồi mới so chữ ký đầy đủ kèm ô — tránh nạp ô của mọi ma
    // trận trong bank.
    const signature = this.importedMatrixSignature(input);
    const candidates = (await this.repo.listMatricesByBank(bank.id))
      .filter((r) => r.createdBy === actorId && r.name === input.name
        && r.subjectId === subject.id && r.curriculumId === curriculum.id);
    for (const candidate of candidates) {
      const existingCells = await this.repo.listMatrixCells(candidate.id);
      if (this.importedMatrixSignature({ ...candidate, cells: existingCells }) === signature) {
        return this.matrixView(candidate);
      }
    }
    // Khuôn ma trận duy nhất là CV 7991 như createMatrix: tỉ lệ tham
    // chiếu chụp từ hằng cấu hình của preset duy nhất còn hiệu lực.
    const preset = MATRIX_PRESETS['cv7991_periodic'];
    const row = await this.repo.dbHandle.transaction(async (tx) => {
      const matrix = await this.repo.insertMatrix({
        tenantId: bank.tenantId,
        name: input.name, subjectId: subject.id, curriculumId: curriculum.id,
        contextId: subject.contextId, presetKind: 'cv7991_periodic',
        targetFormPercents: preset?.targetFormPercents ?? null,
        targetLevelPercents: preset?.targetLevelPercents ?? null,
        levelSet: input.levelSet,
        scopeNote: input.scopeNote,
        scopeNodeIds: input.scopeNodeIds,
        totalScore: input.totalScore,
        createdBy: actorId,
        bankId: bank.id,
        status: 'draft',
        isTemplate: false,
        derivedFromMatrixId: null,
      }, tx);
      for (const cell of input.cells) {
        await this.repo.insertMatrixCell({
          matrixId: matrix.id, curriculumNodeId: cell.curriculumNodeId,
          cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype,
          questionCount: cell.questionCount, cellScore: cell.cellScore,
          minutes: null, tfScale: null, position: cell.position,
        }, tx);
      }
      return matrix;
    });
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_created', payload: { matrixId: row.id, subjectId: subject.id, actorId } });
    return this.matrixView(row);
  }

  /** Đọc một ma trận kèm ô và cảnh báo lệch tỉ lệ (quiz:viewmatrix). */
  async getMatrix(actorId: string, matrixId: string): Promise<ExamMatrixView> {
    const row = await this.getMatrixRow(matrixId);
    // Ma trận thuộc tenant khác với tenant hiệu lực → 404 đồng nhất (TENANT-0, #168).
    const activeTenant = this.tenantContext.currentTenantId();
    if (activeTenant !== undefined && row.tenantId !== null && row.tenantId !== activeTenant) {
      throw new NotFoundException({ message: `Exam matrix ${matrixId} not found`, code: 'quiz.matrix_not_found' });
    }
    await this.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.viewMatrix);
    return this.matrixView(row);
  }

  /** Các ma trận của một môn (quiz:viewmatrix tại context của môn).
   * Ma trận thuộc bank personal của người khác bị loại khỏi danh sách
   * (issue #123) — danh sách theo môn không được rò ma trận riêng. */
  async listMatrices(actorId: string, subjectId: string): Promise<ExamMatrixView[]> {
    const subject = await this.curriculum.getSubject(actorId, subjectId);
    await this.evaluator.requireCapability(actorId, QUIZ_CAPABILITIES.viewMatrix, subject.contextId);
    const rows = await this.repo.listMatricesBySubject(subject.id);
    const foreignPersonalByBank = new Map<string, boolean>();
    const out: ExamMatrixView[] = [];
    for (const r of rows) {
      if (r.bankId) {
        let foreign = foreignPersonalByBank.get(r.bankId);
        if (foreign === undefined) {
          const bank = await this.banks.findBankById(r.bankId);
          foreign = bank ? await this.banks.isForeignPersonalBank(actorId, bank) : false;
          foreignPersonalByBank.set(r.bankId, foreign);
        }
        if (foreign) continue;
      }
      out.push(await this.matrixView(r));
    }
    return out;
  }

  /** Sửa ma trận (quiz:managematrix); thu hẹp bộ mức khi đã có ô dùng mức bị loại thì bị từ chối. */
  async updateMatrix(actorId: string, matrixId: string, input: UpdateExamMatrixDto): Promise<ExamMatrixView> {
    const row = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, row, QUIZ_CAPABILITIES.manageMatrix);
    // MB-1: CHUYỂN ma trận sang bank khác qua PATCH phải có thêm quyền
    // ghi tại bank đích — quyền ở bank nguồn không tự mang sang bank lạ.
    if (input.bankId !== undefined && input.bankId !== null && input.bankId !== row.bankId) {
      const target = await this.banks.findBankById(input.bankId);
      if (!target) throw new NotFoundException({ message: `Matrix bank ${input.bankId} not found`, code: 'quiz.matrix_bank_not_found' });
      if (target.bankKind !== 'matrix') {
        throw new BadRequestException({ message: 'Target bank is not a matrix bank', code: 'quiz.matrix_bank_kind_mismatch' });
      }
      await this.banks.syncBankMembership(target);
      const targetCaps = await this.banks.bankLocalMatrixCaps(actorId, target);
      if (!targetCaps.manage) {
        throw new ForbiddenException({ message: `Missing capability ${QUIZ_CAPABILITIES.manageMatrix} in matrix bank ${target.id}`, code: 'access.capability_denied' });
      }
    }
    if (input.levelSet === 'three' && row.levelSet !== 'three') {
      const cells = await this.repo.listMatrixCells(row.id);
      if (cells.some((c) => c.cognitiveLevel === 'van_dung_cao')) {
        throw new BadRequestException({ message: 'Cells already use van_dung_cao; remove them before switching to the three-level set', code: 'quiz.matrix_level_in_use' });
      }
    }
    const patch: Partial<ExamMatrixRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.targetFormPercents !== undefined) patch.targetFormPercents = input.targetFormPercents;
    if (input.targetLevelPercents !== undefined) patch.targetLevelPercents = input.targetLevelPercents;
    if (input.levelSet !== undefined) patch.levelSet = input.levelSet;
    if (input.scopeNote !== undefined) patch.scopeNote = input.scopeNote;
    if (input.scopeNodeIds !== undefined) patch.scopeNodeIds = input.scopeNodeIds;
    if (input.totalScore !== undefined) patch.totalScore = input.totalScore;
    if (input.bankId !== undefined) patch.bankId = input.bankId;
    if (input.status !== undefined) patch.status = input.status;
    if (input.isTemplate !== undefined) patch.isTemplate = input.isTemplate;
    // Ma trận đã ready (đã dùng sinh đề/đem duyệt) thì sửa nội dung
    // phải tăng version — bản đặc tả đã nộp khớp version tại thời điểm
    // nộp, không khớp bản đã sửa lặng lẽ.
    const contentChanged = ['name', 'targetFormPercents', 'targetLevelPercents', 'levelSet', 'scopeNote', 'scopeNodeIds', 'totalScore']
      .some((k) => (patch as Record<string, unknown>)[k] !== undefined);
    if (contentChanged && row.status !== 'draft') patch.version = row.version + 1;
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

  /**
   * Bản đặc tả sinh TRỰC TIẾP từ các ô, nên thay đổi ở tầng ô trên ma
   * trận đã rời draft cũng phải tăng version như sửa tầng ma trận (xem
   * updateMatrix) — nếu không, bản đặc tả đã nộp khớp version tại thời
   * điểm nộp nhưng không khớp nội dung ô đã bị sửa lặng lẽ sau đó.
   */
  private async bumpMatrixVersionIfNonDraft(matrix: ExamMatrixRow): Promise<void> {
    if (matrix.status !== 'draft') {
      await this.repo.updateMatrix(matrix.id, { version: matrix.version + 1 });
    }
  }

  private async getMatrixCellRow(matrix: ExamMatrixRow, cellId: string): Promise<ExamMatrixCellRow> {
    const row = await this.repo.getMatrixCell(cellId);
    if (!row || row.matrixId !== matrix.id) {
      throw new NotFoundException({ message: `Exam matrix cell ${cellId} not found`, code: 'quiz.matrix_cell_not_found' });
    }
    return row;
  }

  /**
   * Thêm ô vào ma trận (quiz:managematrix): ĐƠN VỊ KIẾN THỨC phải
   * thuộc chương trình của ma trận (ô neo ĐVK — issue #249, ma trận
   * không gắn YCCĐ), mức phải thuộc bộ mức của ma trận, và khi ma
   * trận có phạm vi đã dạy (scope_node_ids) thì ĐVK phải nằm trong
   * phạm vi.
   */
  async createMatrixCell(actorId: string, matrixId: string, input: CreateExamMatrixCellDto): Promise<ExamMatrixView> {
    const matrix = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    this.assertValidTfScale(input.tfScale);
    if (matrix.levelSet === 'three' && input.cognitiveLevel === 'van_dung_cao') {
      throw new BadRequestException({ message: 'van_dung_cao is not part of the three-level set of this matrix', code: 'quiz.matrix_level_not_in_set' });
    }
    if (matrix.scopeNodeIds && matrix.scopeNodeIds.length && !matrix.scopeNodeIds.includes(input.curriculumNodeId)) {
      throw new BadRequestException({ message: 'Curriculum node is outside the taught scope of this matrix', code: 'quiz.matrix_cell_out_of_scope' });
    }
    const node = await this.curriculum.getNode(actorId, input.curriculumNodeId);
    if (node.curriculumId !== matrix.curriculumId) {
      throw new BadRequestException({ message: 'Curriculum node does not belong to the curriculum of this matrix', code: 'quiz.matrix_cell_node_mismatch' });
    }
    const cells = await this.repo.listMatrixCells(matrix.id);
    if (cells.some((c) => c.curriculumNodeId === input.curriculumNodeId && c.cognitiveLevel === input.cognitiveLevel && c.qtype === input.qtype)) {
      throw new BadRequestException({ message: 'A cell already exists for this curriculum node, level and question type', code: 'quiz.matrix_cell_exists' });
    }
    const position = input.position ?? (cells.length ? Math.max(...cells.map((c) => c.position)) + 1 : 1);
    await this.repo.insertMatrixCell({
      matrixId: matrix.id, curriculumNodeId: input.curriculumNodeId,
      cognitiveLevel: input.cognitiveLevel, qtype: input.qtype,
      questionCount: input.questionCount, cellScore: input.cellScore,
      minutes: input.minutes ?? null, tfScale: input.tfScale ?? null, position,
    });
    await this.bumpMatrixVersionIfNonDraft(matrix);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_cell_created', payload: { matrixId: matrix.id, actorId } });
    return this.matrixView(await this.getMatrixRow(matrixId));
  }

  /** Sửa một ô (quiz:managematrix) — khoá ĐVK/mức/dạng không đổi qua sửa; muốn đổi thì xoá ô tạo lại. */
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
    if (Object.keys(patch).length) {
      await this.repo.updateMatrixCell(cell.id, patch);
      await this.bumpMatrixVersionIfNonDraft(matrix);
    }
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_cell_updated', payload: { matrixId: matrix.id, cellId: cell.id, actorId } });
    return this.matrixView(await this.getMatrixRow(matrixId));
  }

  /** Xoá một ô khỏi ma trận (quiz:managematrix). */
  async deleteMatrixCell(actorId: string, matrixId: string, cellId: string): Promise<ExamMatrixView> {
    const matrix = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    const cell = await this.getMatrixCellRow(matrix, cellId);
    await this.repo.deleteMatrixCell(cell.id);
    await this.bumpMatrixVersionIfNonDraft(matrix);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'exam_matrix_cell_deleted', payload: { matrixId: matrix.id, cellId: cell.id, actorId } });
    return this.matrixView(await this.getMatrixRow(matrixId));
  }

  /**
   * Ứng viên thô của một ô: câu ready gắn BẤT KỲ YCCĐ nào thuộc ĐVK
   * của ô ở đúng mức của ô, đúng dạng (qua
   * question_learning_outcomes / Curriculum Chặng 2 — mức nằm trên
   * dòng nối câu × YCCĐ; issue #249). Chưa xét quyền dùng ngân hàng
   * của người gọi.
   */
  private async cellCandidates(cell: Pick<ExamMatrixCellRow, 'curriculumNodeId' | 'cognitiveLevel' | 'qtype'>): Promise<QuestionView[]> {
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
  private async cellCandidatesForUser(actorId: string, cell: Pick<ExamMatrixCellRow, 'curriculumNodeId' | 'cognitiveLevel' | 'qtype'>): Promise<QuestionView[]> {
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
  // Signature giữ dạng Pick 3 trường như phía main (không lấy dạng
  // hàng đầy đủ của P5): đường importAvailability (lát I-1) gọi hàm
  // này bằng ô DỰ THẢO chưa có bản ghi DB, trong khi thân hàm chỉ
  // chuyển tiếp cell sang cellCandidatesForUser (cũng chỉ cần 3
  // trường này) — siết thành hàng đầy đủ sẽ phá đường I-1 mà không
  // đổi hành vi nào. Việc bỏ chùm của P5 (xoá tfClustersOf) giữ nguyên.
  private async cellAvailableCount(actorId: string, cell: Pick<ExamMatrixCellRow, 'curriculumNodeId' | 'cognitiveLevel' | 'qtype'>): Promise<number> {
    const candidates = await this.cellCandidatesForUser(actorId, cell);
    return candidates.length;
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

  /**
   * Khả dụng ngân hàng cho các ô DỰ THẢO của đường nhập ma trận từ
   * file (lát I-1, issue #233): ô chưa có bản ghi DB nên không có
   * cellId — kết quả neo theo bộ ba (ĐVK, mức, dạng) của ô dự thảo.
   * Cùng một cơ chế đếm ứng viên với {@link matrixAvailability} (câu
   * ready gắn bất kỳ YCCĐ nào thuộc ĐVK ở đúng mức, lọc theo quyền
   * dùng ngân hàng của người gọi; Đúng–Sai đếm theo chùm).
   */
  async importAvailability(actorId: string, cells: { curriculumNodeId: string; cognitiveLevel: string; qtype: string; questionCount: number }[]): Promise<MatrixImportCellAvailability[]> {
    const out: MatrixImportCellAvailability[] = [];
    for (const cell of cells) {
      const available = await this.cellAvailableCount(actorId, cell);
      out.push({
        curriculumNodeId: cell.curriculumNodeId,
        cognitiveLevel: cell.cognitiveLevel as MatrixImportCellAvailability['cognitiveLevel'],
        qtype: cell.qtype as MatrixImportCellAvailability['qtype'],
        required: cell.questionCount, available, deficit: Math.max(0, cell.questionCount - available),
      });
    }
    return out;
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
    deficits: { cellId: string; curriculumNodeId: string; cognitiveLevel: string; qtype: string; required: number; available: number; deficit: number }[];
    pools: Map<string, { candidates: QuestionView[] }>;
  }> {
    const deficits: { cellId: string; curriculumNodeId: string; cognitiveLevel: string; qtype: string; required: number; available: number; deficit: number }[] = [];
    const pools = new Map<string, { candidates: QuestionView[] }>();
    for (const cell of cells) {
      const candidates = await this.cellCandidatesForUser(actorId, cell);
      pools.set(cell.id, { candidates });
      const available = candidates.length;
      if (available < cell.questionCount) {
        deficits.push({
          cellId: cell.id, curriculumNodeId: cell.curriculumNodeId,
          cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype,
          required: cell.questionCount, available, deficit: cell.questionCount - available,
        });
      }
    }
    return { deficits, pools };
  }

  // --- Facade cho EB-2 (generate hai bước matrix → paper → deploy) -------------

  /**
   * Đọc ma trận cho generate (cổng quiz:managematrix tại context của
   * bank — E-8 qua requireMatrixCap) + các ô. EB-2: ExamsService
   * là phía điều phối generate; QuizService chỉ còn là nguồn dữ liệu
   * ma trận/pool và phía ghi slots vào quiz.
   */
  async matrixForGeneration(actorId: string, matrixId: string): Promise<{ matrix: ExamMatrixRow; cells: ExamMatrixCellRow[] }> {
    const matrix = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.manageMatrix);
    const cells = await this.repo.listMatrixCells(matrix.id);
    if (!cells.length) {
      throw new BadRequestException({ message: 'This matrix has no cells yet', code: 'quiz.matrix_empty' });
    }
    return { matrix, cells };
  }

  /**
   * Rút MỘT bộ câu cố định cho các ô (cơ chế fixed của Chặng 3, tách
   * ra dùng chung cho generate snapshot + materialize recipe ở
   * EB-2): thiếu câu ở BẤT KỲ ô nào → 422
   * `quiz.matrix_insufficient_questions` kèm chi tiết từng ô, không
   * rút một phần. Không lặp câu trong toàn bộ; mọi ô — kể cả ô
   * truefalse — rút theo CÂU (một câu TF-A là một slot nguyên vẹn
   * mang trọn điểm của một đơn vị ô, không chia phần cho từng ý).
   * page = thứ tự của ô trong ma trận.
   */
  async drawFixedSlots(actorId: string, cells: ExamMatrixCellRow[]): Promise<{
    questionId: string; matrixCellId: string; maxMark: number; page: number;
  }[]> {
    const { deficits, pools } = await this.matrixDeficits(actorId, cells);
    if (deficits.length) {
      throw new UnprocessableEntityException({
        message: deficits.map((d) => `cell ${d.cellId} (node ${d.curriculumNodeId}, ${d.cognitiveLevel}/${d.qtype}): required ${d.required}, available ${d.available}, deficit ${d.deficit}`),
        code: 'quiz.matrix_insufficient_questions',
      });
    }
    const chosen = new Set<string>();
    const out: { questionId: string; matrixCellId: string; maxMark: number; page: number }[] = [];
    let page = 0;
    for (const cell of cells) {
      page += 1;
      const pool = pools.get(cell.id)!;
      const perUnit = cell.cellScore / cell.questionCount;
      const fresh = this.shuffled(pool.candidates.filter((v) => !chosen.has(v.question.id)));
      let picked = fresh.slice(0, cell.questionCount);
      if (picked.length < cell.questionCount) {
        const rest = this.shuffled(pool.candidates.filter((v) => !picked.some((p) => p.question.id === v.question.id)));
        picked = [...picked, ...rest.slice(0, cell.questionCount - picked.length)];
      }
      for (const member of picked) {
        out.push({ questionId: member.question.id, matrixCellId: cell.id, maxMark: perUnit, page });
        chosen.add(member.question.id);
      }
    }
    return out;
  }

  /** Câu có thuộc pool của ô hay không (pool thô theo ĐVK + mức + dạng + ready — điểm neo swap-cùng-ô của EB-2 như swapSlot đã dùng). */
  async cellPoolContains(cellId: string, questionId: string): Promise<boolean> {
    const cell = await this.repo.getMatrixCell(cellId);
    if (!cell) return false;
    const candidates = await this.cellCandidates(cell);
    return candidates.some((v) => v.question.id === questionId);
  }

  /** Đề đã có lượt làm thật thì cấu trúc slots đóng băng (đúng ngữ nghĩa Chặng 1: attempt đã pin câu). */
  private async assertNoRealAttempts(quiz: PinRow): Promise<void> {
    const attempts = await this.repo.listAttempts(quiz.id);
    if (attempts.some((a) => !a.preview)) {
      throw new BadRequestException({ message: 'This quiz already has real attempts; its slots are frozen', code: 'quiz.slots_frozen' });
    }
  }

  /**
   * Dựng view model bản đặc tả theo Mẫu 2 của phụ lục CV 7991: hàng
   * Chủ đề → Nội dung/đơn vị kiến thức → YCCĐ (cột YCCĐ = mọi YCCĐ
   * thuộc ĐVK của ô: nguyên văn chương trình `source_kind='program'`
   * + bản tách mức của tổ chuyên môn `derived`), cột số câu/điểm
   * theo dạng × mức từ các ô;
   * khi đã sinh đề (pinId của đề sinh từ chính ma trận này) thì thêm
   * vị trí slot thật — đề per_student ghi rõ rút ngẫu nhiên theo ô.
   * Chân bảng: tổng theo dạng (điểm + %). Trường nhãn năng lực để dành
   * trong view model (competencyRefs) — chặng này chưa có cơ chế gắn
   * mã năng lực vào outcome nên luôn rỗng.
   */
  async getMatrixSpecification(actorId: string, matrixId: string, pinId?: string): Promise<MatrixSpecification> {
    const matrix = await this.getMatrixRow(matrixId);
    await this.requireMatrixCap(actorId, matrix, QUIZ_CAPABILITIES.viewMatrix);
    let quiz: PinRow | null = null;
    let slots: SpecificationSlot[] | null = null;
    if (pinId) {
      quiz = await this.getPin(pinId);
      if (quiz.matrixId !== matrix.id) {
        throw new BadRequestException({ message: 'The quiz was not generated from this matrix', code: 'quiz.spec_quiz_mismatch' });
      }
      slots = (await this.effectiveSlots(quiz)).map((s) => ({
        matrixCellId: s.matrixCellId, slot: s.slot, questionId: s.questionId,
      }));
    }
    return this.buildSpecification(actorId, matrix, {
      quiz: quiz ? { id: quiz.id, name: quiz.name } : null, slots,
    });
  }

  /**
   * Bản đặc tả neo theo ĐỀ (EB-3, điểm E-6 của hồ sơ ngân hàng đề):
   * cùng một builder với đặc tả theo ma trận, nhưng vị trí câu lấy từ
   * SLOTS CỦA PAPER VERSION đã ghim (đề là neo chính; quiz chỉ là một
   * lần triển khai của đề). Hàm này KHÔNG tự gác capability của ma
   * trận — cổng quyền nằm ở phía gọi (ExamPapersService gác theo đề,
   * gồm lớp bảo mật đề định kỳ A.3.4).
   */
  async buildSpecificationForPaper(actorId: string, matrixId: string, paperSlots: { matrixCellId: string | null; position: number; questionId: string | null }[]): Promise<MatrixSpecification> {
    const matrix = await this.getMatrixRow(matrixId);
    return this.buildSpecification(actorId, matrix, {
      quiz: null,
      slots: paperSlots.map((s) => ({ matrixCellId: s.matrixCellId, slot: s.position, questionId: s.questionId })),
    });
  }

  /** Thông tin tối thiểu của một quiz cho đặc tả theo đề (EB-3): phía gọi tự kiểm quiz có thuộc đề đang xét hay không. */
  async getPinSummary(pinId: string): Promise<{ id: string; name: string; examId: string | null; matrixId: string | null } | null> {
    const row = await this.repo.getPin(pinId);
    if (!row) return null;
    const quiz = await this.enrichPin(row);
    return { id: quiz.id, name: quiz.name, examId: quiz.examId, matrixId: quiz.matrixId };
  }

  /**
   * Builder dùng chung của bản đặc tả: lưới ô của ma trận + (tuỳ
   * chọn) vị trí câu của một tập slot cụ thể — slot của quiz (đặc tả
   * theo ma trận, C.6) hoặc slot của paper version (đặc tả theo đề,
   * E-6). `slots = null` nghĩa là bản đặc tả dự kiến chưa có vị trí.
   */
  private async buildSpecification(actorId: string, matrix: ExamMatrixRow, opts: {
    quiz: { id: string; name: string } | null;
    slots: SpecificationSlot[] | null;
  }): Promise<MatrixSpecification> {
    const subject = await this.curriculum.getSubject(actorId, matrix.subjectId);
    const curriculum = await this.curriculum.getCurriculum(actorId, matrix.curriculumId);
    const cells = await this.repo.listMatrixCells(matrix.id);
    const slots = opts.slots;
    const nodeCache = new Map<string, Awaited<ReturnType<CurriculumService['getNode']>>>();
    const getNode = async (id: string) => {
      let node = nodeCache.get(id);
      if (!node) {
        node = await this.curriculum.getNode(actorId, id);
        nodeCache.set(id, node);
      }
      return node;
    };
    type OutcomeAcc = MatrixSpecification['topics'][number]['nodes'][number]['outcomes'][number];
    // Mã bản ghi theo node (tra sổ đăng ký) — đệm theo node để mỗi
    // node chỉ tra một lần trong một lượt dựng đặc tả.
    const recordIdByNode = new Map<string, string | null>();
    const recordIdForNode = async (nodeId: string): Promise<string | null> => {
      let recordId = recordIdByNode.get(nodeId);
      if (recordId === undefined) {
        recordId = await this.curriculum.programRecordIdForNode(nodeId);
        recordIdByNode.set(nodeId, recordId);
      }
      return recordId;
    };
    /** Mã YCCĐ vị trí từ mã bản ghi + position; null khi node không thuộc dataset. */
    const outcomeCode = (recordId: string | null, position: number): string | null =>
      (recordId ? `${recordId}.${String(position).padStart(2, '0')}` : null);
    type NodeCells = MatrixSpecification['topics'][number]['nodes'][number]['cells'];
    const topicMap = new Map<string, { topicId: string | null; topicTitle: string; nodes: Map<string, { nodeId: string; nodeTitle: string; outcomes: Map<string, OutcomeAcc>; cells: NodeCells }> }>();
    const byForm = new Map<string, { qtype: string; questionCount: number; score: number }>();
    let totalQuestions = 0;
    for (const cell of cells) {
      // Ô neo ĐVK (issue #249): cột YCCĐ của bản đặc tả = MỌI YCCĐ
      // thuộc ĐVK của ô (program + derived tách mức như trước).
      const node = await getNode(cell.curriculumNodeId);
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
        nodeAcc = { nodeId: node.id, nodeTitle: node.title, outcomes: new Map(), cells: [] };
        topicAcc.nodes.set(node.id, nodeAcc);
        // listOutcomes mặc định đã loại dòng program ĐÃ RÚT. Derived
        // mang trạng thái hiện hành của GỐC: gốc đã rút (hoặc không
        // còn tra được) thì derived cũng rời bản đặc tả — cùng một
        // định nghĩa "hiện hành" với pool sinh đề (issue #161).
        const outcomes = await this.curriculum.listOutcomes(actorId, node.id);
        for (const outcome of outcomes) {
          let programContent: string | null = null;
          let derivedContent: string | null = null;
          let position: number | null = outcome.position;
          let code: string | null = null;
          if (outcome.sourceKind === 'derived' && outcome.derivedFromId) {
            const parent = await this.curriculum.getOutcome(actorId, outcome.derivedFromId).catch(() => undefined);
            if (!parent || parent.retiredAt !== null) continue;
            programContent = parent.content;
            derivedContent = outcome.content;
            // Derived là ý tách của gốc: position/mã là của dòng gốc.
            position = parent.position;
            code = outcomeCode(await recordIdForNode(parent.nodeId), parent.position);
          } else {
            programContent = outcome.content;
            code = outcomeCode(await recordIdForNode(node.id), outcome.position);
          }
          nodeAcc.outcomes.set(outcome.id, {
            outcomeId: outcome.id, content: outcome.content, sourceKind: outcome.sourceKind,
            sourceRef: outcome.sourceRef, programContent, derivedContent, position, code,
          });
        }
      }
      const cellSlots = slots ? slots.filter((s) => s.matrixCellId === cell.id) : [];
      const perStudent = cellSlots.length > 0 && cellSlots.every((s) => s.questionId === null);
      nodeAcc.cells.push({
        cellId: cell.id, cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype,
        questionCount: cell.questionCount, cellScore: cell.cellScore, minutes: cell.minutes,
        slotNumbers: slots ? cellSlots.map((s) => s.slot).sort((a, b) => a - b) : null,
        drawNote: slots && perStudent ? 'Rút ngẫu nhiên theo ô' : null,
        competencyRefs: [],
      });
      const formAcc = byForm.get(cell.qtype) ?? { qtype: cell.qtype, questionCount: 0, score: 0 };
      formAcc.questionCount += cell.questionCount;
      formAcc.score += cell.cellScore;
      byForm.set(cell.qtype, formAcc);
      totalQuestions += cell.questionCount;
    }
    const totalScore = cells.reduce((s, c) => s + c.cellScore, 0);
    const formTotals = [...byForm.values()].map((f) => ({
      ...f, percent: totalScore > 0 ? Math.round((f.score / totalScore) * 1000) / 10 : 0,
    }));
    const purpose = `Đề kiểm tra định kỳ môn ${subject.name} (lớp ${curriculum.grade}) xây dựng theo hướng dẫn của Công văn 7991/BGDĐT-GDTrH, bám sát yêu cầu cần đạt của Chương trình GDPT 2018.`;
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
          cells: n.cells,
        })),
      })),
      totals: { byForm: formTotals, totalScore, totalQuestions },
      quiz: opts.quiz,
    };
  }

  /**
   * Xuất bản đặc tả ra file (xlsx qua exceljs — cùng hạ tầng với xuất
   * điểm vnEdu; docx qua gói docx): cùng một view model, hai định dạng
   * nộp/lưu hồ sơ. Định dạng khác → 400 quiz.spec_export_format.
   */
  async exportMatrixSpecification(actorId: string, matrixId: string, format: string, pinId?: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    if (format !== 'xlsx' && format !== 'docx') {
      throw new BadRequestException({ message: 'Specification export format must be xlsx or docx', code: 'quiz.spec_export_format' });
    }
    const spec = await this.getMatrixSpecification(actorId, matrixId, pinId);
    return this.renderSpecification(spec, format);
  }

  /**
   * Render một view model đặc tả ra file (xlsx qua exceljs — cùng hạ
   * tầng với xuất điểm vnEdu; docx qua gói docx): dùng chung cho đặc
   * tả theo ma trận (C.6), đặc tả theo đề và bản chụp trong bộ hồ sơ
   * (EB-3) — cùng một view model, hai định dạng nộp/lưu hồ sơ.
   */
  async renderSpecification(spec: MatrixSpecification, format: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    if (format !== 'xlsx' && format !== 'docx') {
      throw new BadRequestException({ message: 'Specification export format must be xlsx or docx', code: 'quiz.spec_export_format' });
    }
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
  private async requireAnyViewCap(actorId: string, quiz: PinRow): Promise<void> {
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
  async resolveEffectiveSettings(quiz: PinRow, userId: string): Promise<EffectiveQuizSettings> {
    const overrides = await this.repo.listOverrides(quiz.id);
    const userOverride = overrides.find((o) => o.userId === userId);
    let groupOverrides: ExamPinOverrideRow[] = [];
    if (overrides.some((o) => o.groupId !== null)) {
      const myGroupIds = new Set((await this.groups.groupsOfUser(quiz.course, userId)).map((g) => g.id));
      groupOverrides = overrides.filter((o) => o.groupId !== null && myGroupIds.has(o.groupId));
    }
    const hasGroups = groupOverrides.length > 0;
    // Giá trị hợp nhất của nhóm cho một trường ngày giờ: undefined = không có override nhóm nào;
    // null = có nhóm không giới hạn trường này (thắng); ngược lại lấy mốc rộng nhất.
    const mergeDate = (pick: (o: ExamPinOverrideRow) => Date | null, widest: 'min' | 'max'): Date | null | undefined => {
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
      userOverrideId: userOverride?.id ?? null,
      groupOverrideIds: groupOverrides.map((o) => o.id),
    };
  }

  /** Học sinh còn được bắt đầu lượt mới hay không, và vì sao không (mọi kiểm tra đều trên cài đặt HIỆU LỰC của chính học sinh). */
  private async attemptEligibility(quiz: PinRow, userId: string, now: Date): Promise<{
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
    // Khoảng chờ giữa hai lượt (delay1/delay2 của quiz cũ) đã bỏ
    // hẳn khỏi mô hình pin — không còn cổng chờ giữa các lượt.
    if (quiz.lateEntryMinutes !== null && effective.timeOpen
      && now.getTime() > effective.timeOpen.getTime() + quiz.lateEntryMinutes * 60_000) {
      return { canAttempt: false, reason: 'late_entry_closed', inProgressAttemptId: null, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
    }
    const slots = await this.effectiveSlots(quiz);
    if (!slots.length) return { canAttempt: false, reason: 'no_questions', inProgressAttemptId: null, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
    return { canAttempt: true, reason: null, inProgressAttemptId: null, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
  }

  /**
   * Điểm bài hiện tại của một học sinh theo grade_method của quiz (null
   * khi chưa có lượt nào chốt điểm).
   */
  async currentGradeForUser(quiz: PinRow, userId: string): Promise<number | null> {
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
  async getQuizForUser(actorId: string, pinId: string): Promise<{
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
    const quiz = await this.getPin(pinId);
    await this.requireAnyViewCap(actorId, quiz);
    const view = await this.pinView(quiz);
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
    // Phạm vi nhóm đích: người xem không có vai trò nhân sự (quản
    // lý/chấm/báo cáo/preview) mà không thuộc nhóm đích thì lần ghim
    // coi như không tồn tại (404 — không lộ sự tồn tại).
    const isStaffViewer = manage || grade || viewReports || preview;
    if (!isStaffViewer && !(await this.isInTargetGroup(quiz, actorId))) {
      throw new NotFoundException({ message: `Exam pin ${pinId} not found`, code: 'exam.pin_not_found' });
    }
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

  /**
   * Bắt đầu lượt làm mới (hoặc trả về lượt đang dở để tiếp tục): kiểm cửa
   * sổ mở–đóng và số lần cho phép phía server, rút câu cho slot ngẫu
   * nhiên, tạo usage của engine với maxMark lấy từ TỪNG SLOT, pin phiên
   * bản câu ngay lúc bắt đầu. Preview của giáo viên (quiz:preview)
   * bỏ qua cửa sổ/giới hạn và không ghi điểm về sau.
   */
  async startAttempt(actorId: string, pinId: string, opts: { preview?: boolean; password?: string; clientIp?: string } = {}): Promise<QuizAttemptView> {
    const quiz = await this.getPin(pinId);
    const preview = opts.preview === true;
    if (preview) {
      await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.preview);
    } else {
      await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.attempt);
      await this.courses.assertCourseAccess(actorId, quiz.course);
      // Phạm vi nhóm đích: học sinh ngoài nhóm đích không mở được
      // lượt làm của lần ghim này (403 như các cổng thi khác).
      if (!(await this.isInTargetGroup(quiz, actorId))) {
        throw new ForbiddenException({ message: 'This exam is limited to a specific group of this course', code: 'exam.pin_not_in_target_group' });
      }
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
    let effectiveForSnapshot: EffectiveQuizSettings | null = null;
    if (!preview) {
      // Mọi cổng đều xét trên cài đặt HIỆU LỰC của người này (override
      // đã hợp nhất) — preview của giáo viên bỏ qua tất cả.
      const effective = await this.resolveEffectiveSettings(quiz, actorId);
      effectiveForSnapshot = effective;
      if (effective.timeOpen && now < effective.timeOpen) {
        throw new ForbiddenException({ message: 'This quiz is not open yet', code: 'quiz.not_yet_open' });
      }
      // Trễ vào thi: quá mốc mở hiệu lực + late_entry_minutes thì từ
      // chối dù cửa sổ còn mở (preset thi thử: 15 phút, Điều 21
      // TT 24/2024).
      if (quiz.lateEntryMinutes !== null && effective.timeOpen
        && now.getTime() > effective.timeOpen.getTime() + quiz.lateEntryMinutes * 60_000) {
        throw new ForbiddenException({ message: 'The late-entry window for this quiz has passed', code: 'quiz.late_entry_closed' });
      }
      if (effective.timeClose && now > effective.timeClose) {
        throw new ForbiddenException({ message: 'This quiz is closed', code: 'quiz.closed' });
      }
      const mine = existing.filter((a) => !a.preview);
      if (effective.attemptsAllowed > 0 && mine.length >= effective.attemptsAllowed) {
        throw new ForbiddenException({ message: 'No more attempts are allowed for this quiz', code: 'quiz.no_more_attempts' });
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
    const slots = await this.effectiveSlots(quiz);
    if (!slots.length) throw new BadRequestException({ message: 'This quiz has no questions yet', code: 'quiz.no_questions' });

    // Attempt đọc THẲNG slots đã ghim của exam version (bỏ hẳn đường
    // rút câu lúc bắt đầu lượt của recipe/per_student — chốt 26/10):
    // mọi slot hiệu lực đều đã có câu + version ghim, hai học sinh làm
    // cùng một pin nhận CÙNG một bộ câu.
    const resolvedSlots: { quizSlot: EffectiveSlotRow; questionId: string }[] = [];
    for (const s of slots) {
      if (!s.questionId) {
        throw new BadRequestException({ message: `Slot ${s.slot} of this pin has no pinned question`, code: 'exam.pin_slot_unresolved' });
      }
      resolvedSlots.push({ quizSlot: s, questionId: s.questionId });
    }

    // Moodle dùng MỘT dãy số lượt cho mỗi (bài, user) — preview chỉ là
    // cờ trên lượt, không phải dãy riêng: ràng buộc duy nhất của
    // exam_attempts là (pin_id, user_id, attempt_number) không phân
    // biệt preview, đánh số riêng theo cờ sẽ va chạm khi một người vừa
    // preview vừa làm thật.
    const attemptNumber = existing.length + 1;
    const usage = await this.questions.createUsage(actorId, {
      component: QUIZ_COMPONENT, instanceId: quiz.id, contextId: await this.cmContextId(quiz),
      slots: resolvedSlots.map((e) => ({
        questionId: e.questionId, maxMark: e.quizSlot.maxMark,
        // Chế độ tham chiếu version của pin (issue #254): pin `pinned`
        // truyền version đã ghim trong exam version xuống engine (mọi
        // lượt cùng một version); pin `float_latest_ready` KHÔNG truyền
        // version — engine tự phân giải bản ready mới nhất của câu tại
        // lúc bắt đầu lượt này rồi ghim cứng vào attempt (lượt đã bắt
        // đầu không trôi theo bản mới hơn xuất hiện sau đó).
        pinnedVersionId: quiz.versionMode === 'float_latest_ready'
          ? undefined
          : (e.quizSlot.pinnedVersionId ?? undefined),
      })),
    });
    // Nhãn kiểm tra bù + snapshot quy tắc đã áp: lượt bắt đầu trong cửa
    // sổ CHỈ tồn tại nhờ user override mở riêng (mốc mở của override
    // khác mốc mở gốc của quiz) là lượt bù; snapshot ghim toàn bộ quy
    // tắc hiệu lực + nguồn override + thứ tự câu đã rút cho lượt này.
    const eff = effectiveForSnapshot;
    const userOv = eff?.userOverrideId ? (await this.repo.listOverrides(quiz.id)).find((o) => o.id === eff.userOverrideId) : undefined;
    const makeup = !preview && !!userOv && userOv.timeOpen !== null
      && (quiz.timeOpen === null || userOv.timeOpen.getTime() !== quiz.timeOpen.getTime());
    const appliedSettings: Record<string, unknown> | null = preview || !eff ? null : {
      timeOpen: eff.timeOpen?.toISOString() ?? null,
      timeClose: eff.timeClose?.toISOString() ?? null,
      timeLimitSeconds: eff.timeLimit,
      attemptsAllowed: eff.attemptsAllowed,
      passwordRequired: eff.passwordRequired,
      subnet: eff.subnet,
      preset: (quiz.preset as QuizView['preset']) ?? null,
      versionMode: quiz.versionMode,
      lateEntryMinutes: quiz.lateEntryMinutes,
      monitorEvents: quiz.monitorEvents,
      userOverrideId: eff.userOverrideId,
      groupOverrideIds: eff.groupOverrideIds,
      questionOrder: resolvedSlots.map((e) => e.questionId),
    };
    try {
      await this.questions.startUsage(actorId, usage.usage.id);
      const row = await this.repo.insertAttempt({
        pinId: quiz.id, userId: actorId, attemptNumber, usageId: usage.usage.id,
        state: 'inprogress', preview, timeStart: now,
        makeup, appliedSettings,
      });
      await this.outbox.enqueueStandalone({
        aggregate: 'quiz', type: 'quiz_attempt_started',
        payload: { pinId: quiz.id, courseId: quiz.course, attemptId: row.id, usageId: row.usageId, userId: actorId, attemptNumber, preview, actorId },
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
  private assertSubnetAllowed(quiz: PinRow, clientIp: string | undefined): void {
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
  private async attemptDeadline(quiz: PinRow, row: ExamAttemptRow): Promise<Date | null> {
    const effective = await this.resolveEffectiveSettings(quiz, row.userId);
    let deadline: number | null = null;
    if (effective.timeLimit) deadline = row.timeStart.getTime() + effective.timeLimit * 1000;
    if (effective.timeClose) {
      const close = effective.timeClose.getTime();
      deadline = deadline === null ? close : Math.min(deadline, close);
    }
    return deadline === null ? null : new Date(deadline);
  }
  private async isOverdue(quiz: PinRow, row: ExamAttemptRow): Promise<boolean> {
    const deadline = await this.attemptDeadline(quiz, row);
    return deadline !== null && new Date() > deadline;
  }

  /**
   * Cửa sổ xem lại hiện tại của một lượt ĐÃ NỘP xét cho chủ lượt:
   * ngay sau nộp (2 phút từ time_finish) → sau đó khi đợt còn mở → sau
   * khi đóng. Mốc đóng ở đây là mốc đóng MUỘN NHẤT CỦA CẢ ĐỢT
   * (max timeClose của quiz và mọi override), KHÔNG phải mốc hiệu lực
   * của riêng chủ lượt: các ca thi lệch nhau vì override mà dùng mốc
   * riêng thì ca sớm xem được đáp án đúng trong khi ca sau chưa thi —
   * lộ đề (hồ sơ thi trực tuyến VN điểm 5.1.4). Đợt không có mốc đóng
   * thì không bao giờ sang cửa sổ sau-đóng.
   */
  private async reviewWindowBit(quiz: PinRow, row: ExamAttemptRow, now: Date): Promise<number> {
    const finish = row.timeFinish?.getTime() ?? now.getTime();
    if (now.getTime() < finish + REVIEW_IMMEDIATELY_AFTER_MS) return REVIEW_WINDOW.immediatelyAfter;
    const session = await this.repo.sessionLatestClose(quiz.id);
    if (session.hasUnbounded || session.latest === null || now <= session.latest) return REVIEW_WINDOW.laterWhileOpen;
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
  async buildAttemptView(quiz: PinRow, row: ExamAttemptRow, closedDueToTimeLimit: boolean, viewerId?: string): Promise<QuizAttemptView> {
    const usage = await this.questions.getUsage(row.usageId);
    const slots = await this.effectiveSlots(quiz);
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
      // Phía đáp án của version đang dùng cho câu này (guidance +
      // solution lưu trữ): mặc định lấy của version mới nhất, có
      // version đã pin thì lấy đúng của version đã pin.
      let pinnedAnswers = qv.answers;
      let answerKey = qv.answerKey;
      if (a.questionVersionId) {
        const pinned = await this.questions.getVersionContent(a.questionId, a.questionVersionId);
        questionText = pinned.version.questionText as RichTextDocument;
        answers = pinned.answers.map((x) => ({ id: x.id, text: x.answer as RichTextDocument }));
        pinnedAnswers = pinned.answers;
        answerKey = pinned.answerKey;
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
      // Step chấm tay gần nhất có nhận xét: engine ghi data.gradedBy +
      // data.comment khi giáo viên chấm tay (manualGradeAttempt); các
      // step khác (trả lời/chấm tự động) không mang gradedBy.
      const manualCommentStep = [...a.steps]
        .sort((x, y) => x.sequenceNumber - y.sequenceNumber)
        .reverse()
        .find((s) => s.data.gradedBy != null && typeof s.data.comment === 'string' && s.data.comment !== '');
      // Solution HIỂN THỊ suy từ phía đáp án của version: đáp án đúng
      // của multichoice/shortanswer nằm ở cờ isCorrect của các dòng
      // answers; truefalse TF-A đáp án từng mệnh đề và essay lời giải
      // mẫu đều nằm ở bản ghi phía đáp án (truefalse đổi hình dạng lưu
      // trữ {answers} sang hình dạng hiển thị {statements}). Chỉ tính
      // khi cổng reviewRightAnswer mở — cổng đóng thì trường này null,
      // dữ liệu đáp án đúng không rời server.
      let solution: QuestionSolution | null = null;
      if (aspectOn(quiz.reviewRightAnswer)) {
        if (qv.question.qtype === 'essay') {
          solution = (answerKey.solution as QuestionSolution | null) ?? null;
        } else if (qv.question.qtype === 'truefalse') {
          const stored = answerKey.solution as { answers?: { statementId: string; value: boolean }[] } | null;
          solution = stored?.answers?.length
            ? { statements: stored.answers.map((a) => ({ statementId: a.statementId, value: a.value === true })) }
            : null;
        } else if (qv.question.qtype === 'shortanswer') {
          const accepted = pinnedAnswers.filter((x) => x.isCorrect)
            .map((x) => extractRichTextPlainText(x.answer as RichTextDocument).trim())
            .filter((x) => x !== '');
          solution = accepted.length ? { acceptedAnswers: accepted } : null;
        } else {
          const correctRow = pinnedAnswers.find((x) => x.isCorrect);
          solution = correctRow ? { correctAnswerId: correctRow.id } : null;
        }
      }
      const excerptText = extractRichTextPlainText(questionText).trim();
      questions.push({
        slot: a.slot,
        page: pageBySlot.get(a.slot) ?? 1,
        questionAttemptId: a.id,
        questionId: a.questionId,
        qtype: qv.question.qtype,
        questionExcerpt: excerptText.length > 120 ? `${excerptText.slice(0, 120)}…` : excerptText,
        questionText,
        guidance: (answerKey.guidance ?? null) as RichTextDocument | null,
        solution,
        stimulus,
        answers,
        options,
        maxMark: a.maxMark,
        state: a.state,
        response: lastResponse,
        fraction: submitted && aspectOn(quiz.reviewCorrectness) ? a.fraction : null,
        // Điểm của câu luôn là fraction × maxMark của chính câu (câu
        // TF-A đã mang fraction tra thang của lần ghim từ engine).
        mark: (submitted && aspectOn(quiz.reviewMarks) && a.fraction !== null) ? a.fraction * a.maxMark : null,
        rightAnswer: aspectOn(quiz.reviewRightAnswer) ? a.rightAnswer : null,
        feedback: aspectOn(quiz.reviewSpecificFeedback) && lastResponse !== null
          ? (feedbackByAnswerId.get(lastResponse) ?? null)
          : null,
        generalFeedback: aspectOn(quiz.reviewGeneralFeedback) ? generalFeedback : null,
        manualComment: aspectOn(quiz.reviewSpecificFeedback)
          ? (manualCommentStep?.data.comment ?? null)
          : null,
      });
    }
    // Ảnh nhúng trong nội dung câu: phát URL ký cho đúng người đang xem bài
    // làm này (cổng của attempt — chủ attempt / người có quyền xem lại — đã
    // gác ở các hàm gọi buildAttemptView). Học sinh không có quyền tại
    // context bank của giáo viên nên đường files:view thuần không dùng được.
    for (const q of questions) {
      q.questionText = await this.files.resolveQuestionImageUrls(q.questionText);
      q.answers = await Promise.all(q.answers.map(async (a) => ({ ...a, text: await this.files.resolveQuestionImageUrls(a.text) })));
      if (q.stimulus) q.stimulus = { ...q.stimulus, content: await this.files.resolveQuestionImageUrls(q.stimulus.content) };
      q.feedback = await this.files.resolveQuestionImageUrls(q.feedback);
      q.generalFeedback = await this.files.resolveQuestionImageUrls(q.generalFeedback);
      // Hướng dẫn hiện kèm câu hỏi cho chính người làm bài này nên ảnh
      // nhúng trong đó cũng phải được phát URL ký theo cùng cổng của
      // attempt; lời giải mẫu của essay (biến thể {answer}) cũng vậy.
      q.guidance = await this.files.resolveQuestionImageUrls(q.guidance);
      if (q.solution && 'answer' in q.solution) {
        q.solution = { answer: await this.files.resolveQuestionImageUrls(q.solution.answer) };
      }
    }
    const { pendingManual } = this.syncFromUsage(usage);
    // Tầng feedback thứ tư: nhận xét tổng quát theo dải % điểm.
    let overallFeedback: string | null = null;
    if (submitted && row.sumGrades !== null && aspectOn(quiz.reviewOverallFeedback)) {
      const totalMax = this.usageTotalMax(usage);
      if (totalMax > 0) {
        const percent = (row.sumGrades / totalMax) * 100;
        const bands = await this.repo.listFeedbacks(quiz.id);
        const band = bands.find((b) => percent >= b.minPercent && (percent < b.maxPercent || (percent === 100 && b.maxPercent === 100)));
        overallFeedback = band?.feedback ?? null;
      }
    }
    return {
      attempt: await this.attemptSummary(quiz, row),
      quiz: await this.pinView(quiz),
      questions,
      totalMax: this.usageTotalMax(usage),
      pendingManualCount: pendingManual,
      closedDueToTimeLimit,
      overallFeedback,
    };
  }

  /** Quyền xem một lượt: chủ lượt, hoặc người có quiz:grade/viewreports tại module. */
  private async requireAttemptReadable(actorId: string, quiz: PinRow, row: ExamAttemptRow): Promise<void> {
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
    const quiz = await this.getPin(row.pinId);
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
    const quiz = await this.getPin(row.pinId);
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
  private async finalizeAttempt(quiz: PinRow, row: ExamAttemptRow, closedDueToTimeLimit: boolean): Promise<QuizAttemptView> {
    if (row.state !== 'inprogress') return this.buildAttemptView(quiz, row, false);
    // Thang Đ–S của lần ghim đi cùng đường chốt usage để engine tra
    // thang cho câu truefalse TF-A (cấu hình của lần ghim, không nằm
    // trong câu hỏi); lần ghim không đặt thang thì engine dùng mặc
    // định QĐ 764.
    const finishedUsage = await this.questions.finishUsage(row.userId, row.usageId, { tfScale: quiz.tfScale });
    const { sumGrades, pendingManual } = this.syncFromUsage(finishedUsage);
    const state = pendingManual > 0 ? 'needsgrading' : 'finished';
    await this.repo.updateAttempt(row.id, { state, timeFinish: new Date(), sumGrades });
    // Nộp tự động khi hết giờ là một sự kiện giám sát do SERVER ghi
    // (chỉ khi quiz bật ghi nhận) — cùng nguyên tắc chỉ-ghi-nhận.
    if (closedDueToTimeLimit && quiz.monitorEvents && !row.preview) {
      await this.repo.insertAttemptEvent({ attemptId: row.id, type: 'auto_submit_timeout' }).catch(() => undefined);
    }
    const updated = await this.getAttemptRow(row.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'quiz_attempt_finished',
      payload: {
        pinId: quiz.id, courseId: quiz.course, attemptId: row.id, usageId: row.usageId,
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
    const quiz = await this.getPin(row.pinId);
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
  private async pushGrade(quiz: PinRow, userId: string): Promise<void> {
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

  // --- CAM-0: chấm bài giấy bằng camera (issue #112) -----------------------------

  /**
   * Phân giải layout phiếu in cho một quiz (cổng quiz:gradepaper): mọi
   * slot phải là câu CỐ ĐỊNH thuộc loại trắc nghiệm/đúng-sai — phiếu
   * giấy là một đề cố định, slot ngẫu nhiên theo category/ma trận
   * không in được. Mỗi slot được GHIM vào đúng version sẽ in (slot
   * pinned dùng version đã ghim; slot follow_latest ghim version mới
   * nhất tại thời điểm sinh phiếu) kèm đáp án của version đó theo thứ
   * tự in, để lúc ghi điểm chấm đúng bản đã phát cho học sinh.
   */
  async resolvePaperLayout(actorId: string, pinId: string): Promise<{ quiz: PinRow; layout: PaperSlotLayout[] }> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.gradePaper);
    const slots = await this.effectiveSlots(quiz);
    if (!slots.length) throw new BadRequestException({ message: 'This quiz has no questions yet', code: 'quiz.no_questions' });
    if (slots.length > 60) {
      throw new UnprocessableEntityException({ message: 'A paper answer sheet supports at most 60 questions', code: 'paper.too_many_questions' });
    }
    const layout: PaperSlotLayout[] = [];
    for (const slot of slots) {
      if (!slot.questionId) {
        throw new UnprocessableEntityException({ message: 'Paper sheets need a fixed paper: every slot must pin a specific question (no random category/matrix slots)', code: 'paper.requires_fixed_slots' });
      }
      const view = await this.questions.getQuestion(slot.questionId);
      const qtype = view.question.qtype;
      if (qtype !== 'multichoice' && qtype !== 'truefalse') {
        throw new UnprocessableEntityException({ message: `Question type ${qtype} cannot be printed on an OMR answer sheet`, code: 'paper.unsupported_qtype' });
      }
      const pinnedId = slot.versionMode === 'pinned' ? slot.pinnedVersionId : null;
      const content = pinnedId && pinnedId !== view.latestVersion.id
        ? await this.questions.getVersionContent(slot.questionId, pinnedId)
        : { version: view.latestVersion, answers: view.answers, options: view.options };
      let answerIds: string[];
      let statementIds: string[] = [];
      if (qtype === 'truefalse') {
        // TF-A: một slot phiếu mang 4 ý, mỗi ý một cặp ô Đ/S theo đúng
        // thứ tự mệnh đề của version đã ghim — layout ghi statementIds
        // để lúc ghi điểm quy các cặp ô về đáp án theo từng mệnh đề.
        // Đáp án đúng KHÔNG nằm ở layout (nó ở phía đáp án của version,
        // engine tự tra khi chấm).
        const statements = getTrueFalseStatements(content.version.questionText as RichTextDocument);
        if (!statements || statements.length !== TRUE_FALSE_STATEMENT_COUNT) {
          throw new UnprocessableEntityException({ message: 'True/false question is missing its four statements', code: 'paper.bad_truefalse' });
        }
        statementIds = statements.map((s) => s.id);
        answerIds = [];
      } else {
        if (content.answers.length < 2 || content.answers.length > 5) {
          throw new UnprocessableEntityException({ message: 'A printed multichoice question needs 2–5 answers', code: 'paper.bad_option_count' });
        }
        answerIds = content.answers.map((a) => a.id);
      }
      layout.push({
        slot: slot.slot, questionId: slot.questionId, versionId: content.version.id,
        qtype, optionCount: qtype === 'truefalse' ? statementIds.length * 2 : answerIds.length,
        answerIds, statementIds, maxMark: slot.maxMark,
      });
    }
    return { quiz, layout };
  }

  /**
   * Ghi một phiếu giấy đã được giáo viên xác nhận thành attempt của
   * học sinh (cổng quiz:gradepaper, kiểm tại resolvePaperLayout của lô
   * — hàm này tin layout do module paper-grading truyền vào sau khi đã
   * kiểm quyền). Attempt là attempt THẬT của học sinh: usage dựng từ
   * đúng các version đã ghim trên phiếu, đáp án nộp qua engine như
   * attempt online, chốt bằng đúng đường finalizeAttempt (điểm chảy
   * vào sổ điểm như thường). appliedSettings mang dấu nguồn giấy
   * {source: 'paper-scan', scanId, batchId, variantCode} để báo cáo
   * phân biệt được lượt thi giấy. responses[i] là chuỗi đáp án theo
   * ngữ nghĩa engine cho slot i (multichoice: answerId đã chọn;
   * truefalse TF-A: JSON bản đồ statementId → boolean quy từ 4 cặp ô
   * Đ/S của slot; null: để trống).
   */
  async recordPaperAttempt(actorId: string, pinId: string, input: {
    studentId: string;
    layout: PaperSlotLayout[];
    responses: (string | null)[];
    scanId: string;
    batchId: string;
    variantCode: string;
  }): Promise<{ attemptId: string; state: string; sumGrades: number | null }> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.gradePaper);
    const existing = await this.repo.listAttemptsForUser(quiz.id, input.studentId, true);
    const attemptNumber = existing.length + 1;
    const now = new Date();
    const usage = await this.questions.createUsage(input.studentId, {
      component: QUIZ_COMPONENT, instanceId: quiz.id, contextId: await this.cmContextId(quiz),
      slots: input.layout.map((s) => ({ questionId: s.questionId, maxMark: s.maxMark, pinnedVersionId: s.versionId })),
    });
    try {
      await this.questions.startUsage(input.studentId, usage.usage.id);
      const row = await this.repo.insertAttempt({
        pinId: quiz.id, userId: input.studentId, attemptNumber, usageId: usage.usage.id,
        state: 'inprogress', preview: false, timeStart: now, makeup: false,
        appliedSettings: { source: 'paper-scan', scanId: input.scanId, batchId: input.batchId, variantCode: input.variantCode },
      });
      await this.outbox.enqueueStandalone({
        aggregate: 'quiz', type: 'quiz_attempt_started',
        payload: { pinId: quiz.id, courseId: quiz.course, attemptId: row.id, usageId: row.usageId, userId: input.studentId, attemptNumber, preview: false, actorId },
      });
      const usageView = await this.questions.getUsage(usage.usage.id);
      for (const s of input.layout) {
        const response = input.responses[s.slot - 1] ?? null;
        if (response === null) continue;
        const qa = usageView.attempts.find((a) => a.slot === s.slot);
        if (!qa) throw new BadRequestException({ message: `Usage is missing slot ${s.slot}`, code: 'paper.slot_missing' });
        await this.questions.submitResponse(input.studentId, qa.id, response);
      }
      await this.finalizeAttempt(quiz, row, false);
      const updated = await this.getAttemptRow(row.id);
      return { attemptId: updated.id, state: updated.state, sumGrades: updated.sumGrades };
    } catch (err) {
      // Cùng kỷ luật dọn dẹp với startAttempt: attempt chưa thành hình
      // thì xoá usage mồ côi (hàng attempt, nếu đã chèn, cascade theo).
      await this.questions.deleteUsage(usage.usage.id).catch(() => undefined);
      throw err;
    }
  }

  // --- báo cáo + chấm tay ---------------------------------------------------------

  /**
   * Trang kết quả của giáo viên (quiz:viewreports): mọi lượt làm,
   * điểm bài hiện tại theo từng học sinh, hàng đợi essay chờ chấm tay,
   * và thống kê câu sai theo từng slot (câu sai nhiều nhất xếp trước).
   */
  async getResults(actorId: string, pinId: string): Promise<{
    quiz: QuizView;
    attempts: QuizAttemptSummary[];
    gradesByUser: { userId: string; grade: number | null }[];
    needsGrading: QuizNeedsGradingView[];
    questionStats: QuizQuestionStat[];
    summary: QuizResultsSummary;
  }> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports);
    const rows = (await this.repo.listAttempts(quiz.id)).filter((a) => !a.preview);
    const attempts: QuizAttemptSummary[] = [];
    for (const r of rows) attempts.push(await this.attemptSummary(quiz, r));
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const gradesByUser: { userId: string; grade: number | null }[] = [];
    for (const userId of userIds) gradesByUser.push({ userId, grade: await this.currentGradeForUser(quiz, userId) });
    const summary = await this.resultsSummary(quiz, rows, gradesByUser);
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
    return { quiz: await this.pinView(quiz), attempts, gradesByUser, needsGrading, questionStats, summary };
  }

  /**
   * Tổng quan tham gia + phổ điểm của bài (bộ Azota — issue #224):
   * ghi danh lấy từ enrol của khoá chứa pin; "đã nộp" = có ít nhất
   * một lượt finished/needsgrading (không tính preview của GV); phổ
   * điểm tính trên điểm BÀI hiện tại của từng HS (gradesByUser).
   */
  private async resultsSummary(
    quiz: PinRow,
    rows: ExamAttemptRow[],
    gradesByUser: { userId: string; grade: number | null }[],
  ): Promise<QuizResultsSummary> {
    const enrolments = await this.enrol.listEnrolmentsForCourse(quiz.course);
    const enrolledIds = [...new Set(enrolments.filter((e) => e.status === 0).map((e) => e.userId))];
    const submittedIds = new Set(rows.filter((r) => r.state === 'finished' || r.state === 'needsgrading').map((r) => r.userId));
    const notSubmittedIds = enrolledIds.filter((id) => !submittedIds.has(id));
    const nameById = new Map<string, string>();
    if (notSubmittedIds.length) {
      for (const u of await this.users.getUsersByIds(notSubmittedIds)) {
        const full = `${u.firstName} ${u.lastName}`.trim();
        nameById.set(u.id, full || u.username);
      }
    }
    const graded = gradesByUser.map((g) => g.grade).filter((g): g is number => g !== null);
    const averageGrade = graded.length ? graded.reduce((a, b) => a + b, 0) / graded.length : null;
    const distribution = Array.from({ length: 10 }, (_, i) => ({ fromPct: i * 10, toPct: (i + 1) * 10, count: 0 }));
    for (const g of graded) {
      const pct = quiz.grade > 0 ? (g / quiz.grade) * 100 : 0;
      const idx = Math.min(9, Math.max(0, Math.floor(pct / 10)));
      distribution[idx]!.count += 1;
    }
    return {
      enrolledCount: enrolledIds.length,
      submittedCount: enrolledIds.filter((id) => submittedIds.has(id)).length,
      notSubmittedStudents: notSubmittedIds.map((userId) => ({ userId, displayName: nameById.get(userId) ?? userId })),
      averageGrade,
      gradeMax: quiz.grade,
      distribution,
    };
  }

  /**
   * Gộp thống kê câu sai từ các lượt đã nộp (finished/needsgrading) của
   * một quiz: duyệt usage của engine theo từng lượt, gộp theo slot. Tên
   * học sinh sai được tra một lượt theo lô ở cuối; tên câu chỉ điền khi
   * MỌI lượt ở slot dùng cùng một câu (slot cố định). Xếp wrongCount
   * giảm dần để câu sai nhiều nhất lên đầu, hoà thì theo số slot.
   */
  private async questionStats(rows: ExamAttemptRow[]): Promise<QuizQuestionStat[]> {
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
      correct: { userId: string }[];
    }
    const bySlot = new Map<number, SlotAcc>();
    for (const r of submitted) {
      const usage = await this.questions.getUsage(r.usageId);
      for (const a of usage.attempts) {
        let acc = bySlot.get(a.slot);
        if (!acc) {
          acc = {
            questionIds: new Set(), maxMark: a.maxMark, attemptsCount: 0,
            gradedCount: 0, pendingCount: 0, wrongCount: 0, fullyWrongCount: 0, wrong: [], correct: [],
          };
          bySlot.set(a.slot, acc);
        }
        acc.questionIds.add(a.questionId);
        acc.attemptsCount += 1;
        if (a.state === 'needsgrading') {
          acc.pendingCount += 1;
        } else if (a.fraction !== null && a.fraction !== undefined) {
          acc.gradedCount += 1;
          if (a.fraction === 1) acc.correct.push({ userId: r.userId });
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
    const statUserIds = [...new Set([...bySlot.values()].flatMap((acc) => [
      ...acc.wrong.map((w) => w.userId),
      ...acc.correct.map((c) => c.userId),
    ]))];
    const nameById = new Map<string, string>();
    if (statUserIds.length) {
      for (const u of await this.users.getUsersByIds(statUserIds)) {
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
          // Câu hỏi không còn trường tên: nhãn của câu trong thống kê
          // là trích đoạn nội dung thân câu của version mới nhất.
          const text = view ? extractRichTextPlainText(view.latestVersion.questionText as RichTextDocument).trim() : '';
          questionNameById.set(questionId, text.length > 120 ? `${text.slice(0, 120)}…` : text);
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
        correctCount: acc.correct.length,
        correctStudents: acc.correct.map((c) => ({
          userId: c.userId,
          displayName: nameById.get(c.userId) ?? c.userId,
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
    const quiz = await this.getPin(row.pinId);
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
      aggregate: 'quiz', type: 'exam_attempt_regraded',
      payload: {
        pinId: quiz.id, courseId: quiz.course, attemptId: row.id, usageId: row.usageId,
        userId: row.userId, questionAttemptId: input.questionAttemptId, mark: input.mark,
        sumGrades, state: updated.state, actorId,
      },
    });
    if (updated.state === 'finished' && !row.preview) await this.pushGrade(quiz, row.userId);
    return this.buildAttemptView(quiz, updated, false, actorId);
  }

  // --- dải nhận xét tổng quát / sự kiện giám sát / chấm theo câu / thống kê chùm ---

  /** Các dải nhận xét tổng quát của quiz (quiz:manage). */
  async listFeedbacks(actorId: string, pinId: string): Promise<ExamPinFeedbackRow[]> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    return this.repo.listFeedbacks(quiz.id);
  }

  /** Tạo một dải nhận xét tổng quát (quiz:manage); dải tính theo % điểm của bài, [min, max). */
  async createFeedback(actorId: string, pinId: string, input: { minPercent: number; maxPercent: number; feedback: string }): Promise<ExamPinFeedbackRow> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    if (!(input.minPercent < input.maxPercent)) {
      throw new BadRequestException({ message: 'minPercent must be below maxPercent', code: 'quiz.feedback_range' });
    }
    return this.repo.insertFeedback({ pinId: quiz.id, minPercent: input.minPercent, maxPercent: input.maxPercent, feedback: input.feedback });
  }

  /** Xoá một dải nhận xét tổng quát (quiz:manage). */
  async deleteFeedback(actorId: string, pinId: string, feedbackId: string): Promise<void> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    const bands = await this.repo.listFeedbacks(quiz.id);
    if (!bands.some((b) => b.id === feedbackId)) {
      throw new NotFoundException({ message: `Quiz feedback ${feedbackId} not found`, code: 'quiz.feedback_not_found' });
    }
    await this.repo.deleteFeedback(feedbackId);
  }

  /**
   * Ghi một sự kiện giám sát do client báo (thoát fullscreen, mất
   * focus, ngắt kết nối dài). Điều kiện: lượt của chính người báo, còn
   * đang làm, quiz bật monitor_events. CHỈ GHI NHẬN — không có bất kỳ
   * hệ quả tự động nào lên lượt làm.
   */
  async recordAttemptEvent(actorId: string, attemptId: string, input: { type: string; data?: Record<string, unknown> }): Promise<ExamAttemptEventRow> {
    const row = await this.getAttemptRow(attemptId);
    if (row.userId !== actorId) {
      throw new ForbiddenException({ message: 'This attempt belongs to another user', code: 'quiz.attempt_forbidden' });
    }
    const quiz = await this.getPin(row.pinId);
    if (!quiz.monitorEvents) {
      throw new BadRequestException({ message: 'Event monitoring is not enabled for this quiz', code: 'quiz.monitoring_disabled' });
    }
    if (row.state !== 'inprogress') {
      throw new BadRequestException({ message: 'Events can only be recorded while the attempt is in progress', code: 'quiz.attempt_not_in_progress' });
    }
    return this.repo.insertAttemptEvent({ attemptId: row.id, type: input.type, data: input.data ?? null });
  }

  /** Nhật ký sự kiện giám sát của một lượt (chủ lượt hoặc người có quyền chấm/báo cáo). */
  async listAttemptEvents(actorId: string, attemptId: string): Promise<ExamAttemptEventRow[]> {
    const row = await this.getAttemptRow(attemptId);
    const quiz = await this.getPin(row.pinId);
    await this.requireAttemptReadable(actorId, quiz, row);
    return this.repo.listAttemptEvents(row.id);
  }

  /**
   * Hàng đợi chấm THEO CÂU (Q-b): mọi lượt đã nộp chứa câu này, kèm
   * đáp án hiện tại và điểm đã có — giáo viên chấm một câu cho cả lớp
   * trong một màn hình thay vì mở từng học sinh.
   */
  async listQuestionGradingQueue(actorId: string, pinId: string, questionId: string): Promise<{
    attemptId: string; userId: string; displayName: string; attemptNumber: number;
    questionAttemptId: string; slot: number; state: string; response: string | null;
    fraction: number | null; mark: number | null; maxMark: number;
  }[]> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.grade);
    const submitted = (await this.repo.listAttempts(quiz.id)).filter((a) => !a.preview && a.state !== 'inprogress');
    const rows: {
      attemptId: string; userId: string; displayName: string; attemptNumber: number;
      questionAttemptId: string; slot: number; state: string; response: string | null;
      fraction: number | null; mark: number | null; maxMark: number;
    }[] = [];
    const nameById = new Map<string, string>();
    for (const u of await this.users.getUsersByIds(submitted.map((a) => a.userId))) {
      const full = `${u.firstName} ${u.lastName}`.trim();
      nameById.set(u.id, full || u.username);
    }
    for (const r of submitted) {
      const usage = await this.questions.getUsage(r.usageId);
      const qa = usage.attempts.find((a) => a.questionId === questionId);
      if (!qa) continue;
      const lastResponse = [...qa.steps].reverse().find((s) => s.data.answer !== undefined)?.data.answer ?? null;
      rows.push({
        attemptId: r.id, userId: r.userId, displayName: nameById.get(r.userId) ?? r.userId,
        attemptNumber: r.attemptNumber, questionAttemptId: qa.id, slot: qa.slot,
        state: qa.state, response: lastResponse,
        fraction: qa.fraction ?? null,
        mark: qa.fraction !== null && qa.fraction !== undefined ? qa.fraction * qa.maxMark : null,
        maxMark: qa.maxMark,
      });
    }
    return rows.sort((x, y) => x.attemptNumber - y.attemptNumber || x.slot - y.slot);
  }

  /**
   * Chấm tay THEO CÂU cho nhiều lượt (Q-b): mỗi mục đi qua đúng đường
   * chấm tay theo lượt hiện có (engine ghi step, tổng điểm đồng bộ,
   * lượt cuối cùng hết câu chờ thì chốt + ghi sổ điểm).
   */
  async gradeQuestionForAttempts(actorId: string, pinId: string, input: {
    questionId: string;
    grades: { attemptId: string; mark: number; comment?: string }[];
  }): Promise<QuizAttemptSummary[]> {
    const quiz = await this.getPin(pinId);
    await this.requireCap(actorId, quiz, QUIZ_CAPABILITIES.grade);
    const out: QuizAttemptSummary[] = [];
    for (const entry of input.grades) {
      const row = await this.getAttemptRow(entry.attemptId);
      if (row.pinId !== quiz.id) {
        throw new BadRequestException({ message: `Attempt ${entry.attemptId} does not belong to this quiz`, code: 'quiz.attempt_quiz_mismatch' });
      }
      const usage = await this.questions.getUsage(row.usageId);
      const qa = usage.attempts.find((a) => a.questionId === input.questionId);
      if (!qa) {
        throw new BadRequestException({ message: `Attempt ${entry.attemptId} does not contain question ${input.questionId}`, code: 'quiz.question_not_in_attempt' });
      }
      const view = await this.manualGrade(actorId, entry.attemptId, {
        questionAttemptId: qa.id, mark: entry.mark, comment: entry.comment,
      });
      out.push(view.attempt);
    }
    return out;
  }

  /**
   * Các lượt làm của một quiz cho chủ nhân hoặc giáo viên — dùng cho
   * trang thông tin (lượt của tôi) và báo cáo.
   */
  async listAttemptSummaries(actorId: string, pinId: string): Promise<QuizAttemptSummary[]> {
    const quiz = await this.getPin(pinId);
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
