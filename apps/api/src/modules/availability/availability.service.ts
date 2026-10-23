import { BadRequestException, Injectable } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { UsersService } from '../users/users.service';
import {
  evaluateTree, parseAvailabilityTree,
  type AvailabilityNode, type AvailabilityLeaf, type LeafResult, type TreeEvaluation,
} from './domain/availability-tree';

export interface AvailabilityContext {
  userId: string;
  courseId?: string;
  now?: Date;
  /** Grade PERCENTAGES (0-100, Moodle availability_grade semantics) keyed by grade-item id / cm id — supplied by the GradesModule-registered provider via CoursesService. Absent ⇒ grade conditions are unmet. */
  grades?: Record<string, number>;
}

export type LeafEvaluator = (leaf: AvailabilityLeaf, ctx: AvailabilityContext) => Promise<LeafResult>;

/**
 * AvailabilityModule facade (Moodle core_availability). Owns the tree
 * semantics and the leaf-evaluator REGISTRY: owning modules register their
 * leaf types (CompletionModule → 'completion', GroupsModule → 'group' and
 * 'grouping') so Availability never imports their repositories — the
 * dependency direction stays Availability ← owners (report §3.12 inverted
 * via registration, like Moodle availability condition plugins).
 *
 * Built-in leaves: date, grade (hook for Grades), profile (user fields).
 * Unknown leaf types evaluate as NOT available (Moodle ignores missing
 * plugins at construct time but a condition that cannot be checked must
 * never silently grant access).
 */
@Injectable()
/**
 * Đánh giá cây điều kiện availability cho section/course module.
 * Đối chiếu Moodle: availability/classes (tree + từng condition plugin).
 * Dịch vụ là registry mở: mỗi loại điều kiện lá (date, grade, profile, completion, group, grouping)
 * đăng ký một evaluator; mô tả hiển thị của lá lấy từ catalog i18n (namespace availability)
 * theo locale của request, còn error code giữ nguyên tiếng Anh.
 */
export class AvailabilityService {
  private readonly evaluators = new Map<string, LeafEvaluator>();

  constructor(private readonly users: UsersService, private readonly i18n: I18nService) {
    this.register('date', async (leaf, ctx) => this.evalDate(leaf, ctx));
    this.register('grade', async (leaf, ctx) => this.evalGrade(leaf, ctx));
    this.register('profile', async (leaf, ctx) => this.evalProfile(leaf, ctx));
  }

  /**
   * Đăng ký evaluator cho một loại điều kiện lá (các module sở hữu điều kiện tự đăng ký khi khởi tạo).
   */
  register(type: string, evaluator: LeafEvaluator): void {
    this.evaluators.set(type, evaluator);
  }
  /**
   * Loại điều kiện đã có evaluator hay chưa.
   */
  hasEvaluator(type: string): boolean { return this.evaluators.has(type); }

  /** Validate + parse a stored tree; throws BadRequest on malformed JSON structures. */
  /**
   * Phân tích JSON availability thô thành cây điều kiện (ủy quyền cho availability-tree).
   */
  parse(raw: unknown): AvailabilityNode | null {
    try {
      return parseAvailabilityTree(raw);
    } catch (err) {
      throw new BadRequestException({ message: (err as Error).message, code: 'availability.invalid_tree' });
    }
  }

  /**
   * Đánh giá cây cho một user: trả available + failedDescriptions của các lá chưa đạt (chỉ ở nút có show=true).
   */
  async evaluate(raw: unknown, ctx: AvailabilityContext): Promise<TreeEvaluation> {
    const tree = this.parse(raw);
    if (!tree) {
      return { available: true, informationHidden: false, failedDescriptions: [], visible: true, children: [] };
    }
    return evaluateTree(tree, async (leaf) => {
      const evaluator = this.evaluators.get(leaf.type);
      if (!evaluator) return { available: false, description: this.i18n.t('availability.unknownCondition', { args: { type: leaf.type } }) };
      return evaluator(leaf, ctx);
    });
  }

