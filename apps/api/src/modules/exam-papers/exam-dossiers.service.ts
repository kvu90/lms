import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import type {
  CreateExamDossier, ExamDossierView, RejectExamDossier,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import type { QuestionBankRow } from '../questions/question-banks.repository';
import { SiteConfigService } from '../site-config/site-config.service';
import { TenantConfigService } from '../tenants/tenant-config.service';
import { QuizService, type MatrixSpecification } from '../quiz/quiz.service';
import {
  ExamPapersRepository,
  type ExamDossierRow,
} from './exam-papers.repository';
import { ExamPapersService, EXAM_CAPABILITIES } from './exam-papers.service';

/**
 * Luồng duyệt BỘ HỒ SƠ đề (EB-3, issue #165) — đơn vị duyệt của
 * đề/ma trận là TOÀN BỘ tài liệu (khác câu hỏi duyệt từng câu, hồ sơ
 * ngân hàng đề mục A.3/F.2): một bộ hồ sơ ghim bộ ba {phiên bản ma
 * trận + phiên bản đề + bản đặc tả chụp tại lúc nộp} vào một bank đề
 * dùng chung và đi qua các cấp duyệt:
 *
 * - Cấp 1: người có `exam:moderate` tại context bank đích (tổ trưởng
 *   ở bank tổ, người được uỷ quyền ở bank trường) — cùng khuôn duyệt
 *   QB-4/MB-1: duyệt đạt là chốt bản vào bank đích và chịu trách
 *   nhiệm về bản chung.
 * - Cấp 2 (ban giám hiệu): CHỈ tồn tại khi cấu hình bật — xem điểm
 *   seam {@link ExamDossiersService.boardApprovalRequired}. Khi bật,
 *   cấp 1 duyệt chỉ đưa bộ sang `pending_board`; bộ hiệu lực (đề vào
 *   bank đích) sau khi qua cấp 2 bởi người có `exam:moderate` tại
 *   context HỆ THỐNG (vai lãnh đạo cấp trường/site admin).
 *
 * Mỗi mốc duyệt ghi một dòng `exam_dossier_reviews` độc lập + một sự
 * kiện audit ở outbox. Từ chối ở bất kỳ cấp nào cũng bắt buộc lý do
 * và đưa bộ về trạng thái `rejected` — người đóng góp xem được lý do
 * trong danh sách bộ hồ sơ của mình, sửa đề và lập bộ mới.
 */
@Injectable()
export class ExamDossiersService {
  constructor(
    private readonly repo: ExamPapersRepository,
    private readonly papers: ExamPapersService,
    private readonly banks: QuestionBanksService,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly quiz: QuizService,
    private readonly siteConfig: SiteConfigService,
    private readonly tenantConfig: TenantConfigService,
    private readonly outbox: OutboxService,
  ) {}

  // --- điểm seam cấu hình cấp duyệt 2 ---------------------------------------------

  /**
   * ⚠️ ĐIỂM SEAM CẤU HÌNH CẤP DUYỆT 2 (BGH) — nơi DUY NHẤT trong hệ
   * thống đọc công tắc "có cần cấp duyệt ban giám hiệu hay không".
   * Máy trạng thái bộ hồ sơ chỉ gọi điểm này; KHÔNG nơi nào khác đọc
   * trực tiếp khoá cấu hình.
   *
   * TENANT-1 (#196) — seam đã về cấu hình tenant như chỉ đạo EB-3
   * chờ sẵn: công tắc đọc qua `TenantConfigService.getEffectiveValue`
   * theo TENANT CỦA HỒ SƠ (tenant sở hữu bank đích — mỗi trường tự
   * quyết có cấp duyệt BGH hay không; giá trị tenant không có thì
   * TenantConfigService tự rơi về giá trị platform rồi mặc định TẮT
   * theo khuyến nghị của hồ sơ ngân hàng đề F.2). Bank đích là bank
   * dùng chung cấp platform (tenant_id NULL) hoặc chưa rõ hồ sơ thì
   * đọc thẳng giá trị platform qua SiteConfigService như trước.
   * Máy trạng thái không đổi.
   */
  async boardApprovalRequired(dossier?: ExamDossierRow): Promise<boolean> {
    let tenantId: string | null = null;
    if (dossier) {
      const bank = await this.banks.findBankById(dossier.targetBankId);
      tenantId = bank?.tenantId ?? null;
    }
    if (tenantId) {
      return (await this.tenantConfig.getEffectiveValue<boolean>(tenantId, 'exam', 'requireboardapproval')) ?? false;
    }
    return (await this.siteConfig.getValue<boolean>('exam', 'requireboardapproval')) ?? false;
  }

  // --- helpers ----------------------------------------------------------------------

  private async getDossierOrThrow(id: string): Promise<ExamDossierRow> {
    const row = await this.repo.getDossier(id);
    if (!row) throw new NotFoundException({ message: `Exam dossier ${id} not found`, code: 'exam.dossier_not_found' });
    return row;
  }

  /** Người đóng góp hoặc site admin — các thao tác phía người nộp (nộp/xoá nháp) chỉ hai đối tượng này làm được. */
  private async assertProposer(actorId: string, dossier: ExamDossierRow): Promise<void> {
    if (dossier.proposerId === actorId) return;
    if (await this.evaluator.isSiteAdmin(actorId)) return;
    throw new ForbiddenException({ message: 'Only the dossier proposer can perform this action', code: 'exam.dossier_not_proposer' });
  }

  /** Quyền xem một bộ hồ sơ: người đóng góp, site admin, hoặc người duyệt (exam:moderate) của bank đích. */
  private async canViewDossier(actorId: string, dossier: ExamDossierRow): Promise<boolean> {
    if (dossier.proposerId === actorId) return true;
    if (await this.evaluator.isSiteAdmin(actorId)) return true;
    const bank = await this.banks.findBankById(dossier.targetBankId);
    if (!bank) return false;
    return this.evaluator.hasCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId);
  }

  private async dossierView(row: ExamDossierRow): Promise<ExamDossierView> {
    const paper = await this.repo.getPaper(row.paperId);
    let paperName: string | null = null;
    if (paper) {
      const version = row.paperVersionId
        ? await this.repo.getVersion(row.paperVersionId)
        : await this.papers.currentVersion(paper).catch(() => undefined);
      paperName = version?.name ?? null;
    }
    const matrixInfo = row.matrixId ? await this.repo.getMatrixInfo(row.matrixId) : undefined;
    const reviews = await this.repo.listDossierReviews(row.id);
    const names = await this.banks.displayNames([row.proposerId, ...reviews.map((r) => r.reviewerId)]);
    return {
      id: row.id,
      paperId: row.paperId,
      paperName,
      sourceBankId: paper?.bankId ?? null,
      targetBankId: row.targetBankId,
      proposerId: row.proposerId,
      proposerName: names.get(row.proposerId) ?? null,
      note: row.note,
      status: row.status as ExamDossierView['status'],
      paperVersionId: row.paperVersionId,
      paperVersionNumber: row.paperVersionNumber,
      matrixId: row.matrixId,
      matrixName: matrixInfo?.name ?? null,
      matrixVersion: row.matrixVersion,
      boardApprovalRequired: await this.boardApprovalRequired(row),
      resultPaperId: row.resultPaperId,
      reviews: reviews.map((r) => ({
        id: r.id,
        dossierId: r.dossierId,
        level: r.level,
        reviewerId: r.reviewerId,
        reviewerName: names.get(r.reviewerId) ?? null,
        decision: r.decision as 'approved' | 'rejected',
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // --- lập + nộp ----------------------------------------------------------------------

  /**
   * Lập bộ hồ sơ (trạng thái `draft`) cho một đề vào một bank đích
   * dùng chung: người lập phải sửa được đề (tác giả hoặc moderator
   * bank nguồn) và có `exam:share` tại bank nguồn; bank đích không
   * được là bank cá nhân và không trùng bank nguồn. Version CHƯA
   * ghim ở bước này — ghim tại lúc nộp.
   */
  async createDossier(actorId: string, paperId: string, input: CreateExamDossier): Promise<ExamDossierView> {
    const paper = await this.papers.getPaperOrThrow(paperId);
    const sourceBank = await this.papers.bankOfPaper(paper);
    await this.papers.assertCanEditPaper(actorId, paper, sourceBank);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.share, sourceBank.contextId);
    const target = await this.papers.getExamBank(actorId, input.targetBankId);
    if (target.scope === 'personal') {
      throw new BadRequestException({ message: 'A dossier targets a shared exam bank, not a personal bank', code: 'exam.dossier_target_personal' });
    }
    if (target.id === paper.bankId) {
      throw new BadRequestException({ message: 'The paper is already in the target bank', code: 'exam.dossier_same_bank' });
    }
    const row = await this.repo.insertDossier({
      paperId: paper.id, targetBankId: target.id, proposerId: actorId,
      note: input.note ?? '', status: 'draft',
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_dossier_created',
      payload: { dossierId: row.id, paperId: paper.id, targetBankId: target.id, proposerId: actorId },
    });
    return this.dossierView(row);
  }

  /**
   * Nộp bộ hồ sơ: GHIM phiên bản đề hiện tại + phiên bản ma trận của
   * nó và CHỤP bản đặc tả tại đúng thời điểm này vào hồ sơ — từ đây
   * hàng chờ duyệt luôn xem đúng nội dung đã nộp. Đề phải `ready` và
   * phải gắn ma trận (bộ hồ sơ là luồng của đề định kỳ đi đường ma
   * trận; đề dựng tay không ma trận dùng luồng đóng góp từng đề của
   * EB-1). Một đề chỉ có một bộ hồ sơ đang chờ vào cùng bank đích.
   */
  async submitDossier(actorId: string, dossierId: string): Promise<ExamDossierView> {
    const dossier = await this.getDossierOrThrow(dossierId);
    await this.assertProposer(actorId, dossier);
    if (dossier.status !== 'draft') {
      throw new ConflictException({ message: 'Only a draft dossier can be submitted', code: 'exam.dossier_not_draft' });
    }
    const paper = await this.papers.getPaperOrThrow(dossier.paperId);
    if (paper.status !== 'ready') {
      throw new BadRequestException({ message: 'Only a ready paper can be submitted in a dossier', code: 'exam.dossier_source_not_ready' });
    }
    const version = await this.papers.currentVersion(paper);
    if (!version.matrixId) {
      throw new BadRequestException({
        message: 'A dossier requires a paper built from a matrix (matrix + specification + paper are reviewed as one set)',
        code: 'exam.dossier_requires_matrix',
      });
    }
    const active = await this.repo.findActiveDossier(paper.id, dossier.targetBankId, dossier.id);
    if (active) {
      throw new ConflictException({ message: 'An active dossier of this paper to the target bank already exists', code: 'exam.dossier_duplicate_active' });
    }
    const matrixInfo = await this.repo.getMatrixInfo(version.matrixId);
    const matrixVersion = version.matrixVersion ?? matrixInfo?.version ?? null;
    const slots = await this.repo.listSlots(version.id);
    const spec = await this.quiz.buildSpecificationForPaper(actorId, version.matrixId, slots.map((s) => ({
      matrixCellId: s.matrixCellId, position: s.position, questionId: s.questionId,
    })));
    await this.repo.updateDossier(dossier.id, {
      status: 'pending',
      paperVersionId: version.id,
      paperVersionNumber: version.version,
      matrixId: version.matrixId,
      matrixVersion,
      specSnapshot: spec as unknown as Record<string, unknown>,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_dossier_submitted',
      payload: {
        dossierId: dossier.id, paperId: paper.id, paperVersionId: version.id,
        matrixId: version.matrixId, matrixVersion, targetBankId: dossier.targetBankId, proposerId: actorId,
      },
    });
    return this.dossierView((await this.repo.getDossier(dossier.id))!);
  }

  /** Xoá một bộ hồ sơ NHÁP (chưa nộp) — bộ đã nộp không xoá được, chỉ đi tiếp qua các cấp duyệt. */
  async deleteDossier(actorId: string, dossierId: string): Promise<{ id: string; deleted: true }> {
    const dossier = await this.getDossierOrThrow(dossierId);
    await this.assertProposer(actorId, dossier);
    if (dossier.status !== 'draft') {
      throw new ConflictException({ message: 'Only a draft dossier can be deleted', code: 'exam.dossier_not_draft' });
    }
    await this.repo.deleteDossier(dossier.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_dossier_discarded',
      payload: { dossierId: dossier.id, paperId: dossier.paperId, targetBankId: dossier.targetBankId, proposerId: actorId },
    });
    return { id: dossier.id, deleted: true };
  }

  // --- đọc --------------------------------------------------------------------------------

  /** Chi tiết một bộ hồ sơ kèm toàn bộ vết duyệt (người đóng góp / người duyệt bank đích / site admin). */
  async getDossier(actorId: string, dossierId: string): Promise<ExamDossierView> {
    const dossier = await this.getDossierOrThrow(dossierId);
    if (!(await this.canViewDossier(actorId, dossier))) {
      throw new NotFoundException({ message: `Exam dossier ${dossierId} not found`, code: 'exam.dossier_not_found' });
    }
    return this.dossierView(dossier);
  }

  /** Hàng chờ bộ hồ sơ của một bank đích: người duyệt thấy tất cả; người khác chỉ thấy bộ của mình (như hàng chờ đóng góp QB-4). */
  async listBankDossiers(actorId: string, bankId: string): Promise<ExamDossierView[]> {
    const bank = await this.papers.getExamBank(actorId, bankId);
    const canModerate = await this.evaluator.hasCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId);
    const all = await this.repo.listDossiersForBank(bank.id);
    const rows = canModerate ? all : all.filter((r) => r.proposerId === actorId);
    const views: ExamDossierView[] = [];
    for (const row of rows) views.push(await this.dossierView(row));
    return views;
  }

  /** Mọi bộ hồ sơ của chính người dùng (theo dõi kết quả duyệt + lý do từ chối xuyên bank). */
  async listMyDossiers(actorId: string): Promise<ExamDossierView[]> {
    const rows = await this.repo.listDossiersByProposer(actorId);
    const views: ExamDossierView[] = [];
    for (const row of rows) views.push(await this.dossierView(row));
    return views;
  }

  /**
   * Bản đặc tả ĐÃ CHỤP trong bộ hồ sơ — bề mặt duyệt trong hàng chờ:
   * tổ trưởng mở đặc tả ngay tại hàng chờ, đọc đúng nội dung đã nộp
   * (không phải nội dung sống của ma trận/đề tại thời điểm mở). Lần
   * mở của người duyệt được ghi audit `exam_dossier_spec_viewed`.
   */
  async getDossierSpecification(actorId: string, dossierId: string): Promise<Record<string, unknown>> {
    const dossier = await this.getDossierOrThrow(dossierId);
    if (!(await this.canViewDossier(actorId, dossier))) {
      throw new NotFoundException({ message: `Exam dossier ${dossierId} not found`, code: 'exam.dossier_not_found' });
    }
    if (!dossier.specSnapshot) {
      throw new BadRequestException({ message: 'The dossier has not been submitted yet; it carries no specification', code: 'exam.dossier_not_submitted' });
    }
    const bank = await this.banks.findBankById(dossier.targetBankId);
    const isModerator = bank
      ? await this.evaluator.hasCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId)
      : false;
    if (isModerator && dossier.proposerId !== actorId) {
      await this.outbox.enqueueStandalone({
        aggregate: 'exam_paper', type: 'exam_dossier_spec_viewed',
        payload: { dossierId: dossier.id, paperId: dossier.paperId, targetBankId: dossier.targetBankId, actorId },
      });
    }
    return dossier.specSnapshot;
  }

  /** Xuất bản đặc tả đã chụp trong bộ hồ sơ ra xlsx/docx (cùng renderer với mọi bề mặt đặc tả). */
  async exportDossierSpecification(actorId: string, dossierId: string, format: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    const snapshot = await this.getDossierSpecification(actorId, dossierId);
    return this.quiz.renderSpecification(snapshot as unknown as MatrixSpecification, format);
  }

  // --- duyệt --------------------------------------------------------------------------------

  /** Cổng cấp 1: `exam:moderate` tại context của bank đích. */
  private async requireLevel1Moderator(actorId: string, dossier: ExamDossierRow): Promise<QuestionBankRow> {
    const bank = await this.papers.getExamBank(actorId, dossier.targetBankId);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId);
    return bank;
  }

  /**
   * Cổng cấp 2 (ban giám hiệu): `exam:moderate` tại context HỆ
   * THỐNG — vai lãnh đạo cấp trường (site admin đạt qua evaluator
   * như mọi cổng khác). Đây là neo "cấp trường" hiện tại của cấp
   * duyệt 2; cùng điểm chờ tenant với seam cấu hình (issue #166).
   */
  private async requireBoardApprover(actorId: string): Promise<void> {
    const system = await this.contexts.ensureSystemContext();
    const ok = await this.evaluator.hasCapability(actorId, EXAM_CAPABILITIES.moderate, system.id);
    if (!ok) {
      throw new ForbiddenException({
        message: 'Board approval requires exam:moderate at the system context',
        code: 'exam.dossier_board_forbidden',
      });
    }
  }

  /**
   * Chốt duyệt đạt ở cấp cuối: copy PHIÊN BẢN ĐỀ ĐÃ GHIM vào bank
   * đích ở trạng thái `ready` (đề hiện ngay ở bank đích với
   * derived_from + tác giả gốc — truy vết đủ hai đầu cùng dòng vết
   * duyệt và sự kiện audit). Trùng suy từ chính đề nguồn trong bank
   * đích → 409 như duyệt đóng góp QB-4.
   */
  private async finalizeApproval(actorId: string, dossier: ExamDossierRow, level: number): Promise<ExamDossierRow> {
    const source = await this.papers.getPaperOrThrow(dossier.paperId);
    const target = await this.papers.getExamBank(actorId, dossier.targetBankId);
    const inTarget = await this.repo.listPapersInBank(target.id);
    if (inTarget.some((p) => p.derivedFromPaperId === source.id)) {
      throw new ConflictException({
        message: `An identical paper already exists in the target bank (copied from ${source.id})`,
        code: 'exam.duplicate_in_bank',
      });
    }
    const pinned = dossier.paperVersionId ? await this.repo.getVersion(dossier.paperVersionId) : undefined;
    if (!pinned) {
      throw new ConflictException({ message: 'The pinned paper version of this dossier no longer exists', code: 'exam.dossier_version_gone' });
    }
    const copied = await this.papers.copyPaperVersionIntoBank(actorId, source, pinned, target, { status: 'ready' });
    await this.repo.insertDossierReview({
      dossierId: dossier.id, level, reviewerId: actorId, decision: 'approved', reason: null,
    });
    await this.repo.updateDossier(dossier.id, { status: 'approved', resultPaperId: copied.id });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_dossier_approved',
      payload: {
        dossierId: dossier.id, paperId: source.id, paperVersionId: pinned.id,
        targetBankId: target.id, resultPaperId: copied.id,
        reviewerId: actorId, proposerId: dossier.proposerId, level,
      },
    });
    return (await this.repo.getDossier(dossier.id))!;
  }

  /** Chốt từ chối ở một cấp: lý do bắt buộc (DTO đã chặn rỗng), bộ về `rejected`, người đóng góp thấy được lý do. */
  private async finalizeRejection(actorId: string, dossier: ExamDossierRow, level: number, reason: string): Promise<ExamDossierRow> {
    await this.repo.insertDossierReview({
      dossierId: dossier.id, level, reviewerId: actorId, decision: 'rejected', reason,
    });
    await this.repo.updateDossier(dossier.id, { status: 'rejected' });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_dossier_rejected',
      payload: {
        dossierId: dossier.id, paperId: dossier.paperId, targetBankId: dossier.targetBankId,
        reviewerId: actorId, proposerId: dossier.proposerId, level, reason,
      },
    });
    return (await this.repo.getDossier(dossier.id))!;
  }

  /**
   * Duyệt cấp 1 (tổ trưởng/moderate bank đích). Khi cấu hình bật
   * cấp 2: chỉ ghi mốc cấp 1 và đưa bộ sang `pending_board` — đề
   * CHƯA vào bank đích. Khi tắt: duyệt cấp 1 là chốt luôn.
   */
  async approveDossier(actorId: string, dossierId: string): Promise<ExamDossierView> {
    const dossier = await this.getDossierOrThrow(dossierId);
    await this.requireLevel1Moderator(actorId, dossier);
    if (dossier.status !== 'pending') {
      throw new ConflictException({ message: 'Dossier is not waiting for level-1 review', code: 'exam.dossier_not_pending' });
    }
    if (await this.boardApprovalRequired(dossier)) {
      await this.repo.insertDossierReview({
        dossierId: dossier.id, level: 1, reviewerId: actorId, decision: 'approved', reason: null,
      });
      await this.repo.updateDossier(dossier.id, { status: 'pending_board' });
      await this.outbox.enqueueStandalone({
        aggregate: 'exam_paper', type: 'exam_dossier_level1_approved',
        payload: {
          dossierId: dossier.id, paperId: dossier.paperId, targetBankId: dossier.targetBankId,
          reviewerId: actorId, proposerId: dossier.proposerId,
        },
      });
      return this.dossierView((await this.repo.getDossier(dossier.id))!);
    }
    return this.dossierView(await this.finalizeApproval(actorId, dossier, 1));
  }

  /** Từ chối cấp 1: lý do bắt buộc, bộ đóng lại ở `rejected`. */
  async rejectDossier(actorId: string, dossierId: string, input: RejectExamDossier): Promise<ExamDossierView> {
    const dossier = await this.getDossierOrThrow(dossierId);
    await this.requireLevel1Moderator(actorId, dossier);
    if (dossier.status !== 'pending') {
      throw new ConflictException({ message: 'Dossier is not waiting for level-1 review', code: 'exam.dossier_not_pending' });
    }
    return this.dossierView(await this.finalizeRejection(actorId, dossier, 1, input.reason));
  }

  /** Duyệt cấp 2 (ban giám hiệu) — mốc cuối: đề vào bank đích. */
  async boardApproveDossier(actorId: string, dossierId: string): Promise<ExamDossierView> {
    const dossier = await this.getDossierOrThrow(dossierId);
    await this.requireBoardApprover(actorId);
    if (dossier.status !== 'pending_board') {
      throw new ConflictException({ message: 'Dossier is not waiting for board review', code: 'exam.dossier_not_pending_board' });
    }
    return this.dossierView(await this.finalizeApproval(actorId, dossier, 2));
  }

  /** Từ chối cấp 2: lý do bắt buộc, bộ đóng lại ở `rejected` (vết cấp 1 vẫn giữ nguyên). */
  async boardRejectDossier(actorId: string, dossierId: string, input: RejectExamDossier): Promise<ExamDossierView> {
    const dossier = await this.getDossierOrThrow(dossierId);
    await this.requireBoardApprover(actorId);
    if (dossier.status !== 'pending_board') {
      throw new ConflictException({ message: 'Dossier is not waiting for board review', code: 'exam.dossier_not_pending_board' });
    }
    return this.dossierView(await this.finalizeRejection(actorId, dossier, 2, input.reason));
  }
}
