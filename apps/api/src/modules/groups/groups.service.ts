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
 * `moodle/group:accessallgroups` can only ever see their own groups and
 * their members — enforced here in the service for every read.
 *
 * Cohort membership changes are published as outbox events
 * (cohort_member_added / cohort_member_removed); EnrolModule listens and
 * performs the cohort-sync enrolments — Groups never imports Enrol.
 */
@Injectable()
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

  onModuleInit(): void {
    // Availability leaves owned by this module (registry pattern).
    this.availability.register('group', async (leaf, ctx) => {
      const groupId = Number(leaf.id ?? leaf.groupid ?? 0);
      const member = groupId ? await this.repo.isMember(groupId, ctx.userId) : false;
      return { available: member, description: this.i18n.t('availability.mustBeInGroup', { args: { groupId } }) };
    });
    this.availability.register('grouping', async (leaf, ctx) => {
      const groupingId = Number(leaf.id ?? leaf.groupingid ?? 0);
      if (!groupingId) return { available: false, description: this.i18n.t('availability.groupingMissingId') };
      const groups = await this.repo.groupsInGrouping(groupingId);
      for (const g of groups) {
        if (await this.repo.isMember(g.id, ctx.userId)) return { available: true, description: this.i18n.t('availability.inGrouping', { args: { groupingId } }) };
      }
      return { available: false, description: this.i18n.t('availability.mustBeInGrouping', { args: { groupingId } }) };
    });
  }

  // --- groups ---------------------------------------------------------------
  private async requireManageGroups(actorId: number, courseId: number): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'moodle/course:managegroups', await this.courses.courseContextId(courseId));
  }

  async createGroup(actorId: number, courseId: number, input: { name: string; idnumber?: string; description?: string }): Promise<GroupRow> {
    await this.courses.getCourse(courseId);
    await this.requireManageGroups(actorId, courseId);
    const row = await this.repo.insertGroup({ courseid: courseId, name: input.name, idnumber: input.idnumber ?? '', description: input.description ?? '' });
    await this.outbox.enqueueStandalone({ aggregate: 'group', type: 'group_created', payload: { groupId: row.id, courseId } });
    return row;
  }
  async getGroup(id: number): Promise<GroupRow> {
    const row = await this.repo.getGroup(id);
    if (!row) throw new NotFoundException({ message: `Group ${id} not found`, code: 'group.not_found' });
    return row;
  }
  async updateGroup(actorId: number, id: number, input: { name?: string; idnumber?: string; description?: string }): Promise<GroupRow> {
    const group = await this.getGroup(id);
    await this.requireManageGroups(actorId, group.courseid);
    await this.repo.updateGroup(id, input);
    return this.getGroup(id);
  }
  async deleteGroup(actorId: number, id: number): Promise<void> {
    const group = await this.getGroup(id);
    await this.requireManageGroups(actorId, group.courseid);
    await this.repo.deleteGroup(id);
    await this.outbox.enqueueStandalone({ aggregate: 'group', type: 'group_deleted', payload: { groupId: id, courseId: group.courseid } });
  }

  /**
   * The groups visible to an actor in a course under the separate-groups law.
   * Effective mode: the cm's own groupmode when a cm is given and its mode is
   * not "inherit" (0), otherwise the course groupmode.
   */
  async visibleGroupsFor(actorId: number, courseId: number, cmGroupMode?: number): Promise<GroupRow[]> {
    const courseRow = await this.courses.getCourse(courseId);
    const all = await this.repo.listGroups(courseId);
    const effectiveMode = cmGroupMode !== undefined && cmGroupMode !== 0 ? cmGroupMode : courseRow.groupmode;
    if (effectiveMode !== GROUPMODE_SEPARATEGROUPS) return all;
    if (await this.evaluator.isSiteAdmin(actorId)) return all;
    const ctxId = await this.courses.courseContextId(courseId);
    if (await this.evaluator.hasCapability(actorId, 'moodle/group:accessallgroups', ctxId)) return all;
    return this.repo.groupsOfUser(courseId, actorId);
  }

  async listGroups(actorId: number, courseId: number): Promise<GroupRow[]> {
    await this.courses.assertCourseAccess(actorId, courseId).catch(async () => {
      // Users with managegroups may list even without enrolment (teachers).
      await this.requireManageGroups(actorId, courseId);
    });
    return this.visibleGroupsFor(actorId, courseId);
  }

  async addMember(actorId: number, groupId: number, userId: number): Promise<void> {
    const group = await this.getGroup(groupId);
    await this.requireManageGroups(actorId, group.courseid);
    await this.repo.addMember(groupId, userId);
    await this.outbox.enqueueStandalone({ aggregate: 'group', type: 'group_member_added', payload: { groupId, courseId: group.courseid, userId } });
  }
  async removeMember(actorId: number, groupId: number, userId: number): Promise<void> {
    const group = await this.getGroup(groupId);
    await this.requireManageGroups(actorId, group.courseid);
    await this.repo.removeMember(groupId, userId);
    await this.outbox.enqueueStandalone({ aggregate: 'group', type: 'group_member_removed', payload: { groupId, courseId: group.courseid, userId } });
  }

  /**
   * Members of a group, under the separate-groups law: in SEPARATEGROUPS
   * mode a non-privileged actor asking for a group they are not in gets 403
   * — the group's data is not theirs to see, at the SERVER.
   */
  async listMembers(actorId: number, groupId: number): Promise<{ userid: number; timeadded: Date }[]> {
    const group = await this.getGroup(groupId);
    const visible = await this.visibleGroupsFor(actorId, group.courseid);
    if (!visible.some((g) => g.id === groupId)) {
      throw new ForbiddenException({ message: 'Separate groups: you cannot see members of a group you are not in', code: 'group.separate_groups_denied' });
    }
    const rows = await this.repo.listMembers(groupId);
    return rows.map((r) => ({ userid: r.userid, timeadded: r.timeadded }));
  }

  /** All members visible to the actor across the course (used by course participant/group-data views). */
  async listVisibleMembers(actorId: number, courseId: number): Promise<{ groupId: number; userid: number }[]> {
    const visible = await this.visibleGroupsFor(actorId, courseId);
    const rows = await this.repo.listMembersOfGroups(visible.map((g) => g.id));
    return rows.map((r) => ({ groupId: r.groupid, userid: r.userid }));
  }

  async groupsOfUser(courseId: number, userId: number): Promise<GroupRow[]> { return this.repo.groupsOfUser(courseId, userId); }
  async isMember(groupId: number, userId: number): Promise<boolean> { return this.repo.isMember(groupId, userId); }
  /** Internal add used by enrol/cohort sync (system action, no actor capability check). */
  async addMemberInternal(groupId: number, userId: number, component = '', itemid = 0): Promise<void> {
    await this.repo.addMember(groupId, userId, component, itemid);
  }
  async removeMemberInternal(groupId: number, userId: number): Promise<void> { await this.repo.removeMember(groupId, userId); }

  // --- groupings ---------------------------------------------------------------
  async createGrouping(actorId: number, courseId: number, input: { name: string; idnumber?: string; description?: string }): Promise<GroupingRow> {
    await this.courses.getCourse(courseId);
    await this.requireManageGroups(actorId, courseId);
    const row = await this.repo.insertGrouping({ courseid: courseId, name: input.name, idnumber: input.idnumber ?? '', description: input.description ?? '' });
    await this.outbox.enqueueStandalone({ aggregate: 'grouping', type: 'grouping_created', payload: { groupingId: row.id, courseId } });
    return row;
  }
  async getGrouping(id: number): Promise<GroupingRow> {
    const row = await this.repo.getGrouping(id);
    if (!row) throw new NotFoundException({ message: `Grouping ${id} not found`, code: 'group.grouping_not_found' });
    return row;
  }
  async listGroupings(courseId: number): Promise<GroupingRow[]> { return this.repo.listGroupings(courseId); }
  async deleteGrouping(actorId: number, id: number): Promise<void> {
    const grouping = await this.getGrouping(id);
    await this.requireManageGroups(actorId, grouping.courseid);
    await this.repo.deleteGrouping(id);
  }
  async addGroupToGrouping(actorId: number, groupingId: number, groupId: number): Promise<void> {
    const grouping = await this.getGrouping(groupingId);
    const group = await this.getGroup(groupId);
    if (group.courseid !== grouping.courseid) throw new ForbiddenException({ message: 'Group and grouping are in different courses', code: 'group.course_mismatch' });
    await this.requireManageGroups(actorId, grouping.courseid);
    await this.repo.addGroupToGrouping(groupingId, groupId);
  }
  async groupsInGrouping(groupingId: number): Promise<GroupRow[]> { return this.repo.groupsInGrouping(groupingId); }

  // --- cohorts -------------------------------------------------------------------
  private async cohortContextId(input: { contextlevel?: number; categoryId?: number }): Promise<number> {
    if (input.categoryId !== undefined) {
      const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSECAT, input.categoryId);
      if (!ctx) throw new NotFoundException({ message: `No context for category ${input.categoryId}`, code: 'cohort.category_context_missing' });
      return ctx.id;
    }
    return (await this.contexts.ensureSystemContext()).id;
  }

  async createCohort(actorId: number, input: { name: string; idnumber?: string; description?: string; categoryId?: number; visible?: boolean }): Promise<CohortRow> {
    const contextid = await this.cohortContextId(input);
    await this.evaluator.requireCapability(actorId, 'moodle/cohort:manage', contextid);
    const row = await this.repo.insertCohort({
      name: input.name, idnumber: input.idnumber ?? '', description: input.description ?? '',
      contextid, visible: input.visible ?? true,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'cohort', type: 'cohort_created', payload: { cohortId: row.id } });
    return row;
  }
  async getCohort(id: number): Promise<CohortRow> {
    const row = await this.repo.getCohort(id);
    if (!row) throw new NotFoundException({ message: `Cohort ${id} not found`, code: 'cohort.not_found' });
    return row;
  }
  async listCohorts(): Promise<CohortRow[]> { return this.repo.listCohorts(); }
  async updateCohort(actorId: number, id: number, input: { name?: string; idnumber?: string; description?: string; visible?: boolean }): Promise<CohortRow> {
    const cohortRow = await this.getCohort(id);
    await this.evaluator.requireCapability(actorId, 'moodle/cohort:manage', cohortRow.contextid);
    await this.repo.updateCohort(id, input);
    return this.getCohort(id);
  }
  async deleteCohort(actorId: number, id: number): Promise<void> {
    const cohortRow = await this.getCohort(id);
    await this.evaluator.requireCapability(actorId, 'moodle/cohort:manage', cohortRow.contextid);
    await this.repo.deleteCohort(id);
  }
  async listCohortMembers(cohortId: number): Promise<{ userid: number; timeadded: Date }[]> {
    await this.getCohort(cohortId);
    const rows = await this.repo.listCohortMembers(cohortId);
    return rows.map((r) => ({ userid: r.userid, timeadded: r.timeadded }));
  }
  async isCohortMember(cohortId: number, userId: number): Promise<boolean> { return this.repo.isCohortMember(cohortId, userId); }

  /**
   * Add a user to a cohort. Emits cohort_member_added (outbox + in-process)
   * so EnrolModule's cohort-sync handler enrols them into every course with
   * a linked cohort enrol instance.
   */
  async addCohortMember(actorId: number, cohortId: number, userId: number): Promise<void> {
    const cohortRow = await this.getCohort(cohortId);
    await this.evaluator.requireCapability(actorId, 'moodle/cohort:manage', cohortRow.contextid);
    const added = await this.repo.addCohortMember(cohortId, userId);
    if (!added) return;
    await this.outbox.enqueueStandalone({ aggregate: 'cohort', type: 'cohort_member_added', payload: { cohortId, userId } });
    await this.emitter.emitAsync('cohort_member_added', { cohortId, userId });
  }
  async removeCohortMember(actorId: number, cohortId: number, userId: number): Promise<void> {
    const cohortRow = await this.getCohort(cohortId);
    await this.evaluator.requireCapability(actorId, 'moodle/cohort:manage', cohortRow.contextid);
    const removed = await this.repo.removeCohortMember(cohortId, userId);
    if (!removed) return;
    await this.outbox.enqueueStandalone({ aggregate: 'cohort', type: 'cohort_member_removed', payload: { cohortId, userId } });
    await this.emitter.emitAsync('cohort_member_removed', { cohortId, userId });
  }
}
