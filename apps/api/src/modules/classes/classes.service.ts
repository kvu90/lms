import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type {
  AddRosterStudentResult,
  ClassJoinRequest as ClassJoinRequestView,
  ClassListItem,
  ClassOverview,
  ClassPublicView,
  ClassRosterImportReport,
  ClassRosterMember,
  ClassStaffRole,
  ClassStaffView,
  ClassSuspendedMember,
  ClassView,
  ClassViewerRole,
  CreateClass,
  JoinClassResult,
  RosterStudentIdentity,
  UpdateClass,
} from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import type { DbTx } from '../../db/database';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { CAP_ALLOW } from '../access/domain/permission';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import type { CourseRow } from '../courses/courses.repository';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { GroupsService } from '../groups/groups.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import { TenantsService } from '../tenants/tenants.service';
import { UsersService } from '../users/users.service';
import type { UserRow } from '../users/users.repository';
import { CLASS_WHOLE_GROUP_NAME, ClassesRepository, type ClassJoinRequestRow, type ClassRow } from './classes.repository';

export type { ClassRow };

/** Vai của chủ lớp tại context lớp (vai hệ thống sẵn có — hồ sơ mục 2.2). */
export const CLASS_OWNER_ROLE = 'editingteacher';
/** Ba vai hệ thống gán tại context lớp cho đồng GV — tương ứng đúng 3 quyền kiểu Azota (hồ sơ mục 2.2). */
export const CLASS_ASSIGNER_ROLE = 'classassigner';
export const CLASS_GRADER_ROLE = 'classgrader';
export const CLASS_ROSTER_MANAGER_ROLE = 'classrostermanager';

const CLASS_ROLE_DEFS = [
  { shortName: CLASS_ASSIGNER_ROLE, name: 'Class work assigner', description: 'Đồng GV được giao bài / tạo khoá trong lớp (quyền 1 kiểu Azota).' },
  { shortName: CLASS_GRADER_ROLE, name: 'Class grader', description: 'Đồng GV được xem và chấm bài trong các khoá của lớp (quyền 2 kiểu Azota).' },
  { shortName: CLASS_ROSTER_MANAGER_ROLE, name: 'Class roster manager', description: 'Đồng GV được quản lý danh sách học sinh của lớp (quyền 3 kiểu Azota).' },
] as const;

/**
 * Bộ capability vật chất hoá tại context lớp cho từng vai khi lớp được
 * tạo (khuôn qbankmember/qbanklead của ngân hàng): override chỉ tồn tại
 * ở ĐÚNG context lớp đó, và chỉ ai được gán vai tại context lớp mới
 * hưởng — quyền trên lớp không tự chảy sang lớp khác. `cohort:manage` đi
 * kèm quyền quản roster vì roster THỰC CHẤT là cohort_members của
 * backing cohort và đường ghi đi qua GroupsService.
 */
const CLASS_ROLE_GRANTS: Record<string, string[]> = {
  [CLASS_OWNER_ROLE]: [
    'class:view', 'class:update', 'class:delete', 'class:manageroster', 'class:assignwork', 'class:grade', 'class:share',
    'course:create', 'course:update', 'course:manageactivities', 'cohort:manage', 'cohort:view',
  ],
  [CLASS_ASSIGNER_ROLE]: ['class:view', 'class:assignwork', 'course:create', 'course:update', 'course:manageactivities'],
  [CLASS_GRADER_ROLE]: [
    'class:view', 'class:grade',
    'grade:viewall', 'grade:edit', 'assign:viewallsubmissions', 'assign:grade',
    'quiz:view', 'quiz:grade', 'quiz:viewreports',
  ],
  [CLASS_ROSTER_MANAGER_ROLE]: ['class:view', 'class:manageroster', 'cohort:manage', 'cohort:view'],
};

/** Bảng chữ mã tham gia tự báo danh: bỏ ký tự dễ nhầm (0/O, 1/I/L). */
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateJoinCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => JOIN_CODE_ALPHABET[b % JOIN_CODE_ALPHABET.length]).join('');
}

/** Hình dạng lớp ở bề mặt API; `joinCode` chỉ lộ cho người có quyền quản roster (bí mật như enrolment_key). Học phí (`fee*`, CLASS-3) là thông tin gói công khai của lớp nên đi kèm mọi hình dạng lớp. */
export function toClassDto(row: ClassRow, canSeeJoinCode: boolean): ClassView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    code: row.code,
    schoolYear: row.schoolYear,
    ownerId: row.ownerId,
    cohortId: row.cohortId,
    allowSelfReport: row.allowSelfReport,
    joinCode: canSeeJoinCode ? row.joinCode : null,
    joinAutoApprove: row.joinAutoApprove,
    onLeave: row.onLeave as ClassView['onLeave'],
    status: row.status as ClassView['status'],
    description: row.description,
    feeCost: row.feeCost,
    feeCurrency: row.feeCurrency,
    feePaymentAccountId: row.feePaymentAccountId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Đích thu học phí của một lớp (CLASS-3) — gói dữ kiện PaymentsService
 * cần để tạo payment `class_fee`: tenant sở hữu lớp (căn cứ chọn tài
 * khoản nhận + cổng tenant của payment), số tiền và đơn vị tiền của gói.
 * Trả về từ `resolveClassFeePurchase` sau khi đã qua mọi cổng phía lớp.
 */
export interface ClassFeeTarget {
  classId: string;
  tenantId: string;
  feeCost: number;
  feeCurrency: string;
  feePaymentAccountId: string | null;
}

@Injectable()
/**
 * Nghiệp vụ lớp học hạng nhất (issue #184, CLASS-0).
 *
 * Bất biến của lát nền:
 *  - Lớp sở hữu đúng một backing cohort; roster của lớp ≡ cohort_members
 *    của cohort đó — KHÔNG có bảng thành viên thứ hai. Mọi thay đổi
 *    roster đi qua GroupsService.addCohortMember/removeCohortMember để
 *    dùng chung một đường phát sự kiện (in-process + outbox) cho cohort
 *    sync vật chất hoá xuống từng khoá.
 *  - Context lớp (CLASS=45) là cha của context các khoá trong lớp; quyền
 *    tại lớp chảy xuống khoá qua cây path của PermissionEvaluator.
 *  - Khoá tạo trong lớp tự có group "cả lớp" + enrol instance cohort
 *    (qua móc CourseClassHook đăng ký vào CoursesService).
 */
export class ClassesService implements OnModuleInit {
  constructor(
    private readonly repo: ClassesRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly roles: RolesService,
    private readonly courses: CoursesService,
    private readonly groups: GroupsService,
    private readonly enrol: EnrolService,
    private readonly users: UsersService,
    private readonly tenants: TenantsService,
    private readonly tenantContext: TenantContextService,
    private readonly outbox: OutboxService,
  ) {}

  /** Đăng ký neo lớp vào đường tạo khoá của CoursesService (dependency inversion — Courses không import Classes). */
  onModuleInit(): void {
    this.courses.registerClassHook({
      resolveClass: (classId, tenantId) => this.resolveClass(classId, tenantId),
      onCourseCreated: (course) => this.onCourseCreated(course),
    });
  }

  // --- helpers ---------------------------------------------------------------

  /** Tenant hiệu lực: ngữ cảnh request; ngoài request (seed/job) rơi về tenant-zero — cùng khuôn CoursesService. */
  private async effectiveTenantId(): Promise<string> {
    return this.tenantContext.currentTenantId() ?? (await this.tenants.fallbackTenantId());
  }

