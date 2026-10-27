import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ExamMatrixContributionView, ExamMatrixView } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import type { QuestionBankRow } from '../questions/question-banks.repository';
import type { CopyExamMatrixDto, CreateMatrixContributionDto, RejectMatrixContributionDto } from './dto/quiz.dto';
import { QuizRepository, type ExamMatrixCellRow, type ExamMatrixContributionRow, type ExamMatrixRow } from './quiz.repository';
import { QuizService } from './quiz.service';
import { isMatrixContentSignatureConflict, matrixContentSignature } from './matrix-content-signature';

/**
 * Dòng ghi công của một ma trận (theo đúng khuôn AttributionView
 * của câu hỏi): ma trận nguồn đã copy, bank nguồn, tác giả gốc và
 * hai bộ đếm dùng thật — số lượt được copy đi và số version đề đã
 * sinh từ ma trận này.
 */
export interface MatrixAttributionView {
  matrixId: string;
  isCopy: boolean;
  derivedFromMatrixId: string | null;
  originalAuthorId: string | null;
  originalAuthorName: string | null;
  sourceBankId: string | null;
  sourceBankName: string | null;
  copyCount: number;
  useCount: number;
}

/**
 * Bộ capability của lớp ngân hàng ma trận — đủ bộ matrix:*
 * use/add/edit/copy/share/moderate sau đợt đồng bộ khuôn ngân hàng
 * (issue #228, lát S3; MB-1 của issue #111 mở đầu bằng
 * copy/share/moderate và còn neo xem/sửa vào quiz:* của Chặng 3).
 * Tất cả đánh giá TẠI CONTEXT CỦA BANK (E-8).
 */
