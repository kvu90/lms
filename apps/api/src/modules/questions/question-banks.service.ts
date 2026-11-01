import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { extractRichTextPlainText, getTrueFalseStatements, TRUE_FALSE_STATEMENT_COUNT, type RichTextDocument } from '@lms/contracts';
import type { DbTx } from '../../db/database';
import { OutboxService } from '../../infra/events/outbox.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { CAP_ALLOW } from '../access/domain/permission';
import { type ContextRow } from '../access/access.repository';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { GroupsService } from '../groups/groups.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import { TenantsRepository } from '../tenants/tenants.repository';
import { TenantsService } from '../tenants/tenants.service';
import { truefalseHashAnswers } from './domain/question-engine';
import {
  QuestionsRepository, type EntryRow, type QCategoryRow, type QuestionOutcomeLinkRow, type QuestionRow,
  type QuestionSubjectLinkRow, type QuestionsTx, type VersionRow,
} from '@lms/db/repositories/questions';
import { QuestionsService, type QuestionView, type SupportedQtype } from './questions.service';
import { QuestionBanksRepository, BANK_KINDS, type BankKind, type ContributionRow, type QuestionBankRow } from './question-banks.repository';

/** Vai chuyên dụng của lớp bank, gán TẠI context của từng bank (không phải archetype toàn cục). */
export const QBANK_MEMBER_ROLE = 'qbankmember';
export const QBANK_LEAD_ROLE = 'qbanklead';
/** Quyền của thành viên bank: dùng câu + copy câu khỏi bank (đọc qua cổng useall cho đến khi cổng đọc viewall/viewmine của issue #55 rebase vào). files:view để xem được ảnh nhúng trong nội dung câu của bank. */
const MEMBER_CAPS = ['question:useall', 'question:copy', 'files:view'];
/** Quyền của người phụ trách bank (chủ bank cá nhân / tổ trưởng): toàn quyền trong bank, gồm duyệt đóng góp. files:upload + files:view để tải lên và xem ảnh nhúng trong nội dung câu của bank. */
const LEAD_CAPS = ['question:useall', 'question:copy', 'question:share', 'question:moderate', 'question:add', 'question:editall', 'question:managecategory', 'files:view', 'files:upload'];
/**
 * Bộ quyền cho bank MA TRẬN — đủ bộ matrix:* (use/add/edit/copy/
 * share/moderate) sau đợt đồng bộ khuôn ngân hàng (issue #228, lát
 * S3); MB-1 (issue #111) mở đầu bằng copy/share/moderate và còn neo
 * xem/sửa vào quiz:* của Chặng 3. Vẫn cấp qua đúng hai vai
 * qbankmember/qbanklead tại context bank.
 */
const MATRIX_MEMBER_CAPS = ['matrix:use', 'matrix:copy'];
const MATRIX_LEAD_CAPS = ['matrix:use', 'matrix:add', 'matrix:edit', 'matrix:copy', 'matrix:share', 'matrix:moderate'];
/** Bộ quyền cấp tại context bank theo loại món: bank đề (EB-1) tạm dùng khuôn câu hỏi cho đến khi có bộ exam:* riêng. */
function memberCapsForKind(kind: BankKind): string[] { return kind === 'matrix' ? MATRIX_MEMBER_CAPS : MEMBER_CAPS; }
function leadCapsForKind(kind: BankKind): string[] { return kind === 'matrix' ? MATRIX_LEAD_CAPS : LEAD_CAPS; }
/** Archetype được coi là "giáo viên" cho bank trường. */
const STAFF_ARCHETYPES = ['manager', 'coursecreator', 'editingteacher', 'teacher'];
export const BANK_SCOPES = ['personal', 'team', 'school', 'course', 'platform'] as const;
export type BankScope = (typeof BANK_SCOPES)[number];

export interface BankCapabilitiesView {
  use: boolean; add: boolean; edit: boolean; manageCategory: boolean; copy: boolean; share: boolean; moderate: boolean;
  /** MB-1: bộ quyền ma trận tại context bank — chỉ điền khi bankKind = 'matrix' (lúc đó use/copy/share/moderate cũng mang nghĩa ma trận). */
  matrixView?: boolean; matrixManage?: boolean; matrixCopy?: boolean; matrixShare?: boolean; matrixModerate?: boolean;
}
export interface BankView extends QuestionBankRow {
  capabilities: BankCapabilitiesView;
  defaultCategoryId: string | null;
  categoryIds: string[];
}
export interface AttributionView {
  questionId: string;
  isCopy: boolean;
  derivedFromQuestionId: string | null;
  derivedFromVersionId: string | null;
  derivedFromVersionNumber: number | null;
  originalAuthorId: string | null;
  originalAuthorName: string | null;
  sourceBankId: string | null;
  sourceBankName: string | null;
  copyCount: number;
  useCount: number;
}

@Injectable()
/**
 * Lớp BANK của feat Ngân hàng câu hỏi chung (issue #70, QB-1 → QB-4).
 *
 * Quyết định kiến trúc (theo research mục 3.1): bank là thực thể có danh
 * tính riêng với MỘT context riêng — mọi cổng quyền của bank đều là
 * capability `question:*` đánh giá tại context của bank bằng
 * PermissionEvaluator hiện hữu, không dựng ACL song song. Tư cách thành
 * viên được vật chất hoá thành gán vai tại context bank: `qbanklead`
 * (chủ sở hữu/tổ trưởng) và `qbankmember` (thành viên tổ / giáo viên cả
 * trường), đồng bộ từ cohort (bank tổ) và từ các gán vai archetype giáo
 * viên (bank trường). Bank khoá không cần đồng bộ: context bank là con
 * của context khoá nên quyền tại khoá thừa hưởng xuống theo cây context.
 */
export class QuestionBanksService {
  constructor(
    private readonly repo: QuestionBanksRepository,
    private readonly questionsRepo: QuestionsRepository,
    private readonly questions: QuestionsService,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly roles: RolesService,
    private readonly groups: GroupsService,
    private readonly outbox: OutboxService,
    private readonly tenantContext: TenantContextService,
    private readonly tenantRepo: TenantsRepository,
    private readonly tenants: TenantsService,
  ) {}

  /** Tenant cho bank trường mới: tenant hiệu lực của request; ngoài request rơi về tenant-zero. */
  private async schoolTenantId(): Promise<string> {
    return this.tenantContext.currentTenantId() ?? (await this.tenants.fallbackTenantId());
  }

  /** Bank thuộc tenant khác với tenant hiệu lực (và không phải bank cá nhân/bank platform) = vô hình — 404 đồng nhất. */
  private bankTenantHidden(bank: QuestionBankRow): boolean {
    const active = this.tenantContext.currentTenantId();
    if (active === undefined) return false;
    if (bank.scope === 'personal' || bank.scope === 'platform') return false;
    return bank.tenantId !== active;
  }

  // --- vai chuyên dụng -----------------------------------------------------------

  /** Lấy hoặc tạo hai vai chuyên dụng của lớp bank (idempotent). */
  private async ensureBankRoles(): Promise<{ memberRoleId: string; leadRoleId: string }> {
    let member = await this.roles.getRoleByShortname(QBANK_MEMBER_ROLE);
    if (!member) {
      member = await this.roles.createRole({ name: 'Thành viên ngân hàng câu hỏi', shortName: QBANK_MEMBER_ROLE, description: 'Vai thành viên tại context của một bank câu hỏi: dùng + copy câu trong bank.' }).catch(async () => this.roles.getRoleByShortname(QBANK_MEMBER_ROLE));
    }
    let lead = await this.roles.getRoleByShortname(QBANK_LEAD_ROLE);
    if (!lead) {
      lead = await this.roles.createRole({ name: 'Quản trị ngân hàng câu hỏi', shortName: QBANK_LEAD_ROLE, description: 'Vai phụ trách tại context của một bank câu hỏi: toàn quyền trong bank, duyệt đóng góp.' }).catch(async () => this.roles.getRoleByShortname(QBANK_LEAD_ROLE));
    }
    if (!member || !lead) throw new BadRequestException({ message: 'Question bank roles are not available', code: 'question.bank_roles_missing' });
    return { memberRoleId: member.id, leadRoleId: lead.id };
  }

  /** Đặt override ALLOW cho một vai tại context bank (idempotent). */
  private async grantCaps(roleId: string, contextId: string, caps: string[], tx?: DbTx): Promise<void> {
    for (const cap of caps) await this.roles.setCapabilityOverride(roleId, cap, contextId, CAP_ALLOW, undefined, tx);
  }

  /** Gán vai tại context bank nếu chưa có (gán trùng là no-op ở RolesService). */
  private async ensureAssignment(userId: string, roleId: string, contextId: string, tx?: DbTx): Promise<void> {
    const existing = await this.roles.listAssignments({ userId, contextId }, tx);
    if (!existing.some((a) => (a as { roleId: string }).roleId === roleId)) {
      await this.roles.assignRole(userId, roleId, contextId, undefined, undefined, tx);
    }
  }

  // --- vòng đời bank ----------------------------------------------------------------

  /**
   * Dựng một bank hoàn chỉnh: context riêng (instance = bank id), dòng
   * bank, category mặc định ("Mặc định") và override capability cho hai
   * vai chuyên dụng tại context bank.
   *
   * Nguyên tử (issue #490, DL-09): toàn bộ chuỗi GHI sở hữu bởi bank —
   * context bank, dòng bank, category mặc định, override cho hai vai,
   * gán vai lead và dòng outbox `question_bank_created` — chạy trong
   * MỘT transaction: lỗi giữa chừng thì không bank/context mồ côi nào
   * tồn tại (trước đây các đường ensure bắt lỗi rồi đọc lại có thể
   * nhặt trúng đúng bank dở dang đó và dùng tiếp). Việc đảm bảo hai
   * VAI CHUYÊN DỤNG dùng chung (`ensureBankRoles`) nằm NGOÀI
   * transaction như cũ: vai là dữ kiện toàn cục không thuộc bank này,
   * và cơ chế `.catch` đọc-lại-khi-đua-nhau của nó không chạy được
   * trong transaction (một lệnh chèn hỏng sẽ huỷ cả transaction).
   */
  private async buildBank(actorId: string, input: {
    name: string; scope: BankScope; bankKind?: BankKind; ownerId: string | null; scopeRefId: string | null;
    parentContextId: string; contextLevel: number;
    /** Tenant sở hữu (TENANT-0, #168): NULL chỉ cho bank platform; bank cá nhân ghi tenant nhà của chủ sở hữu. */
    tenantId: string | null;
    /** Người nhận vai lead tại context bank khi bank không có owner (vd người tạo bank platform). */
    leadUserId?: string | null;
  }): Promise<QuestionBankRow> {
    const kind = input.bankKind ?? 'question';
    const { memberRoleId, leadRoleId } = await this.ensureBankRoles();
    const bankId = uuidv7();
    return this.repo.dbHandle.transaction(async (tx) => {
      const ctx = await this.contexts.createContext(input.contextLevel, bankId, input.parentContextId, tx);
      const bank = await this.repo.insertBank({
        id: bankId, tenantId: input.tenantId, name: input.name, scope: input.scope, bankKind: kind, ownerId: input.ownerId,
        scopeRefId: input.scopeRefId, contextId: ctx.id, createdBy: actorId,
      }, tx);
      // Category mặc định chỉ thuộc về bank câu hỏi; bank đề/ma trận không có question_categories.
      // Ghi qua điểm chuyển tiếp C-7 (insertCategoryTx phía QuestionBanksRepository):
      // transaction này là Drizzle (DL-09) nên không truyền được cho
      // insertCategory phía Kysely của QuestionsRepository — xem C-7
      // trong CORRECTIONS.md của chiến dịch và comment ở điểm chuyển tiếp.
      if (kind === 'question') {
        await this.repo.insertCategoryTx({
          name: 'Mặc định', contextId: ctx.id, bankId: bank.id, info: '', parent: null,
          stamp: `qbank-${Date.now().toString(36)}-${bank.id.slice(0, 8)}`,
        }, tx);
      }
      await this.grantCaps(memberRoleId, ctx.id, memberCapsForKind(kind), tx);
      await this.grantCaps(leadRoleId, ctx.id, leadCapsForKind(kind), tx);
      const leadUserId = input.ownerId ?? input.leadUserId ?? null;
      if (leadUserId) await this.ensureAssignment(leadUserId, leadRoleId, ctx.id, tx);
      await this.outbox.enqueue(tx, {
        aggregate: 'question_bank', type: 'question_bank_created',
        payload: { bankId: bank.id, scope: bank.scope, scopeRefId: bank.scopeRefId, ownerId: bank.ownerId, actorId },
        tenantId: input.tenantId,
      });
      return bank;
    });
  }

