import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ApproveExamPaperContribution, CopyExamPaper, CreateExamPaper, CreateExamPaperContribution,
  DeployExamPaper, ExamPaperSlotInput, GenerateFromMatrix, MaterializeExamPaper, QuizView,
  RejectExamPaperContribution, SetExamPaperSlots, SetExamPaperStatus, SwapExamPaperSlot, UpdateExamPaper,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { CAP_ALLOW } from '../access/domain/permission';
import { QuestionBanksService, QBANK_LEAD_ROLE, QBANK_MEMBER_ROLE } from '../questions/question-banks.service';
import type { QuestionBankRow } from '../questions/question-banks.repository';
import { QuizService, type MatrixSpecification } from '../quiz/quiz.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import {
  ExamPapersRepository,
  type ExamDeploymentRow, type ExamPaperContributionRow, type ExamPaperRow, type ExamPaperSlotRow, type ExamPaperVersionRow,
} from './exam-papers.repository';
import type { RecipeCellSpec, RecipeSpec } from '../../db/schema';
import type { ExamMatrixCellRow } from '../quiz/quiz.repository';

/** Bộ capability của lớp ngân hàng đề — mọi cổng đều đánh giá TẠI context của bank đề (một nguồn quyền duy nhất là bank). */
export const EXAM_CAPABILITIES = {
  view: 'exam:view',
  edit: 'exam:edit',
  copy: 'exam:copy',
  share: 'exam:share',
  moderate: 'exam:moderate',
  deploy: 'exam:deploy',
} as const;

/** Các loại đề thuộc diện ĐỊNH KỲ/THI THỬ — nội dung ready của chúng tại bank trường là tài liệu mật theo nghĩa nghiệp vụ (lớp bảo mật A.3.4, EB-3). */
export const PERIODIC_EXAM_KINDS = ['midterm', 'final', 'mock'] as const;

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
  /** Ô ma trận nguồn (chỉ ở snapshot materialize từ recipe — neo swap-cùng-ô). */
  matrixCellId: string | null;
}

/** Báo cáo tỉ lệ theo ô của một snapshot có nguồn recipe: kỳ vọng (từ recipeSpec đã ghim) vs thực tế (slots hiện tại). */
export interface ExamPaperCellReport {
  sourceCellId: string;
  learningOutcomeId: string;
  cognitiveLevel: string;
  qtype: string;
  expectedUnits: number;
  actualUnits: number;
  expectedScore: number;
  actualScore: number;
  /** Lệch = số đơn vị hoặc tổng điểm của ô khác kỳ vọng (UI báo ngay ô lệch). */
  deviated: boolean;
}

