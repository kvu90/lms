import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { I18nService } from '@nestjs/i18n';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CompletionService } from '../completion/completion.service';
import { CoursesService } from '../courses/courses.service';
import { GroupsService } from '../groups/groups.service';
import { MessagingService } from '../messaging/messaging.service';
import { UsersService } from '../users/users.service';
import {
  CompetenciesRepository, type CompetencyRow, type EvidenceRow, type FrameworkRow,
  type PlanRow, type TemplateRow, type UsercompRow,
} from './competencies.repository';

export const PLAN_STATUS = { DRAFT: 0, ACTIVE: 1, WAITING_FOR_REVIEW: 2, IN_REVIEW: 3, COMPLETE: 4 } as const;
export const USERCOMP_REVIEW = { NONE: 0, WAITING: 1, IN_REVIEW: 2 } as const;
export const RULE_OUTCOMES = ['complete', 'attach-evidence', 'nothing'] as const;
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

export interface ScaleConfiguration { values: string[]; proficient: number[] }

export function parseScale(framework: FrameworkRow): ScaleConfiguration {
  const raw = (framework.scaleConfiguration ?? {}) as { values?: unknown; proficient?: unknown };
  const values = Array.isArray(raw.values) ? raw.values.map(String) : [];
  const proficient = Array.isArray(raw.proficient) ? raw.proficient.map(Number) : [];
  return { values, proficient };
}

/** Proficiency is a function of the FRAMEWORK SCALE only (report §2#15). */
export function isProficientGrade(framework: FrameworkRow, grade: number | null | undefined): boolean {
  if (grade === null || grade === undefined) return false;
  return parseScale(framework).proficient.includes(grade);
}

/** Một dòng điểm trong cấu hình rule points: competency con đóng góp điểm khi đạt proficiency. */
export interface CompetencyRulePointsEntry { competencyId: string; points: number; required: boolean }

/** Cấu hình rule points đã chuẩn hoá (Moodle `competency_rule_points`: base points + danh sách con). */
export interface CompetencyRulePointsConfig { pointsRequired: number; entries: CompetencyRulePointsEntry[] }

/** Đọc cấu hình rule points từ `competency.ruleConfig` (jsonb); trả null khi không đúng hình dạng. */
export function parseRuleConfig(raw: unknown): CompetencyRulePointsConfig | null {
  const cfg = (raw ?? {}) as { pointsRequired?: unknown; entries?: unknown };
  if (!Number.isInteger(cfg.pointsRequired) || !Array.isArray(cfg.entries)) return null;
  const entries: CompetencyRulePointsEntry[] = [];
  for (const e of cfg.entries as { competencyId?: unknown; points?: unknown; required?: unknown }[]) {
    if (typeof e?.competencyId !== 'string' || !Number.isInteger(e.points) || typeof e.required !== 'boolean') return null;
    entries.push({ competencyId: e.competencyId, points: e.points as number, required: e.required });
  }
  return { pointsRequired: cfg.pointsRequired as number, entries };
}

/** Hình dạng tài liệu export framework (khớp `frameworkExportSchema` ở @lms/contracts). */
export interface FrameworkExportDoc {
  format: 'lms-competency-framework';
  version: 1;
  framework: { shortName: string; idNumber: string; description: string; visible: boolean; taxonomies: string; scale: ScaleConfiguration };
  competencies: {
    key: string; shortName: string; idNumber: string; description: string;
    parentKey: string | null; sortOrder: number;
    rule: { outcome: string; pointsRequired: number; entries: { competencyKey: string; points: number; required: boolean }[] } | null;
  }[];
}

/**
 * CompetenciesModule facade (Moodle core_competency / tool_lp):
 *  - Frameworks own a competency TREE (path/depth) and a SCALE; proficiency
 *    is read off the scale configuration — NEVER inferred from grades. A
 *    grade can only become EVIDENCE when a link's ruleOutcome says
 *    'attach-evidence' (and even then it does not set proficiency).
 *  - Course/cm links carry an explicit ruleOutcome applied by THIS module
 *    when CompletionModule reports a completion (registered hooks — this
 *    module never reads completion tables).
 *  - Learning plans: template → cohort plans; lifecycle
 *    draft → active → waitingforreview → inreview → (approve → active |
 *    complete). Every transition is written to competency_plan_review.
 *  - User competencies carry proficiency + a review state machine
 *    (none → waiting → inreview → approve/reject); evidence rows are the
 *    immutable history of everything that happened.
 */
@Injectable()
/**
 * Nghiệp vụ khung năng lực và kế hoạch học tập (learning plans).
 * Đối chiếu Moodle: competency/classes (framework, competency, plan, user_competency).
 * Quy tắc review: người học không được tự duyệt năng lực/kế hoạch của chính mình (assertNotSelfReview);
 * proficiency chỉ được đặt qua chấm (grade) hoặc duyệt evidence; hoàn thành khoá học/cm có thể tự động
 * cấp proficiency cho các competency đã liên kết khi framework cấu hình như vậy.
 */
export class CompetenciesService implements OnModuleInit {
  constructor(
    private readonly repo: CompetenciesRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly courses: CoursesService,
    private readonly groups: GroupsService,
    private readonly completion: CompletionService,
    private readonly messaging: MessagingService,
    private readonly users: UsersService,
    private readonly outbox: OutboxService,
    private readonly emitter: EventEmitter2,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Khởi tạo: đăng ký hook hoàn thành course/cm để tự động xét proficiency.
   */
  onModuleInit(): void {
    this.completion.registerCourseCompletionHook(async ({ courseId, userId }) => {
      await this.applyCourseCompletion(courseId, userId);
    });
    this.completion.registerCmCompletionHook(async ({ cmId, courseId, userId }) => {
      void courseId;
      await this.applyCmCompletion(cmId, userId);
    });
  }

  private async systemCtx(): Promise<string> {
    return (await this.contexts.ensureSystemContext()).id;
  }
  private async requireManage(actorId: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'competency:competencymanage', await this.systemCtx());
  }

  // --- frameworks & competencies -------------------------------------------------

