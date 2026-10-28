import {
  BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException,
} from '@nestjs/common';
import type {
  CreateExamDossier, ExamDossierView, RejectExamDossier,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import { QuizService, type MatrixSpecification } from '../quiz/quiz.service';
import {
  ExamsRepository,
  type ExamDossierRow,
} from './exams.repository';
import { ExamsService, EXAM_CAPABILITIES, examPaperContentHash } from './exams.service';

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
 *
 * VAI TRÒ HIỆN TẠI (issue #228, lát S4) — LỊCH SỬ CHỈ-ĐỌC: đường
 * hồ sơ đã bị HẤP THỤ vào đường đóng góp duy nhất của đề
 * (`exam_contributions`): bộ hồ sơ thành phần đính kèm tuỳ chọn của
 * một đóng góp, cấp duyệt 2 thành trạng thái `pending_board` của
 * đóng góp. Service này không còn nhận thao tác ghi nào (mọi method
 * ghi trả 410 `exam.dossier_path_closed`); nó phục vụ xem lại lịch
 * sử hồ sơ + đợt chuyển đổi hồ sơ treo một lần
 * ({@link ExamDossiersService.convertLegacyDossiers}). Mô tả luồng
 * duyệt hai cấp dưới đây là LỊCH SỬ của cơ chế EB-3 — giữ lại để
 * người đọc hiểu dữ kiện lịch sử (các mốc duyệt, trạng thái
 * `pending_board`) đang xem.
 * trong danh sách bộ hồ sơ của mình, sửa đề và lập bộ mới.
 */
@Injectable()
export class ExamDossiersService {
  constructor(
    private readonly repo: ExamsRepository,
    private readonly papers: ExamsService,
    private readonly banks: QuestionBanksService,
    private readonly evaluator: PermissionEvaluator,
    private readonly quiz: QuizService,
    private readonly outbox: OutboxService,
  ) {}

  // --- điểm seam cấu hình cấp duyệt 2 ---------------------------------------------

  /**
   * Công tắc cấp duyệt 2 cho một bộ hồ sơ — UỶ THÁC sang điểm seam
   * dùng chung {@link ExamsService.boardApprovalRequiredForBank}
   * (nơi DUY NHẤT đọc khoá `exam/requireboardapproval`): tenant của
   * bank đích của hồ sơ quyết định. Hàm này chỉ còn là vỏ tương
   * thích cho bề mặt đọc (view cần cờ hiệu lực hiện tại); không nơi
   * nào trong service này tự đọc khoá cấu hình nữa.
   */
  async boardApprovalRequired(dossier?: ExamDossierRow): Promise<boolean> {
    if (!dossier) return false;
    const bank = await this.banks.findBankById(dossier.targetBankId);
    if (!bank) return false;
    return this.papers.boardApprovalRequiredForBank(bank);
  }


  // --- helpers ----------------------------------------------------------------------

  private async getDossierOrThrow(id: string): Promise<ExamDossierRow> {
    const row = await this.repo.getDossier(id);
    if (!row) throw new NotFoundException({ message: `Exam dossier ${id} not found`, code: 'exam.dossier_not_found' });
    return row;
  }

  /** Lỗi đóng đường dùng chung cho mọi thao tác ghi của bề mặt hồ sơ: 410 kèm chỉ đường sang đường đóng góp duy nhất. */
  private static pathClosed(): GoneException {
    return new GoneException({
      message: 'The dossier path is closed: contribute the paper through the single contribution path (with an attached dossier when the paper is an official exam)',
      code: 'exam.dossier_path_closed',
    });
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
    const paper = await this.repo.getPaper(row.examId);
    let examName: string | null = null;
    if (paper) {
      const version = row.examVersionId
        ? await this.repo.getVersion(row.examVersionId)
        : await this.papers.currentVersion(paper).catch(() => undefined);
      examName = version?.name ?? null;
    }
    const matrixInfo = row.matrixId ? await this.repo.getMatrixInfo(row.matrixId) : undefined;
    const reviews = await this.repo.listDossierReviews(row.id);
    const names = await this.banks.displayNames([row.proposerId, ...reviews.map((r) => r.reviewerId)]);
    return {
      id: row.id,
      examId: row.examId,
      examName,
      sourceBankId: paper?.bankId ?? null,
      targetBankId: row.targetBankId,
      proposerId: row.proposerId,
      proposerName: names.get(row.proposerId) ?? null,
      note: row.note,
      status: row.status as ExamDossierView['status'],
      examVersionId: row.examVersionId,
      examVersionNumber: row.examVersionNumber,
      matrixId: row.matrixId,
      matrixName: matrixInfo?.name ?? null,
      matrixVersion: row.matrixVersion,
      matrixVersionId: row.matrixVersionId,
      boardApprovalRequired: await this.boardApprovalRequired(row),
      resultExamId: row.resultExamId,
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
   * Lập bộ hồ sơ nháp — ĐÃ ĐÓNG: đường hồ sơ bị hấp thụ vào ĐƯỜNG
   * ĐÓNG GÓP DUY NHẤT của đề (đóng góp kèm bộ hồ sơ đính kèm qua
   * `withDossier`). Mọi thao tác GHI của bề mặt này trả 410
   * `exam.dossier_path_closed`; bề mặt ĐỌC (chi tiết, danh sách,
   * đặc tả) giữ nguyên để xem lại lịch sử.
   */
  async createDossier(_actorId: string, _examId: string, _input: CreateExamDossier): Promise<ExamDossierView> {
    throw ExamDossiersService.pathClosed();
  }

  /** Nộp bộ hồ sơ — ĐÃ ĐÓNG, xem {@link ExamDossiersService.createDossier}. */
  async submitDossier(_actorId: string, _dossierId: string): Promise<ExamDossierView> {
    throw ExamDossiersService.pathClosed();
  }

  /** Xoá bộ hồ sơ nháp — ĐÃ ĐÓNG, xem {@link ExamDossiersService.createDossier}. */
  async deleteDossier(_actorId: string, _dossierId: string): Promise<{ id: string; deleted: true }> {
    throw ExamDossiersService.pathClosed();
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
        payload: { dossierId: dossier.id, examId: dossier.examId, targetBankId: dossier.targetBankId, actorId },
      });
    }
    return dossier.specSnapshot;
  }

  /** Xuất bản đặc tả đã chụp trong bộ hồ sơ ra xlsx/docx (cùng renderer với mọi bề mặt đặc tả). */
  async exportDossierSpecification(actorId: string, dossierId: string, format: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    const snapshot = await this.getDossierSpecification(actorId, dossierId);
    return this.quiz.renderSpecification(snapshot as unknown as MatrixSpecification, format);
  }

  // --- duyệt (ĐÃ ĐÓNG — đường hồ sơ chỉ còn đọc lịch sử) --------------------------------

  /**
   * Duyệt cấp 1 — ĐÃ ĐÓNG cùng toàn bộ đường ghi của hồ sơ: duyệt
   * đề vào bank chung nay đi qua ĐƯỜNG ĐÓNG GÓP DUY NHẤT
   * (`exam_contributions`, kèm bộ hồ sơ đính kèm khi là đề chính
   * thức). Hồ sơ đang chờ tại thời điểm cắt đường đã được chuyển
   * thành đóng góp bởi đợt chuyển đổi một lần
   * ({@link ExamDossiersService.convertLegacyDossiers}).
   */
  async approveDossier(_actorId: string, _dossierId: string): Promise<ExamDossierView> {
    throw ExamDossiersService.pathClosed();
  }

  /** Từ chối cấp 1 — ĐÃ ĐÓNG, xem {@link ExamDossiersService.approveDossier}. */
  async rejectDossier(_actorId: string, _dossierId: string, _input: RejectExamDossier): Promise<ExamDossierView> {
    throw ExamDossiersService.pathClosed();
  }

  /** Duyệt cấp 2 — ĐÃ ĐÓNG, xem {@link ExamDossiersService.approveDossier}. */
  async boardApproveDossier(_actorId: string, _dossierId: string): Promise<ExamDossierView> {
    throw ExamDossiersService.pathClosed();
  }

  /** Từ chối cấp 2 — ĐÃ ĐÓNG, xem {@link ExamDossiersService.approveDossier}. */
  async boardRejectDossier(_actorId: string, _dossierId: string, _input: RejectExamDossier): Promise<ExamDossierView> {
    throw ExamDossiersService.pathClosed();
  }

  // --- chuyển đổi hồ sơ treo (chạy một lần khi cắt đường) -------------------------------

  /**
   * Chuyển đổi toàn bộ hồ sơ còn treo sang ĐƯỜNG ĐÓNG GÓP DUY NHẤT
   * — thao tác vận hành đã chạy MỘT LẦN ở ngữ cảnh platform khi cắt
   * đường hồ sơ, quy tắc theo quyết định hấp thụ đường hồ sơ:
   *
   * - Hồ sơ `pending`/`pending_board`: sinh MỘT đóng góp mode 'new'
   *   mang NGUYÊN trạng thái đang chờ + bộ hồ sơ đã ghim (version
   *   đề, version ma trận, bản đặc tả) + người lập/ghi chú/thời
   *   điểm lập của hồ sơ; toàn bộ mốc duyệt đã có của hồ sơ được
   *   sao sang sổ mốc duyệt của đóng góp để lịch sử duyệt liền
   *   mạch; hash chống trùng tính lại trên version đề đã ghim và
   *   near_duplicate_of quét trong bank đích như một đề xuất mới.
   *   Đóng góp trỏ về hồ sơ gốc qua `source_dossier_id` — neo này
   *   cũng là khoá idempotent: hồ sơ đã có đóng góp mang nó thì bỏ
   *   qua, chạy lại không nhân đôi đóng góp lẫn mốc duyệt.
   * - Hồ sơ `draft`: ĐÓNG BĂNG tại chỗ (giữ nguyên trạng thái làm
   *   dấu vết việc đang soạn dở) + một sự kiện thông báo cho người
   *   lập để họ lập lại dưới dạng đóng góp nếu còn nhu cầu. Phần
   *   thông báo mang ngữ nghĩa "chạy một lần": mỗi lần chạy lại,
   *   hồ sơ draft còn tồn tại lại được tính vào báo cáo — vận hành
   *   chỉ chạy đợt chuyển đổi đúng một lần.
   * - Hồ sơ `approved`/`rejected`: giữ nguyên làm lịch sử kết quả,
   *   không sinh đóng góp (việc của chúng đã xong trước khi cắt
   *   đường).
   *
   * Trả báo cáo đếm trước/sau theo trạng thái + số đã chuyển + số
   * draft đóng băng để vận hành đối chiếu.
   */
  async convertLegacyDossiers(): Promise<{
    before: Record<string, number>;
    converted: number;
    alreadyConverted: number;
    draftsFrozen: number;
  }> {
    const dossiers = await this.repo.listAllDossiers();
    const before: Record<string, number> = {};
    for (const d of dossiers) before[d.status] = (before[d.status] ?? 0) + 1;
    let converted = 0;
    let alreadyConverted = 0;
    let draftsFrozen = 0;
    for (const dossier of dossiers) {
      if (dossier.status === 'pending' || dossier.status === 'pending_board') {
        const existing = await this.repo.findContributionBySourceDossier(dossier.id);
        if (existing) { alreadyConverted += 1; continue; }
        let contentHash = '';
        let nearDuplicateOf: string | null = null;
        const pinned = dossier.examVersionId ? await this.repo.getVersion(dossier.examVersionId) : undefined;
        if (pinned) {
          const slots = await this.repo.listSlots(pinned.id);
          contentHash = examPaperContentHash(pinned, slots);
          for (const other of await this.repo.listPapersInBank(dossier.targetBankId)) {
            const otherVersion = await this.papers.currentVersion(other);
            const otherSlots = await this.repo.listSlots(otherVersion.id);
            if (examPaperContentHash(otherVersion, otherSlots) === contentHash) { nearDuplicateOf = other.id; break; }
          }
        }
        const contribution = await this.repo.insertContribution({
          examId: dossier.examId, targetBankId: dossier.targetBankId, proposerId: dossier.proposerId,
          note: dossier.note, mode: 'new', status: dossier.status,
          contentHash, nearDuplicateOf,
          dossierExamVersionId: dossier.examVersionId,
          dossierExamVersionNumber: dossier.examVersionNumber,
          dossierMatrixId: dossier.matrixId,
          dossierMatrixVersion: dossier.matrixVersion,
          dossierMatrixVersionId: dossier.matrixVersionId,
          dossierSpecSnapshot: dossier.specSnapshot,
          sourceDossierId: dossier.id,
          createdAt: dossier.createdAt, updatedAt: dossier.updatedAt,
        });
        for (const review of await this.repo.listDossierReviews(dossier.id)) {
          await this.repo.insertContributionReview({
            contributionId: contribution.id, level: review.level,
            reviewerId: review.reviewerId, decision: review.decision,
            reason: review.reason, createdAt: review.createdAt,
          });
        }
        await this.outbox.enqueueStandalone({
          aggregate: 'exam_paper', type: 'exam_dossier_converted',
          payload: {
            dossierId: dossier.id, contributionId: contribution.id,
            examId: dossier.examId, targetBankId: dossier.targetBankId,
            proposerId: dossier.proposerId, status: dossier.status,
          },
        });
        converted += 1;
      } else if (dossier.status === 'draft') {
        await this.outbox.enqueueStandalone({
          aggregate: 'exam_paper', type: 'exam_dossier_frozen',
          payload: {
            dossierId: dossier.id, examId: dossier.examId,
            targetBankId: dossier.targetBankId, proposerId: dossier.proposerId,
          },
        });
        draftsFrozen += 1;
      }
    }
    return { before, converted, alreadyConverted, draftsFrozen };
  }
}
