import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RoleSeparationService } from '../access/role-separation.service';
import { AvailabilityService } from '../availability/availability.service';
import { CoursesService, GROUPMODE_SEPARATEGROUPS } from '../courses/courses.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import { TenantsService } from '../tenants/tenants.service';
import { GroupsRepository, type CohortRow, type GroupRow, type GroupingRow } from '@lms/db/repositories/groups';
import type { DbTx } from '../../db/database';
import { GroupsTransitionalRepository } from './groups-transitional.repository';

/**
 * Facade của GroupsModule (core_group + cohort của Moodle).
 *
 * Nhóm tách biệt là luật DỮ LIỆU, không phải bộ lọc UI (report §2#6): khi một
 * khoá học (hoặc cm) ở chế độ SEPARATEGROUPS, một user không có
 * `group:accessallgroups` (hoặc `course:managegroups`, hoặc site
 * admin) chỉ có thể thấy nhóm của chính mình và thành viên của chúng — thi hành
 * tại đây trong service cho mọi đường đọc. VISIBLEGROUPS không áp hạn chế đọc
 * nào (đường ghi vẫn gác capability). Một khoá học có
 * `groupModeForce` ép chế độ của nó lên mọi bề mặt cm.
 *
 * Thay đổi thành viên cohort được công bố thành sự kiện outbox
 * (cohort_member_added / cohort_member_removed); EnrolModule lắng nghe và
 * thực hiện ghi danh đồng bộ cohort — Groups không bao giờ import Enrol.
 */
@Injectable()
/**
 * Nghiệp vụ nhóm và cohort.
 * Quy tắc hiển thị (đối chiếu Moodle group/lib.php): ở chế độ nhóm tách biệt (separate groups),
 * người không có capability accessallgroups chỉ thấy nhóm mình thuộc về và thành viên của chúng.
 * Thay đổi thành viên cohort phát sự kiện để enrol cohort-sync đồng bộ ghi danh.
 */
export class GroupsService implements OnModuleInit {
  constructor(
    private readonly repo: GroupsRepository,
    private readonly courses: CoursesService,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly availability: AvailabilityService,
    private readonly outbox: OutboxService,
    private readonly emitter: EventEmitter2,
    private readonly i18n: I18nService,
    private readonly tenantContext: TenantContextService,
    private readonly tenants: TenantsService,
    private readonly roleSeparation: RoleSeparationService,
    private readonly txRepo: GroupsTransitionalRepository,
  ) {}

  /** Tenant hiệu lực cho cohort mới: category (nếu có) quyết định, không thì tenant của request, ngoài request rơi về tenant-zero. */
  private async cohortTenantId(categoryId?: string): Promise<string> {
    if (categoryId !== undefined) return (await this.courses.getCategory(categoryId)).tenantId;
    return this.tenantContext.currentTenantId() ?? (await this.tenants.fallbackTenantId());
  }

  /**
   * Khởi tạo: đăng ký các hook liên module cần thiết.
   */
  onModuleInit(): void {
    // Các lá availability thuộc sở hữu của module này (mẫu registry).
    this.availability.register('group', async (leaf, ctx) => {
      const groupId = String(leaf.id ?? leaf.groupId ?? '');
      const member = groupId ? await this.repo.isMember(groupId, ctx.userId) : false;
      return { available: member, description: this.i18n.t('availability.mustBeInGroup', { args: { groupId } }) };
    });
    this.availability.register('grouping', async (leaf, ctx) => {
      const groupingId = String(leaf.id ?? leaf.groupingId ?? '');
      if (!groupingId) return { available: false, description: this.i18n.t('availability.groupingMissingId') };
      const groups = await this.repo.groupsInGrouping(groupingId);
      for (const g of groups) {
        if (await this.repo.isMember(g.id, ctx.userId)) return { available: true, description: this.i18n.t('availability.inGrouping', { args: { groupingId } }) };
      }
      return { available: false, description: this.i18n.t('availability.mustBeInGrouping', { args: { groupingId } }) };
    });
  }

