import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ExamMatrixContributionView, ExamMatrixView } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import type { QuestionBankRow } from '../questions/question-banks.repository';
import type { CopyExamMatrixDto, CreateMatrixContributionDto, RejectMatrixContributionDto } from './dto/quiz.dto';
import { QuizRepository, type ExamMatrixContributionRow, type ExamMatrixRow } from './quiz.repository';
import { QuizService } from './quiz.service';

/** Bộ capability của lớp ngân hàng ma trận (MB-1): xem/sửa là quyền Chặng 3, copy/share/moderate là matrix:* — tất cả đánh giá TẠI CONTEXT CỦA BANK (E-8). */
export const MATRIX_BANK_CAPS = {
  view: 'quiz:viewmatrix',
  manage: 'quiz:managematrix',
  copy: 'matrix:copy',
  share: 'matrix:share',
  moderate: 'matrix:moderate',
} as const;

@Injectable()
/**
 * Lớp BANK của Ngân hàng ma trận (MB-1, issue #111) — khuôn QB-1→QB-4
 * của ngân hàng câu hỏi áp cho ma trận:
 *
 * - Bank là question_banks với bank_kind='matrix' (bảng đa loại của
 *   PR #83); exam_matrices.bank_id neo vào bank, quyền MỘT nguồn duy
 *   nhất là context của bank (resolver trong QuizService).
 * - Copy mẫu → ma trận làm việc: deep copy toàn bộ ô với danh tính
 *   mới, derived_from_matrix_id trỏ về mẫu, version về 1, trạng thái
 *   draft — sửa bản copy không đụng mẫu (bất biến truy vết).
 * - Đóng góp + duyệt: giáo viên đề xuất ma trận ready của mình vào
 *   bank chung; người có matrix:moderate tại bank đích duyệt (= copy
 *   sâu vào bank đích, bản vào bank tổ/trường là MẪU) hoặc từ chối kèm
 *   lý do hiện lại cho người gửi.
 */
export class MatrixBanksService {
  constructor(
    private readonly repo: QuizRepository,
    private readonly quiz: QuizService,
    private readonly banks: QuestionBanksService,
    private readonly evaluator: PermissionEvaluator,
    private readonly outbox: OutboxService,
  ) {}

  // --- helpers -----------------------------------------------------------------

  /** Bank ma trận theo id: không có → 404; bank loại khác → 400. */
  private async getMatrixBankOrThrow(bankId: string): Promise<QuestionBankRow> {
    const bank = await this.banks.findBankById(bankId);
    if (!bank) throw new NotFoundException({ message: `Matrix bank ${bankId} not found`, code: 'quiz.matrix_bank_not_found' });
    if (bank.bankKind !== 'matrix') {
      throw new BadRequestException({ message: 'Bank is not a matrix bank', code: 'quiz.matrix_bank_kind_mismatch' });
    }
    return bank;
  }

  private async getMatrixRow(id: string): Promise<ExamMatrixRow> {
    const row = await this.repo.getMatrix(id);
    if (!row) throw new NotFoundException({ message: `Exam matrix ${id} not found`, code: 'quiz.matrix_not_found' });
    return row;
  }

  /**
   * Bộ quyền của actor trên một ma trận NGUỒN: ma trận thuộc bank thì
   * đọc quyền bank-local của bank đó (vai chuyên dụng tại context
   * bank); ma trận chưa thuộc bank thì đọc PermissionEvaluator tại
   * context môn (hành vi Chặng 3).
   */
  private async sourceCapsOf(actorId: string, matrix: ExamMatrixRow): Promise<{
    view: boolean; manage: boolean; copy: boolean; share: boolean; moderate: boolean;
  }> {
    if (matrix.bankId) {
      const bank = await this.banks.findBankById(matrix.bankId);
      if (bank) {
        await this.banks.syncBankMembership(bank);
        return this.banks.bankLocalMatrixCaps(actorId, bank);
      }
    }
    const at = async (cap: string) => this.evaluator.hasCapability(actorId, cap, matrix.contextId);
    const [view, manage, copy, share, moderate] = await Promise.all([
      at(MATRIX_BANK_CAPS.view), at(MATRIX_BANK_CAPS.manage), at(MATRIX_BANK_CAPS.copy),
      at(MATRIX_BANK_CAPS.share), at(MATRIX_BANK_CAPS.moderate),
    ]);
    return { view, manage, copy, share, moderate };
  }

