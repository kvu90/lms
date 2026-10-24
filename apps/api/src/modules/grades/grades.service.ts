import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CompletionService } from '../completion/completion.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { UsersService } from '../users/users.service';
import { AGGREGATIONS, calculateCategory, letterForGrade, adjustedGrade, type AggregationStrategy, type CalcItemInput } from './domain/grade-calculator';
import { parseCsv, serializeCsv } from './domain/grade-csv';
import { GradeFormulaError, evaluateGradeFormula, findFormulaCycle, formulaReferences, parseGradeFormula } from './domain/grade-formula';
import { renderVneduWorkbook, type VneduExportItem, type VneduExportModel } from './domain/vnedu-export';
import type { ExportGradesVneduDto } from './dto/grades.dto';
import { GradesRepository, type CategoryRow, type GradeRow, type ItemRow, type LetterRow, type OutcomeRow, type ScaleRow } from './grades.repository';

export const GRADE_REGRADE_QUEUE = 'grade-regrade';
export const COMPLETION_PASS = 2;
export const COMPLETION_FAIL = 3;
export const COMPLETION_DONE = 1;

/** Trạng thái công bố của một item (PH-0, issue #116): policy neo trên item; published = điểm đang hiện phía học sinh. */
export interface GradePublicationState {
  policy: 'auto' | 'manual';
  published: boolean;
}

export interface GradebookItemView {
  item: ItemRow;
  grade: (GradeRow & { letter: string | null; scaleValue: string | null; outcomeName: string | null }) | null;
  /** Trạng thái công bố của item (PH-0) — phía không có grade:viewall nhận grade = null khi item manual chưa công bố. */
  publication: GradePublicationState;
}
export interface GradebookCategoryView {
  category: CategoryRow;
  total: GradebookItemView | null;
  items: GradebookItemView[];
  children: GradebookCategoryView[];
}

/** Một lỗi import CSV: `row` là số dòng trên bảng tính (dòng tiêu đề là 1), `column` là tiêu đề cột gây lỗi (null khi lỗi ở mức cả dòng). */
export interface GradeImportError {
  row: number;
  column: string | null;
  code: string;
  message: string;
}
/** Kết quả import điểm CSV: số ô đã nhập, số ô bỏ qua (để trống), lỗi theo từng ô/dòng và các cột bị bỏ qua ở mức tệp. */
export interface GradeImportResult {
  imported: number;
  skipped: number;
  errors: GradeImportError[];
  ignoredColumns: string[];
}
/** Trường định danh người học mà import dùng để khớp một dòng CSV với một user. */
export type GradeImportUserIdentifier = 'username' | 'email' | 'userId';
export const GRADE_IMPORT_USER_IDENTIFIERS: readonly GradeImportUserIdentifier[] = ['username', 'email', 'userId'];

/**
 * GradesModule facade (Moodle core_grades) — the highest-risk subsystem
 * (report §2#7/§2.1). All arithmetic lives in the PURE GradeCalculator;
 * this service owns persistence, capability checks, regrade orchestration,
 * history, freeze/override/lock state, and the outbox event chain
 * (grade_updated → completion/availability consumers).
 *
 * Wiring (registry/facade only, no cross-module repositories):
 *  - registers a grade-percentage provider into CoursesService so the
 *    Availability 'grade' leaf evaluates against REAL grades;
 *  - registers grade evaluators into CompletionService so
 *    completionUseGrade and course 'grade' criteria evaluate for real;
 *  - after a regrade it calls CompletionService.refreshGradeCompletion
 *    for every cm-linked item, keeping completion consistent.
 */
@Injectable()
/**
 * Nghiệp vụ sổ điểm (gradebook).
 * Đối chiếu Moodle: grade/lib.php (grade_item, grade_category) và lib/grade.
 * Điểm được lưu theo item; tổng category và điểm khoá học được tính lại (regrade) theo cây category
 * bằng grade-calculator mỗi khi điểm thay đổi; mọi thay đổi đều ghi lịch sử (grades history).
 */
export class GradesService implements OnModuleInit {
  constructor(
    private readonly repo: GradesRepository,
    private readonly courses: CoursesService,
    private readonly enrol: EnrolService,
    private readonly evaluator: PermissionEvaluator,
    private readonly completion: CompletionService,
    private readonly outbox: OutboxService,
    private readonly contexts: ContextsService,
    private readonly users: UsersService,
    @InjectQueue(GRADE_REGRADE_QUEUE) private readonly regradeQueue: Queue,
  ) {}

  /**
   * Khởi tạo: đăng ký grade provider cho availability/completion.
   */
  onModuleInit(): void {
    this.courses.registerGradeProvider(async (userId, courseId) => this.gradePercentagesForUser(userId, courseId));
    this.completion.registerGradeEvaluator(async (cmId, userId) => this.evaluateCmGrade(cmId, userId));
    this.completion.registerCourseGradeChecker(async (courseId, userId) => this.courseGradePassed(courseId, userId));
    this.enrol.registerRelatedDataProbe(async (courseId, userId) => {
      const grades = await this.repo.listGradesForCourse(courseId, userId);
      return grades.length > 0;
    });
  }

