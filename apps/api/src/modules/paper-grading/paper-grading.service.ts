/**
 * Dịch vụ chấm bài giấy bằng camera (CAM-0, issue #112): sinh lô phiếu
 * (ghim layout qua QuizService.resolvePaperLayout + chụp roster lớp),
 * sinh PDF phiếu, tiếp nhận ảnh chụp qua CỔNG CHẤT LƯỢNG (ảnh hỏng bị
 * từ chối ngay, không vào hàng chờ), đọc OMR xác định, hai hàng chờ
 * của giáo viên (gán định danh + xác nhận ca mơ hồ) và ghi attempt
 * "thi giấy" qua QuizService.recordPaperAttempt.
 *
 * Nguyên tắc cứng của lát: điểm KHÔNG BAO GIỜ tự chảy — phiếu chỉ
 * được ghi khi định danh chắc chắn (QR thuộc lô + có trong roster,
 * hoặc mã tô đúng số kiểm tra và khớp roster, hoặc giáo viên gán tay)
 * và mọi câu mơ hồ đã được giáo viên xác nhận. Mọi thao tác đều gác
 * bằng capability `quiz:gradepaper` tại context của hoạt động quiz,
 * giống hệt các đường chấm khác của Quiz.
 */
import {
  BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import {
  PAPER_SCAN_STATUSES, type CreatePaperBatch, type PaperBatch, type PaperReading,
  type PaperScan, type PaperScanStatus, type ResolvePaperReadings,
} from '@lms/contracts';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { EnrolService } from '../enrol/enrol.service';
import { FilesService } from '../files/files.service';
import { QuizService } from '../quiz/quiz.service';
import type { QuizRow } from '../quiz/quiz.repository';
import { SiteConfigService } from '../site-config/site-config.service';
import { UsersService } from '../users/users.service';
import { DEFAULT_OMR_THRESHOLDS, encodePng, processSheetImage, type OmrThresholds } from './domain/omr';
import { computeSheetGeometry, studentCodeForIndex, studentIndexForCode } from './domain/sheet-layout';
import { generateSheetsPdf, parseSheetQr, type SheetPageStudent } from './domain/sheet-pdf';
import { PaperGradingRepository, type PaperBatchRow, type PaperScanRow } from './paper-grading.repository';

export const PAPER_COMPONENT = 'mod_quiz';
const GRADE_PAPER_CAP = 'quiz:gradepaper';

export interface ScanUploadOutcome {
  fileName: string;
  stored: boolean;
  /** Lý do cổng chất lượng từ chối (chỉ khi stored = false): missing_fiducials | blurry | glare | too_dark | unreadable_image. */
  reasons?: string[];
  scan?: PaperScan;
}

@Injectable()
export class PaperGradingService {
  constructor(
    private readonly repo: PaperGradingRepository,
    private readonly quiz: QuizService,
    private readonly enrol: EnrolService,
    private readonly users: UsersService,
    private readonly files: FilesService,
    private readonly config: SiteConfigService,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
  ) {}

  // --- helpers ---------------------------------------------------------------

  /** Context của course module chứa quiz — cùng quy ước với QuizService. */
  private async cmContextId(quiz: QuizRow): Promise<string> {
    if (quiz.cmId) {
      const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.MODULE, quiz.cmId);
      if (ctx) return ctx.id;
    }
    const courseCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, quiz.course);
    if (!courseCtx) throw new NotFoundException({ message: `No context for quiz ${quiz.id}`, code: 'quiz.context_missing' });
    return courseCtx.id;
  }

  private async requireGradePaper(actorId: string, quiz: QuizRow): Promise<void> {
    await this.evaluator.requireCapability(actorId, GRADE_PAPER_CAP, await this.cmContextId(quiz));
  }

  private async getBatchRow(quizId: string, batchId: string): Promise<PaperBatchRow> {
    const row = await this.repo.getBatch(batchId);
    if (!row || row.quizId !== quizId) {
      throw new NotFoundException({ message: `Paper batch ${batchId} not found`, code: 'paper.batch_not_found' });
    }
    return row;
  }

  private async getScanRow(scanId: string): Promise<PaperScanRow> {
    const row = await this.repo.getScan(scanId);
    if (!row) throw new NotFoundException({ message: `Paper scan ${scanId} not found`, code: 'paper.scan_not_found' });
    return row;
  }

  /** Layout của lô theo thứ tự in (slot tăng dần) — vị trí thứ i trong mảng này là hàng thứ i+1 trên phiếu. */
  private sortedLayout(batch: PaperBatchRow) {
    return [...batch.layout].sort((a, b) => a.slot - b.slot);
  }

  private statusFor(studentId: string | null, readings: PaperReading[]): PaperScanStatus {
    if (!studentId) return 'needs_identity';
    if (readings.some((r) => r.state === 'ambiguous')) return 'needs_review';
    return 'ready';
  }

  private batchView(row: PaperBatchRow): PaperBatch {
    return {
      id: row.id, quizId: row.quizId, variantCode: row.variantCode,
      layout: row.layout, roster: row.roster, createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private scanView(row: PaperScanRow, batch: PaperBatchRow): PaperScan {
    const layout = this.sortedLayout(batch);
    const geometry = computeSheetGeometry(layout.map((l) => l.optionCount));
    const student = row.studentId ? batch.roster.find((r) => r.userId === row.studentId) : undefined;
    return {
      id: row.id, quizId: row.quizId, batchId: row.batchId, status: row.status as PaperScanStatus,
      studentId: row.studentId, studentName: student?.displayName ?? null,
      identitySource: row.identitySource as PaperScan['identitySource'],
      identityCode: row.identityCode,
      fileId: row.fileId, warpedFileId: row.warpedFileId,
      rows: geometry.rows.map((g, i) => ({ slot: layout[i]!.slot, centers: g.centers })),
      quality: row.quality, readings: row.readings, attemptId: row.attemptId,
      uploadedBy: row.uploadedBy,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async omrThresholds(): Promise<OmrThresholds> {
    const [fillDensity, blankDensity, minMargin] = await Promise.all([
      this.config.getValue<number>('mod_quiz', 'omrfilldensity'),
      this.config.getValue<number>('mod_quiz', 'omrblankdensity'),
      this.config.getValue<number>('mod_quiz', 'omrminmargin'),
    ]);
    return {
      fillDensity: fillDensity ?? DEFAULT_OMR_THRESHOLDS.fillDensity,
      blankDensity: blankDensity ?? DEFAULT_OMR_THRESHOLDS.blankDensity,
      minMargin: minMargin ?? DEFAULT_OMR_THRESHOLDS.minMargin,
    };
  }

  // --- lô phiếu ---------------------------------------------------------------

  /**
   * Sinh một lô phiếu (một mã đề): layout ghim qua QuizService (cổng
   * quiz:gradepaper + chặn slot ngẫu nhiên/loại câu không in được nằm
   * ở đó), roster chụp từ danh sách ghi danh đang hiệu lực của khoá —
   * chỉ học sinh có quyền làm bài (quiz:attempt) mới có phiếu, sắp
   * theo tên để đánh mã tô 001… cho phiếu trắng.
   */
  async createBatch(actorId: string, quizId: string, input: CreatePaperBatch): Promise<PaperBatch> {
    const { quiz, layout } = await this.quiz.resolvePaperLayout(actorId, quizId);
    const existing = await this.repo.listBatchesForQuiz(quizId);
    let variantCode = input.variantCode?.trim().toUpperCase();
    if (variantCode) {
      if (existing.some((b) => b.variantCode === variantCode)) {
        throw new ConflictException({ message: `Variant ${variantCode} already exists for this quiz`, code: 'paper.variant_exists' });
      }
    } else {
      variantCode = this.nextVariantCode(existing.map((b) => b.variantCode));
    }

    const cmCtx = await this.cmContextId(quiz);
    const enrolments = await this.enrol.listEnrolmentsForCourse(quiz.course);
    const now = new Date();
    const activeUserIds = [...new Set(enrolments
      .filter((e) => e.status === 0 && (!e.timeEnd || e.timeEnd > now))
      .map((e) => e.userId))];
    const users = await this.users.getUsersByIds(activeUserIds);
    const nameById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim() || u.username]));
    const students: { userId: string; displayName: string }[] = [];
    for (const userId of activeUserIds) {
      if (await this.evaluator.hasCapability(userId, 'quiz:attempt', cmCtx)) {
        students.push({ userId, displayName: nameById.get(userId) ?? userId });
      }
    }
    students.sort((a, b) => a.displayName.localeCompare(b.displayName, 'vi') || a.userId.localeCompare(b.userId));
    if (students.length > 999) {
      throw new UnprocessableEntityException({ message: 'Paper roster supports at most 999 students per batch', code: 'paper.roster_too_large' });
    }
    const roster = students.map((s, i) => ({ code: studentCodeForIndex(i), userId: s.userId, displayName: s.displayName }));

    const row = await this.repo.insertBatch({ quizId, variantCode, layout, roster, createdBy: actorId });
    return this.batchView(row);
  }

  private nextVariantCode(used: string[]): string {
    const taken = new Set(used);
    for (let round = 0; ; round++) {
      for (let c = 0; c < 26; c++) {
        const candidate = String.fromCharCode(65 + c) + (round === 0 ? '' : String(round));
        if (!taken.has(candidate)) return candidate;
      }
    }
  }

  async listBatches(actorId: string, quizId: string): Promise<PaperBatch[]> {
    const quiz = await this.quiz.getQuiz(quizId);
    await this.requireGradePaper(actorId, quiz);
    const rows = await this.repo.listBatchesForQuiz(quizId);
    return rows.map((r) => this.batchView(r));
  }

  async getBatch(actorId: string, quizId: string, batchId: string): Promise<PaperBatch> {
    const quiz = await this.quiz.getQuiz(quizId);
    await this.requireGradePaper(actorId, quiz);
    return this.batchView(await this.getBatchRow(quizId, batchId));
  }

  /**
   * Tải PDF phiếu của lô: mặc định mọi phiếu cá nhân hoá (mỗi học sinh
   * một trang); `studentId` chọn một phiếu cá nhân hoá; `kind=blank`
   * cho phiếu trắng ô-tô-mã (mặc định số bản bằng sĩ số roster).
   */
  async sheetsPdf(actorId: string, quizId: string, batchId: string, opts: { studentId?: string; kind?: string; copies?: number }): Promise<{ buffer: Buffer; fileName: string }> {
    const quiz = await this.quiz.getQuiz(quizId);
    await this.requireGradePaper(actorId, quiz);
    const batch = await this.getBatchRow(quizId, batchId);
    let pages: (SheetPageStudent | null)[];
    let suffix: string;
    if (opts.kind === 'blank') {
      const copies = Math.min(200, Math.max(1, opts.copies ?? Math.max(batch.roster.length, 1)));
      pages = Array.from({ length: copies }, () => null);
      suffix = 'trang';
    } else if (opts.studentId) {
      const entry = batch.roster.find((r) => r.userId === opts.studentId);
      if (!entry) throw new NotFoundException({ message: 'Student is not in this batch roster', code: 'paper.student_not_in_batch' });
      pages = [entry];
      suffix = entry.code;
    } else {
      if (!batch.roster.length) {
        throw new BadRequestException({ message: 'Batch roster is empty; print blank sheets instead', code: 'paper.empty_roster' });
      }
      pages = batch.roster;
      suffix = 'ca-nhan';
    }
    const buffer = await generateSheetsPdf({
      quizName: quiz.name, variantCode: batch.variantCode, batchId: batch.id,
      layout: this.sortedLayout(batch), pages,
    });
    return { buffer, fileName: `phieu-tra-loi-${batch.variantCode}-${suffix}.pdf` };
  }

  // --- tiếp nhận ảnh ------------------------------------------------------------

  /**
   * Tiếp nhận một lượt tải ảnh chụp cho một lô: từng ảnh chạy qua
   * cổng chất lượng NGAY tại đây — ảnh hỏng bị từ chối với lý do cụ
   * thể và KHÔNG được lưu; ảnh đạt cổng được OMR đọc, định danh theo
   * thứ tự tin cậy QR → ô tô mã (đúng số kiểm tra + khớp roster) →
   * hàng chờ gán định danh. Trả kết quả theo từng tệp để giáo viên
   * chụp lại đúng tờ bị từ chối.
   */
  async uploadScans(actorId: string, quizId: string, batchId: string, files: { originalname: string; buffer: Buffer; mimetype: string }[]): Promise<ScanUploadOutcome[]> {
    const quiz = await this.quiz.getQuiz(quizId);
    await this.requireGradePaper(actorId, quiz);
    const batch = await this.getBatchRow(quizId, batchId);
    if (!files.length) throw new BadRequestException({ message: 'No image files were uploaded', code: 'paper.no_files' });

    const layout = this.sortedLayout(batch);
    const geometry = computeSheetGeometry(layout.map((l) => l.optionCount));
    const thresholds = await this.omrThresholds();
    const retentionMonths = (await this.config.getValue<number>('mod_quiz', 'paperscanretentionmonths')) ?? 18;
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + retentionMonths);
    const cmCtx = await this.cmContextId(quiz);
    const rosterByUserId = new Map(batch.roster.map((r) => [r.userId, r]));

    const outcomes: ScanUploadOutcome[] = [];
    for (const file of files) {
      const fileName = (file.originalname || 'scan').split(/[\\/]/).pop()!;
      let processed: ReturnType<typeof processSheetImage>;
      try {
        processed = processSheetImage(file.buffer, geometry, thresholds);
      } catch {
        outcomes.push({ fileName, stored: false, reasons: ['unreadable_image'] });
        continue;
      }
      if (!processed.qualityOk) {
        outcomes.push({ fileName, stored: false, reasons: processed.qualityReasons });
        continue;
      }

      // Định danh: QR (phải thuộc đúng lô này + học sinh có trong roster) → ô tô mã.
      let studentId: string | null = null;
      let identitySource: 'qr' | 'bubbles' | null = null;
      let identityCode: string | null = processed.bubbleCode?.code ?? null;
      const qr = parseSheetQr(processed.qrText);
      if (qr && qr.batchId === batch.id && qr.userId && rosterByUserId.has(qr.userId)) {
        studentId = qr.userId;
        identitySource = 'qr';
        identityCode = rosterByUserId.get(qr.userId)!.code;
      } else if (processed.bubbleCode?.checksumOk) {
        const idx = studentIndexForCode(processed.bubbleCode.code);
        const entry = idx !== null ? batch.roster[idx] : undefined;
        if (entry) {
          studentId = entry.userId;
          identitySource = 'bubbles';
          identityCode = entry.code;
        }
      }

      const original = await this.files.upload({
        contextId: cmCtx, component: PAPER_COMPONENT, fileArea: 'paper_scans', itemId: batch.id,
        fileName, data: file.buffer, mimeType: file.mimetype, userId: actorId,
      });
      const warped = await this.files.upload({
        contextId: cmCtx, component: PAPER_COMPONENT, fileArea: 'paper_warped', itemId: batch.id,
        fileName: `warped-${fileName.replace(/\.[^.]+$/, '')}.png`, data: encodePng(processed.warped),
        mimeType: 'image/png', userId: actorId,
      });
      // reading.slot của engine là số thứ tự hàng (1..n theo layout đã sắp); đổi về slot thật của layout.
      const readings: PaperReading[] = processed.readings.map((r) => ({
        slot: layout[r.slot - 1]!.slot,
        densities: r.densities, chosen: r.chosen, state: r.state, margin: r.margin,
        resolvedBy: r.resolvedBy,
      }));
      const scan = await this.repo.insertScan({
        batchId: batch.id, quizId, fileId: original.id, warpedFileId: warped.id,
        studentId, identitySource, identityCode,
        status: this.statusFor(studentId, readings),
        quality: processed.quality, readings, uploadedBy: actorId, expiresAt,
      });
      outcomes.push({ fileName, stored: true, scan: this.scanView(scan, batch) });
    }

    if (outcomes.length && outcomes.every((o) => !o.stored)) {
      const reasons = [...new Set(outcomes.flatMap((o) => o.reasons ?? []))];
      throw new UnprocessableEntityException({
        message: `All uploaded images were rejected by the quality gate: ${reasons.join(', ')}`,
        code: 'paper.all_images_rejected',
      });
    }
    return outcomes;
  }

  // --- hàng chờ -----------------------------------------------------------------

  async listScans(actorId: string, quizId: string, status?: string): Promise<PaperScan[]> {
    const quiz = await this.quiz.getQuiz(quizId);
    await this.requireGradePaper(actorId, quiz);
    if (status && !(PAPER_SCAN_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException({ message: `Unknown paper scan status ${status}`, code: 'paper.bad_status' });
    }
    const rows = await this.repo.listScansForQuiz(quizId, status);
    const out: PaperScan[] = [];
    for (const row of rows) {
      const batch = await this.repo.getBatch(row.batchId);
      if (batch) out.push(this.scanView(row, batch));
    }
    return out;
  }

  async getScan(actorId: string, scanId: string): Promise<PaperScan> {
    const scan = await this.getScanRow(scanId);
    const quiz = await this.quiz.getQuiz(scan.quizId);
    await this.requireGradePaper(actorId, quiz);
    const batch = await this.repo.getBatch(scan.batchId);
    if (!batch) throw new NotFoundException({ message: 'Paper batch of this scan no longer exists', code: 'paper.batch_not_found' });
    return this.scanView(scan, batch);
  }

  /** Ảnh gốc/ảnh đã nắn của phiếu — chỉ trả qua cổng quiz:gradepaper của chính quiz chứa phiếu. */
  async scanImage(actorId: string, scanId: string, kind: string): Promise<{ data: Buffer; mimeType: string; fileName: string }> {
    const scan = await this.getScanRow(scanId);
    const quiz = await this.quiz.getQuiz(scan.quizId);
    await this.requireGradePaper(actorId, quiz);
    const fileId = kind === 'warped' ? scan.warpedFileId : kind === 'original' ? scan.fileId : null;
    if (!fileId) throw new NotFoundException({ message: `No ${kind} image for this scan`, code: 'paper.image_not_found' });
    const { file, data } = await this.files.readContent(fileId);
    return { data, mimeType: file.mimeType ?? 'application/octet-stream', fileName: file.fileName };
  }

  /** Hàng chờ gán định danh: giáo viên chọn đúng học sinh (phải có trong roster của lô). */
  async assignIdentity(actorId: string, scanId: string, studentId: string): Promise<PaperScan> {
    const scan = await this.getScanRow(scanId);
    if (scan.status === 'recorded') throw new ConflictException({ message: 'Scan is already recorded as an attempt', code: 'paper.already_recorded' });
    const quiz = await this.quiz.getQuiz(scan.quizId);
    await this.requireGradePaper(actorId, quiz);
    const batch = await this.repo.getBatch(scan.batchId);
    if (!batch) throw new NotFoundException({ message: 'Paper batch of this scan no longer exists', code: 'paper.batch_not_found' });
    const entry = batch.roster.find((r) => r.userId === studentId);
    if (!entry) throw new BadRequestException({ message: 'Student is not in this batch roster', code: 'paper.student_not_in_roster' });
    const updated = await this.repo.updateScan(scan.id, {
      studentId, identitySource: 'manual', identityCode: entry.code,
      status: this.statusFor(studentId, scan.readings),
    });
    return this.scanView(updated, batch);
  }

  /** Hàng chờ ca mơ hồ: giáo viên quyết ô chọn cho từng câu đang ambiguous (chosen null = để trống). */
  async resolveReadings(actorId: string, scanId: string, input: ResolvePaperReadings): Promise<PaperScan> {
    const scan = await this.getScanRow(scanId);
    if (scan.status === 'recorded') throw new ConflictException({ message: 'Scan is already recorded as an attempt', code: 'paper.already_recorded' });
    const quiz = await this.quiz.getQuiz(scan.quizId);
    await this.requireGradePaper(actorId, quiz);
    const batch = await this.repo.getBatch(scan.batchId);
    if (!batch) throw new NotFoundException({ message: 'Paper batch of this scan no longer exists', code: 'paper.batch_not_found' });
    const optionCountBySlot = new Map(batch.layout.map((l) => [l.slot, l.optionCount]));
    const readings = scan.readings.map((r) => ({ ...r }));
    for (const item of input.readings) {
      const reading = readings.find((r) => r.slot === item.slot);
      if (!reading) throw new BadRequestException({ message: `Slot ${item.slot} is not on this sheet`, code: 'paper.unknown_slot' });
      if (reading.state !== 'ambiguous') {
        throw new BadRequestException({ message: `Slot ${item.slot} is not ambiguous`, code: 'paper.reading_not_ambiguous' });
      }
      const optionCount = optionCountBySlot.get(item.slot) ?? 0;
      if (item.chosen !== null && (item.chosen < 0 || item.chosen >= optionCount)) {
        throw new BadRequestException({ message: `Chosen option ${item.chosen} is out of range for slot ${item.slot}`, code: 'paper.choice_out_of_range' });
      }
      reading.chosen = item.chosen;
      reading.state = item.chosen === null ? 'blank' : 'filled';
      reading.resolvedBy = 'teacher';
    }
    const updated = await this.repo.updateScan(scan.id, {
      readings, status: this.statusFor(scan.studentId, readings),
    });
    return this.scanView(updated, batch);
  }

  /**
   * Ghi phiếu đã sẵn sàng thành attempt thi giấy: đáp án theo đúng
   * layout đã ghim của lô (multichoice = answerId; đúng/sai = 'true'/
   * 'false' theo thứ tự in Đ trước S sau; trống = null) qua đường
   * finalizeAttempt của Quiz — điểm vào sổ như attempt online.
   */
  async recordScan(actorId: string, scanId: string): Promise<PaperScan & { sumGrades: number | null }> {
    const scan = await this.getScanRow(scanId);
    if (scan.status === 'recorded') throw new ConflictException({ message: 'Scan is already recorded as an attempt', code: 'paper.already_recorded' });
    if (scan.status !== 'ready' || !scan.studentId) {
      throw new ConflictException({ message: 'Scan is not ready to record (identity or ambiguous readings unresolved)', code: 'paper.scan_not_ready' });
    }
    const quiz = await this.quiz.getQuiz(scan.quizId);
    await this.requireGradePaper(actorId, quiz);
    const batch = await this.repo.getBatch(scan.batchId);
    if (!batch) throw new NotFoundException({ message: 'Paper batch of this scan no longer exists', code: 'paper.batch_not_found' });

    const maxSlot = Math.max(...batch.layout.map((l) => l.slot));
    const responses: (string | null)[] = Array.from({ length: maxSlot }, () => null);
    for (const entry of batch.layout) {
      const reading = scan.readings.find((r) => r.slot === entry.slot);
      if (!reading || reading.chosen === null) continue;
      responses[entry.slot - 1] = entry.qtype === 'truefalse'
        ? (reading.chosen === 0 ? 'true' : 'false')
        : entry.answerIds[reading.chosen]!;
    }
    const result = await this.quiz.recordPaperAttempt(actorId, scan.quizId, {
      studentId: scan.studentId, layout: batch.layout, responses,
      scanId: scan.id, batchId: batch.id, variantCode: batch.variantCode,
    });
    const updated = await this.repo.updateScan(scan.id, { status: 'recorded', attemptId: result.attemptId });
    return { ...this.scanView(updated, batch), sumGrades: result.sumGrades };
  }

  /** Xoá một phiếu chưa ghi (sai/thừa) khỏi hàng chờ, kèm bản ghi file của nó. Phiếu đã ghi là bằng chứng điểm — không xoá. */
  async deleteScan(actorId: string, scanId: string): Promise<void> {
    const scan = await this.getScanRow(scanId);
    if (scan.status === 'recorded') throw new ConflictException({ message: 'A recorded scan is grade evidence and cannot be deleted', code: 'paper.scan_recorded' });
    const quiz = await this.quiz.getQuiz(scan.quizId);
    await this.requireGradePaper(actorId, quiz);
    await this.repo.deleteScan(scan.id);
    await this.files.deleteFile(scan.fileId).catch(() => undefined);
    if (scan.warpedFileId) await this.files.deleteFile(scan.warpedFileId).catch(() => undefined);
  }
}
