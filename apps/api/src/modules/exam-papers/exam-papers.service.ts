import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  ApproveExamPaperContribution, CopyExamPaper, CreateExamPaper, CreateExamPaperContribution,
  DeployExamPaper, ExamPaperSlotInput, QuizView, RejectExamPaperContribution,
  SetExamPaperSlots, SetExamPaperStatus, UpdateExamPaper,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { CAP_ALLOW } from '../access/domain/permission';
import { QuestionBanksService, QBANK_LEAD_ROLE, QBANK_MEMBER_ROLE } from '../questions/question-banks.service';
import type { QuestionBankRow } from '../questions/question-banks.repository';
import { QuizService } from '../quiz/quiz.service';
import {
  ExamPapersRepository,
  type ExamPaperContributionRow, type ExamPaperRow, type ExamPaperSlotRow, type ExamPaperVersionRow,
} from './exam-papers.repository';

/** Bộ capability của lớp ngân hàng đề — mọi cổng đều đánh giá TẠI context của bank đề (một nguồn quyền duy nhất là bank). */
export const EXAM_CAPABILITIES = {
  view: 'exam:view',
  edit: 'exam:edit',
  copy: 'exam:copy',
  share: 'exam:share',
  moderate: 'exam:moderate',
  deploy: 'exam:deploy',
} as const;

/** exam:* cấp cho hai vai bank dùng chung tại context của MỖI bank đề: thành viên = xem + copy; chủ/tổ trưởng = toàn bộ. */
const MEMBER_EXAM_CAPS = [EXAM_CAPABILITIES.view, EXAM_CAPABILITIES.copy];
const LEAD_EXAM_CAPS = [
  EXAM_CAPABILITIES.view, EXAM_CAPABILITIES.edit, EXAM_CAPABILITIES.copy,
  EXAM_CAPABILITIES.share, EXAM_CAPABILITIES.moderate, EXAM_CAPABILITIES.deploy,
];

export interface ExamPaperCapabilitiesView {
  view: boolean; edit: boolean; copy: boolean; share: boolean; moderate: boolean; deploy: boolean;
}

export interface ExamPaperSlotView {
  position: number;
  section: string;
  questionId: string;
  questionName: string | null;
  qtype: string | null;
  /** Trạng thái entry hiện tại của câu trong ngân hàng câu hỏi (đề đã chụp vẫn đọc được kể cả khi câu bị rút). */
  entryStatus: string | null;
  pinnedVersionId: string | null;
  pinnedVersionNumber: number | null;
  maxMark: number;
  clusterId: string | null;
}

export interface ExamPaperView {
  paper: {
    id: string; bankId: string; kind: string; status: string;
    derivedFromPaperId: string | null; derivedFromMatrixId: string | null;
    originalAuthorId: string | null; createdBy: string;
    latestVersion: number; copyCount: number;
    createdAt: string; updatedAt: string;
  };
  version: {
    id: string; version: number; name: string;
    subjectId: string | null; grade: number | null; examKind: string | null;
    totalScore: number; durationMinutes: number | null;
    tfScale: number[] | null; matrixId: string | null; matrixVersion: number | null;
    createdBy: string; createdAt: string;
  };
  slots: ExamPaperSlotView[];
  /** Truy vết nguồn gốc cho UI hiển thị ghi công (null với đề gốc tự soạn). */
  attribution: { derivedFromPaperId: string; originalAuthorId: string | null; sourceBankId: string } | null;
  capabilities: ExamPaperCapabilitiesView;
}

export interface ExamPaperSummary {
  id: string; bankId: string; kind: string; status: string;
  name: string; examKind: string | null; grade: number | null; subjectId: string | null;
  slotCount: number; totalScore: number; durationMinutes: number | null;
  latestVersion: number; createdBy: string;
  originalAuthorId: string | null; derivedFromPaperId: string | null;
  copyCount: number; updatedAt: string;
  capabilities: ExamPaperCapabilitiesView;
}

export interface ExamPaperContributionView extends ExamPaperContributionRow {
  paperName: string | null;
  sourceBankId: string | null;
}

