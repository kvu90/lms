import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import type {
  QuestionSolution,
  QuizAttemptSummary,
  QuizView,
  RichTextDocument,
} from '@lms/contracts';
import { extractRichTextPlainText } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { FilesService } from '../files/files.service';
import { GradesService } from '../grades/grades.service';
import { GroupsService } from '../groups/groups.service';
import { QuestionsService } from '../questions/questions.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import { ipMatchesSubnetList } from './domain/subnet';
import {
  QUIZ_PIN_ATTEMPTS_LIMIT,
  QuizRepository,
  type ExamAttemptEventRow,
  type ExamAttemptRow,
  type ExamPinOverrideRow,
} from './quiz.repository';
import { QuizSharedService } from './quiz-shared.service';
import { QUIZ_COMPONENT } from './quiz-shared.service';
import { QUIZ_CAPABILITIES } from './quiz-shared.service';
import type {
  EffectiveQuizSettings,
  QuizAttemptQuestionView,
  QuizAttemptView,
  QuizQuestionStat,
  QuizResultsSummary,
  QuizNeedsGradingView,
  PinRow,
  EffectiveSlotRow,
} from './quiz.service';

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

/**
 * Cụm lượt làm, chấm và kết quả của QuizService (cụm 4 của issue
 * #295): thiết lập hiệu lực, bắt đầu lượt, nộp bài, chấm tay, hàng
 * đợi chấm theo câu, kết quả/thống kê, và sự kiện lượt làm. Cụm này
 * gọi xuống tầng thấp dùng chung (`QuizSharedService`); hai method
 * vốn `private` nhưng cụm khác gọi (`pushGrade` cho chấm lại của cụm
 * ghim, `finalizeAttempt` cho lượt giấy của cụm sinh đề) nay để public
 * trong nội bộ module, không phải bề mặt API của module.
 *
 * Hai hằng cửa sổ xem lại (`REVIEW_WINDOW`,
 * `REVIEW_IMMEDIATELY_AFTER_MS`) chuyển về đây cùng nơi dùng thật
 * (phép tính cửa sổ xem lại), facade re-export lại.
 *
 * Lưu ý duy nhất về log: hai cảnh báo ghi điểm của `pushGrade` trước
 * đây mang tên logger `QuizService`, nay mang tên
 * `QuizAttemptsService` (nơi chứa method thật) — nội dung cảnh báo
 * không đổi.
 */

export class QuizAttemptsService {
  private readonly logger = new Logger(QuizAttemptsService.name);

  constructor(
    private readonly repo: QuizRepository,
    private readonly courses: CoursesService,
    private readonly questions: QuestionsService,
    private readonly grades: GradesService,
    private readonly users: UsersService,
    private readonly enrol: EnrolService,
    private readonly passwords: PasswordService,
    private readonly groups: GroupsService,
    private readonly outbox: OutboxService,
    private readonly files: FilesService,
    private readonly shared: QuizSharedService,
  ) {}