/** Một lần triển khai kèm mã đề (EB-2, E-5). */
export interface ExamDeploymentView {
  id: string; paperId: string; paperVersionId: string; quizId: string;
  variantCount: number;
  variants: { code: string; seed: number }[];
  createdBy: string; createdAt: string;
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
    /** Công thức recipe đã ghim (chỉ đề recipe + snapshot materialize từ recipe). */
    recipeSpec: RecipeSpec | null;
    createdBy: string; createdAt: string;
  };
  slots: ExamPaperSlotView[];
  /** Báo cáo lệch tỉ lệ theo ô (null khi đề không có nguồn recipe). */
  cellReport: ExamPaperCellReport[] | null;
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
    private readonly tenantContext: TenantContextService,
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
  async getExamBank(actorId: string, bankId: string): Promise<QuestionBankRow> {
    const view = await this.banks.getBank(actorId, bankId);
    if (view.bankKind !== 'exam') {
      throw new NotFoundException({ message: `Bank ${bankId} is not an exam bank`, code: 'exam.not_exam_bank' });
    }
    const bank: QuestionBankRow = view;
    await this.ensureExamGrants(bank);
    return bank;
  }

  async bankOfPaper(paper: ExamPaperRow): Promise<QuestionBankRow> {
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

  // --- lớp bảo mật đề định kỳ (A.3.4, EB-3) ---------------------------------------

  /**
   * Version hiện tại của đề khi đề thuộc diện bảo mật A.3.4 — bank
   * TRƯỜNG + đề `ready` + loại định kỳ/thi thử; null khi không thuộc
   * diện (đề ở bank tổ/khoá/cá nhân hoặc loại thường xuyên/ôn tập
   * giữ nguyên cổng xem cơ bản).
   */
  private async periodicSchoolVersion(paper: ExamPaperRow, bank: QuestionBankRow): Promise<ExamPaperVersionRow | null> {
    if (bank.scope !== 'school' || paper.status !== 'ready') return null;
    const version = await this.currentVersion(paper);
    if (!version.examKind || !(PERIODIC_EXAM_KINDS as readonly string[]).includes(version.examKind)) return null;
    return version;
  }

  /**
   * Cổng XEM NỘI DUNG đề (chi tiết kèm slots, bản in, bản đặc tả):
   * cổng xem cơ bản cộng lớp A.3.4 — nội dung đề định kỳ/thi thử
   * `ready` tại bank trường chỉ mở cho site admin, tác giả, người
   * duyệt của bank (exam:moderate) hoặc giáo viên ĐANG DẠY khối của
   * đề (gán vai archetype giáo viên tại context một khoá có grade
   * khớp). Giáo viên cùng trường nhưng khác khối bị chặn 403
   * `exam.periodic_view_forbidden`.
   */
  async assertCanViewPaperContent(actorId: string, paper: ExamPaperRow, bank: QuestionBankRow): Promise<void> {
    await this.assertCanViewPaper(actorId, paper, bank);
    const version = await this.periodicSchoolVersion(paper, bank);
    if (!version) return;
    if (await this.evaluator.isSiteAdmin(actorId)) return;
    if (paper.createdBy === actorId) return;
    if (await this.evaluator.hasCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId)) return;
    if (version.grade !== null && await this.repo.userTeachesGrade(actorId, version.grade)) return;
    throw new ForbiddenException({
      message: 'Periodic exam content in the school bank is restricted to teachers of its grade and bank moderators',
      code: 'exam.periodic_view_forbidden',
    });
  }

  /**
   * Ghi audit một lần XEM NỘI DUNG THÀNH CÔNG thuộc diện A.3.4 qua
   * outbox/event log hiện có (no-op khi đề không thuộc diện): ai xem,
   * đề nào, phiên bản nào, bề mặt nào (detail/print/specification).
   */
  async auditPaperContentView(actorId: string, paper: ExamPaperRow, bank: QuestionBankRow, surface: string): Promise<void> {
    const version = await this.periodicSchoolVersion(paper, bank);
    if (!version) return;
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_content_viewed',
      payload: {
        paperId: paper.id, paperVersionId: version.id, paperVersion: version.version,
        bankId: bank.id, examKind: version.examKind, grade: version.grade, surface, actorId,
      },
    });
  }

  /** Cổng sửa/xoá đề: có exam:edit tại bank VÀ (là tác giả HOẶC có exam:moderate) — GV khác chỉ xem/copy, không sửa đề cá nhân của người khác. */
  async assertCanEditPaper(actorId: string, paper: ExamPaperRow, bank: QuestionBankRow): Promise<void> {
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

  async getPaperOrThrow(id: string): Promise<ExamPaperRow> {
    const paper = await this.repo.getPaper(id);
    if (!paper) throw new NotFoundException({ message: `Exam paper ${id} not found`, code: 'exam.not_found' });
    return paper;
  }

  async currentVersion(paper: ExamPaperRow): Promise<ExamPaperVersionRow> {
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
      matrixCellId: s.matrixCellId,
    }));
  }

  /** Báo cáo lệch tỉ lệ theo ô: kỳ vọng từ recipeSpec đã ghim vs slots hiện tại (đơn vị truefalse tính theo chùm 4 slot). */
  private cellReport(version: ExamPaperVersionRow, slots: ExamPaperSlotRow[]): ExamPaperCellReport[] | null {
    const spec = version.recipeSpec;
    if (!spec) return null;
    return spec.cells.map((cell) => {
      const mine = slots.filter((s) => s.matrixCellId === cell.sourceCellId);
      const actualUnits = cell.qtype === 'truefalse' ? mine.length / 4 : mine.length;
      const actualScore = mine.reduce((sum, s) => sum + s.maxMark, 0);
      return {
        sourceCellId: cell.sourceCellId,
        learningOutcomeId: cell.learningOutcomeId,
        cognitiveLevel: cell.cognitiveLevel,
        qtype: cell.qtype,
        expectedUnits: cell.questionCount,
        actualUnits,
        expectedScore: cell.cellScore,
        actualScore,
        deviated: actualUnits !== cell.questionCount || Math.abs(actualScore - cell.cellScore) > 1e-9,
      };
    });
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
        recipeSpec: version.recipeSpec ?? null,
        createdBy: version.createdBy, createdAt: version.createdAt.toISOString(),
      },
      slots: await this.slotViews(slots),
      cellReport: this.cellReport(version, slots),
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

  /** Chi tiết một đề: version hiện tại + slots đã ghim + truy vết + khả năng của actor. Nội dung đề qua cổng A.3.4 (EB-3) và ghi audit khi thuộc diện định kỳ ở bank trường. */
  async getPaper(actorId: string, paperId: string): Promise<ExamPaperView> {
    const paper = await this.getPaperOrThrow(paperId);
    // Đề thuộc tenant khác với tenant hiệu lực → 404 đồng nhất (TENANT-0, #168).
    const activeTenant = this.tenantContext.currentTenantId();
    if (activeTenant !== undefined && paper.tenantId !== null && paper.tenantId !== activeTenant) {
      throw new NotFoundException({ message: `Exam paper ${paperId} not found`, code: 'exam.not_found' });
    }
    const bank = await this.bankOfPaper(paper);
    await this.assertCanViewPaperContent(actorId, paper, bank);
    const view = await this.paperView(actorId, paper);
    await this.auditPaperContentView(actorId, paper, bank, 'detail');
    return view;
  }

  /** Tạo đề snapshot mới trong bank đề (metadata + slots tuỳ chọn; rỗng = đề trắng để soạn tiếp). */
  async createPaper(actorId: string, bankId: string, input: CreateExamPaper): Promise<ExamPaperView> {
    const bank = await this.getExamBank(actorId, bankId);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.edit, bank.contextId);
    const slots = await this.resolveSlots(input.slots ?? []);
    let paper: ExamPaperRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      paper = await this.repo.insertPaper({
        tenantId: bank.tenantId, bankId: bank.id, kind: 'snapshot', status: 'draft', createdBy: actorId, latestVersion: 1,
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
        matrixVersion: current.matrixVersion, recipeSpec: current.recipeSpec ?? null, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(currentSlots.map((s) => ({
        paperVersionId: version.id, position: s.position, section: s.section,
        questionId: s.questionId, pinnedVersionId: s.pinnedVersionId,
        pinnedVersionNumber: s.pinnedVersionNumber, maxMark: s.maxMark, clusterId: s.clusterId,
        matrixCellId: s.matrixCellId,
      })), tx);
      await this.repo.updatePaper(paper.id, { latestVersion: next }, tx);
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_updated',
      payload: { paperId: paper.id, bankId: bank.id, version: next, actorId },
    });
    return this.paperView(actorId, (await this.repo.getPaper(paper.id))!);
  }

  /** Thay toàn bộ slots của đề = tạo paper version mới với đúng danh sách slot đã ghim. Đề RECIPE bị chặn: không sửa tay trực tiếp — phải materialize xuống snapshot rồi sửa trên snapshot (EB-2, D.3). */
  async setSlots(actorId: string, paperId: string, input: SetExamPaperSlots): Promise<ExamPaperView> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanEditPaper(actorId, paper, bank);
    if (paper.kind === 'recipe') {
      throw new BadRequestException({
        message: 'A recipe paper cannot be edited directly; materialize it into a snapshot first',
        code: 'exam.recipe_not_editable',
      });
    }
    const current = await this.currentVersion(paper);
    const slots = await this.resolveSlots(input.slots);
    const next = paper.latestVersion + 1;
    await this.repo.dbHandle.transaction(async (tx) => {
      const version = await this.repo.insertVersion({
        paperId: paper.id, version: next, name: current.name,
        subjectId: current.subjectId, grade: current.grade, examKind: current.examKind,
        totalScore: current.totalScore, durationMinutes: current.durationMinutes,
        tfScale: current.tfScale, matrixId: current.matrixId,
        matrixVersion: current.matrixVersion, recipeSpec: current.recipeSpec ?? null, createdBy: actorId,
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
      if (paper.kind === 'recipe') {
        // Recipe không có slots: "đủ dùng" = có công thức đã ghim (ô + matrix version).
        if (!version.recipeSpec || version.recipeSpec.cells.length === 0) {
          throw new BadRequestException({
            message: 'A recipe paper needs a pinned matrix structure before it can be marked ready',
            code: 'exam.ready_requires_recipe',
          });
        }
      } else {
        const slots = await this.repo.listSlots(version.id);
        if (slots.length === 0) {
          throw new BadRequestException({
            message: 'A paper needs at least one question before it can be marked ready',
            code: 'exam.ready_requires_slots',
          });
        }
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
    return this.copyPaperVersionIntoBank(actorId, source, sourceVersion, target, { name: nameOverride, status: 'draft' });
  }

  /**
   * Nhân bản MỘT PHIÊN BẢN CỤ THỂ của đề vào bank đích: danh tính
   * mới, phiên bản đó trở thành version 1 của bản copy, slots sao
   * nguyên (question + pinned version giữ nguyên), derived_from trỏ
   * về đề nguồn, tác giả gốc giữ nguyên, copy_count của đề nguồn
   * tăng. Copy tay/duyệt đóng góp dùng version hiện tại + trạng thái
   * draft; duyệt BỘ HỒ SƠ (EB-3) dùng PHIÊN BẢN ĐÃ GHIM lúc nộp +
   * trạng thái ready để đề hiện ngay ở bank đích sau khi duyệt đạt.
   */
  async copyPaperVersionIntoBank(actorId: string, source: ExamPaperRow, sourceVersion: ExamPaperVersionRow, target: QuestionBankRow, opts?: { name?: string; status?: string }): Promise<ExamPaperRow> {
    const sourceSlots = await this.repo.listSlots(sourceVersion.id);
    let created: ExamPaperRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      created = await this.repo.insertPaper({
        tenantId: target.tenantId, bankId: target.id, kind: source.kind, status: opts?.status ?? 'draft',
        derivedFromPaperId: source.id,
        derivedFromMatrixId: sourceVersion.matrixId,
        originalAuthorId: source.originalAuthorId ?? source.createdBy,
        createdBy: actorId, latestVersion: 1,
      }, tx);
      const version = await this.repo.insertVersion({
        paperId: created.id, version: 1, name: opts?.name ?? sourceVersion.name,
        subjectId: sourceVersion.subjectId, grade: sourceVersion.grade, examKind: sourceVersion.examKind,
        totalScore: sourceVersion.totalScore, durationMinutes: sourceVersion.durationMinutes,
        tfScale: sourceVersion.tfScale, matrixId: sourceVersion.matrixId,
        matrixVersion: sourceVersion.matrixVersion, recipeSpec: sourceVersion.recipeSpec ?? null, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(sourceSlots.map((s) => ({
        paperVersionId: version.id, position: s.position, section: s.section,
        questionId: s.questionId, pinnedVersionId: s.pinnedVersionId,
        pinnedVersionNumber: s.pinnedVersionNumber, maxMark: s.maxMark, clusterId: s.clusterId,
        matrixCellId: s.matrixCellId,
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

  // --- mã đề ở tầng triển khai (EB-2, E-5) ---------------------------------------

  /** Sinh danh sách mã đề cho một lần triển khai: 001, 002… kèm seed hoán vị riêng từng mã (hạt giống suy xác định từ id lần triển khai để in lại khớp). */
  private makeVariants(deploymentSeedSource: string, count: number): { code: string; seed: number }[] {
    let h = 2166136261;
    for (const ch of deploymentSeedSource) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return Array.from({ length: count }, (_, i) => ({
      code: String(i + 1).padStart(3, '0'),
      seed: (h + i * 2654435761) % 2147483647,
    }));
  }

  private deploymentView(row: ExamDeploymentRow): ExamDeploymentView {
    return {
      id: row.id, paperId: row.paperId, paperVersionId: row.paperVersionId, quizId: row.quizId,
      variantCount: row.variantCount, variants: row.variants ?? [],
      createdBy: row.createdBy, createdAt: row.createdAt.toISOString(),
    };
  }

  /** Các lần triển khai của một đề (mới nhất trước) kèm mã đề của từng lần — cổng xem như xem đề. */
  async listDeployments(actorId: string, paperId: string): Promise<ExamDeploymentView[]> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanViewPaper(actorId, paper, bank);
    const rows = await this.repo.listDeploymentsForPaper(paper.id);
    return rows.map((r) => this.deploymentView(r));
  }

  // --- triển khai vào quiz ---------------------------------------------------------

  /**
   * Triển khai đề vào một quiz: cổng exam:deploy tại bank của đề +
   * đề phải ở trạng thái ready (draft chưa chốt, hidden đã rút — đều
   * không triển khai mới được; quiz ĐÃ triển khai từ trước không bị
   * ảnh hưởng khi đề chuyển hidden).
   *
   * - Snapshot: chụp slots sang quiz qua QuizService.deployPaperSlots
   *   (cổng quiz:manage + đóng băng attempt ở phía quiz); page của
   *   slot suy từ thứ tự xuất hiện của section.
   * - Recipe (EB-2): ghi slot theo Ô NGUỒN từ recipeSpec đã ghim
   *   (QuizService.deployRecipeSlots) — câu rút tại attempt và pin ở
   *   attempt như cơ chế per_student hiện có; cấu trúc (ô/số
   *   câu/điểm) lấy từ bản chụp của recipe, không đọc lại ma trận.
   *
   * Mỗi lần triển khai ghi một dòng exam_deployments mang N mã đề
   * (variant_code ở tầng triển khai — E-5).
   */
  async deploy(actorId: string, paperId: string, input: DeployExamPaper): Promise<QuizView & { deployment: ExamDeploymentView }> {
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
    let view: QuizView;
    if (paper.kind === 'recipe') {
      const spec = version.recipeSpec;
      if (!spec || !version.matrixId) {
        throw new BadRequestException({ message: 'This recipe paper has no pinned matrix structure', code: 'exam.recipe_missing_spec' });
      }
      const slots: { matrixCellId: string; clusterId: string | null; maxMark: number; page: number }[] = [];
      spec.cells.forEach((cell, idx) => {
        const page = idx + 1;
        const perUnit = cell.cellScore / cell.questionCount;
        if (cell.qtype === 'truefalse') {
          for (let u = 0; u < cell.questionCount; u++) {
            const clusterId = randomUUID();
            for (let k = 0; k < 4; k++) {
              slots.push({ matrixCellId: cell.sourceCellId, clusterId, maxMark: perUnit / 4, page });
            }
          }
        } else {
          for (let u = 0; u < cell.questionCount; u++) {
            slots.push({ matrixCellId: cell.sourceCellId, clusterId: null, maxMark: perUnit, page });
          }
        }
      });
      view = await this.quiz.deployRecipeSlots(actorId, input.quizId, {
        paperId: paper.id, paperVersionId: version.id, matrixId: version.matrixId,
        tfScale: version.tfScale, replace: input.replace ?? false, slots,
      });
    } else {
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
          matrixCellId: s.matrixCellId ?? null,
        };
      });
      view = await this.quiz.deployPaperSlots(actorId, input.quizId, {
        paperId: paper.id,
        paperVersionId: version.id,
        matrixId: version.matrixId,
        tfScale: version.tfScale,
        replace: input.replace ?? false,
        slots: mapped,
      });
    }
    const variantCount = input.variantCount ?? 1;
    const deployment = await this.repo.insertDeployment({
      paperId: paper.id, paperVersionId: version.id, quizId: input.quizId,
      variantCount, variants: this.makeVariants(`${paper.id}:${version.id}:${input.quizId}:${Date.now()}`, variantCount),
      createdBy: actorId,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_deployed_with_variants',
      payload: { paperId: paper.id, paperVersionId: version.id, quizId: input.quizId, deploymentId: deployment.id, variantCount, actorId },
    });
    return { ...view, deployment: this.deploymentView(deployment) };
  }

  // --- generate hai bước (EB-2, E-3) ------------------------------------------------

  /**
   * Sinh đề từ ma trận — HAI BƯỚC về mặt dữ liệu, MỘT thao tác cho
   * giáo viên: (1) tạo exam_papers trong ngân hàng đề CÁ NHÂN của
   * người sinh (snapshot khi fixed — bộ câu rút ngay và ghim; recipe
   * khi per_student — chỉ ghim cấu trúc ô + matrix version), trạng
   * thái ready; (2) deploy đề đó vào quiz mới tạo trong khoá. Trả
   * QuizView như endpoint cũ + paperId nằm trong quiz (truy vết
   * chính), matrix_id là truy vết phụ.
   */
  async generateFromMatrix(actorId: string, matrixId: string, input: GenerateFromMatrix): Promise<QuizView & { deployment: ExamDeploymentView }> {
    const { matrix, cells } = await this.quiz.matrixForGeneration(actorId, matrixId);
    const cellScale = cells.find((c) => c.tfScale !== null)?.tfScale ?? null;
    const spec: RecipeSpec = {
      drawMode: input.drawMode,
      sourceBankScope: null,
      sourceBankId: matrix.bankId ?? null,
      cells: cells.map((c) => ({
        sourceCellId: c.id, learningOutcomeId: c.learningOutcomeId,
        cognitiveLevel: c.cognitiveLevel, qtype: c.qtype,
        questionCount: c.questionCount, cellScore: c.cellScore,
        minutes: c.minutes, tfScale: c.tfScale,
      })),
    };
    if (matrix.bankId) {
      const sourceBank = await this.banks.getBankOrThrow(matrix.bankId).catch(() => null);
      spec.sourceBankScope = sourceBank?.scope ?? null;
    }
    // Rút bộ cố định TRƯỚC khi tạo bất kỳ thứ gì (fixed): thiếu câu là
    // lỗi cứng 422 và không để lại đề/quiz rác.
    const drawn = input.drawMode === 'fixed' ? await this.quiz.drawFixedSlots(actorId, cells) : null;

    const bankRow = await this.banks.ensurePersonalBank(actorId, 'exam');
    await this.ensureExamGrants(bankRow);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.edit, bankRow.contextId);

    // Ghim version ready cho từng câu đã rút (đúng kỷ luật ghim của
    // đề: version tại thời điểm chụp) — phân giải trước khi ghi.
    const drawnPinned = drawn ? await Promise.all(drawn.map(async (d) => {
      const ready = await this.repo.resolveReadyVersion(d.questionId);
      if (!ready) {
        throw new BadRequestException({
          message: `Question ${d.questionId} has no ready version; only ready questions can enter a paper`,
          code: 'exam.slot_question_not_ready',
        });
      }
      return { ...d, pinnedVersionId: ready.versionId, pinnedVersionNumber: ready.versionNumber };
    })) : null;
    let paper: ExamPaperRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      paper = await this.repo.insertPaper({
        tenantId: bankRow.tenantId, bankId: bankRow.id,
        kind: input.drawMode === 'fixed' ? 'snapshot' : 'recipe',
        status: 'ready', createdBy: actorId, latestVersion: 1,
        derivedFromMatrixId: matrix.id,
      }, tx);
      const version = await this.repo.insertVersion({
        paperId: paper.id, version: 1, name: input.name,
        subjectId: matrix.subjectId, grade: null, examKind: null,
        totalScore: matrix.totalScore, durationMinutes: null, tfScale: cellScale,
        matrixId: matrix.id, matrixVersion: matrix.version,
        recipeSpec: input.drawMode === 'per_student' ? spec : null,
        createdBy: actorId,
      }, tx);
      if (drawnPinned) {
        // Snapshot sinh từ ma trận: slot ghi matrixCellId nguồn để
        // báo cáo tỉ lệ theo ô đối chiếu được với ma trận.
        await this.repo.insertSlots(drawnPinned.map((d, i) => ({
          paperVersionId: version.id, position: i + 1,
          section: `Ô ${d.page}`,
          questionId: d.questionId,
          pinnedVersionId: d.pinnedVersionId, pinnedVersionNumber: d.pinnedVersionNumber,
          maxMark: d.maxMark, clusterId: d.clusterId, matrixCellId: d.matrixCellId,
        })), tx);
      }
    });
    const totalMinutes = cells.reduce((sum, c) => sum + (c.minutes ?? 0), 0);
    const timeLimitSeconds = input.timeLimitSeconds !== undefined && input.timeLimitSeconds !== null
      ? input.timeLimitSeconds
      : (totalMinutes > 0 ? totalMinutes * 60 : null);
    const created = await this.quiz.createQuiz(actorId, input.courseId, {
      sectionId: input.sectionId, name: input.name,
      timeLimitSeconds, grade: matrix.totalScore, tfScale: cellScale,
    });
    try {
      const deployed = await this.deploy(actorId, paper!.id, { quizId: created.id });
      await this.outbox.enqueueStandalone({
        aggregate: 'exam_paper', type: 'exam_paper_generated_from_matrix',
        payload: { paperId: paper!.id, matrixId: matrix.id, matrixVersion: matrix.version, drawMode: input.drawMode, quizId: created.id, actorId },
      });
      return deployed;
    } catch (err) {
      await this.quiz.deleteQuiz(actorId, created.id).catch(() => undefined);
      throw err;
    }
  }

  // --- materialize + swap-cùng-ô (EB-2, D.3) ------------------------------------------

  /**
   * Chụp một đề RECIPE thành một đề SNAPSHOT mới (materialize): rút
   * một bộ câu cố định từ pool của các ô theo recipeSpec đã ghim
   * (thiếu câu ở bất kỳ ô nào → 422 như generate, không chụp một
   * phần). Snapshot mới nằm CÙNG bank với recipe, derived_from trỏ
   * về recipe (+ matrix version qua version.matrixId/matrixVersion),
   * giữ recipeSpec để báo cáo tỉ lệ + swap-cùng-ô; trạng thái draft
   * để giáo viên sửa rồi mới ready. Recipe gốc KHÔNG đổi.
   */
  async materialize(actorId: string, paperId: string, input: MaterializeExamPaper): Promise<ExamPaperView> {
    const recipe = await this.getPaperOrThrow(paperId);
    if (recipe.kind !== 'recipe') {
      throw new BadRequestException({ message: 'Only a recipe paper can be materialized', code: 'exam.materialize_requires_recipe' });
    }
    const bank = await this.bankOfPaper(recipe);
    await this.assertCanEditPaper(actorId, recipe, bank);
    const recipeVersion = await this.currentVersion(recipe);
    const spec = recipeVersion.recipeSpec;
    if (!spec || !recipeVersion.matrixId) {
      throw new BadRequestException({ message: 'This recipe paper has no pinned matrix structure', code: 'exam.recipe_missing_spec' });
    }
    const pseudoCells = spec.cells.map((c) => ({
      id: c.sourceCellId, matrixId: recipeVersion.matrixId!,
      learningOutcomeId: c.learningOutcomeId, cognitiveLevel: c.cognitiveLevel, qtype: c.qtype,
      questionCount: c.questionCount, cellScore: c.cellScore, minutes: c.minutes, tfScale: c.tfScale,
      position: 0, createdAt: new Date(), updatedAt: new Date(),
    })) as ExamMatrixCellRow[];
    const drawn = await this.quiz.drawFixedSlots(actorId, pseudoCells);
    let created: ExamPaperRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      created = await this.repo.insertPaper({
        tenantId: recipe.tenantId, bankId: recipe.bankId, kind: 'snapshot', status: 'draft',
        derivedFromPaperId: recipe.id, derivedFromMatrixId: recipeVersion.matrixId,
        originalAuthorId: recipe.originalAuthorId ?? recipe.createdBy,
        createdBy: actorId, latestVersion: 1,
      }, tx);
      const version = await this.repo.insertVersion({
        paperId: created.id, version: 1,
        name: input.name ?? `${recipeVersion.name} (bản chụp)`,
        subjectId: recipeVersion.subjectId, grade: recipeVersion.grade, examKind: recipeVersion.examKind,
        totalScore: recipeVersion.totalScore, durationMinutes: recipeVersion.durationMinutes,
        tfScale: recipeVersion.tfScale, matrixId: recipeVersion.matrixId,
        matrixVersion: recipeVersion.matrixVersion, recipeSpec: spec, createdBy: actorId,
      }, tx);
      const resolved = [];
      for (const d of drawn) {
        const ready = await this.repo.resolveReadyVersion(d.questionId);
        if (!ready) {
          throw new BadRequestException({
            message: `Question ${d.questionId} has no ready version; only ready questions can enter a paper`,
            code: 'exam.slot_question_not_ready',
          });
        }
        resolved.push({
          paperVersionId: version.id, section: `Ô ${d.page}`,
          questionId: d.questionId, pinnedVersionId: ready.versionId, pinnedVersionNumber: ready.versionNumber,
          maxMark: d.maxMark, clusterId: d.clusterId, matrixCellId: d.matrixCellId,
        });
      }
      await this.repo.insertSlots(resolved.map((r, i) => ({ ...r, position: i + 1 })), tx);
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_materialized',
      payload: { paperId: created!.id, recipeId: recipe.id, matrixId: recipeVersion.matrixId, matrixVersion: recipeVersion.matrixVersion, actorId },
    });
    return this.paperView(actorId, created!);
  }

  /**
   * Đổi câu của một slot snapshot bằng SWAP-CÙNG-Ô: slot phải mang ô
   * nguồn (snapshot materialize từ recipe); câu thay phải thuộc pool
   * của chính ô đó (cùng YCCĐ + mức + dạng, bản ready) và chưa có
   * trong đề. Tạo paper version mới (các slot khác giữ nguyên, điểm
   * slot giữ nguyên) — version cũ + mọi lần triển khai trước bất biến.
   */
  async swapSlot(actorId: string, paperId: string, input: SwapExamPaperSlot): Promise<ExamPaperView> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanEditPaper(actorId, paper, bank);
    if (paper.kind === 'recipe') {
      throw new BadRequestException({
        message: 'A recipe paper cannot be edited directly; materialize it into a snapshot first',
        code: 'exam.recipe_not_editable',
      });
    }
    const current = await this.currentVersion(paper);
    const slots = await this.repo.listSlots(current.id);
    const slot = slots.find((s) => s.position === input.position);
    if (!slot) throw new NotFoundException({ message: `Paper slot ${input.position} not found`, code: 'exam.slot_not_found' });
    if (!slot.matrixCellId) {
      throw new BadRequestException({ message: 'This slot has no source matrix cell; same-cell swap only applies to slots materialized from a recipe', code: 'exam.swap_no_source_cell' });
    }
    if (slot.clusterId) {
      throw new BadRequestException({ message: 'A cluster member cannot be swapped on its own', code: 'exam.swap_cluster_member' });
    }
    if (!(await this.quiz.cellPoolContains(slot.matrixCellId, input.questionId))) {
      throw new BadRequestException({ message: 'The replacement question is not in the pool of this slot\'s matrix cell', code: 'exam.swap_candidate_out_of_cell' });
    }
    if (slots.some((s) => s.id !== slot.id && s.questionId === input.questionId)) {
      throw new BadRequestException({ message: 'The replacement question is already in this paper', code: 'exam.swap_candidate_duplicate' });
    }
    const ready = await this.repo.resolveReadyVersion(input.questionId);
    if (!ready) {
      throw new BadRequestException({
        message: `Question ${input.questionId} has no ready version; only ready questions can enter a paper`,
        code: 'exam.slot_question_not_ready',
      });
    }
    const next = paper.latestVersion + 1;
    await this.repo.dbHandle.transaction(async (tx) => {
      const version = await this.repo.insertVersion({
        paperId: paper.id, version: next, name: current.name,
        subjectId: current.subjectId, grade: current.grade, examKind: current.examKind,
        totalScore: current.totalScore, durationMinutes: current.durationMinutes,
        tfScale: current.tfScale, matrixId: current.matrixId,
        matrixVersion: current.matrixVersion, recipeSpec: current.recipeSpec ?? null, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(slots.map((s) => ({
        paperVersionId: version.id, position: s.position, section: s.section,
        questionId: s.id === slot.id ? input.questionId : s.questionId,
        pinnedVersionId: s.id === slot.id ? ready.versionId : s.pinnedVersionId,
        pinnedVersionNumber: s.id === slot.id ? ready.versionNumber : s.pinnedVersionNumber,
        maxMark: s.maxMark, clusterId: s.clusterId, matrixCellId: s.matrixCellId,
      })), tx);
      await this.repo.updatePaper(paper.id, { latestVersion: next }, tx);
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_slot_swapped',
      payload: { paperId: paper.id, position: input.position, questionId: input.questionId, cellId: slot.matrixCellId, actorId },
    });
    return this.paperView(actorId, (await this.repo.getPaper(paper.id))!);
  }

  // --- bản đặc tả theo đề (EB-3, E-6) -------------------------------------------------

  /**
   * Bản đặc tả neo theo ĐỀ (điểm E-6 của hồ sơ ngân hàng đề): đặc tả
   * sinh từ ma trận của paper version hiện tại, vị trí câu lấy từ
   * slots của chính đề (không phải từ quiz — quiz chỉ là một lần
   * triển khai của đề). Tham số `quizId` tuỳ chọn ghi nhận lần triển
   * khai cụ thể vào tài liệu; quiz phải thuộc chính đề này. Đề không
   * gắn ma trận → 400 `exam.spec_requires_matrix`. Nội dung qua cổng
   * A.3.4 + audit như mọi bề mặt nội dung đề.
   */
  async getPaperSpecification(actorId: string, paperId: string, quizId?: string): Promise<MatrixSpecification & { paper: { id: string; versionId: string; version: number; name: string } }> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanViewPaperContent(actorId, paper, bank);
    const version = await this.currentVersion(paper);
    if (!version.matrixId) {
      throw new BadRequestException({
        message: 'This paper is not built from a matrix; it has no specification grid',
        code: 'exam.spec_requires_matrix',
      });
    }
    let quizInfo: { id: string; name: string } | null = null;
    if (quizId) {
      const summary = await this.quiz.getQuizSummary(quizId);
      if (!summary || summary.paperId !== paper.id) {
        throw new BadRequestException({ message: 'The quiz was not deployed from this paper', code: 'quiz.spec_quiz_mismatch' });
      }
      quizInfo = { id: summary.id, name: summary.name };
    }
    const slots = await this.repo.listSlots(version.id);
    const spec = await this.quiz.buildSpecificationForPaper(actorId, version.matrixId, slots.map((s) => ({
      matrixCellId: s.matrixCellId, position: s.position, questionId: s.questionId,
    })));
    await this.auditPaperContentView(actorId, paper, bank, 'specification');
    return {
      ...spec,
      quiz: quizInfo ?? spec.quiz,
      paper: { id: paper.id, versionId: version.id, version: version.version, name: version.name },
    };
  }

  /** Xuất bản đặc tả theo đề ra xlsx/docx — cùng renderer với đặc tả theo ma trận (một view model, hai định dạng). */
  async exportPaperSpecification(actorId: string, paperId: string, format: string, quizId?: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    const spec = await this.getPaperSpecification(actorId, paperId, quizId);
    return this.quiz.renderSpecification(spec, format);
  }

  // --- in đề kèm mã đề (EB-2, E-5) ------------------------------------------------------

  /**
   * Bản in HTML của một đề SNAPSHOT theo một MÃ ĐỀ của một lần triển
   * khai: thứ tự câu hoán vị xác định bằng seed của mã (in lại cùng
   * mã cho cùng thứ tự — khớp bản chấm); đầu trang ghi rõ mã đề.
   * Recipe không in trực tiếp (in qua snapshot/lần triển khai).
   */
  async printPaperHtml(actorId: string, paperId: string, deploymentId: string, variantCode: string): Promise<string> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanViewPaperContent(actorId, paper, bank);
    await this.auditPaperContentView(actorId, paper, bank, 'print');
    if (paper.kind === 'recipe') {
      throw new BadRequestException({
        message: 'A recipe paper cannot be printed directly; materialize it into a snapshot first',
        code: 'exam.print_requires_snapshot',
      });
    }
    const deployment = await this.repo.getDeployment(deploymentId);
    if (!deployment || deployment.paperId !== paper.id) {
      throw new NotFoundException({ message: `Deployment ${deploymentId} not found for this paper`, code: 'exam.deployment_not_found' });
    }
    const variant = (deployment.variants ?? []).find((v) => v.code === variantCode);
    if (!variant) {
      throw new NotFoundException({ message: `Variant ${variantCode} not found in this deployment`, code: 'exam.variant_not_found' });
    }
    const version = await this.repo.getVersion(deployment.paperVersionId);
    if (!version) throw new NotFoundException({ message: 'Deployed paper version not found', code: 'exam.version_not_found' });
    const slots = await this.repo.listSlots(version.id);
    const views = await this.slotViews(slots);
    // Hoán vị Fisher–Yates theo seed của mã đề (mulberry32).
    let state = variant.seed >>> 0;
    const rand = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ordered = [...views];
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
    }
    const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = ordered.map((v, i) => `<tr><td>${i + 1}</td><td>${esc(v.questionName ?? v.questionId)}</td><td>${esc(v.qtype ?? '')}</td><td>${v.maxMark}</td></tr>`).join('');
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(version.name)} — Mã đề ${esc(variant.code)}</title></head><body><h1>${esc(version.name)}</h1><p><strong>Mã đề: ${esc(variant.code)}</strong> · Tổng điểm: ${version.totalScore}${version.durationMinutes ? ` · Thời gian: ${version.durationMinutes} phút` : ''}</p><table border="1" cellspacing="0" cellpadding="6"><thead><tr><th>STT</th><th>Câu hỏi</th><th>Dạng</th><th>Điểm</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  }
}