  /**
   * Deep copy một ma trận vào bank đích trong MỘT transaction: dòng
   * ma trận mang danh tính mới + toàn bộ ô sao nguyên (giữ
   * learning_outcome_id — ô neo YCCĐ của chương trình, không neo bank);
   * derived_from_matrix_id trỏ về nguồn; version về 1.
   */
  private async deepCopyMatrix(actorId: string, source: ExamMatrixRow, targetBank: QuestionBankRow, opts: {
    status: 'draft' | 'ready'; isTemplate: boolean; name?: string;
  }): Promise<ExamMatrixRow> {
    const cells = await this.repo.listMatrixCells(source.id);
    return this.repo.dbHandle.transaction(async (tx) => {
      const copy = await this.repo.insertMatrix({
        name: opts.name ?? source.name,
        subjectId: source.subjectId, curriculumId: source.curriculumId,
        contextId: source.contextId,
        bankId: targetBank.id, status: opts.status, isTemplate: opts.isTemplate,
        derivedFromMatrixId: source.id, version: 1,
        presetKind: source.presetKind,
        targetFormPercents: source.targetFormPercents, targetLevelPercents: source.targetLevelPercents,
        levelSet: source.levelSet, scopeNote: source.scopeNote, scopeOutcomeIds: source.scopeOutcomeIds,
        totalScore: source.totalScore, createdBy: actorId,
      }, tx);
      for (const cell of cells) {
        await this.repo.insertMatrixCell({
          matrixId: copy.id, learningOutcomeId: cell.learningOutcomeId,
          cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype,
          questionCount: cell.questionCount, cellScore: cell.cellScore,
          minutes: cell.minutes, tfScale: cell.tfScale, position: cell.position,
        }, tx);
      }
      return copy;
    });
  }

  private async contributionView(row: ExamMatrixContributionRow): Promise<ExamMatrixContributionView> {
    const [names, matrix] = await Promise.all([
      this.banks.displayNames([row.proposerId]),
      this.repo.getMatrix(row.matrixId),
    ]);
    return {
      id: row.id, matrixId: row.matrixId, matrixName: matrix?.name ?? null,
      targetBankId: row.targetBankId, proposerId: row.proposerId,
      proposerName: names.get(row.proposerId) ?? null,
      note: row.note, status: row.status as ExamMatrixContributionView['status'],
      rejectReason: row.rejectReason, reviewerId: row.reviewerId, resultMatrixId: row.resultMatrixId,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  // --- danh sách ma trận trong bank ---------------------------------------------

  /**
   * Các ma trận của một bank ma trận: cổng vào là quyền XEM bank-local
   * (thành viên/phụ trách bank — người ngoài bank, kể cả gọi API trực
   * tiếp, nhận 403, khớp tiêu chí "không thấy bank tổ"). Ma trận ready
   * thấy cho mọi người vào được bank; draft/hidden chỉ chủ sở hữu,
   * người phụ trách bank và site admin thấy.
   */
  async listBankMatrices(actorId: string, bankId: string): Promise<ExamMatrixView[]> {
    const bank = await this.getMatrixBankOrThrow(bankId);
    // Bank ma trận personal của người khác → 404 như bank không tồn tại (issue #123).
    if (await this.banks.isForeignPersonalBank(actorId, bank)) {
      throw new NotFoundException({ message: `Matrix bank ${bankId} not found`, code: 'quiz.matrix_bank_not_found' });
    }
    await this.banks.syncBankMembership(bank);
    const caps = await this.banks.bankLocalMatrixCaps(actorId, bank);
    if (!caps.view) {
      throw new ForbiddenException({ message: `No access to matrix bank ${bankId}`, code: 'quiz.matrix_bank_forbidden' });
    }
    const isAdmin = await this.evaluator.isSiteAdmin(actorId);
    const rows = await this.repo.listMatricesByBank(bank.id);
    const visible = rows.filter((r) => r.status === 'ready' || r.createdBy === actorId || caps.manage || isAdmin);
    const out: ExamMatrixView[] = [];
    for (const row of visible) out.push(await this.quiz.viewMatrixRow(row));
    return out;
  }

  // --- copy mẫu → ma trận làm việc ----------------------------------------------

  /**
   * Copy một ma trận về bank đích (mặc định bank ma trận cá nhân của
   * người copy): cổng nguồn là matrix:copy trên nguồn (bank-local khi
   * nguồn trong bank), cổng đích là quyền phụ trách bank đích
   * (bank-local). Ma trận hidden chỉ chủ sở hữu/người duyệt mới copy
   * được.
   */
  async copyMatrix(actorId: string, matrixId: string, input: CopyExamMatrixDto): Promise<ExamMatrixView> {
    const source = await this.getMatrixRow(matrixId);
    const sourceCaps = await this.sourceCapsOf(actorId, source);
    if (!sourceCaps.copy) {
      throw new ForbiddenException({ message: 'No matrix:copy on the source matrix', code: 'quiz.matrix_copy_source_forbidden' });
    }
    if (source.status === 'hidden' && source.createdBy !== actorId && !sourceCaps.moderate) {
      throw new ForbiddenException({ message: 'Hidden matrices can only be copied by their owner or a moderator', code: 'quiz.matrix_hidden' });
    }
    const target = input.targetBankId
      ? await this.getMatrixBankOrThrow(input.targetBankId)
      : await this.banks.ensurePersonalBank(actorId, 'matrix', { forCopy: true });
    await this.banks.syncBankMembership(target);
    const targetCaps = await this.banks.bankLocalMatrixCaps(actorId, target);
    if (!targetCaps.manage) {
      throw new ForbiddenException({ message: 'No quiz:managematrix on the target matrix bank', code: 'quiz.matrix_copy_target_forbidden' });
    }
    const copy = await this.deepCopyMatrix(actorId, source, target, { status: 'draft', isTemplate: false, name: input.name });
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'exam_matrix_copied',
      payload: { sourceMatrixId: source.id, newMatrixId: copy.id, sourceBankId: source.bankId, targetBankId: target.id, actorId },
    });
    return this.quiz.viewMatrixRow(copy);
  }