  /** Người dùng có thuộc phạm vi đích của lần ghim không: ghim toàn khoá (targetGroupId null) thì mọi học sinh của khoá đều thuộc; ghim theo nhóm thì chỉ thành viên nhóm đích. */
  private async isInTargetGroup(quiz: PinRow, userId: string): Promise<boolean> {
    if (!quiz.targetGroupId) return true;
    const mine = await this.groups.groupsOfUser(quiz.course, userId);
    return mine.some((g) => g.id === quiz.targetGroupId);
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
    const slots = await this.shared.effectiveSlots(quiz);
    if (!slots.length) return { canAttempt: false, reason: 'no_questions', inProgressAttemptId: null, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
    return { canAttempt: true, reason: null, inProgressAttemptId: null, nextAttemptAt: null, passwordRequired: effective.passwordRequired };
  }

  /**
   * Điểm bài hiện tại của một học sinh theo grade_method của quiz (null
   * khi chưa có lượt nào chốt điểm).
   */
  async currentGradeForUser(quiz: PinRow, userId: string): Promise<number | null> {
    const finished = (await this.repo.listAttemptsForUser(quiz.id, userId)).filter((a) => a.state === 'finished' && a.sumGrades !== null);
    return this.gradeFromFinishedAttempts(quiz, finished);
  }

  /**
   * Điểm bài hiện tại từ tập lượt ĐÃ KẾT THÚC có sumGrades của một
   * học sinh, chọn theo grade_method của bài (DL-03, issue #489):
   * tổng maxMark của các usage trong tập được nạp MỘT lần theo lô
   * thay vì `getUsage` theo từng lượt như trước, rồi tính qua
   * `gradeFromTotals`. Đây là đường của phép tính cho MỘT học sinh
   * (`currentGradeForUser`); trang kết quả không gọi hàm này theo
   * từng học sinh — nó nạp tổng của toàn bộ lượt đã kết thúc của cả
   * bài trong một lần rồi dùng thẳng `gradeFromTotals` cho từng
   * học sinh.
   */
  private async gradeFromFinishedAttempts(quiz: PinRow, finished: ExamAttemptRow[]): Promise<number | null> {
    if (!finished.length) return null;
    const totals = await this.questions.usageTotalMaxes(finished.map((a) => a.usageId));
    return this.gradeFromTotals(quiz, finished, totals);
  }

  /**
   * Tính điểm bài từ tập lượt ĐÃ KẾT THÚC của một học sinh khi map
   * tổng maxMark theo usage đã được nạp sẵn: thuần tính trong bộ
   * nhớ, không phát sinh truy vấn. Thứ tự `finished` quyết định
   * first/last nên caller phải truyền đúng thứ tự liệt kê của
   * repository (số lượt tăng dần cho một học sinh).
   */
  private gradeFromTotals(quiz: PinRow, finished: ExamAttemptRow[], totals: Map<string, number>): number | null {
    const values: number[] = [];
    for (const a of finished) {
      const v = this.shared.attemptGradeValue(quiz, a, totals.get(a.usageId) ?? 0);
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
   * Hạng mục điểm của bài đã ở trạng thái ĐÃ CÔNG BỐ hay chưa, hỏi qua
   * cổng công bố chung của module điểm
   * (`GradesService.itemPublicationState`): hạng mục có chính sách
   * `auto` luôn coi là đã công bố; hạng mục `manual` chỉ được coi là
   * đã công bố khi vết công bố theo phạm vi hạng mục gần nhất là hành
   * động công bố. Bài chưa gắn course module, hoặc chưa có hạng mục
   * điểm (lần ghim đời cũ, trước cơ chế hạng mục), thì không có cổng
   * công bố nào áp lên được — coi như đã công bố để giữ nguyên hành vi
   * cũ, phần gác còn lại do mặt nạ xem lại đảm nhiệm.
   */
  private async gradeTotalsPublished(quiz: PinRow): Promise<boolean> {
    if (!quiz.cmId) return true;
    const item = await this.grades.getItemForCm(quiz.course, quiz.cmId).catch(() => undefined);
    if (!item) return true;
    return (await this.grades.itemPublicationState(item)).published;
  }

  /**
   * Mặt nạ `reviewMarks` có đang mở cho CHỦ LƯỢT tại cửa sổ xem lại
   * hiện tại của lượt này không — cùng phép tính với điểm từng câu
   * trong `buildAttemptView`: cổng `reviewAttempt` phải mở tại cửa sổ
   * hiện tại trước, rồi bit `reviewMarks` tại đúng cửa sổ đó mới có
   * hiệu lực. Lượt đang làm dở thì chưa có điểm tổng nào được phép
   * hiện.
   */
  private async ownerMarksVisible(quiz: PinRow, row: ExamAttemptRow, now: Date): Promise<boolean> {
    if (row.state === 'inprogress') return false;
    const windowBit = await this.reviewWindowBit(quiz, row, now);
    if ((quiz.reviewAttempt & windowBit) === 0) return false;
    return (quiz.reviewMarks & windowBit) !== 0;
  }

  /**
   * Che điểm tổng (`grade` + `sumGrades`) trong tóm tắt lượt phía CHỦ
   * LƯỢT (issue #411).
   *
   * Quy tắc nghiệp vụ (mục quy tắc về điểm trong `apps/api/AGENTS.md`):
   * học sinh/phụ huynh chỉ thấy điểm ĐÃ CÔNG BỐ, và mọi đường đọc điểm
   * phải qua cùng một cổng công bố. Điểm tổng vì thế chỉ hiện khi ĐỒNG
   * THỜI thoả cả hai điều kiện độc lập:
   *
   * 1. mặt nạ `reviewMarks` đang mở tại cửa sổ xem lại hiện tại của
   *    lượt (`marksVisible` do nơi gọi tính, dùng cùng phép tính với
   *    điểm từng câu); và
   * 2. hạng mục điểm của bài đã ở trạng thái đã công bố qua cổng công
   *    bố chung của module điểm (`gradeTotalsPublished`).
   *
   * Thiếu một trong hai điều kiện, cả `grade` lẫn `sumGrades` đều về
   * `null` — che một mình `grade` là không đủ, vì `sumGrades` cùng
   * thang tối đa của lượt cho phép suy ngược ra điểm. Lượt chưa có
   * điểm nào (cả hai trường đang `null`) được trả nguyên, không tốn
   * thêm lượt hỏi cổng công bố. Đường phía giáo viên/người có đặc
   * quyền không đi qua hàm này và giữ nguyên số thật.
   */
  private async maskOwnerTotals(quiz: PinRow, summary: QuizAttemptSummary, marksVisible: boolean): Promise<QuizAttemptSummary> {
    if (summary.grade === null && summary.sumGrades === null) return summary;
    if (marksVisible && (await this.gradeTotalsPublished(quiz))) return summary;
    return { ...summary, grade: null, sumGrades: null };
  }

  /**
   * Điểm bài hiện tại (`myGrade`) cho trang thông tin quiz phía CHỦ
   * LƯỢT: nhân sự (quản lý/chấm/báo cáo/preview) thấy số thật như hiện
   * tại; học viên chỉ thấy số thật khi điểm tổng qua được cổng che hai
   * điều kiện của `maskOwnerTotals`, xét trên lượt đã chốt điểm GẦN
   * NHẤT của chính người xem — lượt gần nhất có cửa sổ xem lại khắt
   * khe nhất nên lấy nó làm chuẩn là phía an toàn. Đường ghi sổ điểm
   * (`pushGrade`) KHÔNG đi qua hàm này: nó dùng thẳng
   * `currentGradeForUser` để luôn ghi số thật vào sổ điểm.
   */
  private async myGradeForViewer(quiz: PinRow, userId: string, ownAttempts: ExamAttemptRow[], isStaffViewer: boolean): Promise<number | null> {
    const value = await this.currentGradeForUser(quiz, userId);
    if (value === null || isStaffViewer) return value;
    const contributing = ownAttempts.filter((a) => !a.preview && a.state === 'finished' && a.sumGrades !== null);
    const latest = contributing[contributing.length - 1];
    if (!latest) return null;
    const marksVisible = await this.ownerMarksVisible(quiz, latest, new Date());
    return marksVisible && (await this.gradeTotalsPublished(quiz)) ? value : null;
  }

  /**
   * Trang thông tin quiz cho người xem: cấu hình + slots, các lượt của
   * chính người xem, điểm bài hiện tại và các cờ quyền để client hiển thị
   * đúng thao tác. Điểm tổng trong các lượt của chính người xem và điểm
   * bài hiện tại phía học viên đều qua cổng che hai điều kiện (mặt nạ
   * reviewMarks + hạng mục điểm đã công bố) — xem maskOwnerTotals và
   * myGradeForViewer (issue #411).
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireAnyViewCap(actorId, quiz);
    const view = await this.shared.pinView(quiz);
    const [manage, manageOverrides, grade, viewReports, preview, attempt] = await Promise.all([
      this.shared.hasCap(actorId, quiz, QUIZ_CAPABILITIES.manage),
      this.shared.hasCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides),
      this.shared.hasCap(actorId, quiz, QUIZ_CAPABILITIES.grade),
      this.shared.hasCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports),
      this.shared.hasCap(actorId, quiz, QUIZ_CAPABILITIES.preview),
      this.shared.hasCap(actorId, quiz, QUIZ_CAPABILITIES.attempt),
    ]);
    // Phạm vi nhóm đích: người xem không có vai trò nhân sự (quản
    // lý/chấm/báo cáo/preview) mà không thuộc nhóm đích thì lần ghim
    // coi như không tồn tại (404 — không lộ sự tồn tại).
    const isStaffViewer = manage || grade || viewReports || preview;
    if (!isStaffViewer && !(await this.isInTargetGroup(quiz, actorId))) {
      throw new NotFoundException({ message: `Exam pin ${pinId} not found`, code: 'exam.pin_not_found' });
    }
    const mine = await this.repo.listAttemptsForUser(quiz.id, actorId, true);
    // Tóm tắt theo lô (DL-03, issue #489): tổng điểm các usage nạp
    // một lần cho cả danh sách lượt của người xem.
    const rawSummaries = await this.shared.attemptSummaries(quiz, mine);
    const summaries: QuizAttemptSummary[] = [];
    for (const [index, a] of mine.entries()) {
      const summary = rawSummaries[index]!;
      // Điểm tổng phía học viên phải qua cổng che hai điều kiện (mặt
      // nạ reviewMarks tại cửa sổ hiện tại + hạng mục điểm đã công
      // bố) — xem maskOwnerTotals. Nhân sự và lượt preview của giáo
      // viên không bị che.
      summaries.push(!isStaffViewer && !a.preview
        ? await this.maskOwnerTotals(quiz, summary, await this.ownerMarksVisible(quiz, a, new Date()))
        : summary);
    }
    const eligibility = await this.attemptEligibility(quiz, actorId, new Date());
    const effective = await this.resolveEffectiveSettings(quiz, actorId);
    return {
      quiz: view,
      myAttempts: summaries,
      myGrade: await this.myGradeForViewer(quiz, actorId, mine, isStaffViewer),
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
    const quiz = await this.shared.getPin(pinId);
    const preview = opts.preview === true;
    if (preview) {
      await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.preview);
    } else {
      await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.attempt);
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
    const slots = await this.shared.effectiveSlots(quiz);
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
      component: QUIZ_COMPONENT, instanceId: quiz.id, contextId: await this.shared.cmContextId(quiz),
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
   * nằm ở tầng server, client không nhận được dữ liệu bị tắt. Riêng
   * trường `answers` của câu shortanswer cũng qua đúng cổng đáp án
   * đúng này (xem chốt trong vòng lặp dựng câu): các dòng đáp án của
   * shortanswer chính là tập đáp án được chấp nhận, để nguyên là lộ
   * đáp án đúng dù `solution` đã bị che. Riêng điểm TỔNG của lượt
   * còn phải qua thêm cổng công bố của hạng mục điểm (issue #411,
   * xem maskOwnerTotals): mặt nạ reviewMarks mở là chưa đủ nếu điểm
   * chưa được công bố. Người có
   * quiz:grade/viewreports/manage và lượt preview không bị giới hạn.
   */
  async buildAttemptView(quiz: PinRow, row: ExamAttemptRow, closedDueToTimeLimit: boolean, viewerId?: string): Promise<QuizAttemptView> {
    const usage = await this.questions.getUsage(row.usageId);
    const slots = await this.shared.effectiveSlots(quiz);
    const pageBySlot = new Map(slots.map((s) => [s.slot, s.page]));
    const submitted = row.state !== 'inprogress';
    const viewer = viewerId ?? row.userId;
    let privileged = row.preview || viewer !== row.userId;
    if (!privileged) {
      privileged = (await this.shared.hasCap(viewer, quiz, QUIZ_CAPABILITIES.grade))
        || (await this.shared.hasCap(viewer, quiz, QUIZ_CAPABILITIES.viewReports))
        || (await this.shared.hasCap(viewer, quiz, QUIZ_CAPABILITIES.manage));
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
      // Chốt bảo mật cho câu shortanswer: các dòng đáp án của dạng câu
      // này CHÍNH LÀ tập đáp án được chấp nhận (chấm khớp chính xác
      // theo cờ đúng), nên trường `answers` — vốn dựng vô điều kiện ở
      // cả hai đường trên cho mọi dạng câu — là đáp án đúng trá hình.
      // Khi người xem là chủ lượt không đặc quyền và cổng đáp án đúng
      // chưa mở cho người xem này (đúng điều kiện đang làm `solution`
      // thành null ở dưới: đang làm bài, hoặc sau nộp mà
      // reviewRightAnswer đóng tại cửa sổ hiện tại), trả `answers`
      // rỗng để đáp án được chấp nhận không rời server ở bất kỳ bề
      // mặt nào của lượt. Client không tiêu thụ trường này cho
      // shortanswer (lúc làm chỉ render ô nhập; lúc xem lại đọc đáp
      // án từ `solution` đã qua cổng) nên việc làm rỗng không phá
      // tính năng. Các dạng câu khác giữ nguyên: dòng đáp án của
      // multichoice là lựa chọn phải hiển thị, truefalse/essay không
      // mang đáp án trong trường này. Người có đặc quyền không qua
      // chốt này — vẫn thấy đủ như trước.
      if (!privileged && qv.question.qtype === 'shortanswer' && !aspectOn(quiz.reviewRightAnswer)) {
        answers = [];
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
    const { pendingManual } = this.shared.syncFromUsage(usage);
    // Tầng feedback thứ tư: nhận xét tổng quát theo dải % điểm.
    let overallFeedback: string | null = null;
    if (submitted && row.sumGrades !== null && aspectOn(quiz.reviewOverallFeedback)) {
      const totalMax = this.shared.usageTotalMax(usage);
      if (totalMax > 0) {
        const percent = (row.sumGrades / totalMax) * 100;
        const bands = await this.repo.listFeedbacks(quiz.id);
        const band = bands.find((b) => percent >= b.minPercent && (percent < b.maxPercent || (percent === 100 && b.maxPercent === 100)));
        overallFeedback = band?.feedback ?? null;
      }
    }
    const rawSummary = await this.shared.attemptSummary(quiz, row);
    // Điểm tổng trong view của CHỦ LƯỢT thường phải qua cùng cổng che
    // hai điều kiện như các đường đọc phía học viên khác (issue #411):
    // mặt nạ reviewMarks tại cửa sổ hiện tại — dùng đúng aspectOn như
    // điểm từng câu ở trên — cộng điều kiện hạng mục điểm đã công bố
    // qua cổng công bố chung (xem maskOwnerTotals). Người có đặc quyền
    // và lượt preview giữ nguyên số thật.
    const attemptSummary = !privileged && submitted
      ? await this.maskOwnerTotals(quiz, rawSummary, aspectOn(quiz.reviewMarks))
      : rawSummary;
    return {
      attempt: attemptSummary,
      quiz: await this.shared.pinView(quiz),
      questions,
      totalMax: this.shared.usageTotalMax(usage),
      pendingManualCount: pendingManual,
      closedDueToTimeLimit,
      overallFeedback,
    };
  }

  /**
   * Đọc một lượt làm (chủ lượt hoặc giáo viên). Nếu lượt đang dở mà đã
   * quá hạn làm bài, lần tương tác này chốt lượt phía server trước khi
   * trả kết quả.
   */
  async getAttemptView(actorId: string, attemptId: string): Promise<QuizAttemptView> {
    const row = await this.shared.getAttemptRow(attemptId);
    const quiz = await this.shared.getPin(row.pinId);
    await this.shared.requireAttemptReadable(actorId, quiz, row);
    if (row.state === 'inprogress' && row.userId === actorId && await this.isOverdue(quiz, row)) {
      return this.finalizeAttempt(quiz, await this.shared.getAttemptRow(attemptId), true);
    }
    return this.buildAttemptView(quiz, row, false, actorId);
  }

  /**
   * Lưu câu trả lời của một câu trong lượt đang làm (ủy quyền engine ghi
   * step). Quá hạn làm bài: lượt bị chốt phía server ngay tại tương tác
   * này và view đã nộp được trả về thay vì ghi thêm đáp án.
   */
  async submitResponse(actorId: string, attemptId: string, input: { questionAttemptId: string; response?: string | null }, clientIp?: string): Promise<QuizAttemptView> {
    const row = await this.shared.getAttemptRow(attemptId);
    const quiz = await this.shared.getPin(row.pinId);
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
    return this.buildAttemptView(quiz, await this.shared.getAttemptRow(attemptId), false);
  }

  /**
   * Chốt một lượt phía server: engine chấm toàn bộ usage, tổng điểm được
   * đồng bộ, lượt về finished (hoặc needsgrading khi còn essay), sự kiện
   * quiz_attempt_finished được phát và — khi đã chốt hẳn — điểm bài theo
   * grade_method được ghi vào sổ điểm.
   */
  public async finalizeAttempt(quiz: PinRow, row: ExamAttemptRow, closedDueToTimeLimit: boolean): Promise<QuizAttemptView> {
    if (row.state !== 'inprogress') return this.buildAttemptView(quiz, row, false);
    // Thang Đ–S của lần ghim đi cùng đường chốt usage để engine tra
    // thang cho câu truefalse TF-A (cấu hình của lần ghim, không nằm
    // trong câu hỏi); lần ghim không đặt thang thì engine dùng mặc
    // định QĐ 764.
    const finishedUsage = await this.questions.finishUsage(row.userId, row.usageId, { tfScale: quiz.tfScale });
    const { sumGrades, pendingManual } = this.shared.syncFromUsage(finishedUsage);
    const state = pendingManual > 0 ? 'needsgrading' : 'finished';
    await this.repo.updateAttempt(row.id, { state, timeFinish: new Date(), sumGrades });
    // Nộp tự động khi hết giờ là một sự kiện giám sát do SERVER ghi
    // (chỉ khi quiz bật ghi nhận) — cùng nguyên tắc chỉ-ghi-nhận.
    if (closedDueToTimeLimit && quiz.monitorEvents && !row.preview) {
      await this.repo.insertAttemptEvent({ attemptId: row.id, type: 'auto_submit_timeout' }).catch(() => undefined);
    }
    const updated = await this.shared.getAttemptRow(row.id);
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
    const row = await this.shared.getAttemptRow(attemptId);
    const quiz = await this.shared.getPin(row.pinId);
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
  public async pushGrade(quiz: PinRow, userId: string): Promise<void> {
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports);
    const rows = (await this.repo.listAttempts(quiz.id, QUIZ_PIN_ATTEMPTS_LIMIT)).filter((a) => !a.preview);
    // Tóm tắt và điểm bài đều suy từ chính tập lượt đã nạp (DL-03,
    // issue #489): tóm tắt theo lô một lần; tổng maxMark của toàn
    // bộ lượt đã kết thúc của cả bài cũng nạp theo lô MỘT lần, điểm
    // theo từng học sinh chỉ tính trong bộ nhớ từ các map đã nạp —
    // không truy vấn lại theo từng học sinh như trước.
    const attempts = await this.shared.attemptSummaries(quiz, rows);
    const userIds = [...new Set(rows.map((r) => r.userId))];
    // Gom lượt đã kết thúc theo học sinh, giữ nguyên thứ tự liệt kê
    // của repository trong từng học sinh để ngữ nghĩa first/last
    // của grade_method không đổi.
    const finishedByUser = new Map<string, ExamAttemptRow[]>();
    for (const r of rows) {
      if (r.state !== 'finished' || r.sumGrades === null) continue;
      const list = finishedByUser.get(r.userId);
      if (list) list.push(r);
      else finishedByUser.set(r.userId, [r]);
    }
    const finishedAttempts = [...finishedByUser.values()].flat();
    const finishedTotals = finishedAttempts.length
      ? await this.questions.usageTotalMaxes(finishedAttempts.map((a) => a.usageId))
      : new Map<string, number>();
    const gradesByUser = userIds.map((userId) => ({
      userId,
      grade: this.gradeFromTotals(quiz, finishedByUser.get(userId) ?? [], finishedTotals),
    }));
    const summary = await this.resultsSummary(quiz, rows, gradesByUser);
    const needsGrading: QuizNeedsGradingView[] = [];
    const gradingRows = rows.filter((a) => a.state === 'needsgrading');
    const gradingUsages = await this.questions.getUsages(gradingRows.map((r) => r.usageId));
    for (const r of gradingRows) {
      const usage = gradingUsages.get(r.usageId);
      if (!usage) continue;
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
    return { quiz: await this.shared.pinView(quiz), attempts, gradesByUser, needsGrading, questionStats, summary };
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
    // Usage của mọi lượt đã nộp nạp một lần theo lô (DL-03, issue #489).
    const usages = await this.questions.getUsages(submitted.map((r) => r.usageId));
    for (const r of submitted) {
      const usage = usages.get(r.usageId);
      if (!usage) continue;
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
    const row = await this.shared.getAttemptRow(attemptId);
    const quiz = await this.shared.getPin(row.pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.grade);
    const usage = await this.questions.getUsage(row.usageId);
    if (!usage.attempts.some((a) => a.id === input.questionAttemptId)) {
      throw new NotFoundException({ message: `Question attempt ${input.questionAttemptId} is not part of this quiz attempt`, code: 'quiz.question_attempt_not_found' });
    }
    await this.questions.manualGradeAttempt(actorId, input.questionAttemptId, input.mark, input.comment);
    const after = await this.questions.getUsage(row.usageId);
    const { sumGrades, pendingManual } = this.shared.syncFromUsage(after);
    const wasSubmitted = row.state === 'needsgrading' || row.state === 'finished';
    const nextState = row.state === 'inprogress' ? row.state : (pendingManual > 0 ? 'needsgrading' : 'finished');
    await this.repo.updateAttempt(row.id, { sumGrades, ...(wasSubmitted ? { state: nextState } : {}) });
    const updated = await this.shared.getAttemptRow(row.id);
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

  /**
   * Ghi một sự kiện giám sát do client báo (thoát fullscreen, mất
   * focus, ngắt kết nối dài). Điều kiện: lượt của chính người báo, còn
   * đang làm, quiz bật monitor_events. CHỈ GHI NHẬN — không có bất kỳ
   * hệ quả tự động nào lên lượt làm.
   */
  async recordAttemptEvent(actorId: string, attemptId: string, input: { type: string; data?: Record<string, unknown> }): Promise<ExamAttemptEventRow> {
    const row = await this.shared.getAttemptRow(attemptId);
    if (row.userId !== actorId) {
      throw new ForbiddenException({ message: 'This attempt belongs to another user', code: 'quiz.attempt_forbidden' });
    }
    const quiz = await this.shared.getPin(row.pinId);
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
    const row = await this.shared.getAttemptRow(attemptId);
    const quiz = await this.shared.getPin(row.pinId);
    await this.shared.requireAttemptReadable(actorId, quiz, row);
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.grade);
    const submitted = (await this.repo.listAttempts(quiz.id, QUIZ_PIN_ATTEMPTS_LIMIT)).filter((a) => !a.preview && a.state !== 'inprogress');
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
    // Usage của mọi lượt trong hàng đợi nạp một lần theo lô (DL-03, issue #489).
    const queueUsages = await this.questions.getUsages(submitted.map((r) => r.usageId));
    for (const r of submitted) {
      const usage = queueUsages.get(r.usageId);
      if (!usage) continue;
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.grade);
    const out: QuizAttemptSummary[] = [];
    for (const entry of input.grades) {
      const row = await this.shared.getAttemptRow(entry.attemptId);
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
   * trang thông tin (lượt của tôi) và báo cáo. Nhánh có
   * quiz:viewreports (cả lớp) giữ nguyên số thật; nhánh chủ lượt thì
   * điểm tổng phải qua cổng che hai điều kiện như mọi đường đọc phía
   * học viên (xem maskOwnerTotals, issue #411), trừ người có quyền
   * chấm/quản lý và lượt preview của giáo viên.
   */
  async listAttemptSummaries(actorId: string, pinId: string): Promise<QuizAttemptSummary[]> {
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireAnyViewCap(actorId, quiz);
    const canSeeAll = await this.shared.hasCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports);
    if (canSeeAll) {
      const rows = (await this.repo.listAttempts(quiz.id, QUIZ_PIN_ATTEMPTS_LIMIT)).filter((a) => !a.preview);
      return this.shared.attemptSummaries(quiz, rows);
    }
    const isStaffViewer = (await this.shared.hasCap(actorId, quiz, QUIZ_CAPABILITIES.grade))
      || (await this.shared.hasCap(actorId, quiz, QUIZ_CAPABILITIES.manage));
    const rows = await this.repo.listAttemptsForUser(quiz.id, actorId, true);
    // Tóm tắt theo lô (DL-03, issue #489) rồi mới áp mặt nạ theo từng lượt.
    const rawSummaries = await this.shared.attemptSummaries(quiz, rows);
    const out: QuizAttemptSummary[] = [];
    for (const [index, r] of rows.entries()) {
      const summary = rawSummaries[index]!;
      out.push(!isStaffViewer && !r.preview
        ? await this.maskOwnerTotals(quiz, summary, await this.ownerMarksVisible(quiz, r, new Date()))
        : summary);
    }
    return out;
  }
}