export const MATRIX_BANK_CAPS = {
  view: 'matrix:use',
  add: 'matrix:add',
  manage: 'matrix:edit',
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
 *   mới, derived_from_matrix_id trỏ về mẫu, version về 1, hạ cánh
 *   `ready` (quy tắc hoàn thiện: sao chép vào bank là đường vào bank
 *   ở dạng đã hoàn thiện) — sửa bản copy fork version mới, không
 *   đụng mẫu (bất biến truy vết).
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
    view: boolean; add: boolean; manage: boolean; copy: boolean; share: boolean; moderate: boolean;
  }> {
    if (matrix.bankId) {
      const bank = await this.banks.findBankById(matrix.bankId);
      if (bank) {
        await this.banks.syncBankMembership(bank);
        return this.banks.bankLocalMatrixCaps(actorId, bank);
      }
    }
    const at = async (cap: string) => this.evaluator.hasCapability(actorId, cap, matrix.contextId);
    const [view, add, manage, copy, share, moderate] = await Promise.all([
      at(MATRIX_BANK_CAPS.view), at(MATRIX_BANK_CAPS.add), at(MATRIX_BANK_CAPS.manage), at(MATRIX_BANK_CAPS.copy),
      at(MATRIX_BANK_CAPS.share), at(MATRIX_BANK_CAPS.moderate),
    ]);
    return { view, add, manage, copy, share, moderate };
  }

  /**
   * Deep copy một ma trận vào bank đích trong MỘT transaction: dòng
   * ma trận mang danh tính mới + toàn bộ ô sao nguyên (giữ
   * curriculum_node_id — ô neo ĐVK của chương trình, không neo bank);
   * derived_from_matrix_id trỏ về nguồn; version về 1 — và version 1
   * đó là hàng version bất biến của chính bản copy (chụp cấu hình
   * của nguồn tại thời điểm copy), toàn bộ ô sao thuộc về version
   * này: bản copy có lịch sử version độc lập với nguồn ngay từ đầu.
   *
   * Chữ ký nội dung của bản sao (lát chống trùng của issue #233)
   * tính từ ĐÚNG nội dung của bản sao — tên sau ghi đè nếu có + phần
   * đầu và toàn bộ ô của nguồn — và ghi ngay trong transaction: nếu
   * bank đích đã có một ma trận trùng toàn bộ nội dung, ràng buộc
   * duy nhất (bank, chữ ký) chặn bản sao và toàn bộ transaction
   * rollback, dịch thành 409 `quiz.matrix_duplicate_content` thay vì
   * lỗi 500 thô.
   *
   * @throws ConflictException khi bank đích đã có ma trận trùng toàn
   *   bộ nội dung với bản sao.
   */
  private async deepCopyMatrix(actorId: string, source: ExamMatrixRow, targetBank: QuestionBankRow, opts: {
    status: 'draft' | 'ready'; isTemplate: boolean; name?: string;
  }): Promise<ExamMatrixRow> {
    const cells = await this.repo.listMatrixCells(source.id);
    const contentSignature = matrixContentSignature({
      name: opts.name ?? source.name,
      subjectId: source.subjectId, curriculumId: source.curriculumId,
      levelSet: source.levelSet, totalScore: source.totalScore,
      scopeNote: source.scopeNote, scopeNodeIds: source.scopeNodeIds,
      cells,
    });
    try {
      return await this.repo.dbHandle.transaction(async (tx) => {
        const copy = await this.repo.insertMatrix({
          tenantId: targetBank.tenantId,
          name: opts.name ?? source.name,
          subjectId: source.subjectId, curriculumId: source.curriculumId,
          contextId: source.contextId,
          bankId: targetBank.id, status: opts.status, isTemplate: opts.isTemplate,
          derivedFromMatrixId: source.id, version: 1,
          // Truy vết copy đầy đủ theo khuôn câu hỏi: bank nguồn tại
          // thời điểm copy + tác giả gốc giữ nguyên qua các đời copy;
          // bộ đếm của nguồn tăng trong cùng transaction.
          derivedFromBankId: source.bankId,
          originalAuthorId: source.originalAuthorId ?? source.createdBy,
          presetKind: source.presetKind,
          targetFormPercents: source.targetFormPercents, targetLevelPercents: source.targetLevelPercents,
          levelSet: source.levelSet, scopeNote: source.scopeNote, scopeNodeIds: source.scopeNodeIds,
          totalScore: source.totalScore, contentSignature, createdBy: actorId,
        }, tx);
        const firstVersion = await this.repo.insertMatrixVersion({
          matrixId: copy.id, version: 1,
          presetKind: source.presetKind,
          targetFormPercents: source.targetFormPercents, targetLevelPercents: source.targetLevelPercents,
          levelSet: source.levelSet, scopeNote: source.scopeNote, scopeNodeIds: source.scopeNodeIds,
          totalScore: source.totalScore, createdBy: actorId,
        }, tx);
        for (const cell of cells) {
          await this.repo.insertMatrixCell({
            matrixId: copy.id, matrixVersionId: firstVersion.id, curriculumNodeId: cell.curriculumNodeId,
            cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype,
            questionCount: cell.questionCount, cellScore: cell.cellScore,
            minutes: cell.minutes, tfScale: cell.tfScale, position: cell.position,
          }, tx);
        }
        await this.repo.bumpMatrixCopyCount(source.id, tx);
        return copy;
      });
    } catch (err) {
      if (isMatrixContentSignatureConflict(err)) {
        throw new ConflictException({ message: 'A matrix with identical content already exists in the target bank', code: 'quiz.matrix_duplicate_content' });
      }
      throw err;
    }
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
      note: row.note, contentHash: row.contentHash, nearDuplicateOf: row.nearDuplicateOf,
      status: row.status as ExamMatrixContributionView['status'],
      rejectReason: row.rejectReason, reviewerId: row.reviewerId, resultMatrixId: row.resultMatrixId,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Hash nội dung của một ma trận (chống trùng đóng góp): cấu hình
   * định hình lưới (preset, tỉ lệ dạng/mức, bộ mức, phạm vi, tổng
   * điểm) + toàn bộ ô của version hiện hành đã sắp theo vị trí
   * (nút chương trình, mức nhận thức, dạng câu, số câu, điểm, thang
   * Đ–S). Tên ma trận KHÔNG vào hash — trùng ở đây là trùng CẤU
   * TRÚC lưới, hai ma trận khác tên vẫn là một lưới. Khuôn hash
   * ngang hàng `examPaperContentHash` của đề.
   */
  private matrixContentHash(matrix: ExamMatrixRow, cells: ExamMatrixCellRow[]): string {
    const config = [
      matrix.presetKind, matrix.levelSet, String(matrix.totalScore),
      JSON.stringify(matrix.targetFormPercents), JSON.stringify(matrix.targetLevelPercents),
      JSON.stringify(matrix.scopeNodeIds), matrix.scopeNote ?? '',
    ].join('::');
    const body = [...cells]
      .sort((a, b) => a.position - b.position)
      .map((c) => [
        c.curriculumNodeId ?? '', c.cognitiveLevel, c.qtype,
        c.questionCount, c.cellScore, c.minutes ?? '', JSON.stringify(c.tfScale),
      ].join('@'))
      .join('|');
    return createHash('sha256').update(`${config}::${body}`).digest('hex');
  }

  /** Tra một ma trận theo id KHÔNG gác quyền — chỉ dùng ở biên MCP để kiểm chủ sở hữu trước khi đề xuất đóng góp (cổng đầy đủ vẫn nằm ở proposeContribution). */
  async findMatrixById(matrixId: string): Promise<ExamMatrixRow | undefined> {
    return this.repo.getMatrix(matrixId);
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
   * nguồn trong bank), cổng đích là cổng TẠO matrix:add tại bank đích
   * (bank-local; copy là ghi một ma trận mới vào bank đích — khuôn
   * S3). Ma trận hidden chỉ chủ sở hữu/người duyệt mới copy được.
   * Bản copy hạ cánh `ready` tại bank đích theo quy tắc hoàn thiện
   * (sao chép vào bank ở dạng đã hoàn thiện — cùng hạ cánh với
   * đường duyệt đóng góp), version 1.
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
    if (!targetCaps.add) {
      throw new ForbiddenException({ message: 'No matrix:add on the target matrix bank', code: 'quiz.matrix_copy_target_forbidden' });
    }
    const copy = await this.deepCopyMatrix(actorId, source, target, { status: 'ready', isTemplate: false, name: input.name });
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
   *
   * Chống trùng (issue #228 — ngang hàng câu hỏi và đề): hash nội
   * dung của ma trận nguồn tính tại lúc đề xuất; một ma trận trong
   * bank đích có cùng hash thì ghi near_duplicate_of trỏ tới ma
   * trận đó để người duyệt cân nhắc (trùng suy từ chính ma trận
   * nguồn bị chặn 409 lúc duyệt — xem approveContribution).
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
    const hash = this.matrixContentHash(source, await this.repo.listMatrixCells(source.id));
    let nearDuplicateOf: string | null = null;
    for (const other of await this.repo.listMatricesByBank(target.id)) {
      const otherHash = this.matrixContentHash(other, await this.repo.listMatrixCells(other.id));
      if (otherHash === hash) { nearDuplicateOf = other.id; break; }
    }
    const row = await this.repo.insertMatrixContribution({
      matrixId: source.id, targetBankId: target.id, proposerId: actorId, note: input.note ?? '',
      contentHash: hash, nearDuplicateOf,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'quiz', type: 'exam_matrix_contribution_proposed',
      payload: { contributionId: row.id, matrixId: source.id, targetBankId: target.id, actorId, nearDuplicateOf },
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
   * reviewer_id là người duyệt. Bank đích đã có bản copy suy từ
   * chính ma trận nguồn thì chặn 409 — chống trùng tuyệt đối ngang
   * hàng đường duyệt đóng góp của đề (`exam.duplicate_in_bank`).
   */
  async approveContribution(actorId: string, bankId: string, contributionId: string): Promise<ExamMatrixContributionView> {
    const bank = await this.getMatrixBankOrThrow(bankId);
    await this.requireModerator(actorId, bank);
    const contribution = await this.getPendingContribution(bank, contributionId);
    const source = await this.getMatrixRow(contribution.matrixId);
    const inTarget = await this.repo.listMatricesByBank(bank.id);
    if (inTarget.some((m) => m.derivedFromMatrixId === source.id)) {
      throw new ConflictException({
        message: `An identical matrix already exists in the target bank (copied from ${source.id})`,
        code: 'quiz.matrix_duplicate_in_bank',
      });
    }
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

  /**
   * Dòng ghi công của một ma trận: cổng là quyền XEM trên ma trận
   * nguồn (cùng bộ quyền nguồn của copy/đóng góp) — người không xem
   * được ma trận thì không đọc được truy vết của nó.
   */
  async getAttribution(actorId: string, matrixId: string): Promise<MatrixAttributionView> {
    const matrix = await this.getMatrixRow(matrixId);
    const caps = await this.sourceCapsOf(actorId, matrix);
    if (!caps.view) {
      throw new ForbiddenException({ message: 'No access to the source matrix', code: 'quiz.matrix_attribution_source_forbidden' });
    }
    const [names, generated, sourceBank] = await Promise.all([
      matrix.originalAuthorId ? this.banks.displayNames([matrix.originalAuthorId]) : Promise.resolve(new Map<string, string>()),
      this.repo.listExamVersionsByMatrix(matrix.id),
      matrix.derivedFromBankId ? this.banks.findBankById(matrix.derivedFromBankId) : Promise.resolve(undefined),
    ]);
    return {
      matrixId: matrix.id,
      isCopy: matrix.derivedFromMatrixId !== null,
      derivedFromMatrixId: matrix.derivedFromMatrixId,
      originalAuthorId: matrix.originalAuthorId,
      originalAuthorName: matrix.originalAuthorId ? (names.get(matrix.originalAuthorId) ?? null) : null,
      sourceBankId: matrix.derivedFromBankId,
      sourceBankName: sourceBank?.name ?? null,
      copyCount: matrix.copyCount,
      useCount: generated.length,
    };
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