  // --- đóng góp + duyệt (khuôn QB-4) ----------------------------------------------

  /**
   * Đề xuất đóng góp: ma trận nguồn phải ready; cổng matrix:share tại
   * context nguồn; đích phải là bank ma trận dùng chung (không phải
   * bank cá nhân); một đề xuất đang chờ cho cùng ma trận + cùng người
   * gửi + cùng bank đích thì không gửi trùng (409).
   */
  async proposeContribution(actorId: string, matrixId: string, input: CreateMatrixContributionDto): Promise<ExamMatrixContributionView> {
    const target = await this.getMatrixBankOrThrow(input.targetBankId);
    if (target.scope === 'personal') {
      throw new BadRequestException({ message: 'Contributions target shared matrix banks, not a personal bank', code: 'quiz.matrix_contribution_target_personal' });
    }
    const source = await this.getMatrixRow(matrixId);
    if (source.status !== 'ready') {
      throw new BadRequestException({ message: 'Only a ready matrix can be proposed as a contribution', code: 'quiz.matrix_contribution_source_not_ready' });
    }
    const sourceCaps = await this.sourceCapsOf(actorId, source);
    if (!sourceCaps.view) {
      throw new ForbiddenException({ message: 'No access to the source matrix', code: 'quiz.matrix_contribution_source_forbidden' });
    }
    if (!sourceCaps.share) {
      throw new ForbiddenException({ message: 'No matrix:share on the source matrix', code: 'quiz.matrix_share_forbidden' });
    }
    const pending = await this.repo.findPendingMatrixContribution(source.id, target.id, actorId);
    if (pending) {
      throw new ConflictException({ message: 'A pending contribution for this matrix to this bank already exists', code: 'quiz.matrix_contribution_pending_exists' });
    }
    const row = await this.repo.insertMatrixContribution({
      matrixId: source.id, targetBankId: target.id, proposerId: actorId, note: input.note ?? '',
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'exam_matrix_contribution_proposed',
      payload: { contributionId: row.id, matrixId: source.id, targetBankId: target.id, actorId },
    });
    return this.contributionView(row);
  }

