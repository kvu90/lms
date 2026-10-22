import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CompletionService } from '../completion/completion.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { AGGREGATIONS, calculateCategory, letterForGrade, adjustedGrade, type AggregationStrategy, type CalcItemInput } from './domain/grade-calculator';
import { GradeFormulaError, evaluateGradeFormula, findFormulaCycle, formulaReferences, parseGradeFormula } from './domain/grade-formula';
import { GradesRepository, type CategoryRow, type GradeRow, type ItemRow, type LetterRow, type OutcomeRow, type ScaleRow } from './grades.repository';

export const GRADE_REGRADE_QUEUE = 'grade-regrade';
export const COMPLETION_PASS = 2;
export const COMPLETION_FAIL = 3;
export const COMPLETION_DONE = 1;

export interface GradebookItemView {
  item: ItemRow;
  grade: (GradeRow & { letter: string | null; scaleValue: string | null; outcomeName: string | null }) | null;
}
export interface GradebookCategoryView {
  category: CategoryRow;
  total: GradebookItemView | null;
  items: GradebookItemView[];
  children: GradebookCategoryView[];
}

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
 *    completionusegrade and course 'grade' criteria evaluate for real;
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
    if (scale.courseid !== null && scale.courseid !== courseId) {
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
    if (outcome.courseid !== null && outcome.courseid !== courseId) {
      throw new BadRequestException({ message: 'Outcome belongs to another course', code: 'grades.outcome_course_mismatch' });
    }
    const scale = await this.repo.getScale(outcome.scaleid);
    if (!scale) throw new NotFoundException({ message: `Grade scale ${outcome.scaleid} not found`, code: 'grades.scale_not_found' });
    return { outcome, scale };
  }

  /**
   * Kiểm tra idnumber không trùng với item khác trong cùng khoá học (idnumber là khoá tham chiếu của công thức).
   */
  private async assertIdnumberFree(courseId: string, idnumber: string | null | undefined, selfItemId?: string): Promise<void> {
    if (!idnumber) return;
    const existing = await this.repo.findItemByIdnumber(courseId, idnumber);
    if (existing && existing.id !== selfItemId) {
      throw new BadRequestException({ message: `idnumber ${idnumber} is already used in this course`, code: 'grades.idnumber_taken' });
    }
  }

  /**
   * Kiểm tra công thức của item calculated NGAY khi lưu (không đợi tới lúc tính điểm):
   * cú pháp sai/hàm lạ → 400 grades.calculation_invalid / grades.calculation_unknown_function;
   * idnumber tham chiếu không tồn tại → 400 grades.calculation_unknown_idnumber;
   * tham chiếu vòng (trực tiếp hoặc qua chuỗi calculated khác) → 400 grades.calculation_cycle.
   */
  private async assertCalculationValid(
    courseId: string,
    calculation: string,
    self: { itemId?: string; idnumber?: string | null },
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
    const byIdnumber = new Map(items.filter((i) => i.idnumber).map((i) => [i.idnumber!, i]));
    for (const ref of refs) {
      if (!byIdnumber.has(ref) && ref !== self.idnumber) {
        throw new BadRequestException({ message: `Grade calculation references unknown idnumber [[${ref}]]`, code: 'grades.calculation_unknown_idnumber' });
      }
    }
    // Đồ thị tham chiếu giữa các calculated item của khoá học để phát hiện vòng.
    const graph = new Map<string, string[]>();
    for (const item of items) {
      if (!item.idnumber || !item.calculation) continue;
      if (item.id === self.itemId && item.idnumber !== self.idnumber) continue; // item tự đổi idnumber: cạnh cũ không còn
      try { graph.set(item.idnumber, formulaReferences(parseGradeFormula(item.calculation))); } catch { /* công thức cũ lỗi không tạo cạnh */ }
    }
    if (self.idnumber) graph.set(self.idnumber, refs);
    const starts = self.idnumber ? [self.idnumber, ...refs] : refs;
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
      root = await this.repo.insertCategory({ courseid: courseId, parent: null, fullname: '', aggregation: 'natural', depth: 1, path: '' });
      await this.repo.updateCategory(root.id, { path: `/${root.id}` });
      root = (await this.repo.getCategory(root.id))!;
    }
    let courseItem = await this.repo.findItemByTypeInstance(courseId, 'course', courseId);
    if (!courseItem) {
      courseItem = await this.repo.insertItem({
        courseid: courseId, categoryid: root.id, itemname: 'Course total', itemtype: 'course',
        iteminstance: courseId, grademax: 100, grademin: 0,
      });
    }
    return { category: root, courseItem };
  }

  /**
   * Tạo category điểm con.
   */
  async createCategory(actorId: string, courseId: string, input: {
    fullname: string; parentId?: string; aggregation?: string; droplow?: number; keephigh?: number;
    aggregateonlygraded?: boolean; hidden?: boolean;
  }): Promise<CategoryRow> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'moodle/grade:manage', courseId);
    const aggregation = (input.aggregation ?? 'natural') as AggregationStrategy;
    if (!AGGREGATIONS.includes(aggregation)) {
      throw new BadRequestException({ message: `Unknown aggregation ${input.aggregation}`, code: 'grades.bad_aggregation' });
    }
    const { category: root } = await this.ensureCourseCategory(courseId);
    const parent = input.parentId ? await this.getCategory(input.parentId) : root;
    if (parent.courseid !== courseId) throw new BadRequestException({ message: 'Parent category belongs to another course', code: 'grades.parent_course_mismatch' });
    const cat = await this.repo.insertCategory({
      courseid: courseId, parent: parent.id, fullname: input.fullname, aggregation,
      droplow: input.droplow ?? 0, keephigh: input.keephigh ?? 0,
      aggregateonlygraded: input.aggregateonlygraded ?? false, hidden: input.hidden ?? false,
      depth: parent.depth + 1, path: '',
    });
    await this.repo.updateCategory(cat.id, { path: `${parent.path}/${cat.id}` });
    // Every category owns a total item living in its PARENT category.
    await this.repo.insertItem({
      courseid: courseId, categoryid: parent.id, itemname: input.fullname, itemtype: 'category',
      iteminstance: cat.id, grademax: 100, grademin: 0,
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
    fullname?: string; aggregation?: string; droplow?: number; keephigh?: number;
    aggregateonlygraded?: boolean; hidden?: boolean;
  }): Promise<CategoryRow> {
    const cat = await this.getCategory(categoryId);
    await this.requireCap(actorId, 'moodle/grade:manage', cat.courseid);
    if (input.aggregation !== undefined && !AGGREGATIONS.includes(input.aggregation as AggregationStrategy)) {
      throw new BadRequestException({ message: `Unknown aggregation ${input.aggregation}`, code: 'grades.bad_aggregation' });
    }
    const aggregationChanged = input.aggregation !== undefined && input.aggregation !== cat.aggregation;
    const patch: Partial<CategoryRow> = {};
    if (input.fullname !== undefined) patch.fullname = input.fullname;
    if (input.aggregation !== undefined) patch.aggregation = input.aggregation;
    if (input.droplow !== undefined) patch.droplow = input.droplow;
    if (input.keephigh !== undefined) patch.keephigh = input.keephigh;
    if (input.aggregateonlygraded !== undefined) patch.aggregateonlygraded = input.aggregateonlygraded;
    if (input.hidden !== undefined) patch.hidden = input.hidden;
    if (Object.keys(patch).length) await this.repo.updateCategory(categoryId, patch);
    if (input.fullname !== undefined) {
      const totalItem = await this.repo.findItemByTypeInstance(cat.courseid, 'category', categoryId);
      if (totalItem) await this.repo.updateItem(totalItem.id, { itemname: input.fullname });
    }
    if (aggregationChanged || input.droplow !== undefined || input.keephigh !== undefined || input.aggregateonlygraded !== undefined) {
      // Aggregation semantics changed ⇒ bulk regrade in the worker + outbox chain.
      await this.regradeQueue.add('regrade', { courseId: cat.courseid, categoryId },
        { jobId: `grade-regrade-${cat.courseid}-${categoryId}-${Date.now()}`, attempts: 3 });
      await this.outbox.enqueueStandalone({
        aggregate: 'grades', type: 'grade_category_aggregation_changed',
        payload: { courseId: cat.courseid, categoryId, aggregation: input.aggregation ?? cat.aggregation },
      });
      await this.regradeCourse(cat.courseid);
    }
    return this.getCategory(categoryId);
  }

  /**
   * Xoá category (item con được nâng lên category cha).
   */
  async deleteCategory(actorId: string, categoryId: string): Promise<void> {
    const cat = await this.getCategory(categoryId);
    await this.requireCap(actorId, 'moodle/grade:manage', cat.courseid);
    const root = await this.repo.rootCategory(cat.courseid);
    if (root && root.id === categoryId) {
      throw new BadRequestException({ message: 'The course category cannot be deleted', code: 'grades.root_category' });
    }
    const children = (await this.repo.listCategories(cat.courseid)).filter((c) => c.parent === categoryId);
    const items = await this.repo.listItemsInCategory(categoryId);
    if (children.length || items.length) {
      throw new BadRequestException({ message: 'Category is not empty', code: 'grades.category_not_empty' });
    }
    const totalItem = await this.repo.findItemByTypeInstance(cat.courseid, 'category', categoryId);
    if (totalItem) await this.repo.deleteItem(totalItem.id);
    await this.repo.deleteCategory(categoryId);
    await this.regradeCourse(cat.courseid);
  }

  // --- items ---------------------------------------------------------------

  /**
   * Tạo grade item (manual hoặc gắn với hoạt động).
   */
  async createItem(actorId: string, courseId: string, input: {
    itemname: string; itemtype?: string; categoryId?: string; cmId?: string;
    grademax?: number; grademin?: number; gradepass?: number; scaleId?: string;
    outcomeId?: string; idnumber?: string; calculation?: string;
    weightoverride?: boolean; weight?: number; extracredit?: boolean;
    multiplicator?: number; plusfactor?: number; hidden?: boolean;
  }): Promise<ItemRow> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'moodle/grade:manage', courseId);
    const itemtype = input.itemtype ?? 'manual';
    if (!['manual', 'mod', 'calculated'].includes(itemtype)) {
      throw new BadRequestException({ message: `grade item type ${itemtype} is created by the system`, code: 'grades.bad_itemtype' });
    }
    if (itemtype === 'mod' && !input.cmId) {
      throw new BadRequestException({ message: 'A mod item requires cmId', code: 'grades.cm_required' });
    }
    if (itemtype === 'calculated' && !input.calculation) {
      throw new BadRequestException({ message: 'A calculated item requires a calculation formula', code: 'grades.calculation_required' });
    }
    if (itemtype !== 'calculated' && input.calculation) {
      throw new BadRequestException({ message: 'Only calculated items carry a calculation formula', code: 'grades.calculation_only_calculated' });
    }
    await this.assertIdnumberFree(courseId, input.idnumber ?? null);
    if (itemtype === 'calculated') {
      await this.assertCalculationValid(courseId, input.calculation!, { idnumber: input.idnumber ?? null });
    }
    const { category: root } = await this.ensureCourseCategory(courseId);
    const category = input.categoryId ? await this.getCategory(input.categoryId) : root;
    if (category.courseid !== courseId) throw new BadRequestException({ message: 'Category belongs to another course', code: 'grades.category_course_mismatch' });
    let itemmodule: string | null = null;
    if (itemtype === 'mod') {
      const cm = await this.courses.getCm(input.cmId!);
      if (cm.course !== courseId) throw new BadRequestException({ message: 'cm belongs to another course', code: 'grades.cm_course_mismatch' });
      itemmodule = cm.component;
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
    const grademin = outcomeScale ? 1 : (input.grademin ?? 0);
    const grademax = outcomeScale ? Math.max(1, this.scaleValues(outcomeScale).length) : (input.grademax ?? 100);
    if (grademax <= grademin && !outcomeScale) throw new BadRequestException({ message: 'grademax must be greater than grademin', code: 'grades.bad_range' });
    const item = await this.repo.insertItem({
      courseid: courseId, categoryid: category.id, itemname: input.itemname, itemtype,
      itemmodule, iteminstance: itemtype === 'mod' ? input.cmId! : null,
      gradetype: (outcomeScale || input.scaleId) ? 'scale' : 'value',
      scaleid: outcomeScale ? outcomeScale.id : (input.scaleId ?? null),
      outcomeid: input.outcomeId ?? null,
      idnumber: input.idnumber ?? null,
      calculation: itemtype === 'calculated' ? input.calculation! : null,
      grademax, grademin, gradepass: input.gradepass ?? 0,
      weightoverride: input.weightoverride ?? false, aggregationcoef: input.weight ?? 0,
      extracredit: input.extracredit ?? false, multiplicator: input.multiplicator ?? 1,
      plusfactor: input.plusfactor ?? 0, hidden: input.hidden ?? false,
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
    itemname?: string; categoryId?: string; grademax?: number; grademin?: number; gradepass?: number;
    scaleId?: string | null; outcomeId?: string | null; idnumber?: string | null; calculation?: string | null;
    weightoverride?: boolean; weight?: number; extracredit?: boolean;
    multiplicator?: number; plusfactor?: number; hidden?: boolean; locked?: boolean;
  }): Promise<ItemRow> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'moodle/grade:manage', item.courseid);
    // Công thức/idnumber/outcome được kiểm tra lại đầy đủ mỗi lần sửa, giống lúc tạo.
    const nextIdnumber = input.idnumber !== undefined ? input.idnumber : item.idnumber;
    if (input.idnumber !== undefined) await this.assertIdnumberFree(item.courseid, input.idnumber, itemId);
    if (input.idnumber !== undefined && item.idnumber && input.idnumber !== item.idnumber) {
      const referenced = (await this.repo.listItems(item.courseid))
        .some((i) => i.id !== itemId && !!i.calculation && i.calculation.includes(`[[${item.idnumber}]]`));
      if (referenced) {
        throw new BadRequestException({ message: `idnumber ${item.idnumber} is referenced by a grade calculation`, code: 'grades.idnumber_in_use' });
      }
    }
    const nextCalculation = input.calculation !== undefined ? input.calculation : item.calculation;
    if (item.itemtype === 'calculated') {
      if (!nextCalculation) {
        throw new BadRequestException({ message: 'A calculated item requires a calculation formula', code: 'grades.calculation_required' });
      }
      await this.assertCalculationValid(item.courseid, nextCalculation, { itemId, idnumber: nextIdnumber });
    } else if (input.calculation !== undefined && input.calculation !== null) {
      throw new BadRequestException({ message: 'Only calculated items carry a calculation formula', code: 'grades.calculation_only_calculated' });
    }
    const patch: Partial<ItemRow> = {};
    if (input.idnumber !== undefined) patch.idnumber = input.idnumber;
    if (input.calculation !== undefined && item.itemtype === 'calculated') patch.calculation = input.calculation;
    if (input.outcomeId !== undefined) {
      if (input.outcomeId === null) {
        patch.outcomeid = null;
        // Gỡ outcome: scale của outcome cũng được gỡ theo, item quay về thang số thường.
        patch.scaleid = null;
        patch.gradetype = 'value';
      } else {
        const { scale } = await this.outcomeForCourse(input.outcomeId, item.courseid);
        patch.outcomeid = input.outcomeId;
        patch.scaleid = scale.id;
        patch.gradetype = 'scale';
        patch.grademin = 1;
        patch.grademax = Math.max(1, this.scaleValues(scale).length);
      }
    }
    if (input.scaleId !== undefined && input.outcomeId === undefined) {
      if (input.scaleId !== null) await this.scaleForOutcome(input.scaleId, item.courseid);
      patch.scaleid = input.scaleId;
      patch.gradetype = input.scaleId ? 'scale' : 'value';
    }
    if (input.itemname !== undefined) patch.itemname = input.itemname;
    if (input.categoryId !== undefined) {
      const cat = await this.getCategory(input.categoryId);
      if (cat.courseid !== item.courseid) throw new BadRequestException({ message: 'Category belongs to another course', code: 'grades.category_course_mismatch' });
      patch.categoryid = input.categoryId;
    }
    if (input.grademax !== undefined) patch.grademax = input.grademax;
    if (input.grademin !== undefined) patch.grademin = input.grademin;
    if (input.gradepass !== undefined) patch.gradepass = input.gradepass;
    if (input.weightoverride !== undefined) patch.weightoverride = input.weightoverride;
    if (input.weight !== undefined) patch.aggregationcoef = input.weight;
    if (input.extracredit !== undefined) patch.extracredit = input.extracredit;
    if (input.multiplicator !== undefined) patch.multiplicator = input.multiplicator;
    if (input.plusfactor !== undefined) patch.plusfactor = input.plusfactor;
    if (input.hidden !== undefined) patch.hidden = input.hidden;
    if (input.locked !== undefined) patch.locked = input.locked;
    if (Object.keys(patch).length) await this.repo.updateItem(itemId, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'grades', type: 'grade_item_updated', payload: { courseId: item.courseid, itemId } });
    await this.regradeCourse(item.courseid);
    return this.getItem(itemId);
  }

  /**
   * Xoá item và điểm của nó.
   */
  async deleteItem(actorId: string, itemId: string): Promise<void> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'moodle/grade:manage', item.courseid);
    if (item.itemtype === 'course' || item.itemtype === 'category') {
      throw new BadRequestException({ message: 'Category/course total items are deleted with their category', code: 'grades.system_item' });
    }
    await this.repo.deleteItem(itemId);
    await this.regradeCourse(item.courseid);
  }

  // --- entering grades -------------------------------------------------------

  /** Leaf final grade: raw adjusted by multiplicator/offset; frozen once a non-identity formula produced it. */
  private leafFinal(item: ItemRow, raw: number | null, existing?: GradeRow): { finalgrade: number | null; frozen: boolean } {
    if (raw === null) return { finalgrade: null, frozen: false };
    if (existing?.frozen) return { finalgrade: existing.finalgrade, frozen: true };
    const adjusted = adjustedGrade({
      itemId: item.id, grademin: item.grademin, grademax: item.grademax, grade: raw,
      multiplicator: item.multiplicator, offset: item.plusfactor,
    });
    const hasFormula = item.multiplicator !== 1 || item.plusfactor !== 0;
    return { finalgrade: adjusted, frozen: hasFormula };
  }

  /**
   * Đặt điểm cho user tại item: kiểm capability grade:edit, ghi lịch sử, kích hoạt regrade.
   */
  async setGrade(actorId: string, itemId: string, userId: string, input: { rawgrade?: number | null; feedback?: string }): Promise<GradeRow> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'moodle/grade:edit', item.courseid);
    if (item.itemtype === 'course' || item.itemtype === 'category' || item.itemtype === 'calculated') {
      throw new BadRequestException({ message: 'Category/course totals and calculated items are calculated, not entered', code: 'grades.calculated_item' });
    }
    if (item.locked) throw new ForbiddenException({ message: 'This grade item is locked', code: 'grades.item_locked' });
    if (item.outcomeid && input.rawgrade !== undefined && input.rawgrade !== null) {
      // Điểm outcome là chỉ số nguyên 1-based trong scale của outcome (scale item id trong Moodle) — ngoài khoảng là lỗi, không kẹp âm thầm.
      const { scale } = await this.outcomeForCourse(item.outcomeid, item.courseid);
      const count = this.scaleValues(scale).length;
      if (!Number.isInteger(input.rawgrade) || input.rawgrade < 1 || input.rawgrade > count) {
        throw new BadRequestException({ message: `Outcome grade must be an integer scale index between 1 and ${count}`, code: 'grades.outcome_grade_out_of_scale' });
      }
    }
    const existing = await this.repo.getGrade(itemId, userId);
    if (existing?.locked) throw new ForbiddenException({ message: 'This grade is locked', code: 'grades.grade_locked' });
    if (existing?.overridden) throw new ForbiddenException({ message: 'This grade is overridden; clear the override before entering a grade', code: 'grades.grade_overridden' });
    const raw = input.rawgrade ?? null;
    if (raw !== null && (raw < item.grademin - 1e-9 || raw > item.grademax + 1e-9)) {
      // Moodle clamps out-of-range raw grades into the item range on entry.
    }
    const clampedRaw = raw === null ? null : Math.min(item.grademax, Math.max(item.grademin, raw));
    const { finalgrade, frozen } = this.leafFinal(item, clampedRaw, existing);
    let saved!: GradeRow;
    await this.repo.dbHandle.transaction(async (tx) => {
      saved = await this.repo.upsertGrade({
        itemid: itemId, userid: userId, rawgrade: clampedRaw, rawgrademin: item.grademin, rawgrademax: item.grademax,
        finalgrade, feedback: input.feedback ?? existing?.feedback ?? null,
        hidden: existing?.hidden ?? false, locked: existing?.locked ?? false,
        overridden: false, excluded: existing?.excluded ?? false, frozen,
        aggregationstatus: 'used', aggregationweight: existing?.aggregationweight ?? null,
      }, tx as never);
      await this.repo.insertHistory({
        action: existing ? 2 : 1, oldid: existing?.id ?? null, itemid: itemId, userid: userId,
        rawgrade: clampedRaw, finalgrade, overridden: false, excluded: existing?.excluded ?? false,
        frozen, source: 'manual', loggeduser: actorId,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'grades', type: 'grade_updated',
        payload: { courseId: item.courseid, itemId, userId, rawgrade: clampedRaw, finalgrade },
      });
    });
    await this.regradeUser(item.courseid, userId);
    await this.refreshCompletionForUser(item.courseid, userId);
    void saved;
    return (await this.repo.getGrade(itemId, userId))!;
  }

  /** Override / lock / exclude / hide / unfreeze a single grade, then regrade the user. */
  /**
   * Sửa một bản ghi điểm đã có (kèm lịch sử).
   */
  async updateGrade(actorId: string, gradeId: string, input: {
    overridden?: boolean; finalgrade?: number | null; locked?: boolean; excluded?: boolean;
    hidden?: boolean; frozen?: boolean; feedback?: string;
  }): Promise<GradeRow> {
    const grade = await this.repo.getGradeById(gradeId);
    if (!grade) throw new NotFoundException({ message: `Grade ${gradeId} not found`, code: 'grades.grade_not_found' });
    const item = await this.getItem(grade.itemid);
    await this.requireCap(actorId, 'moodle/grade:edit', item.courseid);
    const patch: Partial<GradeRow> = {};
    if (input.overridden !== undefined) patch.overridden = input.overridden;
    if (input.finalgrade !== undefined) patch.finalgrade = input.finalgrade;
    if (input.locked !== undefined) { patch.locked = input.locked; patch.locktime = input.locked ? new Date() : null; }
    if (input.excluded !== undefined) patch.excluded = input.excluded;
    if (input.hidden !== undefined) patch.hidden = input.hidden;
    if (input.frozen !== undefined) patch.frozen = input.frozen;
    if (input.feedback !== undefined) patch.feedback = input.feedback;
    if (input.overridden === true && input.finalgrade === undefined && grade.finalgrade === null) {
      throw new BadRequestException({ message: 'Overriding requires a finalgrade', code: 'grades.override_needs_grade' });
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.updateGrade(gradeId, patch, tx as never);
      await this.repo.insertHistory({
        action: 2, oldid: gradeId, itemid: grade.itemid, userid: grade.userid,
        rawgrade: grade.rawgrade, finalgrade: patch.finalgrade ?? grade.finalgrade,
        overridden: patch.overridden ?? grade.overridden, excluded: patch.excluded ?? grade.excluded,
        frozen: patch.frozen ?? grade.frozen, source: 'override', loggeduser: actorId,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'grades', type: 'grade_updated',
        payload: { courseId: item.courseid, itemId: grade.itemid, userId: grade.userid, finalgrade: patch.finalgrade ?? grade.finalgrade, overridden: patch.overridden ?? grade.overridden },
      });
    });
    await this.regradeUser(item.courseid, grade.userid);
    await this.refreshCompletionForUser(item.courseid, grade.userid);
    return (await this.repo.getGradeById(gradeId))!;
  }

  // --- regrade ---------------------------------------------------------------

  /**
   * Recompute every category total (bottom-up) and the course total for one
   * user. Overridden totals are never recomputed; frozen totals keep their
   * frozen final grade. Category/course items get their grademax synced to
   * the calculator's structural max for natural/sum.
   */
  /**
   * Tính lại tổng cho một user trong khoá học.
   */
  async regradeUser(courseId: string, userId: string): Promise<void> {
    const categories = await this.repo.listCategories(courseId);
    const items = await this.repo.listItems(courseId);
    const grades = await this.repo.listGradesForCourse(courseId, userId);
    const gradeByItem = new Map<string, GradeRow>(grades.map((g) => [g.itemid, g]));
    const finalByItem = new Map<string, number | null>(grades.map((g) => [g.itemid, g.finalgrade]));

    // Calculated items: đánh giá công thức theo idnumber trước khi tổng hợp category.
    // Tham chiếu tới item thường dùng finalgrade đã lưu; tham chiếu tới calculated khác được
    // giải quyết đệ quy (vòng đã bị chặn lúc lưu công thức, ở đây chỉ là phòng thủ → null).
    // Kết quả được kẹp vào [grademin, grademax] của chính calculated item và lưu như điểm của nó.
    const byIdnumber = new Map(items.filter((i) => i.idnumber).map((i) => [i.idnumber!, i]));
    const computedCalc = new Map<string, number | null>();
    const resolving = new Set<string>();
    const resolveFinal = (it: ItemRow): number | null => {
      if (it.itemtype !== 'calculated') return finalByItem.get(it.id) ?? null;
      if (computedCalc.has(it.id)) return computedCalc.get(it.id)!;
      if (resolving.has(it.id)) return null;
      resolving.add(it.id);
      let value: number | null = null;
      const existingCalc = gradeByItem.get(it.id);
      if (existingCalc?.overridden) {
        value = existingCalc.finalgrade;
      } else if (it.calculation) {
        try {
          value = evaluateGradeFormula(parseGradeFormula(it.calculation), (idnumber) => {
            const ref = byIdnumber.get(idnumber);
            if (!ref || ref.id === it.id) return null;
            if (gradeByItem.get(ref.id)?.excluded) return null;
            return resolveFinal(ref);
          });
        } catch { value = null; }
        if (value !== null) value = Math.min(it.grademax, Math.max(it.grademin, value));
      }
      resolving.delete(it.id);
      computedCalc.set(it.id, value);
      return value;
    };
    for (const calcItem of items.filter((i) => i.itemtype === 'calculated')) {
      const existingCalc = gradeByItem.get(calcItem.id);
      if (existingCalc?.overridden) { finalByItem.set(calcItem.id, existingCalc.finalgrade); continue; }
      const value = resolveFinal(calcItem);
      finalByItem.set(calcItem.id, value);
      const changed = !existingCalc || existingCalc.finalgrade !== value;
      const savedCalc = await this.repo.upsertGrade({
        itemid: calcItem.id, userid: userId, rawgrade: existingCalc?.rawgrade ?? null,
        rawgrademin: calcItem.grademin, rawgrademax: calcItem.grademax,
        finalgrade: value, hidden: existingCalc?.hidden ?? false, locked: existingCalc?.locked ?? false,
        overridden: false, excluded: existingCalc?.excluded ?? false, frozen: existingCalc?.frozen ?? false,
        feedback: existingCalc?.feedback ?? null, aggregationstatus: value === null ? 'novalue' : 'used',
        aggregationweight: existingCalc?.aggregationweight ?? null,
      });
      gradeByItem.set(calcItem.id, savedCalc);
      if (changed && value !== null) {
        await this.repo.insertHistory({
          action: existingCalc ? 2 : 1, oldid: existingCalc?.id ?? null, itemid: calcItem.id, userid: userId,
          rawgrade: null, finalgrade: value, overridden: false,
          excluded: existingCalc?.excluded ?? false, frozen: existingCalc?.frozen ?? false, source: 'calculation',
        });
        await this.outbox.enqueueStandalone({
          aggregate: 'grades', type: 'grade_updated',
          payload: { courseId, itemId: calcItem.id, userId, finalgrade: value, calculated: true },
        });
      }
    }

    const byDepthDesc = [...categories].sort((a, b) => b.depth - a.depth);
    for (const cat of byDepthDesc) {
      const totalItem = items.find((i) => (i.itemtype === 'category' && i.iteminstance === cat.id)
        || (i.itemtype === 'course' && cat.parent === null));
      if (!totalItem) continue;
      const existing = gradeByItem.get(totalItem.id);
      if (existing?.overridden) { finalByItem.set(totalItem.id, existing.finalgrade); continue; }
      if (existing?.frozen && existing.finalgrade !== null) { finalByItem.set(totalItem.id, existing.finalgrade); continue; }

      // Item thang định tính (gradetype='scale', gồm cả item gắn outcome) KHÔNG tham gia
      // tổng hợp số của category — cùng luật đã ghi cho scale; chúng chỉ hiển thị trong sổ điểm.
      const childItems = items.filter((i) => i.categoryid === cat.id && i.id !== totalItem.id
        && !i.outcomeid && i.gradetype !== 'scale');
      const calcItems: CalcItemInput[] = childItems.map((ci) => {
        const g = gradeByItem.get(ci.id);
        const isSubTotal = ci.itemtype === 'category' || ci.itemtype === 'course';
        const isCalculated = ci.itemtype === 'calculated';
        return {
          itemId: ci.id, grademin: ci.grademin, grademax: ci.grademax,
          grade: finalByItem.get(ci.id) ?? null,
          excluded: g?.excluded ?? false, extracredit: ci.extracredit,
          weightOverride: ci.weightoverride, weight: ci.aggregationcoef,
          aggregationcoef: ci.aggregationcoef,
          // Multiplicator/offset apply to leaf grades at entry time, not to totals or calculated items.
          multiplicator: (isSubTotal || isCalculated) ? 1 : ci.multiplicator, offset: (isSubTotal || isCalculated) ? 0 : ci.plusfactor,
          frozen: g?.frozen ?? false,
        };
      });
      const result = calculateCategory({
        aggregation: cat.aggregation as AggregationStrategy,
        grademin: totalItem.grademin, grademax: totalItem.grademax,
        droplow: cat.droplow, keephigh: cat.keephigh, aggregateOnlyGraded: cat.aggregateonlygraded,
        items: calcItems,
      });
      if ((cat.aggregation === 'natural' || cat.aggregation === 'sum') && Math.abs(result.grademax - totalItem.grademax) > 1e-9) {
        await this.repo.updateItem(totalItem.id, { grademax: result.grademax });
        totalItem.grademax = result.grademax;
      }
      const changed = !existing || existing.finalgrade !== result.finalgrade;
      const saved = await this.repo.upsertGrade({
        itemid: totalItem.id, userid: userId, rawgrade: null,
        rawgrademin: totalItem.grademin, rawgrademax: totalItem.grademax,
        finalgrade: result.finalgrade, hidden: existing?.hidden ?? false, locked: existing?.locked ?? false,
        overridden: false, excluded: existing?.excluded ?? false, frozen: existing?.frozen ?? false,
        feedback: existing?.feedback ?? null, aggregationstatus: result.finalgrade === null ? 'novalue' : 'used',
        aggregationweight: existing?.aggregationweight ?? null,
      });
      gradeByItem.set(totalItem.id, saved);
      finalByItem.set(totalItem.id, result.finalgrade);
      // Record effective natural weights on the child grade rows.
      for (const [itemIdStr, w] of Object.entries(result.weights)) {
        const childGrade = gradeByItem.get(itemIdStr);
        if (childGrade && childGrade.aggregationweight !== w) {
          await this.repo.updateGrade(childGrade.id, { aggregationweight: w });
        }
      }
      if (changed && result.finalgrade !== null) {
        await this.repo.insertHistory({
          action: existing ? 2 : 1, oldid: existing?.id ?? null, itemid: totalItem.id, userid: userId,
          rawgrade: null, finalgrade: result.finalgrade, overridden: false,
          excluded: existing?.excluded ?? false, frozen: existing?.frozen ?? false, source: 'regrade',
        });
        await this.outbox.enqueueStandalone({
          aggregate: 'grades', type: 'grade_updated',
          payload: { courseId, itemId: totalItem.id, userId, finalgrade: result.finalgrade, calculated: true },
        });
      }
    }
  }

  /**
   * Tính lại tổng cho toàn bộ khoá học.
   */
  async regradeCourse(courseId: string): Promise<{ courseId: string; users: number }> {
    const userIds = new Set<string>();
    for (const g of await this.repo.listGradesForCourse(courseId)) userIds.add(g.userid);
    for (const ue of await this.enrol.listEnrolmentsForCourse(courseId)) userIds.add(ue.userid);
    for (const userId of userIds) await this.regradeUser(courseId, userId);
    for (const userId of userIds) await this.refreshCompletionForUser(courseId, userId);
    await this.outbox.enqueueStandalone({ aggregate: 'grades', type: 'course_grade_recalculated', payload: { courseId, users: userIds.size } });
    return { courseId, users: userIds.size };
  }

  /**
   * Đưa yêu cầu regrade vào hàng đợi (worker) khi thay đổi lớn.
   */
  async triggerRegrade(actorId: string, courseId: string): Promise<{ courseId: string; users: number }> {
    await this.requireCap(actorId, 'moodle/grade:manage', courseId);
    return this.regradeCourse(courseId);
  }

  // --- cross-module evaluators ------------------------------------------------

  /** Completion hook: state for a cm with completionusegrade. Null = no grade yet. */
  /**
   * Điểm phần trăm của user tại cm — đầu vào cho availability/completion theo điểm.
   */
  async evaluateCmGrade(cmId: string, userId: string): Promise<number | null> {
    const cm = await this.courses.getCm(cmId).catch(() => undefined);
    if (!cm) return null;
    const item = await this.repo.findItemForCm(cm.course, cmId);
    if (!item) return null;
    const grade = await this.repo.getGrade(item.id, userId);
    if (!grade || grade.finalgrade === null) return null;
    if (item.gradepass > 0) return grade.finalgrade >= item.gradepass ? COMPLETION_PASS : COMPLETION_FAIL;
    return COMPLETION_DONE;
  }

  /** Course-completion 'grade' criterion: the course total meets the course item's gradepass. */
  /**
   * Điểm tổng khoá học của user có đạt ngưỡng qua môn hay không.
   */
  async courseGradePassed(courseId: string, userId: string): Promise<boolean> {
    const { courseItem } = await this.ensureCourseCategory(courseId);
    const grade = await this.repo.getGrade(courseItem.id, userId);
    if (!grade || grade.finalgrade === null) return false;
    return courseItem.gradepass > 0 ? grade.finalgrade >= courseItem.gradepass : true;
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
      const g = grades.find((x) => x.itemid === item.id);
      if (!g || g.finalgrade === null || item.grademax <= item.grademin) continue;
      if (item.outcomeid || item.gradetype === 'scale') continue; // điểm định tính không có phần trăm số
      const pct = ((g.finalgrade - item.grademin) / (item.grademax - item.grademin)) * 100;
      out[String(item.id)] = pct;
      if (item.itemtype === 'mod') out[String(item.iteminstance)] = pct;
      if (item.itemtype === 'course') out['course'] = pct;
    }
    return out;
  }

  /** Raw final grade of an item for a user (facade for reports/other modules). */
  /**
   * Điểm cuối cùng của user tại item (sau tính toán).
   */
  async getFinalGrade(itemId: string, userId: string): Promise<number | null> {
    const g = await this.repo.getGrade(itemId, userId);
    return g?.finalgrade ?? null;
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
      if (cm.completionusegrade) await this.completion.refreshGradeCompletion(cm.id, userId);
    }
    // Course-level criteria may include a 'grade' criterion on the course total.
    await this.completion.reaggregateCourseCompletion(userId, courseId);
  }

  // --- letters, scales, reports ------------------------------------------------

  /**
   * Đặt bảng grade letters của khoá học.
   */
  async setLetters(actorId: string, courseId: string, letters: { letter: string; lowerboundary: number }[]): Promise<LetterRow[]> {
    await this.requireCap(actorId, 'moodle/grade:manage', courseId);
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
    await this.requireCap(actorId, 'moodle/grade:manage', courseId);
    return this.repo.insertScale({ courseid: courseId, name: input.name, scale: input.scale, description: input.description ?? '' });
  }
  /**
   * Tạo scale mức site (courseid = null) — dùng được cho outcome mức site và mọi khoá học.
   */
  async createSiteScale(actorId: string, input: { name: string; scale: string; description?: string }): Promise<ScaleRow> {
    await this.requireSiteCap(actorId, 'moodle/grade:manage');
    return this.repo.insertScale({ courseid: null, name: input.name, scale: input.scale, description: input.description ?? '' });
  }
  /**
   * Liệt kê scales.
   */
  async listScales(courseId: string): Promise<ScaleRow[]> { return this.repo.listScales(courseId); }

  // --- outcomes --------------------------------------------------------------

  /**
   * Tạo grade outcome: mức khoá học khi có courseId, mức site khi courseId = null.
   * Capability dùng chung của grades: moodle/grade:manage tại context khoá học (hoặc hệ thống với outcome site).
   */
  async createOutcome(actorId: string, courseId: string | null, input: { name: string; scaleId: string; description?: string }): Promise<OutcomeRow> {
    if (courseId !== null) {
      await this.courses.getCourse(courseId);
      await this.requireCap(actorId, 'moodle/grade:manage', courseId);
    } else {
      await this.requireSiteCap(actorId, 'moodle/grade:manage');
    }
    await this.scaleForOutcome(input.scaleId, courseId);
    const row = await this.repo.insertOutcome({
      courseid: courseId, scaleid: input.scaleId, name: input.name, description: input.description ?? '',
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
    if (outcome.courseid === null) await this.requireSiteCap(actorId, 'moodle/grade:manage');
    else await this.requireCap(actorId, 'moodle/grade:manage', outcome.courseid);
  }

  /**
   * Cập nhật grade outcome; đổi scale thì các item đang gắn outcome được đồng bộ scaleid/grademax theo scale mới và tính lại.
   */
  async updateOutcome(actorId: string, outcomeId: string, input: { name?: string; scaleId?: string; description?: string }): Promise<OutcomeRow> {
    const outcome = await this.getOutcome(outcomeId);
    await this.requireOutcomeCap(actorId, outcome);
    const patch: Partial<OutcomeRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.scaleId !== undefined) {
      await this.scaleForOutcome(input.scaleId, outcome.courseid);
      patch.scaleid = input.scaleId;
    }
    if (Object.keys(patch).length) await this.repo.updateOutcome(outcomeId, patch);
    if (input.scaleId !== undefined && input.scaleId !== outcome.scaleid) {
      // Đổi scale của outcome ⇒ đồng bộ scaleid và khoảng điểm (1..số mức) cho mọi item đang gắn outcome này.
      const scale = (await this.repo.getScale(input.scaleId))!;
      const count = this.scaleValues(scale).length;
      for (const item of await this.repo.listItemsForOutcome(outcomeId)) {
        await this.repo.updateItem(item.id, { scaleid: input.scaleId, grademin: 1, grademax: Math.max(1, count) });
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
   * finalgrade là chỉ số 1-based và scaleValue là nhãn mức tương ứng trong scale.
   */
  private scaleValueFor(
    grade: GradeRow, item: ItemRow,
    outcomesById: Map<string, OutcomeRow>, scalesById: Map<string, ScaleRow>,
  ): { scaleValue: string | null; outcomeName: string | null } {
    if (grade.finalgrade === null) return { scaleValue: null, outcomeName: null };
    const outcome = item.outcomeid ? outcomesById.get(item.outcomeid) : undefined;
    const scaleId = outcome?.scaleid ?? item.scaleid;
    if (!scaleId) return { scaleValue: null, outcomeName: outcome?.name ?? null };
    const scale = scalesById.get(scaleId);
    if (!scale) return { scaleValue: null, outcomeName: outcome?.name ?? null };
    const values = this.scaleValues(scale);
    const idx = Math.round(grade.finalgrade) - 1;
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
      letter: grade.finalgrade === null ? null : letterForGrade(grade.finalgrade, item.grademin, item.grademax, letters),
    };
  }

  /**
   * Gradebook view for one target user. The viewer sees their OWN book; other
   * users' books require moodle/grade:viewall at the course context. Hidden
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
      ? await this.evaluator.hasCapability(viewerId, 'moodle/grade:viewall', await this.courses.courseContextId(courseId)).catch(() => false)
      : false;
    if (viewerId !== targetUserId) {
      await this.requireCap(viewerId, 'moodle/grade:viewall', courseId);
    } else if (!canViewAll) {
      await this.courses.assertCourseAccess(viewerId, courseId);
    }
    const seeHidden = viewerId !== targetUserId || canViewAll
      ? (viewerId === targetUserId ? canViewAll : true) : false;
    const { category: root } = await this.ensureCourseCategory(courseId);
    const categories = await this.repo.listCategories(courseId);
    const items = await this.repo.listItems(courseId);
    const grades = await this.repo.listGradesForCourse(courseId, targetUserId);
    const letters = await this.getLetters(courseId);
    const gradeByItem = new Map(grades.map((g) => [g.itemid, g]));
    const outcomesById = new Map((await this.repo.listOutcomes(courseId)).map((o) => [o.id, o]));
    const scalesById = new Map((await this.repo.listScales(courseId)).map((s) => [s.id, s]));
    // Item có thể gắn outcome/scale mức site không nằm trong listScales(courseId) khi courseId là của khoá khác? listScales đã gồm site + khoá này.
    for (const item of items) {
      if (item.scaleid && !scalesById.has(item.scaleid)) {
        const s = await this.repo.getScale(item.scaleid);
        if (s) scalesById.set(s.id, s);
      }
    }

    const viewForItem = (item: ItemRow): GradebookItemView => {
      const g = gradeByItem.get(item.id);
      const visibleGrade = g && (seeHidden || !g.hidden) ? g : undefined;
      return { item, grade: this.withLetter(visibleGrade, item, letters, outcomesById, scalesById) };
    };
    const build = (cat: CategoryRow): GradebookCategoryView => {
      const totalItem = items.find((i) => (i.itemtype === 'category' && i.iteminstance === cat.id)
        || (i.itemtype === 'course' && cat.parent === null));
      const leafItems = items.filter((i) => i.categoryid === cat.id && i.id !== totalItem?.id
        && (seeHidden || !i.hidden));
      return {
        category: cat,
        total: totalItem ? viewForItem(totalItem) : null,
        items: leafItems.map(viewForItem),
        children: categories.filter((c) => c.parent === cat.id && (seeHidden || !c.hidden)).map(build),
      };
    };
    const tree = build(root);
    return { courseId, userId: targetUserId, categories: [tree], courseTotal: tree.total };
  }

  /** Teacher report: one row per enrolled user with the course total + letter. */
  /**
   * Báo cáo điểm toàn lớp cho giáo viên.
   */
  async getReport(viewerId: string, courseId: string): Promise<{
    courseId: string; rows: {
      userId: string; finalgrade: number | null; letter: string | null;
      outcomes: { itemId: string; outcomeId: string; outcomeName: string; scaleValue: string | null; finalgrade: number | null }[];
    }[];
  }> {
    await this.requireCap(viewerId, 'moodle/grade:viewall', courseId);
    const { courseItem } = await this.ensureCourseCategory(courseId);
    const letters = await this.getLetters(courseId);
    const items = await this.repo.listItems(courseId);
    const outcomeItems = items.filter((i) => i.outcomeid);
    const outcomesById = new Map((await this.repo.listOutcomes(courseId)).map((o) => [o.id, o]));
    const scalesById = new Map((await this.repo.listScales(courseId)).map((s) => [s.id, s]));
    const enrolments = await this.enrol.listEnrolmentsForCourse(courseId);
    const userIds = [...new Set(enrolments.map((e) => e.userid))];
    const rows = [];
    for (const userId of userIds) {
      const g = await this.repo.getGrade(courseItem.id, userId);
      const outcomes = [];
      for (const item of outcomeItems) {
        const og = await this.repo.getGrade(item.id, userId);
        const outcome = outcomesById.get(item.outcomeid!);
        const view = og ? this.scaleValueFor(og, item, outcomesById, scalesById) : { scaleValue: null, outcomeName: null };
        outcomes.push({
          itemId: item.id, outcomeId: item.outcomeid!, outcomeName: outcome?.name ?? view.outcomeName ?? '',
          scaleValue: view.scaleValue, finalgrade: og?.finalgrade ?? null,
        });
      }
      rows.push({
        userId,
        finalgrade: g?.finalgrade ?? null,
        letter: g?.finalgrade !== null && g?.finalgrade !== undefined
          ? letterForGrade(g.finalgrade, courseItem.grademin, courseItem.grademax, letters) : null,
        outcomes,
      });
    }
    return { courseId, rows };
  }
}