  private async requireCap(actorId: string, capability: string, courseId: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, capability, await this.courses.courseContextId(courseId));
  }

  /** Kiểm capability tại context hệ thống (dùng cho outcome/scale mức site). */
  private async requireSiteCap(actorId: string, capability: string): Promise<void> {
    const system = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, capability, system.id);
  }

  /** Các mức của một scale: chuỗi phân tách bằng dấu phẩy, mức thấp nhất trước (chỉ số điểm 1-based khớp thứ tự này). */
  private scaleValues(scale: ScaleRow): string[] {
    return scale.scale.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
  }

  /**
   * Lấy scale và kiểm tra phạm vi dùng được: outcome mức khoá học dùng scale của site hoặc của chính khoá học;
   * outcome mức site chỉ dùng scale mức site.
   */
  private async scaleForOutcome(scaleId: string, courseId: string | null): Promise<ScaleRow> {
    const scale = await this.repo.getScale(scaleId);
    if (!scale) throw new NotFoundException({ message: `Grade scale ${scaleId} not found`, code: 'grades.scale_not_found' });
    if (scale.courseId !== null && scale.courseId !== courseId) {
      throw new BadRequestException({ message: 'Scale belongs to another course', code: 'grades.outcome_scale_mismatch' });
    }
    return scale;
  }

  /** Lấy outcome; ném grades.outcome_not_found khi vắng. */
  async getOutcome(id: string): Promise<OutcomeRow> {
    const row = await this.repo.getOutcome(id);
    if (!row) throw new NotFoundException({ message: `Grade outcome ${id} not found`, code: 'grades.outcome_not_found' });
    return row;
  }

  /**
   * Kiểm tra outcome dùng được cho một khoá học (outcome của site hoặc của chính khoá học đó)
   * và trả về scale của outcome.
   */
  private async outcomeForCourse(outcomeId: string, courseId: string): Promise<{ outcome: OutcomeRow; scale: ScaleRow }> {
    const outcome = await this.getOutcome(outcomeId);
    if (outcome.courseId !== null && outcome.courseId !== courseId) {
      throw new BadRequestException({ message: 'Outcome belongs to another course', code: 'grades.outcome_course_mismatch' });
    }
    const scale = await this.repo.getScale(outcome.scaleId);
    if (!scale) throw new NotFoundException({ message: `Grade scale ${outcome.scaleId} not found`, code: 'grades.scale_not_found' });
    return { outcome, scale };
  }

  /**
   * Kiểm tra idNumber không trùng với item khác trong cùng khoá học (idNumber là khoá tham chiếu của công thức).
   */
  private async assertIdnumberFree(courseId: string, idNumber: string | null | undefined, selfItemId?: string): Promise<void> {
    if (!idNumber) return;
    const existing = await this.repo.findItemByIdnumber(courseId, idNumber);
    if (existing && existing.id !== selfItemId) {
      throw new BadRequestException({ message: `idNumber ${idNumber} is already used in this course`, code: 'grades.idnumber_taken' });
    }
  }

  /**
   * Kiểm tra công thức của item calculated NGAY khi lưu (không đợi tới lúc tính điểm):
   * cú pháp sai/hàm lạ → 400 grades.calculation_invalid / grades.calculation_unknown_function;
   * idNumber tham chiếu không tồn tại → 400 grades.calculation_unknown_idnumber;
   * tham chiếu vòng (trực tiếp hoặc qua chuỗi calculated khác) → 400 grades.calculation_cycle.
   */
  private async assertCalculationValid(
    courseId: string,
    calculation: string,
    self: { itemId?: string; idNumber?: string | null },
  ): Promise<void> {
    let ast;
    try {
      ast = parseGradeFormula(calculation);
    } catch (e) {
      if (e instanceof GradeFormulaError && e.reason === 'unknown_function') {
        throw new BadRequestException({ message: e.message, code: 'grades.calculation_unknown_function' });
      }
      throw new BadRequestException({ message: e instanceof Error ? e.message : 'Invalid grade calculation', code: 'grades.calculation_invalid' });
    }
    const refs = formulaReferences(ast);
    const items = await this.repo.listItems(courseId);
    const byIdnumber = new Map(items.filter((i) => i.idNumber).map((i) => [i.idNumber!, i]));
    for (const ref of refs) {
      if (!byIdnumber.has(ref) && ref !== self.idNumber) {
        throw new BadRequestException({ message: `Grade calculation references unknown idNumber [[${ref}]]`, code: 'grades.calculation_unknown_idnumber' });
      }
    }
    // Đồ thị tham chiếu giữa các calculated item của khoá học để phát hiện vòng.
    const graph = new Map<string, string[]>();
    for (const item of items) {
      if (!item.idNumber || !item.calculation) continue;
      if (item.id === self.itemId && item.idNumber !== self.idNumber) continue; // item tự đổi idNumber: cạnh cũ không còn
      try { graph.set(item.idNumber, formulaReferences(parseGradeFormula(item.calculation))); } catch { /* công thức cũ lỗi không tạo cạnh */ }
    }
    if (self.idNumber) graph.set(self.idNumber, refs);
    const starts = self.idNumber ? [self.idNumber, ...refs] : refs;
    for (const start of starts) {
      const cycle = findFormulaCycle(graph, start);
      if (cycle) {
        throw new BadRequestException({ message: `Grade calculation has a circular reference: ${cycle.join(' -> ')}`, code: 'grades.calculation_cycle' });
      }
    }
  }

  // --- structure -----------------------------------------------------------

  /** The course category (tree root) + its course-total item, created lazily like Moodle does. */
  /**
   * Đảm bảo khoá học có category điểm gốc.
   */
  async ensureCourseCategory(courseId: string): Promise<{ category: CategoryRow; courseItem: ItemRow }> {
    let root = await this.repo.rootCategory(courseId);
    if (!root) {
      root = await this.repo.insertCategory({ courseId: courseId, parent: null, fullName: '', aggregation: 'natural', depth: 1, path: '' });
      await this.repo.updateCategory(root.id, { path: `/${root.id}` });
      root = (await this.repo.getCategory(root.id))!;
    }
    let courseItem = await this.repo.findItemByTypeInstance(courseId, 'course', courseId);
    if (!courseItem) {
      courseItem = await this.repo.insertItem({
        courseId: courseId, categoryId: root.id, itemName: 'Course total', itemType: 'course',
        itemInstance: courseId, gradeMax: 100, gradeMin: 0,
      });
    }
    return { category: root, courseItem };
  }

  /**
   * Tạo category điểm con.
   */
  async createCategory(actorId: string, courseId: string, input: {
    fullName: string; parentId?: string; aggregation?: string; dropLow?: number; keepHigh?: number;
    aggregateOnlyGraded?: boolean; hidden?: boolean;
  }): Promise<CategoryRow> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:manage', courseId);
    const aggregation = (input.aggregation ?? 'natural') as AggregationStrategy;
    if (!AGGREGATIONS.includes(aggregation)) {
      throw new BadRequestException({ message: `Unknown aggregation ${input.aggregation}`, code: 'grades.bad_aggregation' });
    }
    const { category: root } = await this.ensureCourseCategory(courseId);
    const parent = input.parentId ? await this.getCategory(input.parentId) : root;
    if (parent.courseId !== courseId) throw new BadRequestException({ message: 'Parent category belongs to another course', code: 'grades.parent_course_mismatch' });
    const cat = await this.repo.insertCategory({
      courseId: courseId, parent: parent.id, fullName: input.fullName, aggregation,
      dropLow: input.dropLow ?? 0, keepHigh: input.keepHigh ?? 0,
      aggregateOnlyGraded: input.aggregateOnlyGraded ?? false, hidden: input.hidden ?? false,
      depth: parent.depth + 1, path: '',
    });
    await this.repo.updateCategory(cat.id, { path: `${parent.path}/${cat.id}` });
    // Every category owns a total item living in its PARENT category.
    await this.repo.insertItem({
      courseId: courseId, categoryId: parent.id, itemName: input.fullName, itemType: 'category',
      itemInstance: cat.id, gradeMax: 100, gradeMin: 0,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'grades', type: 'grade_category_created', payload: { courseId, categoryId: cat.id } });
    return (await this.repo.getCategory(cat.id))!;
  }

  /**
   * Lấy category; ném grades.category_not_found khi vắng.
   */
  async getCategory(id: string): Promise<CategoryRow> {
    const row = await this.repo.getCategory(id);
    if (!row) throw new NotFoundException({ message: `Grade category ${id} not found`, code: 'grades.category_not_found' });
    return row;
  }
  /**
   * Category của khoá học.
   */
  async listCategories(courseId: string): Promise<CategoryRow[]> {
    await this.ensureCourseCategory(courseId);
    return this.repo.listCategories(courseId);
  }

  /**
   * Cập nhật category (chiến lược tổng hợp, drop-lowest…).
   */
  async updateCategory(actorId: string, categoryId: string, input: {
    fullName?: string; aggregation?: string; dropLow?: number; keepHigh?: number;
    aggregateOnlyGraded?: boolean; hidden?: boolean;
  }): Promise<CategoryRow> {
    const cat = await this.getCategory(categoryId);
    await this.requireCap(actorId, 'grade:manage', cat.courseId);
    if (input.aggregation !== undefined && !AGGREGATIONS.includes(input.aggregation as AggregationStrategy)) {
      throw new BadRequestException({ message: `Unknown aggregation ${input.aggregation}`, code: 'grades.bad_aggregation' });
    }
    const aggregationChanged = input.aggregation !== undefined && input.aggregation !== cat.aggregation;
    const patch: Partial<CategoryRow> = {};
    if (input.fullName !== undefined) patch.fullName = input.fullName;
    if (input.aggregation !== undefined) patch.aggregation = input.aggregation;
    if (input.dropLow !== undefined) patch.dropLow = input.dropLow;
    if (input.keepHigh !== undefined) patch.keepHigh = input.keepHigh;
    if (input.aggregateOnlyGraded !== undefined) patch.aggregateOnlyGraded = input.aggregateOnlyGraded;
    if (input.hidden !== undefined) patch.hidden = input.hidden;
    if (Object.keys(patch).length) await this.repo.updateCategory(categoryId, patch);
    if (input.fullName !== undefined) {
      const totalItem = await this.repo.findItemByTypeInstance(cat.courseId, 'category', categoryId);
      if (totalItem) await this.repo.updateItem(totalItem.id, { itemName: input.fullName });
    }
    if (aggregationChanged || input.dropLow !== undefined || input.keepHigh !== undefined || input.aggregateOnlyGraded !== undefined) {
      // Aggregation semantics changed ⇒ bulk regrade in the worker + outbox chain.
      await this.regradeQueue.add('regrade', { courseId: cat.courseId, categoryId },
        { jobId: `grade-regrade-${cat.courseId}-${categoryId}-${Date.now()}`, attempts: 3 });
      await this.outbox.enqueueStandalone({
        aggregate: 'grades', type: 'grade_category_aggregation_changed',
        payload: { courseId: cat.courseId, categoryId, aggregation: input.aggregation ?? cat.aggregation },
      });
      await this.regradeCourse(cat.courseId);
    }
    return this.getCategory(categoryId);
  }

  /**
   * Xoá category (item con được nâng lên category cha).
   */
  async deleteCategory(actorId: string, categoryId: string): Promise<void> {
    const cat = await this.getCategory(categoryId);
    await this.requireCap(actorId, 'grade:manage', cat.courseId);
    const root = await this.repo.rootCategory(cat.courseId);
    if (root && root.id === categoryId) {
      throw new BadRequestException({ message: 'The course category cannot be deleted', code: 'grades.root_category' });
    }
    const children = (await this.repo.listCategories(cat.courseId)).filter((c) => c.parent === categoryId);
    const items = await this.repo.listItemsInCategory(categoryId);
    if (children.length || items.length) {
      throw new BadRequestException({ message: 'Category is not empty', code: 'grades.category_not_empty' });
    }
    const totalItem = await this.repo.findItemByTypeInstance(cat.courseId, 'category', categoryId);
    if (totalItem) await this.repo.deleteItem(totalItem.id);
    await this.repo.deleteCategory(categoryId);
    await this.regradeCourse(cat.courseId);
  }

  // --- items ---------------------------------------------------------------

  /**
   * Tạo grade item (manual hoặc gắn với hoạt động).
   */
  async createItem(actorId: string, courseId: string, input: {
    itemName: string; itemType?: string; categoryId?: string; cmId?: string;
    gradeMax?: number; gradeMin?: number; gradePass?: number; scaleId?: string;
    outcomeId?: string; idNumber?: string; calculation?: string;
    weightOverride?: boolean; weight?: number; extraCredit?: boolean;
    multiplicator?: number; plusFactor?: number; hidden?: boolean;
  }): Promise<ItemRow> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:manage', courseId);
    const itemType = input.itemType ?? 'manual';
    if (!['manual', 'mod', 'calculated'].includes(itemType)) {
      throw new BadRequestException({ message: `grade item type ${itemType} is created by the system`, code: 'grades.bad_itemtype' });
    }
    if (itemType === 'mod' && !input.cmId) {
      throw new BadRequestException({ message: 'A mod item requires cmId', code: 'grades.cm_required' });
    }
    if (itemType === 'calculated' && !input.calculation) {
      throw new BadRequestException({ message: 'A calculated item requires a calculation formula', code: 'grades.calculation_required' });
    }
    if (itemType !== 'calculated' && input.calculation) {
      throw new BadRequestException({ message: 'Only calculated items carry a calculation formula', code: 'grades.calculation_only_calculated' });
    }
    await this.assertIdnumberFree(courseId, input.idNumber ?? null);
    if (itemType === 'calculated') {
      await this.assertCalculationValid(courseId, input.calculation!, { idNumber: input.idNumber ?? null });
    }
    const { category: root } = await this.ensureCourseCategory(courseId);
    const category = input.categoryId ? await this.getCategory(input.categoryId) : root;
    if (category.courseId !== courseId) throw new BadRequestException({ message: 'Category belongs to another course', code: 'grades.category_course_mismatch' });
    let itemModule: string | null = null;
    if (itemType === 'mod') {
      const cm = await this.courses.getCm(input.cmId!);
      if (cm.course !== courseId) throw new BadRequestException({ message: 'cm belongs to another course', code: 'grades.cm_course_mismatch' });
      itemModule = cm.component;
      const existing = await this.repo.findItemForCm(courseId, input.cmId!);
      if (existing) throw new BadRequestException({ message: 'This activity already has a grade item', code: 'grades.item_exists_for_cm' });
    }
    // Outcome: item gắn outcome dùng scale của outcome, điểm lưu theo chỉ số 1..số mức của scale.
    let outcomeScale: ScaleRow | null = null;
    if (input.outcomeId) {
      const resolved = await this.outcomeForCourse(input.outcomeId, courseId);
      outcomeScale = resolved.scale;
      if (input.scaleId && input.scaleId !== outcomeScale.id) {
        throw new BadRequestException({ message: 'scaleId must match the outcome scale', code: 'grades.outcome_scale_mismatch' });
      }
    } else if (input.scaleId) {
      await this.scaleForOutcome(input.scaleId, courseId);
    }
    const gradeMin = outcomeScale ? 1 : (input.gradeMin ?? 0);
    const gradeMax = outcomeScale ? Math.max(1, this.scaleValues(outcomeScale).length) : (input.gradeMax ?? 100);
    if (gradeMax <= gradeMin && !outcomeScale) throw new BadRequestException({ message: 'gradeMax must be greater than gradeMin', code: 'grades.bad_range' });
    const item = await this.repo.insertItem({
      courseId: courseId, categoryId: category.id, itemName: input.itemName, itemType,
      itemModule, itemInstance: itemType === 'mod' ? input.cmId! : null,
      gradeType: (outcomeScale || input.scaleId) ? 'scale' : 'value',
      scaleId: outcomeScale ? outcomeScale.id : (input.scaleId ?? null),
      outcomeId: input.outcomeId ?? null,
      idNumber: input.idNumber ?? null,
      calculation: itemType === 'calculated' ? input.calculation! : null,
      gradeMax, gradeMin, gradePass: input.gradePass ?? 0,
      weightOverride: input.weightOverride ?? false, aggregationCoef: input.weight ?? 0,
      extraCredit: input.extraCredit ?? false, multiplicator: input.multiplicator ?? 1,
      plusFactor: input.plusFactor ?? 0, hidden: input.hidden ?? false,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'grades', type: 'grade_item_created', payload: { courseId, itemId: item.id } });
    return item;
  }

  /**
   * Lấy item; ném grades.item_not_found khi vắng.
   */
  async getItem(id: string): Promise<ItemRow> {
    const row = await this.repo.getItem(id);
    if (!row) throw new NotFoundException({ message: `Grade item ${id} not found`, code: 'grades.item_not_found' });
    return row;
  }
  /**
   * Item của khoá học.
   */
  async listItems(courseId: string): Promise<ItemRow[]> {
    await this.ensureCourseCategory(courseId);
    return this.repo.listItems(courseId);
  }

  /**
   * Cập nhật item.
   */
  async updateItem(actorId: string, itemId: string, input: {
    itemName?: string; categoryId?: string; gradeMax?: number; gradeMin?: number; gradePass?: number;
    scaleId?: string | null; outcomeId?: string | null; idNumber?: string | null; calculation?: string | null;
    weightOverride?: boolean; weight?: number; extraCredit?: boolean;
    multiplicator?: number; plusFactor?: number; hidden?: boolean; locked?: boolean;
  }): Promise<ItemRow> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'grade:manage', item.courseId);
    // Công thức/idNumber/outcome được kiểm tra lại đầy đủ mỗi lần sửa, giống lúc tạo.
    const nextIdnumber = input.idNumber !== undefined ? input.idNumber : item.idNumber;
    if (input.idNumber !== undefined) await this.assertIdnumberFree(item.courseId, input.idNumber, itemId);
    if (input.idNumber !== undefined && item.idNumber && input.idNumber !== item.idNumber) {
      const referenced = (await this.repo.listItems(item.courseId))
        .some((i) => i.id !== itemId && !!i.calculation && i.calculation.includes(`[[${item.idNumber}]]`));
      if (referenced) {
        throw new BadRequestException({ message: `idNumber ${item.idNumber} is referenced by a grade calculation`, code: 'grades.idnumber_in_use' });
      }
    }
    const nextCalculation = input.calculation !== undefined ? input.calculation : item.calculation;
    if (item.itemType === 'calculated') {
      if (!nextCalculation) {
        throw new BadRequestException({ message: 'A calculated item requires a calculation formula', code: 'grades.calculation_required' });
      }
      await this.assertCalculationValid(item.courseId, nextCalculation, { itemId, idNumber: nextIdnumber });
    } else if (input.calculation !== undefined && input.calculation !== null) {
      throw new BadRequestException({ message: 'Only calculated items carry a calculation formula', code: 'grades.calculation_only_calculated' });
    }
    const patch: Partial<ItemRow> = {};
    if (input.idNumber !== undefined) patch.idNumber = input.idNumber;
    if (input.calculation !== undefined && item.itemType === 'calculated') patch.calculation = input.calculation;
    if (input.outcomeId !== undefined) {
      if (input.outcomeId === null) {
        patch.outcomeId = null;
        // Gỡ outcome: scale của outcome cũng được gỡ theo, item quay về thang số thường.
        patch.scaleId = null;
        patch.gradeType = 'value';
      } else {
        const { scale } = await this.outcomeForCourse(input.outcomeId, item.courseId);
        patch.outcomeId = input.outcomeId;
        patch.scaleId = scale.id;
        patch.gradeType = 'scale';
        patch.gradeMin = 1;
        patch.gradeMax = Math.max(1, this.scaleValues(scale).length);
      }
    }
    if (input.scaleId !== undefined && input.outcomeId === undefined) {
      if (input.scaleId !== null) await this.scaleForOutcome(input.scaleId, item.courseId);
      patch.scaleId = input.scaleId;
      patch.gradeType = input.scaleId ? 'scale' : 'value';
    }
    if (input.itemName !== undefined) patch.itemName = input.itemName;
    if (input.categoryId !== undefined) {
      const cat = await this.getCategory(input.categoryId);
      if (cat.courseId !== item.courseId) throw new BadRequestException({ message: 'Category belongs to another course', code: 'grades.category_course_mismatch' });
      patch.categoryId = input.categoryId;
    }
    if (input.gradeMax !== undefined) patch.gradeMax = input.gradeMax;
    if (input.gradeMin !== undefined) patch.gradeMin = input.gradeMin;
    if (input.gradePass !== undefined) patch.gradePass = input.gradePass;
    if (input.weightOverride !== undefined) patch.weightOverride = input.weightOverride;
    if (input.weight !== undefined) patch.aggregationCoef = input.weight;
    if (input.extraCredit !== undefined) patch.extraCredit = input.extraCredit;
    if (input.multiplicator !== undefined) patch.multiplicator = input.multiplicator;
    if (input.plusFactor !== undefined) patch.plusFactor = input.plusFactor;
    if (input.hidden !== undefined) patch.hidden = input.hidden;
    if (input.locked !== undefined) patch.locked = input.locked;
    if (Object.keys(patch).length) await this.repo.updateItem(itemId, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'grades', type: 'grade_item_updated', payload: { courseId: item.courseId, itemId } });
    await this.regradeCourse(item.courseId);
    return this.getItem(itemId);
  }

  /**
   * Xoá item và điểm của nó.
   */
  async deleteItem(actorId: string, itemId: string): Promise<void> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'grade:manage', item.courseId);
    if (item.itemType === 'course' || item.itemType === 'category') {
      throw new BadRequestException({ message: 'Category/course total items are deleted with their category', code: 'grades.system_item' });
    }
    await this.repo.deleteItem(itemId);
    await this.regradeCourse(item.courseId);
  }

  // --- entering grades -------------------------------------------------------

  /** Leaf final grade: raw adjusted by multiplicator/offset; frozen once a non-identity formula produced it. */
  private leafFinal(item: ItemRow, raw: number | null, existing?: GradeRow): { finalGrade: number | null; frozen: boolean } {
    if (raw === null) return { finalGrade: null, frozen: false };
    if (existing?.frozen) return { finalGrade: existing.finalGrade, frozen: true };
    const adjusted = adjustedGrade({
      itemId: item.id, gradeMin: item.gradeMin, gradeMax: item.gradeMax, grade: raw,
      multiplicator: item.multiplicator, offset: item.plusFactor,
    });
    const hasFormula = item.multiplicator !== 1 || item.plusFactor !== 0;
    return { finalGrade: adjusted, frozen: hasFormula };
  }

  /**
   * Đặt điểm cho user tại item: kiểm capability grade:edit, ghi lịch sử, kích hoạt regrade.
   * `options` (GB-VN-2) cho luồng nghiệp vụ phía trên ghi đúng nguồn truy vết
   * vào history (`source`) và đặt cờ overridden khi giá trị vào sổ là quyết
   * định sửa tay của giáo viên (sửa-chốt ứng viên); không truyền options thì
   * hành vi giữ nguyên hệt bản gốc (source 'manual', overridden=false).
   */
  async setGrade(actorId: string, itemId: string, userId: string, input: { rawGrade?: number | null; feedback?: string }, options?: { source?: string; overridden?: boolean }): Promise<GradeRow> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'grade:edit', item.courseId);
    if (item.itemType === 'course' || item.itemType === 'category' || item.itemType === 'calculated') {
      throw new BadRequestException({ message: 'Category/course totals and calculated items are calculated, not entered', code: 'grades.calculated_item' });
    }
    if (item.locked) throw new ForbiddenException({ message: 'This grade item is locked', code: 'grades.item_locked' });
    if (item.outcomeId && input.rawGrade !== undefined && input.rawGrade !== null) {
      // Điểm outcome là chỉ số nguyên 1-based trong scale của outcome (scale item id trong Moodle) — ngoài khoảng là lỗi, không kẹp âm thầm.
      const { scale } = await this.outcomeForCourse(item.outcomeId, item.courseId);
      const count = this.scaleValues(scale).length;
      if (!Number.isInteger(input.rawGrade) || input.rawGrade < 1 || input.rawGrade > count) {
        throw new BadRequestException({ message: `Outcome grade must be an integer scale index between 1 and ${count}`, code: 'grades.outcome_grade_out_of_scale' });
      }
    }
    const existing = await this.repo.getGrade(itemId, userId);
    if (existing?.locked) throw new ForbiddenException({ message: 'This grade is locked', code: 'grades.grade_locked' });
    if (existing?.overridden && options?.overridden !== true) throw new ForbiddenException({ message: 'This grade is overridden; clear the override before entering a grade', code: 'grades.grade_overridden' });
    const raw = input.rawGrade ?? null;
    if (raw !== null && (raw < item.gradeMin - 1e-9 || raw > item.gradeMax + 1e-9)) {
      // Moodle clamps out-of-range raw grades into the item range on entry.
    }
    const clampedRaw = raw === null ? null : Math.min(item.gradeMax, Math.max(item.gradeMin, raw));
    const { finalGrade, frozen } = this.leafFinal(item, clampedRaw, existing);
    let saved!: GradeRow;
    await this.repo.dbHandle.transaction(async (tx) => {
      saved = await this.repo.upsertGrade({
        itemId: itemId, userId: userId, rawGrade: clampedRaw, rawGradeMin: item.gradeMin, rawGradeMax: item.gradeMax,
        finalGrade, feedback: input.feedback ?? existing?.feedback ?? null,
        hidden: existing?.hidden ?? false, locked: existing?.locked ?? false,
        overridden: options?.overridden ?? false, excluded: existing?.excluded ?? false, frozen,
        aggregationStatus: 'used', aggregationWeight: existing?.aggregationWeight ?? null,
      }, tx as never);
      await this.repo.insertHistory({
        action: existing ? 2 : 1, oldId: existing?.id ?? null, itemId: itemId, userId: userId,
        rawGrade: clampedRaw, finalGrade, overridden: options?.overridden ?? false, excluded: existing?.excluded ?? false,
        frozen, source: options?.source ?? 'manual', loggedUser: actorId,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'grades', type: 'grade_updated',
        payload: { courseId: item.courseId, itemId, userId, rawGrade: clampedRaw, finalGrade, actorId },
      });
    });
    await this.regradeUser(item.courseId, userId);
    await this.refreshCompletionForUser(item.courseId, userId);
    await this.auditGradeChangeAfterPublish(actorId, item, userId, !!existing);
    void saved;
    return (await this.repo.getGrade(itemId, userId))!;
  }

  /**
   * Grade item của một course module (item_type 'mod'), nếu hoạt động đã có.
   */
  async getItemForCm(courseId: string, cmId: string): Promise<ItemRow | undefined> {
    return this.repo.findItemForCm(courseId, cmId);
  }

  /**
   * Đường ghi điểm CỦA HOẠT ĐỘNG (Moodle grade_update từ mod, vd mod_quiz
   * ghi điểm bài sau khi chốt lượt làm): không qua capability của người
   * dùng vì chủ thể ghi là chính hoạt động — lượt làm tự chốt phía server
   * (hết giờ, đủ điểm) kể cả khi không có thao tác của giáo viên. Vẫn tôn
   * trọng các khoá của sổ điểm như setGrade: item bị khoá thì từ chối,
   * grade đã bị giáo viên ghi đè (overridden) hoặc khoá thì GIỮ NGUYÊN
   * (hoạt động không đè quyết định của giáo viên — trả về grade hiện có).
   * Ghi history với source là tên hoạt động để truy vết.
   */
  async recordActivityGrade(itemId: string, userId: string, rawGrade: number | null, source = 'mod/quiz'): Promise<GradeRow | undefined> {
    const item = await this.getItem(itemId);
    if (item.itemType === 'course' || item.itemType === 'category' || item.itemType === 'calculated') {
      throw new BadRequestException({ message: 'Category/course totals and calculated items are calculated, not entered', code: 'grades.calculated_item' });
    }
    if (item.locked) throw new ForbiddenException({ message: 'This grade item is locked', code: 'grades.item_locked' });
    const existing = await this.repo.getGrade(itemId, userId);
    if (existing?.locked || existing?.overridden) return existing;
    const raw = rawGrade === null ? null : Math.min(item.gradeMax, Math.max(item.gradeMin, rawGrade));
    const { finalGrade, frozen } = this.leafFinal(item, raw, existing);
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.upsertGrade({
        itemId: itemId, userId: userId, rawGrade: raw, rawGradeMin: item.gradeMin, rawGradeMax: item.gradeMax,
        finalGrade, feedback: existing?.feedback ?? null,
        hidden: existing?.hidden ?? false, locked: existing?.locked ?? false,
        overridden: false, excluded: existing?.excluded ?? false, frozen,
        aggregationStatus: 'used', aggregationWeight: existing?.aggregationWeight ?? null,
      }, tx as never);
      await this.repo.insertHistory({
        action: existing ? 2 : 1, oldId: existing?.id ?? null, itemId: itemId, userId: userId,
        rawGrade: raw, finalGrade, overridden: false, excluded: existing?.excluded ?? false,
        frozen, source, loggedUser: null,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'grades', type: 'grade_updated',
        payload: { courseId: item.courseId, itemId, userId, rawGrade: raw, finalGrade, source },
      });
    });
    await this.regradeUser(item.courseId, userId);
    await this.refreshCompletionForUser(item.courseId, userId);
    return this.repo.getGrade(itemId, userId);
  }

  /** Override / lock / exclude / hide / unfreeze a single grade, then regrade the user. */
  /**
   * Sửa một bản ghi điểm đã có (kèm lịch sử).
   */
  async updateGrade(actorId: string, gradeId: string, input: {
    overridden?: boolean; finalGrade?: number | null; locked?: boolean; excluded?: boolean;
    hidden?: boolean; frozen?: boolean; feedback?: string;
  }): Promise<GradeRow> {
    const grade = await this.repo.getGradeById(gradeId);
    if (!grade) throw new NotFoundException({ message: `Grade ${gradeId} not found`, code: 'grades.grade_not_found' });
    const item = await this.getItem(grade.itemId);
    await this.requireCap(actorId, 'grade:edit', item.courseId);
    const patch: Partial<GradeRow> = {};
    if (input.overridden !== undefined) patch.overridden = input.overridden;
    if (input.finalGrade !== undefined) patch.finalGrade = input.finalGrade;
    if (input.locked !== undefined) { patch.locked = input.locked; patch.lockTime = input.locked ? new Date() : null; }
    if (input.excluded !== undefined) patch.excluded = input.excluded;
    if (input.hidden !== undefined) patch.hidden = input.hidden;
    if (input.frozen !== undefined) patch.frozen = input.frozen;
    if (input.feedback !== undefined) patch.feedback = input.feedback;
    if (input.overridden === true && input.finalGrade === undefined && grade.finalGrade === null) {
      throw new BadRequestException({ message: 'Overriding requires a finalGrade', code: 'grades.override_needs_grade' });
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.updateGrade(gradeId, patch, tx as never);
      await this.repo.insertHistory({
        action: 2, oldId: gradeId, itemId: grade.itemId, userId: grade.userId,
        rawGrade: grade.rawGrade, finalGrade: patch.finalGrade ?? grade.finalGrade,
        overridden: patch.overridden ?? grade.overridden, excluded: patch.excluded ?? grade.excluded,
        frozen: patch.frozen ?? grade.frozen, source: 'override', loggedUser: actorId,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'grades', type: 'grade_updated',
        payload: { courseId: item.courseId, itemId: grade.itemId, userId: grade.userId, finalGrade: patch.finalGrade ?? grade.finalGrade, overridden: patch.overridden ?? grade.overridden, actorId },
      });
    });
    await this.regradeUser(item.courseId, grade.userId);
    await this.refreshCompletionForUser(item.courseId, grade.userId);
    await this.auditGradeChangeAfterPublish(actorId, item, grade.userId, true);
    return (await this.repo.getGradeById(gradeId))!;
  }

  // --- regrade ---------------------------------------------------------------

  /**
   * Recompute every category total (bottom-up) and the course total for one
   * user. Overridden totals are never recomputed; frozen totals keep their
   * frozen final grade. Category/course items get their gradeMax synced to
   * the calculator's structural max for natural/sum.
   */
  /**
   * Tính lại tổng cho một user trong khoá học.
   */
  async regradeUser(courseId: string, userId: string): Promise<void> {
    const categories = await this.repo.listCategories(courseId);
    const items = await this.repo.listItems(courseId);
    const grades = await this.repo.listGradesForCourse(courseId, userId);
    const gradeByItem = new Map<string, GradeRow>(grades.map((g) => [g.itemId, g]));
    const finalByItem = new Map<string, number | null>(grades.map((g) => [g.itemId, g.finalGrade]));

    // Calculated items: đánh giá công thức theo idNumber trước khi tổng hợp category.
    // Tham chiếu tới item thường dùng finalGrade đã lưu; tham chiếu tới calculated khác được
    // giải quyết đệ quy (vòng đã bị chặn lúc lưu công thức, ở đây chỉ là phòng thủ → null).
    // Kết quả được kẹp vào [gradeMin, gradeMax] của chính calculated item và lưu như điểm của nó.
    const byIdnumber = new Map(items.filter((i) => i.idNumber).map((i) => [i.idNumber!, i]));
    const computedCalc = new Map<string, number | null>();
    const resolving = new Set<string>();
    const resolveFinal = (it: ItemRow): number | null => {
      if (it.itemType !== 'calculated') return finalByItem.get(it.id) ?? null;
      if (computedCalc.has(it.id)) return computedCalc.get(it.id)!;
      if (resolving.has(it.id)) return null;
      resolving.add(it.id);
      let value: number | null = null;
      const existingCalc = gradeByItem.get(it.id);
      if (existingCalc?.overridden) {
        value = existingCalc.finalGrade;
      } else if (it.calculation) {
        try {
          value = evaluateGradeFormula(parseGradeFormula(it.calculation), (idNumber) => {
            const ref = byIdnumber.get(idNumber);
            if (!ref || ref.id === it.id) return null;
            if (gradeByItem.get(ref.id)?.excluded) return null;
            return resolveFinal(ref);
          });
        } catch { value = null; }
        if (value !== null) value = Math.min(it.gradeMax, Math.max(it.gradeMin, value));
      }
      resolving.delete(it.id);
      computedCalc.set(it.id, value);
      return value;
    };
    for (const calcItem of items.filter((i) => i.itemType === 'calculated')) {
      const existingCalc = gradeByItem.get(calcItem.id);
      if (existingCalc?.overridden) { finalByItem.set(calcItem.id, existingCalc.finalGrade); continue; }
      const value = resolveFinal(calcItem);
      finalByItem.set(calcItem.id, value);
      const changed = !existingCalc || existingCalc.finalGrade !== value;
      const savedCalc = await this.repo.upsertGrade({
        itemId: calcItem.id, userId: userId, rawGrade: existingCalc?.rawGrade ?? null,
        rawGradeMin: calcItem.gradeMin, rawGradeMax: calcItem.gradeMax,
        finalGrade: value, hidden: existingCalc?.hidden ?? false, locked: existingCalc?.locked ?? false,
        overridden: false, excluded: existingCalc?.excluded ?? false, frozen: existingCalc?.frozen ?? false,
        feedback: existingCalc?.feedback ?? null, aggregationStatus: value === null ? 'novalue' : 'used',
        aggregationWeight: existingCalc?.aggregationWeight ?? null,
      });
      gradeByItem.set(calcItem.id, savedCalc);
      if (changed && value !== null) {
        await this.repo.insertHistory({
          action: existingCalc ? 2 : 1, oldId: existingCalc?.id ?? null, itemId: calcItem.id, userId: userId,
          rawGrade: null, finalGrade: value, overridden: false,
          excluded: existingCalc?.excluded ?? false, frozen: existingCalc?.frozen ?? false, source: 'calculation',
        });
        await this.outbox.enqueueStandalone({
          aggregate: 'grades', type: 'grade_updated',
          payload: { courseId, itemId: calcItem.id, userId, finalGrade: value, calculated: true },
        });
      }
    }

    const byDepthDesc = [...categories].sort((a, b) => b.depth - a.depth);
    for (const cat of byDepthDesc) {
      const totalItem = items.find((i) => (i.itemType === 'category' && i.itemInstance === cat.id)
        || (i.itemType === 'course' && cat.parent === null));
      if (!totalItem) continue;
      const existing = gradeByItem.get(totalItem.id);
      if (existing?.overridden) { finalByItem.set(totalItem.id, existing.finalGrade); continue; }
      if (existing?.frozen && existing.finalGrade !== null) { finalByItem.set(totalItem.id, existing.finalGrade); continue; }

      // Item thang định tính (gradeType='scale', gồm cả item gắn outcome) KHÔNG tham gia
      // tổng hợp số của category — cùng luật đã ghi cho scale; chúng chỉ hiển thị trong sổ điểm.
      const childItems = items.filter((i) => i.categoryId === cat.id && i.id !== totalItem.id
        && !i.outcomeId && i.gradeType !== 'scale');
      const calcItems: CalcItemInput[] = childItems.map((ci) => {
        const g = gradeByItem.get(ci.id);
        const isSubTotal = ci.itemType === 'category' || ci.itemType === 'course';
        const isCalculated = ci.itemType === 'calculated';
        return {
          itemId: ci.id, gradeMin: ci.gradeMin, gradeMax: ci.gradeMax,
          grade: finalByItem.get(ci.id) ?? null,
          excluded: g?.excluded ?? false, extraCredit: ci.extraCredit,
          weightOverride: ci.weightOverride, weight: ci.aggregationCoef,
          aggregationCoef: ci.aggregationCoef,
          // Multiplicator/offset apply to leaf grades at entry time, not to totals or calculated items.
          multiplicator: (isSubTotal || isCalculated) ? 1 : ci.multiplicator, offset: (isSubTotal || isCalculated) ? 0 : ci.plusFactor,
          frozen: g?.frozen ?? false,
        };
      });
      const result = calculateCategory({
        aggregation: cat.aggregation as AggregationStrategy,
        gradeMin: totalItem.gradeMin, gradeMax: totalItem.gradeMax,
        dropLow: cat.dropLow, keepHigh: cat.keepHigh, aggregateOnlyGraded: cat.aggregateOnlyGraded,
        items: calcItems,
      });
      if ((cat.aggregation === 'natural' || cat.aggregation === 'sum') && Math.abs(result.gradeMax - totalItem.gradeMax) > 1e-9) {
        await this.repo.updateItem(totalItem.id, { gradeMax: result.gradeMax });
        totalItem.gradeMax = result.gradeMax;
      }
      const changed = !existing || existing.finalGrade !== result.finalGrade;
      const saved = await this.repo.upsertGrade({
        itemId: totalItem.id, userId: userId, rawGrade: null,
        rawGradeMin: totalItem.gradeMin, rawGradeMax: totalItem.gradeMax,
        finalGrade: result.finalGrade, hidden: existing?.hidden ?? false, locked: existing?.locked ?? false,
        overridden: false, excluded: existing?.excluded ?? false, frozen: existing?.frozen ?? false,
        feedback: existing?.feedback ?? null, aggregationStatus: result.finalGrade === null ? 'novalue' : 'used',
        aggregationWeight: existing?.aggregationWeight ?? null,
      });
      gradeByItem.set(totalItem.id, saved);
      finalByItem.set(totalItem.id, result.finalGrade);
      // Record effective natural weights on the child grade rows.
      for (const [itemIdStr, w] of Object.entries(result.weights)) {
        const childGrade = gradeByItem.get(itemIdStr);
        if (childGrade && childGrade.aggregationWeight !== w) {
          await this.repo.updateGrade(childGrade.id, { aggregationWeight: w });
        }
      }
      if (changed && result.finalGrade !== null) {
        await this.repo.insertHistory({
          action: existing ? 2 : 1, oldId: existing?.id ?? null, itemId: totalItem.id, userId: userId,
          rawGrade: null, finalGrade: result.finalGrade, overridden: false,
          excluded: existing?.excluded ?? false, frozen: existing?.frozen ?? false, source: 'regrade',
        });
        await this.outbox.enqueueStandalone({
          aggregate: 'grades', type: 'grade_updated',
          payload: { courseId, itemId: totalItem.id, userId, finalGrade: result.finalGrade, calculated: true },
        });
      }
    }
  }

  /**
   * Tính lại tổng cho toàn bộ khoá học.
   */
  async regradeCourse(courseId: string): Promise<{ courseId: string; users: number }> {
    const userIds = new Set<string>();
    for (const g of await this.repo.listGradesForCourse(courseId)) userIds.add(g.userId);
    for (const ue of await this.enrol.listEnrolmentsForCourse(courseId)) userIds.add(ue.userId);
    for (const userId of userIds) await this.regradeUser(courseId, userId);
    for (const userId of userIds) await this.refreshCompletionForUser(courseId, userId);
    await this.outbox.enqueueStandalone({ aggregate: 'grades', type: 'course_grade_recalculated', payload: { courseId, users: userIds.size } });
    return { courseId, users: userIds.size };
  }

  /**
   * Đưa yêu cầu regrade vào hàng đợi (worker) khi thay đổi lớn.
   */
  async triggerRegrade(actorId: string, courseId: string): Promise<{ courseId: string; users: number }> {
    await this.requireCap(actorId, 'grade:manage', courseId);
    return this.regradeCourse(courseId);
  }

  // --- cross-module evaluators ------------------------------------------------

  /** Completion hook: state for a cm with completionUseGrade. Null = no grade yet. */
  /**
   * Điểm phần trăm của user tại cm — đầu vào cho availability/completion theo điểm.
   */
  async evaluateCmGrade(cmId: string, userId: string): Promise<number | null> {
    const cm = await this.courses.getCm(cmId).catch(() => undefined);
    if (!cm) return null;
    const item = await this.repo.findItemForCm(cm.course, cmId);
    if (!item) return null;
    const grade = await this.repo.getGrade(item.id, userId);
    if (!grade || grade.finalGrade === null) return null;
    if (item.gradePass > 0) return grade.finalGrade >= item.gradePass ? COMPLETION_PASS : COMPLETION_FAIL;
    return COMPLETION_DONE;
  }

  /** Course-completion 'grade' criterion: the course total meets the course item's gradePass. */
  /**
   * Điểm tổng khoá học của user có đạt ngưỡng qua môn hay không.
   */
  async courseGradePassed(courseId: string, userId: string): Promise<boolean> {
    const { courseItem } = await this.ensureCourseCategory(courseId);
    const grade = await this.repo.getGrade(courseItem.id, userId);
    if (!grade || grade.finalGrade === null) return false;
    return courseItem.gradePass > 0 ? grade.finalGrade >= courseItem.gradePass : true;
  }

  /** Availability 'grade' leaf values: percentages (0-100) keyed by grade-item id AND by cm id. */
  /**
   * Điểm phần trăm theo từng item của user (cho availability).
   */
  async gradePercentagesForUser(userId: string, courseId: string): Promise<Record<string, number>> {
    const items = await this.repo.listItems(courseId);
    const grades = await this.repo.listGradesForCourse(courseId, userId);
    const out: Record<string, number> = {};
    for (const item of items) {
      const g = grades.find((x) => x.itemId === item.id);
      if (!g || g.finalGrade === null || item.gradeMax <= item.gradeMin) continue;
      if (item.outcomeId || item.gradeType === 'scale') continue; // điểm định tính không có phần trăm số
      const pct = ((g.finalGrade - item.gradeMin) / (item.gradeMax - item.gradeMin)) * 100;
      out[String(item.id)] = pct;
      if (item.itemType === 'mod') out[String(item.itemInstance)] = pct;
      if (item.itemType === 'course') out['course'] = pct;
    }
    return out;
  }

  /** Raw final grade of an item for a user (facade for reports/other modules). */
  /**
   * Điểm cuối cùng của user tại item (sau tính toán).
   */
  async getFinalGrade(itemId: string, userId: string): Promise<number | null> {
    const g = await this.repo.getGrade(itemId, userId);
    return g?.finalGrade ?? null;
  }
  /**
   * Một dòng điểm đầy đủ (item + grade + letter).
   */
  async getGradeRow(itemId: string, userId: string): Promise<GradeRow | undefined> {
    return this.repo.getGrade(itemId, userId);
  }
  /**
   * Lịch sử thay đổi điểm.
   */
  async listHistory(itemId: string, userId: string) {
    return this.repo.listHistory(itemId, userId);
  }

  private async refreshCompletionForUser(courseId: string, userId: string): Promise<void> {
    const cms = await this.courses.listCms(courseId);
    for (const cm of cms) {
      if (cm.completionUseGrade) await this.completion.refreshGradeCompletion(cm.id, userId);
    }
    // Course-level criteria may include a 'grade' criterion on the course total.
    await this.completion.reaggregateCourseCompletion(userId, courseId);
  }

  // --- letters, scales, reports ------------------------------------------------

  /**
   * Đặt bảng grade letters của khoá học.
   */
  async setLetters(actorId: string, courseId: string, letters: { letter: string; lowerBoundary: number }[]): Promise<LetterRow[]> {
    await this.requireCap(actorId, 'grade:manage', courseId);
    const contextId = await this.courses.courseContextId(courseId);
    await this.repo.replaceLetters(contextId, letters);
    return this.repo.listLetters(contextId);
  }
  /**
   * Bảng grade letters hiện tại.
   */
  async getLetters(courseId: string): Promise<LetterRow[]> {
    const contextId = await this.courses.courseContextId(courseId);
    return this.repo.listLetters(contextId);
  }

  /**
   * Tạo scale điểm tuỳ biến.
   */
  async createScale(actorId: string, courseId: string, input: { name: string; scale: string; description?: string }): Promise<ScaleRow> {
    await this.requireCap(actorId, 'grade:manage', courseId);
    return this.repo.insertScale({ courseId: courseId, name: input.name, scale: input.scale, description: input.description ?? '' });
  }
  /**
   * Tạo scale mức site (courseId = null) — dùng được cho outcome mức site và mọi khoá học.
   */
  async createSiteScale(actorId: string, input: { name: string; scale: string; description?: string }): Promise<ScaleRow> {
    await this.requireSiteCap(actorId, 'grade:manage');
    return this.repo.insertScale({ courseId: null, name: input.name, scale: input.scale, description: input.description ?? '' });
  }
  /**
   * Liệt kê scales.
   */
  async listScales(courseId: string): Promise<ScaleRow[]> { return this.repo.listScales(courseId); }

  // --- outcomes --------------------------------------------------------------

  /**
   * Tạo grade outcome: mức khoá học khi có courseId, mức site khi courseId = null.
   * Capability dùng chung của grades: grade:manage tại context khoá học (hoặc hệ thống với outcome site).
   */
  async createOutcome(actorId: string, courseId: string | null, input: { name: string; scaleId: string; description?: string }): Promise<OutcomeRow> {
    if (courseId !== null) {
      await this.courses.getCourse(courseId);
      await this.requireCap(actorId, 'grade:manage', courseId);
    } else {
      await this.requireSiteCap(actorId, 'grade:manage');
    }
    await this.scaleForOutcome(input.scaleId, courseId);
    const row = await this.repo.insertOutcome({
      courseId: courseId, scaleId: input.scaleId, name: input.name, description: input.description ?? '',
    });
    await this.outbox.enqueueStandalone({ aggregate: 'grades', type: 'grade_outcome_created', payload: { courseId, outcomeId: row.id } });
    return row;
  }

  /**
   * Liệt kê outcome: của một khoá học (kèm outcome site) hoặc chỉ outcome site khi không truyền courseId.
   */
  async listOutcomes(courseId?: string): Promise<OutcomeRow[]> {
    return this.repo.listOutcomes(courseId);
  }

  /** Kiểm capability phù hợp phạm vi của outcome (site → context hệ thống, khoá học → context khoá học). */
  private async requireOutcomeCap(actorId: string, outcome: OutcomeRow): Promise<void> {
    if (outcome.courseId === null) await this.requireSiteCap(actorId, 'grade:manage');
    else await this.requireCap(actorId, 'grade:manage', outcome.courseId);
  }

  /**
   * Cập nhật grade outcome; đổi scale thì các item đang gắn outcome được đồng bộ scaleId/gradeMax theo scale mới và tính lại.
   */
  async updateOutcome(actorId: string, outcomeId: string, input: { name?: string; scaleId?: string; description?: string }): Promise<OutcomeRow> {
    const outcome = await this.getOutcome(outcomeId);
    await this.requireOutcomeCap(actorId, outcome);
    const patch: Partial<OutcomeRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.scaleId !== undefined) {
      await this.scaleForOutcome(input.scaleId, outcome.courseId);
      patch.scaleId = input.scaleId;
    }
    if (Object.keys(patch).length) await this.repo.updateOutcome(outcomeId, patch);
    if (input.scaleId !== undefined && input.scaleId !== outcome.scaleId) {
      // Đổi scale của outcome ⇒ đồng bộ scaleId và khoảng điểm (1..số mức) cho mọi item đang gắn outcome này.
      const scale = (await this.repo.getScale(input.scaleId))!;
      const count = this.scaleValues(scale).length;
      for (const item of await this.repo.listItemsForOutcome(outcomeId)) {
        await this.repo.updateItem(item.id, { scaleId: input.scaleId, gradeMin: 1, gradeMax: Math.max(1, count) });
      }
    }
    return this.getOutcome(outcomeId);
  }

  /**
   * Xoá grade outcome; item đang gắn outcome được gỡ liên kết (khoá ngoại set null) nhưng giữ nguyên điểm đã lưu.
   */
  async deleteOutcome(actorId: string, outcomeId: string): Promise<void> {
    const outcome = await this.getOutcome(outcomeId);
    await this.requireOutcomeCap(actorId, outcome);
    await this.repo.deleteOutcome(outcomeId);
  }

  /**
   * Giá trị scale hiển thị cho một điểm: với item gắn outcome (hoặc item scale thường),
   * finalGrade là chỉ số 1-based và scaleValue là nhãn mức tương ứng trong scale.
   */
  private scaleValueFor(
    grade: GradeRow, item: ItemRow,
    outcomesById: Map<string, OutcomeRow>, scalesById: Map<string, ScaleRow>,
  ): { scaleValue: string | null; outcomeName: string | null } {
    if (grade.finalGrade === null) return { scaleValue: null, outcomeName: null };
    const outcome = item.outcomeId ? outcomesById.get(item.outcomeId) : undefined;
    const scaleId = outcome?.scaleId ?? item.scaleId;
    if (!scaleId) return { scaleValue: null, outcomeName: outcome?.name ?? null };
    const scale = scalesById.get(scaleId);
    if (!scale) return { scaleValue: null, outcomeName: outcome?.name ?? null };
    const values = this.scaleValues(scale);
    const idx = Math.round(grade.finalGrade) - 1;
    return { scaleValue: idx >= 0 && idx < values.length ? values[idx]! : null, outcomeName: outcome?.name ?? null };
  }

  private withLetter(
    grade: GradeRow | undefined, item: ItemRow, letters: LetterRow[],
    outcomesById: Map<string, OutcomeRow> = new Map(), scalesById: Map<string, ScaleRow> = new Map(),
  ): (GradeRow & { letter: string | null; scaleValue: string | null; outcomeName: string | null }) | null {
    if (!grade) return null;
    const { scaleValue, outcomeName } = this.scaleValueFor(grade, item, outcomesById, scalesById);
    return {
      ...grade, scaleValue, outcomeName,
      letter: grade.finalGrade === null ? null : letterForGrade(grade.finalGrade, item.gradeMin, item.gradeMax, letters),
    };
  }

  /**
   * Gradebook view for one target user. The viewer sees their OWN book; other
   * users' books require grade:viewall at the course context. Hidden
   * items/categories (and hidden grades) are filtered for viewers without
   * viewall — hiding is enforced here, at the API, not just in the UI.
   */
  /**
   * Sổ điểm của một user: cây category/item kèm điểm và tổng.
   */
  async getGradebook(viewerId: string, courseId: string, targetUserId: string): Promise<{
    courseId: string; userId: string; categories: GradebookCategoryView[]; courseTotal: GradebookItemView | null;
  }> {
    const canViewAll = viewerId === targetUserId
      ? await this.evaluator.hasCapability(viewerId, 'grade:viewall', await this.courses.courseContextId(courseId)).catch(() => false)
      : false;
    if (viewerId !== targetUserId) {
      await this.requireCap(viewerId, 'grade:viewall', courseId);
    } else if (!canViewAll) {
      await this.courses.assertCourseAccess(viewerId, courseId);
    }
    const seeHidden = viewerId !== targetUserId || canViewAll
      ? (viewerId === targetUserId ? canViewAll : true) : false;
    // Người có grade:viewall (giáo viên) xem đủ kể cả điểm chưa công bố; học
    // sinh xem chính mình thì bị cổng công bố của PH-0 (issue #116).
    const maskUnpublished = viewerId === targetUserId && !canViewAll;
    return this.buildGradebookView(courseId, targetUserId, { seeHidden, maskUnpublished });
  }

  /**
   * Sổ điểm của một học sinh DÀNH CHO PHỤ HUYNH có liên kết giám hộ (PH-0,
   * issue #116): quyền đọc suy từ liên kết (GuardiansService đã kiểm tra
   * trước khi gọi) — không yêu cầu ghi danh, ẩn như phía học sinh tự xem
   * (không thấy item/điểm ẩn, điểm của item manual chưa công bố bị che).
   */
  async getGradebookForGuardian(courseId: string, targetUserId: string): Promise<{
    courseId: string; userId: string; categories: GradebookCategoryView[]; courseTotal: GradebookItemView | null;
  }> {
    return this.buildGradebookView(courseId, targetUserId, { seeHidden: false, maskUnpublished: true });
  }

  /** Dựng cây sổ điểm dùng chung: seeHidden quyết định lộ item/điểm ẩn; maskUnpublished áp cổng công bố PH-0. */
  private async buildGradebookView(courseId: string, targetUserId: string, opts: { seeHidden: boolean; maskUnpublished: boolean }): Promise<{
    courseId: string; userId: string; categories: GradebookCategoryView[]; courseTotal: GradebookItemView | null;
  }> {
    const { seeHidden, maskUnpublished } = opts;
    const { category: root } = await this.ensureCourseCategory(courseId);
    const categories = await this.repo.listCategories(courseId);
    const items = await this.repo.listItems(courseId);
    const grades = await this.repo.listGradesForCourse(courseId, targetUserId);
    const letters = await this.getLetters(courseId);
    const gradeByItem = new Map(grades.map((g) => [g.itemId, g]));
    const outcomesById = new Map((await this.repo.listOutcomes(courseId)).map((o) => [o.id, o]));
    const scalesById = new Map((await this.repo.listScales(courseId)).map((s) => [s.id, s]));
    // Item có thể gắn outcome/scale mức site không nằm trong listScales(courseId) khi courseId là của khoá khác? listScales đã gồm site + khoá này.
    for (const item of items) {
      if (item.scaleId && !scalesById.has(item.scaleId)) {
        const s = await this.repo.getScale(item.scaleId);
        if (s) scalesById.set(s.id, s);
      }
    }
    const publicationByItem = await this.publicationStatesForCourse(courseId, items);

    const viewForItem = (item: ItemRow, maskGrade: boolean): GradebookItemView => {
      const g = gradeByItem.get(item.id);
      const visibleGrade = g && (seeHidden || !g.hidden) && !maskGrade ? g : undefined;
      return {
        item,
        grade: this.withLetter(visibleGrade, item, letters, outcomesById, scalesById),
        publication: publicationByItem.get(item.id) ?? { policy: 'auto', published: true },
      };
    };
    const build = (cat: CategoryRow): { view: GradebookCategoryView; subtreeHasUnpublishedGrade: boolean } => {
      const totalItem = items.find((i) => (i.itemType === 'category' && i.itemInstance === cat.id)
        || (i.itemType === 'course' && cat.parent === null));
      const leafItems = items.filter((i) => i.categoryId === cat.id && i.id !== totalItem?.id
        && (seeHidden || !i.hidden));
      const childResults = categories.filter((c) => c.parent === cat.id && (seeHidden || !c.hidden)).map(build);
      // Điểm tổng của category/khoá bị che khi trong phạm vi của nó còn điểm
      // của item manual chưa công bố — không để tổng lộ phần chưa công bố.
      const leafHasUnpublished = leafItems.some((i) => {
        const pub = publicationByItem.get(i.id);
        return maskUnpublished && pub && !pub.published && gradeByItem.get(i.id);
      });
      const subtreeHasUnpublishedGrade = leafHasUnpublished
        || childResults.some((r) => r.subtreeHasUnpublishedGrade);
      const totalMasked = maskUnpublished
        && (subtreeHasUnpublishedGrade || (totalItem ? !(publicationByItem.get(totalItem.id)?.published ?? true) : false));
      return {
        subtreeHasUnpublishedGrade,
        view: {
          category: cat,
          total: totalItem ? viewForItem(totalItem, totalMasked) : null,
          items: leafItems.map((i) => viewForItem(i, maskUnpublished && !(publicationByItem.get(i.id)?.published ?? true))),
          children: childResults.map((r) => r.view),
        },
      };
    };
    const { view: tree } = build(root);
    return { courseId, userId: targetUserId, categories: [tree], courseTotal: tree.total };
  }

  // --- Công bố điểm (PH-0, issue #116) --------------------------------------

  /**
   * Trạng thái công bố hiệu lực của mọi item trong một khoá: item 'auto' luôn
   * coi là đã công bố (điểm hiện ngay khi chấm); item 'manual' chỉ hiện khi
   * vết mới nhất trong grade_publications (scope item) là 'publish'.
   */
  async publicationStatesForCourse(courseId: string, items?: ItemRow[]): Promise<Map<string, GradePublicationState>> {
    const rows = items ?? await this.repo.listItems(courseId);
    const publications = await this.repo.listPublications(courseId);
    const latestByItem = new Map<string, string>();
    for (const p of publications) {
      if (p.scope === 'item' && p.itemId) latestByItem.set(p.itemId, p.action);
    }
    const states = new Map<string, GradePublicationState>();
    for (const item of rows) {
      const policy = item.postingPolicy === 'manual' ? 'manual' : 'auto';
      states.set(item.id, {
        policy,
        published: policy === 'auto' ? true : latestByItem.get(item.id) === 'publish',
      });
    }
    return states;
  }

  /** Trạng thái công bố hiệu lực của một item. */
  async itemPublicationState(item: ItemRow): Promise<GradePublicationState> {
    const states = await this.publicationStatesForCourse(item.courseId, [item]);
    return states.get(item.id) ?? { policy: 'auto', published: true };
  }

  /** Đặt chính sách công bố cho một item (grade:publish tại context khoá). */
  async setItemPostingPolicy(actorId: string, itemId: string, policy: 'auto' | 'manual'): Promise<ItemRow> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'grade:publish', item.courseId);
    await this.repo.updateItem(itemId, { postingPolicy: policy });
    await this.outbox.enqueueStandalone({
      aggregate: 'grades', type: 'grade_posting_policy_changed',
      payload: { actorId, courseId: item.courseId, itemId, objectId: itemId, policy },
    });
    return (await this.repo.getItem(itemId))!;
  }

  /** Công bố / rút công bố điểm của một item cho mọi học sinh (grade:publish tại context khoá); ghi vết vào grade_publications + event_log qua outbox. */
  async setItemPublication(actorId: string, itemId: string, action: 'publish' | 'unpublish', note?: string): Promise<GradePublicationState> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'grade:publish', item.courseId);
    await this.repo.insertPublication({
      courseId: item.courseId, scope: 'item', itemId, bookId: null, userId: null,
      action, actorId, note: note ?? null,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'grades', type: action === 'publish' ? 'grade_item_published' : 'grade_item_unpublished',
      payload: { actorId, courseId: item.courseId, itemId, objectId: itemId, note: note ?? null },
    });
    return this.itemPublicationState(await this.getItem(itemId));
  }

  /**
   * Audit sửa điểm sau công bố (research PH mục 5.2.7): khi giáo viên sửa
   * một điểm ĐÃ TỒN TẠI trên item đang ở trạng thái công bố hiệu lực, phát
   * thêm sự kiện grade_changed_after_publish vào event_log qua outbox —
   * điểm đã tới tay học sinh/phụ huynh mà đổi thì phải có vết riêng.
   */
  private async auditGradeChangeAfterPublish(actorId: string, item: ItemRow, userId: string, hadExistingGrade: boolean): Promise<void> {
    if (!hadExistingGrade) return;
    const state = await this.itemPublicationState(item).catch(() => null);
    if (!state?.published) return;
    await this.outbox.enqueueStandalone({
      aggregate: 'grades', type: 'grade_changed_after_publish',
      payload: { actorId, courseId: item.courseId, itemId: item.id, userId, objectId: item.id },
    }).catch(() => undefined);
  }

  /** Teacher report: one row per enrolled user with the course total + letter. */
  /**
   * Báo cáo điểm toàn lớp cho giáo viên.
   */
  async getReport(viewerId: string, courseId: string): Promise<{
    courseId: string; rows: {
      userId: string; finalGrade: number | null; letter: string | null;
      outcomes: { itemId: string; outcomeId: string; outcomeName: string; scaleValue: string | null; finalGrade: number | null }[];
    }[];
  }> {
    await this.requireCap(viewerId, 'grade:viewall', courseId);
    const { courseItem } = await this.ensureCourseCategory(courseId);
    const letters = await this.getLetters(courseId);
    const items = await this.repo.listItems(courseId);
    const outcomeItems = items.filter((i) => i.outcomeId);
    const outcomesById = new Map((await this.repo.listOutcomes(courseId)).map((o) => [o.id, o]));
    const scalesById = new Map((await this.repo.listScales(courseId)).map((s) => [s.id, s]));
    const enrolments = await this.enrol.listEnrolmentsForCourse(courseId);
    const userIds = [...new Set(enrolments.map((e) => e.userId))];
    const rows = [];
    for (const userId of userIds) {
      const g = await this.repo.getGrade(courseItem.id, userId);
      const outcomes = [];
      for (const item of outcomeItems) {
        const og = await this.repo.getGrade(item.id, userId);
        const outcome = outcomesById.get(item.outcomeId!);
        const view = og ? this.scaleValueFor(og, item, outcomesById, scalesById) : { scaleValue: null, outcomeName: null };
        outcomes.push({
          itemId: item.id, outcomeId: item.outcomeId!, outcomeName: outcome?.name ?? view.outcomeName ?? '',
          scaleValue: view.scaleValue, finalGrade: og?.finalGrade ?? null,
        });
      }
      rows.push({
        userId,
        finalGrade: g?.finalGrade ?? null,
        letter: g?.finalGrade !== null && g?.finalGrade !== undefined
          ? letterForGrade(g.finalGrade, courseItem.gradeMin, courseItem.gradeMax, letters) : null,
        outcomes,
      });
    }
    return { courseId, rows };
  }

  // --- export / import CSV ---------------------------------------------------

  /**
   * Tên cột CSV của một grade item: tên hiển thị, kèm `[idNumber]` khi item có
   * idNumber — chính hậu tố này là khoá ánh xạ ưu tiên khi import đọc lại file.
   */
  private itemCsvColumn(item: ItemRow): string {
    return item.idNumber ? `${item.itemName} [${item.idNumber}]` : item.itemName;
  }

  /** Số điểm trong CSV: làm tròn 6 chữ số thập phân để khử nhiễu dấu phẩy động của điểm tổng đã tính. */
  private csvNumber(value: number): string {
    return String(Math.round(value * 1e6) / 1e6);
  }

  /**
   * Export điểm của một khoá học ra CSV (issue #24, theo mẫu grade export của Moodle):
   * một dòng cho mỗi người học đã ghi danh; cột định danh userId/username/firstName/
   * lastName/email, sau đó một cột cho mỗi grade item (điểm tổng khoá học ở cột cuối)
   * mang finalGrade hiện tại, ô trống khi chưa có điểm. Quyền: grade:viewall
   * tại context khoá học — cùng quyền với báo cáo lớp.
   */
  async exportGradesCsv(actorId: string, courseId: string): Promise<{ filename: string; csv: string }> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:viewall', courseId);
    await this.ensureCourseCategory(courseId);
    const items = await this.repo.listItems(courseId);
    // Course total xuống cột cuối như Moodle; các item còn lại giữ thứ tự sổ điểm.
    const orderedItems = [...items.filter((i) => i.itemType !== 'course'), ...items.filter((i) => i.itemType === 'course')];
    const enrolments = await this.enrol.listEnrolmentsForCourse(courseId);
    const userIds = [...new Set(enrolments.map((e) => e.userId))];
    const usersById = new Map((await this.users.getUsersByIds(userIds)).map((u) => [u.id, u]));
    const grades = await this.repo.listGradesForCourse(courseId);
    const gradeByUserItem = new Map(grades.map((g) => [`${g.userId}:${g.itemId}`, g]));
    const header = ['userId', 'username', 'firstName', 'lastName', 'email', ...orderedItems.map((i) => this.itemCsvColumn(i))];
    const sortedIds = [...userIds].sort((a, b) => (usersById.get(a)?.username ?? a).localeCompare(usersById.get(b)?.username ?? b));
    const rows: string[][] = [header];
    for (const userId of sortedIds) {
      const user = usersById.get(userId);
      const row = [userId, user?.username ?? '', user?.firstName ?? '', user?.lastName ?? '', user?.email ?? ''];
      for (const item of orderedItems) {
        const g = gradeByUserItem.get(`${userId}:${item.id}`);
        row.push(g?.finalGrade !== null && g?.finalGrade !== undefined ? this.csvNumber(g.finalGrade) : '');
      }
      rows.push(row);
    }
    return { filename: `grades-${courseId}.csv`, csv: serializeCsv(rows) };
  }

  /** Năm học mặc định cho bảng xuất vnEdu: năm học VN bắt đầu tháng 8 (tháng 8–12 thuộc năm học bắt đầu năm đó, tháng 1–7 thuộc năm học bắt đầu năm trước). */
  private defaultVneduSchoolYear(now = new Date()): string {
    const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    return `${startYear}-${startYear + 1}`;
  }

  /**
   * Xuất sổ điểm ra Excel theo cấu trúc vnEdu/TT 22/2021 (issue #53; kiểm
   * chứng mẫu ở comment Bước 0 của issue): một bảng cho một môn/lớp/học kỳ,
   * cột STT/Mã học sinh (username)/Họ và tên, mỗi mục thường xuyên một cột
   * (hệ số 1), giữa kỳ (hệ số 2), cuối kỳ (hệ số 3) và ĐTBmhk tính theo Điều
   * 9. Ánh xạ mục điểm → loại cột do giáo viên xác nhận tường minh trong
   * payload (gradebook không có trường loại điểm TT22; đoán ngầm sẽ phân
   * loại sai lặng lẽ). Điểm xuất là finalGrade quy đổi thang 10 — xem
   * domain/vnedu-export. Quyền: grade:viewall tại context khoá, như CSV.
   */
  async exportGradesVnedu(actorId: string, courseId: string, dto: ExportGradesVneduDto): Promise<{ filename: string; buffer: Buffer }> {
    const course = await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:viewall', courseId);
    await this.ensureCourseCategory(courseId);
    const items = await this.repo.listItems(courseId);
    const byId = new Map(items.map((i) => [i.id, i]));
    const mappedIds = [...dto.regularItemIds, dto.midtermItemId, dto.finalItemId];
    if (new Set(mappedIds).size !== mappedIds.length) {
      throw new BadRequestException({ message: 'Each grade item may only be mapped to one vnEdu column type', code: 'grades.vnedu_duplicate_item' });
    }
    const resolveItem = (itemId: string): ItemRow => {
      const item = byId.get(itemId);
      if (!item) {
        throw new BadRequestException({ message: `Grade item ${itemId} does not belong to this course`, code: 'grades.vnedu_item_not_in_course' });
      }
      if (item.itemType !== 'manual' && item.itemType !== 'mod') {
        throw new BadRequestException({ message: `Grade item '${item.itemName}' is a category/course total, not a component grade`, code: 'grades.vnedu_item_not_exportable' });
      }
      if (item.gradeType !== 'value') {
        throw new BadRequestException({ message: `Grade item '${item.itemName}' is not a numeric (value) grade and cannot be converted to the 10-point scale`, code: 'grades.vnedu_item_not_exportable' });
      }
      if (!(item.gradeMax > item.gradeMin)) {
        throw new BadRequestException({ message: `Grade item '${item.itemName}' has an empty grade range`, code: 'grades.vnedu_item_bad_range' });
      }
      return item;
    };
    const toModelItem = (item: ItemRow): VneduExportItem => ({ id: item.id, name: item.itemName, gradeMin: item.gradeMin, gradeMax: item.gradeMax });
    const regular = dto.regularItemIds.map((id) => toModelItem(resolveItem(id)));
    const midterm = toModelItem(resolveItem(dto.midtermItemId));
    const finalItem = toModelItem(resolveItem(dto.finalItemId));

    const enrolments = await this.enrol.listEnrolmentsForCourse(courseId);
    const userIds = [...new Set(enrolments.map((e) => e.userId))];
    const usersById = new Map((await this.users.getUsersByIds(userIds)).map((u) => [u.id, u]));
    const grades = await this.repo.listGradesForCourse(courseId);
    const gradeByUserItem = new Map(grades.map((g) => [`${g.userId}:${g.itemId}`, g.finalGrade ?? null]));
    const mappedItems = [...regular, midterm, finalItem];
    const givenNameOf = (fullName: string): string => fullName.trim().split(/\s+/).at(-1) ?? '';
    const students = userIds.map((userId) => {
      const user = usersById.get(userId);
      const fullName = user ? `${user.lastName} ${user.firstName}`.replace(/\s+/g, ' ').trim() : '';
      const studentGrades = new Map<string, number | null>();
      for (const item of mappedItems) studentGrades.set(item.id, gradeByUserItem.get(`${userId}:${item.id}`) ?? null);
      return { code: user?.username ?? userId, fullName, grades: studentGrades };
    });
    // Danh sách lớp VN xếp theo TÊN (từ cuối của họ tên), rồi họ tên đầy đủ, rồi mã — như sổ điểm giấy.
    students.sort((a, b) =>
      givenNameOf(a.fullName).localeCompare(givenNameOf(b.fullName), 'vi')
      || a.fullName.localeCompare(b.fullName, 'vi')
      || a.code.localeCompare(b.code));

    const schoolYear = dto.schoolYear ?? this.defaultVneduSchoolYear();
    const model: VneduExportModel = {
      className: dto.className ?? course.shortName,
      subjectName: dto.subjectName ?? course.fullName,
      semester: dto.semester,
      schoolYear,
      regular,
      midterm,
      final: finalItem,
      students,
    };
    const buffer = await renderVneduWorkbook(model);
    const safeShortName = course.shortName.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'course';
    return { filename: `vnedu-${safeShortName}-hk${dto.semester}-${schoolYear}.xlsx`, buffer };
  }

  /**
   * Import điểm từ CSV (issue #24, theo mẫu grade import của Moodle): hàng đầu là
   * tiêu đề; người học được khớp bằng cột định danh (`userIdentifier`, mặc định
   * username); mỗi cột còn lại được ánh xạ tới một grade item theo thứ tự ưu tiên:
   * hậu tố `[idNumber]` trong tiêu đề → idNumber trần → id của item → tên item.
   * Cột tổng/calculated/không khớp được liệt kê vào ignoredColumns thay vì nhập.
   * Từng ô điểm đi qua ĐÚNG đường setGrade như nhập tay (kiểm capability, tôn
   * trọng overridden/locked, ghi lịch sử, regrade) — ô lỗi (user không tồn tại,
   * điểm không phải số, điểm đang overridden/locked…) thành một mục trong errors
   * và các ô đúng của cùng dòng vẫn được nhập; ô để trống bị bỏ qua.
   */
  async importGradesCsv(
    actorId: string,
    courseId: string,
    csvText: string,
    opts: { userIdentifier?: string } = {},
  ): Promise<GradeImportResult> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:edit', courseId);
    const identifier = (opts.userIdentifier ?? 'username') as GradeImportUserIdentifier;
    if (!GRADE_IMPORT_USER_IDENTIFIERS.includes(identifier)) {
      throw new BadRequestException({ message: `Unknown user identifier '${opts.userIdentifier}' (expected one of ${GRADE_IMPORT_USER_IDENTIFIERS.join(', ')})`, code: 'grades.import_bad_user_identifier' });
    }
    const table = parseCsv(csvText);
    if (!table.length) throw new BadRequestException({ message: 'The CSV file is empty', code: 'grades.import_empty' });
    const headers = table[0]!.map((h) => h.trim());
    const norm = (h: string): string => h.trim().toLowerCase();
    const idColumn = headers.findIndex((h) => norm(h) === identifier.toLowerCase());
    if (idColumn === -1) {
      throw new BadRequestException({ message: `The CSV file has no '${identifier}' column to identify users`, code: 'grades.import_missing_identifier_column' });
    }
    const items = await this.repo.listItems(courseId);
    const byIdnumber = new Map(items.filter((i) => i.idNumber).map((i) => [i.idNumber!, i]));
    const byId = new Map(items.map((i) => [i.id, i]));
    const byName = new Map<string, ItemRow>();
    for (const i of items) if (!byName.has(i.itemName)) byName.set(i.itemName, i);
    const byNameFolded = new Map<string, ItemRow>();
    for (const i of items) { const k = i.itemName.toLowerCase(); if (!byNameFolded.has(k)) byNameFolded.set(k, i); }
    const userInfoColumns = new Set(['userid', 'username', 'firstname', 'lastname', 'email']);
    const resolveColumnItem = (header: string): ItemRow | null => {
      const bracket = /^(.+) \[([^\]]+)\]$/.exec(header);
      if (bracket) { const byBracket = byIdnumber.get(bracket[2]!); if (byBracket) return byBracket; }
      return byIdnumber.get(header) ?? byId.get(header) ?? byName.get(header) ?? byNameFolded.get(header.toLowerCase()) ?? null;
    };
    const gradeColumns: { index: number; header: string; item: ItemRow }[] = [];
    const ignoredColumns: string[] = [];
    headers.forEach((header, index) => {
      if (index === idColumn || userInfoColumns.has(norm(header))) return;
      const item = resolveColumnItem(header);
      // Chỉ item nhập tay/mod mới nhận điểm nhập; tổng category/course và calculated do hệ thống tính.
      if (!item || item.itemType === 'course' || item.itemType === 'category' || item.itemType === 'calculated') {
        ignoredColumns.push(header);
        return;
      }
      gradeColumns.push({ index, header, item });
    });
    if (!gradeColumns.length) {
      throw new BadRequestException({ message: 'The CSV file has no column that maps to an enterable grade item', code: 'grades.import_no_grade_columns' });
    }
    const result: GradeImportResult = { imported: 0, skipped: 0, errors: [], ignoredColumns };
    const resolveUser = async (key: string) => {
      if (identifier === 'username') return this.users.getByUsername(key);
      if (identifier === 'email') return this.users.getByEmail(key);
      return this.users.getByIdOrUndefined(key);
    };
    for (let r = 1; r < table.length; r += 1) {
      const row = table[r]!;
      const rowNumber = r + 1; // dòng trên bảng tính: tiêu đề là dòng 1
      if (row.every((c) => c.trim() === '')) continue;
      const key = (row[idColumn] ?? '').trim();
      if (!key) {
        result.errors.push({ row: rowNumber, column: headers[idColumn]!, code: 'grades.import_missing_identifier', message: `Row has no ${identifier} value` });
        continue;
      }
      const user = await resolveUser(key);
      if (!user) {
        result.errors.push({ row: rowNumber, column: headers[idColumn]!, code: 'grades.import_user_not_found', message: `No user with ${identifier} '${key}'` });
        continue;
      }
      for (const col of gradeColumns) {
        const cell = (row[col.index] ?? '').trim();
        if (cell === '') { result.skipped += 1; continue; }
        const value = Number(cell);
        if (!Number.isFinite(value)) {
          result.errors.push({ row: rowNumber, column: col.header, code: 'grades.import_not_a_number', message: `'${cell}' is not a number` });
          continue;
        }
        try {
          await this.setGrade(actorId, col.item.id, user.id, { rawGrade: value });
          result.imported += 1;
        } catch (e) {
          // Lỗi nghiệp vụ của từng ô (overridden/locked/khoảng outcome…) không chặn các ô còn lại.
          const resp = e instanceof HttpException ? e.getResponse() : null;
          const body = typeof resp === 'object' && resp !== null ? (resp as { code?: string; message?: string }) : null;
          result.errors.push({
            row: rowNumber, column: col.header,
            code: body?.code ?? 'grades.import_row_failed',
            message: body?.message ?? (e instanceof Error ? e.message : 'Could not import this grade'),
          });
        }
      }
    }
    return result;
  }
}