/**
 * Lớp Ngân hàng đề (feat issue #113, EB-1) — thực thể ĐỀ trên khuôn
 * bank đa loại của feat Ngân hàng câu hỏi chung:
 *
 * - Danh tính đề sống trong bank `bank_kind='exam'`; quyền neo MỘT
 *   nguồn duy nhất là bank: capability `exam:*` đánh giá tại context
 *   của bank (vai qbankmember/qbanklead dùng chung được cấp thêm
 *   exam:* tại context của từng bank đề — xem ensureExamGrants).
 * - Nội dung là SNAPSHOT bất biến theo version: sửa metadata hay
 *   slots đều tạo paper version mới; slot ghim cứng version ready mới
 *   nhất của câu tại thời điểm lưu (kỷ luật QB-3), câu chưa ready /
 *   đã rút (hidden) không vào được đề.
 * - Copy = deep copy: danh tính đề mới + slots sao nguyên (question +
 *   pinned version KHÔNG đổi — copy đề không copy câu), ghi
 *   derived_from + tác giả gốc giữ qua các đời copy.
 * - Đóng góp/duyệt theo đúng khuôn QB-4 (duyệt đạt = chủ bank đích
 *   copy vào bank đích; chống trùng hoàn toàn bằng content hash).
 * - Triển khai vào quiz: chụp slots sang quiz_slots + ghim paper
 *   version trên quiz (QuizService.deployPaperSlots lo cổng
 *   quiz:manage + đóng băng khi đã có lượt thật); đề bị hidden/xoá
 *   sau đó không vỡ quiz đã triển khai.
 */
@Injectable()
export class ExamPapersService {
  constructor(
    private readonly repo: ExamPapersRepository,
    private readonly banks: QuestionBanksService,
    private readonly evaluator: PermissionEvaluator,
    private readonly roles: RolesService,
    private readonly quiz: QuizService,
    private readonly outbox: OutboxService,
  ) {}

  // --- cổng bank + quyền ----------------------------------------------------

  /**
   * Cấp bộ exam:* cho hai vai bank dùng chung tại context của bank đề
   * này (idempotent — gọi mỗi khi chạm vào một bank đề). Vai bank do
   * QuestionBanksService dựng lười khi bank đầu tiên được tạo; bank đề
   * luôn đi qua buildBank nên hai vai chắc chắn tồn tại ở đây.
   */
  private async ensureExamGrants(bank: QuestionBankRow): Promise<void> {
    if (bank.bankKind !== 'exam') return;
    const [member, lead] = await Promise.all([
      this.roles.getRoleByShortname(QBANK_MEMBER_ROLE),
      this.roles.getRoleByShortname(QBANK_LEAD_ROLE),
    ]);
    if (member) {
      for (const cap of MEMBER_EXAM_CAPS) {
        await this.roles.setCapabilityOverride(member.id, cap, bank.contextId, CAP_ALLOW);
      }
    }
    if (lead) {
      for (const cap of LEAD_EXAM_CAPS) {
        await this.roles.setCapabilityOverride(lead.id, cap, bank.contextId, CAP_ALLOW);
      }
    }
  }

  /** Lấy bank đề (đồng bộ tư cách thành viên qua QuestionBanksService.getBank) + bảo đảm exam grants; 404 khi bank không tồn tại hoặc không phải bank đề. */
  private async getExamBank(actorId: string, bankId: string): Promise<QuestionBankRow> {
    const view = await this.banks.getBank(actorId, bankId);
    if (view.bankKind !== 'exam') {
      throw new NotFoundException({ message: `Bank ${bankId} is not an exam bank`, code: 'exam.not_exam_bank' });
    }
    const bank: QuestionBankRow = view;
    await this.ensureExamGrants(bank);
    return bank;
  }

  private async bankOfPaper(paper: ExamPaperRow): Promise<QuestionBankRow> {
    const bank = await this.banks.getBankOrThrow(paper.bankId);
    await this.ensureExamGrants(bank);
    return bank;
  }

  private async capabilitiesAt(actorId: string, bank: QuestionBankRow): Promise<ExamPaperCapabilitiesView> {
    const at = (cap: string) => this.evaluator.hasCapability(actorId, cap, bank.contextId);
    const [view, edit, copy, share, moderate, deploy] = await Promise.all([
      at(EXAM_CAPABILITIES.view), at(EXAM_CAPABILITIES.edit), at(EXAM_CAPABILITIES.copy),
      at(EXAM_CAPABILITIES.share), at(EXAM_CAPABILITIES.moderate), at(EXAM_CAPABILITIES.deploy),
    ]);
    return { view, edit, copy, share, moderate, deploy };
  }

