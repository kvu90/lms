import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type {
  ExamMatrixView,
  MatrixCellAvailability,
  MatrixImportCellAvailability,
  PaperSlotLayout,
  PinRegradeLogEntry,
  PinRegradeResult,
  PinVersionUpdatePreview,
  QuestionSolution,
  QuizAttemptSummary,
  ExamPinOverrideView,
  QuizView,
  RichTextDocument,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import { TenantsService } from '../tenants/tenants.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { CurriculumService } from '../curriculum/curriculum.service';
import { FilesService } from '../files/files.service';
import { GradesService } from '../grades/grades.service';
import { GroupsService } from '../groups/groups.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import type { QuestionBankRow } from '@lms/db/repositories/question-banks';
import { QuestionsService } from '../questions/questions.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import type {
  CreateExamMatrixCellDto,
  CreateExamMatrixDto,
  CreateExamPinOverrideDto,
  UpdateExamMatrixCellDto,
  UpdateExamMatrixDto,
  UpdateExamPinOverrideDto,
  WithdrawExamMatrixDto,
} from './dto/quiz.dto';
import { type ExamKind } from './domain/matrix';
import {
  QuizRepository,
  type ExamMatrixCellRow,
  type ExamMatrixRow,
  type ExamAttemptEventRow,
  type ExamAttemptRow,
  type ExamPinFeedbackRow,
  type ExamPinRow,
} from '@lms/db/repositories/quiz';
import { QuizSharedService } from './quiz-shared.service';
import { QuizAttemptsService } from './quiz-attempts.service';
import { QuizPinsService } from './quiz-pins.service';
import { QuizMatricesService } from './quiz-matrices.service';
import { QuizGenerationService } from './quiz-generation.service';

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

export { QUIZ_COMPONENT, QUIZ_CAPABILITIES } from './quiz-shared.service';
export { REVIEW_WINDOW, REVIEW_IMMEDIATELY_AFTER_MS } from './quiz-attempts.service';
export { QTYPE_LABELS, LEVEL_LABELS, flattenSpecification } from './quiz-generation.service';

/**
 * Facade của QuizService: giữ nguyên bề mặt công khai và chữ ký
 * constructor như trước khi tách, uỷ quyền mọi method cho service cụm
 * sở hữu. Bốn cụm ca sử dụng của issue #295 (ghim đề / ma trận /
 * sinh đề-đặc tả / lượt làm-chấm-kết quả) cộng tầng thấp dùng chung
 * (`QuizSharedService`: primitive tải pin/ma trận, cổng quyền,
 * tính điểm từ usage) — xem docblock của từng service cụm.
 *
 * Đồ thị phụ thuộc giữa các cụm không có vòng: cụm lượt làm chỉ trỏ
 * xuống tầng thấp; cụm ghim gọi sang cụm lượt làm đúng phép `pushGrade`
 * (chấm lại); cụm sinh đề gọi sang cụm lượt làm đúng phép
 * `finalizeAttempt` (lượt giấy); cụm ma trận chỉ trỏ xuống tầng thấp.
 * Các service cụm không đăng ký provider riêng, module wiring không
 * đổi — đúng khuôn facade của phần messaging trong cùng PR này.
 *
 * Hai điểm khác biệt duy nhất so với file gốc ngoài tổ chức file:
 * (1) các method vốn `private` nhưng cụm khác gọi nay public trong nội
 * bộ module (ghi rõ ở docblock từng service cụm), không phải bề mặt
 * API của module; (2) hai cảnh báo ghi điểm của `pushGrade` mang tên
 * logger `QuizAttemptsService` thay cho `QuizService`.
 */