  /**
   * Hàng chờ đóng góp của một bank: người duyệt (bank-local moderate)
   * thấy tất cả; thành viên thường chỉ thấy đề xuất của chính mình (để
   * xem kết quả duyệt và lý do từ chối).
   */
  async listContributions(actorId: string, bankId: string, status?: string): Promise<ExamMatrixContributionView[]> {
    const bank = await this.getMatrixBankOrThrow(bankId);
    await this.banks.syncBankMembership(bank);
    const caps = await this.banks.bankLocalMatrixCaps(actorId, bank);
    if (!caps.view) {
      throw new ForbiddenException({ message: `No access to matrix bank ${bankId}`, code: 'quiz.matrix_bank_forbidden' });
    }
    let rows = await this.repo.listMatrixContributions(bank.id, status);
    if (!caps.moderate) rows = rows.filter((r) => r.proposerId === actorId);
    const out: ExamMatrixContributionView[] = [];
    for (const row of rows) out.push(await this.contributionView(row));
    return out;
  }

  /** Mọi đề xuất đóng góp của chính người dùng (xem kết quả duyệt xuyên bank). */
  async listMyContributions(actorId: string): Promise<ExamMatrixContributionView[]> {
    const rows = await this.repo.listMatrixContributionsByProposer(actorId);
    const out: ExamMatrixContributionView[] = [];
    for (const row of rows) out.push(await this.contributionView(row));
    return out;
  }

  private async getPendingContribution(bank: QuestionBankRow, contributionId: string): Promise<ExamMatrixContributionRow> {
    const row = await this.repo.getMatrixContribution(contributionId);
    if (!row || row.targetBankId !== bank.id) {
      throw new NotFoundException({ message: `Matrix contribution ${contributionId} not found`, code: 'quiz.matrix_contribution_not_found' });
    }
    if (row.status !== 'pending') {
      throw new ConflictException({ message: 'Contribution is no longer pending', code: 'quiz.matrix_contribution_not_pending' });
    }
    return row;
  }

  /** Cổng duyệt: quyền moderate bank-local tại bank đích (sau đồng bộ thành viên). */
  private async requireModerator(actorId: string, bank: QuestionBankRow): Promise<void> {
    await this.banks.syncBankMembership(bank);
    const caps = await this.banks.bankLocalMatrixCaps(actorId, bank);
    if (!caps.moderate) {
      throw new ForbiddenException({ message: 'No matrix:moderate on the target matrix bank', code: 'quiz.matrix_moderate_forbidden' });
    }
  }

  /**
   * Duyệt đóng góp = copy sâu ma trận nguồn vào bank đích (người duyệt
   * chịu trách nhiệm về bản chung như QB-4): bản vào bank tổ/trường là
   * MẪU (is_template = true, status ready); truy vết giữ đủ ba đầu —
   * proposer_id trên hàng chờ, derived_from_matrix_id trên bản đích,
   * reviewer_id là người duyệt.
   */
  async approveContribution(actorId: string, bankId: string, contributionId: string): Promise<ExamMatrixContributionView> {
    const bank = await this.getMatrixBankOrThrow(bankId);
    await this.requireModerator(actorId, bank);
    const contribution = await this.getPendingContribution(bank, contributionId);
    const source = await this.getMatrixRow(contribution.matrixId);
    const copy = await this.deepCopyMatrix(actorId, source, bank, {
      status: 'ready', isTemplate: bank.scope === 'personal' ? source.isTemplate : true,
    });
    await this.repo.updateMatrixContribution(contribution.id, {
      status: 'approved', reviewerId: actorId, resultMatrixId: copy.id, rejectReason: null,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'exam_matrix_contribution_approved',
      payload: { contributionId: contribution.id, matrixId: source.id, newMatrixId: copy.id, targetBankId: bank.id, actorId },
    });
    return this.contributionView((await this.repo.getMatrixContribution(contribution.id))!);
  }

  /** Từ chối đóng góp: lý do BẮT BUỘC (DTO đã chặn rỗng), hiện lại cho người gửi trong hàng chờ của họ. */
  async rejectContribution(actorId: string, bankId: string, contributionId: string, input: RejectMatrixContributionDto): Promise<ExamMatrixContributionView> {
    const bank = await this.getMatrixBankOrThrow(bankId);
    await this.requireModerator(actorId, bank);
    const contribution = await this.getPendingContribution(bank, contributionId);
    await this.repo.updateMatrixContribution(contribution.id, {
      status: 'rejected', reviewerId: actorId, rejectReason: input.reason, resultMatrixId: null,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'exam_matrix_contribution_rejected',
      payload: { contributionId: contribution.id, targetBankId: bank.id, actorId },
    });
    return this.contributionView((await this.repo.getMatrixContribution(contribution.id))!);
  }
}
