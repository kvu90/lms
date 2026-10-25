import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ClassView, CreateClass, UpdateClass } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
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
import { CLASS_WHOLE_GROUP_NAME, ClassesRepository, type ClassRow } from './classes.repository';

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

/** Hình dạng lớp ở bề mặt API; `joinCode` chỉ lộ cho người có quyền quản roster (bí mật như enrolment_key). */
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
    onLeave: row.onLeave as ClassView['onLeave'],
    status: row.status as ClassView['status'],
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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

  /** Người xem thấy được mã tham gia khi có quyền quản roster của lớp (hoặc là chủ lớp / quản trị tenant). */
  private async canSeeJoinCode(actorId: string, row: ClassRow): Promise<boolean> {
    if (actorId === row.ownerId) return true;
    const ctxId = await this.classContextId(row.id);
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

    const cohortRow = await this.repo.insertBackingCohort({
      tenantId,
      name: input.name,
      idNumber: '',
      description: '',
      contextId: tenantCtx.id,
      component: 'class',
      visible: false,
    });
    const row = await this.repo.insertClass({
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
    });
    const classCtx = await this.contexts.createContext(CONTEXT_LEVELS.CLASS, row.id, tenantCtx.id);
    await this.repo.updateCohortContext(cohortRow.id, classCtx.id);
    await this.applyClassRoleGrants(classCtx.id, actorId);
    const ownerRole = await this.roles.getRoleByShortname(CLASS_OWNER_ROLE);
    if (!ownerRole) throw new Error('editingteacher role not seeded');
    await this.roles.assignRole(ownerId, ownerRole.id, classCtx.id, actorId);
    await this.outbox.enqueueStandalone({
      aggregate: 'class', type: 'class_created',
      payload: { classId: row.id, tenantId, ownerId, actorId },
      tenantId,
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

  /** Vật chất hoá bộ capability của 4 vai tại đúng context lớp này (gọi lúc tạo lớp). */
  private async applyClassRoleGrants(classContextId: string, modifierId: string): Promise<void> {
    await this.ensureClassRoles();
    for (const [shortName, caps] of Object.entries(CLASS_ROLE_GRANTS)) {
      const role = await this.roles.getRoleByShortname(shortName);
      if (!role) continue;
      for (const cap of caps) {
        await this.roles.setCapabilityOverride(role.id, cap, classContextId, CAP_ALLOW, modifierId);
      }
    }
  }

  /** Danh sách lớp của tenant hiệu lực mà người xem có liên hệ (chủ lớp / có vai tại lớp / thành viên roster); quản trị tenant thấy toàn bộ. */
  async listClasses(actorId: string): Promise<ClassView[]> {
    const tenantId = await this.effectiveTenantId();
    const rows = await this.repo.listClassesByTenant(tenantId);
    const tenantCtx = await this.contexts.getTenantContext(tenantId);
    const seesAll = (await this.evaluator.isSiteAdmin(actorId))
      || (tenantCtx ? await this.evaluator.hasCapability(actorId, 'tenant:manage', tenantCtx.id) : false);
    const visible: ClassRow[] = [];
    for (const row of rows) {
      if (seesAll || (await this.canViewClass(actorId, row))) visible.push(row);
    }
    return Promise.all(visible.map(async (row) => toClassDto(row, await this.canSeeJoinCode(actorId, row))));
  }

  /** Chi tiết một lớp (cổng xem như canViewClass). */
  async getClass(actorId: string, id: string): Promise<ClassView> {
    const row = await this.getClassRow(id);
    if (!(await this.canViewClass(actorId, row))) {
      throw new NotFoundException({ message: `Class ${id} not found`, code: 'class.not_found' });
    }
    return toClassDto(row, await this.canSeeJoinCode(actorId, row));
  }

  /** Sửa lớp; đổi `onLeave` thì đẩy xuống mọi instance cohort hiện có của lớp; xoay mã tham gia làm mã cũ mất hiệu lực ngay. */
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

  /** Danh sách học sinh của lớp (cổng xem lớp). */
  async listRoster(actorId: string, classId: string): Promise<{ userId: string; timeAdded: string }[]> {
    const row = await this.getClassRow(classId);
    if (!(await this.canViewClass(actorId, row))) {
      throw new NotFoundException({ message: `Class ${classId} not found`, code: 'class.not_found' });
    }
    const members = await this.groups.listCohortMembers(row.cohortId);
    return members.map((m) => ({ userId: m.userId, timeAdded: m.timeAdded.toISOString() }));
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
