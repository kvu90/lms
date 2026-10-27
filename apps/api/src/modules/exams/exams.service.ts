import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ApproveExamContribution, CopyExam, CreateExam, CreateExamContribution,
  CreateExamPin, ExamSlotInput, GenerateFromMatrix, QuizView,
  RejectExamContribution, SetExamSlots, SetExamStatus, SwapExamSlot, UpdateExam,
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
  ExamsRepository,
  type ExamContributionRow, type ExamRow, type ExamSlotRow, type ExamVersionRow,
} from './exams.repository';
import type { ExamMatrixCellRow } from '../quiz/quiz.repository';

/**
 * Bộ capability của lớp ngân hàng đề — mọi cổng đều đánh giá TẠI
 * context của bank đề (một nguồn quyền duy nhất là bank). Tên đã
 * chuẩn hoá về khuôn use/add/edit/copy/share/moderate ở đợt đồng bộ
 * khuôn ngân hàng (issue #228, lát S3): `view` giữ làm khoá nội bộ
 * nhưng capability thật là `exam:use` (bản đồ tên cũ exam:view đã bỏ
 * hẳn khỏi registry); `add` gác mọi đường TẠO đề mới (tạo tay, sinh
 * từ ma trận, copy vào bank đích), `edit` chỉ còn gác sửa đề đã có.
 */
export const EXAM_CAPABILITIES = {
  view: 'exam:use',
  add: 'exam:add',
  edit: 'exam:edit',
  copy: 'exam:copy',
  share: 'exam:share',
  moderate: 'exam:moderate',
  deploy: 'exam:deploy',
} as const;

/** Các loại đề thuộc diện ĐỊNH KỲ/THI THỬ — nội dung ready của chúng tại bank trường là tài liệu mật theo nghĩa nghiệp vụ (lớp bảo mật A.3.4, EB-3). */
export const PERIODIC_EXAM_KINDS = ['midterm', 'final', 'mock'] as const;

/** exam:* cấp cho hai vai bank dùng chung tại context của MỖI bank đề: thành viên = xem + copy; chủ/tổ trưởng = toàn bộ (gồm cả exam:add). */
const MEMBER_EXAM_CAPS = [EXAM_CAPABILITIES.view, EXAM_CAPABILITIES.copy];
const LEAD_EXAM_CAPS = [
  EXAM_CAPABILITIES.view, EXAM_CAPABILITIES.add, EXAM_CAPABILITIES.edit, EXAM_CAPABILITIES.copy,
  EXAM_CAPABILITIES.share, EXAM_CAPABILITIES.moderate, EXAM_CAPABILITIES.deploy,
];

export interface ExamCapabilitiesView {
  view: boolean; add: boolean; edit: boolean; copy: boolean; share: boolean; moderate: boolean; deploy: boolean;
}

export interface ExamSlotView {
  position: number;
  section: string;
  questionId: string;
  questionName: string | null;
  qtype: string | null;
  /** Trạng thái entry hiện tại của câu trong ngân hàng câu hỏi (đề đã chụp vẫn đọc được kể cả khi câu bị rút). */
  entryStatus: string | null;
  pinnedVersionId: string | null;
  pinnedVersionNumber: number | null;
  /** Số version ready MỚI NHẤT của câu trong ngân hàng (null khi câu chưa có bản ready nào). */
  latestReadyVersionNumber: number | null;
  /**
   * Huy hiệu "có bản ready mới" ở bề mặt soạn đề (issue #254): slot đang
   * ghim version cũ hơn bản ready mới nhất của câu — giáo viên thấy được
   * ngay trong lúc soạn; cập nhật vẫn là thao tác tường minh (sửa đề tạo
   * version mới của đề, hoặc cập nhật pin ở cấp lần ghim), không tự trôi.
   */
  hasNewerVersion: boolean;
  maxMark: number;
  clusterId: string | null;
  /** Ô ma trận nguồn (chỉ ở snapshot materialize từ recipe — neo swap-cùng-ô). */
  matrixCellId: string | null;
}