  /**
   * Tạo framework năng lực.
   */
  async createFramework(actorId: string, input: { shortName: string; idNumber?: string; description?: string; scale: ScaleConfiguration; visible?: boolean }): Promise<FrameworkRow> {
    await this.requireManage(actorId);
    if (!input.scale.values.length) throw new BadRequestException({ message: 'A framework scale needs at least one value', code: 'competency.scale_empty' });
    for (const idx of input.scale.proficient) {
      if (idx < 0 || idx >= input.scale.values.length) {
        throw new BadRequestException({ message: `Proficient index ${idx} is outside the scale`, code: 'competency.scale_proficient_range' });
      }
    }
    return this.repo.insertFramework({
      shortName: input.shortName, idNumber: input.idNumber ?? '', description: input.description ?? '',
      contextId: await this.systemCtx(), scaleConfiguration: input.scale, visible: input.visible ?? true,
    });
  }
  /**
   * Lấy framework; ném competencies.framework_not_found khi vắng.
   */
  async getFramework(id: string): Promise<FrameworkRow> {
    const row = await this.repo.getFramework(id);
    if (!row) throw new NotFoundException({ message: `Framework ${id} not found`, code: 'competency.framework_not_found' });
    return row;
  }
  /**
   * Liệt kê framework.
   */
  async listFrameworks(): Promise<FrameworkRow[]> { return this.repo.listFrameworks(); }

  /**
   * Thêm competency vào framework (có thể lồng nhau theo parent).
   */
  async createCompetency(actorId: string, frameworkId: string, input: { shortName: string; idNumber?: string; description?: string; parentId?: string }): Promise<CompetencyRow> {
    await this.requireManage(actorId);
    const framework = await this.getFramework(frameworkId);
    void framework;
    let parent: CompetencyRow | undefined;
    if (input.parentId) {
      parent = await this.getCompetency(input.parentId);
      if (parent.frameworkId !== frameworkId) throw new BadRequestException({ message: 'Parent competency belongs to another framework', code: 'competency.parent_framework_mismatch' });
    }
    const created = await this.repo.insertCompetency({
      frameworkId: frameworkId, shortName: input.shortName, idNumber: input.idNumber ?? '',
      description: input.description ?? '', parentId: parent?.id ?? null,
      path: '', depth: parent ? parent.depth + 1 : 1,
    });
    const path = parent ? `${parent.path}/${created.id}` : `/${created.id}`;
    await this.repo.updateCompetency(created.id, { path });
    return (await this.repo.getCompetency(created.id))!;
  }
  /**
   * Lấy competency; ném competencies.not_found khi vắng.
   */
  async getCompetency(id: string): Promise<CompetencyRow> {
    const row = await this.repo.getCompetency(id);
    if (!row) throw new NotFoundException({ message: `Competency ${id} not found`, code: 'competency.not_found' });
    return row;
  }
  /**
   * Competency của framework.
   */
  async listCompetencies(frameworkId: string): Promise<CompetencyRow[]> {
    await this.getFramework(frameworkId);
    return this.repo.listCompetencies(frameworkId);
  }

  // --- competency rules (points) ---------------------------------------------------------

  /**
   * Xem rule của một competency (null khi competency chưa có rule).
   */
  async getCompetencyRule(competencyId: string): Promise<{ competencyId: string; type: string | null; outcome: string; config: CompetencyRulePointsConfig | null }> {
    const row = await this.getCompetency(competencyId);
    return {
      competencyId: row.id,
      type: row.ruleType,
      outcome: row.ruleOutcome,
      config: row.ruleType === 'points' ? parseRuleConfig(row.ruleConfig) : null,
    };
  }

  /**
   * Đặt rule points cho competency cha (oracle: Moodle `competency_rule_points::validate_config`).
   * Quy tắc kiểm tra bám Moodle: ngưỡng điểm >= 1; mỗi dòng điểm tham chiếu một competency
   * CON TRỰC TIẾP, không trùng, không tự tham chiếu, điểm >= 0; tổng điểm các con phải
   * với tới ngưỡng — cấu hình không bao giờ đạt được bị từ chối ngay khi đặt.
   */
  async setCompetencyRule(actorId: string, competencyId: string, input: { outcome: string; pointsRequired: number; entries: CompetencyRulePointsEntry[] }): Promise<{ competencyId: string; type: string | null; outcome: string; config: CompetencyRulePointsConfig | null }> {
    await this.requireManage(actorId);
    const parent = await this.getCompetency(competencyId);
    void parent;
    const invalid = (msg: string): never => { throw new BadRequestException({ message: msg, code: 'competency.rule_invalid' }); };
    const outcome = this.assertOutcome(input.outcome === 'nothing' ? 'nothing' : input.outcome);
    if (!Number.isInteger(input.pointsRequired) || input.pointsRequired < 1) invalid('The points required must be at least 1');
    const children = await this.repo.listChildren(competencyId);
    const childIds = new Set(children.map((c) => c.id));
    const seen = new Set<string>();
    let total = 0;
    for (const entry of input.entries) {
      if (entry.competencyId === competencyId) invalid('A competency cannot contribute points to its own rule');
      if (seen.has(entry.competencyId)) invalid('The rule lists the same competency twice');
      seen.add(entry.competencyId);
      if (!childIds.has(entry.competencyId)) invalid('Rule points can only come from direct children of the competency');
      if (!Number.isInteger(entry.points) || entry.points < 0) invalid('Rule points must be a non-negative integer');
      total += entry.points;
    }
    if (!seen.size) invalid('A points rule needs at least one child competency');
    if (input.pointsRequired > total) invalid('The points required exceed the total points the children can contribute');
    const config: CompetencyRulePointsConfig = { pointsRequired: input.pointsRequired, entries: input.entries };
    await this.repo.updateCompetency(competencyId, { ruleType: 'points', ruleConfig: config, ruleOutcome: outcome });
    return this.getCompetencyRule(competencyId);
  }

