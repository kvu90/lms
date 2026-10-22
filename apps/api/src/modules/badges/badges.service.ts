import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { I18nService } from '@nestjs/i18n';
import type { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { CompetenciesService } from '../competencies/competencies.service';
import { CompletionService } from '../completion/completion.service';
import { CoursesService } from '../courses/courses.service';
import { MessagingService } from '../messaging/messaging.service';
import { UsersService } from '../users/users.service';
import { BadgesRepository, type BadgeRow, type CriteriaRow, type IssuedRow } from './badges.repository';

export const BADGE_AWARD_QUEUE = 'badge-award';
export const BADGE_STATUS = { INACTIVE: 0, ACTIVE: 1, RETIRED: 2, ARCHIVED: 3, DISABLED: 4 } as const;
export const CRITERIA_AGGREGATION = { ALL: 1, ANY: 2 } as const;
export const LEAF_TYPES = ['coursecompletion', 'activitycompletion', 'competency', 'badge', 'manual'] as const;

export interface CriteriaInput {
  method: number; // 1=ALL, 2=ANY over the leaves
  criteria: { criteriatype: string; params?: Record<string, unknown>; description?: string }[];
}

/**
 * BadgesModule facade (Moodle core_badges):
 *  - Criteria form a two-level tree: ONE 'overall' row carrying the ALL/ANY
 *    aggregation, plus leaf rows (course completion, activity completion,
 *    competency proficiency, another badge, manual-by-role).
 *  - FREEZE LAW: criteria of an ACTIVE badge — or of any badge with issued
 *    awards — cannot be changed. Duplicate the badge to edit its criteria.
 *  - Issuing creates an IMMUTABLE assertion (snapshot of badge + criteria,
 *    evidence, issue/expiry dates). Revoking marks the assertion revoked;
 *    the row is never deleted.
 *  - Auto-award: this module registers completion hooks with
 *    CompletionService and listens for competency proficiency events; the
 *    evaluator only reads OTHER modules through their facades
 *    (CompletionService, CompetenciesService), never their tables. The
 *    worker runs the same evaluation from the 'badge-award' queue.
 */
@Injectable()
export class BadgesService implements OnModuleInit {
  constructor(
    private readonly repo: BadgesRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly roles: RolesService,
    private readonly courses: CoursesService,
    private readonly completion: CompletionService,
    private readonly competencies: CompetenciesService,
    private readonly messaging: MessagingService,
    private readonly users: UsersService,
    private readonly outbox: OutboxService,
    private readonly i18n: I18nService,
    @InjectQueue(BADGE_AWARD_QUEUE) private readonly awardQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.completion.registerCourseCompletionHook(async ({ userId, courseId }) => {
      void courseId;
      await this.enqueueEvaluation(userId, 'course-completion');
      await this.evaluateUserBadges(userId);
    });
    this.completion.registerCmCompletionHook(async ({ userId }) => {
      await this.evaluateUserBadges(userId);
    });
  }

  /** Competency proficiency changed (in-process event from CompetenciesService) ⇒ re-evaluate. */
  @OnEvent('competency_proficiency_changed')
  async onProficiencyChanged(payload: { userId: number; competencyId: number }): Promise<void> {
    await this.enqueueEvaluation(payload.userId, 'competency');
    await this.evaluateUserBadges(payload.userId);
  }

  private async enqueueEvaluation(userId: number, trigger: string): Promise<void> {
    await this.awardQueue.add('evaluate', { userId, trigger }, {
      jobId: `badge-award-${userId}-${trigger}-${Date.now()}`,
      attempts: 3, removeOnComplete: true,
    }).catch(() => undefined);
  }

  private async systemCtx(): Promise<number> {
    return (await this.contexts.ensureSystemContext()).id;
  }
  private async badgeContextId(badgeRow: BadgeRow): Promise<number> {
    return badgeRow.type === 2 && badgeRow.courseid
      ? this.courses.courseContextId(badgeRow.courseid)
      : this.systemCtx();
  }

  // --- badge CRUD -----------------------------------------------------------------

  async createBadge(actorId: number, input: {
    name: string; description?: string; type?: number; courseid?: number;
    issuername?: string; issuerurl?: string; issuercontact?: string;
    expiredate?: string; expireperiod?: number; version?: string;
  }): Promise<BadgeRow> {
    const type = input.type ?? 1;
    if (type === 2 && !input.courseid) throw new BadRequestException({ message: 'A course badge requires courseid', code: 'badges.course_required' });
    const ctx = type === 2 ? await this.courses.courseContextId(input.courseid!) : await this.systemCtx();
    await this.evaluator.requireCapability(actorId, 'moodle/badges:createbadge', ctx);
    if (type === 1 && !(await this.evaluator.isSiteAdmin(actorId))) {
      // Site badges are a system-context artefact: only manager/site-admin paths.
      const manager = await this.roles.getRoleByShortname('manager');
      const assignments = manager ? await this.evaluator.hasCapability(actorId, 'moodle/badges:createbadge', ctx) : false;
      if (!assignments) throw new ForbiddenException({ message: 'Site badges require a manager role at the system context', code: 'badges.site_badge_manager_only' });
    }
    return this.repo.insertBadge({
      name: input.name, description: input.description ?? '', type,
      courseid: type === 2 ? input.courseid! : null,
      issuername: input.issuername ?? 'LMS', issuerurl: input.issuerurl ?? '', issuercontact: input.issuercontact ?? '',
      expiredate: input.expiredate ? new Date(input.expiredate) : null,
      expireperiod: input.expireperiod ?? null, status: BADGE_STATUS.INACTIVE,
      version: input.version ?? '', usercreated: actorId, usermodified: actorId,
    });
  }

  async getBadge(id: number): Promise<BadgeRow> {
    const row = await this.repo.getBadge(id);
    if (!row) throw new NotFoundException({ message: `Badge ${id} not found`, code: 'badges.not_found' });
    return row;
  }
  async listBadges(): Promise<BadgeRow[]> { return this.repo.listBadges(); }

  async updateBadge(actorId: number, id: number, input: { name?: string; description?: string; issuername?: string; expireperiod?: number }): Promise<BadgeRow> {
    const badgeRow = await this.getBadge(id);
    await this.evaluator.requireCapability(actorId, 'moodle/badges:configurecriteria', await this.badgeContextId(badgeRow));
    const patch: Partial<BadgeRow> = { usermodified: actorId };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.issuername !== undefined) patch.issuername = input.issuername;
    if (input.expireperiod !== undefined) patch.expireperiod = input.expireperiod;
    await this.repo.updateBadge(id, patch);
    return this.getBadge(id);
  }

  /** Moodle delete = archive (badgeslib_test test_delete_badge): the badge is never hard-deleted by default. */
  async archiveBadge(actorId: number, id: number): Promise<BadgeRow> {
    const badgeRow = await this.getBadge(id);
    await this.evaluator.requireCapability(actorId, 'moodle/badges:configurecriteria', await this.badgeContextId(badgeRow));
    await this.repo.updateBadge(id, { status: BADGE_STATUS.ARCHIVED, usermodified: actorId });
    return this.getBadge(id);
  }

  async setStatus(actorId: number, id: number, status: number): Promise<BadgeRow> {
    const badgeRow = await this.getBadge(id);
    await this.evaluator.requireCapability(actorId, 'moodle/badges:configurecriteria', await this.badgeContextId(badgeRow));
    if (![BADGE_STATUS.INACTIVE, BADGE_STATUS.ACTIVE, BADGE_STATUS.DISABLED].includes(status as never)) {
      throw new BadRequestException({ message: `Status ${status} cannot be set directly`, code: 'badges.bad_status' });
    }
    if (status === BADGE_STATUS.ACTIVE) {
      const leaves = (await this.repo.listCriteria(id)).filter((c) => c.criteriatype !== 'overall');
      if (!leaves.length) {
        throw new BadRequestException({ message: 'A badge cannot be enabled without criteria', code: 'badges.no_criteria' });
      }
    }
    await this.repo.updateBadge(id, { status, usermodified: actorId });
    await this.outbox.enqueueStandalone({ aggregate: 'badges', type: 'badge_status_changed', payload: { badgeId: id, status } });
    return this.getBadge(id);
  }

  // --- criteria -----------------------------------------------------------------------

  async getCriteria(badgeId: number): Promise<{ method: number; criteria: CriteriaRow[] }> {
    await this.getBadge(badgeId);
    const rows = await this.repo.listCriteria(badgeId);
    const overall = rows.find((r) => r.criteriatype === 'overall');
    return { method: overall?.method ?? CRITERIA_AGGREGATION.ALL, criteria: rows.filter((r) => r.criteriatype !== 'overall') };
  }

  /** The freeze law (report §2#14): active badges and badges with awards have immutable criteria. */
  async assertCriteriaEditable(badgeRow: BadgeRow): Promise<void> {
    if (badgeRow.status === BADGE_STATUS.ACTIVE || badgeRow.status === BADGE_STATUS.DISABLED) {
      throw new ForbiddenException({
        message: 'Criteria of an active badge are frozen. Duplicate the badge to change its criteria.',
        code: 'badges.criteria_frozen',
      });
    }
    if ((await this.repo.countIssued(badgeRow.id)) > 0) {
      throw new ForbiddenException({
        message: 'This badge has already been issued; its criteria are frozen. Duplicate the badge to change them.',
        code: 'badges.criteria_frozen',
      });
    }
  }

  async setCriteria(actorId: number, badgeId: number, input: CriteriaInput): Promise<{ method: number; criteria: CriteriaRow[] }> {
    const badgeRow = await this.getBadge(badgeId);
    await this.evaluator.requireCapability(actorId, 'moodle/badges:configurecriteria', await this.badgeContextId(badgeRow));
    await this.assertCriteriaEditable(badgeRow);
    if (![CRITERIA_AGGREGATION.ALL, CRITERIA_AGGREGATION.ANY].includes(input.method as never)) {
      throw new BadRequestException({ message: 'Criteria method must be 1 (ALL) or 2 (ANY)', code: 'badges.bad_method' });
    }
    for (const leaf of input.criteria) {
      if (!LEAF_TYPES.includes(leaf.criteriatype as never)) {
        throw new BadRequestException({ message: `Unknown criteria type ${leaf.criteriatype}`, code: 'badges.bad_criteria_type' });
      }
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.deleteCriteria(badgeId, tx as never);
      await this.repo.insertCriteria({ badgeid: badgeId, criteriatype: 'overall', method: input.method, params: {} }, tx as never);
      for (const leaf of input.criteria) {
        await this.repo.insertCriteria({
          badgeid: badgeId, criteriatype: leaf.criteriatype, method: input.method,
          params: leaf.params ?? {}, description: leaf.description ?? '',
        }, tx as never);
      }
    });
    return this.getCriteria(badgeId);
  }

  /** Duplicate = the sanctioned way to edit a frozen badge (new INACTIVE badge with copied criteria). */
  async duplicateBadge(actorId: number, badgeId: number): Promise<BadgeRow> {
    const source = await this.getBadge(badgeId);
    await this.evaluator.requireCapability(actorId, 'moodle/badges:createbadge', await this.badgeContextId(source));
    const copy = await this.repo.insertBadge({
      name: `${source.name} (copy)`, description: source.description, type: source.type,
      courseid: source.courseid, issuername: source.issuername, issuerurl: source.issuerurl,
      issuercontact: source.issuercontact, expiredate: source.expiredate, expireperiod: source.expireperiod,
      status: BADGE_STATUS.INACTIVE, version: source.version, language: source.language,
      usercreated: actorId, usermodified: actorId,
    });
    const { criteria } = await this.getCriteria(badgeId);
    const rows = await this.repo.listCriteria(badgeId);
    const overall = rows.find((r) => r.criteriatype === 'overall');
    await this.repo.insertCriteria({ badgeid: copy.id, criteriatype: 'overall', method: overall?.method ?? 1, params: {} });
    for (const leaf of criteria) {
      await this.repo.insertCriteria({ badgeid: copy.id, criteriatype: leaf.criteriatype, method: leaf.method, params: leaf.params, description: leaf.description });
    }
    return copy;
  }

  // --- evaluation & issuing --------------------------------------------------------------

  private async leafSatisfied(leaf: CriteriaRow, userId: number): Promise<boolean> {
    const params = (leaf.params ?? {}) as Record<string, unknown>;
    switch (leaf.criteriatype) {
      case 'coursecompletion': {
        const courseId = Number(params.courseId ?? 0);
        if (!courseId) return false;
        const completion = await this.completion.getCourseCompletion(userId, courseId).catch(() => undefined);
        return completion?.status === 'complete';
      }
      case 'activitycompletion': {
        const cmId = Number(params.cmId ?? 0);
        if (!cmId) return false;
        const state = await this.completion.getCmCompletion(cmId, userId).catch(() => undefined);
        return !!state && state.state >= 1;
      }
      case 'competency': {
        const competencyId = Number(params.competencyId ?? 0);
        if (!competencyId) return false;
        return this.competencies.isProficient(userId, competencyId);
      }
      case 'badge': {
        const otherBadgeId = Number(params.badgeId ?? 0);
        if (!otherBadgeId) return false;
        const issued = await this.repo.findIssued(otherBadgeId, userId);
        return !!issued && !issued.revoked;
      }
      case 'manual': {
        const award = await this.repo.findManualAward(leaf.badgeid, userId);
        return !!award;
      }
      default:
        return false;
    }
  }

  /** Evaluate the criteria tree of one badge for one user. */
  async evaluateBadge(badgeId: number, userId: number): Promise<{ satisfied: boolean; method: number; leaves: { criteriaId: number; criteriatype: string; satisfied: boolean }[] }> {
    const { method, criteria } = await this.getCriteria(badgeId);
    const leaves = [];
    for (const leaf of criteria) {
      leaves.push({ criteriaId: leaf.id, criteriatype: leaf.criteriatype, satisfied: await this.leafSatisfied(leaf, userId) });
    }
    const satisfied = leaves.length === 0 ? false
      : method === CRITERIA_AGGREGATION.ANY ? leaves.some((l) => l.satisfied) : leaves.every((l) => l.satisfied);
    return { satisfied, method, leaves };
  }

  /**
   * Issue a badge: creates the immutable assertion. Idempotent — a user
   * holds a given badge at most once (a second call returns the existing
   * assertion).
   */
  async issueBadge(badgeId: number, userId: number, evidence?: Record<string, unknown>): Promise<IssuedRow> {
    const badgeRow = await this.getBadge(badgeId);
    const existing = await this.repo.findIssued(badgeId, userId);
    if (existing) return existing;
    const { criteria } = await this.getCriteria(badgeId);
    const dateexpire = badgeRow.expiredate ?? (badgeRow.expireperiod
      ? new Date(Date.now() + badgeRow.expireperiod * 86400_000) : null);
    const uniquehash = createHash('sha256').update(`${badgeId}:${userId}:${randomUUID()}`).digest('hex');
    const issued = await this.repo.dbHandle.transaction(async (tx) => {
      const row = await this.repo.insertIssued({
        badgeid: badgeId, userid: userId, uniquehash,
        snapshot: {
          badge: { id: badgeRow.id, name: badgeRow.name, description: badgeRow.description, type: badgeRow.type, courseid: badgeRow.courseid, issuername: badgeRow.issuername, issuerurl: badgeRow.issuerurl, version: badgeRow.version },
          criteria: criteria.map((c) => ({ criteriatype: c.criteriatype, method: c.method, params: c.params })),
        },
        evidence: evidence ?? {},
        dateexpire, visible: true,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'badges', type: 'badge_issued',
        payload: { badgeId, userId, issuedId: row.id, uniquehash },
      });
      return row;
    });
    await this.messaging.notify(userId, 'badge_awarded', {
      subject: this.i18n.t('platform.badgeAwardedSubject', { args: { name: badgeRow.name } }),
      body: this.i18n.t('platform.badgeAwardedBody', { args: { name: badgeRow.name, issuer: badgeRow.issuername } }),
      contextUrl: `/badges/${badgeId}`,
    }).catch(() => undefined);
    await this.repo.updateIssued(issued.id, { issuernotified: true });
    return issued;
  }

  /** Evaluate every ACTIVE badge for a user and issue the ones newly satisfied. */
  async evaluateUserBadges(userId: number): Promise<{ evaluated: number; issued: number[] }> {
    const user = await this.users.getByIdOrUndefined(userId);
    if (!user || user.suspended || user.deleted) return { evaluated: 0, issued: [] };
    const badges = (await this.repo.listBadges()).filter((b) => b.status === BADGE_STATUS.ACTIVE);
    const issued: number[] = [];
    for (const badgeRow of badges) {
      if (await this.repo.findIssued(badgeRow.id, userId)) continue;
      const result = await this.evaluateBadge(badgeRow.id, userId);
      if (result.satisfied) {
        const row = await this.issueBadge(badgeRow.id, userId, { evaluatedLeaves: result.leaves });
        issued.push(row.id);
      }
    }
    return { evaluated: badges.length, issued };
  }

  // --- manual award --------------------------------------------------------------------------

  /**
   * Manual award (oracle: badgeslib award_criteria_manual). The badge must
   * declare a manual criterion; if it names a role, the issuer must hold
   * that role at the badge context. The award satisfies the manual leaf;
   * the badge is issued only if the overall aggregation then holds.
   */
  async manualAward(actorId: number, badgeId: number, recipientId: number): Promise<{ award: unknown; issued: IssuedRow | null; evaluation: unknown }> {
    const badgeRow = await this.getBadge(badgeId);
    if (badgeRow.status !== BADGE_STATUS.ACTIVE) {
      throw new BadRequestException({ message: 'Only an active badge can be awarded', code: 'badges.not_active' });
    }
    const ctx = await this.badgeContextId(badgeRow);
    await this.evaluator.requireCapability(actorId, 'moodle/badges:awardbadge', ctx);
    await this.users.getUser(recipientId);
    const { criteria } = await this.getCriteria(badgeId);
    const manualLeaf = criteria.find((c) => c.criteriatype === 'manual');
    if (!manualLeaf) {
      throw new BadRequestException({ message: 'This badge has no manual award criterion', code: 'badges.no_manual_criteria' });
    }
    const roleIdParam = Number((manualLeaf.params as Record<string, unknown>)?.roleId ?? 0);
    let issuerRole: number | null = null;
    if (roleIdParam) {
      const assignments = await this.evaluator.hasCapabilityFromRealAssignment(actorId, 'moodle/badges:awardbadge', ctx);
      if (!assignments) throw new ForbiddenException({ message: 'Issuer does not hold the required awarding role', code: 'badges.issuer_role' });
      issuerRole = roleIdParam;
    }
    const award = await this.repo.insertManualAward({ badgeid: badgeId, recipientid: recipientId, issuerid: actorId, issuerrole: issuerRole });
    const evaluation = await this.evaluateBadge(badgeId, recipientId);
    const issued = evaluation.satisfied ? await this.issueBadge(badgeId, recipientId, { manualAwardId: award.id }) : null;
    return { award, issued, evaluation };
  }

  // --- assertions --------------------------------------------------------------------------------

  async listMyBadges(userId: number): Promise<(IssuedRow & { badge: BadgeRow })[]> {
    const rows = await this.repo.listIssuedForUser(userId);
    const out: (IssuedRow & { badge: BadgeRow })[] = [];
    for (const row of rows) {
      const badgeRow = await this.repo.getBadge(row.badgeid);
      if (badgeRow) out.push({ ...row, badge: badgeRow });
    }
    return out;
  }
  async listIssuedForBadge(actorId: number, badgeId: number): Promise<IssuedRow[]> {
    const badgeRow = await this.getBadge(badgeId);
    await this.evaluator.requireCapability(actorId, 'moodle/badges:awardbadge', await this.badgeContextId(badgeRow));
    return this.repo.listIssuedForBadge(badgeId);
  }
  async getIssued(id: number): Promise<IssuedRow> {
    const row = await this.repo.getIssued(id);
    if (!row) throw new NotFoundException({ message: `Badge assertion ${id} not found`, code: 'badges.assertion_not_found' });
    return row;
  }

  /** Revoke: the assertion row SURVIVES (marked revoked); only its visibility/effect ends. */
  async revokeIssued(actorId: number, issuedId: number): Promise<IssuedRow> {
    const issued = await this.getIssued(issuedId);
    const badgeRow = await this.getBadge(issued.badgeid);
    await this.evaluator.requireCapability(actorId, 'moodle/badges:revokebadge', await this.badgeContextId(badgeRow));
    await this.repo.updateIssued(issuedId, { revoked: true, revokedat: new Date(), visible: false });
    await this.outbox.enqueueStandalone({ aggregate: 'badges', type: 'badge_revoked', payload: { badgeId: issued.badgeid, userId: issued.userid, issuedId } });
    return this.getIssued(issuedId);
  }
}