export interface ExamView {
  paper: {
    id: string; bankId: string; kind: string; status: string;
    derivedFromExamId: string | null; derivedFromMatrixId: string | null;
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
  slots: ExamSlotView[];
  /**
   * Truy vết nguồn gốc cho UI hiển thị ghi công (null với đề gốc tự
   * soạn): bank nguồn và số version của đề nguồn GHI TẠI LÚC COPY
   * (không suy lại từ đề nguồn hiện tại — đề nguồn có thể đã chuyển
   * bank hoặc có thêm version sau đó).
   */
  attribution: { derivedFromExamId: string; originalAuthorId: string | null; sourceBankId: string; derivedFromVersionNumber: number | null } | null;
  capabilities: ExamCapabilitiesView;
}

export interface ExamPinSummary {
  id: string; courseId: string; courseName: string;
  examVersionId: string; versionNumber: number;
  name: string | null; variantCount: number; variantCodes: string[]; targetGroupId: string | null;
  createdAt: string;
}

export interface ExamSummary {
  id: string; bankId: string; kind: string; status: string;
  name: string; examKind: string | null; grade: number | null; subjectId: string | null;
  slotCount: number; totalScore: number; durationMinutes: number | null;
  latestVersion: number; createdBy: string;
  originalAuthorId: string | null; derivedFromExamId: string | null;
  copyCount: number; updatedAt: string;
  capabilities: ExamCapabilitiesView;
}

export interface ExamContributionView extends ExamContributionRow {
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
export class ExamsService {
  constructor(
    private readonly repo: ExamsRepository,
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

  async bankOfPaper(paper: ExamRow): Promise<QuestionBankRow> {
    const bank = await this.banks.getBankOrThrow(paper.bankId);
    await this.ensureExamGrants(bank);
    return bank;
  }

  private async capabilitiesAt(actorId: string, bank: QuestionBankRow): Promise<ExamCapabilitiesView> {
    const at = (cap: string) => this.evaluator.hasCapability(actorId, cap, bank.contextId);
    const [view, add, edit, copy, share, moderate, deploy] = await Promise.all([
      at(EXAM_CAPABILITIES.view), at(EXAM_CAPABILITIES.add), at(EXAM_CAPABILITIES.edit), at(EXAM_CAPABILITIES.copy),
      at(EXAM_CAPABILITIES.share), at(EXAM_CAPABILITIES.moderate), at(EXAM_CAPABILITIES.deploy),
    ]);
    return { view, add, edit, copy, share, moderate, deploy };
  }

  /** Đề ở trạng thái ready thì người có exam:use thấy; draft/hidden chỉ tác giả hoặc người duyệt của bank thấy. */
  private async assertCanViewPaper(actorId: string, paper: ExamRow, bank: QuestionBankRow): Promise<void> {
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
  private async periodicSchoolVersion(paper: ExamRow, bank: QuestionBankRow): Promise<ExamVersionRow | null> {
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
  async assertCanViewPaperContent(actorId: string, paper: ExamRow, bank: QuestionBankRow): Promise<void> {
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
  async auditPaperContentView(actorId: string, paper: ExamRow, bank: QuestionBankRow, surface: string): Promise<void> {
    const version = await this.periodicSchoolVersion(paper, bank);
    if (!version) return;
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_content_viewed',
      payload: {
        examId: paper.id, examVersionId: version.id, paperVersion: version.version,
        bankId: bank.id, examKind: version.examKind, grade: version.grade, surface, actorId,
      },
    });
  }

  /** Cổng sửa/xoá đề: có exam:edit tại bank VÀ (là tác giả HOẶC có exam:moderate) — GV khác chỉ xem/copy, không sửa đề cá nhân của người khác. */
  async assertCanEditPaper(actorId: string, paper: ExamRow, bank: QuestionBankRow): Promise<void> {
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

  async getPaperOrThrow(id: string): Promise<ExamRow> {
    const paper = await this.repo.getPaper(id);
    if (!paper) throw new NotFoundException({ message: `Exam paper ${id} not found`, code: 'exam.not_found' });
    return paper;
  }

  async currentVersion(paper: ExamRow): Promise<ExamVersionRow> {
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
  private async resolveSlots(slots: ExamSlotInput[]): Promise<{
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
        // Không ghi điểm cho slot = lấy điểm mặc định của phiên bản
        // câu hỏi đã ghim (khuôn quiz cũ: điểm slot thắng khi ghi rõ).
        maxMark: s.maxMark ?? ready.defaultMark,
        section: s.section ?? '',
        clusterId: null,
      });
    }
    return resolved;
  }

  /** Hash cấu trúc của một paper version (chống trùng đóng góp/copy): tên + danh sách question@pinnedVersion:điểm đã sắp theo vị trí. */
  private paperContentHash(version: ExamVersionRow, slots: ExamSlotRow[]): string {
    const body = slots
      .map((s) => `${s.questionId}@${s.pinnedVersionNumber ?? 0}:${s.maxMark}`)
      .join('|');
    return createHash('sha256').update(`${version.name}::${body}`).digest('hex');
  }

  // --- view -------------------------------------------------------------------

  private async slotViews(slots: ExamSlotRow[]): Promise<ExamSlotView[]> {
    const questionIds = [...new Set(slots.map((s) => s.questionId))];
    const [infos, statuses] = await Promise.all([
      this.repo.listSlotQuestionInfo(questionIds),
      this.repo.listQuestionEntryStatuses(questionIds),
    ]);
    const infoById = new Map(infos.map((i) => [i.questionId, i]));
    const statusById = new Map(statuses.map((s) => [s.questionId, s.status]));
    // Bản ready mới nhất của từng câu (cho huy hiệu "có bản ready mới"
    // ở bề mặt soạn đề, issue #254) — tra qua QuestionBanksService như
    // bề mặt quiz vẫn làm cho cùng một dữ kiện.
    const latestReadyById = new Map<string, number | null>();
    for (const questionId of questionIds) {
      const bankInfo = await this.banks.getQuestionBankInfo(questionId).catch(() => null);
      latestReadyById.set(questionId, bankInfo?.latestReadyVersionNumber ?? null);
    }
    return slots.map((s) => {
      const latestReadyVersionNumber = latestReadyById.get(s.questionId) ?? null;
      return {
        position: s.position,
        section: s.section,
        questionId: s.questionId,
        questionName: infoById.get(s.questionId)?.name ?? null,
        qtype: infoById.get(s.questionId)?.qtype ?? null,
        entryStatus: statusById.get(s.questionId) ?? null,
        pinnedVersionId: s.pinnedVersionId,
        pinnedVersionNumber: s.pinnedVersionNumber,
        latestReadyVersionNumber,
        hasNewerVersion: s.pinnedVersionNumber !== null
          && latestReadyVersionNumber !== null
          && latestReadyVersionNumber > s.pinnedVersionNumber,
        maxMark: s.maxMark,
        clusterId: s.clusterId,
        matrixCellId: s.matrixCellId,
      };
    });
  }

  async paperView(actorId: string, paper: ExamRow): Promise<ExamView> {
    const bank = await this.bankOfPaper(paper);
    const version = await this.currentVersion(paper);
    const slots = await this.repo.listSlots(version.id);
    const caps = await this.capabilitiesAt(actorId, bank);
    const canEdit = caps.edit && (paper.createdBy === actorId || caps.moderate);
    let attribution: ExamView['attribution'] = null;
    if (paper.derivedFromExamId) {
      const source = await this.repo.getPaper(paper.derivedFromExamId);
      attribution = {
        derivedFromExamId: paper.derivedFromExamId,
        originalAuthorId: paper.originalAuthorId,
        // Ưu tiên bank nguồn đã ghi tại lúc copy; chỉ bản copy cũ
        // (chưa có cột ghi) mới suy từ bank hiện tại của đề nguồn.
        sourceBankId: paper.derivedFromBankId ?? source?.bankId ?? paper.bankId,
        derivedFromVersionNumber: paper.derivedFromVersionNumber,
      };
    }
    return {
      paper: {
        id: paper.id, bankId: paper.bankId, kind: paper.kind, status: paper.status,
        derivedFromExamId: paper.derivedFromExamId, derivedFromMatrixId: paper.derivedFromMatrixId,
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
  async listPapers(actorId: string, bankId: string): Promise<ExamSummary[]> {
    const bank = await this.getExamBank(actorId, bankId);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.view, bank.contextId);
    const caps = await this.capabilitiesAt(actorId, bank);
    const isAdmin = await this.evaluator.isSiteAdmin(actorId);
    const papers = await this.repo.listPapersInBank(bank.id);
    const summaries: ExamSummary[] = [];
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
        originalAuthorId: paper.originalAuthorId, derivedFromExamId: paper.derivedFromExamId,
        copyCount: paper.copyCount, updatedAt: paper.updatedAt.toISOString(),
        capabilities: { ...caps, edit: caps.edit && (paper.createdBy === actorId || caps.moderate) },
      });
    }
    return summaries;
  }

