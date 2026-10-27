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
  /** PHẦN TRĂM điểm (0-100, ngữ nghĩa availability_grade của Moodle) theo khoá id của grade-item / id của cm — do provider đã đăng ký của GradesModule cung cấp qua CoursesService. Vắng mặt ⇒ các điều kiện theo điểm coi như chưa đạt. */
  grades?: Record<string, number>;
}

export type LeafEvaluator = (leaf: AvailabilityLeaf, ctx: AvailabilityContext) => Promise<LeafResult>;

/**
 * Facade của AvailabilityModule (core_availability của Moodle). Sở hữu ngữ nghĩa
 * cây và REGISTRY evaluator của lá: các module sở hữu đăng ký
 * loại lá của chúng (CompletionModule → 'completion', GroupsModule → 'group' và
 * 'grouping') để Availability không bao giờ import repository của chúng —
 * chiều phụ thuộc giữ nguyên Availability ← owners (report §3.12 đảo ngược
 * qua đăng ký, như các plugin điều kiện availability của Moodle).
 *
 * Các lá tích hợp sẵn: date, grade (hook cho Grades), profile (trường user).
 * Loại lá lạ được đánh giá là KHÔNG khả dụng (Moodle bỏ qua plugin thiếu
 * lúc dựng nhưng một điều kiện không kiểm tra được thì
 * không bao giờ được lặng lẽ cấp quyền truy cập).
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

  /** Kiểm chứng + phân tích cây đã lưu; ném BadRequest khi cấu trúc JSON sai định dạng. */
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

  /** Boolean rút gọn dùng cho các kiểm tra truy cập. */
  /**
   * Rút gọn của evaluate: chỉ cần biết khả dụng hay không.
   */
  async isAvailable(raw: unknown, ctx: AvailabilityContext): Promise<boolean> {
    return (await this.evaluate(raw, ctx)).available;
  }

  // --- các lá tích hợp sẵn -----------------------------------------------------

  /** Lá date: {type:'date', direction:'>='|'<' , time: epochSeconds|string}. availability_date của Moodle. */
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
   * Lá grade: {type:'grade', id, min, max} — min/max là PHẦN TRĂM của
   * grade item được tham chiếu (availability_grade của Moodle). Điểm: ctx.grades mang
   * phần trăm thật từ GradesModule; khi id không có điểm,
   * điều kiện coi như chưa đạt (không bao giờ tự qua).
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

  /** Lá profile: {type:'profile', field, operator ('eq'|'contains'|'notempty'|'isempty'), value}. Kiểm tra hồ sơ user + các trường tuỳ biến. */
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