  /** Bank cá nhân của người dùng cho một loại món — tạo lười ở lần chạm đầu tiên ("Ngân hàng của tôi").
   * CHỈ cấp cho người thuộc nhóm vai giáo viên (archetype staff) hoặc
   * site admin: học sinh mở bề mặt bank không được tạo bank cá nhân
   * kèm vai qbanklead (điểm chặn 3 phán quyết PR #83) — trước đây
   * listBanks gọi vô điều kiện nên mọi tài khoản đều nhận bank + quyền
   * soạn câu. Người không đủ tư cách mà đã có bank từ trước vẫn không
   * được tạo mới; listBanks cũng không liệt kê bank đó cho họ. */
  async ensurePersonalBank(userId: string, kind: BankKind = 'question', opts?: { forCopy?: boolean }): Promise<QuestionBankRow> {
    const existing = await this.repo.getPersonalBank(userId, kind);
    if (existing) return existing;
    // Cổng staff chỉ áp cho tạo thụ động (mở bề mặt bank / tạo tường minh):
    // học sinh không tự sinh bank + vai qbanklead chỉ vì mở danh sách.
    // Ngoại lệ duy nhất là đích copy: copyQuestion đã kiểm tra quyền copy
    // trên câu nguồn TRƯỚC khi tới đây, nên quyền copy nguồn mới là cổng
    // thật — tạo bank đích cho người copy có quyền (kể cả thành viên tổ
    // không phải staff) là hành vi có chủ đích, không phải tạo thụ động.
    // Bank đích vẫn cấp vai lead như thường để cổng question:add ở
    // category đích sau đó đạt; người không có quyền copy nguồn vẫn bị
    // chặn từ assertCanCopySource trước khi bank nào được tạo.
    const isStaff = (await this.repo.listUserIdsWithArchetypes(STAFF_ARCHETYPES)).includes(userId)
      || (await this.evaluator.isSiteAdmin(userId));
    if (!isStaff && !opts?.forCopy) {
      throw new ForbiddenException({ message: 'Only staff can have a personal question bank', code: 'question.personal_bank_staff_only' });
    }
    const system = await this.contexts.ensureSystemContext();
    try {
      return await this.buildBank(userId, {
        name: 'Ngân hàng của tôi', scope: 'personal', bankKind: kind, ownerId: userId, scopeRefId: null,
        parentContextId: system.id, contextLevel: CONTEXT_LEVELS.USER,
        // Bank cá nhân là của người dùng trên toàn hệ thống (unique theo
        // owner+kind); tenant_id chỉ ghi tenant nhà lúc tạo để truy vết.
        tenantId: await this.schoolTenantId(),
      });
    } catch (err) {
      const again = await this.repo.getPersonalBank(userId, kind);
      if (again) return again;
      throw err;
    }
  }

  /** Bank trường duy nhất CỦA TENANT HIỆU LỰC cho một loại món — tạo lười bởi người đầu tiên đủ quyền (admin/giáo viên của tenant). */
  async ensureSchoolBank(actorId: string, kind: BankKind = 'question'): Promise<QuestionBankRow> {
    const tenantId = await this.schoolTenantId();
    const existing = await this.repo.getSchoolBank(tenantId, kind);
    if (existing) return existing;
    const tenantCtx = await this.contexts.ensureTenantContext(tenantId);
    try {
      const bank = await this.buildBank(actorId, {
        name: 'Ngân hàng trường', scope: 'school', bankKind: kind, ownerId: null, scopeRefId: null,
        parentContextId: tenantCtx.id, contextLevel: CONTEXT_LEVELS.COURSECAT,
        tenantId,
      });
      await this.syncSchoolMembers(bank);
      return bank;
    } catch (err) {
      const again = await this.repo.getSchoolBank(tenantId, kind);
      if (again) return again;
      throw err;
    }
  }

  /**
   * Bank platform (Ngân hàng hệ thống) duy nhất cho một loại món — chỉ
   * platform tạo/ghi (cổng ở createBank/listBanks phía gọi); tenant_id
   * NULL, mọi tenant đọc/copy xuống được qua đồng bộ thành viên staff.
   */
  async ensurePlatformBank(actorId: string, kind: BankKind = 'question'): Promise<QuestionBankRow> {
    const existing = await this.repo.getPlatformBank(kind);
    if (existing) return existing;
    const system = await this.contexts.ensureSystemContext();
    try {
      const bank = await this.buildBank(actorId, {
        name: 'Ngân hàng hệ thống', scope: 'platform', bankKind: kind, ownerId: null, scopeRefId: null,
        parentContextId: system.id, contextLevel: CONTEXT_LEVELS.COURSECAT,
        tenantId: null, leadUserId: actorId,
      });
      await this.syncPlatformMembers(bank);
      return bank;
    } catch (err) {
      const again = await this.repo.getPlatformBank(kind);
      if (again) return again;
      throw err;
    }
  }