@Injectable()
export class QuizService {
  private readonly shared: QuizSharedService;
  private readonly attempts: QuizAttemptsService;
  private readonly pins: QuizPinsService;
  private readonly matrices: QuizMatricesService;
  private readonly generation: QuizGenerationService;

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
  ) {
    this.shared = new QuizSharedService(this.repo, this.contexts, this.evaluator, this.questions, this.banks, this.tenantContext, this.tenants);
    this.attempts = new QuizAttemptsService(this.repo, this.courses, this.questions, this.grades, this.users, this.enrol, this.passwords, this.groups, this.outbox, this.files, this.shared);
    this.pins = new QuizPinsService(this.repo, this.courses, this.evaluator, this.questions, this.grades, this.users, this.passwords, this.groups, this.outbox, this.shared, this.attempts);
    this.matrices = new QuizMatricesService(this.repo, this.evaluator, this.banks, this.curriculum, this.outbox, this.tenantContext, this.shared);
    this.generation = new QuizGenerationService(this.repo, this.questions, this.curriculum, this.outbox, this.shared, this.attempts);
  }

  /**
   * Lấy pin đã LÀM GIÀU; ném exam.pin_not_found khi vắng. Hàng
   * exam_pins được gộp với các trường suy từ exam version đã ghim
   * (thang điểm, tên hiển thị, ma trận, thang Đ–S) và exam (kind)
   * thành một "bài kiểm tra trong khoá" thống nhất cho các tầng trên.
   */
  async getPin(id: string): Promise<PinRow> {
    return this.shared.getPin(id);
  }

  /** Hàng pin thô (chưa làm giàu) cho các seam cần đúng bản ghi đã ghim (vd in đề theo pin). */
  async getPinRow(id: string): Promise<ExamPinRow | undefined> {
    return this.shared.getPinRow(id);
  }

  /**
   * Slots HIỆU LỰC của một pin — không còn bảng slots riêng của bài:
   * - Đề snapshot: đọc thẳng exam_slots của version đã ghim (page suy
   *   từ thứ tự xuất hiện của section, như lúc triển khai trước đây).
   */
  async effectiveSlots(pin: PinRow): Promise<EffectiveSlotRow[]> {
    return this.shared.effectiveSlots(pin);
  }

  /** Pin đã có lượt làm thật thì exam version đã ghim bị khoá (lượt đã pin câu theo version đó). */
  async assertPinUnlocked(pin: PinRow): Promise<void> {
    return this.pins.assertPinUnlocked(pin);
  }

  /**
   * View của quiz kèm slots và tổng điểm slot. Slot cố định mang thêm
   * thông tin bank nguồn + kỷ luật version (QB-3): chế độ ghim, version
   * đang ghim, version ready mới nhất và cờ có bản mới để UI hiển thị
   * "Câu thuộc Ngân hàng [tên] · đang ghim v[n] · đã có v[m]".
   */
  async pinView(quiz: PinRow): Promise<QuizView> {
    return this.shared.pinView(quiz);
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
    return this.pins.createPinRecord(actorId, courseId, input);
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
    return this.pins.updatePin(actorId, pinId, input);
  }

  /**
   * Xoá pin cùng attempts, usages của engine, course module và
   * grade item của hoạt động (quiz:manage). Đề trong bank không bị
   * ảnh hưởng — xoá pin chỉ gỡ lần tổ chức trong khoá này.
   */
  async deletePin(actorId: string, pinId: string): Promise<void> {
    return this.pins.deletePin(actorId, pinId);
  }

  /**
   * Xem trước thao tác cập nhật pin lên bản ready mới nhất của đề
   * (quiz:manage; issue #254): đích là exam version có số lớn nhất của
   * đề — chỉ tồn tại khi đề đang `ready` và bản đó mới hơn bản đang
   * ghim. Kèm diff từng slot và cờ `blockedByAttempts` để giáo viên
   * biết trước rằng thao tác áp sẽ bị chặn khi pin đã có lượt làm thật.
   */
  async getPinVersionUpdatePreview(actorId: string, pinId: string): Promise<PinVersionUpdatePreview> {
    return this.pins.getPinVersionUpdatePreview(actorId, pinId);
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
    return this.pins.applyPinVersionUpdate(actorId, pinId, toExamVersionId);
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
    return this.pins.regradePinQuestion(actorId, pinId, input);
  }

  /**
   * Nhật ký chấm lại theo đáp án của pin cho giáo viên (quiz:viewreports;
   * issue #254): mỗi lần áp thật một dòng kèm điểm đổi của từng lượt —
   * căn cứ truy vết khi học sinh/phụ huynh hỏi vì sao điểm thay đổi.
   */
  async listPinRegrades(actorId: string, pinId: string): Promise<PinRegradeLogEntry[]> {
    return this.pins.listPinRegrades(actorId, pinId);
  }

  /**
   * Lịch sử sửa điểm của CHÍNH học sinh trong một pin (issue #254): các
   * lần chấm lại theo đáp án đã đổi điểm của mình — câu nào, khi nào,
   * điểm trước/sau. Đi qua CÙNG cổng công bố như mọi đường đọc điểm:
   * pin chưa công bố kết quả thì trả danh sách rỗng (không lộ điểm qua
   * kênh phụ), trừ người có quyền xem báo cáo của pin.
   */
  async listMyPinRegrades(actorId: string, pinId: string): Promise<PinRegradeLogEntry[]> {
    return this.pins.listMyPinRegrades(actorId, pinId);
  }

  /**
   * Các pin trong khoá học (cho trang khoá học/danh sách hoạt động).
   * H9 (rà soát #134): QuizView kèm slots (questionId, pinnedVersion,
   * bank) là cấu trúc đề — chỉ người qua cổng truy cập khoá mới liệt kê
   * được; trước đây handler không nhận actor nên người ngoài khoá cũng
   * khảo sát được thành phần đề của bất kỳ khoá nào.
   */
  async listPins(actorId: string, courseId: string): Promise<QuizView[]> {
    return this.pins.listPins(actorId, courseId);
  }

  /** Công bố kết quả của pin (trạng thái công bố của #224 sống trên exam_pins.results_published_at; quiz:manage). */
  async publishResults(actorId: string, pinId: string): Promise<QuizView> {
    return this.pins.publishResults(actorId, pinId);
  }

  /** Thu hồi công bố kết quả của pin (quiz:manage). */
  async unpublishResults(actorId: string, pinId: string): Promise<QuizView> {
    return this.pins.unpublishResults(actorId, pinId);
  }

  /** Sửa override theo id (route /exam-pin-overrides/:overrideId): pin suy từ chính override. */
  async updatePinOverride(actorId: string, overrideId: string, dto: UpdateExamPinOverrideDto): Promise<ExamPinOverrideView> {
    return this.pins.updatePinOverride(actorId, overrideId, dto);
  }

  /** Xoá override theo id (route /exam-pin-overrides/:overrideId). */
  async deletePinOverride(actorId: string, overrideId: string): Promise<void> {
    return this.pins.deletePinOverride(actorId, overrideId);
  }

  /** Xoá feedback theo id (route /exam-pin-feedbacks/:feedbackId): pin suy từ chính feedback. */
  async deletePinFeedback(actorId: string, feedbackId: string): Promise<void> {
    return this.pins.deletePinFeedback(actorId, feedbackId);
  }

  /** Danh sách ghi đè của quiz (quiz:manageoverrides). */
  async listOverrides(actorId: string, pinId: string): Promise<ExamPinOverrideView[]> {
    return this.pins.listOverrides(actorId, pinId);
  }

  /**
   * Tạo ghi đè (quiz:manageoverrides): đích phải là đúng MỘT nhóm của
   * khoá chứa quiz hoặc đúng MỘT người dùng có quyền vào khoá; mỗi đích
   * tối đa một ghi đè cho một quiz (trùng đích bị từ chối thay vì đè
   * lặng lẽ như Moodle upsert).
   */
  async createOverride(actorId: string, pinId: string, input: CreateExamPinOverrideDto): Promise<ExamPinOverrideView> {
    return this.pins.createOverride(actorId, pinId, input);
  }

  /** Sửa một ghi đè (quiz:manageoverrides); trường không gửi giữ nguyên, `null` ở trường ghi đè = quay về kế thừa. */
  async updateOverride(actorId: string, pinId: string, overrideId: string, input: UpdateExamPinOverrideDto): Promise<ExamPinOverrideView> {
    return this.pins.updateOverride(actorId, pinId, overrideId, input);
  }

  /** Xoá một ghi đè (quiz:manageoverrides) — đích của ghi đè quay về cài đặt tầng dưới ngay. */
  async deleteOverride(actorId: string, pinId: string, overrideId: string): Promise<void> {
    return this.pins.deleteOverride(actorId, pinId, overrideId);
  }

  /**
   * Cổng BANK của các luồng ghi ma trận vào bank cá nhân (MB-1, cùng
   * học thuyết neo bank của {@link requireMatrixCap}): bank đích của
   * các luồng này là bank ma trận CÁ NHÂN của chính người gọi — tạo
   * lười như đường copy mẫu (người không thuộc nhóm staff bị từ chối
   * ngay ở bước tạo lười, trước mọi lần đọc dữ liệu) — và quyền ghi
   * chốt bằng bộ quyền bank-local tại bank đó (chủ bank giữ vai lead
   * nên có `quiz:managematrix` bản địa).
   *
   * Đây là cổng DUY NHẤT của đường nhập ma trận từ file ở cả ba đầu
   * (sinh mẫu, xem trước, ghi — MatrixImportService gọi hàm này) và
   * là bước chốt quyền của chính thao tác ghi
   * {@link createMatrixFromImport}. Các luồng này KHÔNG gác thêm
   * `quiz:managematrix` hay `curriculum:view` tại context của môn:
   * môn chỉ là phạm vi dữ liệu tham chiếu của thao tác ghi, và giáo
   * viên thật không có vai nào tại context hệ thống của môn GDPT nên
   * cổng tại context môn chặn nhầm mọi giáo viên (điểm chặn của
   * nghiệm thu D-3 trên production, issue #233).
   *
   * @param actorId - Người gọi (chủ bank đích).
   * @returns Bank ma trận cá nhân của người gọi.
   * @throws ForbiddenException `question.personal_bank_staff_only`
   *   khi người gọi không thuộc nhóm staff và chưa có bank cá nhân;
   *   `access.capability_denied` khi bộ quyền bank-local không cho
   *   phụ trách bank.
   */
  async requirePersonalMatrixBankManage(actorId: string): Promise<QuestionBankRow> {
    return this.matrices.requirePersonalMatrixBankManage(actorId);
  }

  /** View đầy đủ của một dòng ma trận (ô + cảnh báo) — bản công khai cho lớp bank (MB-1) dùng sau khi đã tự gác quyền. */
  async viewMatrixRow(row: ExamMatrixRow): Promise<ExamMatrixView> {
    return this.matrices.viewMatrixRow(row);
  }

  /**
   * Tạo ma trận: quyền ghi MỘT nguồn duy nhất (E-8) — khi gắn vào một
   * Tạo ma trận: quyền ghi MỘT nguồn duy nhất (E-8) — khi gắn vào một
   * bank ma trận (MB-1) thì gác matrix:add tại CONTEXT CỦA BANK
   * (bank phải tồn tại và đúng bank_kind='matrix'); không gắn bank thì
   * gác matrix:add tại context của môn. Tạo mới dùng cổng ADD
   * (khuôn S3 của #228) — matrix:edit chỉ gác sửa ma trận đã có. Tỉ
   * lệ mục tiêu không được cho thì CHỤP từ preset tại lúc tạo — về
   * sau preset có đổi thì ma trận đã tạo không đổi theo.
   *
   * Môn/chương trình ở đây chỉ là dữ liệu THAM CHIẾU của thao tác ghi
   * (đối chiếu cặp + lấy context môn cho nhánh không gắn bank) nên
   * đọc bằng đường tham chiếu nội bộ của CurriculumService, không qua
   * đường đọc công khai vốn đòi `curriculum:view` tại context của
   * môn — lớp đọc đó từng chặn nhầm giáo viên tạo ma trận GẮN BANK
   * theo môn thuộc chương trình hệ thống (cùng điểm chặn D-3 của
   * issue #233 ở đường nhập file), trong khi cổng ghi thật của nhánh
   * gắn bank là bộ quyền bank-local tại bank đích.
   */
  async createMatrix(actorId: string, input: CreateExamMatrixDto): Promise<ExamMatrixView> {
    return this.matrices.createMatrix(actorId, input);
  }

  /**
   * Ghi NGUYÊN TỬ một ma trận từ kết quả parse HỢP LỆ của đường nhập
   * file (lát I-2, issue #233) — đầu ghi duy nhất của luồng nhập:
   *
   * 1. Đối chiếu cặp môn/chương trình như {@link createMatrix} bằng
   *    đường đọc tham chiếu nội bộ (môn/chương trình chỉ là dữ liệu
   *    tham chiếu của thao tác ghi). Cổng quyền của luồng là cổng
   *    bank cá nhân {@link requirePersonalMatrixBankManage}: đã chạy
   *    ở bước parse của chính request ghi
   *    (MatrixImportService.previewImport) và chạy lại tại đây ngay
   *    trước khi ghi — KHÔNG có cổng nào tại context của môn.
   * 2. Bank đích = bank ma trận CÁ NHÂN của người nhập (tạo lười như
   *    đường copy mẫu); quyền ghi tại bank chốt bằng bộ quyền
   *    bank-local như nhánh gắn bank của createMatrix; `tenant_id`
   *    của ma trận suy từ bank (schema đã chốt: tenant suy từ bank
   *    chủ). Ma trận vào bank ở trạng thái `draft`, không phải mẫu —
   *    cùng vị thế với ma trận tạo tay, muốn lên bank chung phải đi
   *    đường copy/đóng góp hiện có.
   * 3. CHỐNG GHI TRÙNG hai tầng (lát schema của issue #233 đóng cửa
   *    sổ đua của tầng một): tầng một đối chiếu chữ ký nội dung với
   *    các ma trận chính người nhập đã có trong bank đích — trùng
   *    toàn bộ thì trả ngay ma trận đã có, KHÔNG tạo bản thứ hai
   *    (gửi lại cùng một file do double submit/retry không nhân đôi
   *    dữ liệu). Tầng hai là ràng buộc duy nhất (bank_id,
   *    content_signature) ở DB: chữ ký được ghi xuống cột
   *    `content_signature` ngay trong transaction tạo ma trận, nên
   *    hai request trùng chạy ĐỒNG THỜI tuyệt đối cũng chỉ một
   *    transaction thắng; transaction thua chạm ràng buộc, rollback
   *    toàn bộ, rồi đọc lại ma trận thắng cuộc theo (bank, chữ ký)
   *    và trả về — người dùng không nhận lỗi, đúng hành vi "trùng
   *    toàn bộ thì trả bản đã có".
   * 4. Ghi ma trận + toàn bộ ô trong MỘT transaction: bất kỳ lỗi nào
   *    giữa chừng (khoá ngoại, ràng buộc duy nhất của ô, check của
   *    DB) đều rollback toàn bộ — không để lại ma trận mồ côi hay ô
   *    ghi dở. Sự kiện outbox `exam_matrix_created` phát SAU khi
   *    transaction đã commit, như createMatrix; riêng request thua
   *    cuộc ở bước 3 không phát sự kiện vì không tạo dữ liệu nào.
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
    return this.matrices.createMatrixFromImport(actorId, input);
  }

  /** Đọc một ma trận kèm ô và cảnh báo lệch tỉ lệ (matrix:use). */
  async getMatrix(actorId: string, matrixId: string): Promise<ExamMatrixView> {
    return this.matrices.getMatrix(actorId, matrixId);
  }

  /**
   * Đọc nội dung của ĐÚNG một version bất biến của ma trận: cấu
   * hình lấy từ hàng version, ô lấy theo version đó — dùng để đối
   * chiếu bản đặc tả đã nộp/đề đã sinh với nội dung ma trận tại
   * thời điểm của chúng. Cổng quyền như đọc ma trận hiện hành.
   * Version không tồn tại → 404 quiz.matrix_version_not_found.
   */
  async getMatrixVersion(actorId: string, matrixId: string, version: number): Promise<ExamMatrixView> {
    return this.matrices.getMatrixVersion(actorId, matrixId, version);
  }

  /**
   * Truy nguồn chiều ngược của ma trận: mọi version đề đã sinh từ
   * ma trận này (exam_versions.matrix_id) kèm số version ma trận đã
   * neo lúc sinh đề — để người soạn truy từ ma trận ra các đề nó đã
   * đẻ ra. Cổng quyền và cổng tenant như đọc chi tiết ma trận.
   */
  async listGeneratedExams(actorId: string, matrixId: string) {
    return this.matrices.listGeneratedExams(actorId, matrixId);
  }

  async listMatrices(actorId: string, subjectId: string): Promise<ExamMatrixView[]> {
    return this.matrices.listMatrices(actorId, subjectId);
  }

  /** Sửa ma trận (matrix:edit); thu hẹp bộ mức khi đã có ô dùng mức bị loại thì bị từ chối. */
  async updateMatrix(actorId: string, matrixId: string, input: UpdateExamMatrixDto): Promise<ExamMatrixView> {
    return this.matrices.updateMatrix(actorId, matrixId, input);
  }

  /**
   * Rút một ma trận khỏi ngân hàng (matrix:edit — ngang hàng
   * `withdrawPaper` của đề và `withdrawQuestion` của QB-3, issue
   * #228 lát S5): trạng thái về `hidden` KÈM truy vết bắt buộc —
   * lý do (DTO chặn rỗng), người rút, thời điểm. Hệ quả của
   * `hidden`: ma trận biến mất khỏi khám phá, không sinh đề mới /
   * đóng góp mới được; các version đề đã sinh từ ma trận và các
   * version ma trận đã ghim trong hồ sơ/đóng góp vẫn đọc lại
   * nguyên vẹn vì chúng là bản chụp bất biến. Ma trận đang `hidden`
   * rồi thì 409 — rút hai lần không có nghĩa.
   */
  async withdrawMatrix(actorId: string, matrixId: string, input: WithdrawExamMatrixDto): Promise<{ matrixId: string; status: string }> {
    return this.matrices.withdrawMatrix(actorId, matrixId, input);
  }

  /**
   * Khôi phục một ma trận đã rút về `ready` và XOÁ truy vết lần
   * rút (ngang hàng khôi phục của đề/câu hỏi): ma trận hiện lại
   * trong khám phá và sinh đề/đóng góp được như trước. Ma trận
   * không ở trạng thái `hidden` thì 409.
   */
  async restoreMatrix(actorId: string, matrixId: string): Promise<{ matrixId: string; status: string }> {
    return this.matrices.restoreMatrix(actorId, matrixId);
  }

  /** Xoá ma trận (matrix:edit); đề đã sinh từ ma trận giữ nguyên, chỉ mất vết matrix_id (FK set null). */
  async deleteMatrix(actorId: string, matrixId: string): Promise<void> {
    return this.matrices.deleteMatrix(actorId, matrixId);
  }

  /**
   * Thêm ô vào ma trận (matrix:edit): ĐƠN VỊ KIẾN THỨC phải
   * thuộc chương trình của ma trận (ô neo ĐVK — issue #249, ma trận
   * không gắn YCCĐ), mức phải thuộc bộ mức của ma trận, và khi ma
   * trận có phạm vi đã dạy (scope_node_ids) thì ĐVK phải nằm trong
   * phạm vi.
   */
  async createMatrixCell(actorId: string, matrixId: string, input: CreateExamMatrixCellDto): Promise<ExamMatrixView> {
    return this.matrices.createMatrixCell(actorId, matrixId, input);
  }

  /** Sửa một ô (matrix:edit) — khoá ĐVK/mức/dạng không đổi qua sửa; muốn đổi thì xoá ô tạo lại. */
  async updateMatrixCell(actorId: string, matrixId: string, cellId: string, input: UpdateExamMatrixCellDto): Promise<ExamMatrixView> {
    return this.matrices.updateMatrixCell(actorId, matrixId, cellId, input);
  }

  /** Xoá một ô khỏi ma trận (matrix:edit). */
  async deleteMatrixCell(actorId: string, matrixId: string, cellId: string): Promise<ExamMatrixView> {
    return this.matrices.deleteMatrixCell(actorId, matrixId, cellId);
  }

  /**
   * Khả dụng ngân hàng theo từng ô cho người gọi (matrix:use):
   * cần / có / thiếu. Generate khoá cứng khi bất kỳ ô nào thiếu.
   */
  async matrixAvailability(actorId: string, matrixId: string): Promise<{ matrixId: string; cells: MatrixCellAvailability[]; sufficient: boolean }> {
    return this.matrices.matrixAvailability(actorId, matrixId);
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
    return this.matrices.importAvailability(actorId, cells);
  }

  /**
   * Đọc ma trận cho generate (cổng matrix:edit tại context của
   * bank — E-8 qua requireMatrixCap) + các ô. EB-2: ExamsService
   * là phía điều phối generate; QuizService chỉ còn là nguồn dữ liệu
   * ma trận/pool và phía ghi slots vào quiz.
   */
  async matrixForGeneration(actorId: string, matrixId: string): Promise<{ matrix: ExamMatrixRow; cells: ExamMatrixCellRow[] }> {
    return this.generation.matrixForGeneration(actorId, matrixId);
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
    return this.generation.drawFixedSlots(actorId, cells);
  }

  /** Câu có thuộc pool của ô hay không (pool thô theo ĐVK + mức + dạng + ready — điểm neo swap-cùng-ô của EB-2 như swapSlot đã dùng). */
  async cellPoolContains(cellId: string, questionId: string): Promise<boolean> {
    return this.generation.cellPoolContains(cellId, questionId);
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
    return this.generation.getMatrixSpecification(actorId, matrixId, pinId);
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
    return this.generation.buildSpecificationForPaper(actorId, matrixId, paperSlots);
  }

  /** Thông tin tối thiểu của một quiz cho đặc tả theo đề (EB-3): phía gọi tự kiểm quiz có thuộc đề đang xét hay không. */
  async getPinSummary(pinId: string): Promise<{ id: string; name: string; examId: string | null; matrixId: string | null } | null> {
    return this.pins.getPinSummary(pinId);
  }

  /**
   * Xuất bản đặc tả ra file (xlsx qua exceljs — cùng hạ tầng với xuất
   * điểm vnEdu; docx qua gói docx): cùng một view model, hai định dạng
   * nộp/lưu hồ sơ. Định dạng khác → 400 quiz.spec_export_format.
   */
  async exportMatrixSpecification(actorId: string, matrixId: string, format: string, pinId?: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    return this.generation.exportMatrixSpecification(actorId, matrixId, format, pinId);
  }

  /**
   * Render một view model đặc tả ra file (xlsx qua exceljs — cùng hạ
   * tầng với xuất điểm vnEdu; docx qua gói docx): dùng chung cho đặc
   * tả theo ma trận (C.6), đặc tả theo đề và bản chụp trong bộ hồ sơ
   * (EB-3) — cùng một view model, hai định dạng nộp/lưu hồ sơ.
   */
  async renderSpecification(spec: MatrixSpecification, format: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    return this.generation.renderSpecification(spec, format);
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
    return this.attempts.resolveEffectiveSettings(quiz, userId);
  }

  /**
   * Điểm bài hiện tại của một học sinh theo grade_method của quiz (null
   * khi chưa có lượt nào chốt điểm).
   */
  async currentGradeForUser(quiz: PinRow, userId: string): Promise<number | null> {
    return this.attempts.currentGradeForUser(quiz, userId);
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
    return this.attempts.getQuizForUser(actorId, pinId);
  }

  /**
   * Bắt đầu lượt làm mới (hoặc trả về lượt đang dở để tiếp tục): kiểm cửa
   * sổ mở–đóng và số lần cho phép phía server, rút câu cho slot ngẫu
   * nhiên, tạo usage của engine với maxMark lấy từ TỪNG SLOT, pin phiên
   * bản câu ngay lúc bắt đầu. Preview của giáo viên (quiz:preview)
   * bỏ qua cửa sổ/giới hạn và không ghi điểm về sau.
   */
  async startAttempt(actorId: string, pinId: string, opts: { preview?: boolean; password?: string; clientIp?: string } = {}): Promise<QuizAttemptView> {
    return this.attempts.startAttempt(actorId, pinId, opts);
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
    return this.attempts.buildAttemptView(quiz, row, closedDueToTimeLimit, viewerId);
  }

  /**
   * Đọc một lượt làm (chủ lượt hoặc giáo viên). Nếu lượt đang dở mà đã
   * quá hạn làm bài, lần tương tác này chốt lượt phía server trước khi
   * trả kết quả.
   */
  async getAttemptView(actorId: string, attemptId: string): Promise<QuizAttemptView> {
    return this.attempts.getAttemptView(actorId, attemptId);
  }

  /**
   * Lưu câu trả lời của một câu trong lượt đang làm (ủy quyền engine ghi
   * step). Quá hạn làm bài: lượt bị chốt phía server ngay tại tương tác
   * này và view đã nộp được trả về thay vì ghi thêm đáp án.
   */
  async submitResponse(actorId: string, attemptId: string, input: { questionAttemptId: string; response?: string | null }, clientIp?: string): Promise<QuizAttemptView> {
    return this.attempts.submitResponse(actorId, attemptId, input, clientIp);
  }

  /**
   * Học sinh nộp bài: chốt lượt hiện tại của chính mình.
   */
  async submitAttempt(actorId: string, attemptId: string): Promise<QuizAttemptView> {
    return this.attempts.submitAttempt(actorId, attemptId);
  }

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
    return this.generation.resolvePaperLayout(actorId, pinId);
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
    return this.generation.recordPaperAttempt(actorId, pinId, input);
  }

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
    return this.attempts.getResults(actorId, pinId);
  }

  /**
   * Chấm tay một câu essay đang chờ (quiz:grade): điểm đi qua bước
   * chấm của question engine (ghi step + fraction), tổng điểm của lượt
   * được đồng bộ lại; khi câu cuối cùng được chấm, lượt về finished và
   * điểm bài được ghi lại vào sổ điểm.
   */
  async manualGrade(actorId: string, attemptId: string, input: { questionAttemptId: string; mark: number; comment?: string }): Promise<QuizAttemptView> {
    return this.attempts.manualGrade(actorId, attemptId, input);
  }

  /** Các dải nhận xét tổng quát của quiz (quiz:manage). */
  async listFeedbacks(actorId: string, pinId: string): Promise<ExamPinFeedbackRow[]> {
    return this.pins.listFeedbacks(actorId, pinId);
  }

  /** Tạo một dải nhận xét tổng quát (quiz:manage); dải tính theo % điểm của bài, [min, max). */
  async createFeedback(actorId: string, pinId: string, input: { minPercent: number; maxPercent: number; feedback: string }): Promise<ExamPinFeedbackRow> {
    return this.pins.createFeedback(actorId, pinId, input);
  }

  /** Xoá một dải nhận xét tổng quát (quiz:manage). */
  async deleteFeedback(actorId: string, pinId: string, feedbackId: string): Promise<void> {
    return this.pins.deleteFeedback(actorId, pinId, feedbackId);
  }

  /**
   * Ghi một sự kiện giám sát do client báo (thoát fullscreen, mất
   * focus, ngắt kết nối dài). Điều kiện: lượt của chính người báo, còn
   * đang làm, quiz bật monitor_events. CHỈ GHI NHẬN — không có bất kỳ
   * hệ quả tự động nào lên lượt làm.
   */
  async recordAttemptEvent(actorId: string, attemptId: string, input: { type: string; data?: Record<string, unknown> }): Promise<ExamAttemptEventRow> {
    return this.attempts.recordAttemptEvent(actorId, attemptId, input);
  }

  /** Nhật ký sự kiện giám sát của một lượt (chủ lượt hoặc người có quyền chấm/báo cáo). */
  async listAttemptEvents(actorId: string, attemptId: string): Promise<ExamAttemptEventRow[]> {
    return this.attempts.listAttemptEvents(actorId, attemptId);
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
    return this.attempts.listQuestionGradingQueue(actorId, pinId, questionId);
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
    return this.attempts.gradeQuestionForAttempts(actorId, pinId, input);
  }

  /**
   * Các lượt làm của một quiz cho chủ nhân hoặc giáo viên — dùng cho
   * trang thông tin (lượt của tôi) và báo cáo.
   */
  async listAttemptSummaries(actorId: string, pinId: string): Promise<QuizAttemptSummary[]> {
    return this.attempts.listAttemptSummaries(actorId, pinId);
  }
}
