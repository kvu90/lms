import { ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { AvailabilityService } from '../availability/availability.service';
import { CoursesService, GROUPMODE_SEPARATEGROUPS } from '../courses/courses.service';
import { GroupsRepository, type CohortRow, type GroupRow, type GroupingRow } from './groups.repository';

/**
 * GroupsModule facade (Moodle core_group + cohort).
 *
 * Separate groups is a DATA law, not a UI filter (report §2#6): when a
 * course (or cm) is in SEPARATEGROUPS mode, a user without
 * `moodle/group:accessallgroups` (or `moodle/course:managegroups`, or site
 * admin) can only ever see their own groups and their members — enforced
 * here in the service for every read. VISIBLEGROUPS imposes no read
 * restriction (writes stay capability-gated). A course with
 * `groupModeForce` forces its mode onto every cm surface.
 *
 * Cohort membership changes are published as outbox events
 * (cohort_member_added / cohort_member_removed); EnrolModule listens and
 * performs the cohort-sync enrolments — Groups never imports Enrol.
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
  ) {}

  /**
   * Khởi tạo: đăng ký các hook liên module cần thiết.
   */
  onModuleInit(): void {
    // Availability leaves owned by this module (registry pattern).
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

  // --- groups ---------------------------------------------------------------
  private async requireManageGroups(actorId: string, courseId: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'moodle/course:managegroups', await this.courses.courseContextId(courseId));
  }

  /**
   * Người xem có capability quản lý nhóm tại khoá học hay không (site admin
   * được tính là có — xem PermissionEvaluator.hasCapability).
   */
  async canManageGroups(actorId: string, courseId: string): Promise<boolean> {
    return this.evaluator.hasCapability(actorId, 'moodle/course:managegroups', await this.courses.courseContextId(courseId));
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
   * site admin, hoặc có `moodle/group:accessallgroups`, hoặc có
   * `moodle/course:managegroups` tại context khoá học (đối chiếu Moodle:
   * người quản lý nhóm không bị luật separate groups giới hạn).
   */
  async canSeeAllGroups(actorId: string, courseId: string): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(actorId)) return true;
    const ctxId = await this.courses.courseContextId(courseId);
    if (await this.evaluator.hasCapability(actorId, 'moodle/group:accessallgroups', ctxId)) return true;
    return this.evaluator.hasCapability(actorId, 'moodle/course:managegroups', ctxId);
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
   * The groups visible to an actor in a course under the separate-groups law.
   * Effective mode: the cm's own groupMode when a cm is given and its mode is
   * not "inherit" (0), otherwise the course groupMode — unless the course
   * forces its mode (groupModeForce), which overrides the cm entirely.
   * VISIBLEGROUPS and NOGROUPS return every group; only SEPARATEGROUPS
   * restricts a non-privileged actor to their own groups.
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
      // Users with managegroups may list even without enrolment (teachers).
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
   * Thêm thành viên (kiểm capability).
   */
  async addMember(actorId: string, groupId: string, userId: string): Promise<void> {
    const group = await this.getGroup(groupId);
    await this.requireManageGroups(actorId, group.courseId);
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
   * Members of a group, under the separate-groups law: in SEPARATEGROUPS
   * mode a non-privileged actor asking for a group they are not in gets 403
   * — the group's data is not theirs to see, at the SERVER.
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

  /** All members visible to the actor across the course (used by course participant/group-data views). */
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
  /** Internal add used by enrol/cohort sync (system action, no actor capability check). */
  /**
   * Thêm thành viên không kiểm capability — dành cho đồng bộ nội bộ (cohort sync).
   */
  async addMemberInternal(groupId: string, userId: string, component = '', itemId: string | null = null): Promise<void> {
    await this.repo.addMember(groupId, userId, component, itemId);
  }
  /**
   * Gỡ thành viên không kiểm capability — dành cho đồng bộ nội bộ.
   */
  async removeMemberInternal(groupId: string, userId: string): Promise<void> { await this.repo.removeMember(groupId, userId); }

  // --- groupings ---------------------------------------------------------------
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

  // --- cohorts -------------------------------------------------------------------
  private async cohortContextId(input: { contextLevel?: number; categoryId?: string }): Promise<string> {
    if (input.categoryId !== undefined) {
      const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSECAT, input.categoryId);
      if (!ctx) throw new NotFoundException({ message: `No context for category ${input.categoryId}`, code: 'cohort.category_context_missing' });
      return ctx.id;
    }
    return (await this.contexts.ensureSystemContext()).id;
  }

  /**
   * Tạo cohort tại context hệ thống hoặc category.
   */
  async createCohort(actorId: string, input: { name: string; idNumber?: string; description?: string; categoryId?: string; visible?: boolean }): Promise<CohortRow> {
    const contextId = await this.cohortContextId(input);
    await this.evaluator.requireCapability(actorId, 'moodle/cohort:manage', contextId);
    const row = await this.repo.insertCohort({
      name: input.name, idNumber: input.idNumber ?? '', description: input.description ?? '',
      contextId, visible: input.visible ?? true,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'cohort', type: 'cohort_created', payload: { cohortId: row.id } });
    return row;
  }
  /**
   * Lấy cohort; ném groups.cohort_not_found khi vắng.
   */
  async getCohort(id: string): Promise<CohortRow> {
    const row = await this.repo.getCohort(id);
    if (!row) throw new NotFoundException({ message: `Cohort ${id} not found`, code: 'cohort.not_found' });
    return row;
  }
  /**
   * Liệt kê cohort.
   */
  async listCohorts(): Promise<CohortRow[]> { return this.repo.listCohorts(); }
  /**
   * Cập nhật cohort.
   */
  async updateCohort(actorId: string, id: string, input: { name?: string; idNumber?: string; description?: string; visible?: boolean }): Promise<CohortRow> {
    const cohortRow = await this.getCohort(id);
    await this.evaluator.requireCapability(actorId, 'moodle/cohort:manage', cohortRow.contextId);
    await this.repo.updateCohort(id, input);
    return this.getCohort(id);
  }
  /**
   * Xoá cohort.
   */
  async deleteCohort(actorId: string, id: string): Promise<void> {
    const cohortRow = await this.getCohort(id);
    await this.evaluator.requireCapability(actorId, 'moodle/cohort:manage', cohortRow.contextId);
    await this.repo.deleteCohort(id);
  }
  /**
   * Thành viên cohort.
   */
  async listCohortMembers(cohortId: string): Promise<{ userId: string; timeAdded: Date }[]> {
    await this.getCohort(cohortId);
    const rows = await this.repo.listCohortMembers(cohortId);
    return rows.map((r) => ({ userId: r.userId, timeAdded: r.timeAdded }));
  }
  /**
   * Kiểm tra thành viên cohort.
   */
  async isCohortMember(cohortId: string, userId: string): Promise<boolean> { return this.repo.isCohortMember(cohortId, userId); }

  /**
   * Add a user to a cohort. Emits cohort_member_added (outbox + in-process)
   * so EnrolModule's cohort-sync handler enrols them into every course with
   * a linked cohort enrol instance.
   */
  /**
   * Thêm thành viên cohort và phát sự kiện đồng bộ ghi danh (cohort sync).
   */
  async addCohortMember(actorId: string, cohortId: string, userId: string): Promise<void> {
    const cohortRow = await this.getCohort(cohortId);
    await this.evaluator.requireCapability(actorId, 'moodle/cohort:manage', cohortRow.contextId);
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
    await this.evaluator.requireCapability(actorId, 'moodle/cohort:manage', cohortRow.contextId);
    const removed = await this.repo.removeCohortMember(cohortId, userId);
    if (!removed) return;
    await this.outbox.enqueueStandalone({ aggregate: 'cohort', type: 'cohort_member_removed', payload: { cohortId, userId } });
    await this.emitter.emitAsync('cohort_member_removed', { cohortId, userId });
  }
}