  /** Convenience boolean used by access checks. */
  /**
   * Rút gọn của evaluate: chỉ cần biết khả dụng hay không.
   */
  async isAvailable(raw: unknown, ctx: AvailabilityContext): Promise<boolean> {
    return (await this.evaluate(raw, ctx)).available;
  }

  // --- built-in leaves -----------------------------------------------------

  /** date leaf: {type:'date', direction:'>='|'<' , time: epochSeconds|string}. Moodle availability_date. */
  private async evalDate(leaf: AvailabilityLeaf, ctx: AvailabilityContext): Promise<LeafResult> {
    const now = ctx.now ?? new Date();
    const rawTime = (leaf.t ?? leaf.time) as number | string | undefined;
    const when = typeof rawTime === 'number' ? new Date(rawTime * (rawTime < 1e12 ? 1000 : 1)) : new Date(String(rawTime));
    if (Number.isNaN(when.getTime())) return { available: false, description: this.i18n.t('availability.invalidDate') };
    const direction = String(leaf.d ?? leaf.direction ?? '>=');
    const available = direction === '<' || direction === '<=' ? now < when : now >= when;
    return { available, description: this.i18n.t('availability.dateRange', { args: { direction, date: when.toISOString() } }) };
  }

  /**
   * grade leaf: {type:'grade', id, min, max} — min/max are PERCENTAGES of the
   * referenced grade item (Moodle availability_grade). Grades: ctx.grades carries
   * real percentages from GradesModule; when no grade exists for the id, the
   * condition is unmet (never auto-pass).
   */
  private async evalGrade(leaf: AvailabilityLeaf, ctx: AvailabilityContext): Promise<LeafResult> {
    const id = String(leaf.id ?? '');
    const grade = ctx.grades?.[id];
    if (grade === undefined) return { available: false, description: this.i18n.t('availability.gradeNotAvailable', { args: { id } }) };
    const min = leaf.min !== undefined ? Number(leaf.min) : undefined;
    const max = leaf.max !== undefined ? Number(leaf.max) : undefined;
    const available = (min === undefined || grade >= min) && (max === undefined || grade <= max);
    const range = `${min !== undefined ? `>= ${min}` : ''}${max !== undefined ? `<= ${max}` : ''}`.trim();
    return { available, description: this.i18n.t('availability.gradeMustBe', { args: { id, range } }) };
  }

  /** profile leaf: {type:'profile', field, operator ('eq'|'contains'|'notempty'|'isempty'), value}. Checks user profile + custom fields. */
  private async evalProfile(leaf: AvailabilityLeaf, ctx: AvailabilityContext): Promise<LeafResult> {
    const field = String(leaf.field ?? leaf.sf ?? '');
    const operator = String(leaf.operator ?? leaf.op ?? 'eq');
    const expected = leaf.value !== undefined ? String(leaf.value) : (leaf.v !== undefined ? String(leaf.v) : '');
    let actual: string | undefined;
    try {
      const profile = await this.users.getProfileView(ctx.userId, ctx.userId);
      if (field === 'username') actual = profile.username;
      else if (field === 'firstName') actual = profile.firstName;
      else if (field === 'lastName') actual = profile.lastName;
      else if (field === 'email') actual = profile.email;
      else actual = profile.customFields.find((f) => f.shortName === field)?.value ?? undefined;
    } catch {
      return { available: false, description: this.i18n.t('availability.profileField', { args: { field } }) };
    }
    let available: boolean;
    switch (operator) {
      case 'notempty': case 'isnotempty': available = !!actual; break;
      case 'isempty': available = !actual; break;
      case 'contains': available = actual !== undefined && actual.includes(expected); break;
      default: available = actual !== undefined && actual === expected;
    }
    return { available, description: this.i18n.t('availability.profileCondition', { args: { field, operator, expected } }) };
  }
}