  /** Đề ở trạng thái ready thì người có exam:view thấy; draft/hidden chỉ tác giả hoặc người duyệt của bank thấy. */
  private async assertCanViewPaper(actorId: string, paper: ExamPaperRow, bank: QuestionBankRow): Promise<void> {
    if ((await this.evaluator.isSiteAdmin(actorId))) return;
    if (paper.status === 'ready') {
      await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.view, bank.contextId);
      return;
    }
    if (paper.createdBy === actorId) return;
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId);
  }

  /** Cổng sửa/xoá đề: có exam:edit tại bank VÀ (là tác giả HOẶC có exam:moderate) — GV khác chỉ xem/copy, không sửa đề cá nhân của người khác. */
  private async assertCanEditPaper(actorId: string, paper: ExamPaperRow, bank: QuestionBankRow): Promise<void> {
    if (await this.evaluator.isSiteAdmin(actorId)) return;
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.edit, bank.contextId);
    if (paper.createdBy === actorId) return;
    const moderate = await this.evaluator.hasCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId);
    if (!moderate) {
      throw new ForbiddenException({
        message: 'Only the paper author or a bank moderator can modify this paper',
        code: 'exam.edit_not_owner',
      });
    }
  }

  private async getPaperOrThrow(id: string): Promise<ExamPaperRow> {
    const paper = await this.repo.getPaper(id);
    if (!paper) throw new NotFoundException({ message: `Exam paper ${id} not found`, code: 'exam.not_found' });
    return paper;
  }

  private async currentVersion(paper: ExamPaperRow): Promise<ExamPaperVersionRow> {
    const version = await this.repo.getVersionByNumber(paper.id, paper.latestVersion);
    if (!version) throw new NotFoundException({ message: `Paper ${paper.id} has no version ${paper.latestVersion}`, code: 'exam.version_not_found' });
    return version;
  }

  // --- soạn slots --------------------------------------------------------------

  /**
   * Phân giải danh sách slot payload thành slot đã ghim: mỗi câu phải
   * tồn tại và có bản ready (ghim bản ready mới nhất — cùng điểm phân
   * giải của quiz.addSlot QB-3); câu draft/hidden bị chặn tại cổng này.
   */
  private async resolveSlots(slots: ExamPaperSlotInput[]): Promise<{
    questionId: string; pinnedVersionId: string; pinnedVersionNumber: number;
    maxMark: number; section: string; clusterId: string | null;
  }[]> {
    const resolved = [];
    for (const s of slots) {
      if (!(await this.repo.questionExists(s.questionId))) {
        throw new NotFoundException({ message: `Question ${s.questionId} not found`, code: 'exam.slot_question_not_found' });
      }
      const ready = await this.repo.resolveReadyVersion(s.questionId);
      if (!ready) {
        throw new BadRequestException({
          message: `Question ${s.questionId} has no ready version; only ready questions can enter a paper`,
          code: 'exam.slot_question_not_ready',
        });
      }
      resolved.push({
        questionId: s.questionId,
        pinnedVersionId: ready.versionId,
        pinnedVersionNumber: ready.versionNumber,
        maxMark: s.maxMark ?? 1,
        section: s.section ?? '',
        clusterId: s.clusterId ?? null,
      });
    }
    return resolved;
  }

  /** Hash cấu trúc của một paper version (chống trùng đóng góp/copy): tên + danh sách question@pinnedVersion:điểm đã sắp theo vị trí. */
  private paperContentHash(version: ExamPaperVersionRow, slots: ExamPaperSlotRow[]): string {
    const body = slots
      .map((s) => `${s.questionId}@${s.pinnedVersionNumber ?? 0}:${s.maxMark}`)
      .join('|');
    return createHash('sha256').update(`${version.name}::${body}`).digest('hex');
  }

  // --- view -------------------------------------------------------------------

  private async slotViews(slots: ExamPaperSlotRow[]): Promise<ExamPaperSlotView[]> {
    const questionIds = [...new Set(slots.map((s) => s.questionId))];
    const [infos, statuses] = await Promise.all([
      this.repo.listSlotQuestionInfo(questionIds),
      this.repo.listQuestionEntryStatuses(questionIds),
    ]);
    const infoById = new Map(infos.map((i) => [i.questionId, i]));
    const statusById = new Map(statuses.map((s) => [s.questionId, s.status]));
    return slots.map((s) => ({
      position: s.position,
      section: s.section,
      questionId: s.questionId,
      questionName: infoById.get(s.questionId)?.name ?? null,
      qtype: infoById.get(s.questionId)?.qtype ?? null,
      entryStatus: statusById.get(s.questionId) ?? null,
      pinnedVersionId: s.pinnedVersionId,
      pinnedVersionNumber: s.pinnedVersionNumber,
      maxMark: s.maxMark,
      clusterId: s.clusterId,
    }));
  }

  async paperView(actorId: string, paper: ExamPaperRow): Promise<ExamPaperView> {
    const bank = await this.bankOfPaper(paper);
    const version = await this.currentVersion(paper);
    const slots = await this.repo.listSlots(version.id);
    const caps = await this.capabilitiesAt(actorId, bank);
    const canEdit = caps.edit && (paper.createdBy === actorId || caps.moderate);
    let attribution: ExamPaperView['attribution'] = null;
    if (paper.derivedFromPaperId) {
      const source = await this.repo.getPaper(paper.derivedFromPaperId);
      attribution = {
        derivedFromPaperId: paper.derivedFromPaperId,
        originalAuthorId: paper.originalAuthorId,
        sourceBankId: source?.bankId ?? paper.bankId,
      };
    }
    return {
      paper: {
        id: paper.id, bankId: paper.bankId, kind: paper.kind, status: paper.status,
        derivedFromPaperId: paper.derivedFromPaperId, derivedFromMatrixId: paper.derivedFromMatrixId,
        originalAuthorId: paper.originalAuthorId, createdBy: paper.createdBy,
        latestVersion: paper.latestVersion, copyCount: paper.copyCount,
        createdAt: paper.createdAt.toISOString(), updatedAt: paper.updatedAt.toISOString(),
      },
      version: {
        id: version.id, version: version.version, name: version.name,
        subjectId: version.subjectId, grade: version.grade, examKind: version.examKind,
        totalScore: version.totalScore, durationMinutes: version.durationMinutes,
        tfScale: version.tfScale, matrixId: version.matrixId, matrixVersion: version.matrixVersion,
        createdBy: version.createdBy, createdAt: version.createdAt.toISOString(),
      },
      slots: await this.slotViews(slots),
      attribution,
      capabilities: { ...caps, edit: canEdit },
    };
  }

  // --- CRUD đề ------------------------------------------------------------------

  /** Danh sách đề trong một bank đề (lọc theo quyền xem từng đề). */
  async listPapers(actorId: string, bankId: string): Promise<ExamPaperSummary[]> {
    const bank = await this.getExamBank(actorId, bankId);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.view, bank.contextId);
    const caps = await this.capabilitiesAt(actorId, bank);
    const isAdmin = await this.evaluator.isSiteAdmin(actorId);
    const papers = await this.repo.listPapersInBank(bank.id);
    const summaries: ExamPaperSummary[] = [];
    for (const paper of papers) {
      const visible = isAdmin || paper.status === 'ready' || paper.createdBy === actorId || caps.moderate;
      if (!visible) continue;
      const version = await this.currentVersion(paper);
      const slots = await this.repo.listSlots(version.id);
      summaries.push({
        id: paper.id, bankId: paper.bankId, kind: paper.kind, status: paper.status,
        name: version.name, examKind: version.examKind, grade: version.grade, subjectId: version.subjectId,
        slotCount: slots.length, totalScore: version.totalScore, durationMinutes: version.durationMinutes,
        latestVersion: paper.latestVersion, createdBy: paper.createdBy,
        originalAuthorId: paper.originalAuthorId, derivedFromPaperId: paper.derivedFromPaperId,
        copyCount: paper.copyCount, updatedAt: paper.updatedAt.toISOString(),
        capabilities: { ...caps, edit: caps.edit && (paper.createdBy === actorId || caps.moderate) },
      });
    }
    return summaries;
  }

  /** Chi tiết một đề: version hiện tại + slots đã ghim + truy vết + khả năng của actor. */
  async getPaper(actorId: string, paperId: string): Promise<ExamPaperView> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanViewPaper(actorId, paper, bank);
    return this.paperView(actorId, paper);
  }

  /** Tạo đề snapshot mới trong bank đề (metadata + slots tuỳ chọn; rỗng = đề trắng để soạn tiếp). */
  async createPaper(actorId: string, bankId: string, input: CreateExamPaper): Promise<ExamPaperView> {
    const bank = await this.getExamBank(actorId, bankId);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.edit, bank.contextId);
    const slots = await this.resolveSlots(input.slots ?? []);
    let paper: ExamPaperRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      paper = await this.repo.insertPaper({
        bankId: bank.id, kind: 'snapshot', status: 'draft', createdBy: actorId, latestVersion: 1,
        derivedFromMatrixId: input.matrixId ?? null,
      }, tx);
      const version = await this.repo.insertVersion({
        paperId: paper.id, version: 1, name: input.name,
        subjectId: input.subjectId ?? null, grade: input.grade ?? null,
        examKind: input.examKind ?? null, totalScore: input.totalScore ?? 10,
        durationMinutes: input.durationMinutes ?? null, tfScale: input.tfScale ?? null,
        matrixId: input.matrixId ?? null, matrixVersion: null, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(slots.map((s, i) => ({ paperVersionId: version.id, position: i + 1, ...s })), tx);
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_created',
      payload: { paperId: paper!.id, bankId: bank.id, actorId },
    });
    return this.paperView(actorId, paper!);
  }

  /**
   * Sửa metadata của đề = tạo paper version MỚI (slots mang nguyên từ
   * version hiện tại). Version cũ bất biến: quiz đã ghim version cũ
   * không đổi (tiêu chí nghiệm thu 2 của issue).
   */
  async updatePaper(actorId: string, paperId: string, input: UpdateExamPaper): Promise<ExamPaperView> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanEditPaper(actorId, paper, bank);
    const current = await this.currentVersion(paper);
    const currentSlots = await this.repo.listSlots(current.id);
    const next = paper.latestVersion + 1;
    await this.repo.dbHandle.transaction(async (tx) => {
      const version = await this.repo.insertVersion({
        paperId: paper.id, version: next,
        name: input.name ?? current.name,
        subjectId: input.subjectId !== undefined ? input.subjectId : current.subjectId,
        grade: input.grade !== undefined ? input.grade : current.grade,
        examKind: input.examKind !== undefined ? input.examKind : current.examKind,
        totalScore: input.totalScore ?? current.totalScore,
        durationMinutes: input.durationMinutes !== undefined ? input.durationMinutes : current.durationMinutes,
        tfScale: input.tfScale !== undefined ? input.tfScale : current.tfScale,
        matrixId: input.matrixId !== undefined ? input.matrixId : current.matrixId,
        matrixVersion: current.matrixVersion, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(currentSlots.map((s) => ({
        paperVersionId: version.id, position: s.position, section: s.section,
        questionId: s.questionId, pinnedVersionId: s.pinnedVersionId,
        pinnedVersionNumber: s.pinnedVersionNumber, maxMark: s.maxMark, clusterId: s.clusterId,
      })), tx);
      await this.repo.updatePaper(paper.id, { latestVersion: next }, tx);
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_updated',
      payload: { paperId: paper.id, bankId: bank.id, version: next, actorId },
    });
    return this.paperView(actorId, (await this.repo.getPaper(paper.id))!);
  }

  /** Thay toàn bộ slots của đề = tạo paper version mới với đúng danh sách slot đã ghim. */
  async setSlots(actorId: string, paperId: string, input: SetExamPaperSlots): Promise<ExamPaperView> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanEditPaper(actorId, paper, bank);
    const current = await this.currentVersion(paper);
    const slots = await this.resolveSlots(input.slots);
    const next = paper.latestVersion + 1;
    await this.repo.dbHandle.transaction(async (tx) => {
      const version = await this.repo.insertVersion({
        paperId: paper.id, version: next, name: current.name,
        subjectId: current.subjectId, grade: current.grade, examKind: current.examKind,
        totalScore: current.totalScore, durationMinutes: current.durationMinutes,
        tfScale: current.tfScale, matrixId: current.matrixId,
        matrixVersion: current.matrixVersion, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(slots.map((s, i) => ({ paperVersionId: version.id, position: i + 1, ...s })), tx);
      await this.repo.updatePaper(paper.id, { latestVersion: next }, tx);
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_slots_set',
      payload: { paperId: paper.id, bankId: bank.id, version: next, slotCount: slots.length, actorId },
    });
    return this.paperView(actorId, (await this.repo.getPaper(paper.id))!);
  }

  /**
   * Đổi trạng thái vòng đời: draft → ready (bắt buộc có ít nhất 1
   * slot); mọi trạng thái → hidden (rút khỏi ngân hàng — quiz đã
   * triển khai không vỡ vì đã chụp slots riêng); hidden → ready/draft
   * (khôi phục). Chỉ tác giả hoặc người duyệt.
   */
  async setStatus(actorId: string, paperId: string, input: SetExamPaperStatus): Promise<ExamPaperView> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanEditPaper(actorId, paper, bank);
    if (input.status === 'ready') {
      const version = await this.currentVersion(paper);
      const slots = await this.repo.listSlots(version.id);
      if (slots.length === 0) {
        throw new BadRequestException({
          message: 'A paper needs at least one question before it can be marked ready',
          code: 'exam.ready_requires_slots',
        });
      }
    }
    await this.repo.updatePaper(paper.id, { status: input.status });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_status_changed',
      payload: { paperId: paper.id, bankId: bank.id, status: input.status, actorId },
    });
    return this.paperView(actorId, (await this.repo.getPaper(paper.id))!);
  }

  /**
   * Xoá vật lý một đề: versions/slots/contributions cascade theo FK;
   * quizzes.paper_id/paper_version_id tự về null (FK set null) — quiz
   * đã thi vẫn đọc attempt bình thường từ slots đã chụp.
   */
  async deletePaper(actorId: string, paperId: string): Promise<{ id: string; deleted: true }> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanEditPaper(actorId, paper, bank);
    await this.repo.deletePaper(paper.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_deleted',
      payload: { paperId: paper.id, bankId: bank.id, actorId },
    });
    return { id: paper.id, deleted: true };
  }

  // --- copy ---------------------------------------------------------------------

  /**
   * Deep copy một đề sang bank đích (mặc định ngân hàng đề cá nhân
   * của người copy): danh tính mới, slots sao nguyên — question +
   * pinned version GIỮ NGUYÊN (copy đề không copy câu), derived_from
   * trỏ về đề nguồn, tác giả gốc giữ nguyên qua các đời copy,
   * copy_count của đề nguồn tăng. Bản copy bắt đầu ở draft, version 1.
   */
  async copyPaper(actorId: string, paperId: string, input: CopyExamPaper): Promise<ExamPaperView> {
    const source = await this.getPaperOrThrow(paperId);
    const sourceBank = await this.bankOfPaper(source);
    await this.assertCanViewPaper(actorId, source, sourceBank);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.copy, sourceBank.contextId);

    let target: QuestionBankRow;
    if (input.targetBankId) {
      target = await this.getExamBank(actorId, input.targetBankId);
    } else {
      const row = await this.banks.ensurePersonalBank(actorId, 'exam', { forCopy: true });
      await this.ensureExamGrants(row);
      target = row;
    }
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.edit, target.contextId);

    const copied = await this.deepCopyInto(actorId, source, target, input.name);
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_copied',
      payload: {
        paperId: copied.id, sourcePaperId: source.id,
        sourceBankId: sourceBank.id, targetBankId: target.id, actorId,
      },
    });
    return this.paperView(actorId, copied);
  }

  /** Nhân bản đề (danh tính + version hiện tại thành version 1 + slots nguyên trạng) vào bank đích — dùng chung cho copy tay và duyệt đóng góp. */
  private async deepCopyInto(actorId: string, source: ExamPaperRow, target: QuestionBankRow, nameOverride?: string): Promise<ExamPaperRow> {
    const sourceVersion = await this.currentVersion(source);
    const sourceSlots = await this.repo.listSlots(sourceVersion.id);
    let created: ExamPaperRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      created = await this.repo.insertPaper({
        bankId: target.id, kind: source.kind, status: 'draft',
        derivedFromPaperId: source.id,
        derivedFromMatrixId: sourceVersion.matrixId,
        originalAuthorId: source.originalAuthorId ?? source.createdBy,
        createdBy: actorId, latestVersion: 1,
      }, tx);
      const version = await this.repo.insertVersion({
        paperId: created.id, version: 1, name: nameOverride ?? sourceVersion.name,
        subjectId: sourceVersion.subjectId, grade: sourceVersion.grade, examKind: sourceVersion.examKind,
        totalScore: sourceVersion.totalScore, durationMinutes: sourceVersion.durationMinutes,
        tfScale: sourceVersion.tfScale, matrixId: sourceVersion.matrixId,
        matrixVersion: sourceVersion.matrixVersion, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(sourceSlots.map((s) => ({
        paperVersionId: version.id, position: s.position, section: s.section,
        questionId: s.questionId, pinnedVersionId: s.pinnedVersionId,
        pinnedVersionNumber: s.pinnedVersionNumber, maxMark: s.maxMark, clusterId: s.clusterId,
      })), tx);
      await this.repo.bumpCopyCount(source.id, tx);
    });
    return created!;
  }

  // --- đóng góp (khuôn QB-4) ------------------------------------------------------

  /**
   * Đề xuất đóng góp một đề READY vào bank đích (tổ/trường/khoá):
   * cổng exam:share tại bank NGUỒN; bank đích không được là bank cá
   * nhân; chống trùng: hash cấu trúc bằng một đề đã có trong bank
   * đích thì ghi nhận near_duplicate_of (trùng hoàn toàn — suy từ
   * chính đề nguồn — sẽ bị chặn 409 lúc duyệt như QB-4).
   */
  async proposeContribution(actorId: string, targetBankId: string, input: CreateExamPaperContribution): Promise<ExamPaperContributionRow> {
    const target = await this.getExamBank(actorId, targetBankId);
    if (target.scope === 'personal') {
      throw new BadRequestException({ message: 'Cannot contribute into a personal bank', code: 'exam.contribution_target_personal' });
    }
    const paper = await this.getPaperOrThrow(input.paperId);
    const sourceBank = await this.bankOfPaper(paper);
    if (paper.bankId === target.id) {
      throw new BadRequestException({ message: 'The paper is already in the target bank', code: 'exam.contribution_same_bank' });
    }
    await this.assertCanViewPaper(actorId, paper, sourceBank);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.share, sourceBank.contextId);
    if (paper.status !== 'ready') {
      throw new BadRequestException({ message: 'Only a ready paper can be contributed', code: 'exam.contribution_source_not_ready' });
    }
    const existing = await this.repo.findPendingContribution(paper.id, target.id);
    if (existing) {
      throw new ConflictException({ message: 'A pending contribution of this paper to the target bank already exists', code: 'exam.contribution_duplicate_pending' });
    }
    const version = await this.currentVersion(paper);
    const slots = await this.repo.listSlots(version.id);
    const hash = this.paperContentHash(version, slots);
    let nearDuplicateOf: string | null = null;
    for (const other of await this.repo.listPapersInBank(target.id)) {
      const otherVersion = await this.currentVersion(other);
      const otherSlots = await this.repo.listSlots(otherVersion.id);
      if (this.paperContentHash(otherVersion, otherSlots) === hash) { nearDuplicateOf = other.id; break; }
    }
    const row = await this.repo.insertContribution({
      paperId: paper.id, targetBankId: target.id, proposerId: actorId,
      note: input.note ?? '', contentHash: hash, nearDuplicateOf,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_contribution_proposed',
      payload: { contributionId: row.id, targetBankId: target.id, paperId: paper.id, proposerId: actorId, nearDuplicateOf },
    });
    return row;
  }

  /** Hàng chờ đóng góp của một bank đề: người duyệt (exam:moderate tại bank đích) thấy tất cả; người khác chỉ thấy đề xuất của mình (như QB-4). */
  async listContributions(actorId: string, bankId: string): Promise<ExamPaperContributionView[]> {
    const bank = await this.getExamBank(actorId, bankId);
    const canModerate = await this.evaluator.hasCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId);
    const all = await this.repo.listContributionsForBank(bank.id);
    const rows = canModerate ? all : all.filter((r) => r.proposerId === actorId);
    const views: ExamPaperContributionView[] = [];
    for (const row of rows) {
      const paper = await this.repo.getPaper(row.paperId);
      views.push({ ...row, paperName: paper ? (await this.currentVersion(paper)).name : null, sourceBankId: paper?.bankId ?? null });
    }
    return views;
  }

  private async getContributionForBank(bankId: string, contributionId: string): Promise<ExamPaperContributionRow> {
    const row = await this.repo.getContribution(contributionId);
    if (!row || row.targetBankId !== bankId) {
      throw new NotFoundException({ message: `Contribution ${contributionId} not found`, code: 'exam.contribution_not_found' });
    }
    return row;
  }

  /**
   * Duyệt một đề xuất: chủ bank đích (exam:moderate tại bank đích)
   * COPY đề vào bank đích — đề vào bank đích là danh tính mới suy từ
   * đề nguồn; trùng hoàn toàn (đã có bản suy từ chính đề nguồn trong
   * bank đích) thì 409 như QB-4.
   */
  async approveContribution(actorId: string, bankId: string, contributionId: string, _input: ApproveExamPaperContribution): Promise<ExamPaperContributionRow> {
    const bank = await this.getExamBank(actorId, bankId);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId);
    const contribution = await this.getContributionForBank(bank.id, contributionId);
    if (contribution.status !== 'pending') {
      throw new ConflictException({ message: 'Contribution is no longer pending', code: 'exam.contribution_not_pending' });
    }
    const source = await this.getPaperOrThrow(contribution.paperId);
    const inTarget = await this.repo.listPapersInBank(bank.id);
    if (inTarget.some((p) => p.derivedFromPaperId === source.id)) {
      throw new ConflictException({
        message: `An identical paper already exists in the target bank (copied from ${source.id})`,
        code: 'exam.duplicate_in_bank',
      });
    }
    const copied = await this.deepCopyInto(actorId, source, bank);
    await this.repo.updateContribution(contribution.id, {
      status: 'approved', reviewerId: actorId, resultPaperId: copied.id,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_contribution_approved',
      payload: {
        contributionId: contribution.id, targetBankId: bank.id, paperId: source.id,
        resultPaperId: copied.id, reviewerId: actorId, proposerId: contribution.proposerId,
      },
    });
    return (await this.repo.getContribution(contribution.id))!;
  }

  /** Từ chối một đề xuất: lý do bắt buộc để giáo viên sửa và đề xuất lại. */
  async rejectContribution(actorId: string, bankId: string, contributionId: string, input: RejectExamPaperContribution): Promise<ExamPaperContributionRow> {
    const bank = await this.getExamBank(actorId, bankId);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId);
    const contribution = await this.getContributionForBank(bank.id, contributionId);
    if (contribution.status !== 'pending') {
      throw new ConflictException({ message: 'Contribution is no longer pending', code: 'exam.contribution_not_pending' });
    }
    await this.repo.updateContribution(contribution.id, {
      status: 'rejected', reviewerId: actorId, rejectReason: input.reason,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_contribution_rejected',
      payload: {
        contributionId: contribution.id, targetBankId: bank.id, paperId: contribution.paperId,
        reviewerId: actorId, proposerId: contribution.proposerId, reason: input.reason,
      },
    });
    return (await this.repo.getContribution(contribution.id))!;
  }

  // --- triển khai vào quiz ---------------------------------------------------------

  /**
   * Triển khai đề vào một quiz: cổng exam:deploy tại bank của đề +
   * đề phải ở trạng thái ready (draft chưa chốt, hidden đã rút — đều
   * không triển khai mới được; quiz ĐÃ triển khai từ trước không bị
   * ảnh hưởng khi đề chuyển hidden). Slots được chụp sang quiz qua
   * QuizService.deployPaperSlots (cổng quiz:manage + đóng băng
   * attempt ở phía quiz); page của slot suy từ thứ tự xuất hiện của
   * section (mỗi phần một trang, không phần = trang 1).
   */
  async deploy(actorId: string, paperId: string, input: DeployExamPaper): Promise<QuizView> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.deploy, bank.contextId);
    if (paper.status !== 'ready') {
      throw new BadRequestException({
        message: `Only a ready paper can be deployed (current status: ${paper.status})`,
        code: 'exam.deploy_requires_ready',
      });
    }
    const version = await this.currentVersion(paper);
    const slots = await this.repo.listSlots(version.id);
    if (slots.length === 0) {
      throw new BadRequestException({ message: 'Cannot deploy an empty paper', code: 'exam.deploy_empty_paper' });
    }
    const pageBySection = new Map<string, number>();
    const mapped = slots.map((s) => {
      if (!pageBySection.has(s.section)) pageBySection.set(s.section, pageBySection.size + 1);
      return {
        questionId: s.questionId,
        pinnedVersionId: s.pinnedVersionId,
        pinnedVersionNumber: s.pinnedVersionNumber,
        maxMark: s.maxMark,
        page: pageBySection.get(s.section)!,
        clusterId: s.clusterId,
      };
    });
    return this.quiz.deployPaperSlots(actorId, input.quizId, {
      paperId: paper.id,
      paperVersionId: version.id,
      tfScale: version.tfScale,
      replace: input.replace ?? false,
      slots: mapped,
    });
  }
}