  /**
   * Đánh giá rule points của competency CHA sau khi một competency con đạt proficiency
   * (oracle: Moodle `api::apply_competency_rules_from_usercompetency`). Rule thỏa khi mọi
   * con `required` đều proficient (trong cùng scope plan/course của con) và tổng điểm
   * các con đã đạt >= ngưỡng. Idempotent: cha đã proficient (outcome complete) hoặc đã có
   * evidence `rule_points_met` (outcome attach-evidence) thì không ghi thêm gì.
   * Cha đạt nhờ rule lại được đánh giá tiếp lên ông (đệ quy theo cây).
   */
  private async evaluateParentRule(userId: string, childCompetencyId: string, scope: { planId?: string; courseId?: string }): Promise<void> {
    const child = await this.repo.getCompetency(childCompetencyId);
    if (!child?.parentId) return;
    const parent = await this.repo.getCompetency(child.parentId);
    if (!parent || parent.ruleType !== 'points' || parent.ruleOutcome === 'nothing') return;
    const config = parseRuleConfig(parent.ruleConfig);
    if (!config) return;
    const planId = scope.planId ?? null;
    const courseId = scope.courseId ?? null;
    const scoped = (await this.repo.listUsercompsForUser(userId))
      .filter((r) => (r.planId ?? null) === planId && (r.courseId ?? null) === courseId);
    const proficientIds = new Set(scoped.filter((r) => r.proficiency === true).map((r) => r.competencyId));
    let points = 0;
    for (const entry of config.entries) {
      if (!proficientIds.has(entry.competencyId)) {
        if (entry.required) return; // con bắt buộc chưa đạt ⇒ rule chưa thỏa
        continue;
      }
      points += entry.points;
    }
    if (points < config.pointsRequired) return;
    const parentUc = await this.getOrCreateUsercomp(userId, parent.id, scope);
    const existing = await this.repo.listEvidence(parentUc.id);
    if (existing.some((e) => e.action === 'rule_points_met')) return; // đã áp rule rồi — không ghi trùng
    if (parent.ruleOutcome === 'attach-evidence') {
      // Chỉ ghi evidence: proficiency của cha KHÔNG đổi (bám Moodle OUTCOME_EVIDENCE).
      await this.repo.insertEvidence({
        userCompetencyId: parentUc.id, actionUserId: userId, action: 'rule_points_met',
        description: 'Competency rule (points) matched', grade: null,
      });
      return;
    }
    // outcome 'complete': cha tự đạt proficiency theo mức proficient đầu tiên của scale.
    if (parentUc.proficiency === true) return;
    const framework = await this.getFramework(parent.frameworkId);
    const grade = parseScale(framework).proficient[0];
    if (grade === undefined) return;
    await this.repo.updateUsercomp(parentUc.id, { grade, proficiency: true });
    await this.repo.insertEvidence({
      userCompetencyId: parentUc.id, actionUserId: userId, action: 'rule_points_met',
      description: 'Competency rule (points) matched', grade,
    });
    await this.emitter.emitAsync('competency_proficiency_changed', { userId, competencyId: parent.id });
    await this.outbox.enqueueStandalone({
      aggregate: 'competency', type: 'competency_proficiency_changed',
      payload: { userId, competencyId: parent.id, proficient: true, via: 'rule-points' },
    });
    await this.evaluateParentRule(userId, parent.id, scope);
  }

  // --- framework export / import / duplication --------------------------------------------

  /**
   * Export một framework ra tài liệu JSON của hệ thống (cây competency + scale + taxonomies + rule).
   * `key` trong tài liệu là id nguồn, chỉ dùng để nối cấu trúc nội bộ của file.
   */
  async exportFramework(actorId: string, frameworkId: string): Promise<FrameworkExportDoc> {
    await this.requireManage(actorId);
    const framework = await this.getFramework(frameworkId);
    const competencies = await this.repo.listCompetencies(frameworkId);
    return {
      format: 'lms-competency-framework',
      version: 1,
      framework: {
        shortName: framework.shortName, idNumber: framework.idNumber, description: framework.description,
        visible: framework.visible, taxonomies: framework.taxonomies, scale: parseScale(framework),
      },
      competencies: competencies.map((c) => {
        const config = c.ruleType === 'points' ? parseRuleConfig(c.ruleConfig) : null;
        return {
          key: c.id, shortName: c.shortName, idNumber: c.idNumber, description: c.description,
          parentKey: c.parentId, sortOrder: c.sortOrder,
          rule: config ? {
            outcome: c.ruleOutcome, pointsRequired: config.pointsRequired,
            entries: config.entries.map((e) => ({ competencyKey: e.competencyId, points: e.points, required: e.required })),
          } : null,
        };
      }),
    };
  }

