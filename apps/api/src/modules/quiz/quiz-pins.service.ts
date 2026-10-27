import { BadRequestException, NotFoundException } from '@nestjs/common';
import type {
  PinRegradeLogEntry,
  PinRegradeResult,
  PinVersionUpdatePreview,
  PinVersionUpdateSlotDiff,
  ExamPinOverrideView,
  QuizView,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { GradesService } from '../grades/grades.service';
import { GroupsService } from '../groups/groups.service';
import { QuestionsService, type UsageView } from '../questions/questions.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import type { CreateExamPinOverrideDto, UpdateExamPinOverrideDto } from './dto/quiz.dto';
import { EXAM_KIND_PRESETS, type ExamKind } from './domain/matrix';
import { isValidSubnetList } from './domain/subnet';
import {
  QuizRepository,
  type ExamAttemptRow,
  type ExamPinFeedbackRow,
  type ExamPinOverrideRow,
  type ExamPinRow,
} from './quiz.repository';
import { QuizSharedService } from './quiz-shared.service';
import { QuizAttemptsService } from './quiz-attempts.service';
import { QUIZ_COMPONENT } from './quiz-shared.service';
import { QUIZ_CAPABILITIES } from './quiz-shared.service';
import type { PinRow } from './quiz.service';

/**
 * Cụm ghim đề và vòng đời lần ghim của QuizService (cụm 1 của issue
 * #295): tạo/đọc/sửa/xoá lần ghim, cập nhật version tường minh +
 * chấm lại của issue #254 (giữ trọn trong cụm này, không tách riêng),
 * ghi đè theo người học, phản hồi theo ngưỡng điểm, công bố/huỷ
 * công bố kết quả, và tóm tắt pin. Nhóm phản hồi theo ngưỡng điểm
 * nằm ở cuối file gốc nhưng thuộc cụm này theo bản đồ đặc tả.
 *
 * Cụm này gọi xuống tầng thấp dùng chung (`QuizSharedService`) và gọi
 * sang cụm lượt làm đúng một phép (`pushGrade` của `QuizAttemptsService`
 * trong chấm lại) — ngoài hai đường đó, cụm không phụ thuộc cụm nào.
 * Các method vốn `private` nhưng cụm khác gọi đã nới thành public nội
 * bộ module; bề mặt công khai ra ngoài module vẫn qua facade.
 */

export class QuizPinsService {
  constructor(
    private readonly repo: QuizRepository,
    private readonly courses: CoursesService,
    private readonly evaluator: PermissionEvaluator,
    private readonly questions: QuestionsService,
    private readonly grades: GradesService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly groups: GroupsService,
    private readonly outbox: OutboxService,
    private readonly shared: QuizSharedService,
    private readonly attempts: QuizAttemptsService,
  ) {}

  /** Pin đã có lượt làm thật thì exam version đã ghim bị khoá (lượt đã pin câu theo version đó). */
  async assertPinUnlocked(pin: PinRow): Promise<void> {
    const attempts = await this.repo.listAttempts(pin.id);
    if (attempts.some((a) => !a.preview)) {
      throw new BadRequestException({ message: 'This pin already has real attempts; its pinned exam version is locked', code: 'exam.pin_locked' });
    }
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

  /** Nhóm đích của lần ghim phải thuộc đúng khoá của lần ghim (chốt bổ sung 26/10 — ghim neo KHOÁ HỌC, nhóm là của khoá đó). */
  private async assertTargetGroup(courseId: string, targetGroupId: string | null | undefined): Promise<void> {
    if (targetGroupId === undefined || targetGroupId === null) return;
    const group = await this.groups.getGroup(targetGroupId).catch(() => null);
    if (!group || group.courseId !== courseId) {
      throw new BadRequestException({ message: 'Target group does not belong to this course', code: 'exam.pin_target_group_invalid' });
    }
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
    return this.shared.pinView(await this.shared.getPin(pin.id));
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
    const pin = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, pin, QUIZ_CAPABILITIES.manage);
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
    const updated = await this.shared.getPin(pin.id);
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
    return this.shared.pinView(updated);
  }

  /**
   * Xoá pin cùng attempts, usages của engine, course module và
   * grade item của hoạt động (quiz:manage). Đề trong bank không bị
   * ảnh hưởng — xoá pin chỉ gỡ lần tổ chức trong khoá này.
   */
  async deletePin(actorId: string, pinId: string): Promise<void> {
    const pin = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, pin, QUIZ_CAPABILITIES.manage);
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
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
    const pin = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, pin, QUIZ_CAPABILITIES.manage);
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
    const updated = await this.shared.getPin(pin.id);
    if (updated.cmId) {
      const item = await this.grades.getItemForCm(updated.course, updated.cmId);
      if (item) await this.grades.updateItem(actorId, item.id, { gradeMax: target.totalScore });
    }
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'exam_pin_version_updated',
      payload: { pinId: pin.id, courseId: pin.course, fromExamVersionId: pin.examVersionId, toExamVersionId: target.id, actorId },
    });
    return this.shared.pinView(updated);
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.grade);
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
      const oldSumGrades = this.shared.syncFromUsage(usage).sumGrades;
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
        const { sumGrades, pendingManual } = this.shared.syncFromUsage(afterUsage);
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
        const updated = await this.shared.getAttemptRow(c.attempt.id);
        if (updated.state === 'finished') await this.attempts.pushGrade(quiz, c.attempt.userId);
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports);
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
    const quiz = await this.shared.getPin(pinId);
    if (!quiz.resultsPublishedAt && !(await this.shared.hasCap(actorId, quiz, QUIZ_CAPABILITIES.viewReports))) {
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
      out.push(await this.shared.pinView(await this.shared.enrichPin(r)));
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
    const pin = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, pin, QUIZ_CAPABILITIES.manage);
    await this.repo.updatePin(pin.id, { resultsPublishedAt: new Date() });
    return this.shared.pinView(await this.shared.getPin(pin.id));
  }

  /** Thu hồi công bố kết quả của pin (quiz:manage). */
  async unpublishResults(actorId: string, pinId: string): Promise<QuizView> {
    const pin = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, pin, QUIZ_CAPABILITIES.manage);
    await this.repo.updatePin(pin.id, { resultsPublishedAt: null });
    return this.shared.pinView(await this.shared.getPin(pin.id));
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
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
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manageOverrides);
    const row = await this.getOverrideRow(quiz, overrideId);
    await this.repo.deleteOverride(row.id);
    await this.outbox.enqueueStandalone({ aggregate: 'quiz', type: 'quiz_override_deleted', payload: { pinId: quiz.id, courseId: quiz.course, overrideId: row.id, actorId } });
  }

  // --- ma trận đề (Chặng 3) ---------------------------------------------------------

  /** Thông tin tối thiểu của một quiz cho đặc tả theo đề (EB-3): phía gọi tự kiểm quiz có thuộc đề đang xét hay không. */
  async getPinSummary(pinId: string): Promise<{ id: string; name: string; examId: string | null; matrixId: string | null } | null> {
    const row = await this.repo.getPin(pinId);
    if (!row) return null;
    const quiz = await this.shared.enrichPin(row);
    return { id: quiz.id, name: quiz.name, examId: quiz.examId, matrixId: quiz.matrixId };
  }

  /** Các dải nhận xét tổng quát của quiz (quiz:manage). */
  async listFeedbacks(actorId: string, pinId: string): Promise<ExamPinFeedbackRow[]> {
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    return this.repo.listFeedbacks(quiz.id);
  }

  /** Tạo một dải nhận xét tổng quát (quiz:manage); dải tính theo % điểm của bài, [min, max). */
  async createFeedback(actorId: string, pinId: string, input: { minPercent: number; maxPercent: number; feedback: string }): Promise<ExamPinFeedbackRow> {
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    if (!(input.minPercent < input.maxPercent)) {
      throw new BadRequestException({ message: 'minPercent must be below maxPercent', code: 'quiz.feedback_range' });
    }
    return this.repo.insertFeedback({ pinId: quiz.id, minPercent: input.minPercent, maxPercent: input.maxPercent, feedback: input.feedback });
  }

  /** Xoá một dải nhận xét tổng quát (quiz:manage). */
  async deleteFeedback(actorId: string, pinId: string, feedbackId: string): Promise<void> {
    const quiz = await this.shared.getPin(pinId);
    await this.shared.requireCap(actorId, quiz, QUIZ_CAPABILITIES.manage);
    const bands = await this.repo.listFeedbacks(quiz.id);
    if (!bands.some((b) => b.id === feedbackId)) {
      throw new NotFoundException({ message: `Quiz feedback ${feedbackId} not found`, code: 'quiz.feedback_not_found' });
    }
    await this.repo.deleteFeedback(feedbackId);
  }
}