  /** Context lớp; ném class.context_missing khi cây chưa dựng (trạng thái hỏng — lớp luôn tạo kèm context). */
  private async classContextId(classId: string): Promise<string> {
    const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.CLASS, classId);
    if (!ctx) throw new NotFoundException({ message: `No context for class ${classId}`, code: 'class.context_missing' });
    return ctx.id;
  }

  /** Lớp theo id trong phạm vi tenant hiệu lực; lớp của tenant khác = không tồn tại (404 đồng nhất như TENANT-0). */
  async getClassRow(id: string): Promise<ClassRow> {
    const row = await this.repo.getClass(id);
    const tenantId = await this.effectiveTenantId();
    if (!row || row.tenantId !== tenantId) {
      throw new NotFoundException({ message: `Class ${id} not found`, code: 'class.not_found' });
    }
    return row;
  }

  /** Người xem thấy được mã tham gia khi có quyền quản roster của lớp (hoặc là chủ lớp / quản trị tenant). `knownCtxId` cho phép nơi gọi đã tra context lớp rồi dùng lại, tránh tra trùng. */
  private async canSeeJoinCode(actorId: string, row: ClassRow, knownCtxId?: string): Promise<boolean> {
    if (actorId === row.ownerId) return true;
    const ctxId = knownCtxId ?? (await this.classContextId(row.id));
    return this.evaluator.hasCapability(actorId, 'class:manageroster', ctxId);
  }

  /** Quyền xem lớp: capability `class:view` tại context lớp, HOẶC là thành viên roster (học sinh xem lớp của mình), HOẶC chủ lớp. */
  private async canViewClass(actorId: string, row: ClassRow): Promise<boolean> {
    if (actorId === row.ownerId) return true;
    const ctxId = await this.classContextId(row.id);
    if (await this.evaluator.hasCapability(actorId, 'class:view', ctxId)) return true;
    return this.groups.isCohortMember(row.cohortId, actorId);
  }

  // --- vòng đời lớp ------------------------------------------------------------

  /**
   * Tạo lớp: backing cohort + context lớp + bộ override quyền cho 4 vai
   * tại context lớp + gán vai chủ lớp (editingteacher) cho owner. Chỉ
   * `name` bắt buộc. `ownerId` khác người tạo chỉ khi người tạo có
   * `tenant:manage` (admin tạo lớp hộ giáo viên — đường review-seed dùng).
   *
   * Nguyên tử (issue #490, DL-09): toàn bộ chuỗi GHI sở hữu bởi lớp —
   * cohort nền, dòng lớp, context lớp, nối context cho cohort, bộ
   * override quyền, gán vai chủ lớp và dòng outbox `class_created` —
   * chạy trong MỘT transaction: lỗi ở bất kỳ bước nào thì không trạng
   * thái dở dang nào tồn tại (trước đây một lần tạo lớp chết giữa
   * chừng để lại cohort/lớp/context mồ côi). Các cổng đọc/điều kiện
   * đứng trước (capability, tồn tại owner, trùng mã lớp, membership
   * hiệu lực) và việc đảm bảo sẵn các VAI HỆ THỐNG dùng chung
   * (`ensureClassRoles` — dữ kiện toàn cục, không thuộc lớp này; cơ
   * chế khôi phục khi tạo vai đua nhau của nó cũng không chạy được
   * trong transaction vì một lệnh chèn hỏng sẽ huỷ cả transaction)
   * nằm NGOÀI transaction như cũ.
   */
  async createClass(actorId: string, input: CreateClass): Promise<ClassView> {
    const tenantId = await this.effectiveTenantId();
    const tenantCtx = await this.contexts.ensureTenantContext(tenantId);
    await this.evaluator.requireCapability(actorId, 'class:create', tenantCtx.id);
    const ownerId = input.ownerId ?? actorId;
    if (ownerId !== actorId) {
      await this.evaluator.requireCapability(actorId, 'tenant:manage', tenantCtx.id);
    }
    await this.users.getUser(ownerId);
    if (input.code && (await this.repo.getClassByCode(tenantId, input.code))) {
      throw new ConflictException({ message: `Class code ${input.code} is taken in this tenant`, code: 'class.code_taken' });
    }
    // Chủ lớp phải là thành viên hiệu lực của tenant — nếu không, cổng
    // membership của evaluator sẽ vô hiệu mọi vai tại lớp vừa gán.
    await this.tenants.ensureActiveMembership(tenantId, ownerId);

    const row = await this.repo.dbHandle.transaction(async (tx) => {
      const cohortRow = await this.repo.insertBackingCohort({
        tenantId,
        name: input.name,
        idNumber: '',
        description: '',
        contextId: tenantCtx.id,
        component: 'class',
        visible: false,
      }, tx);
      const classRow = await this.repo.insertClass({
        tenantId,
        name: input.name,
        code: input.code ?? null,
        schoolYear: input.schoolYear ?? null,
        ownerId,
        cohortId: cohortRow.id,
        allowSelfReport: false,
        joinCode: null,
        onLeave: 'suspend',
        status: 'active',
        description: input.description ?? '',
      }, tx);
      const classCtx = await this.contexts.createContext(CONTEXT_LEVELS.CLASS, classRow.id, tenantCtx.id, tx);
      await this.repo.updateCohortContext(cohortRow.id, classCtx.id, tx);
      await this.applyClassRoleGrants(classCtx.id, actorId, tx);
      const ownerRole = await this.roles.getRoleByShortname(CLASS_OWNER_ROLE);
      if (!ownerRole) throw new Error('editingteacher role not seeded');
      await this.roles.assignRole(ownerId, ownerRole.id, classCtx.id, actorId, undefined, tx);
      await this.outbox.enqueue(tx, {
        aggregate: 'class', type: 'class_created',
        payload: { classId: classRow.id, tenantId, ownerId, actorId },
        tenantId,
      });
      return classRow;
    });
    return toClassDto(row, true);
  }

  /** Ba vai lớp là vai hệ thống: tạo lười lần đầu (idempotent theo shortname), archetype `teacher`. */
  private async ensureClassRoles(): Promise<void> {
    for (const def of CLASS_ROLE_DEFS) {
      if (!(await this.roles.getRoleByShortname(def.shortName))) {
        await this.roles.createRole({ name: def.name, shortName: def.shortName, description: def.description, archetype: 'teacher' });
      }
    }
  }

  /** Vật chất hoá bộ capability của 4 vai tại đúng context lớp này (gọi lúc tạo lớp). Việc đảm bảo vai hệ thống (`ensureClassRoles`) cố ý KHÔNG nhận `tx` — vai là dữ kiện toàn cục dùng chung, xem ghi chú ở `createClass`. */
  private async applyClassRoleGrants(classContextId: string, modifierId: string, tx?: DbTx): Promise<void> {
    await this.ensureClassRoles();
    for (const [shortName, caps] of Object.entries(CLASS_ROLE_GRANTS)) {
      const role = await this.roles.getRoleByShortname(shortName);
      if (!role) continue;
      for (const cap of caps) {
        await this.roles.setCapabilityOverride(role.id, cap, classContextId, CAP_ALLOW, modifierId, tx);
      }
    }
  }

  /**
   * Danh sách lớp của tenant hiệu lực mà người xem có liên hệ (chủ lớp / có vai tại lớp / thành viên roster); quản trị tenant thấy toàn bộ.
   *
   * Mỗi dòng kèm bốn cờ khả năng do server suy cho ĐÚNG người gọi để
   * trang danh sách vẽ hành động theo vai (học viên không thấy các
   * hành động quản trị mình không có quyền): khả năng tạo lớp neo tại
   * context tenant (`class:create`, tính một lần cho cả đáp số); ba
   * cờ còn lại neo tại context của TỪNG lớp — chủ lớp luôn có đủ,
   * các vai khác suy qua evaluator như gói tổng quan suy
   * `canManageRoster`/`canShare`. Cờ xoá phản ánh trọn cổng xoá hiện
   * hành: `class:delete` tại context lớp và, khi người gọi không
   * phải chủ lớp, thêm `tenant:manage` tại context tenant. Các cờ
   * chỉ phục vụ hiển thị — gác quyền thật vẫn ở từng endpoint ghi.
   */
  async listClasses(actorId: string): Promise<ClassListItem[]> {
    const tenantId = await this.effectiveTenantId();
    const rows = await this.repo.listClassesByTenant(tenantId);
    const tenantCtx = await this.contexts.getTenantContext(tenantId);
    const seesAll = (await this.evaluator.isSiteAdmin(actorId))
      || (tenantCtx ? await this.evaluator.hasCapability(actorId, 'tenant:manage', tenantCtx.id) : false);
    const canCreate = tenantCtx ? await this.evaluator.hasCapability(actorId, 'class:create', tenantCtx.id) : false;
    const visible: ClassRow[] = [];
    for (const row of rows) {
      if (seesAll || (await this.canViewClass(actorId, row))) visible.push(row);
    }
    return Promise.all(visible.map(async (row) => {
      const ctxId = await this.classContextId(row.id);
      const isOwner = actorId === row.ownerId;
      const canUpdate = isOwner || (await this.evaluator.hasCapability(actorId, 'class:update', ctxId));
      const canManageRoster = isOwner || (await this.evaluator.hasCapability(actorId, 'class:manageroster', ctxId));
      const canDelete = (isOwner || (tenantCtx ? await this.evaluator.hasCapability(actorId, 'tenant:manage', tenantCtx.id) : false))
        && (isOwner || (await this.evaluator.hasCapability(actorId, 'class:delete', ctxId)));
      return {
        ...toClassDto(row, await this.canSeeJoinCode(actorId, row, ctxId)),
        canCreate,
        canUpdate,
        canDelete,
        canManageRoster,
      };
    }));
  }

  /** Chi tiết một lớp (cổng xem như canViewClass). */
  async getClass(actorId: string, id: string): Promise<ClassView> {
    const row = await this.getClassRow(id);
    if (!(await this.canViewClass(actorId, row))) {
      throw new NotFoundException({ message: `Class ${id} not found`, code: 'class.not_found' });
    }
    return toClassDto(row, await this.canSeeJoinCode(actorId, row));
  }

  /**
   * Dashboard theo lớp (CLASS-2): gói tổng quan MỘT lớp cho đúng vai
   * của người gọi — dữ kiện các endpoint hiện có không cho biết quan hệ
   * của người gọi với lớp, và danh sách khoá của lớp trả mọi khoá trong
   * khi học sinh chỉ được thấy khoá mình đang học, nên gói này suy cả
   * hai ở phía server.
   *
   * Flow:
   *  1. Cổng xem lớp như mọi đường đọc của lớp (canViewClass): người
   *     ngoài lớp nhận 404 đồng nhất, không lộ sự tồn tại của lớp.
   *  2. Suy quan hệ của người gọi từ dữ kiện thật: chủ lớp → `owner`;
   *     giữ ít nhất một trong 3 vai lớp gán tay tại context lớp (cùng
   *     cách liệt kê của listStaff) hoặc có cờ quản roster/phân vai →
   *     `staff`; thuộc roster → `member`; còn lại là người xem được lớp
   *     nhờ quyền quản trị cấp trên (site admin / tenant:manage) →
   *     `staff` ở mức xem, các thao tác quản trị vẫn gác riêng bằng
   *     `canManageRoster`/`canShare` đi kèm trong gói.
   *  3. Danh sách khoá lọc theo vai: owner/staff nhận mọi khoá của
   *     lớp; member chỉ nhận các khoá mình đang ghi danh ACTIVE —
   *     đình chỉ ở một khoá thì khoá đó biến mất khỏi gói.
   *
   * Bất biến: gói KHÔNG mang bất kỳ dữ kiện điểm nào — dashboard là
   * bề mặt tổng quan/điều hướng; mô hình điểm (chốt 23:49 25/10/2026)
   * chỉ có điểm theo từng bài, cấm tổng hợp theo lớp/khoá.
   *
   * @param actorId - Người gọi đã xác thực.
   * @param id - Id của lớp.
   * @returns Gói tổng quan khớp `classOverviewSchema` phía contracts
   *   (danh sách khoá là bản ghi khoá thô như endpoint khoá của lớp).
   * @throws NotFoundException `class.not_found` khi lớp không thuộc
   *   tenant hiệu lực hoặc người gọi không có quan hệ với lớp.
   */
  async getClassOverview(actorId: string, id: string): Promise<Omit<ClassOverview, 'courses'> & { courses: CourseRow[] }> {
    const row = await this.getClassRow(id);
    if (!(await this.canViewClass(actorId, row))) {
      throw new NotFoundException({ message: `Class ${id} not found`, code: 'class.not_found' });
    }
    const ctxId = await this.classContextId(id);
    const isOwner = actorId === row.ownerId;
    const canManageRoster = isOwner || (await this.evaluator.hasCapability(actorId, 'class:manageroster', ctxId));
    const canShare = isOwner || (await this.evaluator.hasCapability(actorId, 'class:share', ctxId));

    // Đồng GV = được gán TAY (component rỗng) ít nhất một trong 3 vai
    // lớp tại đúng context lớp này — cùng khuôn liệt kê của listStaff;
    // các dòng gán do ghi danh cấp không phải vai lớp nên không lẫn vào.
    const staffRoleIds = new Set<string>();
    for (const shortName of [CLASS_ASSIGNER_ROLE, CLASS_GRADER_ROLE, CLASS_ROSTER_MANAGER_ROLE]) {
      const role = await this.roles.getRoleByShortname(shortName);
      if (role) staffRoleIds.add(role.id);
    }
    type AssignmentRow = { userId: string; roleId: string; component: string };
    const assignments = (await this.roles.listAssignments({ contextId: ctxId })) as unknown as AssignmentRow[];
    const hasStaffRole = assignments.some((a) => a.component === '' && a.userId === actorId && staffRoleIds.has(a.roleId));
    const isMember = await this.groups.isCohortMember(row.cohortId, actorId);

    const viewerRole: ClassViewerRole = isOwner
      ? 'owner'
      : hasStaffRole || canManageRoster || canShare
        ? 'staff'
        : isMember
          ? 'member'
          : 'staff';

    const allCourses = await this.repo.listCoursesInClass(id);
    let courses = allCourses;
    if (viewerRole === 'member') {
      const activeIds = new Set(await this.repo.listActiveEnrolledCourseIds(id, actorId));
      courses = allCourses.filter((c) => activeIds.has(c.id));
    }
    const rosterCount = (await this.groups.listCohortMembers(row.cohortId)).length;
    return {
      class: toClassDto(row, await this.canSeeJoinCode(actorId, row)),
      viewerRole,
      canManageRoster,
      canShare,
      rosterCount,
      courses,
    };
  }

  /** Sửa lớp; đổi `onLeave` thì đẩy xuống mọi instance cohort hiện có của lớp; xoay mã tham gia làm mã cũ mất hiệu lực ngay. Đặt/đổi học phí gói lớp (CLASS-3) cũng qua đường này — cùng cổng `class:update` tại context lớp. */
  async updateClass(actorId: string, id: string, input: UpdateClass): Promise<ClassView> {
    const row = await this.getClassRow(id);
    const ctxId = await this.classContextId(id);
    await this.evaluator.requireCapability(actorId, 'class:update', ctxId);
    const patch: Partial<ClassRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.code !== undefined) {
      if (input.code !== null && input.code !== row.code) {
        const taken = await this.repo.getClassByCode(row.tenantId, input.code);
        if (taken && taken.id !== id) {
          throw new ConflictException({ message: `Class code ${input.code} is taken in this tenant`, code: 'class.code_taken' });
        }
      }
      patch.code = input.code;
    }
    if (input.schoolYear !== undefined) patch.schoolYear = input.schoolYear;
    if (input.description !== undefined) patch.description = input.description;
    if (input.onLeave !== undefined) patch.onLeave = input.onLeave;
    if (input.allowSelfReport !== undefined) patch.allowSelfReport = input.allowSelfReport;
    if (input.joinAutoApprove !== undefined) patch.joinAutoApprove = input.joinAutoApprove;
    // CLASS-3: đặt/đổi học phí gói lớp đi qua đúng PATCH này (gác
    // `class:update` ở trên — chủ lớp giữ sẵn qua vai editingteacher).
    // feeCurrency chuẩn hoá chữ hoa như mọi mã tiền tệ của payments.
    if (input.feeCost !== undefined) patch.feeCost = input.feeCost;
    if (input.feeCurrency !== undefined) patch.feeCurrency = input.feeCurrency.toUpperCase();
    if (input.feePaymentAccountId !== undefined) patch.feePaymentAccountId = input.feePaymentAccountId;
    if (input.rotateJoinCode || (patch.allowSelfReport === true && !row.joinCode)) {
      patch.joinCode = generateJoinCode();
    }
    if (Object.keys(patch).length) await this.repo.updateClass(id, patch);
    if (patch.onLeave !== undefined && patch.onLeave !== row.onLeave) {
      await this.repo.syncOnLeaveToInstances(row.cohortId, patch.onLeave);
    }
    const updated = (await this.repo.getClass(id))!;
    return toClassDto(updated, await this.canSeeJoinCode(actorId, updated));
  }

  /** Lưu trữ lớp (cuối năm): đóng băng ghi danh mới + tạo khoá mới, giữ nguyên dữ liệu để đọc lại. */
  async archiveClass(actorId: string, id: string): Promise<ClassView> {
    const row = await this.getClassRow(id);
    const ctxId = await this.classContextId(id);
    await this.evaluator.requireCapability(actorId, 'class:update', ctxId);
    if (row.status !== 'archived') {
      await this.repo.updateClass(id, { status: 'archived' });
      await this.outbox.enqueueStandalone({
        aggregate: 'class', type: 'class_archived',
        payload: { classId: id, tenantId: row.tenantId, actorId },
        tenantId: row.tenantId,
      });
    }
    const updated = (await this.repo.getClass(id))!;
    return toClassDto(updated, await this.canSeeJoinCode(actorId, updated));
  }

  /**
   * Xoá lớp: chỉ chủ lớp (hoặc quản trị tenant kèm `class:delete`) và chỉ
   * khi lớp không còn khoá nào — FK RESTRICT là lưới cuối, kiểm trước ở
   * đây để trả lỗi nghiệp vụ rõ ràng. Xoá kèm backing cohort + context.
   */
  async deleteClass(actorId: string, id: string): Promise<void> {
    const row = await this.getClassRow(id);
    const ctxId = await this.classContextId(id);
    await this.evaluator.requireCapability(actorId, 'class:delete', ctxId);
    if (actorId !== row.ownerId) {
      const tenantCtx = await this.contexts.ensureTenantContext(row.tenantId);
      await this.evaluator.requireCapability(actorId, 'tenant:manage', tenantCtx.id);
    }
    if ((await this.repo.countCoursesInClass(id)) > 0) {
      throw new ConflictException({ message: 'Class still has courses; archive or delete its courses first', code: 'class.has_courses' });
    }
    await this.repo.deleteClass(id);
    await this.repo.deleteCohort(row.cohortId);
    await this.contexts.deleteByLevelInstance(CONTEXT_LEVELS.CLASS, id);
    await this.outbox.enqueueStandalone({
      aggregate: 'class', type: 'class_deleted',
      payload: { classId: id, tenantId: row.tenantId, actorId },
      tenantId: row.tenantId,
    });
  }

  // --- roster (≡ cohort_members của backing cohort) ---------------------------

  /**
   * Danh sách học sinh của lớp kèm thông tin hiển thị của tài khoản (cổng xem lớp).
   *
   * Thu hẹp trường liên hệ theo quyền của người gọi: email là dữ
   * kiện phía quản trị/người được giao quyền, không phải dữ kiện bạn
   * học được xem; `username` của tài khoản tạo qua đường nạp roster
   * chính là số điện thoại nên cũng thuộc diện liên hệ. Người gọi có
   * quyền quản roster của lớp này (chủ lớp hoặc `class:manageroster`
   * tại context lớp) nhận đáp số đầy đủ; mọi người xem được lớp còn
   * lại nhận các dòng đã làm rỗng `email` và `username`, giữ nguyên
   * họ tên và thời điểm vào lớp để các hiển thị lớp học thông thường
   * (danh sách bạn học theo tên) vẫn dùng được.
   */
  async listRoster(actorId: string, classId: string): Promise<ClassRosterMember[]> {
    const row = await this.getClassRow(classId);
    if (!(await this.canViewClass(actorId, row))) {
      throw new NotFoundException({ message: `Class ${classId} not found`, code: 'class.not_found' });
    }
    const ctxId = await this.classContextId(classId);
    const canManageRoster = actorId === row.ownerId || (await this.evaluator.hasCapability(actorId, 'class:manageroster', ctxId));
    const members = await this.groups.listCohortMembers(row.cohortId);
    const usersById = new Map((await this.users.getUsersByIds(members.map((m) => m.userId))).map((u) => [u.id, u]));
    return members.map((m) => {
      const u = usersById.get(m.userId);
      return {
        userId: m.userId,
        timeAdded: m.timeAdded.toISOString(),
        firstName: u?.firstName ?? '',
        lastName: u?.lastName ?? '',
        username: canManageRoster ? (u?.username ?? '') : '',
        email: canManageRoster ? (u?.email ?? '') : '',
      };
    });
  }

  /**
   * Thêm học sinh vào lớp = thêm vào backing cohort qua GroupsService —
   * cohort sync (in-process + consumer outbox) vật chất hoá ghi danh
   * xuống mọi khoá của lớp. Lớp đã lưu trữ thì đóng băng roster.
   */
  async addToRoster(actorId: string, classId: string, userId: string): Promise<void> {
    const row = await this.getClassRow(classId);
    if (row.status === 'archived') {
      throw new BadRequestException({ message: 'Class is archived; roster is frozen', code: 'class.archived' });
    }
    const ctxId = await this.classContextId(classId);
    await this.evaluator.requireCapability(actorId, 'class:manageroster', ctxId);
    await this.users.getUser(userId);
    await this.tenants.ensureActiveMembership(row.tenantId, userId);
    await this.groups.addCohortMember(actorId, row.cohortId, userId);
  }

  /** Gỡ học sinh khỏi lớp: cohort sync đình chỉ/rút ghi danh ở mọi khoá theo `on_leave` của lớp. */
  async removeFromRoster(actorId: string, classId: string, userId: string): Promise<void> {
    const row = await this.getClassRow(classId);
    if (row.status === 'archived') {
      throw new BadRequestException({ message: 'Class is archived; roster is frozen', code: 'class.archived' });
    }
    const ctxId = await this.classContextId(classId);
    await this.evaluator.requireCapability(actorId, 'class:manageroster', ctxId);
    await this.groups.removeCohortMember(actorId, row.cohortId, userId);
  }

  /** Mọi khoá thuộc lớp (cổng xem lớp). */
  async listClassCourses(actorId: string, classId: string): Promise<CourseRow[]> {
    const row = await this.getClassRow(classId);
    if (!(await this.canViewClass(actorId, row))) {
      throw new NotFoundException({ message: `Class ${classId} not found`, code: 'class.not_found' });
    }
    return this.repo.listCoursesInClass(classId);
  }

  // --- nạp roster theo định danh + import Excel (CLASS-1) ----------------------

  /** Cổng quản roster dùng chung cho các đường nạp: lớp chưa lưu trữ + capability `class:manageroster` tại context lớp. */
  private async requireRosterManager(actorId: string, row: ClassRow): Promise<void> {
    if (row.status === 'archived') {
      throw new BadRequestException({ message: 'Class is archived; roster is frozen', code: 'class.archived' });
    }
    const ctxId = await this.classContextId(row.id);
    await this.evaluator.requireCapability(actorId, 'class:manageroster', ctxId);
  }

  /** Họ tên hiển thị của một tài khoản: "Họ Tên" theo thứ tự VN, rơi về username khi trống. */
  private displayNameOf(user: UserRow): string {
    const full = `${user.lastName} ${user.firstName}`.trim();
    return full || user.username;
  }

  /** Tách họ tên đầy đủ kiểu VN: từ CUỐI là tên, phần còn lại là họ + đệm. */
  private splitFullName(fullName: string): { firstName: string; lastName: string } {
    const tokens = fullName.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { firstName: '', lastName: '' };
    return { firstName: tokens[tokens.length - 1]!, lastName: tokens.slice(0, -1).join(' ') };
  }

  /** Mật khẩu tạm cho tài khoản học sinh mới tạo qua roster: đủ 4 lớp ký tự theo chính sách mặc định, buộc đổi ở lần đăng nhập đầu (forcePasswordChange). */
  private generateTemporaryPassword(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(12);
    const core = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    return `Lms@9${core}`;
  }

  /** Username chưa bị chiếm, bắt đầu từ `base`; trùng thì thêm hậu tố số tăng dần. */
  private async uniqueUsername(base: string): Promise<string> {
    const stem = base || 'hocvien';
    let candidate = stem;
    let n = 1;
    while (await this.users.getByUsername(candidate)) {
      n += 1;
      candidate = `${stem}${n}`;
    }
    return candidate;
  }

  /**
   * Phân giải một định danh học sinh thành tài khoản: khớp theo EMAIL
   * trước, rồi theo SĐT (= username); không khớp thì TẠO tài khoản mới
   * (username = SĐT hoặc phần trước @ của email; chưa có email thì dùng
   * hộp thư giữ chỗ `<username>@roster.local` — tài khoản đăng nhập bằng
   * username, hộp thư này chỉ để thoả ràng buộc email duy nhất, đã ghi
   * rõ ở hợp đồng contracts). Tài khoản mới mang mật khẩu tạm + cờ buộc
   * đổi mật khẩu.
   */
  private async resolveStudentAccount(input: RosterStudentIdentity): Promise<{ user: UserRow; created: boolean; temporaryPassword: string | null }> {
    const email = input.email?.trim().toLowerCase() || undefined;
    const phone = input.phone ? input.phone.replace(/[^0-9]/g, '') || undefined : undefined;
    if (!email && !phone) {
      throw new BadRequestException({ message: 'A student row needs an email or a phone number to match or create an account', code: 'class.roster_identity_missing' });
    }
    let user = email ? await this.users.getByEmail(email) : undefined;
    if (!user && phone) user = await this.users.getByUsername(phone);
    if (user) return { user, created: false, temporaryPassword: null };
    const { firstName, lastName } = this.splitFullName(input.fullName);
    const localPart = email ? email.split('@')[0]!.replace(/[^a-z0-9._-]/g, '') : '';
    const username = await this.uniqueUsername(phone ?? localPart);
    const temporaryPassword = this.generateTemporaryPassword();
    const created = await this.users.createUser({
      username,
      email: email ?? `${username}@roster.local`,
      password: temporaryPassword,
      firstName,
      lastName,
      forcePasswordChange: true,
    });
    return { user: created, created: true, temporaryPassword };
  }

  /** Nạp một học sinh theo định danh vào lớp đã qua cổng quản roster; trả kết quả kèm mật khẩu tạm khi vừa tạo tài khoản. */
  private async addStudentByIdentity(row: ClassRow, actorId: string, input: RosterStudentIdentity): Promise<AddRosterStudentResult> {
    const { user, created, temporaryPassword } = await this.resolveStudentAccount(input);
    const already = await this.groups.isCohortMember(row.cohortId, user.id);
    if (!already) await this.addToRoster(actorId, row.id, user.id);
    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      fullName: this.displayNameOf(user),
      outcome: already ? 'already_member' : created ? 'created' : 'matched',
      temporaryPassword: created ? temporaryPassword : null,
    };
  }

  /** POST /classes/:id/roster/identity — GV thêm một học sinh bằng họ tên + email/SĐT thay vì phải biết userId. */
  async addRosterStudentByIdentity(actorId: string, classId: string, input: RosterStudentIdentity): Promise<AddRosterStudentResult> {
    const row = await this.getClassRow(classId);
    await this.requireRosterManager(actorId, row);
    return this.addStudentByIdentity(row, actorId, input);
  }

  /**
   * Import roster (nhiều dòng): mỗi dòng độc lập — dòng lỗi ghi vào báo
   * cáo kèm mã lỗi, không chặn các dòng còn lại; GV sửa đúng dòng lỗi
   * trong file rồi nạp lại riêng dòng đó.
   */
  async importRoster(actorId: string, classId: string, rows: RosterStudentIdentity[]): Promise<ClassRosterImportReport> {
    const row = await this.getClassRow(classId);
    await this.requireRosterManager(actorId, row);
    const results: ClassRosterImportReport['results'] = [];
    let added = 0;
    let created = 0;
    let alreadyMembers = 0;
    let failed = 0;
    for (const [i, input] of rows.entries()) {
      try {
        const r = await this.addStudentByIdentity(row, actorId, input);
        if (r.outcome === 'already_member') {
          alreadyMembers += 1;
          results.push({ row: i + 1, fullName: input.fullName, status: 'already_member', userId: r.userId, username: r.username, temporaryPassword: null, error: null });
        } else {
          added += 1;
          if (r.outcome === 'created') created += 1;
          results.push({ row: i + 1, fullName: input.fullName, status: r.outcome === 'created' ? 'added_created' : 'added_matched', userId: r.userId, username: r.username, temporaryPassword: r.temporaryPassword, error: null });
        }
      } catch (err) {
        failed += 1;
        const resp = err instanceof HttpException ? err.getResponse() : null;
        const body = (typeof resp === 'object' && resp !== null ? resp : {}) as { code?: unknown; message?: unknown };
        const error = typeof body.code === 'string' ? body.code : typeof body.message === 'string' ? body.message : 'class.roster_row_failed';
        results.push({ row: i + 1, fullName: input.fullName, status: 'error', userId: null, username: null, temporaryPassword: null, error });
      }
    }
    return { total: rows.length, added, created, alreadyMembers, failed, results };
  }

  /** Đọc một file Excel roster (sheet đầu tiên) thành các dòng định danh: tự nhận diện hàng tiêu đề theo từ khoá cột (Họ tên | SĐT | Email | Ngày sinh), thiếu tiêu đề thì đọc theo đúng thứ tự cột đó. */
  async parseRosterWorkbook(buffer: Buffer): Promise<RosterStudentIdentity[]> {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.worksheets[0];
    if (!ws) {
      throw new BadRequestException({ message: 'The workbook has no worksheet', code: 'class.import_file_empty' });
    }
    const cellText = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      if (value instanceof Date) {
        const dd = String(value.getDate()).padStart(2, '0');
        const mm = String(value.getMonth() + 1).padStart(2, '0');
        return `${dd}/${mm}/${value.getFullYear()}`;
      }
      if (typeof value === 'object') {
        const v = value as { text?: unknown; result?: unknown };
        if (typeof v.text === 'string') return v.text.trim();
        if (v.result !== undefined) return cellText(v.result);
        return '';
      }
      return String(value).trim();
    };
    const rawRows: string[][] = [];
    ws.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellText(cell.value)));
      if (cells.some((c) => c !== '')) rawRows.push(cells);
    });
    if (rawRows.length === 0) return [];
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
    const header = rawRows[0]!.map(norm);
    const findCol = (...keywords: string[]) => header.findIndex((h) => keywords.some((k) => h.includes(k)));
    const nameCol = findCol('ten', 'name');
    const hasHeader = nameCol >= 0;
    const cols = hasHeader
      ? { name: nameCol, phone: findCol('dien thoai', 'sdt', 'phone'), email: findCol('email', 'mail'), dob: findCol('ngay sinh', 'sinh', 'birth') }
      : { name: 0, phone: 1, email: 2, dob: 3 };
    const dataRows = hasHeader ? rawRows.slice(1) : rawRows;
    if (dataRows.length > 500) {
      throw new BadRequestException({ message: 'Roster import is limited to 500 rows per file', code: 'class.import_too_many_rows' });
    }
    const out: RosterStudentIdentity[] = [];
    for (const cells of dataRows) {
      const fullName = (cells[cols.name] ?? '').trim();
      if (!fullName) continue;
      const email = cols.email >= 0 ? (cells[cols.email] ?? '').trim() : '';
      const phone = cols.phone >= 0 ? (cells[cols.phone] ?? '').trim() : '';
      const dob = cols.dob >= 0 ? (cells[cols.dob] ?? '').trim() : '';
      out.push({
        fullName,
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(dob ? { dateOfBirth: dob } : {}),
      });
    }
    return out;
  }

  /** File mẫu roster .xlsx cho GV tải về: đúng 4 cột kiểu Azota (Họ tên | Số điện thoại | Email | Ngày sinh) + một dòng ví dụ. */
  async buildRosterTemplateWorkbook(): Promise<{ filename: string; buffer: Buffer }> {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Danh sách học sinh');
    ws.columns = [{ width: 28 }, { width: 16 }, { width: 28 }, { width: 14 }];
    const header = ws.addRow(['Họ tên', 'Số điện thoại', 'Email', 'Ngày sinh']);
    header.font = { bold: true };
    ws.addRow(['Nguyễn Văn An', '0901234567', 'an.nguyen@example.com', '15/03/2011']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { filename: 'mau-danh-sach-hoc-sinh.xlsx', buffer };
  }

  // --- phân quyền đồng GV tại context lớp (CLASS-1) -----------------------------

  /**
   * Bề mặt phân quyền của lớp: chủ lớp + mọi đồng GV đang giữ một trong
   * 3 vai lớp tại context lớp (gán tay — component rỗng; các dòng do ghi
   * danh cấp không phải vai lớp nên không lẫn vào). Phân quyền vẫn là cơ
   * chế vai/context sẵn có, KHÔNG có bảng quyền song song.
   */
  async listStaff(actorId: string, classId: string): Promise<ClassStaffView> {
    const row = await this.getClassRow(classId);
    if (!(await this.canViewClass(actorId, row))) {
      throw new NotFoundException({ message: `Class ${classId} not found`, code: 'class.not_found' });
    }
    const ctxId = await this.classContextId(classId);
    const roleIds = new Map<string, ClassStaffRole>();
    for (const shortName of ['classassigner', 'classgrader', 'classrostermanager'] as const) {
      const role = await this.roles.getRoleByShortname(shortName);
      if (role) roleIds.set(role.id, shortName);
    }
    type AssignmentRow = { id: string; userId: string; roleId: string; component: string };
    const assignments = (await this.roles.listAssignments({ contextId: ctxId })) as unknown as AssignmentRow[];
    const rolesByUser = new Map<string, Set<ClassStaffRole>>();
    for (const a of assignments) {
      if (a.component !== '') continue;
      const shortName = roleIds.get(a.roleId);
      if (!shortName) continue;
      const set = rolesByUser.get(a.userId) ?? new Set<ClassStaffRole>();
      set.add(shortName);
      rolesByUser.set(a.userId, set);
    }
    const userIds = [...new Set([row.ownerId, ...rolesByUser.keys()])];
    const usersById = new Map((await this.users.getUsersByIds(userIds)).map((u) => [u.id, u]));
    const toEntry = (userId: string, isOwner: boolean) => {
      const u = usersById.get(userId);
      return {
        userId,
        firstName: u?.firstName ?? '',
        lastName: u?.lastName ?? '',
        username: u?.username ?? '',
        email: u?.email ?? '',
        isOwner,
        roles: [...(rolesByUser.get(userId) ?? [])],
      };
    };
    const staff = [
      toEntry(row.ownerId, true),
      ...[...rolesByUser.keys()].filter((id) => id !== row.ownerId).map((id) => toEntry(id, false)),
    ];
    const canShare = actorId === row.ownerId || (await this.evaluator.hasCapability(actorId, 'class:share', ctxId));
    const canManageRoster = actorId === row.ownerId || (await this.evaluator.hasCapability(actorId, 'class:manageroster', ctxId));
    return { staff, canShare, canManageRoster };
  }

  /**
   * Đặt lại bộ 3 vai lớp cho một đồng GV (chỉ người có `class:share`):
   * gán vai còn thiếu, gỡ vai thừa — chỉ đụng các dòng gán TAY tại đúng
   * context lớp này. Chủ lớp giữ vai editingteacher cố định, không sửa
   * qua đường này.
   */
  async setStaffRoles(actorId: string, classId: string, input: { userId?: string; email?: string; roles: ClassStaffRole[] }): Promise<ClassStaffView> {
    const row = await this.getClassRow(classId);
    const ctxId = await this.classContextId(classId);
    await this.evaluator.requireCapability(actorId, 'class:share', ctxId);
    // Định danh đồng GV: userId hoặc email của tài khoản CÓ SẴN (đường
    // phân quyền không tự tạo tài khoản — tạo tài khoản là việc của
    // quản trị/roster, tránh cấp quyền cho một tài khoản vừa sinh nhầm).
    let targetId = input.userId;
    if (!targetId && input.email) {
      const byEmail = await this.users.getByEmail(input.email.trim().toLowerCase());
      if (!byEmail) {
        throw new NotFoundException({ message: `No account with email ${input.email}`, code: 'class.staff_user_not_found' });
      }
      targetId = byEmail.id;
    }
    if (!targetId) {
      throw new BadRequestException({ message: 'A staff member must be identified by userId or email', code: 'class.staff_identity_missing' });
    }
    if (targetId === row.ownerId) {
      throw new BadRequestException({ message: 'The class owner keeps the owner role; transfer ownership instead of editing class roles', code: 'class.owner_roles_locked' });
    }
    await this.ensureClassRoles();
    await this.users.getUser(targetId);
    await this.tenants.ensureActiveMembership(row.tenantId, targetId);
    type AssignmentRow = { id: string; userId: string; roleId: string; component: string };
    const assignments = (await this.roles.listAssignments({ contextId: ctxId, userId: targetId })) as unknown as AssignmentRow[];
    for (const shortName of ['classassigner', 'classgrader', 'classrostermanager'] as const) {
      const role = await this.roles.getRoleByShortname(shortName);
      if (!role) continue;
      const existing = assignments.find((a) => a.roleId === role.id && a.component === '');
      const wanted = input.roles.includes(shortName);
      if (wanted && !existing) await this.roles.assignRole(targetId, role.id, ctxId, actorId);
      if (!wanted && existing) await this.roles.unassignRole(existing.id, actorId);
    }
    return this.listStaff(actorId, classId);
  }

  // --- tự báo danh bằng mã tham gia (CLASS-1) -----------------------------------

  /** Tra lớp theo mã tham gia ở ngữ cảnh platform: mã là bí mật toàn hệ, lớp đích có thể thuộc tenant khác tenant hiệu lực của người gọi (hồ sơ hotfix #196: tra cứu xuyên tenant phải bọc platform tường minh, quyết định nghiệp vụ nằm ở tầng service). */
  private async classByJoinCode(joinCode: string): Promise<ClassRow> {
    const row = await this.tenantContext.run({ platform: true }, () => this.repo.getClassByJoinCode(joinCode.trim().toUpperCase()));
    if (!row || !row.allowSelfReport || !row.joinCode) {
      throw new NotFoundException({ message: 'Join code is not valid for any open class', code: 'class.join_code_invalid' });
    }
    return row;
  }

  /** Xem trước lớp từ mã tham gia (học sinh xác nhận đúng lớp trước khi xin vào). */
  async previewJoin(joinCode: string): Promise<{ classId: string; name: string; schoolYear: string | null; ownerName: string }> {
    const row = await this.classByJoinCode(joinCode);
    const owner = await this.users.getByIdOrUndefined(row.ownerId);
    return {
      classId: row.id,
      name: row.name,
      schoolYear: row.schoolYear,
      ownerName: owner ? this.displayNameOf(owner) : '',
    };
  }

  /**
   * Xin vào lớp bằng mã tham gia. Luật chốt cứng: lớp TRỐNG → vào
   * thẳng; lớp đã có học sinh → hàng chờ duyệt, trừ khi lớp bật tự
   * duyệt (`joinAutoApprove`). Vào thẳng đi qua đường nội bộ của cohort
   * (người xin là học sinh, không có `cohort:manage` — quyết định cho
   * vào đã nằm ở luật này + công tắc của lớp).
   */
  async joinByCode(actorId: string, joinCode: string): Promise<JoinClassResult> {
    const row = await this.classByJoinCode(joinCode);
    if (row.status === 'archived') {
      throw new BadRequestException({ message: 'Class is archived; roster is frozen', code: 'class.archived' });
    }
    const view = { id: row.id, name: row.name, schoolYear: row.schoolYear };
    return this.tenantContext.run({ platform: true }, async () => {
      if (await this.groups.isCohortMember(row.cohortId, actorId)) {
        return { outcome: 'already_member' as const, class: view };
      }
      const memberCount = (await this.groups.listCohortMembers(row.cohortId)).length;
      if (row.joinAutoApprove || memberCount === 0) {
        await this.tenants.ensureActiveMembership(row.tenantId, actorId);
        await this.groups.addCohortMemberInternal(row.cohortId, actorId);
        await this.outbox.enqueueStandalone({
          aggregate: 'class', type: 'class_member_joined',
          payload: { classId: row.id, tenantId: row.tenantId, userId: actorId, via: 'self_report' },
          tenantId: row.tenantId,
        });
        return { outcome: 'joined' as const, class: view };
      }
      const pending = await this.repo.findPendingJoinRequest(row.id, actorId);
      if (!pending) {
        await this.repo.insertJoinRequest({ tenantId: row.tenantId, classId: row.id, userId: actorId, status: 'pending' });
      }
      return { outcome: 'pending' as const, class: view };
    });
  }

  /** Hàng chờ duyệt tự báo danh của lớp (cổng quản roster). */
  async listJoinRequests(actorId: string, classId: string): Promise<ClassJoinRequestView[]> {
    const row = await this.getClassRow(classId);
    const ctxId = await this.classContextId(classId);
    await this.evaluator.requireCapability(actorId, 'class:manageroster', ctxId);
    const requests = await this.repo.listJoinRequests(classId, 'pending');
    const usersById = new Map((await this.users.getUsersByIds(requests.map((r) => r.userId))).map((u) => [u.id, u]));
    return requests.map((r) => this.toJoinRequestView(r, usersById.get(r.userId)));
  }

  private toJoinRequestView(r: ClassJoinRequestRow, user?: UserRow): ClassJoinRequestView {
    return {
      id: r.id,
      classId: r.classId,
      userId: r.userId,
      firstName: user?.firstName ?? '',
      lastName: user?.lastName ?? '',
      username: user?.username ?? '',
      email: user?.email ?? '',
      status: r.status as ClassJoinRequestView['status'],
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    };
  }

  /** Duyệt (đưa vào roster qua đúng đường CLASS-0) hoặc từ chối (chỉ đóng yêu cầu) một yêu cầu tự báo danh. */
  async decideJoinRequest(actorId: string, classId: string, requestId: string, approve: boolean): Promise<ClassJoinRequestView> {
    const row = await this.getClassRow(classId);
    const ctxId = await this.classContextId(classId);
    await this.evaluator.requireCapability(actorId, 'class:manageroster', ctxId);
    const request = await this.repo.getJoinRequest(requestId);
    if (!request || request.classId !== classId) {
      throw new NotFoundException({ message: `Join request ${requestId} not found`, code: 'class.join_request_not_found' });
    }
    if (request.status !== 'pending') {
      throw new ConflictException({ message: 'Join request was already decided', code: 'class.join_request_decided' });
    }
    if (approve) await this.addToRoster(actorId, classId, request.userId);
    await this.repo.updateJoinRequest(requestId, {
      status: approve ? 'approved' : 'rejected',
      decidedBy: actorId,
      decidedAt: new Date(),
    });
    const updated = (await this.repo.getJoinRequest(requestId))!;
    const user = await this.users.getByIdOrUndefined(request.userId);
    return this.toJoinRequestView(updated, user);
  }

  // --- thành viên đã đình chỉ (CLASS-1) ------------------------------------------

  /**
   * Danh sách học sinh đã đình chỉ khỏi lớp: đã gỡ khỏi roster theo chế
   * độ `suspend` (ghi danh ở các khoá đang SUSPENDED, giữ dữ liệu) và
   * chưa vào lại. Thêm lại vào roster (đường roster thường) là kích
   * hoạt lại đúng các dòng ghi danh cũ.
   */
  async listSuspendedMembers(actorId: string, classId: string): Promise<ClassSuspendedMember[]> {
    const row = await this.getClassRow(classId);
    if (!(await this.canViewClass(actorId, row))) {
      throw new NotFoundException({ message: `Class ${classId} not found`, code: 'class.not_found' });
    }
    const suspendedIds = await this.repo.listSuspendedMemberIds(row.cohortId);
    if (suspendedIds.length === 0) return [];
    const memberIds = new Set((await this.groups.listCohortMembers(row.cohortId)).map((m) => m.userId));
    const former = suspendedIds.filter((id) => !memberIds.has(id));
    const usersById = new Map((await this.users.getUsersByIds(former)).map((u) => [u.id, u]));
    return former.map((userId) => {
      const u = usersById.get(userId);
      return {
        userId,
        firstName: u?.firstName ?? '',
        lastName: u?.lastName ?? '',
        username: u?.username ?? '',
        email: u?.email ?? '',
      };
    });
  }

  // --- học phí theo lớp (CLASS-3) ----------------------------------------------

  /**
   * Gói CÔNG KHAI của lớp cho người chưa ghi danh (bề mặt mua gói lớp):
   * bất kỳ người dùng đã đăng nhập nào trong tenant hiệu lực cũng xem
   * được — đây là trang bán gói của lớp, khác các đường đọc nội bộ vốn
   * chỉ mở cho người có quan hệ với lớp. Gói chỉ mang thông tin người
   * mua cần (tên lớp, chủ lớp, học phí) + hai cờ suy cho đúng người gọi
   * (`isMember`, `canPurchase`); tuyệt đối không mang cohort, mã tham
   * gia hay tài khoản nhận tiền.
   *
   * @param actorId - Người gọi đã xác thực.
   * @param id - Id của lớp.
   * @returns Gói khớp `classPublicViewSchema` phía contracts.
   * @throws NotFoundException `class.not_found` khi lớp không thuộc
   *   tenant hiệu lực (giữ nguyên tắc không lộ sự tồn tại xuyên tenant).
   */
  async getClassPublic(actorId: string, id: string): Promise<ClassPublicView> {
    const row = await this.getClassRow(id);
    const owner = await this.users.getByIdOrUndefined(row.ownerId);
    const isMember = await this.groups.isCohortMember(row.cohortId, actorId);
    const feeEnabled = row.feeCost !== null && row.feeCost > 0;
    return {
      classId: row.id,
      name: row.name,
      code: row.code,
      schoolYear: row.schoolYear,
      description: row.description,
      ownerName: owner ? this.displayNameOf(owner) : '',
      status: row.status as ClassPublicView['status'],
      feeCost: row.feeCost,
      feeCurrency: row.feeCurrency,
      feeEnabled,
      isMember,
      // Đã ghi danh ACTIVE (thuộc roster) thì không bị mời mua lại;
      // lớp đã lưu trữ đóng băng ghi danh mới nên cũng không bán nữa.
      canPurchase: feeEnabled && !isMember && row.status === 'active',
    };
  }

  /**
   * Cổng phía lớp cho việc TẠO payment `class_fee` — PaymentsService
   * gọi trước khi chọn tài khoản và tạo payment. Mọi luật thuộc về lớp
   * nằm ở đây; luật tiền (chọn tài khoản, cổng tenant của account, sinh
   * mã/QR) nằm ở PaymentsService, cùng khuôn `createFeePayment` của
   * `enrol_fee`:
   *  1. Lớp phải thuộc tenant hiệu lực (trang mua gói nằm trong tenant)
   *     — lớp của tenant khác nhận 404 như không tồn tại.
   *  2. Lớp đã lưu trữ → 400 `class.archived` (roster đóng băng, không
   *     bán ghi danh mới vào lớp đã đóng).
   *  3. Lớp không bật thu học phí (`feeCost` null/0) → 400
   *     `payment.no_fee` (cùng mã lỗi với instance fee không có phí).
   *  4. Người mua đã thuộc roster → 409 `class.already_member`: đã ghi
   *     danh ACTIVE thì không mua lại gói lớp.
   *
   * @param classId - Id của lớp được mua gói.
   * @param userId - Người mua.
   * @returns Đích thu học phí của lớp (tenant + số tiền + tài khoản chỉ định riêng nếu có).
   */
  async resolveClassFeePurchase(classId: string, userId: string): Promise<ClassFeeTarget> {
    const row = await this.getClassRow(classId);
    if (row.status === 'archived') {
      throw new BadRequestException({ message: 'Class is archived; enrolment is frozen', code: 'class.archived' });
    }
    if (row.feeCost === null || row.feeCost <= 0) {
      throw new BadRequestException({ message: 'Class has no fee configured', code: 'payment.no_fee' });
    }
    if (await this.groups.isCohortMember(row.cohortId, userId)) {
      throw new ConflictException({ message: 'User is already a member of this class', code: 'class.already_member' });
    }
    return {
      classId: row.id,
      tenantId: row.tenantId,
      feeCost: row.feeCost,
      feeCurrency: row.feeCurrency,
      feePaymentAccountId: row.feePaymentAccountId,
    };
  }

  /**
   * Đích học phí của lớp phục vụ ĐỐI CHIẾU tại điểm kích hoạt quyền
   * lợi của pipeline thanh toán (issue #419): chỉ đọc tenant sở hữu
   * và học phí đang cấu hình của lớp từ bản ghi phía server, KHÔNG
   * áp các cổng phía người mua của `resolveClassFeePurchase` — tại
   * thời điểm kích hoạt, lớp đã lưu trữ hay người mua đã thuộc
   * roster đều là trạng thái có thể hợp lệ của một payment đã tạo
   * trước đó, và phép đối chiếu chỉ cần trả lời "payment có khớp
   * giá + tenant của lớp đích hay không". Chạy trong ngữ cảnh
   * platform tường minh vì các điểm kích hoạt (matching SePay bất
   * đồng bộ, webhook gateway) không mang phiên tenant của lớp đích
   * — cùng khuôn đọc của `activatePaidClassEnrol` ngay dưới đây.
   *
   * @param classId - Id của lớp (chính là `item_id` của payment `class_fee`).
   * @returns Tenant sở hữu và học phí đang cấu hình của lớp; null khi lớp không tồn tại.
   */
  async getClassFeeTarget(classId: string): Promise<{ tenantId: string; feeCost: number | null } | null> {
    return this.tenantContext.run({ platform: true }, async () => {
      const row = await this.repo.getClass(classId);
      if (!row) return null;
      return { tenantId: row.tenantId, feeCost: row.feeCost };
    });
  }

  /**
   * Kích hoạt ghi danh cấp lớp sau khi payment `class_fee` thành công —
   * hàm song song với `EnrolService.activatePaidEnrol`, chỉ
   * PaymentsService gọi sau khi payment đã `succeeded` qua đường đã xác
   * thực (webhook manual đã verify / matching SePay khớp đủ 3 điều
   * kiện). Quyết định cho vào đã nằm ở payment thành công nên đường này
   * đi qua cổng HỆ THỐNG của cohort, không gác capability của một actor.
   *
   * Flow:
   *  1. Chạy trong ngữ cảnh platform tường minh: webhook/IPN không có
   *     ngữ cảnh tenant của request, lớp đích có thể thuộc tenant khác
   *     tenant nền — cùng tiền lệ tra mã tham gia của CLASS-1.
   *  2. Đảm bảo tư cách thành viên tenant của lớp cho người mua (học
   *     sinh tự do ở trang chính mua lớp của trung tâm thì được cấp
   *     membership của trung tâm ở bước này, như đường tự báo danh).
   *  3. Thêm vào backing cohort qua `addCohortMemberInternal` — cohort
   *     sync vật chất hoá ghi danh xuống MỌI khoá của lớp.
   *
   * Idempotent: đã thuộc roster thì đường cohort tự bỏ qua (không phát
   * sự kiện, không ghi danh trùng) — webhook replay / matching chạy lại
   * / tiêu thụ outbox lặp đều an toàn.
   *
   * @param classId - Id của lớp (chính là `item_id` của payment).
   * @param userId - Người mua (chính là `user_id` của payment).
   * @throws NotFoundException `class.not_found` khi lớp không tồn tại.
   * @throws BadRequestException `class.archived` khi lớp đã lưu trữ —
   *   payment đã thu tiền nhưng roster đóng băng: vận hành xử lý bằng
   *   hoàn tiền, không tự phá luật đóng băng của CLASS-0.
   */
  async activatePaidClassEnrol(classId: string, userId: string): Promise<void> {
    await this.tenantContext.run({ platform: true }, async () => {
      const row = await this.repo.getClass(classId);
      if (!row) {
        throw new NotFoundException({ message: `Class ${classId} not found`, code: 'class.not_found' });
      }
      if (row.status === 'archived') {
        throw new BadRequestException({ message: 'Class is archived; roster is frozen', code: 'class.archived' });
      }
      // Đã thuộc roster (kích hoạt lặp / webhook replay) → dừng tại
      // đây: không phát lại sự kiện vào lớp, không ghi danh trùng.
      if (await this.groups.isCohortMember(row.cohortId, userId)) return;
      await this.tenants.ensureActiveMembership(row.tenantId, userId);
      await this.groups.addCohortMemberInternal(row.cohortId, userId);
      await this.outbox.enqueueStandalone({
        aggregate: 'class', type: 'class_member_joined',
        payload: { classId: row.id, tenantId: row.tenantId, userId, via: 'class_fee' },
        tenantId: row.tenantId,
      });
    });
  }

  /**
   * Đảo quyền lợi khi payment `class_fee` bị hoàn TOÀN BỘ — đối tác của
   * `activatePaidClassEnrol`, chỉ PaymentsService gọi từ đường refund
   * (đã gác `payment:manageaccounts` ở đó, kèm lệnh chi đã xác nhận).
   *
   * Cơ chế: gỡ người học khỏi backing cohort qua đường hệ thống —
   * cohort sync áp chế độ rời của từng instance cohort của lớp xuống
   * mọi khoá; chế độ mặc định của lớp là `suspend` nên ghi danh thành
   * SUSPENDED, GIỮ NGUYÊN điểm và dữ liệu học tập (luật rời lớp mặc
   * định của mô hình lớp). Học sinh rơi vào danh sách "đã đình chỉ"
   * của lớp và được kích hoạt lại nguyên trạng nếu vào lại roster.
   *
   * Khác đường gỡ roster thủ công ở hai điểm có chủ đích: (1) không
   * gác capability của actor — quyết định nằm ở lệnh hoàn tiền đã xác
   * thực; (2) lớp ĐÃ LƯU TRỮ vẫn gỡ được — hoàn tiền là giao dịch bù
   * trừ tài chính, không phải thao tác sửa roster, nên luật đóng băng
   * roster không chặn nó. Không thuộc roster thì bỏ qua (idempotent).
   *
   * @param classId - Id của lớp (chính là `item_id` của payment).
   * @param userId - Người bị đình chỉ (chính là `user_id` của payment).
   * @param tx - Transaction của settle hoàn tiền (issue #490) khi bên
   *   gọi đang settle: việc gỡ roster chạy trong đúng transaction đó
   *   để rollback của settle cũng huỷ việc gỡ. Khi truyền `tx`, sự
   *   kiện `cohort_member_removed` trong-tiến-trình KHÔNG phát ở đây
   *   (handler đồng bộ đọc trạng thái đã commit — phát giữa
   *   transaction sẽ thấy thành viên vẫn còn và bỏ qua) — hàm trả về
   *   cohortId của lần gỡ để bên gọi phát bù qua
   *   `notifyPaidClassMemberRemoved` SAU khi transaction của nó
   *   commit. Không truyền `tx` thì hành vi như cũ, trả về null.
   */
  async suspendPaidClassMember(classId: string, userId: string, tx?: DbTx): Promise<string | null> {
    return this.tenantContext.run({ platform: true }, async () => {
      const row = await this.repo.getClass(classId);
      if (!row) return null;
      const removed = await this.groups.removeCohortMemberInternal(row.cohortId, userId, tx);
      return tx && removed ? row.cohortId : null;
    });
  }

  /**
   * Phát bù sự kiện rời cohort cho một lần gỡ roster đã commit trong
   * transaction của bên gọi (settle hoàn tiền — xem
   * `suspendPaidClassMember`): cohort sync của EnrolService nhận sự
   * kiện này mới đình chỉ/rút các ghi danh tương ứng, và nó phải đọc
   * được trạng thái thành viên ĐÃ commit nên chỉ được phát sau
   * commit.
   */
  async notifyPaidClassMemberRemoved(cohortId: string, userId: string): Promise<void> {
    await this.groups.emitCohortMemberRemoved(cohortId, userId);
  }

  // --- móc cho đường tạo khoá (CourseClassHook) --------------------------------

  /**
   * Phân giải lớp đích khi tạo khoá: lớp phải tồn tại trong đúng tenant
   * của danh mục đích và chưa lưu trữ; trả context lớp làm cha context
   * khoá + cổng capability `course:create`.
   */
  async resolveClass(classId: string, tenantId: string): Promise<{ classId: string; contextId: string }> {
    const row = await this.repo.getClass(classId);
    if (!row || row.tenantId !== tenantId) {
      throw new NotFoundException({ message: `Class ${classId} not found`, code: 'class.not_found' });
    }
    if (row.status === 'archived') {
      throw new BadRequestException({ message: 'Class is archived; cannot add courses', code: 'class.archived' });
    }
    return { classId: row.id, contextId: await this.classContextId(row.id) };
  }

  /**
   * Vật chất hoá phía lớp ngay khi một khoá được tạo trong lớp: group
   * "cả lớp" + enrol instance cohort trỏ vào backing cohort (backfill
   * toàn bộ roster hiện có qua cơ chế instance cohort sẵn có).
   */
  async onCourseCreated(course: CourseRow): Promise<void> {
    if (!course.classId) return;
    const row = await this.repo.getClass(course.classId);
    if (!row) return;
    const group = await this.groups.createGroupInternal(course.id, CLASS_WHOLE_GROUP_NAME);
    await this.enrol.ensureClassCohortInstance(
      course.id,
      row.cohortId,
      row.onLeave === 'unenrol' ? 'unenrol' : 'suspend',
      group.id,
    );
  }
}