  /** Chi tiết một đề: version hiện tại + slots đã ghim + truy vết + khả năng của actor. Nội dung đề qua cổng A.3.4 (EB-3) và ghi audit khi thuộc diện định kỳ ở bank trường. */
  async getPaper(actorId: string, paperId: string): Promise<ExamView> {
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

  /** Các lần ghim của một đề — thay danh sách deployments cũ; cổng xem cùng cổng chi tiết đề. */
  async listPins(actorId: string, paperId: string): Promise<ExamPinSummary[]> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanViewPaperContent(actorId, paper, bank);
    const rows = await this.repo.listPinsOfExam(paperId);
    return rows.map((r) => ({
      id: r.id, courseId: r.courseId, courseName: r.courseName,
      examVersionId: r.examVersionId, versionNumber: r.versionNumber,
      name: r.name, variantCount: r.variantCount, variantCodes: (r.variants ?? []).map((v) => v.code),
      targetGroupId: r.targetGroupId, createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Tạo đề snapshot mới trong bank đề (metadata + slots tuỳ chọn; rỗng = đề trắng để soạn tiếp). Cổng tạo là exam:add (khuôn S3) — exam:edit chỉ gác sửa đề đã có. */
  async createPaper(actorId: string, bankId: string, input: CreateExam): Promise<ExamView> {
    const bank = await this.getExamBank(actorId, bankId);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.add, bank.contextId);
    const slots = await this.resolveSlots(input.slots ?? []);
    let paper: ExamRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      paper = await this.repo.insertPaper({
        tenantId: bank.tenantId, bankId: bank.id, kind: 'snapshot', status: 'draft', createdBy: actorId, latestVersion: 1,
        derivedFromMatrixId: input.matrixId ?? null,
      }, tx);
      const version = await this.repo.insertVersion({
        examId: paper.id, version: 1, name: input.name,
        subjectId: input.subjectId ?? null, grade: input.grade ?? null,
        examKind: input.examKind ?? null, totalScore: input.totalScore ?? 10,
        durationMinutes: input.durationMinutes ?? null, tfScale: input.tfScale ?? null,
        matrixId: input.matrixId ?? null, matrixVersion: null, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(slots.map((s, i) => ({ examVersionId: version.id, position: i + 1, ...s })), tx);
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
  async updatePaper(actorId: string, paperId: string, input: UpdateExam): Promise<ExamView> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanEditPaper(actorId, paper, bank);
    const current = await this.currentVersion(paper);
    const currentSlots = await this.repo.listSlots(current.id);
    const next = paper.latestVersion + 1;
    await this.repo.dbHandle.transaction(async (tx) => {
      const version = await this.repo.insertVersion({
        examId: paper.id, version: next,
        name: input.name ?? current.name,
        subjectId: input.subjectId !== undefined ? input.subjectId : current.subjectId,
        grade: input.grade !== undefined ? input.grade : current.grade,
        examKind: input.examKind !== undefined ? input.examKind : current.examKind,
        totalScore: input.totalScore ?? current.totalScore,
        durationMinutes: input.durationMinutes !== undefined ? input.durationMinutes : current.durationMinutes,
        tfScale: input.tfScale !== undefined ? input.tfScale : current.tfScale,
        matrixId: input.matrixId !== undefined ? input.matrixId : current.matrixId,
        matrixVersion: current.matrixVersion,
        matrixVersionId: input.matrixId !== undefined && input.matrixId !== current.matrixId ? null : current.matrixVersionId,
        createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(currentSlots.map((s) => ({
        examVersionId: version.id, position: s.position, section: s.section,
        questionId: s.questionId, pinnedVersionId: s.pinnedVersionId,
        pinnedVersionNumber: s.pinnedVersionNumber, maxMark: s.maxMark, clusterId: s.clusterId,
        matrixCellId: s.matrixCellId,
      })), tx);
      await this.repo.updatePaper(paper.id, { latestVersion: next }, tx);
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_updated',
      payload: { examId: paper.id, bankId: bank.id, version: next, actorId },
    });
    return this.paperView(actorId, (await this.repo.getPaper(paper.id))!);
  }

  /** Thay toàn bộ slots của đề = tạo paper version mới với đúng danh sách slot đã ghim. */
  async setSlots(actorId: string, paperId: string, input: SetExamSlots): Promise<ExamView> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanEditPaper(actorId, paper, bank);
    const current = await this.currentVersion(paper);
    const slots = await this.resolveSlots(input.slots);
    const next = paper.latestVersion + 1;
    await this.repo.dbHandle.transaction(async (tx) => {
      const version = await this.repo.insertVersion({
        examId: paper.id, version: next, name: current.name,
        subjectId: current.subjectId, grade: current.grade, examKind: current.examKind,
        totalScore: current.totalScore, durationMinutes: current.durationMinutes,
        tfScale: current.tfScale, matrixId: current.matrixId,
        matrixVersion: current.matrixVersion, matrixVersionId: current.matrixVersionId, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(slots.map((s, i) => ({ examVersionId: version.id, position: i + 1, ...s })), tx);
      await this.repo.updatePaper(paper.id, { latestVersion: next }, tx);
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_slots_set',
      payload: { examId: paper.id, bankId: bank.id, version: next, slotCount: slots.length, actorId },
    });
    return this.paperView(actorId, (await this.repo.getPaper(paper.id))!);
  }

  /**
   * Đổi trạng thái vòng đời: draft → ready (bắt buộc có ít nhất 1
   * slot); mọi trạng thái → hidden (rút khỏi ngân hàng — quiz đã
   * triển khai không vỡ vì đã chụp slots riêng); hidden → ready/draft
   * (khôi phục). Chỉ tác giả hoặc người duyệt.
   */
  async setStatus(actorId: string, paperId: string, input: SetExamStatus): Promise<ExamView> {
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
      payload: { examId: paper.id, bankId: bank.id, status: input.status, actorId },
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
      payload: { examId: paper.id, bankId: bank.id, actorId },
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
  async copyPaper(actorId: string, paperId: string, input: CopyExam): Promise<ExamView> {
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
    // Ghi một đề MỚI vào bank đích = cổng tạo exam:add tại bank đích
    // (khuôn S3); quyền sửa đề đã có (exam:edit) không thay cho cổng tạo.
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.add, target.contextId);

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
  private async deepCopyInto(actorId: string, source: ExamRow, target: QuestionBankRow, nameOverride?: string): Promise<ExamRow> {
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
  async copyPaperVersionIntoBank(actorId: string, source: ExamRow, sourceVersion: ExamVersionRow, target: QuestionBankRow, opts?: { name?: string; status?: string }): Promise<ExamRow> {
    const sourceSlots = await this.repo.listSlots(sourceVersion.id);
    let created: ExamRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      created = await this.repo.insertPaper({
        tenantId: target.tenantId, bankId: target.id, kind: source.kind, status: opts?.status ?? 'draft',
        derivedFromExamId: source.id,
        derivedFromMatrixId: sourceVersion.matrixId,
        originalAuthorId: source.originalAuthorId ?? source.createdBy,
        // Ghi bank nguồn + số version của đề nguồn TẠI LÚC COPY —
        // truy vết không phụ thuộc trạng thái của đề nguồn về sau.
        derivedFromBankId: source.bankId,
        derivedFromVersionNumber: sourceVersion.version,
        createdBy: actorId, latestVersion: 1,
      }, tx);
      const version = await this.repo.insertVersion({
        examId: created.id, version: 1, name: opts?.name ?? sourceVersion.name,
        subjectId: sourceVersion.subjectId, grade: sourceVersion.grade, examKind: sourceVersion.examKind,
        totalScore: sourceVersion.totalScore, durationMinutes: sourceVersion.durationMinutes,
        tfScale: sourceVersion.tfScale, matrixId: sourceVersion.matrixId,
        matrixVersion: sourceVersion.matrixVersion, matrixVersionId: sourceVersion.matrixVersionId, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(sourceSlots.map((s) => ({
        examVersionId: version.id, position: s.position, section: s.section,
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
  async proposeContribution(actorId: string, targetBankId: string, input: CreateExamContribution): Promise<ExamContributionRow> {
    const target = await this.getExamBank(actorId, targetBankId);
    if (target.scope === 'personal') {
      throw new BadRequestException({ message: 'Cannot contribute into a personal bank', code: 'exam.contribution_target_personal' });
    }
    const paper = await this.getPaperOrThrow(input.examId);
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
      examId: paper.id, targetBankId: target.id, proposerId: actorId,
      note: input.note ?? '', contentHash: hash, nearDuplicateOf,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_contribution_proposed',
      payload: { contributionId: row.id, targetBankId: target.id, examId: paper.id, proposerId: actorId, nearDuplicateOf },
    });
    return row;
  }

  /** Hàng chờ đóng góp của một bank đề: người duyệt (exam:moderate tại bank đích) thấy tất cả; người khác chỉ thấy đề xuất của mình (như QB-4). */
  async listContributions(actorId: string, bankId: string): Promise<ExamContributionView[]> {
    const bank = await this.getExamBank(actorId, bankId);
    const canModerate = await this.evaluator.hasCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId);
    const all = await this.repo.listContributionsForBank(bank.id);
    const rows = canModerate ? all : all.filter((r) => r.proposerId === actorId);
    const views: ExamContributionView[] = [];
    for (const row of rows) {
      const paper = await this.repo.getPaper(row.examId);
      views.push({ ...row, paperName: paper ? (await this.currentVersion(paper)).name : null, sourceBankId: paper?.bankId ?? null });
    }
    return views;
  }

  private async getContributionForBank(bankId: string, contributionId: string): Promise<ExamContributionRow> {
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
  async approveContribution(actorId: string, bankId: string, contributionId: string, _input: ApproveExamContribution): Promise<ExamContributionRow> {
    const bank = await this.getExamBank(actorId, bankId);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.moderate, bank.contextId);
    const contribution = await this.getContributionForBank(bank.id, contributionId);
    if (contribution.status !== 'pending') {
      throw new ConflictException({ message: 'Contribution is no longer pending', code: 'exam.contribution_not_pending' });
    }
    const source = await this.getPaperOrThrow(contribution.examId);
    const inTarget = await this.repo.listPapersInBank(bank.id);
    if (inTarget.some((p) => p.derivedFromExamId === source.id)) {
      throw new ConflictException({
        message: `An identical paper already exists in the target bank (copied from ${source.id})`,
        code: 'exam.duplicate_in_bank',
      });
    }
    const copied = await this.deepCopyInto(actorId, source, bank);
    await this.repo.updateContribution(contribution.id, {
      status: 'approved', reviewerId: actorId, resultExamId: copied.id,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_contribution_approved',
      payload: {
        contributionId: contribution.id, targetBankId: bank.id, paperId: source.id,
        resultExamId: copied.id, reviewerId: actorId, proposerId: contribution.proposerId,
      },
    });
    return (await this.repo.getContribution(contribution.id))!;
  }

  /** Từ chối một đề xuất: lý do bắt buộc để giáo viên sửa và đề xuất lại. */
  async rejectContribution(actorId: string, bankId: string, contributionId: string, input: RejectExamContribution): Promise<ExamContributionRow> {
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
        contributionId: contribution.id, targetBankId: bank.id, paperId: contribution.examId,
        reviewerId: actorId, proposerId: contribution.proposerId, reason: input.reason,
      },
    });
    return (await this.repo.getContribution(contribution.id))!;
  }

  // --- mã đề ở tầng triển khai (EB-2, E-5) ---------------------------------------

  // --- ghim đề vào khoá (thực thể hợp nhất) ---------------------------------------

  /**
   * Ghim một đề READY vào một khoá — thao tác DUY NHẤT thay deploy +
   * tạo quiz trước đây: cổng exam:deploy tại bank của đề + đề phải
   * ready (draft chưa chốt, hidden đã rút — đều không ghim mới được;
   * pin đã ghim từ trước không bị ảnh hưởng khi đề chuyển hidden).
   * Dạng `newExam`: tạo đề trong bank đề CÁ NHÂN của giáo viên rồi
   * ghim ngay version vừa tạo (đề còn draft, GV soạn tiếp sau) —
   * đúng một thao tác cho GV từ course builder.
   * Bản ghi pin + course module + grade item do
   * QuizService.createPinRecord lo.
   */
  async createPin(actorId: string, courseId: string, input: CreateExamPin): Promise<QuizView> {
    let examId = input.examId;
    let examVersionId = input.examVersionId;
    if (input.newExam) {
      if (examId) {
        throw new BadRequestException({ message: 'Provide either examId or newExam, not both', code: 'exam.pin_source_ambiguous' });
      }
      const bankRow = await this.banks.ensurePersonalBank(actorId, 'exam');
      await this.ensureExamGrants(bankRow);
      const created = await this.createPaper(actorId, bankRow.id, input.newExam);
      examId = created.paper.id;
      examVersionId = created.version.id;
      // Đề mới tạo giữ trạng thái draft và ghim ngay ở version vừa
      // tạo: đây là đề CỦA CHÍNH giáo viên trong khoá của mình (luồng
      // "tạo bài trong khoá" từ course builder) — cổng ready chỉ áp
      // cho đường ghim examId có sẵn bên dưới. GV soạn tiếp trong
      // trình soạn đề rồi nâng version của pin; học sinh chưa làm
      // được khi đề chưa có câu (cổng no_questions ở attempt).
    }
    if (!examId) {
      throw new BadRequestException({ message: 'An exam pin needs either examId or newExam', code: 'exam.pin_source_required' });
    }
    const paper = await this.getPaperOrThrow(examId);
    const bank = await this.bankOfPaper(paper);
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.deploy, bank.contextId);
    if (!input.newExam && paper.status !== 'ready') {
      throw new BadRequestException({
        message: `Only a ready exam can be pinned (current status: ${paper.status})`,
        code: 'exam.pin_requires_ready',
      });
    }
    const version = examVersionId ? await this.repo.getVersion(examVersionId) : await this.currentVersion(paper);
    if (!version || version.examId !== paper.id) {
      throw new NotFoundException({ message: `Exam version ${examVersionId} not found for exam ${paper.id}`, code: 'exam.version_not_found' });
    }
    return this.quiz.createPinRecord(actorId, courseId, {
      sectionId: input.sectionId, examId: paper.id, examVersionId: version.id,
      name: input.name, intro: input.intro,
      timeOpen: input.timeOpen, timeClose: input.timeClose, timeLimitSeconds: input.timeLimitSeconds,
      attemptsAllowed: input.attemptsAllowed, gradeMethod: input.gradeMethod, shuffleAnswers: input.shuffleAnswers,
      password: input.password, subnet: input.subnet,
      reviewAttempt: input.reviewAttempt, reviewCorrectness: input.reviewCorrectness,
      reviewMarks: input.reviewMarks, reviewSpecificFeedback: input.reviewSpecificFeedback,
      reviewGeneralFeedback: input.reviewGeneralFeedback, reviewRightAnswer: input.reviewRightAnswer,
      reviewOverallFeedback: input.reviewOverallFeedback,
      preset: input.preset, lateEntryMinutes: input.lateEntryMinutes, monitorEvents: input.monitorEvents,
      variantCount: input.variantCount,
      versionMode: input.versionMode,
      targetGroupId: input.targetGroupId ?? null,
    });
  }

  /**
   * Sinh đề từ ma trận — HAI BƯỚC về mặt dữ liệu, MỘT thao tác cho
   * giáo viên: (1) rút MỘT bộ câu cố định từ ngân hàng theo các ô
   * của ma trận và tạo đề snapshot trong ngân hàng đề CÁ NHÂN của
   * người sinh (bộ câu ghim cứng thành slots của exam version — bỏ
   * hẳn dạng recipe/per_student, chốt 26/10), trạng thái ready;
   * (2) ghim đề đó vào khoá qua exam-pins. Trả QuizView của pin +
   * examId (truy vết chính), matrix_id là truy vết phụ.
   */
  async generateFromMatrix(actorId: string, matrixId: string, input: GenerateFromMatrix): Promise<QuizView & { examId: string; matrixId: string }> {
    const { matrix, cells } = await this.quiz.matrixForGeneration(actorId, matrixId);
    const cellScale = cells.find((c) => c.tfScale !== null)?.tfScale ?? null;
    // Rút bộ câu cố định MỘT LẦN ngay lúc sinh đề: thiếu câu ở bất
    // kỳ ô nào là lỗi cứng 422 và không để lại đề/pin rác.
    const drawn = await this.quiz.drawFixedSlots(actorId, cells);

    const bankRow = await this.banks.ensurePersonalBank(actorId, 'exam');
    await this.ensureExamGrants(bankRow);
    // Sinh đề là TẠO một đề mới trong bank cá nhân → cổng exam:add (khuôn S3).
    await this.evaluator.requireCapability(actorId, EXAM_CAPABILITIES.add, bankRow.contextId);

    // Ghim version ready cho từng câu đã rút (đúng kỷ luật ghim của
    // đề: version tại thời điểm chụp) — phân giải trước khi ghi.
    const drawnPinned = await Promise.all(drawn.map(async (d) => {
      const ready = await this.repo.resolveReadyVersion(d.questionId);
      if (!ready) {
        throw new BadRequestException({
          message: `Question ${d.questionId} has no ready version; only ready questions can enter a paper`,
          code: 'exam.slot_question_not_ready',
        });
      }
      return { ...d, pinnedVersionId: ready.versionId, pinnedVersionNumber: ready.versionNumber };
    }));
    let paper: ExamRow | undefined;
    await this.repo.dbHandle.transaction(async (tx) => {
      paper = await this.repo.insertPaper({
        tenantId: bankRow.tenantId, bankId: bankRow.id,
        kind: 'snapshot',
        status: 'ready', createdBy: actorId, latestVersion: 1,
        derivedFromMatrixId: matrix.id,
      }, tx);
      // Neo FK tới đúng version bất biến của ma trận tại thời điểm
      // sinh đề: đề đọc lại được nội dung ma trận gốc dù ma trận có
      // version mới về sau.
      const matrixVersionId = await this.repo.getMatrixVersionRowId(matrix.id, matrix.version, tx);
      const version = await this.repo.insertVersion({
        examId: paper.id, version: 1, name: input.name,
        subjectId: matrix.subjectId, grade: null, examKind: null,
        totalScore: matrix.totalScore, durationMinutes: null, tfScale: cellScale,
        matrixId: matrix.id, matrixVersion: matrix.version, matrixVersionId,
        createdBy: actorId,
      }, tx);
      if (drawnPinned) {
        // Snapshot sinh từ ma trận: slot ghi matrixCellId nguồn để
        // báo cáo tỉ lệ theo ô đối chiếu được với ma trận.
        await this.repo.insertSlots(drawnPinned.map((d, i) => ({
          examVersionId: version.id, position: i + 1,
          section: `Ô ${d.page}`,
          questionId: d.questionId,
          pinnedVersionId: d.pinnedVersionId, pinnedVersionNumber: d.pinnedVersionNumber,
          maxMark: d.maxMark, clusterId: null, matrixCellId: d.matrixCellId,
        })), tx);
      }
    });
    const totalMinutes = cells.reduce((sum, c) => sum + (c.minutes ?? 0), 0);
    const timeLimitSeconds = input.timeLimitSeconds !== undefined && input.timeLimitSeconds !== null
      ? input.timeLimitSeconds
      : (totalMinutes > 0 ? totalMinutes * 60 : null);
    const pin = await this.createPin(actorId, input.courseId, {
      sectionId: input.sectionId, examId: paper!.id, name: input.name, timeLimitSeconds,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_generated_from_matrix',
      payload: { paperId: paper!.id, matrixId: matrix.id, matrixVersion: matrix.version, pinId: pin.id, actorId },
    });
    return { ...pin, examId: paper!.id, matrixId: matrix.id };
  }

  // --- materialize + swap-cùng-ô (EB-2, D.3) ------------------------------------------

  /**
   * Đổi câu của một slot snapshot bằng SWAP-CÙNG-Ô: slot phải mang ô
   * nguồn (snapshot materialize từ recipe); câu thay phải thuộc pool
   * của chính ô đó (cùng YCCĐ + mức + dạng, bản ready) và chưa có
   * trong đề. Tạo paper version mới (các slot khác giữ nguyên, điểm
   * slot giữ nguyên) — version cũ + mọi lần triển khai trước bất biến.
   */
  async swapSlot(actorId: string, paperId: string, input: SwapExamSlot): Promise<ExamView> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanEditPaper(actorId, paper, bank);
    const current = await this.currentVersion(paper);
    const slots = await this.repo.listSlots(current.id);
    const slot = slots.find((s) => s.position === input.position);
    if (!slot) throw new NotFoundException({ message: `Paper slot ${input.position} not found`, code: 'exam.slot_not_found' });
    if (!slot.matrixCellId) {
      throw new BadRequestException({ message: 'This slot has no source matrix cell; same-cell swap only applies to slots generated from a matrix', code: 'exam.swap_no_source_cell' });
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
        examId: paper.id, version: next, name: current.name,
        subjectId: current.subjectId, grade: current.grade, examKind: current.examKind,
        totalScore: current.totalScore, durationMinutes: current.durationMinutes,
        tfScale: current.tfScale, matrixId: current.matrixId,
        matrixVersion: current.matrixVersion, matrixVersionId: current.matrixVersionId, createdBy: actorId,
      }, tx);
      await this.repo.insertSlots(slots.map((s) => ({
        examVersionId: version.id, position: s.position, section: s.section,
        questionId: s.id === slot.id ? input.questionId : s.questionId,
        pinnedVersionId: s.id === slot.id ? ready.versionId : s.pinnedVersionId,
        pinnedVersionNumber: s.id === slot.id ? ready.versionNumber : s.pinnedVersionNumber,
        maxMark: s.maxMark, clusterId: s.clusterId, matrixCellId: s.matrixCellId,
      })), tx);
      await this.repo.updatePaper(paper.id, { latestVersion: next }, tx);
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'exam_paper', type: 'exam_paper_slot_swapped',
      payload: { examId: paper.id, position: input.position, questionId: input.questionId, cellId: slot.matrixCellId, actorId },
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
  async getPaperSpecification(actorId: string, paperId: string, pinId?: string): Promise<MatrixSpecification & { paper: { id: string; versionId: string; version: number; name: string } }> {
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
    let pinInfo: { id: string; name: string } | null = null;
    if (pinId) {
      const summary = await this.quiz.getPinSummary(pinId);
      if (!summary || summary.examId !== paper.id) {
        throw new BadRequestException({ message: 'The quiz was not deployed from this paper', code: 'exam.spec_pin_mismatch' });
      }
      pinInfo = { id: summary.id, name: summary.name };
    }
    const slots = await this.repo.listSlots(version.id);
    const spec = await this.quiz.buildSpecificationForPaper(actorId, version.matrixId, slots.map((s) => ({
      matrixCellId: s.matrixCellId, position: s.position, questionId: s.questionId,
    })));
    await this.auditPaperContentView(actorId, paper, bank, 'specification');
    return {
      ...spec,
      quiz: pinInfo ?? spec.quiz,
      paper: { id: paper.id, versionId: version.id, version: version.version, name: version.name },
    };
  }

  /** Xuất bản đặc tả theo đề ra xlsx/docx — cùng renderer với đặc tả theo ma trận (một view model, hai định dạng). */
  async exportPaperSpecification(actorId: string, paperId: string, format: string, pinId?: string): Promise<{ filename: string; contentType: string; buffer: Buffer }> {
    const spec = await this.getPaperSpecification(actorId, paperId, pinId);
    return this.quiz.renderSpecification(spec, format);
  }

  // --- in đề kèm mã đề (EB-2, E-5) ------------------------------------------------------

  /**
   * Bản in HTML của một đề SNAPSHOT theo một MÃ ĐỀ của một lần triển
   * khai: thứ tự câu hoán vị xác định bằng seed của mã (in lại cùng
   * mã cho cùng thứ tự — khớp bản chấm); đầu trang ghi rõ mã đề.
   * In theo slots của exam version đã ghim trên pin.
   */
  async printPaperHtml(actorId: string, paperId: string, pinId: string, variantCode: string): Promise<string> {
    const paper = await this.getPaperOrThrow(paperId);
    const bank = await this.bankOfPaper(paper);
    await this.assertCanViewPaperContent(actorId, paper, bank);
    await this.auditPaperContentView(actorId, paper, bank, 'print');
    const pin = await this.quiz.getPinRow(pinId);
    if (!pin || pin.examId !== paper.id) {
      throw new NotFoundException({ message: `Pin ${pinId} not found for this exam`, code: 'exam.pin_not_found' });
    }
    const variant = (pin.variants ?? []).find((v) => v.code === variantCode);
    if (!variant) {
      throw new NotFoundException({ message: `Variant ${variantCode} not found in this deployment`, code: 'exam.variant_not_found' });
    }
    const version = await this.repo.getVersion(pin.examVersionId);
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