  // --- nhóm ---------------------------------------------------------------
  private async requireManageGroups(actorId: string, courseId: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'course:managegroups', await this.courses.courseContextId(courseId));
  }

  /**
   * Người xem có capability quản lý nhóm tại khoá học hay không (site admin
   * được tính là có — xem PermissionEvaluator.hasCapability).
   */
  async canManageGroups(actorId: string, courseId: string): Promise<boolean> {
    return this.evaluator.hasCapability(actorId, 'course:managegroups', await this.courses.courseContextId(courseId));
  }

  /**
   * Che khoá ghi danh của nhóm đối với người không có quyền quản lý nhóm:
   * khoá là bí mật, response chỉ mang `enrolmentKey: null` (vẫn giữ nguyên
   * hình dạng bản ghi để client không phải đoán trường có tồn tại hay không).
   */
  private hideGroupKey(group: GroupRow): GroupRow {
    return group.enrolmentKey ? { ...group, enrolmentKey: null } : group;
  }

  /**
   * Tạo nhóm trong khoá học; `enrolmentKey` đặt khoá ghi danh riêng của nhóm
   * (người tạo là staff quản lý nhóm nên bản ghi trả về giữ nguyên khoá).
   */
  async createGroup(actorId: string, courseId: string, input: { name: string; idNumber?: string; description?: string; enrolmentKey?: string }): Promise<GroupRow> {
    await this.courses.getCourse(courseId);
    await this.requireManageGroups(actorId, courseId);
    const row = await this.repo.insertGroup({ courseId: courseId, name: input.name, idNumber: input.idNumber ?? '', description: input.description ?? '', enrolmentKey: input.enrolmentKey ?? null });
    await this.outbox.enqueueStandalone({ aggregate: 'group', type: 'group_created', payload: { groupId: row.id, courseId } });
    return row;
  }
  /**
   * Lấy nhóm; ném groups.not_found khi vắng.
   */
  async getGroup(id: string): Promise<GroupRow> {
    const row = await this.repo.getGroup(id);
    if (!row) throw new NotFoundException({ message: `Group ${id} not found`, code: 'group.not_found' });
    return row;
  }
  /**
   * Cập nhật nhóm; `enrolmentKey: null` xoá khoá ghi danh của nhóm.
   */
  async updateGroup(actorId: string, id: string, input: { name?: string; idNumber?: string; description?: string; enrolmentKey?: string | null }): Promise<GroupRow> {
    const group = await this.getGroup(id);
    await this.requireManageGroups(actorId, group.courseId);
    const { enrolmentKey, ...rest } = input;
    await this.repo.updateGroup(id, { ...rest, ...(enrolmentKey !== undefined ? { enrolmentKey: enrolmentKey } : {}) });
    return this.getGroup(id);
  }
  /**
   * Xoá nhóm.
   */
  async deleteGroup(actorId: string, id: string): Promise<void> {
    const group = await this.getGroup(id);
    await this.requireManageGroups(actorId, group.courseId);
    await this.repo.deleteGroup(id);
    await this.outbox.enqueueStandalone({ aggregate: 'group', type: 'group_deleted', payload: { groupId: id, courseId: group.courseId } });
  }

  /**
   * Người xem có đặc quyền thấy mọi nhóm của khoá học ở mọi chế độ hay không:
   * site admin, hoặc có `group:accessallgroups`, hoặc có
   * `course:managegroups` tại context khoá học (đối chiếu Moodle:
   * người quản lý nhóm không bị luật separate groups giới hạn).
   */
  async canSeeAllGroups(actorId: string, courseId: string): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(actorId)) return true;
    const ctxId = await this.courses.courseContextId(courseId);
    if (await this.evaluator.hasCapability(actorId, 'group:accessallgroups', ctxId)) return true;
    return this.evaluator.hasCapability(actorId, 'course:managegroups', ctxId);
  }

  /**
   * Chế độ nhóm hiệu lực cho một bề mặt của khoá học: khi khoá bật
   * `groupModeForce`, chế độ của khoá thắng tuyệt đối và groupMode riêng
   * của course module bị bỏ qua; ngược lại groupMode của cm (khác 0 =
   * "inherit") được ưu tiên, cuối cùng mới tới chế độ của khoá.
   */
  effectiveGroupMode(courseRow: { groupMode: number; groupModeForce: boolean }, cmGroupMode?: number): number {
    if (courseRow.groupModeForce) return courseRow.groupMode;
    return cmGroupMode !== undefined && cmGroupMode !== 0 ? cmGroupMode : courseRow.groupMode;
  }

  /**
   * Các nhóm một actor thấy được trong một khoá học theo luật nhóm tách biệt.
   * Chế độ hiệu lực: groupMode riêng của cm khi có cm và chế độ của nó
   * không phải "inherit" (0), ngược lại là groupMode của khoá học — trừ khi khoá học
   * ép chế độ của nó (groupModeForce), cái này ghi đè cm hoàn toàn.
   * VISIBLEGROUPS và NOGROUPS trả mọi nhóm; chỉ SEPARATEGROUPS
   * mới hạn chế actor không có đặc quyền vào nhóm của chính họ.
   */
  /**
   * Các nhóm user được phép thấy theo chế độ nhóm của khoá học.
   */
  async visibleGroupsFor(actorId: string, courseId: string, cmGroupMode?: number): Promise<GroupRow[]> {
    const courseRow = await this.courses.getCourse(courseId);
    const all = await this.repo.listGroups(courseId);
    const effectiveMode = this.effectiveGroupMode(courseRow, cmGroupMode);
    if (effectiveMode !== GROUPMODE_SEPARATEGROUPS) return all;
    if (await this.canSeeAllGroups(actorId, courseId)) return all;
    return this.repo.groupsOfUser(courseId, actorId);
  }

  /**
   * Liệt kê nhóm của khoá học. Khoá ghi danh của nhóm chỉ hiện với người có
   * capability quản lý nhóm; học viên thường nhận `enrolmentKey: null`.
   */
  async listGroups(actorId: string, courseId: string): Promise<GroupRow[]> {
    await this.courses.assertCourseAccess(actorId, courseId).catch(async () => {
      // User có managegroups được liệt kê ngay cả khi chưa ghi danh (giáo viên).
      await this.requireManageGroups(actorId, courseId);
    });
    const groups = await this.visibleGroupsFor(actorId, courseId);
    if (await this.canManageGroups(actorId, courseId)) return groups;
    return groups.map((g) => this.hideGroupKey(g));
  }

  /**
   * Mọi nhóm của khoá học kèm khoá ghi danh thật — đường nội bộ cho module
   * khác (enrol_self đối chiếu group enrolment key), KHÔNG phơi qua API.
   */
  async groupsForCourseInternal(courseId: string): Promise<GroupRow[]> {
    return this.repo.listGroups(courseId);
  }

  /**
   * Thêm thành viên (kiểm capability). Luật nghiệp vụ GN-2 (issue #234):
   * chỉ xếp được người đang ghi danh HIỆU LỰC trong khoá của nhóm — người
   * chưa ghi danh, đã rút hẳn, đang bị đình chỉ hoặc ngoài cửa sổ ghi danh
   * đều bị từ chối bằng 400 `group.member_not_enrolled`, để nhóm không
   * chứa "thành viên ma" không thuộc khoá. Đường nội bộ
   * `addMemberInternal` (enrol/cohort sync) KHÔNG qua cổng này vì luôn đi
   * kèm một thao tác ghi danh của hệ thống.
   */
  async addMember(actorId: string, groupId: string, userId: string): Promise<void> {
    const group = await this.getGroup(groupId);
    await this.requireManageGroups(actorId, group.courseId);
    if (!(await this.courses.isActivelyEnrolled(group.courseId, userId))) {
      throw new BadRequestException({ message: 'User is not actively enrolled in this course', code: 'group.member_not_enrolled' });
    }
    await this.repo.addMember(groupId, userId);
    await this.outbox.enqueueStandalone({ aggregate: 'group', type: 'group_member_added', payload: { groupId, courseId: group.courseId, userId } });
  }
  /**
   * Gỡ thành viên (kiểm capability).
   */
  async removeMember(actorId: string, groupId: string, userId: string): Promise<void> {
    const group = await this.getGroup(groupId);
    await this.requireManageGroups(actorId, group.courseId);
    await this.repo.removeMember(groupId, userId);
    await this.outbox.enqueueStandalone({ aggregate: 'group', type: 'group_member_removed', payload: { groupId, courseId: group.courseId, userId } });
  }

  /**
   * Thành viên của một nhóm, theo luật nhóm tách biệt: ở chế độ SEPARATEGROUPS
   * một actor không có đặc quyền hỏi về một nhóm họ không thuộc về sẽ nhận 403
   * — dữ liệu của nhóm không phải của họ để thấy, tại SERVER.
   */
  /**
   * Thành viên của nhóm.
   */
  async listMembers(actorId: string, groupId: string): Promise<{ userId: string; timeAdded: Date }[]> {
    const group = await this.getGroup(groupId);
    const visible = await this.visibleGroupsFor(actorId, group.courseId);
    if (!visible.some((g) => g.id === groupId)) {
      throw new ForbiddenException({ message: 'Separate groups: you cannot see members of a group you are not in', code: 'group.separate_groups_denied' });
    }
    const rows = await this.repo.listMembers(groupId);
    return rows.map((r) => ({ userId: r.userId, timeAdded: r.timeAdded }));
  }

  /** Mọi thành viên người xem được thấy trên toàn khoá học (dùng cho các view thành viên/dữ liệu nhóm của khoá học). */
  /**
   * Thành viên mà người xem được phép thấy.
   */
  async listVisibleMembers(actorId: string, courseId: string): Promise<{ groupId: string; userId: string }[]> {
    const visible = await this.visibleGroupsFor(actorId, courseId);
    const rows = await this.repo.listMembersOfGroups(visible.map((g) => g.id));
    return rows.map((r) => ({ groupId: r.groupId, userId: r.userId }));
  }

  /**
   * Nhóm của user trong khoá học.
   */
  async groupsOfUser(courseId: string, userId: string): Promise<GroupRow[]> { return this.repo.groupsOfUser(courseId, userId); }
  /**
   * Kiểm tra thành viên nhóm.
   */
  async isMember(groupId: string, userId: string): Promise<boolean> { return this.repo.isMember(groupId, userId); }
  /** Thêm nội bộ dùng bởi đồng bộ enrol/cohort (hành động hệ thống, không kiểm tra capability của actor). */
  /**
   * Thêm thành viên không kiểm capability — dành cho đồng bộ nội bộ (cohort sync).
   */
  async addMemberInternal(groupId: string, userId: string, component = '', itemId: string | null = null): Promise<void> {
    await this.repo.addMember(groupId, userId, component, itemId);
  }

  /**
   * Tạo nhóm không kiểm capability — dành cho đồng bộ nội bộ: group "cả
   * lớp" tự sinh khi một khoá được tạo trong lớp (issue #184, CLASS-0).
   * Idempotent theo (courseId, name): đã có nhóm cùng tên trong khoá thì
   * trả lại nhóm đó (unique `course_groups_course_name_unique` là chốt
   * DB; đua hai lần tạo cùng lúc thì lần sau đọc lại theo tên).
   */
  async createGroupInternal(courseId: string, name: string): Promise<GroupRow> {
    const existing = (await this.repo.listGroups(courseId)).find((g) => g.name === name);
    if (existing) return existing;
    return this.repo.insertGroup({ courseId, name, idNumber: '', description: '', enrolmentKey: null });
  }
  /**
   * Gỡ thành viên không kiểm capability — dành cho đồng bộ nội bộ.
   */
  async removeMemberInternal(groupId: string, userId: string): Promise<void> { await this.repo.removeMember(groupId, userId); }

  // --- grouping ---------------------------------------------------------------
  /**
   * Tạo grouping.
   */
  async createGrouping(actorId: string, courseId: string, input: { name: string; idNumber?: string; description?: string }): Promise<GroupingRow> {
    await this.courses.getCourse(courseId);
    await this.requireManageGroups(actorId, courseId);
    const row = await this.repo.insertGrouping({ courseId: courseId, name: input.name, idNumber: input.idNumber ?? '', description: input.description ?? '' });
    await this.outbox.enqueueStandalone({ aggregate: 'grouping', type: 'grouping_created', payload: { groupingId: row.id, courseId } });
    return row;
  }
  /**
   * Lấy grouping; ném groups.grouping_not_found khi vắng.
   */
  async getGrouping(id: string): Promise<GroupingRow> {
    const row = await this.repo.getGrouping(id);
    if (!row) throw new NotFoundException({ message: `Grouping ${id} not found`, code: 'group.grouping_not_found' });
    return row;
  }
  /**
   * Liệt kê grouping của khoá học. Khi có `actorId`, luật separate groups
   * áp dụng như với danh sách nhóm: người xem thường chỉ thấy các grouping
   * chứa ít nhất một nhóm mình được phép thấy (grouping không chứa nhóm nào
   * mình thấy được coi như không tồn tại); ở visible/no-groups hoặc khi có
   * đặc quyền (xem `canSeeAllGroups`) thì thấy tất cả. Không truyền
   * `actorId` là đường nội bộ giữa các module, trả về toàn bộ.
   */
  async listGroupings(courseId: string, actorId?: string): Promise<GroupingRow[]> {
    const all = await this.repo.listGroupings(courseId);
    if (!actorId || !all.length) return all;
    await this.courses.assertCourseAccess(actorId, courseId).catch(async () => {
      // Người quản lý nhóm được liệt kê dù chưa ghi danh (như listGroups).
      await this.requireManageGroups(actorId, courseId);
    });
    const visible = await this.visibleGroupsFor(actorId, courseId);
    if (visible.length === (await this.repo.listGroups(courseId)).length) return all;
    const visibleIds = new Set(visible.map((g) => g.id));
    const kept: GroupingRow[] = [];
    for (const grouping of all) {
      const groups = await this.repo.groupsInGrouping(grouping.id);
      if (groups.some((g) => visibleIds.has(g.id))) kept.push(grouping);
    }
    return kept;
  }
  /**
   * Xoá grouping.
   */
  async deleteGrouping(actorId: string, id: string): Promise<void> {
    const grouping = await this.getGrouping(id);
    await this.requireManageGroups(actorId, grouping.courseId);
    await this.repo.deleteGrouping(id);
  }
  /**
   * Đưa nhóm vào grouping.
   */
  async addGroupToGrouping(actorId: string, groupingId: string, groupId: string): Promise<void> {
    const grouping = await this.getGrouping(groupingId);
    const group = await this.getGroup(groupId);
    if (group.courseId !== grouping.courseId) throw new ForbiddenException({ message: 'Group and grouping are in different courses', code: 'group.course_mismatch' });
    await this.requireManageGroups(actorId, grouping.courseId);
    await this.repo.addGroupToGrouping(groupingId, groupId);
  }
  /**
   * Nhóm thuộc grouping; khi có `actorId`, danh sách được lọc theo luật hiển
   * thị nhóm của khoá chứa grouping (separate groups: chỉ còn nhóm người xem
   * được phép thấy) và khoá ghi danh bị che trừ khi người xem có capability
   * quản lý nhóm. Không truyền `actorId` là đường nội bộ (availability),
   * trả về toàn bộ nhóm của grouping.
   */
  async groupsInGrouping(groupingId: string, actorId?: string): Promise<GroupRow[]> {
    const groups = await this.repo.groupsInGrouping(groupingId);
    if (!actorId || !groups.length) return groups;
    const courseId = groups[0]!.courseId;
    const visible = await this.visibleGroupsFor(actorId, courseId);
    const visibleIds = new Set(visible.map((g) => g.id));
    const scoped = groups.filter((g) => visibleIds.has(g.id));
    if (await this.canManageGroups(actorId, courseId)) return scoped;
    return scoped.map((g) => this.hideGroupKey(g));
  }

  // --- cohort -------------------------------------------------------------------
  private async cohortContextId(input: { contextLevel?: number; categoryId?: string }, tenantId: string): Promise<string> {
    if (input.categoryId !== undefined) {
      const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSECAT, input.categoryId);
      if (!ctx) throw new NotFoundException({ message: `No context for category ${input.categoryId}`, code: 'cohort.category_context_missing' });
      return ctx.id;
    }
    // Cohort không gắn category neo vào context TENANT của tenant sở hữu
    // (không còn neo thẳng hệ thống) để cổng membership + phạm vi vai của
    // tenant áp được lên cohort và các bank tổ bám vào nó (TENANT-0, #168).
    return (await this.contexts.ensureTenantContext(tenantId)).id;
  }

  /**
   * Tạo cohort trong một tenant (theo category hoặc tenant hiệu lực).
   */
  async createCohort(actorId: string, input: { name: string; idNumber?: string; description?: string; categoryId?: string; visible?: boolean }): Promise<CohortRow> {
    const tenantId = await this.cohortTenantId(input.categoryId);
    const contextId = await this.cohortContextId(input, tenantId);
    await this.evaluator.requireCapability(actorId, 'cohort:manage', contextId);
    const row = await this.repo.insertCohort({
      tenantId,
      name: input.name, idNumber: input.idNumber ?? '', description: input.description ?? '',
      contextId, visible: input.visible ?? true,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'cohort', type: 'cohort_created', payload: { cohortId: row.id }, tenantId });
    return row;
  }
  /**
   * Lấy cohort; ném groups.cohort_not_found khi vắng (kể cả khi cohort
   * thuộc tenant khác — 404 đồng nhất). Khi có `actorId` (đường HTTP —
   * H10 của rà soát #134), người xem phải qua cùng cổng
   * `requireCohortViewer` như đường đọc thành viên: không có
   * `cohort:view`/`cohort:manage` tại context của cohort thì nhận đúng
   * 404 như cohort không tồn tại. Không truyền `actorId` là đường nội bộ
   * giữa các module, giữ nguyên hành vi.
   */
  async getCohort(id: string, actorId?: string): Promise<CohortRow> {
    const row = await this.repo.getCohort(id);
    const active = this.tenantContext.currentTenantId();
    if (!row || (active !== undefined && row.tenantId !== active)) {
      throw new NotFoundException({ message: `Cohort ${id} not found`, code: 'cohort.not_found' });
    }
    if (actorId !== undefined) await this.requireCohortViewer(actorId, row);
    return row;
  }
  /**
   * Liệt kê cohort mà người gọi được xem: chỉ cohort của tenant hiệu lực
   * (TENANT-0) mà người gọi có `cohort:view` hoặc `cohort:manage` tại
   * context của chính cohort đó (H10, rà soát #134) — trước đây mọi user
   * đã đăng nhập liệt kê được cohort của toàn site dù registry đã có
   * sẵn `cohort:view`.
   */
  async listCohorts(actorId: string): Promise<CohortRow[]> {
    const all = await this.repo.listCohorts();
    const active = this.tenantContext.currentTenantId();
    const scoped = active ? all.filter((c) => c.tenantId === active) : all;
    const out: CohortRow[] = [];
    for (const row of scoped) {
      const canView = await this.evaluator.hasCapability(actorId, 'cohort:view', row.contextId);
      const canManage = canView ? false : await this.evaluator.hasCapability(actorId, 'cohort:manage', row.contextId);
      if (canView || canManage) out.push(row);
    }
    return out;
  }
  /**
   * Cập nhật cohort.
   */
  async updateCohort(actorId: string, id: string, input: { name?: string; idNumber?: string; description?: string; visible?: boolean }): Promise<CohortRow> {
    const cohortRow = await this.getCohort(id);
    await this.evaluator.requireCapability(actorId, 'cohort:manage', cohortRow.contextId);
    await this.repo.updateCohort(id, input);
    return this.getCohort(id);
  }
  /**
   * Xoá cohort.
   */
  async deleteCohort(actorId: string, id: string): Promise<void> {
    const cohortRow = await this.getCohort(id);
    await this.evaluator.requireCapability(actorId, 'cohort:manage', cohortRow.contextId);
    await this.repo.deleteCohort(id);
  }
  /**
   * Thành viên cohort. Khi có `actorId` (đường HTTP), người xem phải có
   * capability `cohort:view` hoặc `cohort:manage` tại context của cohort —
   * cùng chuẩn capability/context với các thao tác cohort khác; người ngoài
   * nhận 404 `cohort.not_found` giống hệt cohort không tồn tại, để không lộ
   * sự tồn tại của cohort (issue #44). Không truyền `actorId` là đường nội
   * bộ giữa các module (đồng bộ ghi danh theo cohort, sinh learning plan),
   * trả về toàn bộ.
   */
  async listCohortMembers(cohortId: string, actorId?: string): Promise<{ userId: string; timeAdded: Date }[]> {
    const cohortRow = await this.getCohort(cohortId);
    if (actorId !== undefined) await this.requireCohortViewer(actorId, cohortRow);
    const rows = await this.repo.listCohortMembers(cohortId);
    return rows.map((r) => ({ userId: r.userId, timeAdded: r.timeAdded }));
  }
  /**
   * Cổng xem cohort cho các đường đọc dữ liệu thành viên: đạt khi có
   * `cohort:view` hoặc `cohort:manage` tại context của cohort (site admin
   * được PermissionEvaluator tính là có cả hai). Không đạt thì ném đúng 404
   * `cohort.not_found` như khi cohort vắng.
   */
  private async requireCohortViewer(actorId: string, cohortRow: CohortRow): Promise<void> {
    const canView = await this.evaluator.hasCapability(actorId, 'cohort:view', cohortRow.contextId);
    const canManage = canView ? false : await this.evaluator.hasCapability(actorId, 'cohort:manage', cohortRow.contextId);
    if (!canView && !canManage) throw new NotFoundException({ message: `Cohort ${cohortRow.id} not found`, code: 'cohort.not_found' });
  }
  /**
   * Kiểm tra thành viên cohort.
   */
  async isCohortMember(cohortId: string, userId: string): Promise<boolean> { return this.repo.isCohortMember(cohortId, userId); }

  /**
   * Thêm một user vào cohort. Phát cohort_member_added (outbox + trong tiến trình)
   * để handler đồng bộ cohort của EnrolModule ghi danh họ vào mọi khoá học có
   * instance enrol cohort liên kết.
   */
  /**
   * Thêm thành viên cohort và phát sự kiện đồng bộ ghi danh (cohort sync).
   */
  async addCohortMember(actorId: string, cohortId: string, userId: string): Promise<void> {
    const cohortRow = await this.getCohort(cohortId);
    await this.evaluator.requireCapability(actorId, 'cohort:manage', cohortRow.contextId);
    // Chốt TÁCH VAI — funnel 2 (RoleSeparationService giữ định nghĩa
    // dùng chung): vào cohort của một lớp đồng nghĩa được ghi danh
    // học viên vào mọi khoá của lớp đó, nên người đang DẠY bất kỳ
    // khoá nào thuộc lớp/cohort này bị từ chối tại đây với mã
    // `access.role_context_conflict`, TRƯỚC khi dòng thành viên được
    // tạo (và trước khi sự kiện đồng bộ phát ra). Mọi đường roster
    // của lớp — theo userId, khớp email/số điện thoại, nhập Excel —
    // đều đi qua điểm vào này hoặc điểm vào hệ thống bên dưới.
    await this.roleSeparation.assertCohortMembershipAllowed(userId, cohortId);
    const added = await this.repo.addCohortMember(cohortId, userId);
    if (!added) return;
    await this.outbox.enqueueStandalone({ aggregate: 'cohort', type: 'cohort_member_added', payload: { cohortId, userId } });
    await this.emitter.emitAsync('cohort_member_added', { cohortId, userId });
  }
  /**
   * Gỡ thành viên cohort và phát sự kiện để enrol cohort-sync rút ghi danh tương ứng.
   */
  async removeCohortMember(actorId: string, cohortId: string, userId: string): Promise<void> {
    const cohortRow = await this.getCohort(cohortId);
    await this.evaluator.requireCapability(actorId, 'cohort:manage', cohortRow.contextId);
    const removed = await this.repo.removeCohortMember(cohortId, userId);
    if (!removed) return;
    await this.outbox.enqueueStandalone({ aggregate: 'cohort', type: 'cohort_member_removed', payload: { cohortId, userId } });
    await this.emitCohortMemberRemoved(cohortId, userId);
  }

  /**
   * Phát sự kiện trong-tiến-trình `cohort_member_removed` — móc mà
   * EnrolService lắng nghe để đình chỉ/rút các ghi danh cohort-sync.
   * Tách thành điểm vào riêng để các luồng ĐANG ở trong một transaction
   * (settle hoàn tiền học phí lớp, issue #490) có thể hoãn việc phát
   * cho tới SAU khi transaction commit: handler đồng bộ đọc trạng thái
   * thành viên ĐÃ commit, phát giữa transaction sẽ thấy thành viên vẫn
   * còn và bỏ qua việc đình chỉ.
   */
  async emitCohortMemberRemoved(cohortId: string, userId: string): Promise<void> {
    await this.emitter.emitAsync('cohort_member_removed', { cohortId, userId });
  }
  /**
   * Thêm thành viên cohort theo đường HỆ THỐNG (không gác capability của
   * một actor cụ thể): dùng cho luồng mà quyết định cho vào đã được gác ở
   * tầng nghiệp vụ phía trên — hiện là tự báo danh vào lớp được duyệt /
   * tự vào thẳng theo luật lớp (ClassesService, issue #184 CLASS-1):
   * người xin vào là học sinh, vốn không có `cohort:manage`. Phát đúng
   * cùng cặp sự kiện như `addCohortMember` để cohort sync vật chất hoá
   * ghi danh như mọi đường roster khác.
   */
  async addCohortMemberInternal(cohortId: string, userId: string): Promise<void> {
    await this.getCohort(cohortId);
    // Chốt TÁCH VAI — funnel 2, điểm vào hệ thống: cùng kiểm tra như
    // addCohortMember (đường này phục vụ tham gia lớp bằng mã và kích
    // hoạt sau thanh toán gói lớp — người xin vào vẫn không được là
    // giáo viên của chính lớp/khoá đích).
    await this.roleSeparation.assertCohortMembershipAllowed(userId, cohortId);
    const added = await this.repo.addCohortMember(cohortId, userId);
    if (!added) return;
    await this.outbox.enqueueStandalone({ aggregate: 'cohort', type: 'cohort_member_added', payload: { cohortId, userId } });
    await this.emitter.emitAsync('cohort_member_added', { cohortId, userId });
  }
  /**
   * Gỡ thành viên cohort theo đường HỆ THỐNG — đối tác của
   * `addCohortMemberInternal`, dùng cho luồng mà quyết định gỡ đã được
   * gác ở tầng nghiệp vụ phía trên: hoàn tiền học phí lớp (CLASS-3,
   * issue #184) — lệnh hoàn đã gác bằng `payment:manageaccounts` ở
   * PaymentsService, người bị gỡ là học sinh vốn không giữ
   * `cohort:manage`. Phát đúng cùng cặp sự kiện như
   * `removeCohortMember` để cohort sync đình chỉ/rút ghi danh ở mọi
   * khoá theo chế độ rời của từng instance. Không phải thành viên thì
   * im lặng bỏ qua (idempotent — tiêu thụ lặp sự kiện hoàn tiền không
   * phát sự kiện hai lần).
   *
   * Biến thể TRONG TRANSACTION (issue #490): khi bên gọi truyền `tx`
   * (settle hoàn tiền), việc xoá và dòng outbox đi bằng chính
   * transaction đó — rollback thì cả hai cùng huỷ — và sự kiện
   * trong-tiến-trình KHÔNG phát ở đây (handler đọc trạng thái đã
   * commit nên phải chờ sau commit); hàm trả `true` để bên gọi biết
   * cần phát bù qua `emitCohortMemberRemoved` sau khi transaction của
   * nó commit xong. Không truyền `tx` thì hành vi như cũ và hàm trả
   * về chỉ cho biết có xoá được dòng thành viên hay không.
   */
  async removeCohortMemberInternal(cohortId: string, userId: string, tx?: DbTx): Promise<boolean> {
    await this.getCohort(cohortId);
    if (tx) {
      // Điểm nối C-8/C: bên gọi truyền transaction Drizzle của
      // settle hoàn tiền (DL-10) — lệnh xoá chạy qua repository
      // chuyển tiếp Drizzle và dòng outbox ghi bằng đúng
      // transaction đó; chủ đóng D4 #656.
      const removed = await this.txRepo.removeCohortMember(cohortId, userId, tx);
      if (!removed) return false;
      await this.outbox.enqueue(tx, { aggregate: 'cohort', type: 'cohort_member_removed', payload: { cohortId, userId } });
      return true;
    }
    const removed = await this.repo.removeCohortMember(cohortId, userId);
    if (!removed) return false;
    await this.outbox.enqueueStandalone({ aggregate: 'cohort', type: 'cohort_member_removed', payload: { cohortId, userId } });
    await this.emitCohortMemberRemoved(cohortId, userId);
    return true;
  }
}