  /** Bank của một khoá cho một loại món — tạo lười, context bank là con của context khoá. */
  async ensureCourseBank(actorId: string, courseId: string, name?: string, kind: BankKind = 'question'): Promise<QuestionBankRow> {
    const existing = await this.repo.getBankByScopeRef('course', courseId, kind);
    if (existing) return existing;
    const courseCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, courseId);
    if (!courseCtx) throw new NotFoundException({ message: `No context for course ${courseId}`, code: 'question.course_context_missing' });
    const tenantId = await this.repo.getCourseTenantId(courseId);
    if (!tenantId) throw new NotFoundException({ message: `Course ${courseId} not found`, code: 'question.course_not_found' });
    try {
      return await this.buildBank(actorId, {
        name: name ?? 'Ngân hàng khoá học', scope: 'course', bankKind: kind, ownerId: null, scopeRefId: courseId,
        parentContextId: courseCtx.id, contextLevel: CONTEXT_LEVELS.COURSE,
        tenantId,
      });
    } catch (err) {
      const again = await this.repo.getBankByScopeRef('course', courseId, kind);
      if (again) return again;
      throw err;
    }
  }

  /**
   * Tạo bank theo yêu cầu tường minh (QB-1):
   * - personal: mỗi người một bank — đã có thì trả bank hiện hữu.
   * - team: scopeRefId = cohort; người tạo phải là thành viên cohort (hoặc
   *   site admin); tổ trưởng mặc định là người tạo, phải thuộc cohort.
   * - school: chỉ người có `question:managecategory` tại hệ thống.
   * - course: scopeRefId = course; cổng `question:managecategory` tại khoá.
   */
  async createBank(actorId: string, input: { name: string; scope: string; bankKind?: string; scopeRefId?: string; leaderId?: string }): Promise<BankView> {
    if (!(BANK_SCOPES as readonly string[]).includes(input.scope)) {
      throw new BadRequestException({ message: `Unknown bank scope ${input.scope}`, code: 'question.bank_scope_invalid' });
    }
    const kind = (input.bankKind ?? 'question') as BankKind;
    if (!(BANK_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException({ message: `Unknown bank kind ${String(input.bankKind)}`, code: 'question.bank_kind_invalid' });
    }
    const scope = input.scope as BankScope;
    if (scope === 'personal') {
      const bank = await this.ensurePersonalBank(actorId, kind);
      return this.bankView(actorId, bank);
    }
    if (scope === 'platform') {
      // Ngân hàng hệ thống: chỉ platform ghi — cổng `tenant:manage` tại
      // context hệ thống (platform admin / site admin).
      const system = await this.contexts.ensureSystemContext();
      await this.evaluator.requireCapability(actorId, 'tenant:manage', system.id);
      const bank = await this.ensurePlatformBank(actorId, kind);
      return this.bankView(actorId, bank);
    }
    if (scope === 'school') {
      // Bank trường của tenant hiệu lực: cổng tại context tenant của
      // tenant đó, lùi về context hệ thống cho vai platform như trước.
      const tenantId = await this.schoolTenantId();
      const tenantCtx = await this.contexts.ensureTenantContext(tenantId);
      if (!(await this.evaluator.hasCapability(actorId, 'question:managecategory', tenantCtx.id))) {
        const system = await this.contexts.ensureSystemContext();
        await this.evaluator.requireCapability(actorId, 'question:managecategory', system.id);
      }
      const bank = await this.ensureSchoolBank(actorId, kind);
      return this.bankView(actorId, bank);
    }
    if (scope === 'course') {
      if (!input.scopeRefId) throw new BadRequestException({ message: 'scopeRefId (course id) is required for a course bank', code: 'question.bank_scope_ref_required' });
      const courseCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, input.scopeRefId);
      if (!courseCtx) throw new NotFoundException({ message: `No context for course ${input.scopeRefId}`, code: 'question.course_context_missing' });
      await this.evaluator.requireCapability(actorId, 'question:managecategory', courseCtx.id);
      const bank = await this.ensureCourseBank(actorId, input.scopeRefId, input.name, kind);
      return this.bankView(actorId, bank);
    }
    // team
    if (!input.scopeRefId) throw new BadRequestException({ message: 'scopeRefId (cohort id) is required for a team bank', code: 'question.bank_scope_ref_required' });
    const existing = await this.repo.getBankByScopeRef('team', input.scopeRefId, kind);
    if (existing) return this.bankView(actorId, existing);
    const cohort = await this.groups.getCohort(input.scopeRefId);
    const members = await this.groups.listCohortMembers(cohort.id);
    const isAdmin = await this.evaluator.isSiteAdmin(actorId);
    if (!isAdmin && !members.some((m) => m.userId === actorId)) {
      throw new ForbiddenException({ message: 'Only cohort members can create the team question bank', code: 'question.bank_team_not_member' });
    }
    const leaderId = input.leaderId ?? actorId;
    if (!members.some((m) => m.userId === leaderId)) {
      throw new BadRequestException({ message: 'The team bank leader must be a cohort member', code: 'question.bank_leader_not_member' });
    }
    const parentCtx = await this.contexts.getContext(cohort.contextId).catch(() => undefined)
      ?? (await this.contexts.ensureSystemContext());
    const bank = await this.buildBank(actorId, {
      name: input.name, scope: 'team', bankKind: kind, ownerId: leaderId, scopeRefId: cohort.id,
      parentContextId: parentCtx.id, contextLevel: CONTEXT_LEVELS.COURSECAT,
      tenantId: cohort.tenantId,
    });
    await this.syncTeamMembers(bank);
    return this.bankView(actorId, bank);
  }

  // --- đồng bộ thành viên -------------------------------------------------------------

  /** Đồng bộ một vai tại context bank về đúng tập user mong muốn (thêm thiếu, gỡ thừa). */
  private async syncRoleAssignments(bank: QuestionBankRow, roleId: string, desiredUserIds: Set<string>): Promise<void> {
    const assignments = await this.roles.listAssignments({ contextId: bank.contextId });
    const mine = assignments.filter((a) => (a as { roleId: string }).roleId === roleId) as { id: string; userId: string }[];
    const current = new Set(mine.map((a) => a.userId));
    for (const userId of desiredUserIds) {
      if (!current.has(userId)) await this.roles.assignRole(userId, roleId, bank.contextId);
    }
    for (const a of mine) {
      if (!desiredUserIds.has(a.userId)) await this.roles.unassignRole(a.id);
    }
  }

  /** Bank tổ: thành viên cohort → qbankmember; owner (tổ trưởng) → qbanklead. */
  async syncTeamMembers(bank: QuestionBankRow): Promise<void> {
    if (bank.scope !== 'team' || !bank.scopeRefId) return;
    const { memberRoleId, leadRoleId } = await this.ensureBankRoles();
    const members = await this.groups.listCohortMembers(bank.scopeRefId).catch(() => []);
    const memberIds = new Set(members.map((m) => m.userId));
    if (bank.ownerId) memberIds.delete(bank.ownerId);
    await this.syncRoleAssignments(bank, memberRoleId, memberIds);
    await this.syncRoleAssignments(bank, leadRoleId, new Set(bank.ownerId ? [bank.ownerId] : []));
  }

  /**
   * Bank trường: giáo viên (archetype staff) → qbankmember — trong một
   * tenant trường/trung tâm chỉ tính staff LÀ THÀNH VIÊN của tenant đó;
   * bank trường của tenant-zero (không gian platform) giữ quy tắc cũ
   * (mọi staff, vì tenant-zero không có cổng membership).
   */
  async syncSchoolMembers(bank: QuestionBankRow): Promise<void> {
    if (bank.scope !== 'school' || !bank.tenantId) return;
    const { memberRoleId } = await this.ensureBankRoles();
    const staff = await this.repo.listUserIdsWithArchetypes(STAFF_ARCHETYPES);
    const tenant = await this.tenantRepo.getTenant(bank.tenantId);
    let desired = staff;
    if (tenant && tenant.kind !== 'platform') {
      const members = await this.tenantRepo.listMembershipsForTenant(bank.tenantId);
      const memberIds = new Set(members.filter((m) => m.status === 'active').map((m) => m.userId));
      desired = staff.filter((id) => memberIds.has(id));
    }
    await this.syncRoleAssignments(bank, memberRoleId, new Set(desired));
  }

  /** Bank platform (Ngân hàng hệ thống): mọi staff đọc/copy được (qbankmember); quyền ghi nằm ở vai lead do platform cấp tường minh. */
  async syncPlatformMembers(bank: QuestionBankRow): Promise<void> {
    if (bank.scope !== 'platform') return;
    const { memberRoleId } = await this.ensureBankRoles();
    const staff = await this.repo.listUserIdsWithArchetypes(STAFF_ARCHETYPES);
    await this.syncRoleAssignments(bank, memberRoleId, new Set(staff));
  }

  /** Đồng bộ tư cách thành viên trước khi đánh giá quyền (bank tổ + bank trường + bank platform). */
  private async syncMembership(bank: QuestionBankRow): Promise<void> {
    if (bank.scope === 'team') await this.syncTeamMembers(bank);
    else if (bank.scope === 'school') await this.syncSchoolMembers(bank);
    else if (bank.scope === 'platform') await this.syncPlatformMembers(bank);
  }

  // --- cổng quyền + view -----------------------------------------------------------------

  /** Lấy bank hoặc 404. */
  async getBankOrThrow(id: string): Promise<QuestionBankRow> {
    const bank = await this.repo.getBank(id);
    if (!bank) throw new NotFoundException({ message: `Question bank ${id} not found`, code: 'question.bank_not_found' });
    return bank;
  }

  // --- riêng tư bank personal (issue #123) -------------------------------------
  // Ngân hàng riêng của từng giáo viên là KHU VỰC RIÊNG ("của tôi"):
  // cổng capability tại context bank KHÔNG đủ để gác vì context bank
  // personal là con của context hệ thống — GV staff/manager kế thừa
  // question:useall/question:copy/... xuống mọi bank personal của đồng
  // nghiệp (bằng chứng phán quyết MCP-0 6391128869 + EB-1 6391268932).
  // Mọi bề mặt đọc/gác qua lớp bank này phải cộng thêm phép kiểm tra
  // chủ sở hữu dưới đây: bank personal chỉ chủ sở hữu vào được; site
  // admin giữ toàn quyền như bất biến hiện hành (khớp bankLocalMatrixCaps
  // của MB-1). Bank tổ/trường/khoá KHÔNG qua cổng này.

  /** Bank có phải bank personal của NGƯỜI KHÁC đối với actor không (site admin thì không). */
  async isForeignPersonalBank(actorId: string, bank: QuestionBankRow): Promise<boolean> {
    if (bank.scope !== 'personal' || bank.ownerId === actorId) return false;
    return !(await this.evaluator.isSiteAdmin(actorId));
  }

  /** 404 bank_not_found khi bank là bank personal của người khác — như bank không tồn tại (không oracle). */
  private async assertNotForeignPersonalBank(actorId: string, bank: QuestionBankRow): Promise<void> {
    if (await this.isForeignPersonalBank(actorId, bank)) {
      throw new NotFoundException({ message: `Question bank ${bank.id} not found`, code: 'question.bank_not_found' });
    }
  }

  /** Bộ capability của actor tại context của bank. Bank ma trận (MB-1) đọc bộ quyền bank-local (vai chuyên dụng tại context bank — xem bankLocalMatrixCaps): use/copy/share/moderate mang nghĩa ma trận, các trường question:* không áp dụng để false. */
  async bankCapabilities(actorId: string, bank: QuestionBankRow): Promise<BankCapabilitiesView> {
    const at = async (cap: string) => this.evaluator.hasCapability(actorId, cap, bank.contextId);
    if (bank.bankKind === 'matrix') {
      const caps = await this.bankLocalMatrixCaps(actorId, bank);
      return {
        // Khuôn chung ba thực thể (S3): use/add/edit của bank ma trận
        // đọc từ đúng bộ matrix:* bank-local (trước S3 hai trường này
        // luôn false vì ma trận chưa có capability add/edit riêng).
        use: caps.view, add: caps.add, edit: caps.manage, manageCategory: false,
        copy: caps.copy, share: caps.share, moderate: caps.moderate,
        matrixView: caps.view, matrixManage: caps.manage, matrixCopy: caps.copy, matrixShare: caps.share, matrixModerate: caps.moderate,
      };
    }
    const [use, add, edit, manageCategory, copy, share, moderate] = await Promise.all([
      at('question:useall'), at('question:add'), at('question:editall'), at('question:managecategory'),
      at('question:copy'), at('question:share'), at('question:moderate'),
    ]);
    return { use, add, edit, manageCategory, copy, share, moderate };
  }

  /** View bank kèm khả năng của actor + category của bank. */
  async bankView(actorId: string, bank: QuestionBankRow): Promise<BankView> {
    const categories = await this.repo.listCategoriesOfBank(bank.id);
    return {
      ...bank,
      capabilities: await this.bankCapabilities(actorId, bank),
      defaultCategoryId: categories[0]?.id ?? null,
      categoryIds: categories.map((c) => c.id),
    };
  }

  /** Cổng "vào được bank": có quyền dùng câu tại context bank (sau đồng bộ thành viên).
   * Bank personal của người khác → 404 (issue #123) thay cho 403. */
  async assertCanUseBank(actorId: string, bank: QuestionBankRow): Promise<void> {
    await this.assertNotForeignPersonalBank(actorId, bank);
    await this.syncMembership(bank);
    if (!(await this.evaluator.hasCapability(actorId, 'question:useall', bank.contextId))) {
      throw new ForbiddenException({ message: `No access to question bank ${bank.id}`, code: 'question.bank_forbidden' });
    }
  }

  /**
   * Cổng "vào được bank" THEO LOẠI MÓN (MB-1): bank ma trận gác bằng
   * quyền bank-local (vai chuyên dụng tại context bank — xem
   * bankLocalMatrixCaps) thay cho question:useall — quyền của mỗi loại
   * món vẫn MỘT nguồn duy nhất là context của bank (E-8).
   */
  async assertCanUseBankForKind(actorId: string, bank: QuestionBankRow): Promise<void> {
    await this.assertNotForeignPersonalBank(actorId, bank);
    await this.syncMembership(bank);
    if (bank.bankKind === 'matrix') {
      const caps = await this.bankLocalMatrixCaps(actorId, bank);
      if (!caps.view) {
        throw new ForbiddenException({ message: `No access to question bank ${bank.id}`, code: 'question.bank_forbidden' });
      }
      return;
    }
    if (!(await this.evaluator.hasCapability(actorId, 'question:useall', bank.contextId))) {
      throw new ForbiddenException({ message: `No access to question bank ${bank.id}`, code: 'question.bank_forbidden' });
    }
  }

  /** Tra bank theo id, KHÔNG ném lỗi — resolver quyền của module khác (Quiz/MB-1) dùng để neo quyền về context bank. */
  async findBankById(id: string): Promise<QuestionBankRow | null> {
    return (await this.repo.getBank(id)) ?? null;
  }

  /** Đồng bộ tư cách thành viên bank (tổ/trường) — bản công khai cho module khác gác quyền tại context bank. */
  async syncBankMembership(bank: QuestionBankRow): Promise<void> {
    await this.syncMembership(bank);
  }

  /** Tên hiển thị của nhiều user — cho hàng chờ đóng góp của module khác (MB-1). */
  async displayNames(userIds: string[]): Promise<Map<string, string | null>> {
    return this.repo.getUserDisplayNames(userIds);
  }

  /**
   * Bộ quyền MA TRẬN của actor tại một bank ma trận (MB-1) — tính từ
   * HAI VAI CHUYÊN DỤNG TẠI CHÍNH CONTEXT BANK (qbankmember/qbanklead,
   * đã đồng bộ từ cohort/trường/chủ sở hữu), KHÔNG qua PermissionEvaluator:
   * evaluator kế thừa mặc định archetype từ mọi context tổ tiên, nên một
   * giáo viên được gán vai ở context hệ thống sẽ "lọt" mọi cổng bank dù
   * không phải thành viên — phá vỡ nguyên tắc ngân hàng kín của tổ.
   * Quyền tại bank chỉ từ tư cách thành viên bank (đúng nghĩa "MỘT
   * nguồn duy nhất là bank", E-8); site admin vẫn toàn quyền.
   */
  async bankLocalMatrixCaps(actorId: string, bank: QuestionBankRow): Promise<{
    view: boolean; add: boolean; manage: boolean; copy: boolean; share: boolean; moderate: boolean;
  }> {
    const none = { view: false, add: false, manage: false, copy: false, share: false, moderate: false };
    if (await this.evaluator.isSiteAdmin(actorId)) return { view: true, add: true, manage: true, copy: true, share: true, moderate: true };
    // Bank personal là khu vực riêng (issue #123): người không phải chủ
    // sở hữu không có quyền bank-local nào, kể cả khi còn assignment sót.
    if (bank.scope === 'personal' && bank.ownerId !== actorId) return none;
    const assignments = await this.roles.listAssignments({ userId: actorId, contextId: bank.contextId });
    if (!assignments.length) return none;
    const roleIds = new Set(assignments.map((a) => (a as { roleId: string }).roleId));
    const [memberRole, leadRole] = await Promise.all([
      this.roles.getRoleByShortname(QBANK_MEMBER_ROLE), this.roles.getRoleByShortname(QBANK_LEAD_ROLE),
    ]);
    const isLead = leadRole ? roleIds.has(leadRole.id) : false;
    const isMember = memberRole ? roleIds.has(memberRole.id) : false;
    if (!isLead && !isMember) return none;
    // add (tạo ma trận mới trong bank) cùng tầng với manage: chỉ phụ
    // trách bank — thành viên thường chỉ xem + copy như trước.
    return { view: true, add: isLead, manage: isLead, copy: true, share: isLead, moderate: isLead };
  }

  /**
   * Danh sách bank actor vào được: bank cá nhân của chính mình + bank
   * trường (nếu là giáo viên) + bank tổ mình thuộc về + bank các khoá
   * mình có quyền dùng câu. Bank cá nhân và bank trường được đảm bảo tồn
   * tại cho người đủ tư cách (tạo lười).
   */
  async listBanks(actorId: string, kind: BankKind = 'question'): Promise<BankView[]> {
    const isStaff = (await this.repo.listUserIdsWithArchetypes(STAFF_ARCHETYPES)).includes(actorId)
      || (await this.evaluator.isSiteAdmin(actorId));
    // Chỉ người đủ tư cách mới được tạo lười bank cá nhân (điểm chặn 3):
    // học sinh gọi listBanks không còn tự sinh bank + vai qbanklead.
    if (isStaff) await this.ensurePersonalBank(actorId, kind);
    if (isStaff) await this.ensureSchoolBank(actorId, kind);
    // Ngân hàng hệ thống (bank platform) chỉ platform tạo — người giữ
    // tenant:manage ở hệ thống mở danh sách thì bank được đảm bảo tồn tại.
    const system = await this.contexts.ensureSystemContext();
    if (await this.evaluator.hasCapability(actorId, 'tenant:manage', system.id)) {
      await this.ensurePlatformBank(actorId, kind);
    }
    const all = (await this.repo.listBanks()).filter((b) => b.bankKind === kind);
    const out: BankView[] = [];
    for (const bank of all) {
      // Bank của tenant khác (trừ bank cá nhân của chính mình và bank
      // platform dùng chung) không xuất hiện trong danh sách (TENANT-0).
      if (this.bankTenantHidden(bank)) continue;
      // Hàng tồn từ trước khi có cổng: bank cá nhân của chính người
      // không đủ tư cách cũng không liệt kê cho họ nữa.
      if (bank.scope === 'personal' && bank.ownerId === actorId && !isStaff) continue;
      // Riêng tư bank personal (issue #123): bank personal của NGƯỜI
      // KHÁC không bao giờ xuất hiện trong danh sách — kể cả GV staff
      // có question:useall kế thừa tại context bank đó.
      if (await this.isForeignPersonalBank(actorId, bank)) continue;
      await this.syncMembership(bank);
      // Cổng vào theo loại món: bank câu hỏi dùng question:useall tại
      // context bank (kế thừa cây context như QB); bank ma trận (MB-1)
      // dùng quyền bank-local — GV ngoài tổ không thấy bank tổ kể cả
      // khi có vai archetype ở context tổ tiên.
      const canEnter = kind === 'matrix'
        ? (await this.bankLocalMatrixCaps(actorId, bank)).view
        : await this.evaluator.hasCapability(actorId, 'question:useall', bank.contextId);
      if (canEnter) {
        out.push(await this.bankView(actorId, bank));
      }
    }
    return out;
  }

  /** Chi tiết một bank (kèm đồng bộ + cổng vào bank theo loại món).
   * Bank personal của người khác → 404 như không tồn tại (issue #123). */
  async getBank(actorId: string, bankId: string): Promise<BankView> {
    const bank = await this.getBankOrThrow(bankId);
    if (this.bankTenantHidden(bank)) {
      throw new NotFoundException({ message: `Question bank ${bankId} not found`, code: 'question.bank_not_found' });
    }
    await this.assertNotForeignPersonalBank(actorId, bank);
    await this.assertCanUseBankForKind(actorId, bank);
    return this.bankView(actorId, bank);
  }

  // --- suy bank từ category ---------------------------------------------------------------

  /**
   * Bank của một category, KHÔNG tạo mới: bank_id tường minh trước; chưa
   * có thì suy từ context (context khoá → bank khoá; context hệ thống /
   * danh mục khoá → bank trường) — đúng quy tắc QB-1 cho category hiện hữu.
   */
  async findBankForCategory(category: QCategoryRow): Promise<QuestionBankRow | null> {
    if (category.bankId) return (await this.repo.getBank(category.bankId)) ?? null;
    const ctx = await this.contexts.getContext(category.contextId).catch(() => undefined);
    if (!ctx?.instanceId) return null;
    if (ctx.contextLevel === CONTEXT_LEVELS.COURSE) {
      return (await this.repo.getBankByScopeRef('course', ctx.instanceId)) ?? null;
    }
    if (ctx.contextLevel === CONTEXT_LEVELS.SYSTEM || ctx.contextLevel === CONTEXT_LEVELS.COURSECAT) {
      // Bank trường suy theo tenant của cây context chứa category; chưa
      // có neo tenant (category cũ) thì rơi về tenant hiệu lực/zero.
      const pathContexts = await this.contexts.getPathContexts(ctx);
      const tenantCtx = pathContexts.find((c) => c.contextLevel === CONTEXT_LEVELS.TENANT);
      const tenantId = tenantCtx?.instanceId ?? (await this.schoolTenantId());
      return (await this.repo.getSchoolBank(tenantId)) ?? null;
    }
    return null;
  }

  /**
   * Bank của NHIỀU category trong số truy vấn cố định (DL-04, issue
   * #489): bản theo lô của `findBankForCategory` với ngữ nghĩa giữ
   * nguyên từng bước — bank_id tường minh tra theo lô; context của
   * các category còn lại tra một lần; bank khoá tra theo lô theo
   * scope_ref; bank trường suy theo tenant lấy từ cây context (mọi
   * context trên các đường path được nạp chung một truy vấn, thứ tự
   * gốc → lá dựng lại từ `path` như `getPathContexts`) và tenant dự
   * phòng `schoolTenantId()` chỉ gọi tối đa một lần cho cả lô.
   * Category không suy được bank thì nhận null trong map.
   */
  async findBanksForCategories(categories: QCategoryRow[]): Promise<Map<string, QuestionBankRow | null>> {
    const result = new Map<string, QuestionBankRow | null>();
    if (!categories.length) return result;

    const explicitIds = [...new Set(categories.map((c) => c.bankId).filter((id): id is string => id != null))];
    const explicitBanks = explicitIds.length
      ? new Map((await this.repo.getBanksByIds(explicitIds)).map((b) => [b.id, b]))
      : new Map<string, QuestionBankRow>();
    const inferred: QCategoryRow[] = [];
    for (const category of categories) {
      if (category.bankId) result.set(category.id, explicitBanks.get(category.bankId) ?? null);
      else inferred.push(category);
    }
    if (!inferred.length) return result;

    const contextsById = new Map(
      (await this.contexts.getContextsByIds(inferred.map((c) => c.contextId))).map((c) => [c.id, c]),
    );
    const courseRefs = new Map<string, QCategoryRow[]>();
    const schoolCats: { category: QCategoryRow; ctx: ContextRow }[] = [];
    for (const category of inferred) {
      const ctx = contextsById.get(category.contextId);
      if (!ctx?.instanceId) {
        result.set(category.id, null);
      } else if (ctx.contextLevel === CONTEXT_LEVELS.COURSE) {
        const list = courseRefs.get(ctx.instanceId) ?? [];
        list.push(category);
        courseRefs.set(ctx.instanceId, list);
      } else if (ctx.contextLevel === CONTEXT_LEVELS.SYSTEM || ctx.contextLevel === CONTEXT_LEVELS.COURSECAT) {
        schoolCats.push({ category, ctx });
      } else {
        result.set(category.id, null);
      }
    }

    if (courseRefs.size) {
      const courseBanks = await this.repo.listBanksByScopeRefs('course', [...courseRefs.keys()]);
      const firstByRef = new Map<string, QuestionBankRow>();
      for (const bank of courseBanks) {
        if (bank.scopeRefId && !firstByRef.has(bank.scopeRefId)) firstByRef.set(bank.scopeRefId, bank);
      }
      for (const [instanceId, cats] of courseRefs) {
        for (const category of cats) result.set(category.id, firstByRef.get(instanceId) ?? null);
      }
    }

    if (schoolCats.length) {
      const pathIds = [...new Set(schoolCats.flatMap(({ ctx }) => ctx.path.split('/').filter(Boolean)))];
      const pathContextsById = new Map(
        (await this.contexts.getContextsByIds(pathIds)).map((c) => [c.id, c]),
      );
      let fallbackTenantId: string | undefined;
      const tenantIdByCategory = new Map<string, string>();
      for (const { category, ctx } of schoolCats) {
        const rootToLeaf = ctx.path.split('/').filter(Boolean).reverse()
          .map((id) => pathContextsById.get(id)).filter((c) => c !== undefined);
        const tenantCtx = rootToLeaf.find((c) => c.contextLevel === CONTEXT_LEVELS.TENANT);
        if (tenantCtx?.instanceId) {
          tenantIdByCategory.set(category.id, tenantCtx.instanceId);
        } else {
          fallbackTenantId ??= await this.schoolTenantId();
          tenantIdByCategory.set(category.id, fallbackTenantId);
        }
      }
      const schoolBanks = await this.repo.listSchoolBanksByTenantIds([...new Set(tenantIdByCategory.values())]);
      const firstByTenant = new Map<string, QuestionBankRow>();
      for (const bank of schoolBanks) {
        if (bank.tenantId && !firstByTenant.has(bank.tenantId)) firstByTenant.set(bank.tenantId, bank);
      }
      for (const { category } of schoolCats) {
        result.set(category.id, firstByTenant.get(tenantIdByCategory.get(category.id)!) ?? null);
      }
    }
    return result;
  }

  /**
   * Một category có thuộc về một bank hay không, theo ĐÚNG phép suy
   * của `categoryBelongsToBank` nhưng dùng bank suy sẵn theo lô
   * (`findBanksForCategories`) thay vì truy vấn lại cho từng cặp
   * category × bank (DL-04, issue #489).
   */
  private categoryMatchesBank(
    category: QCategoryRow,
    bank: QuestionBankRow,
    inferredBankByCategory: Map<string, QuestionBankRow | null>,
  ): boolean {
    if (category.bankId) return category.bankId === bank.id;
    if (category.contextId === bank.contextId) return true;
    return inferredBankByCategory.get(category.id)?.id === bank.id;
  }

  /** Như findBankForCategory nhưng tạo lười bank suy được khi chưa có. */
  async ensureBankForCategory(actorId: string, category: QCategoryRow): Promise<QuestionBankRow | null> {
    const found = await this.findBankForCategory(category);
    if (found) return found;
    const ctx = await this.contexts.getContext(category.contextId).catch(() => undefined);
    if (!ctx?.instanceId) return null;
    if (ctx.contextLevel === CONTEXT_LEVELS.COURSE) {
      return this.ensureCourseBank(actorId, ctx.instanceId).catch(() => null);
    }
    if (ctx.contextLevel === CONTEXT_LEVELS.SYSTEM || ctx.contextLevel === CONTEXT_LEVELS.COURSECAT) {
      return this.ensureSchoolBank(actorId).catch(() => null);
    }
    return null;
  }

  /** Category mặc định của bank (category đầu tiên); 400 khi bank chưa có category nào. */
  async defaultCategoryOfBank(bank: QuestionBankRow): Promise<QCategoryRow> {
    const categories = await this.repo.listCategoriesOfBank(bank.id);
    const first = categories[0];
    if (!first) throw new BadRequestException({ message: `Question bank ${bank.id} has no category`, code: 'question.bank_no_category' });
    return first;
  }

  /**
   * Kiểm chứng một category thuộc về một bank — MỘT phép suy duy nhất
   * cho mọi bề mặt (điểm chặn 4 phán quyết PR #83): bank_id tường minh
   * trước; category sống trực tiếp trong context bank thì thuộc bank đó;
   * còn lại suy theo context như findBankForCategory (category ở context
   * khoá thuộc bank khoá, category ở context hệ thống/danh mục thuộc
   * bank trường) — trước đây các bề mặt tự suy kiểu khác nhau nên
   * category khoá hiện hữu bị sót khỏi khám phá và chống trùng.
   */
  async categoryBelongsToBank(category: QCategoryRow, bank: QuestionBankRow): Promise<boolean> {
    if (category.bankId) return category.bankId === bank.id;
    if (category.contextId === bank.contextId) return true;
    const inferred = await this.findBankForCategory(category);
    return inferred?.id === bank.id;
  }

  // --- QB-2: copy có truy vết -------------------------------------------------------------

  /**
   * Thông tin bank + version của một câu hỏi phục vụ slot đề thi (QB-3)
   * và hiển thị: bank suy từ category, trạng thái entry, version mới
   * nhất và version `ready` mới nhất (đích của follow_latest / nút nâng).
   */
  async getQuestionBankInfo(questionId: string): Promise<QuestionBankInfo | null> {
    const infos = await this.getQuestionBankInfos([questionId]);
    return infos.get(questionId) ?? null;
  }

  /**
   * Thông tin bank của NHIỀU câu hỏi trong số truy vấn cố định
   * (DL-05, issue #489): bản theo lô của `getQuestionBankInfo` cho
   * các đường đọc phải tra bank cho mọi câu trên một trang (view slot
   * của đề) — question, entry, category, bank suy theo lô và version
   * đều nạp theo tập, rồi lắp kết quả bằng đúng bộ dựng của đường lẻ
   * nên mọi trường khớp hệt. Câu không tồn tại hoặc chưa có entry
   * nhận null trong map.
   */
  async getQuestionBankInfos(questionIds: string[]): Promise<Map<string, QuestionBankInfo | null>> {
    const infos = new Map<string, QuestionBankInfo | null>();
    const uniqueIds = [...new Set(questionIds)];
    if (!uniqueIds.length) return infos;
    const questions = await this.questionsRepo.getQuestionsByIds(uniqueIds);
    const questionById = new Map(questions.map((q) => [q.id, q]));
    const entries = await this.questionsRepo.getEntriesByQuestionIds(uniqueIds);
    const entryByQuestion = new Map(entries.map((e) => [e.questionId, e]));
    const categories = await this.questionsRepo.getCategoriesByIds(
      [...new Set(questions.map((q) => q.category))],
    );
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const bankByCategory = await this.findBanksForCategories(categories);
    const versions = await this.questionsRepo.listVersionsForEntries(entries.map((e) => e.id));
    const versionsByEntry = new Map<string, VersionRow[]>();
    for (const v of versions) {
      const list = versionsByEntry.get(v.questionBankEntryId) ?? [];
      list.push(v);
      versionsByEntry.set(v.questionBankEntryId, list);
    }
    for (const questionId of uniqueIds) {
      const q = questionById.get(questionId);
      const entry = entryByQuestion.get(questionId);
      if (!q || !entry) {
        infos.set(questionId, null);
        continue;
      }
      const category = categoryById.get(q.category);
      const bank = category ? (bankByCategory.get(category.id) ?? null) : null;
      infos.set(questionId, this.buildQuestionBankInfo(bank, category, entry, versionsByEntry.get(entry.id) ?? []));
    }
    return infos;
  }

  /** Lắp thông tin bank của một câu từ các dòng đã nạp sẵn — dùng chung cho đường lẻ và đường theo lô. */
  private buildQuestionBankInfo(
    bank: QuestionBankRow | null,
    category: QCategoryRow | undefined,
    entry: EntryRow,
    versions: VersionRow[],
  ): QuestionBankInfo {
    const ready = versions.filter((v) => v.status === 'ready');
    const latestReady = ready.length ? ready[ready.length - 1]! : null;
    const latest = versions.length ? versions[versions.length - 1]! : null;
    return {
      bank,
      // bankExplicit: category gắn bank tường minh (bank_id) — phân biệt
      // với bank suy từ context cho category cũ (QB-1), nơi hành vi mặc
      // định của slot không đổi.
      bankExplicit: category?.bankId != null && bank !== null && category.bankId === bank.id,
      entryStatus: entry.status, latestVersion: entry.latestVersion,
      latestVersionId: latest?.id ?? null,
      latestReadyVersionId: latestReady?.id ?? null, latestReadyVersionNumber: latestReady?.version ?? null,
    };
  }

  /** Dòng ghi công của một câu hỏi: truy vết copy + tác giả gốc + bank nguồn + tín hiệu dùng/copy. */
  async getAttribution(questionId: string): Promise<AttributionView> {
    const q = await this.questionsRepo.getQuestion(questionId);
    if (!q) throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
    const names = await this.repo.getUserDisplayNames([q.originalAuthorId ?? '', q.createdBy ?? '']);
    let derivedFromVersionNumber: number | null = null;
    if (q.derivedFromVersionId) {
      const v = await this.questionsRepo.getVersion(q.derivedFromVersionId);
      derivedFromVersionNumber = v?.version ?? null;
    }
    let sourceBankName: string | null = null;
    if (q.derivedFromBankId) {
      sourceBankName = (await this.repo.getBank(q.derivedFromBankId))?.name ?? null;
    }
    const useCounts = await this.repo.countSlotsByQuestionIds([questionId]);
    return {
      questionId,
      isCopy: q.derivedFromQuestionId !== null,
      derivedFromQuestionId: q.derivedFromQuestionId,
      derivedFromVersionId: q.derivedFromVersionId,
      derivedFromVersionNumber,
      originalAuthorId: q.originalAuthorId,
      originalAuthorName: q.originalAuthorId ? (names.get(q.originalAuthorId) ?? null) : null,
      sourceBankId: q.derivedFromBankId,
      sourceBankName,
      copyCount: q.copyCount,
      useCount: useCounts.get(questionId) ?? 0,
    };
  }

  /**
   * Dòng ghi công CHO NGƯỜI ĐỌC: cùng cổng với chi tiết câu hỏi
   * (issue #55) — actor phải có `question:useall` tại context của
   * category chứa câu, không thì 404 như chi tiết câu hỏi (không oracle
   * phân biệt "có nhưng cấm" với "không có"). Đồng bộ thành viên bank
   * trước khi kiểm quyền để thành viên tổ/trường mới thêm không bị 404
   * oan. Luồng nội bộ (copy trả attribution cho người vừa copy) vẫn
   * dùng getAttribution không cổng vì caller đã qua cổng copy.
   */
  async getAttributionForViewer(actorId: string, questionId: string): Promise<AttributionView> {
    await this.assertQuestionReadableByViewer(actorId, questionId);
    return this.getAttribution(questionId);
  }

  /**
   * Cổng đọc cho người xem một câu hỏi (dùng chung cho attribution
   * và truy nguồn chiều ngược): câu không tồn tại, câu thuộc bank
   * personal của người khác, hoặc actor không có `question:useall`
   * tại context của category chứa câu → 404 đồng nhất, không oracle.
   */
  private async assertQuestionReadableByViewer(actorId: string, questionId: string): Promise<void> {
    const q = await this.questionsRepo.getQuestion(questionId);
    if (!q) throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
    const category = await this.questionsRepo.getCategory(q.category);
    if (!category) throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
    const bank = await this.findBankForCategory(category);
    if (bank) await this.syncMembership(bank);
    // Câu thuộc bank personal của người khác → 404 như chi tiết câu (issue #123).
    if (bank && (await this.isForeignPersonalBank(actorId, bank))) {
      throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
    }
    const canUse = await this.evaluator.hasCapability(actorId, 'question:useall', category.contextId).catch(() => false);
    if (!canUse) throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
  }

  /**
   * Truy nguồn chiều ngược của câu hỏi: các version đề đang chứa
   * câu này — cùng cổng đọc với attribution (không có cổng thì 404,
   * không lộ đề nào đang dùng câu).
   */
  async listContainingExams(actorId: string, questionId: string) {
    await this.assertQuestionReadableByViewer(actorId, questionId);
    return this.repo.listContainingExams(questionId);
  }

  /**
   * Deep copy thuần (không kiểm quyền — caller chịu trách nhiệm cổng):
   * danh tính MỚI + version 1 trọn nội dung version mới nhất của câu
   * nguồn (answers, options theo qtype, stimulus, gắn kết chương trình),
   * truy vết `derived_from_*` + `original_author_id` giữ nguyên qua các
   * đời copy; tăng copy_count cho câu nguồn và phát `question_copied`.
   * Sau copy hai bản độc lập tuyệt đối.
   */
  async deepCopyQuestion(actorId: string, source: QuestionView, targetCategory: QCategoryRow): Promise<QuestionView> {
    const sourceQ = source.question;
    const sourceVersion = source.latestVersion;
    const sourceCategory = await this.questionsRepo.getCategory(sourceQ.category);
    const sourceBank = sourceCategory ? await this.findBankForCategory(sourceCategory) : null;
    let created!: { q: QuestionRow; entryId: string; versionId: string };
    // Điểm mở giao dịch ở QuestionsRepository phía Kysely (issue
    // #642): callback chỉ ghi qua questionsRepo + cloneVersionContentTx
    // nên nguyên tử giữ nguyên — một database, một giao dịch Kysely.
    await this.questionsRepo.transaction(async (tx) => {
      // Stimulus là thực thể dùng chung theo category: cùng category thì
      // dùng chung tiếp; khác category thì sao một bản vào category đích.
      let stimulusId: string | null = null;
      if (sourceVersion.stimulusId) {
        const stimulus = await this.questionsRepo.getStimulus(sourceVersion.stimulusId);
        if (stimulus) {
          stimulusId = stimulus.categoryId === targetCategory.id
            ? stimulus.id
            : (await this.questionsRepo.insertStimulus({ categoryId: targetCategory.id, createdBy: actorId, content: stimulus.content as never }, tx)).id;
        }
      }
      const q = await this.questionsRepo.insertQuestion({
        category: targetCategory.id, qtype: sourceQ.qtype,
        createdBy: actorId, modifiedBy: actorId,
        derivedFromQuestionId: sourceQ.id,
        derivedFromVersionId: sourceVersion.id,
        derivedFromBankId: sourceBank?.id ?? null,
        originalAuthorId: sourceQ.originalAuthorId ?? sourceQ.createdBy,
        // Nguồn ngoài hệ thống được kế thừa nguyên qua copy (nguồn gốc
        // của câu không đổi khi câu di chuyển giữa các bank).
        sourceKind: sourceQ.sourceKind ?? null,
        sourceRef: sourceQ.sourceRef ?? null,
        copyCount: 0,
      }, tx);
      const entry = await this.questionsRepo.insertEntry({
        questionCategoryId: targetCategory.id, questionId: q.id, latestVersion: 1, status: 'ready',
      }, tx);
      const version = await this.questionsRepo.insertVersion({
        questionBankEntryId: entry.id, questionId: q.id, version: 1,
        questionText: sourceVersion.questionText as never,
        generalFeedback: sourceVersion.generalFeedback as never,
        defaultMark: sourceVersion.defaultMark, penalty: sourceVersion.penalty,
        stimulusId,
      }, tx);
      // cloneVersionContentTx nhân bản cả bản ghi phía đáp án
      // (guidance + solution) của version nguồn — xem QuestionsService.
      await this.questions.cloneVersionContentTx(tx, sourceQ.qtype as SupportedQtype, sourceVersion.id, version.id);
      for (const link of await this.questionsRepo.listQuestionSubjectLinks(sourceQ.id)) {
        await this.questionsRepo.insertQuestionSubjectLink({ questionId: q.id, subjectId: link.subjectId }, tx);
      }
      for (const link of await this.questionsRepo.listQuestionOutcomeLinks(sourceQ.id)) {
        await this.questionsRepo.insertQuestionOutcomeLink({
          questionId: q.id, learningOutcomeId: link.learningOutcomeId, cognitiveLevel: link.cognitiveLevel,
        }, tx);
      }
      created = { q, entryId: entry.id, versionId: version.id };
    });
    await this.questionsRepo.updateQuestion(sourceQ.id, { copyCount: sourceQ.copyCount + 1 });
    await this.outbox.enqueueStandalone({
      aggregate: 'question', type: 'question_copied',
      payload: {
        sourceQuestionId: sourceQ.id, newQuestionId: created.q.id, actorId,
        sourceBankId: sourceBank?.id ?? null, targetCategoryId: targetCategory.id,
        originalAuthorId: sourceQ.originalAuthorId ?? sourceQ.createdBy,
      },
    });
    return this.questions.getQuestion(created.q.id);
  }

  /** Cổng copy phía nguồn: câu phải xem được (useall tại bank/context nguồn) + có `question:copy`; câu đã rút chỉ tác giả/người duyệt mới copy tiếp được. */
  private async assertCanCopySource(actorId: string, source: QuestionView): Promise<void> {
    const sourceQ = source.question;
    const category = await this.questionsRepo.getCategory(sourceQ.category);
    const bank = category ? await this.findBankForCategory(category) : null;
    const capCtx = bank?.contextId ?? category?.contextId;
    if (bank) await this.syncMembership(bank);
    // Câu trong bank personal của người khác không phải nguồn copy của
    // đồng nghiệp (issue #123) — dù question:copy kế thừa có đạt.
    if (bank && (await this.isForeignPersonalBank(actorId, bank))) {
      throw new ForbiddenException({ message: 'Question is not visible to you', code: 'question.copy_source_forbidden' });
    }
    const isAdmin = await this.evaluator.isSiteAdmin(actorId);
    if (!isAdmin && capCtx) {
      const [canUse, canCopy] = await Promise.all([
        this.evaluator.hasCapability(actorId, 'question:useall', capCtx),
        this.evaluator.hasCapability(actorId, 'question:copy', capCtx),
      ]);
      if (!canUse && sourceQ.createdBy !== actorId) {
        throw new ForbiddenException({ message: 'Question is not visible to you', code: 'question.copy_source_forbidden' });
      }
      if (!canCopy) {
        throw new ForbiddenException({ message: 'Missing capability question:copy at the source bank', code: 'question.copy_forbidden' });
      }
    }
    if (source.entry.status === 'hidden' && !isAdmin && sourceQ.createdBy !== actorId) {
      const canModerate = capCtx ? await this.evaluator.hasCapability(actorId, 'question:moderate', capCtx) : false;
      if (!canModerate) {
        throw new ForbiddenException({ message: 'Question has been withdrawn from its bank', code: 'question.withdrawn' });
      }
    }
  }

  /**
   * Copy một câu về một bank đích (QB-2): đích mặc định là ngân hàng cá
   * nhân của người copy; category đích mặc định là category mặc định
   * của bank đích. Cổng đích: `question:add` tại context của category đích.
   */
  async copyQuestion(actorId: string, questionId: string, input: { targetBankId?: string; targetCategoryId?: string }): Promise<QuestionView & { attribution: AttributionView }> {
    const source = await this.questions.getQuestion(questionId);
    await this.assertCanCopySource(actorId, source);
    const targetBank = input.targetBankId
      ? await this.getBankOrThrow(input.targetBankId)
      : await this.ensurePersonalBank(actorId, 'question', { forCopy: true });
    // Đích copy là bank personal của người khác → 404 như bank không có (issue #123).
    await this.assertNotForeignPersonalBank(actorId, targetBank);
    await this.syncMembership(targetBank);
    let targetCategory: QCategoryRow;
    if (input.targetCategoryId) {
      targetCategory = await this.questions.getCategory(input.targetCategoryId);
      if (!(await this.categoryBelongsToBank(targetCategory, targetBank))) {
        throw new BadRequestException({ message: 'Target category does not belong to the target bank', code: 'question.copy_target_category_mismatch' });
      }
    } else {
      targetCategory = await this.defaultCategoryOfBank(targetBank);
    }
    await this.evaluator.requireCapability(actorId, 'question:add', targetCategory.contextId);
    const view = await this.deepCopyQuestion(actorId, source, targetCategory);
    return { ...view, attribution: await this.getAttribution(view.question.id) };
  }

  /** Copy hàng loạt theo lựa chọn: từng câu độc lập, lỗi của một câu không chặn các câu còn lại. */
  async copyQuestionsBatch(actorId: string, input: { questionIds: string[]; targetBankId?: string; targetCategoryId?: string }): Promise<{
    results: { questionId: string; ok: boolean; newQuestionId?: string; error?: string }[];
  }> {
    const results: { questionId: string; ok: boolean; newQuestionId?: string; error?: string }[] = [];
    for (const questionId of input.questionIds) {
      try {
        const view = await this.copyQuestion(actorId, questionId, {
          targetBankId: input.targetBankId, targetCategoryId: input.targetCategoryId,
        });
        results.push({ questionId, ok: true, newQuestionId: view.question.id });
      } catch (err) {
        results.push({ questionId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { results };
  }

  // --- QB-3: rút câu + xoá vật lý có guard ------------------------------------------------

  /** Cổng rút/khôi phục/xoá: tác giả của câu, hoặc moderate/editall tại bank (hay context category khi chưa có bank). */
  private async assertCanGovernQuestion(actorId: string, questionId: string): Promise<{ q: QuestionRow; category: QCategoryRow; bank: QuestionBankRow | null }> {
    const q = await this.questionsRepo.getQuestion(questionId);
    if (!q) throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
    const category = await this.questions.getCategory(q.category);
    const bank = await this.findBankForCategory(category);
    if (bank) await this.syncMembership(bank);
    if (q.createdBy === actorId || (await this.evaluator.isSiteAdmin(actorId))) return { q, category, bank };
    // Câu thuộc bank personal của người khác: đồng nghiệp không govern
    // được dù moderate/editall kế thừa tại context bank đó (issue #123).
    if (bank && (await this.isForeignPersonalBank(actorId, bank))) {
      throw new ForbiddenException({ message: 'Only the author or a bank moderator can govern this question', code: 'question.govern_forbidden' });
    }
    const capCtx = bank?.contextId ?? category.contextId;
    const [moderate, editall] = await Promise.all([
      this.evaluator.hasCapability(actorId, 'question:moderate', capCtx),
      this.evaluator.hasCapability(actorId, 'question:editall', capCtx),
    ]);
    if (!moderate && !editall) {
      throw new ForbiddenException({ message: 'Only the author or a bank moderator can govern this question', code: 'question.govern_forbidden' });
    }
    return { q, category, bank };
  }

  /**
   * Rút câu khỏi bank chung (QB-3): cấm xoá vật lý khi còn tham chiếu —
   * thay bằng trạng thái `hidden` (mất khỏi khám phá, không thêm mới vào
   * đề; version đã ghim vẫn phục vụ đề hiện hữu). Lý do bắt buộc; sự
   * kiện `question_withdrawn` mang danh sách quiz đang dùng câu để phía
   * thông báo xử lý tiếp.
   */
  async withdrawQuestion(actorId: string, questionId: string, reason: string): Promise<{ questionId: string; status: string; affectedPinIds: string[] }> {
    const { q, bank } = await this.assertCanGovernQuestion(actorId, questionId);
    const entry = await this.questionsRepo.getEntryByQuestion(questionId);
    if (!entry) throw new NotFoundException({ message: `Question ${questionId} has no bank entry`, code: 'question.entry_missing' });
    if (entry.status === 'hidden') {
      throw new ConflictException({ message: 'Question is already withdrawn', code: 'question.already_withdrawn' });
    }
    const affectedPinIds = await this.repo.listPinIdsUsingQuestion(questionId);
    await this.repo.updateEntry(entry.id, {
      status: 'hidden', withdrawnReason: reason, withdrawnBy: actorId, withdrawnAt: new Date(),
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'question', type: 'question_withdrawn',
      payload: { questionId, bankId: bank?.id ?? null, reason, actorId, affectedPinIds, authorId: q.createdBy },
    });
    return { questionId, status: 'hidden', affectedPinIds };
  }

  /** Hoàn rút câu: trạng thái về `ready`, xoá truy vết rút. */
  async restoreQuestion(actorId: string, questionId: string): Promise<{ questionId: string; status: string }> {
    await this.assertCanGovernQuestion(actorId, questionId);
    const entry = await this.questionsRepo.getEntryByQuestion(questionId);
    if (!entry) throw new NotFoundException({ message: `Question ${questionId} has no bank entry`, code: 'question.entry_missing' });
    if (entry.status !== 'hidden') {
      throw new ConflictException({ message: 'Question is not withdrawn', code: 'question.not_withdrawn' });
    }
    await this.repo.updateEntry(entry.id, {
      status: 'ready', withdrawnReason: null, withdrawnBy: null, withdrawnAt: null,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'question', type: 'question_restored',
      payload: { questionId, actorId },
    });
    return { questionId, status: 'ready' };
  }

  /**
   * Xoá vật lý một câu hỏi — CHỈ khi chưa từng được dùng: còn slot đề
   * hoặc attempt tham chiếu thì 409 và hướng sang rút câu (hidden).
   */
  async deleteQuestion(actorId: string, questionId: string): Promise<{ deleted: true }> {
    await this.assertCanGovernQuestion(actorId, questionId);
    const [slotPinIds, attempts] = await Promise.all([
      this.repo.listPinIdsUsingQuestion(questionId),
      this.repo.countAttemptsOfQuestion(questionId),
    ]);
    if (slotPinIds.length > 0 || attempts > 0) {
      throw new ConflictException({
        message: 'Question is referenced by exam slots or attempts and cannot be deleted; withdraw it instead',
        code: 'question.delete_blocked_in_use',
      });
    }
    await this.repo.deleteQuestionRow(questionId);
    await this.outbox.enqueueStandalone({
      aggregate: 'question', type: 'question_deleted',
      payload: { questionId, actorId },
    });
    return { deleted: true };
  }

  // --- QB-4: đóng góp vào bank chung --------------------------------------------------------

  /** Chuẩn hoá văn bản cho hash chống trùng: bóc về chữ thường, gộp khoảng trắng. */
  private normaliseForHash(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Hash nội dung của một version: sha256 trên (qtype + thân câu đã
   * chuẩn hoá + tập đáp án kèm cờ đúng/sai đã sắp xếp). Hai câu trùng hoàn
   * toàn có cùng hash; trùng thân câu khác đáp án cho textHash trùng —
   * gần trùng để cảnh báo người duyệt.
   */
  /**
   * Hash nội dung từ DỮ KIỆN THÔ (thân câu + đáp án dạng text thuần) —
   * công thức hash QB-4 dùng chung cho version đã lưu (versionHashes)
   * và payload chưa lưu (findDuplicatesForPayload của đường nạp MCP),
   * để hai đường không bao giờ lệch nhau. Chuẩn hoá NFC trước khi băm
   * (hồ sơ research MCP Phần 3.1 lớp 3: dấu tiếng Việt dạng tổ hợp
   * không lách được chống trùng).
   */
  private contentHashes(qtype: string, textPlain: string, answers: { textPlain: string; isCorrect: boolean }[]): { hash: string; textHash: string } {
    const textPart = this.normaliseForHash(textPlain.normalize('NFC'));
    const answerPart = answers
      .map((a) => `${this.normaliseForHash(a.textPlain.normalize('NFC'))}:${a.isCorrect ? 1 : 0}`)
      .sort()
      .join('|');
    const hash = createHash('sha256').update(`${qtype}|${textPart}|${answerPart}`).digest('hex');
    const textHash = createHash('sha256').update(`${qtype}|${textPart}`).digest('hex');
    return { hash, textHash };
  }

  private async versionHashes(qtype: string, versionId: string, questionText: unknown): Promise<{ hash: string; textHash: string }> {
    // Câu truefalse TF-A không có dòng đáp án thông thường: dữ kiện
    // băm là từng mệnh đề kèm giá trị Đúng/Sai lấy từ bản ghi phía đáp
    // án của version (issue #316), ghép bằng cùng hàm dùng chung với
    // đường payload MCP để hai đường không lệch nhau.
    if (qtype === 'truefalse') {
      const key = await this.questionsRepo.getAnswerKey(versionId);
      return this.contentHashes(
        qtype,
        extractRichTextPlainText(questionText as RichTextDocument),
        truefalseHashAnswers(questionText, key?.solution),
      );
    }
    const answers = await this.questionsRepo.listAnswers(versionId);
    return this.contentHashes(
      qtype,
      extractRichTextPlainText(questionText as RichTextDocument),
      answers.map((a) => ({ textPlain: extractRichTextPlainText(a.answer as RichTextDocument), isCorrect: a.isCorrect })),
    );
  }

  /** Quét bank đích tìm câu trùng hoàn toàn (cùng hash) / gần trùng (cùng thân câu) với một bộ hash nguồn. */
  private async scanDuplicatesInBank(bank: QuestionBankRow, source: { hash: string; textHash: string }): Promise<{ exactId: string | null; nearId: string | null }> {
    // Quét MỌI category thuộc bank theo phép suy thống nhất (kể cả
    // category khoá hiện hữu không gắn bank_id) — trước đây chỉ quét
    // category gắn bank_id tường minh nên chống trùng sót câu khoá.
    // Phép suy chạy theo lô (DL-04, issue #489): nạp bank suy được
    // cho mọi category một lần thay vì kiểm từng category.
    const allCategories = await this.questionsRepo.listCategories();
    const inferredBankByCategory = await this.findBanksForCategories(allCategories);
    const categories = allCategories.filter((cat) => this.categoryMatchesBank(cat, bank, inferredBankByCategory));
    const rows = await this.repo.listQuestionsWithEntryInCategories(categories.map((c) => c.id));
    let nearId: string | null = null;
    for (const { q, entry } of rows) {
      if (entry.status === 'hidden') continue;
      const version = await this.questionsRepo.getVersionByNumber(entry.id, entry.latestVersion);
      if (!version) continue;
      const candidate = await this.versionHashes(q.qtype, version.id, version.questionText);
      if (candidate.hash === source.hash) return { exactId: q.id, nearId };
      if (candidate.textHash === source.textHash && nearId === null) nearId = q.id;
    }
    return { exactId: null, nearId };
  }

  /** Chống trùng cho một version ĐÃ lưu (đường copy/đóng góp QB-4). */
  private async findDuplicatesInBank(bank: QuestionBankRow, qtype: string, sourceVersionId: string, sourceText: unknown): Promise<{ exactId: string | null; nearId: string | null }> {
    const source = await this.versionHashes(qtype, sourceVersionId, sourceText);
    return this.scanDuplicatesInBank(bank, source);
  }

  /**
   * Chống trùng cho payload CHƯA lưu — cổng tạo của đường nạp MCP
   * (issue #110): dùng ĐÚNG công thức hash + phép quét của QB-4 qua
   * `contentHashes`/`scanDuplicatesInBank`, payload chữ thuần được băm
   * trực tiếp (tương đương đường trích text từ tài liệu rich text vì
   * bước chuẩn hoá gộp mọi khoảng trắng về một dấu cách).
   */
  async findDuplicatesForPayload(bank: QuestionBankRow, payload: {
    qtype: string; questionText: string; answers: { text: string; correct: boolean }[];
  }): Promise<{ exactId: string | null; nearId: string | null }> {
    const source = this.contentHashes(payload.qtype, payload.questionText, payload.answers.map((a) => ({ textPlain: a.text, isCorrect: a.correct })));
    return this.scanDuplicatesInBank(bank, source);
  }

  /**
   * Đặt trạng thái của một câu (entry + version mới nhất) — đường nạp
   * ngoài hệ thống dùng để đưa câu mới tạo về `draft` (issue #110: câu
   * AI nạp vào LUÔN ở draft chờ giáo viên duyệt; REST tạo câu mặc định
   * `ready`) và để duyệt phát hành draft lên `ready`. Withdraw/restore
   * của QB-3 chỉ đổi entry (version giữ nguyên để slot đã ghim còn
   * phục vụ được); đường này đổi cả hai vì draft chưa từng được dùng.
   */
  async setQuestionStatus(questionId: string, status: 'draft' | 'ready'): Promise<void> {
    const entry = await this.questionsRepo.getEntryByQuestion(questionId);
    if (!entry) {
      throw new NotFoundException({ message: `Question ${questionId} has no bank entry`, code: 'question.entry_missing' });
    }
    // Luật READY (mô hình giaokhoa): câu chỉ được phát hành khi phần
    // đáp án của version mới nhất ĐẠT luật theo qtype — cùng luật mà
    // đường soạn kiểm lúc tạo/sửa, kiểm lại ở cổng phát hành vì câu
    // draft có thể được tạo qua các đường nạp không qua kiểm đó trọn
    // vẹn (vd nạp hàng loạt). Chuyển về draft không cần kiểm.
    if (status === 'ready') await this.assertReadyContent(questionId, entry.latestVersion);
    await this.questionsRepo.updateEntry(entry.id, { status });
    const version = await this.questionsRepo.getVersionByNumber(entry.id, entry.latestVersion);
    if (version) await this.questionsRepo.updateVersion(version.id, { status });
  }

  /**
   * Kiểm luật phía đáp án cho cổng phát hành `ready`: multichoice đúng
   * 4 lựa chọn + đúng 1 đáp án đúng; truefalse TF-A: thân câu chốt
   * đuôi bằng đúng 4 mệnh đề và đáp án từng mệnh đề ở bản ghi phía đáp
   * án phủ đúng tập mệnh đề đó; shortanswer ít nhất 1 đáp án và mọi
   * dòng đều được chấp nhận; essay không có yêu cầu phía đáp án (chấm
   * tay).
   *
   * @param questionId - câu sắp phát hành.
   * @param latestVersion - số version mới nhất trên entry của câu.
   * @throws BadRequestException `question.bad_answer_data` khi phần đáp
   *   án chưa đạt luật của qtype.
   */
  private async assertReadyContent(questionId: string, latestVersion: number): Promise<void> {
    const q = await this.questionsRepo.getQuestion(questionId);
    if (!q) {
      throw new NotFoundException({ message: `Question ${questionId} not found`, code: 'question.not_found' });
    }
    const entry = await this.questionsRepo.getEntryByQuestion(questionId);
    const version = entry ? await this.questionsRepo.getVersionByNumber(entry.id, latestVersion) : undefined;
    if (!version) {
      throw new NotFoundException({ message: `Question ${questionId} latest version missing`, code: 'question.version_missing' });
    }
    const answers = await this.questionsRepo.listAnswers(version.id);
    const correctCount = answers.filter((a) => a.isCorrect).length;
    const bad = (message: string): BadRequestException => new BadRequestException({ message, code: 'question.bad_answer_data' });
    if (q.qtype === 'multichoice') {
      if (answers.length !== 4) throw bad('A ready multichoice question needs exactly four choices');
      if (correctCount !== 1) throw bad('A ready multichoice question needs exactly one correct answer');
    } else if (q.qtype === 'truefalse') {
      const statements = getTrueFalseStatements(version.questionText as RichTextDocument);
      if (!statements || statements.length !== TRUE_FALSE_STATEMENT_COUNT) {
        throw bad('A ready truefalse question needs a stem ending with exactly four statements');
      }
      const key = await this.questionsRepo.getAnswerKey(version.id);
      const solution = key?.solution as { answers?: { statementId: string; value: boolean }[] } | null | undefined;
      const covered = new Set((solution?.answers ?? []).map((a) => a.statementId));
      if (covered.size !== statements.length || statements.some((s) => !covered.has(s.id))) {
        throw bad('A ready truefalse question needs a Đúng/Sai answer for every statement');
      }
    } else if (q.qtype === 'shortanswer') {
      if (answers.length === 0) throw bad('A ready shortanswer question needs at least one accepted answer');
      if (correctCount !== answers.length) throw bad('Every listed shortanswer answer must be an accepted answer');
    }
  }

  /**
   * Chuyển trạng thái draft ↔ ready qua đường web (màn soạn/duyệt câu
   * hỏi, issue #248): cùng nghiệp vụ `setQuestionStatus` mà đường MCP
   * dùng, thêm cổng govern như withdraw/restore (tác giả, moderator
   * hoặc editall tại context của bank; bank cá nhân của người khác bị
   * chặn). Câu đang `hidden` (đã rút) không chuyển qua đường này —
   * phải restore trước. Đổi trạng thái không tạo phiên bản mới.
   */
  async setQuestionStatusForActor(actorId: string, questionId: string, status: 'draft' | 'ready'): Promise<{ questionId: string; status: string }> {
    await this.assertCanGovernQuestion(actorId, questionId);
    const entry = await this.questionsRepo.getEntryByQuestion(questionId);
    if (!entry) {
      throw new NotFoundException({ message: `Question ${questionId} has no bank entry`, code: 'question.entry_missing' });
    }
    if (entry.status === 'hidden') {
      throw new ConflictException({ message: 'Question is withdrawn; restore it before changing its publish status', code: 'question.status_withdrawn' });
    }
    if (entry.status !== status) {
      await this.setQuestionStatus(questionId, status);
      await this.outbox.enqueueStandalone({
        aggregate: 'question', type: status === 'ready' ? 'question_published' : 'question_unpublished',
        payload: { questionId, actorId },
      });
    }
    return { questionId, status };
  }

  /**
   * Đề xuất đóng góp một câu vào bank đích (QB-4): cần `question:share`
   * tại bank/context nguồn; câu phải ở trạng thái `ready`; trùng hoàn
   * toàn trong bank đích thì chặn ngay và trỏ câu đã có; gần trùng thì
   * gắn cờ cho người duyệt. Mode 'update' yêu cầu câu nguồn là bản copy
   * suy từ chính câu đích (liên kết derived_from).
   */
  async proposeContribution(actorId: string, targetBankId: string, input: {
    questionId: string; note?: string; mode?: string; targetQuestionId?: string;
  }): Promise<ContributionRow> {
    const bank = await this.getBankOrThrow(targetBankId);
    if (bank.scope === 'personal') {
      throw new BadRequestException({ message: 'Cannot contribute to a personal bank', code: 'question.contribution_target_personal' });
    }
    await this.syncMembership(bank);
    const source = await this.questions.getQuestion(input.questionId);
    const sourceCategory = await this.questionsRepo.getCategory(source.question.category);
    const sourceBank = sourceCategory ? await this.findBankForCategory(sourceCategory) : null;
    // Nguồn đóng góp thuộc bank personal của người khác → câu "không
    // tồn tại" đối với người đề xuất (issue #123 vòng 2): đóng góp là
    // đường đưa nội dung bank riêng lên bank chung, chỉ chủ sở hữu mới
    // đề xuất được câu của chính mình; đồng nghiệp không rút được nội
    // dung riêng của người khác qua đường này dù có question:share.
    if (sourceBank && (await this.isForeignPersonalBank(actorId, sourceBank))) {
      throw new NotFoundException({ message: `Question ${input.questionId} not found`, code: 'question.not_found' });
    }
    const shareCtx = sourceBank?.contextId ?? sourceCategory?.contextId;
    if (shareCtx) {
      if (sourceBank) await this.syncMembership(sourceBank);
      await this.evaluator.requireCapability(actorId, 'question:share', shareCtx);
    }
    if (source.entry.status !== 'ready') {
      throw new BadRequestException({ message: 'Only a ready question can be contributed', code: 'question.contribution_source_not_ready' });
    }
    const mode = input.mode ?? 'new';
    if (mode !== 'new' && mode !== 'update') {
      throw new BadRequestException({ message: `Unknown contribution mode ${mode}`, code: 'question.contribution_mode_invalid' });
    }
    let nearDuplicateOf: string | null = null;
    if (mode === 'update') {
      if (!input.targetQuestionId) {
        throw new BadRequestException({ message: 'targetQuestionId is required for an update contribution', code: 'question.contribution_target_required' });
      }
      const target = await this.questions.getQuestion(input.targetQuestionId);
      const targetCategory = await this.questionsRepo.getCategory(target.question.category);
      if (!targetCategory || !(await this.categoryBelongsToBank(targetCategory, bank))) {
        throw new BadRequestException({ message: 'Target question does not belong to the target bank', code: 'question.contribution_target_not_in_bank' });
      }
      if (source.question.derivedFromQuestionId !== input.targetQuestionId) {
        throw new BadRequestException({ message: 'An update contribution must come from a copy derived from the target question', code: 'question.contribution_not_derived' });
      }
    } else {
      const dup = await this.findDuplicatesInBank(bank, source.question.qtype, source.latestVersion.id, source.latestVersion.questionText);
      if (dup.exactId) {
        throw new ConflictException({
          message: `An identical question already exists in the target bank: ${dup.exactId}`,
          code: 'question.duplicate_in_bank',
        });
      }
      nearDuplicateOf = dup.nearId;
    }
    const pending = await this.repo.listContributions({ targetBankId: bank.id, status: 'pending', proposerId: actorId });
    if (pending.some((c) => c.questionId === input.questionId && c.mode === mode && c.targetQuestionId === (input.targetQuestionId ?? null))) {
      throw new ConflictException({ message: 'An identical pending contribution already exists', code: 'question.contribution_pending_exists' });
    }
    const { hash } = await this.versionHashes(source.question.qtype, source.latestVersion.id, source.latestVersion.questionText);
    const row = await this.repo.insertContribution({
      questionId: input.questionId, targetBankId: bank.id,
      targetQuestionId: input.targetQuestionId ?? null,
      proposerId: actorId, note: input.note ?? '', mode,
      status: 'pending', contentHash: hash, nearDuplicateOf,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'question_bank', type: 'question_contribution_proposed',
      payload: { contributionId: row.id, targetBankId: bank.id, questionId: input.questionId, mode, proposerId: actorId, nearDuplicateOf },
    });
    return row;
  }

  /** Hàng chờ đóng góp của một bank: người duyệt thấy tất cả; người khác chỉ thấy đề xuất của mình. */
  async listContributions(actorId: string, bankId: string, status?: string): Promise<(ContributionRow & { proposerName: string | null; questionName: string | null })[]> {
    const bank = await this.getBankOrThrow(bankId);
    await this.assertNotForeignPersonalBank(actorId, bank);
    await this.syncMembership(bank);
    const canModerate = await this.evaluator.hasCapability(actorId, 'question:moderate', bank.contextId);
    const rows = await this.repo.listContributions({
      targetBankId: bank.id, status,
      proposerId: canModerate ? undefined : actorId,
    });
    const names = await this.repo.getUserDisplayNames(rows.map((r) => r.proposerId));
    const out: (ContributionRow & { proposerName: string | null; questionName: string | null })[] = [];
    for (const row of rows) {
      const q = await this.questionsRepo.getQuestion(row.questionId);
      // Câu hỏi không còn trường tên (quyết 12:04 ngày 26/10/2026):
      // nhãn hiển thị của đề xuất là TRÍCH ĐOẠN nội dung thân câu của
      // version mới nhất, cắt ở 120 ký tự.
      let questionName: string | null = null;
      if (q) {
        const entry = await this.questionsRepo.getEntryByQuestion(q.id);
        const version = entry ? await this.questionsRepo.getVersionByNumber(entry.id, entry.latestVersion) : undefined;
        if (version) {
          const text = extractRichTextPlainText(version.questionText as RichTextDocument).trim();
          questionName = text.length > 120 ? `${text.slice(0, 120)}…` : text;
        }
      }
      out.push({ ...row, proposerName: names.get(row.proposerId) ?? null, questionName });
    }
    return out;
  }

  /** Sao stimulus của version nguồn vào category đích trong giao dịch (dùng khi duyệt bản mới). */
  private async copyStimulusForCategory(tx: QuestionsTx, sourceStimulusId: string | null, targetCategoryId: string, actorId: string): Promise<string | null> {
    if (!sourceStimulusId) return null;
    const stimulus = await this.questionsRepo.getStimulus(sourceStimulusId);
    if (!stimulus) return null;
    if (stimulus.categoryId === targetCategoryId) return stimulus.id;
    const copy = await this.questionsRepo.insertStimulus(
      { categoryId: targetCategoryId, createdBy: actorId, content: stimulus.content as never }, tx);
    return copy.id;
  }

  /**
   * Duyệt một đề xuất (QB-4, cổng `question:moderate` tại bank đích):
   * - mode 'new': COPY câu nguồn vào bank đích bằng cơ chế deep copy của
   *   QB-2 (danh tính mới, derived_from trỏ về câu gốc, ghi công tác giả).
   * - mode 'update': tạo VERSION MỚI trên chính danh tính câu đích từ
   *   nội dung version mới nhất của câu nguồn.
   */
  async approveContribution(actorId: string, bankId: string, contributionId: string, input: { targetCategoryId?: string }): Promise<ContributionRow> {
    const bank = await this.getBankOrThrow(bankId);
    await this.syncMembership(bank);
    await this.evaluator.requireCapability(actorId, 'question:moderate', bank.contextId);
    const contribution = await this.repo.getContribution(contributionId);
    if (!contribution || contribution.targetBankId !== bank.id) {
      throw new NotFoundException({ message: `Contribution ${contributionId} not found`, code: 'question.contribution_not_found' });
    }
    if (contribution.status !== 'pending') {
      throw new ConflictException({ message: 'Contribution is no longer pending', code: 'question.contribution_not_pending' });
    }
    const source = await this.questions.getQuestion(contribution.questionId);
    let resultQuestionId: string;
    if (contribution.mode === 'update') {
      const targetView = await this.questions.getQuestion(contribution.targetQuestionId!);
      const targetCategory = await this.questions.getCategory(targetView.question.category);
      const nextVersion = targetView.entry.latestVersion + 1;
      // Điểm mở giao dịch ở QuestionsRepository phía Kysely (issue
      // #642) như deepCopyQuestion: callback chỉ ghi qua questionsRepo
      // + cloneVersionContentTx, nguyên tử không đổi.
      await this.questionsRepo.transaction(async (tx) => {
        const stimulusId = await this.copyStimulusForCategory(tx, source.latestVersion.stimulusId, targetCategory.id, actorId);
        const version = await this.questionsRepo.insertVersion({
          questionBankEntryId: targetView.entry.id, questionId: targetView.question.id, version: nextVersion,
          questionText: source.latestVersion.questionText as never,
          generalFeedback: source.latestVersion.generalFeedback as never,
          defaultMark: source.latestVersion.defaultMark, penalty: source.latestVersion.penalty,
          stimulusId,
        }, tx);
        // cloneVersionContentTx nhân bản cả bản ghi phía đáp án
        // (guidance + solution) của version nguồn sang version mới.
        await this.questions.cloneVersionContentTx(tx, targetView.question.qtype as SupportedQtype, source.latestVersion.id, version.id);
      });
      await this.questionsRepo.updateEntry(targetView.entry.id, { latestVersion: nextVersion });
      await this.questionsRepo.updateQuestion(targetView.question.id, { modifiedBy: actorId });
      resultQuestionId = targetView.question.id;
    } else {
      const dup = await this.findDuplicatesInBank(bank, source.question.qtype, source.latestVersion.id, source.latestVersion.questionText);
      if (dup.exactId && dup.exactId !== contribution.questionId) {
        throw new ConflictException({
          message: `An identical question already exists in the target bank: ${dup.exactId}`,
          code: 'question.duplicate_in_bank',
        });
      }
      let targetCategory: QCategoryRow;
      if (input.targetCategoryId) {
        targetCategory = await this.questions.getCategory(input.targetCategoryId);
        if (!(await this.categoryBelongsToBank(targetCategory, bank))) {
          throw new BadRequestException({ message: 'Target category does not belong to the target bank', code: 'question.copy_target_category_mismatch' });
        }
      } else {
        targetCategory = await this.defaultCategoryOfBank(bank);
      }
      const view = await this.deepCopyQuestion(actorId, source, targetCategory);
      resultQuestionId = view.question.id;
    }
    await this.repo.updateContribution(contribution.id, {
      status: 'approved', reviewerId: actorId, resultQuestionId,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'question_bank', type: 'question_contribution_approved',
      payload: {
        contributionId: contribution.id, targetBankId: bank.id, questionId: contribution.questionId,
        mode: contribution.mode, resultQuestionId, reviewerId: actorId, proposerId: contribution.proposerId,
      },
    });
    return (await this.repo.getContribution(contribution.id))!;
  }

  /** Từ chối một đề xuất: lý do bắt buộc để giáo viên sửa và đề xuất lại. */
  async rejectContribution(actorId: string, bankId: string, contributionId: string, reason: string): Promise<ContributionRow> {
    const bank = await this.getBankOrThrow(bankId);
    await this.syncMembership(bank);
    await this.evaluator.requireCapability(actorId, 'question:moderate', bank.contextId);
    const contribution = await this.repo.getContribution(contributionId);
    if (!contribution || contribution.targetBankId !== bank.id) {
      throw new NotFoundException({ message: `Contribution ${contributionId} not found`, code: 'question.contribution_not_found' });
    }
    if (contribution.status !== 'pending') {
      throw new ConflictException({ message: 'Contribution is no longer pending', code: 'question.contribution_not_pending' });
    }
    await this.repo.updateContribution(contribution.id, {
      status: 'rejected', reviewerId: actorId, rejectReason: reason,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'question_bank', type: 'question_contribution_rejected',
      payload: {
        contributionId: contribution.id, targetBankId: bank.id, questionId: contribution.questionId,
        reviewerId: actorId, proposerId: contribution.proposerId, reason,
      },
    });
    return (await this.repo.getContribution(contribution.id))!;
  }

  // --- QB-4: khám phá ------------------------------------------------------------------------

  /**
   * Trang khám phá ngân hàng (QB-4): câu hỏi trong các bank actor vào
   * được, lọc theo bank / môn / node chương trình / YCCĐ / mức / dạng
   * câu / từ khoá / tác giả; câu không ở trạng thái `ready` chỉ tác giả
   * hoặc người duyệt của bank mới thấy; sắp xếp mặc định theo use_count
   * giảm dần. Mỗi dòng mang tín hiệu use_count + copy_count và truy vết
   * tác giả để UI hiển thị + hành động tại dòng.
   */
  async discover(actorId: string, filter: {
    bankId?: string; subjectId?: string; nodeId?: string; outcomeId?: string;
    cognitiveLevel?: string; qtype?: string; keyword?: string; authorId?: string;
  }): Promise<DiscoveryItem[]> {
    const banks = await this.listBanks(actorId);
    const bankById = new Map(banks.map((b) => [b.id, b]));
    if (filter.bankId && !bankById.has(filter.bankId)) {
      throw new ForbiddenException({ message: `No access to question bank ${filter.bankId}`, code: 'question.bank_forbidden' });
    }
    const activeBanks = filter.bankId ? [bankById.get(filter.bankId)!] : banks;
    const moderatorByBank = new Map<string, boolean>();
    for (const b of activeBanks) moderatorByBank.set(b.id, b.capabilities.moderate);

    // Category của các bank đang xét theo phép suy thống nhất
    // categoryBelongsToBank (kể cả category khoá hiện hữu không gắn
    // bank_id — trước đây chỉ khớp bank_id tường minh hoặc context
    // trùng context bank nên khám phá sót toàn bộ câu khoá). Phép suy
    // chạy theo lô (DL-04, issue #489): bank của mọi category được
    // suy một lần, rồi mỗi category gán cho bank ĐẦU TIÊN trong
    // activeBanks khớp phép suy — đúng thứ tự thắng của vòng lặp cặp
    // category × bank trước đây.
    const allCategories = await this.questionsRepo.listCategories();
    const inferredBankByCategory = await this.findBanksForCategories(allCategories);
    const categoryBank = new Map<string, QuestionBankRow>();
    for (const cat of allCategories) {
      const matchIds = new Set<string>();
      if (cat.bankId) {
        matchIds.add(cat.bankId);
      } else {
        for (const bank of activeBanks) {
          if (bank.contextId === cat.contextId) matchIds.add(bank.id);
        }
        const inferred = inferredBankByCategory.get(cat.id);
        if (inferred) matchIds.add(inferred.id);
      }
      const winner = activeBanks.find((b) => matchIds.has(b.id));
      if (winner) categoryBank.set(cat.id, winner);
    }
    let rows = await this.repo.listQuestionsWithEntryInCategories([...categoryBank.keys()]);

    // Lọc theo gắn kết chương trình (giao nhau — AND — như cổng lọc A.6).
    if (filter.subjectId !== undefined || filter.outcomeId !== undefined || filter.cognitiveLevel !== undefined) {
      const linked = await this.questionsRepo.filterQuestionsByCurriculumLinks({
        subjectId: filter.subjectId, outcomeId: filter.outcomeId, cognitiveLevel: filter.cognitiveLevel,
      });
      const ids = new Set(linked.map((q) => q.id));
      rows = rows.filter((r) => ids.has(r.q.id));
    }
    // Dòng gắn YCCĐ của mọi câu trong tập đang xét nạp MỘT lần theo
    // lô (DL-04, issue #489): dùng cho cả bộ lọc theo node chương
    // trình ở ngay dưới lẫn trường outcomes của từng dòng kết quả.
    const outcomeLinksByQuestion = new Map<string, QuestionOutcomeLinkRow[]>();
    if (rows.length) {
      const allOutcomeLinks = await this.questionsRepo.listQuestionOutcomeLinksForQuestions(rows.map((r) => r.q.id));
      for (const link of allOutcomeLinks) {
        const list = outcomeLinksByQuestion.get(link.questionId) ?? [];
        list.push(link);
        outcomeLinksByQuestion.set(link.questionId, list);
      }
    }
    if (filter.nodeId !== undefined) {
      const outcomeIds = new Set(await this.repo.listOutcomeIdsForNode(filter.nodeId));
      rows = rows.filter((r) => (outcomeLinksByQuestion.get(r.q.id) ?? [])
        .some((l) => outcomeIds.has(l.learningOutcomeId)));
    }
    if (filter.qtype !== undefined) rows = rows.filter((r) => r.q.qtype === filter.qtype);
    if (filter.authorId !== undefined) {
      rows = rows.filter((r) => r.q.createdBy === filter.authorId || r.q.originalAuthorId === filter.authorId);
    }

    const useCounts = await this.repo.countSlotsByQuestionIds(rows.map((r) => r.q.id));
    const names = await this.repo.getUserDisplayNames(
      rows.flatMap((r) => [r.q.createdBy ?? '', r.q.originalAuthorId ?? '']),
    );
    // Version đích và dòng gắn môn của mọi câu còn lại cũng nạp theo
    // lô một lần (DL-04, issue #489) thay vì tra theo từng dòng như
    // trước; version của mỗi entry chọn đúng bản mang số version bằng
    // entry.latestVersion như `getVersionByNumber`.
    const versionByEntry = new Map<string, VersionRow>();
    const subjectLinksByQuestion = new Map<string, QuestionSubjectLinkRow[]>();
    if (rows.length) {
      const allVersions = await this.questionsRepo.listVersionsForEntries(rows.map((r) => r.entry.id));
      const wantedVersionByEntry = new Map(rows.map((r) => [r.entry.id, r.entry.latestVersion]));
      for (const v of allVersions) {
        if (wantedVersionByEntry.get(v.questionBankEntryId) === v.version) versionByEntry.set(v.questionBankEntryId, v);
      }
      const allSubjectLinks = await this.questionsRepo.listQuestionSubjectLinksForQuestions(rows.map((r) => r.q.id));
      for (const link of allSubjectLinks) {
        const list = subjectLinksByQuestion.get(link.questionId) ?? [];
        list.push(link);
        subjectLinksByQuestion.set(link.questionId, list);
      }
    }
    const keyword = filter.keyword?.toLowerCase();
    const out: DiscoveryItem[] = [];
    for (const { q, entry } of rows) {
      const bank = categoryBank.get(q.category)!;
      const privileged = q.createdBy === actorId || (moderatorByBank.get(bank.id) ?? false);
      if (entry.status !== 'ready' && !privileged) continue;
      const version = versionByEntry.get(entry.id);
      // Câu hỏi không còn trường tên: từ khoá chỉ khớp trên nội dung
      // thân câu, và nhãn hiển thị của dòng khám phá là trích đoạn
      // chính nội dung đó (cắt 120 ký tự).
      const textPlain = version ? extractRichTextPlainText(version.questionText as RichTextDocument).trim() : '';
      if (keyword && !textPlain.toLowerCase().includes(keyword)) continue;
      const subjectLinks = subjectLinksByQuestion.get(q.id) ?? [];
      const outcomeLinks = outcomeLinksByQuestion.get(q.id) ?? [];
      out.push({
        questionId: q.id, excerpt: textPlain.length > 120 ? `${textPlain.slice(0, 120)}…` : textPlain, qtype: q.qtype, status: entry.status,
        latestVersion: entry.latestVersion,
        idnumber: q.idnumber,
        bankId: bank.id, bankName: bank.name, bankScope: bank.scope,
        authorId: q.createdBy, authorName: q.createdBy ? (names.get(q.createdBy) ?? null) : null,
        originalAuthorId: q.originalAuthorId,
        originalAuthorName: q.originalAuthorId ? (names.get(q.originalAuthorId) ?? null) : null,
        derivedFromQuestionId: q.derivedFromQuestionId,
        useCount: useCounts.get(q.id) ?? 0,
        copyCount: q.copyCount,
        subjectIds: subjectLinks.map((l) => l.subjectId),
        outcomes: outcomeLinks.map((l) => ({ outcomeId: l.learningOutcomeId, cognitiveLevel: l.cognitiveLevel })),
      });
    }
    out.sort((a, b) => b.useCount - a.useCount || b.copyCount - a.copyCount);
    return out;
  }
}

/** Thông tin bank của một câu hỏi (QB-3): bank suy từ category của câu, trạng thái entry và các mốc version mới nhất / ready mới nhất. */
export interface QuestionBankInfo {
  bank: QuestionBankRow | null;
  bankExplicit: boolean;
  entryStatus: string;
  latestVersion: number;
  latestVersionId: string | null;
  latestReadyVersionId: string | null;
  latestReadyVersionNumber: number | null;
}

/** Một dòng của trang khám phá (QB-4): `excerpt` là trích đoạn nội dung thân câu — câu hỏi không có trường tên (quyết 12:04 ngày 26/10/2026). */
export interface DiscoveryItem {
  questionId: string;
  excerpt: string;
  qtype: string;
  status: string;
  latestVersion: number;
  idnumber: string | null;
  bankId: string;
  bankName: string;
  bankScope: string;
  authorId: string | null;
  authorName: string | null;
  originalAuthorId: string | null;
  originalAuthorName: string | null;
  derivedFromQuestionId: string | null;
  useCount: number;
  copyCount: number;
  subjectIds: string[];
  outcomes: { outcomeId: string; cognitiveLevel: string }[];
}