  /**
   * Kiểm tra tính toàn vẹn nội bộ của tài liệu export trước khi tạo framework:
   * key duy nhất, parentKey tồn tại và không tạo chu trình, rule chỉ tham chiếu con
   * trực tiếp của chính competency mang rule, ngưỡng điểm với tới được, scale hợp lệ.
   * Mọi lỗi đều là `competency.import_invalid` (400) và không có gì được tạo.
   */
  private validateFrameworkExport(doc: FrameworkExportDoc): void {
    const invalid = (msg: string): never => { throw new BadRequestException({ message: msg, code: 'competency.import_invalid' }); };
    if (!doc.framework.scale.values.length) invalid('The framework scale needs at least one value');
    for (const idx of doc.framework.scale.proficient) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= doc.framework.scale.values.length) invalid('A proficient index is outside the scale');
    }
    const byKey = new Map<string, FrameworkExportDoc['competencies'][number]>();
    for (const c of doc.competencies) {
      if (byKey.has(c.key)) invalid(`Duplicate competency key ${c.key}`);
      byKey.set(c.key, c);
    }
    for (const c of doc.competencies) {
      if (c.parentKey !== null) {
        if (c.parentKey === c.key) invalid('A competency cannot be its own parent');
        if (!byKey.has(c.parentKey)) invalid(`Unknown parent key ${c.parentKey}`);
      }
      if (c.rule) {
        const seen = new Set<string>();
        let total = 0;
        for (const entry of c.rule.entries) {
          const target = byKey.get(entry.competencyKey);
          if (!target) invalid(`Rule references unknown competency key ${entry.competencyKey}`);
          if (target!.parentKey !== c.key) invalid('Rule points can only come from direct children of the competency');
          if (seen.has(entry.competencyKey)) invalid('The rule lists the same competency twice');
          seen.add(entry.competencyKey);
          total += entry.points;
        }
        if (!seen.size) invalid('A points rule needs at least one child competency');
        if (c.rule.pointsRequired > total) invalid('The points required exceed the total points the children can contribute');
      }
    }
  }

  /**
   * Tạo framework MỚI từ tài liệu export (id mới toàn bộ, cấu trúc cây/scale/rule giữ nguyên).
   * Toàn bộ thao tác nằm trong MỘT transaction: tài liệu hỏng ⇒ rollback, không tạo nửa vời.
   * Dùng chung cho import và duplication.
   */
  private async createFrameworkFromExport(doc: FrameworkExportDoc, overrides?: { shortName?: string; idNumber?: string }): Promise<FrameworkRow> {
    this.validateFrameworkExport(doc);
    const frameworkId = await this.repo.dbHandle.transaction(async (tx) => {
      const framework = await this.repo.insertFramework({
        shortName: overrides?.shortName ?? doc.framework.shortName,
        idNumber: overrides?.idNumber ?? doc.framework.idNumber,
        description: doc.framework.description, contextId: await this.systemCtx(),
        scaleConfiguration: doc.framework.scale, taxonomies: doc.framework.taxonomies,
        visible: doc.framework.visible,
      }, tx as never);
      // Chèn theo thứ tự topo: cha trước con (tài liệu export vốn đã xếp theo path,
      // nhưng import từ ngoài vào không được tin cậy thứ tự đó).
      const mapped = new Map<string, { id: string; path: string; depth: number }>();
      const pending = [...doc.competencies];
      while (pending.length) {
        const idx = pending.findIndex((c) => c.parentKey === null || mapped.has(c.parentKey));
        if (idx === -1) throw new BadRequestException({ message: 'The competency tree contains a cycle', code: 'competency.import_invalid' });
        const [node] = pending.splice(idx, 1);
        const parentInfo = node.parentKey ? mapped.get(node.parentKey)! : undefined;
        const created = await this.repo.insertCompetency({
          frameworkId: framework.id, shortName: node.shortName, idNumber: node.idNumber,
          description: node.description, parentId: parentInfo?.id ?? null,
          path: '', depth: parentInfo ? parentInfo.depth + 1 : 1, sortOrder: node.sortOrder,
        }, tx as never);
        const path = parentInfo ? `${parentInfo.path}/${created.id}` : `/${created.id}`;
        await this.repo.updateCompetency(created.id, { path }, tx as never);
        mapped.set(node.key, { id: created.id, path, depth: parentInfo ? parentInfo.depth + 1 : 1 });
      }
      // Rule gắn sau khi mọi competency đã có id mới (config tham chiếu id con).
      for (const node of doc.competencies) {
        if (!node.rule) continue;
        const config: CompetencyRulePointsConfig = {
          pointsRequired: node.rule.pointsRequired,
          entries: node.rule.entries.map((e) => ({ competencyId: mapped.get(e.competencyKey)!.id, points: e.points, required: e.required })),
        };
        await this.repo.updateCompetency(mapped.get(node.key)!.id, {
          ruleType: 'points', ruleConfig: config, ruleOutcome: node.rule.outcome,
        }, tx as never);
      }
      return framework.id;
    });
    return this.getFramework(frameworkId);
  }

  /**
   * Import tài liệu export thành một framework mới (capability quản lý framework).
   */
  async importFramework(actorId: string, doc: FrameworkExportDoc): Promise<FrameworkRow> {
    await this.requireManage(actorId);
    return this.createFrameworkFromExport(doc);
  }

  /**
   * Nhân bản framework ngay trong hệ thống (oracle: Moodle `api::duplicate_framework` /
   * `test_duplicate_framework`): framework mới mang idNumber chưa dùng (hậu tố `_1`, `_2`, …),
   * shortName thêm " (copy)", toàn bộ cây + rule được sao với id mới (rule config được
   * migrate sang id con mới như Moodle `migrate_competency_tree_rules`).
   */
  async duplicateFramework(actorId: string, frameworkId: string): Promise<FrameworkRow> {
    const doc = await this.exportFramework(actorId, frameworkId);
    const original = await this.getFramework(frameworkId);
    const used = new Set((await this.repo.listFrameworks()).map((f) => f.idNumber));
    let n = 1;
    let candidate = `${original.idNumber}_${n}`;
    while (used.has(candidate)) { n += 1; candidate = `${original.idNumber}_${n}`; }
    return this.createFrameworkFromExport(doc, { shortName: `${original.shortName} (copy)`, idNumber: candidate });
  }

  // --- course / cm links --------------------------------------------------------------

  private assertOutcome(outcome: string): RuleOutcome {
    if (!RULE_OUTCOMES.includes(outcome as RuleOutcome)) {
      throw new BadRequestException({ message: `Unknown ruleOutcome ${outcome} (expected complete | attach-evidence | nothing)`, code: 'competency.bad_ruleoutcome' });
    }
    return outcome as RuleOutcome;
  }

  /**
   * Liên kết competency với khoá học + quy tắc tự cấp proficiency.
   */
  async linkCourseCompetency(actorId: string, courseId: string, input: { competencyId: string; ruleOutcome: string }) {
    await this.courses.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'competency:coursecompetencymanage', await this.courses.courseContextId(courseId));
    const competencyRow = await this.getCompetency(input.competencyId);
    return this.repo.insertCourseLink({ courseId: courseId, competencyId: competencyRow.id, ruleOutcome: this.assertOutcome(input.ruleOutcome) });
  }
  /**
   * Competency đã liên kết với khoá học.
   */
  async listCourseCompetencies(courseId: string) {
    return this.repo.listCourseLinks(courseId);
  }
  /**
   * Liên kết competency với course module.
   */
  async linkModuleCompetency(actorId: string, cmId: string, input: { competencyId: string; ruleOutcome: string }) {
    const cm = await this.courses.getCm(cmId);
    await this.evaluator.requireCapability(actorId, 'competency:coursecompetencymanage', await this.courses.courseContextId(cm.course));
    const competencyRow = await this.getCompetency(input.competencyId);
    return this.repo.insertModuleLink({ courseModuleId: cmId, competencyId: competencyRow.id, ruleOutcome: this.assertOutcome(input.ruleOutcome) });
  }
  /**
   * Competency đã liên kết với module.
   */
  async listModuleCompetencies(cmId: string) {
    return this.repo.listModuleLinks(cmId);
  }

  // --- user competencies + evidence -------------------------------------------------------

  /**
   * Lấy hoặc tạo bản ghi năng lực của user cho một competency.
   */
  async getOrCreateUsercomp(userId: string, competencyId: string, scope: { planId?: string; courseId?: string }): Promise<UsercompRow> {
    const planId = scope.planId ?? null;
    const courseId = scope.courseId ?? null;
    const existing = await this.repo.findUsercomp(userId, competencyId, planId, courseId);
    if (existing) return existing;
    return this.repo.insertUsercomp({ userId: userId, competencyId: competencyId, planId, courseId });
  }

  /**
   * Lấy usercomp theo id.
   */
  async getUsercomp(id: string): Promise<UsercompRow> {
    const row = await this.repo.getUsercomp(id);
    if (!row) throw new NotFoundException({ message: `User competency ${id} not found`, code: 'competency.usercomp_not_found' });
    return row;
  }
  /**
   * Usercomp của user.
   */
  async listUsercompsForUser(userId: string): Promise<UsercompRow[]> {
    return this.repo.listUsercompsForUser(userId);
  }

  /** Facade for BadgesModule: is this user proficient in this competency (any scope)? */
  /**
   * User đã đạt chuẩn competency hay chưa.
   */
  async isProficient(userId: string, competencyId: string): Promise<boolean> {
    const rows = await this.repo.listUsercompsForUser(userId);
    return rows.some((r) => r.competencyId === competencyId && r.proficiency === true);
  }

  private async validateGrade(competencyId: string, grade: number): Promise<FrameworkRow> {
    const competencyRow = await this.getCompetency(competencyId);
    const framework = await this.getFramework(competencyRow.frameworkId);
    const scale = parseScale(framework);
    if (!Number.isInteger(grade) || grade < 0 || grade >= scale.values.length) {
      throw new BadRequestException({
        message: `Grade ${grade} is not a value of the framework scale (0..${scale.values.length - 1})`,
        code: 'competency.grade_outside_scale',
      });
    }
    return framework;
  }

  /**
   * Attach evidence to a user's competency (oracle: api_test
   * test_add_evidence_*). A grade on evidence is a SCALE INDEX: it sets
   * proficiency per the framework scale — but only when the actor may rate
   * (review capability, or the plan/course manager path). Evidence submitted
   * by the learner themselves is recorded WITHOUT a proficiency effect
   * unless sendForReview moves it into the review workflow.
   */
  /**
   * Thêm bằng chứng cho usercomp (có thể đồng thời gửi duyệt).
   */
  async addEvidence(actorId: string, input: {
    userId: string; competencyId: string; planId?: string; courseId?: string;
    description: string; url?: string; grade?: number; note?: string; sendForReview?: boolean;
  }): Promise<{ usercomp: UsercompRow; evidence: EvidenceRow }> {
    const competencyRow = await this.getCompetency(input.competencyId);
    void competencyRow;
    await this.users.getUser(input.userId);
    if (input.grade !== undefined) await this.validateGrade(input.competencyId, input.grade);
    const canRate = await this.evaluator.hasCapability(actorId, 'competency:usercompetencyreview', await this.systemCtx());
    const usercomp = await this.getOrCreateUsercomp(input.userId, input.competencyId, { planId: input.planId, courseId: input.courseId });
    let evidence!: EvidenceRow;
    await this.repo.dbHandle.transaction(async (tx) => {
      evidence = await this.repo.insertEvidence({
        userCompetencyId: usercomp.id, actionUserId: actorId, action: 'evidence',
        description: input.description, url: input.url ?? null,
        grade: input.grade ?? null, note: input.note ?? '',
        contextId: await this.systemCtx(),
      }, tx as never);
      if (input.grade !== undefined && canRate) {
        const framework = await this.getFramework(competencyRow.frameworkId);
        await this.repo.updateUsercomp(usercomp.id, {
          grade: input.grade, proficiency: isProficientGrade(framework, input.grade),
        }, tx as never);
        await this.emitter.emitAsync('competency_proficiency_changed', { userId: input.userId, competencyId: input.competencyId });
      }
      if (input.sendForReview) {
        await this.repo.updateUsercomp(usercomp.id, { status: USERCOMP_REVIEW.WAITING }, tx as never);
        await this.repo.insertEvidence({
          userCompetencyId: usercomp.id, actionUserId: actorId, action: 'review_requested',
          description: 'Sent for review with evidence', grade: null,
        }, tx as never);
      }
      await this.outbox.enqueue(tx as never, {
        aggregate: 'competency', type: 'competency_evidence_added',
        payload: { userId: input.userId, competencyId: input.competencyId, evidenceId: evidence.id },
      });
    });
    // Evidence kèm grade của người có quyền chấm đã đặt proficiency ⇒ đánh giá rule của cha.
    if (input.grade !== undefined && canRate) {
      const framework = await this.getFramework(competencyRow.frameworkId);
      if (isProficientGrade(framework, input.grade)) {
        await this.evaluateParentRule(input.userId, input.competencyId, { planId: input.planId, courseId: input.courseId });
      }
    }
    return { usercomp: await this.getUsercomp(usercomp.id), evidence };
  }

  /**
   * Bằng chứng của usercomp.
   */
  async listEvidence(usercompId: string): Promise<EvidenceRow[]> {
    await this.getUsercomp(usercompId);
    return this.repo.listEvidence(usercompId);
  }

  // --- usercomp review workflow ---------------------------------------------------------

  private async transitionUsercompReview(actorId: string, usercompId: string, action: 'request' | 'start' | 'approve' | 'reject',
    opts?: { grade?: number; note?: string }): Promise<UsercompRow> {
    const usercomp = await this.getUsercomp(usercompId);
    const systemCtx = await this.systemCtx();
    if (action === 'request') {
      if (actorId !== usercomp.userId) {
        await this.evaluator.requireCapability(actorId, 'competency:planmanage', systemCtx);
      }
      if (usercomp.status !== USERCOMP_REVIEW.NONE) {
        throw new BadRequestException({ message: 'A review is already in progress for this competency', code: 'competency.review_in_progress' });
      }
      await this.repo.updateUsercomp(usercompId, { status: USERCOMP_REVIEW.WAITING });
      await this.repo.insertEvidence({ userCompetencyId: usercompId, actionUserId: actorId, action: 'review_requested', description: 'Review requested', note: opts?.note ?? '' });
    } else {
      await this.evaluator.requireCapability(actorId, 'competency:usercompetencyreview', systemCtx);
      if (action === 'start') {
        if (usercomp.status !== USERCOMP_REVIEW.WAITING) {
          throw new BadRequestException({ message: 'Review can only start from waitingforreview', code: 'competency.review_not_waiting' });
        }
        await this.repo.updateUsercomp(usercompId, { status: USERCOMP_REVIEW.IN_REVIEW, reviewerId: actorId });
        await this.repo.insertEvidence({ userCompetencyId: usercompId, actionUserId: actorId, action: 'review_started', description: 'Review started', note: opts?.note ?? '' });
      } else if (action === 'approve') {
        if (usercomp.status !== USERCOMP_REVIEW.IN_REVIEW && usercomp.status !== USERCOMP_REVIEW.WAITING) {
          throw new BadRequestException({ message: 'Only a competency in review can be approved', code: 'competency.review_not_in_review' });
        }
        if (opts?.grade !== undefined) await this.validateGrade(usercomp.competencyId, opts.grade);
        const competencyRow = await this.getCompetency(usercomp.competencyId);
        const framework = await this.getFramework(competencyRow.frameworkId);
        const scale = parseScale(framework);
        const grade = opts?.grade ?? scale.proficient[0];
        if (grade === undefined) throw new BadRequestException({ message: 'The framework scale has no proficient value to approve with', code: 'competency.scale_no_proficient' });
        await this.repo.updateUsercomp(usercompId, {
          status: USERCOMP_REVIEW.NONE, grade, proficiency: isProficientGrade(framework, grade), reviewerId: actorId,
        });
        await this.repo.insertEvidence({
          userCompetencyId: usercompId, actionUserId: actorId, action: 'review_approved',
          description: 'Review approved', grade, note: opts?.note ?? '',
        });
        await this.emitter.emitAsync('competency_proficiency_changed', { userId: usercomp.userId, competencyId: usercomp.competencyId });
        await this.outbox.enqueueStandalone({
          aggregate: 'competency', type: 'competency_proficiency_changed',
          payload: { userId: usercomp.userId, competencyId: usercomp.competencyId, proficient: true },
        });
        // Con vừa đạt proficiency ⇒ đánh giá rule points của cha (cùng đường Moodle dùng khi duyệt).
        if (isProficientGrade(framework, grade)) {
          await this.evaluateParentRule(usercomp.userId, usercomp.competencyId, { planId: usercomp.planId ?? undefined, courseId: usercomp.courseId ?? undefined });
        }
      } else {
        if (usercomp.status !== USERCOMP_REVIEW.IN_REVIEW && usercomp.status !== USERCOMP_REVIEW.WAITING) {
          throw new BadRequestException({ message: 'Only a competency in review can be rejected', code: 'competency.review_not_in_review' });
        }
        await this.repo.updateUsercomp(usercompId, { status: USERCOMP_REVIEW.NONE, reviewerId: actorId });
        await this.repo.insertEvidence({
          userCompetencyId: usercompId, actionUserId: actorId, action: 'review_rejected',
          description: 'Review rejected', note: opts?.note ?? '',
        });
      }
    }
    return this.getUsercomp(usercompId);
  }

  /**
   * Gửi usercomp đi duyệt.
   */
  async requestUsercompReview(actorId: string, usercompId: string): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'request');
  }
  /**
   * Reviewer bắt đầu duyệt usercomp.
   */
  async startUsercompReview(actorId: string, usercompId: string): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'start');
  }
  /**
   * Duyệt đạt: đặt proficiency theo thang của framework.
   */
  async approveUsercompReview(actorId: string, usercompId: string, grade?: number, note?: string): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'approve', { grade, note });
  }
  /**
   * Từ chối duyệt usercomp.
   */
  async rejectUsercompReview(actorId: string, usercompId: string, note?: string): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'reject', { note });
  }

  /** Direct rating by a reviewer (oracle: test_add_evidence_complete / grade_competency_in_course). */
  /**
   * Chấm trực tiếp proficiency cho usercomp bởi người có capability.
   */
  async gradeUsercomp(actorId: string, input: { userId: string; competencyId: string; planId?: string; courseId?: string; grade: number; note?: string }): Promise<UsercompRow> {
    await this.evaluator.requireCapability(actorId, 'competency:usercompetencyreview', await this.systemCtx());
    const framework = await this.validateGrade(input.competencyId, input.grade);
    const usercomp = await this.getOrCreateUsercomp(input.userId, input.competencyId, { planId: input.planId, courseId: input.courseId });
    await this.repo.updateUsercomp(usercomp.id, { grade: input.grade, proficiency: isProficientGrade(framework, input.grade) });
    await this.repo.insertEvidence({
      userCompetencyId: usercomp.id, actionUserId: actorId, action: 'graded',
      description: 'Rated by reviewer', grade: input.grade, note: input.note ?? '',
    });
    await this.emitter.emitAsync('competency_proficiency_changed', { userId: input.userId, competencyId: input.competencyId });
    if (isProficientGrade(framework, input.grade)) {
      await this.evaluateParentRule(input.userId, input.competencyId, { planId: input.planId, courseId: input.courseId });
    }
    return this.getUsercomp(usercomp.id);
  }

  // --- completion-driven rule outcomes (registered hooks) --------------------------------

  /** Course completed ⇒ apply each linked competency's ruleOutcome in the COURSE scope. */
  /**
   * Hook hoàn thành khoá học: cấp proficiency cho competency liên kết có quy tắc tự động.
   */
  async applyCourseCompletion(courseId: string, userId: string): Promise<void> {
    const links = await this.repo.listCourseLinks(courseId);
    for (const link of links) {
      if (link.ruleOutcome === 'nothing') continue;
      await this.applyOutcome(userId, link.competencyId, { courseId }, link.ruleOutcome as RuleOutcome, `Course ${courseId} completed`);
    }
  }
  /** Activity completed ⇒ apply each linked competency's ruleOutcome in the COURSE scope of the cm's course. */
  /**
   * Hook hoàn thành cm: cấp proficiency cho competency liên kết với module.
   */
  async applyCmCompletion(cmId: string, userId: string): Promise<void> {
    const links = await this.repo.listModuleLinks(cmId);
    if (!links.length) return;
    const cm = await this.courses.getCm(cmId).catch(() => undefined);
    for (const link of links) {
      if (link.ruleOutcome === 'nothing') continue;
      await this.applyOutcome(userId, link.competencyId, { courseId: cm?.course }, link.ruleOutcome as RuleOutcome, `Activity ${cmId} completed`);
    }
  }

  private async applyOutcome(userId: string, competencyId: string, scope: { planId?: string; courseId?: string },
    outcome: RuleOutcome, description: string): Promise<void> {
    const usercomp = await this.getOrCreateUsercomp(userId, competencyId, scope);
    if (outcome === 'attach-evidence') {
      // Evidence ONLY: proficiency is untouched — grades/points never leak
      // into proficiency (report §2#15).
      await this.repo.insertEvidence({
        userCompetencyId: usercomp.id, actionUserId: userId, action: 'course_completed',
        description, grade: null,
      });
      return;
    }
    // 'complete': proficiency from the framework scale's first proficient value.
    const competencyRow = await this.getCompetency(competencyId);
    const framework = await this.getFramework(competencyRow.frameworkId);
    const scale = parseScale(framework);
    const grade = scale.proficient[0];
    await this.repo.insertEvidence({
      userCompetencyId: usercomp.id, actionUserId: userId, action: 'course_completed',
      description, grade: grade ?? null,
    });
    if (grade !== undefined) {
      await this.repo.updateUsercomp(usercomp.id, { grade, proficiency: true });
      await this.emitter.emitAsync('competency_proficiency_changed', { userId, competencyId });
      await this.outbox.enqueueStandalone({
        aggregate: 'competency', type: 'competency_proficiency_changed',
        payload: { userId, competencyId, proficient: true, via: 'course-completion' },
      });
      await this.evaluateParentRule(userId, competencyId, scope);
    }
  }

  // --- templates ---------------------------------------------------------------------------

  /**
   * Tạo template kế hoạch.
   */
  async createTemplate(actorId: string, input: { shortName: string; description?: string; dueDate?: string }): Promise<TemplateRow> {
    await this.requireManage(actorId);
    return this.repo.insertTemplate({
      shortName: input.shortName, description: input.description ?? '',
      contextId: await this.systemCtx(), dueDate: input.dueDate ? new Date(input.dueDate) : null,
    });
  }
  /**
   * Lấy template; ném competencies.template_not_found khi vắng.
   */
  async getTemplate(id: string): Promise<TemplateRow> {
    const row = await this.repo.getTemplate(id);
    if (!row) throw new NotFoundException({ message: `Template ${id} not found`, code: 'competency.template_not_found' });
    return row;
  }
  /**
   * Liệt kê template.
   */
  async listTemplates(): Promise<TemplateRow[]> { return this.repo.listTemplates(); }
  /**
   * Thêm competency vào template.
   */
  async addTemplateCompetency(actorId: string, templateId: string, competencyId: string): Promise<{ templateId: string; competencies: CompetencyRow[] }> {
    await this.requireManage(actorId);
    await this.getTemplate(templateId);
    await this.getCompetency(competencyId);
    await this.repo.addTemplateCompetency(templateId, competencyId);
    return { templateId, competencies: await this.repo.listTemplateCompetencies(templateId) };
  }
  /**
   * Gắn cohort vào template.
   */
  async addTemplateCohort(actorId: string, templateId: string, cohortId: string): Promise<{ templateId: string; cohorts: string[] }> {
    await this.requireManage(actorId);
    await this.getTemplate(templateId);
    await this.groups.getCohort(cohortId);
    await this.repo.addTemplateCohort(templateId, cohortId);
    return { templateId, cohorts: await this.repo.listTemplateCohorts(templateId) };
  }

  /** Generate plans for every member of every linked cohort (idempotent per user+template). */
  /**
   * Sinh plan cho mọi thành viên cohort của template (bỏ qua user đã có plan từ template này).
   */
  async createPlansFromTemplate(actorId: string, templateId: string): Promise<{ created: number; plans: PlanRow[] }> {
    await this.requireManage(actorId);
    const template = await this.getTemplate(templateId);
    const cohortIds = await this.repo.listTemplateCohorts(templateId);
    const plans: PlanRow[] = [];
    for (const cohortId of cohortIds) {
      const members = await this.groups.listCohortMembers(cohortId);
      for (const member of members) {
        const plan = await this.createPlanFromTemplate(template, member.userId);
        if (plan) plans.push(plan);
      }
    }
    return { created: plans.length, plans };
  }

  private async createPlanFromTemplate(template: TemplateRow, userId: string): Promise<PlanRow | null> {
    const existing = await this.repo.findPlanFromTemplate(userId, template.id);
    if (existing) return null;
    const competencies = await this.repo.listTemplateCompetencies(template.id);
    const plan = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertPlan({
        name: template.shortName, description: template.description, userId: userId,
        templateId: template.id, status: PLAN_STATUS.ACTIVE, dueDate: template.dueDate,
      }, tx as never);
      for (const c of competencies) await this.repo.addPlanCompetency(created.id, c.id, tx as never);
      return created;
    });
    for (const c of competencies) {
      await this.getOrCreateUsercomp(userId, c.id, { planId: plan.id });
    }
    return plan;
  }

  // --- plans ---------------------------------------------------------------------------------

  /**
   * Tạo plan thủ công cho user.
   */
  async createPlan(actorId: string, input: { userId?: string; name: string; description?: string; templateId?: string }): Promise<PlanRow & { competencies: string[] }> {
    const userId = input.userId ?? actorId;
    if (userId !== actorId) {
      await this.evaluator.requireCapability(actorId, 'competency:planmanage', await this.systemCtx());
    }
    await this.users.getUser(userId);
    if (input.templateId) {
      const template = await this.getTemplate(input.templateId);
      const created = await this.createPlanFromTemplate(template, userId);
      const plan = created ?? (await this.repo.findPlanFromTemplate(userId, template.id))!;
      return { ...plan, competencies: await this.repo.listPlanCompetencyIds(plan.id) };
    }
    const plan = await this.repo.insertPlan({
      name: input.name, description: input.description ?? '', userId: userId,
      templateId: null, status: PLAN_STATUS.DRAFT,
    });
    return { ...plan, competencies: [] };
  }

  /**
   * Chi tiết plan kèm trạng thái từng competency.
   */
  async getPlanView(actorId: string, planId: string): Promise<{ plan: PlanRow; competencies: { competency: CompetencyRow; usercomp: UsercompRow | null }[]; reviews: unknown }> {
    const plan = await this.repo.getPlan(planId);
    if (!plan) throw new NotFoundException({ message: `Learning plan ${planId} not found`, code: 'competency.plan_not_found' });
    if (plan.userId !== actorId) {
      await this.evaluator.requireCapability(actorId, 'competency:planview', await this.systemCtx());
    }
    const ids = plan.templateId
      ? (await this.repo.listTemplateCompetencies(plan.templateId)).map((c) => c.id)
      : await this.repo.listPlanCompetencyIds(planId);
    const usercomps = await this.repo.listUsercompsForPlan(planId, plan.userId);
    const competencies = [];
    for (const id of ids) {
      competencies.push({
        competency: await this.getCompetency(id),
        usercomp: usercomps.find((u) => u.competencyId === id) ?? null,
      });
    }
    return { plan, competencies, reviews: await this.repo.listPlanReviews(planId) };
  }

  /**
   * Plan của user.
   */
  async listPlansForUser(actorId: string, userId: string): Promise<PlanRow[]> {
    if (actorId !== userId) {
      await this.evaluator.requireCapability(actorId, 'competency:planview', await this.systemCtx());
    }
    return this.repo.listPlansForUser(userId);
  }

  private async planTransition(actorId: string, planId: string, action: 'activate' | 'request-review' | 'cancel-review' | 'start-review' | 'stop-review' | 'approve' | 'unapprove' | 'complete',
    note?: string): Promise<PlanRow> {
    const plan = await this.repo.getPlan(planId);
    if (!plan) throw new NotFoundException({ message: `Learning plan ${planId} not found`, code: 'competency.plan_not_found' });
    const from = plan.status;
    const bad = (msg: string): never => { throw new BadRequestException({ message: msg, code: 'competency.plan_bad_transition' }); };
    let to = from;
    switch (action) {
      case 'activate':
        if (plan.userId !== actorId) await this.evaluator.requireCapability(actorId, 'competency:planmanage', await this.systemCtx());
        if (from !== PLAN_STATUS.DRAFT) bad('Only a draft plan can be activated');
        to = PLAN_STATUS.ACTIVE;
        break;
      case 'request-review':
        if (plan.userId !== actorId) await this.evaluator.requireCapability(actorId, 'competency:planmanage', await this.systemCtx());
        if (from !== PLAN_STATUS.ACTIVE) bad('Only an active plan can be sent for review');
        to = PLAN_STATUS.WAITING_FOR_REVIEW;
        break;
      case 'cancel-review':
        if (plan.userId !== actorId) await this.evaluator.requireCapability(actorId, 'competency:planmanage', await this.systemCtx());
        if (from !== PLAN_STATUS.WAITING_FOR_REVIEW) bad('Only a plan waiting for review can cancel the request');
        to = PLAN_STATUS.ACTIVE;
        break;
      case 'start-review':
        await this.evaluator.requireCapability(actorId, 'competency:usercompetencyreview', await this.systemCtx());
        if (from !== PLAN_STATUS.WAITING_FOR_REVIEW) bad('Review can only start for a plan waiting for review');
        to = PLAN_STATUS.IN_REVIEW;
        break;
      case 'stop-review':
        await this.evaluator.requireCapability(actorId, 'competency:usercompetencyreview', await this.systemCtx());
        if (from !== PLAN_STATUS.IN_REVIEW) bad('Only a plan in review can stop review');
        to = PLAN_STATUS.ACTIVE;
        break;
      case 'approve':
        await this.evaluator.requireCapability(actorId, 'competency:usercompetencyreview', await this.systemCtx());
        if (from !== PLAN_STATUS.IN_REVIEW) bad('Only a plan in review can be approved');
        to = PLAN_STATUS.ACTIVE; // approved review returns the plan to active (Moodle approve_plan)
        break;
      case 'unapprove':
        await this.evaluator.requireCapability(actorId, 'competency:usercompetencyreview', await this.systemCtx());
        if (from !== PLAN_STATUS.ACTIVE) bad('Only an active (previously approved) plan can be unapproved');
        to = PLAN_STATUS.IN_REVIEW;
        break;
      case 'complete':
        if (plan.userId !== actorId) await this.evaluator.requireCapability(actorId, 'competency:planmanage', await this.systemCtx());
        if (from !== PLAN_STATUS.ACTIVE && from !== PLAN_STATUS.IN_REVIEW) bad('Only an active plan can be completed');
        to = PLAN_STATUS.COMPLETE;
        break;
    }
    await this.repo.updatePlan(planId, { status: to, reviewerId: ['start-review', 'approve', 'unapprove'].includes(action) ? actorId : plan.reviewerId });
    await this.repo.insertPlanReview({ planId: planId, actorId: actorId, action, statusFrom: from, statusTo: to, note: note ?? '' });
    if (action === 'request-review' && plan.reviewerId) {
      await this.messaging.notify(plan.reviewerId, 'competency_review_requested', {
        subject: this.i18n.t('platform.planReviewRequestedSubject', { args: { name: plan.name } }),
        body: this.i18n.t('platform.planReviewRequestedBody', { args: { userId: plan.userId, planId: plan.id } }),
        contextUrl: `/competencies/plans/${plan.id}`,
      }).catch(() => undefined);
    }
    await this.outbox.enqueueStandalone({
      aggregate: 'competency', type: `competency_plan_${action.replace('-', '_')}`,
      payload: { planId, userId: plan.userId, from, to },
    });
    return (await this.repo.getPlan(planId))!;
  }

  /**
   * Kích hoạt plan (draft → active).
   */
  async activatePlan(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'activate'); }
  /**
   * Gửi plan đi duyệt (notification nội dung lấy từ catalog i18n).
   */
  async requestPlanReview(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'request-review'); }
  /**
   * Huỷ yêu cầu duyệt plan.
   */
  async cancelPlanReview(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'cancel-review'); }
  /**
   * Reviewer bắt đầu duyệt plan.
   */
  async startPlanReview(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'start-review'); }
  /**
   * Dừng vòng duyệt plan.
   */
  async stopPlanReview(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'stop-review'); }
  /**
   * Duyệt plan.
   */
  async approvePlan(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'approve'); }
  /**
   * Gỡ duyệt plan.
   */
  async unapprovePlan(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'unapprove'); }
  /**
   * Hoàn tất plan.
   */
  async completePlan(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'complete'); }

  /** Forbidden import guard: plan owners may not review their own plans. */
  /**
   * Chặn tự duyệt: reviewer phải khác chủ plan/usercomp.
   */
  async assertNotSelfReview(actorId: string, userId: string): Promise<void> {
    if (actorId === userId) throw new ForbiddenException({ message: 'You cannot review your own competencies', code: 'competency.self_review' });
  }
}
