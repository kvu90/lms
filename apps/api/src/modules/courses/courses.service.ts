import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  course as courseTable, courseModules as courseModulesTable, courseSectionAnchorOutcomes, courseSectionAnchors,
  courseSections as courseSectionsTable,
  courseCompletionCriteria, courseCompletionSettings, courseFormatOptions, gradeCategories, gradeItems,
  gradeOutcomes, quizzes, quizSlots, scales,
} from '../../db/schema';
import type { Database } from '../../db/database';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { AvailabilityService, type AvailabilityContext } from '../availability/availability.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { CoursesRepository, type CategoryRow, type CmRow, type CourseRow, type DbTx, type SectionRow } from './courses.repository';

export const GROUPMODE_NOGROUPS = 0;
export const GROUPMODE_SEPARATEGROUPS = 1;
export const GROUPMODE_VISIBLEGROUPS = 2;
export const COURSE_COMPONENT = 'core_course';
export const COURSE_AREA = 'course';

export type CategoryDeleteMode = 'moveup' | 'recursive';

/** Trạng thái mở của section/module (K1) suy từ visible + openAt. */
export type CourseItemStatus = 'draft' | 'open' | 'scheduled';

/**
 * Suy trạng thái mở (K1): ẩn = Nháp; hiện + có ngày mở ở tương lai =
 * Mở theo lịch; còn lại = Đã mở.
 */
export function courseItemStatus(visible: boolean, openAt: Date | null, now: Date = new Date()): CourseItemStatus {
  if (!visible) return 'draft';
  if (openAt && openAt.getTime() > now.getTime()) return 'scheduled';
  return 'open';
}

/** Component có instance riêng được nhân bản sâu ở K1 (bảng instance + slot). */
export const QUIZ_COMPONENT_NAME = 'mod_quiz';

/** Registered by EnrolModule at bootstrap — keeps Courses → Enrol import-free (dependency inversion, cf. Availability registry). */
export interface EnrolChecker {
  /**
   * User có enrolment đang hiệu lực trong khoá học hay không (ủy quyền cho enrol checker đã đăng ký để tránh vòng phụ thuộc module).
   */
  isEnrolled(courseId: string, userId: string, opts?: { onlyActive?: boolean }): Promise<boolean>;
}

/** Một đơn vị khung chương trình chọn được để nạp vào khoá (K0a): node khung + toàn bộ YCCĐ trong subtree của nó. */
export interface CurriculumFrameUnit {
  nodeId: string;
  title: string;
  kind: string;
  outcomes: { outcomeId: string; content: string }[];
}

/**
 * Nguồn đơn vị khung chương trình — CurriculumModule đăng ký lúc khởi
 * tạo (dependency inversion như EnrolChecker/grade provider: Courses
 * không import ngược Curriculum). Cổng quyền của đường này là
 * `course:update` tại khoá đích do applyCurriculumFrame kiểm TRƯỚC khi
 * gọi provider — provider không đòi thêm `curriculum:view` tại context
 * hệ thống (giáo viên thật chỉ có vai tại context khoá, issue #66).
 */
export interface CurriculumFrameProvider {
  getFrameUnits(actorId: string, curriculumId: string): Promise<CurriculumFrameUnit[]>;
}

/** Một đơn vị khung SGK: một chủ đề của cuốn sách — các bài trong chủ đề là mục của section sẽ tạo. */
export interface TextbookFrameUnit {
  chapterNodeId: string;
  title: string;
  items: { lessonNodeId: string; title: string; outcomes: { outcomeId: string; content: string }[] }[];
}

/**
 * Nguồn đơn vị khung SGK — CurriculumModule đăng ký lúc khởi tạo (K0b,
 * cùng mẫu dependency inversion với CurriculumFrameProvider). Cổng
 * quyền là `course:update` tại khoá đích do applyTextbookFrame kiểm
 * TRƯỚC khi gọi provider — provider không đòi thêm quyền.
 */
export interface TextbookFrameProvider {
  getTextbookFrameUnits(actorId: string, textbookId: string): Promise<TextbookFrameUnit[]>;
}

/** Khung đã neo trên một section trong khung hiển thị nội dung khoá (bản chụp lúc nạp). */
export interface SectionFrameView {
  nodeId: string | null;
  nodeTitle: string;
  outcomes: { outcomeId: string | null; content: string }[];
}

/** Khung SGK đã neo trên một section (bản chụp lúc nạp, K0b): node chủ đề nguồn + các mục bài + YCCĐ chụp của từng mục. */
export interface SectionTextbookFrameView {
  nodeId: string | null;
  textbookId: string | null;
  nodeTitle: string;
  items: { nodeId: string | null; title: string; outcomes: { outcomeId: string | null; content: string }[] }[];
}

export interface CourseContentView {
  course: CourseRow;
  contextId: string;
  customFields: { shortName: string; value: string | null }[];
  sections: (SectionRow & {
    availabilityResult?: { available: boolean; visible: boolean; failedDescriptions: string[] };
    /** Trạng thái mở Nháp/Đã mở/Mở theo lịch (K1). */
    status?: CourseItemStatus;
    /** Neo khung chương trình (K0a): null khi section không xuất phát từ khung. */
    frame?: SectionFrameView | null;
    modules: (CmRow & { status?: CourseItemStatus; contextId?: string; availabilityResult?: { available: boolean; visible: boolean; failedDescriptions: string[] } })[];
    /** Neo khung SGK (K0b): null khi section không xuất phát từ khung SGK. */
    textbookFrame?: SectionTextbookFrameView | null;
  })[];
}

/**
 * CoursesModule facade (Moodle core_course). Categories and courses form
 * trees/contexts: every category gets a coursecat context (40), every course
 * a course context (50) under its category, every cm a module context (70)
 * under its course — created through the AccessModule facade only.
 */
@Injectable()
/**
 * Nghiệp vụ khoá học: category, course, section và course module, kèm kiểm tra truy cập.
 * Quy tắc truy cập (đối chiếu Moodle lib/accesslib + course/lib.php): khoá học ẩn chỉ xem được khi có
 * capability xem khoá ẩn; học viên phải có enrolment đang hiệu lực mới xem được nội dung;
 * section/cm còn phải qua cây điều kiện availability mới được coi là khả dụng.
 */
export class CoursesService {
  private enrolChecker?: EnrolChecker;
  /** Registered by GradesModule: grade percentages (0-100) per user+course for availability 'grade' leaves. */
  private gradeProvider?: (userId: string, courseId: string) => Promise<Record<string, number>>;
  /** Registered by CurriculumModule: đơn vị khung chương trình cho cơ chế nạp khung vào khoá (K0a). */
  private frameProvider?: CurriculumFrameProvider;
  /** Registered by CurriculumModule: đơn vị khung SGK cho cơ chế nạp khung vào khoá (K0b). */
  private textbookFrameProvider?: TextbookFrameProvider;

  /**
   * Đăng ký nguồn đơn vị khung chương trình (module curriculum cắm vào khi khởi tạo).
   */
  registerCurriculumFrameProvider(provider: CurriculumFrameProvider): void {
    this.frameProvider = provider;
  }

  /**
   * Đăng ký nguồn đơn vị khung SGK (module curriculum cắm vào khi khởi tạo).
   */
  registerTextbookFrameProvider(provider: TextbookFrameProvider): void {
    this.textbookFrameProvider = provider;
  }

  /**
   * Đăng ký provider điểm cho availability (module grades cắm vào khi khởi tạo).
   */
  registerGradeProvider(fn: (userId: string, courseId: string) => Promise<Record<string, number>>): void {
    this.gradeProvider = fn;
  }
  /**
   * Điểm hiện tại của user phục vụ điều kiện availability theo điểm.
   */
  async gradesForAvailability(userId: string, courseId: string): Promise<Record<string, number> | undefined> {
    return this.gradeProvider ? this.gradeProvider(userId, courseId) : undefined;
  }

  constructor(
    private readonly repo: CoursesRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly customFields: CustomFieldsService,
    private readonly availability: AvailabilityService,
    private readonly outbox: OutboxService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Đăng ký hàm kiểm tra enrolment (module enrol cắm vào).
   */
  registerEnrolChecker(checker: EnrolChecker): void { this.enrolChecker = checker; }

  // --- context helpers -----------------------------------------------------
  /**
   * Context id của category (tạo context nếu chưa có).
   */
  async categoryContextId(categoryId: string): Promise<string> {
    const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSECAT, categoryId);
    if (!ctx) throw new NotFoundException({ message: `No context for category ${categoryId}`, code: 'course.category_context_missing' });
    return ctx.id;
  }
  /**
   * Context id của khoá học.
   */
  async courseContextId(courseId: string): Promise<string> {
    const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, courseId);
    if (!ctx) throw new NotFoundException({ message: `No context for course ${courseId}`, code: 'course.context_missing' });
    return ctx.id;
  }
  /**
   * Context id của course module.
   */
  async cmContextId(cmId: string): Promise<string | undefined> {
    return (await this.contexts.getByLevelInstance(CONTEXT_LEVELS.MODULE, cmId))?.id;
  }

  // --- categories ------------------------------------------------------------
  /**
   * Tạo category (kiểm capability tại context cha, tính path).
   */
  async createCategory(actorId: string, input: { name: string; idNumber?: string; description?: string; parent?: string; visible?: boolean }): Promise<CategoryRow> {
    const parent = input.parent ?? null;
    let parentCtxId: string;
    if (parent === null) {
      parentCtxId = (await this.contexts.ensureSystemContext()).id;
    } else {
      const parentCat = await this.getCategory(parent);
      parentCtxId = await this.categoryContextId(parentCat.id);
    }
    await this.evaluator.requireCapability(actorId, 'category:manage', parentCtxId);
    const sortOrder = await this.repo.countSiblingCategories(parent);
    const cat = await this.repo.insertCategory({
      name: input.name, idNumber: input.idNumber ?? null, description: input.description ?? '',
      parent, sortOrder, visible: input.visible ?? true, path: '', depth: 1,
    });
    const parentRow = parent === null ? null : await this.getCategory(parent);
    const path = parentRow ? `${parentRow.path}/${cat.id}` : `/${cat.id}`;
    const depth = parentRow ? parentRow.depth + 1 : 1;
    await this.repo.updateCategoryPath(cat.id, path, depth);
    await this.contexts.createContext(CONTEXT_LEVELS.COURSECAT, cat.id, parentCtxId);
    await this.outbox.enqueueStandalone({ aggregate: 'course_category', type: 'category_created', payload: { categoryId: cat.id, parent, actorId } });
    return { ...cat, path, depth };
  }

  /**
   * Lấy category; ném course.category_not_found khi vắng.
   */
  async getCategory(id: string): Promise<CategoryRow> {
    const row = await this.repo.getCategory(id);
    if (!row) throw new NotFoundException({ message: `Category ${id} not found`, code: 'course.category_not_found' });
    return row;
  }
  /**
   * Liệt kê category.
   */
  async listCategories(): Promise<CategoryRow[]> { return this.repo.listCategories(); }

  /** Category tree for UI: nested children arrays. */
  /**
   * Cây category kèm khoá học lồng bên trong.
   */
  async categoryTree(): Promise<(CategoryRow & { children: unknown[] })[]> {
    const all = await this.repo.listCategories();
    const byId = new Map<string, CategoryRow & { children: unknown[] }>(all.map((c) => [c.id, { ...c, children: [] }]));
    const roots: (CategoryRow & { children: unknown[] })[] = [];
    for (const c of byId.values()) {
      if (c.parent !== null && byId.has(c.parent)) (byId.get(c.parent)!.children as unknown[]).push(c);
      else roots.push(c);
    }
    return roots;
  }

  /**
   * Cập nhật category; đổi cha sẽ viết lại path cây con.
   */
  async updateCategory(actorId: string, id: string, input: { name?: string; idNumber?: string; description?: string; visible?: boolean; parent?: string }): Promise<CategoryRow> {
    const cat = await this.getCategory(id);
    await this.evaluator.requireCapability(actorId, 'category:manage', await this.categoryContextId(id));
    if (input.parent !== undefined && input.parent !== cat.parent) {
      await this.moveCategory(cat, input.parent, actorId);
    }
    const patch: Partial<CategoryRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.idNumber !== undefined) patch.idNumber = input.idNumber;
    if (input.description !== undefined) patch.description = input.description;
    if (input.visible !== undefined) patch.visible = input.visible;
    if (Object.keys(patch).length) await this.repo.updateCategory(id, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'course_category', type: 'category_updated', payload: { categoryId: id, actorId } });
    return this.getCategory(id);
  }

  /** Move a category under a new parent, rewriting path/depth of the whole subtree and reparenting its context. */
  private async moveCategory(cat: CategoryRow, newParent: string | null, actorId?: string): Promise<void> {
    if (newParent === cat.id) throw new BadRequestException({ message: 'A category cannot be its own parent', code: 'course.category_cycle' });
    const subtree = await this.repo.subtreeOf(cat);
    if (subtree.some((c) => c.id === newParent)) {
      throw new BadRequestException({ message: 'A category cannot be moved under its own descendant', code: 'course.category_cycle' });
    }
    const newParentRow = newParent === null ? null : await this.getCategory(newParent);
    const oldPath = cat.path;
    const newPath = newParentRow ? `${newParentRow.path}/${cat.id}` : `/${cat.id}`;
    const depthDelta = (newParentRow ? newParentRow.depth + 1 : 1) - cat.depth;
    for (const c of subtree) {
      await this.repo.updateCategoryPath(c.id, newPath + c.path.slice(oldPath.length), c.depth + depthDelta);
    }
    await this.repo.updateCategory(cat.id, { parent: newParent });
    const ctxId = await this.categoryContextId(cat.id);
    const newParentCtxId = newParentRow ? await this.categoryContextId(newParentRow.id) : (await this.contexts.ensureSystemContext()).id;
    await this.contexts.reparentContext(ctxId, newParentCtxId);
    await this.outbox.enqueueStandalone({ aggregate: 'course_category', type: 'category_moved', payload: { categoryId: cat.id, fromParent: cat.parent, toParent: newParent, actorId: actorId ?? null } });
  }

  /**
   * Delete a category — the fate of contained courses/subcategories MUST be
   * explicit (Moodle rule, report §2#4): 'moveup' re-parents children and
   * courses to the deleted category's parent; 'recursive' deletes them.
   * Refuses (400) when the category is non-empty and no mode is given.
   */
  /**
   * Xoá category rỗng (còn khoá học/category con thì từ chối).
   */
  async deleteCategory(actorId: string, id: string, mode?: CategoryDeleteMode): Promise<{ deleted: true; mode: CategoryDeleteMode | 'empty' }> {
    const cat = await this.getCategory(id);
    await this.evaluator.requireCapability(actorId, 'category:manage', await this.categoryContextId(id));
    const children = await this.repo.childrenOf(id);
    const coursesHere = await this.repo.listCourses(id);
    if ((children.length || coursesHere.length) && !mode) {
      throw new BadRequestException({
        message: 'Category is not empty: pass mode=moveup (move contents to the parent category) or mode=recursive (delete contents)',
        code: 'course.category_not_empty',
      });
    }
    const effectiveMode: CategoryDeleteMode | 'empty' = mode ?? 'empty';
    if (mode === 'moveup' && cat.parent === null && coursesHere.length) {
      throw new BadRequestException({ message: 'Cannot move courses up from a top-level category (no parent category)', code: 'course.category_moveup_no_parent' });
    }
    if (mode === 'moveup') {
      for (const child of children) await this.moveCategory(child, cat.parent, actorId);
      for (const c of coursesHere) {
        await this.repo.updateCourse(c.id, { category: cat.parent! });
        const courseCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, c.id);
        if (courseCtx) await this.contexts.reparentContext(courseCtx.id, await this.categoryContextId(cat.parent!));
      }
    } else if (mode === 'recursive') {
      const subtree = await this.repo.subtreeOf(cat);
      for (const sub of subtree) {
        for (const c of await this.repo.listCourses(sub.id)) await this.deleteCourseInternal(c, actorId);
      }
      // Delete subcategories deepest-first (FK from course.category is cascade, courses already gone).
      for (const sub of subtree.sort((a, b) => b.depth - a.depth)) {
        if (sub.id !== id) {
          await this.contexts.deleteByLevelInstance(CONTEXT_LEVELS.COURSECAT, sub.id);
          await this.repo.deleteCategory(sub.id);
        }
      }
    }
    await this.contexts.deleteByLevelInstance(CONTEXT_LEVELS.COURSECAT, id);
    await this.repo.deleteCategory(id);
    await this.outbox.enqueueStandalone({ aggregate: 'course_category', type: 'category_deleted', payload: { categoryId: id, mode: effectiveMode, actorId } });
    return { deleted: true, mode: effectiveMode };
  }

  // --- courses ---------------------------------------------------------------
  /**
   * Tạo khoá học trong category, kèm context và category điểm gốc được tạo ở tầng grades qua hook.
   */
  async createCourse(actorId: string, input: {
    fullName: string; shortName: string; category: string; idNumber?: string; summary?: string;
    format?: string; visible?: boolean; startDate?: string; endDate?: string; groupMode?: number; groupModeForce?: boolean;
    subjectId?: string | null; grade?: number | null;
    formatOptions?: Record<string, string>; customFields?: Record<string, string>;
  }): Promise<CourseRow> {
    const category = await this.getCategory(input.category);
    const categoryCtxId = await this.categoryContextId(category.id);
    // Creating a course requires the capability in the CATEGORY context (Moodle rule).
    await this.evaluator.requireCapability(actorId, 'course:create', categoryCtxId);
    if (input.subjectId != null) await this.assertSubjectExists(input.subjectId);
    const shortName = input.shortName.trim();
    if (await this.repo.getCourseByShortname(shortName)) {
      throw new ConflictException({ message: `Course shortName ${shortName} is taken`, code: 'course.shortname_taken' });
    }
    if (input.startDate && input.endDate && new Date(input.endDate) < new Date(input.startDate)) {
      throw new BadRequestException({ message: 'Course end date is before its start date', code: 'course.invalid_dates' });
    }
    if (input.customFields) await this.customFields.validateValuesForInstance(COURSE_COMPONENT, COURSE_AREA, input.customFields);
    const siblings = await this.repo.listCourses(category.id);
    const created = await this.repo.dbHandle.transaction(async (tx) => {
      const row = await this.repo.insertCourse({
        category: category.id, fullName: input.fullName, shortName,
        idNumber: input.idNumber ?? '', summary: input.summary ?? '',
        format: input.format ?? 'topics', visible: input.visible ?? true,
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
        groupMode: input.groupMode ?? GROUPMODE_NOGROUPS, groupModeForce: input.groupModeForce ?? false, sortOrder: siblings.length,
        subjectId: input.subjectId ?? null, grade: input.grade ?? null,
      }, tx as never);
      await this.outbox.enqueue(tx as never, { aggregate: 'course', type: 'course_created', payload: { courseId: row.id, categoryId: category.id, actorId } });
      return row;
    });
    await this.contexts.createContext(CONTEXT_LEVELS.COURSE, created.id, categoryCtxId);
    // Every course starts with section 0 (general), as in Moodle.
    await this.repo.insertSection({ course: created.id, section: 0, name: null, summary: '', visible: true });
    if (input.formatOptions) {
      for (const [name, value] of Object.entries(input.formatOptions)) {
        await this.repo.setFormatOption(created.id, created.format, name, value);
      }
    }
    if (input.customFields) await this.customFields.setValuesForInstance(COURSE_COMPONENT, COURSE_AREA, created.id, input.customFields);
    return created;
  }

  /** Neo môn của khoá phải trỏ tới một môn học có thật trong cây chương trình (K0a). */
  private async assertSubjectExists(subjectId: string): Promise<void> {
    if (!(await this.repo.getSubjectById(subjectId))) {
      throw new BadRequestException({ message: `Subject ${subjectId} not found`, code: 'course.subject_not_found' });
    }
  }

  /**
   * Lấy khoá học; ném course.not_found khi vắng.
   */
  async getCourse(id: string): Promise<CourseRow> {
    const row = await this.repo.getCourse(id);
    if (!row) throw new NotFoundException({ message: `Course ${id} not found`, code: 'course.not_found' });
    return row;
  }
  /**
   * Tìm/liệt kê khoá học — khoá mẫu tổ/trường (K1) KHÔNG hiện ở danh
   * sách khoá thường; chúng chỉ được liệt kê qua `listTemplates`.
   */
  async listCourses(categoryId?: string): Promise<CourseRow[]> {
    return (await this.repo.listCourses(categoryId)).filter((c) => !c.isTemplate);
  }

  /**
   * Danh sách khoá mẫu tổ/trường cho đường 5 của wizard tạo khoá (K1).
   * Chỉ người có thể tạo khoá ở ít nhất một danh mục (hoặc quản trị hệ
   * thống) mới thấy mẫu — người không có đường tạo khoá thì danh sách
   * mẫu không có ý nghĩa và trả rỗng.
   */
  async listTemplates(actorId: string): Promise<CourseRow[]> {
    if (!(await this.evaluator.isSiteAdmin(actorId))) {
      const categories = await this.repo.listCategories();
      let canCreate = false;
      for (const cat of categories) {
        const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSECAT, cat.id);
        if (ctx && (await this.evaluator.hasCapability(actorId, 'course:create', ctx.id))) { canCreate = true; break; }
      }
      if (!canCreate) return [];
    }
    return this.repo.listTemplateCourses();
  }
  /**
   * Tuỳ chọn định dạng của khoá học.
   */
  async getFormatOptions(courseId: string): Promise<(typeof import('../../db/schema').courseFormatOptions.$inferSelect)[]> {
    return this.repo.listFormatOptions(courseId);
  }
  /**
   * Giá trị trường tuỳ biến của khoá học.
   */
  async getCourseCustomFields(courseId: string): Promise<{ shortName: string; value: string | null }[]> {
    const values = await this.customFields.getValuesForInstance(COURSE_COMPONENT, COURSE_AREA, courseId);
    return values.map((v) => ({ shortName: v.field.shortName, value: v.value }));
  }

  /**
   * Cập nhật khoá học (shortName giữ duy nhất).
   */
  async updateCourse(actorId: string, id: string, input: {
    fullName?: string; shortName?: string; category?: string; idNumber?: string; summary?: string;
    format?: string; visible?: boolean; startDate?: string | null; endDate?: string | null; groupMode?: number; groupModeForce?: boolean;
    subjectId?: string | null; grade?: number | null; isTemplate?: boolean;
    formatOptions?: Record<string, string>; customFields?: Record<string, string>;
  }): Promise<CourseRow> {
    const existing = await this.getCourse(id);
    await this.evaluator.requireCapability(actorId, 'course:update', await this.courseContextId(id));
    if (input.shortName !== undefined && input.shortName.trim() !== existing.shortName) {
      if (await this.repo.getCourseByShortname(input.shortName.trim())) {
        throw new ConflictException({ message: `Course shortName ${input.shortName} is taken`, code: 'course.shortname_taken' });
      }
    }
    if (input.customFields) await this.customFields.validateValuesForInstance(COURSE_COMPONENT, COURSE_AREA, input.customFields);
    const patch: Partial<CourseRow> = {};
    if (input.fullName !== undefined) patch.fullName = input.fullName;
    if (input.shortName !== undefined) patch.shortName = input.shortName.trim();
    if (input.idNumber !== undefined) patch.idNumber = input.idNumber;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.format !== undefined) patch.format = input.format;
    if (input.visible !== undefined) patch.visible = input.visible;
    if (input.startDate !== undefined) patch.startDate = input.startDate ? new Date(input.startDate) : null;
    if (input.endDate !== undefined) patch.endDate = input.endDate ? new Date(input.endDate) : null;
    if (input.groupMode !== undefined) patch.groupMode = input.groupMode;
    if (input.groupModeForce !== undefined) patch.groupModeForce = input.groupModeForce;
    if (input.subjectId !== undefined) {
      if (input.subjectId !== null) await this.assertSubjectExists(input.subjectId);
      patch.subjectId = input.subjectId;
    }
    if (input.grade !== undefined) patch.grade = input.grade;
    if (input.isTemplate !== undefined) patch.isTemplate = input.isTemplate;
    if (input.category !== undefined && input.category !== existing.category) {
      const newCategory = await this.getCategory(input.category);
      patch.category = newCategory.id;
    }
    if (Object.keys(patch).length) await this.repo.updateCourse(id, patch);
    if (patch.category !== undefined) {
      const courseCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, id);
      if (courseCtx) await this.contexts.reparentContext(courseCtx.id, await this.categoryContextId(patch.category));
    }
    if (input.formatOptions) {
      const fmt = input.format ?? existing.format;
      for (const [name, value] of Object.entries(input.formatOptions)) await this.repo.setFormatOption(id, fmt, name, value);
    }
    if (input.customFields) await this.customFields.setValuesForInstance(COURSE_COMPONENT, COURSE_AREA, id, input.customFields);
    await this.outbox.enqueueStandalone({ aggregate: 'course', type: 'course_updated', payload: { courseId: id, actorId } });
    return this.getCourse(id);
  }

  /**
   * Xoá khoá học và dữ liệu phụ thuộc qua sự kiện/hook của các module khác.
   */
  async deleteCourse(actorId: string, id: string): Promise<void> {
    const courseRow = await this.getCourse(id);
    await this.evaluator.requireCapability(actorId, 'course:delete', await this.courseContextId(id));
    await this.deleteCourseInternal(courseRow, actorId);
  }

  /** Delete without a capability re-check (category recursive delete already checked the category capability). */
  private async deleteCourseInternal(courseRow: CourseRow, actorId?: string): Promise<void> {
    const cms = await this.repo.listCms(courseRow.id);
    for (const cm of cms) await this.emitCmDeleted(cm, actorId);
    await this.contexts.deleteByLevelInstance(CONTEXT_LEVELS.COURSE, courseRow.id);
    await this.repo.deleteCourse(courseRow.id);
    await this.outbox.enqueueStandalone({ aggregate: 'course', type: 'course_deleted', payload: { courseId: courseRow.id, actorId: actorId ?? null } });
  }

  // --- access gate -------------------------------------------------------------
  /**
   * The course-content gate (report §2#5): enrolment and capability are
   * INDEPENDENT conditions. Access = site admin, OR an ACTIVE enrolment, OR
   * a real (non-student) role assignment granting course:view.
   * A suspended enrolment therefore blocks even a user who holds the student
   * role — the role alone never opens the course.
   */
  /**
   * Cổng truy cập khoá học: ẩn + chưa enrol + thiếu capability → course.access_denied.
   */
  async assertCourseAccess(userId: string, courseId: string): Promise<CourseRow> {
    const courseRow = await this.getCourse(courseId);
    if (await this.evaluator.isSiteAdmin(userId)) return courseRow;
    const ctxId = await this.courseContextId(courseId);
    if (!courseRow.visible && !(await this.evaluator.hasCapability(userId, 'course:viewhiddencourses', ctxId))) {
      throw new ForbiddenException({ message: 'Course is hidden', code: 'course.hidden' });
    }
    if (this.enrolChecker && (await this.enrolChecker.isEnrolled(courseId, userId, { onlyActive: true }))) return courseRow;
    if (await this.evaluator.hasCapabilityFromRealAssignment(userId, 'course:view', ctxId, { excludeArchetypes: ['student'] })) return courseRow;
    throw new ForbiddenException({ message: 'User is not enrolled in this course (or the enrolment is not active)', code: 'course.not_enrolled' });
  }

  /**
   * User có capability xem hoạt động ẩn trong khoá học hay không.
   */
  async canViewHiddenActivities(userId: string, courseId: string): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    return this.evaluator.hasCapability(userId, 'course:viewhiddenactivities', await this.courseContextId(courseId));
  }

  // --- sections & modules ------------------------------------------------------
  /**
   * Thêm section vào khoá học.
   */
  async createSection(actorId: string, courseId: string, input: { name?: string; summary?: string; visible?: boolean; availability?: unknown; openAt?: string | null }): Promise<SectionRow> {
    await this.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'course:update', await this.courseContextId(courseId));
    if (input.availability !== undefined) this.availability.parse(input.availability);
    const existing = await this.repo.listSections(courseId);
    const nextNumber = existing.length ? Math.max(...existing.map((s) => s.section)) + 1 : 0;
    return this.repo.insertSection({
      course: courseId, section: nextNumber, name: input.name ?? null,
      summary: input.summary ?? '', visible: input.visible ?? true,
      availability: (input.availability ?? null) as never,
      openAt: input.openAt ? new Date(input.openAt) : null,
    });
  }
  /**
   * Lấy section; ném course.section_not_found khi vắng.
   */
  async getSection(id: string): Promise<SectionRow> {
    const row = await this.repo.getSection(id);
    if (!row) throw new NotFoundException({ message: `Section ${id} not found`, code: 'course.section_not_found' });
    return row;
  }
  /**
   * Liệt kê section của khoá học.
   */
  async listSections(courseId: string): Promise<SectionRow[]> { return this.repo.listSections(courseId); }
  /**
   * Cập nhật section (gồm cây availability dạng JSON).
   */
  async updateSection(actorId: string, id: string, input: { name?: string; summary?: string; visible?: boolean; availability?: unknown; openAt?: string | null }): Promise<SectionRow> {
    const section = await this.getSection(id);
    await this.evaluator.requireCapability(actorId, 'course:update', await this.courseContextId(section.course));
    if (input.availability !== undefined) this.availability.parse(input.availability);
    const patch: Partial<SectionRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.visible !== undefined) patch.visible = input.visible;
    if (input.availability !== undefined) patch.availability = input.availability as never;
    if (input.openAt !== undefined) patch.openAt = input.openAt ? new Date(input.openAt) : null;
    if (Object.keys(patch).length) await this.repo.updateSection(id, patch);
    return this.getSection(id);
  }
  /**
   * Xoá section.
   */
  async deleteSection(actorId: string, id: string): Promise<void> {
    const section = await this.getSection(id);
    await this.evaluator.requireCapability(actorId, 'course:update', await this.courseContextId(section.course));
    const cms = await this.repo.listCmsInSection(id);
    for (const cm of cms) await this.deleteCmInternal(cm, actorId);
    await this.repo.deleteSection(id);
  }

  /**
   * Thêm course module (hoạt động/tài nguyên) vào section.
   */
  async createCm(actorId: string, courseId: string, input: {
    sectionId: string; component: string; instanceId?: string; name?: string; visible?: boolean; groupMode?: number;
    availability?: unknown; completion?: number; completionView?: boolean; completionUseGrade?: boolean;
    completionManual?: boolean; completionExpected?: string; openAt?: string | null;
  }): Promise<CmRow> {
    const courseRow = await this.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'course:manageactivities', await this.courseContextId(courseId));
    const section = await this.getSection(input.sectionId);
    if (section.course !== courseId) throw new BadRequestException({ message: 'Section does not belong to this course', code: 'course.section_course_mismatch' });
    if (input.availability !== undefined) this.availability.parse(input.availability);
    // Module mới luôn nối cuối outline của section (K1: sortOrder tường minh).
    const siblings = await this.repo.listCmsInSection(section.id);
    const sortOrder = siblings.length ? Math.max(...siblings.map((c) => c.sortOrder)) + 1 : 0;
    const cm = await this.repo.insertCm({
      course: courseId, section: section.id, component: input.component, instanceId: input.instanceId ?? null,
      name: input.name ?? '', visible: input.visible ?? true, groupMode: input.groupMode ?? 0,
      availability: (input.availability ?? null) as never,
      completion: input.completion ?? (input.completionManual ? 1 : 0),
      completionView: input.completionView ?? false, completionUseGrade: input.completionUseGrade ?? false,
      completionManual: input.completionManual ?? false,
      completionExpected: input.completionExpected ? new Date(input.completionExpected) : null,
      openAt: input.openAt ? new Date(input.openAt) : null,
      sortOrder,
    });
    const courseCtxId = await this.courseContextId(courseId);
    await this.contexts.createContext(CONTEXT_LEVELS.MODULE, cm.id, courseCtxId);
    await this.outbox.enqueueStandalone({ aggregate: 'course_module', type: 'cm_created', payload: { cmId: cm.id, courseId, component: cm.component, instanceId: cm.instanceId, actorId } });
    void courseRow;
    return cm;
  }
  /**
   * Lấy cm; ném course.module_not_found khi vắng.
   */
  async getCm(id: string): Promise<CmRow> {
    const row = await this.repo.getCm(id);
    if (!row) throw new NotFoundException({ message: `Course module ${id} not found`, code: 'course.cm_not_found' });
    return row;
  }
  /**
   * Liệt kê cm của khoá học.
   */
  async listCms(courseId: string): Promise<CmRow[]> { return this.repo.listCms(courseId); }
  /**
   * Cập nhật cm (gồm availability và completion kỳ vọng).
   */
  async updateCm(actorId: string, id: string, input: {
    name?: string; visible?: boolean; groupMode?: number; availability?: unknown; completion?: number;
    completionView?: boolean; completionUseGrade?: boolean; completionManual?: boolean; completionExpected?: string | null; openAt?: string | null; sectionId?: string;
  }): Promise<CmRow> {
    const cm = await this.getCm(id);
    await this.evaluator.requireCapability(actorId, 'course:manageactivities', await this.courseContextId(cm.course));
    if (input.availability !== undefined) this.availability.parse(input.availability);
    const patch: Partial<CmRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.visible !== undefined) patch.visible = input.visible;
    if (input.groupMode !== undefined) patch.groupMode = input.groupMode;
    if (input.availability !== undefined) patch.availability = input.availability as never;
    if (input.completion !== undefined) patch.completion = input.completion;
    if (input.completionView !== undefined) patch.completionView = input.completionView;
    if (input.completionUseGrade !== undefined) patch.completionUseGrade = input.completionUseGrade;
    if (input.completionManual !== undefined) patch.completionManual = input.completionManual;
    if (input.completionExpected !== undefined) patch.completionExpected = input.completionExpected ? new Date(input.completionExpected) : null;
    if (input.openAt !== undefined) patch.openAt = input.openAt ? new Date(input.openAt) : null;
    if (input.sectionId !== undefined) {
      const section = await this.getSection(input.sectionId);
      if (section.course !== cm.course) throw new BadRequestException({ message: 'Section does not belong to this course', code: 'course.section_course_mismatch' });
      patch.section = section.id;
    }
    if (Object.keys(patch).length) await this.repo.updateCm(id, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'course_module', type: 'cm_updated', payload: { cmId: id, courseId: cm.course, actorId } });
    return this.getCm(id);
  }

  private async emitCmDeleted(cm: CmRow, actorId?: string): Promise<void> {
    const contextId = await this.cmContextId(cm.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'course_module', type: 'cm_deleted',
      payload: { cmId: cm.id, courseId: cm.course, contextId: contextId ?? null, component: cm.component, instanceId: cm.instanceId, actorId: actorId ?? null },
    });
    // In-process delivery for the owning modules' handlers (completion, files);
    // handlers are idempotent, so the durable outbox relay may replay safely.
    await this.emitter.emitAsync('cm_deleted', { cmId: cm.id, courseId: cm.course, contextId: contextId ?? null, component: cm.component, instanceId: cm.instanceId });
    if (contextId) await this.contexts.deleteContext(contextId);
  }

  private async deleteCmInternal(cm: CmRow, actorId?: string): Promise<void> {
    await this.emitCmDeleted(cm, actorId);
    await this.repo.deleteCm(cm.id);
  }
  /**
   * Xoá cm và phát sự kiện để module liên quan dọn dữ liệu.
   */
  async deleteCm(actorId: string, id: string): Promise<void> {
    const cm = await this.getCm(id);
    await this.evaluator.requireCapability(actorId, 'course:manageactivities', await this.courseContextId(cm.course));
    await this.deleteCmInternal(cm, actorId);
  }

  /**
   * Record that a user viewed a cm: enqueues the durable `cm_viewed` outbox
   * event AND delivers it in-process so CompletionModule's listener writes
   * the completionView state (handlers are idempotent).
   */
  /**
   * Ghi nhận lượt xem cm — đầu vào của completion theo lượt xem.
   */
  async recordCmView(userId: string, cmId: string): Promise<CmRow> {
    const cm = await this.getCm(cmId);
    await this.assertCourseAccess(userId, cm.course);
    const access = await this.checkCmAccess(userId, cm);
    if (!access.available) throw new ForbiddenException({ message: 'This activity is not available to you yet', code: 'availability.not_available' });
    await this.outbox.enqueueStandalone({ aggregate: 'course_module', type: 'cm_viewed', payload: { cmId, courseId: cm.course, userId, actorId: userId } });
    await this.emitter.emitAsync('cm_viewed', { cmId, courseId: cm.course, userId });
    return cm;
  }

  /** Server-side availability check for one cm (section availability AND cm availability must both pass). */
  /**
   * Đánh giá truy cập một cm: hiển thị (show) tách khỏi khả dụng (available) theo semantics availability của Moodle.
   */
  async checkCmAccess(userId: string, cm: CmRow, grades?: Record<string, number>): Promise<{ available: boolean; visible: boolean; failedDescriptions: string[] }> {
    const resolvedGrades = grades ?? (this.gradeProvider ? await this.gradesForAvailability(userId, cm.course) : undefined);
    const ctx: AvailabilityContext = { userId, courseId: cm.course, grades: resolvedGrades };
    const section = await this.repo.getSection(cm.section);
    if (section?.availability) {
      const s = await this.availability.evaluate(section.availability, ctx);
      if (!s.available) return { available: false, visible: s.visible, failedDescriptions: s.failedDescriptions };
    }
    // Ngày mở theo lịch của section (K1): chưa tới ngày thì học viên
    // không thấy mục con bên trong, trừ người xem được hoạt động ẩn.
    if (section?.openAt && section.openAt.getTime() > Date.now()) {
      const canSeeHidden = await this.canViewHiddenActivities(userId, cm.course);
      if (!canSeeHidden) return { available: false, visible: false, failedDescriptions: [] };
    }
    // Ngày mở theo lịch của chính module (K1).
    if (cm.openAt && cm.openAt.getTime() > Date.now()) {
      const canSeeHidden = await this.canViewHiddenActivities(userId, cm.course);
      if (!canSeeHidden) return { available: false, visible: false, failedDescriptions: [] };
    }
    if (!cm.visible) {
      const canSeeHidden = await this.canViewHiddenActivities(userId, cm.course);
      if (!canSeeHidden) return { available: false, visible: false, failedDescriptions: [] };
    }
    if (section && !section.visible) {
      const canSeeHidden = await this.canViewHiddenActivities(userId, cm.course);
      if (!canSeeHidden) return { available: false, visible: false, failedDescriptions: [] };
    }
    const r = await this.availability.evaluate(cm.availability, ctx);
    return { available: r.available, visible: r.visible, failedDescriptions: r.failedDescriptions };
  }

  /**
   * Đánh giá truy cập một section theo cây availability của nó.
   */
  async checkSectionAccess(userId: string, section: SectionRow, grades?: Record<string, number>): Promise<{ available: boolean; visible: boolean; failedDescriptions: string[] }> {
    if (!section.visible && !(await this.canViewHiddenActivities(userId, section.course))) {
      return { available: false, visible: false, failedDescriptions: [] };
    }
    // Ngày mở theo lịch (K1): section chưa tới ngày mở thì học viên
    // không xem được, người xem được hoạt động ẩn vẫn thấy để soạn.
    if (section.openAt && section.openAt.getTime() > Date.now() && !(await this.canViewHiddenActivities(userId, section.course))) {
      return { available: false, visible: false, failedDescriptions: [] };
    }
    const resolvedGrades = grades ?? (this.gradeProvider ? await this.gradesForAvailability(userId, section.course) : undefined);
    const r = await this.availability.evaluate(section.availability, { userId, courseId: section.course, grades: resolvedGrades });
    return { available: r.available, visible: r.visible, failedDescriptions: r.failedDescriptions };
  }

  /**
   * Nạp khung chương trình vào khoá (K0a — bản sao có neo): mỗi node
   * khung được chọn thành một section mới mang tựa của node và toàn bộ
   * YCCĐ trong subtree của nó, chụp nguyên văn vào neo. `insertAtSection`
   * chèn trước section mang số đó (đẩy các section từ đó xuống cuối
   * đoạn chèn), bỏ trống thì nối cuối outline. Sửa cây chương trình sau
   * đó không đổi các section đã nạp vì chúng đọc từ bản chụp.
   * Nạp lại là IDEMPOTENT theo node: node đã có section neo trong khoá
   * (từ chính khung này) thì bỏ qua — không sinh section trùng, không
   * dịch outline — và kết quả chỉ gồm các section thật sự vừa tạo.
   * Quyền: course:update tại context khoá đích là cổng duy nhất của
   * đường nạp khung (provider khung tin cậy cổng này — xem
   * CurriculumFrameProvider).
   */
  async applyCurriculumFrame(actorId: string, courseId: string, input: {
    curriculumId: string; nodeIds: string[]; insertAtSection?: number;
  }): Promise<(SectionRow & { frame: SectionFrameView })[]> {
    await this.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'course:update', await this.courseContextId(courseId));
    if (!this.frameProvider) {
      throw new BadRequestException({ message: 'Curriculum frame provider is not registered', code: 'course.frame_provider_missing' });
    }
    const units = await this.frameProvider.getFrameUnits(actorId, input.curriculumId);
    const wanted = new Set(input.nodeIds);
    const selected = units.filter((u) => wanted.has(u.nodeId));
    if (selected.length !== wanted.size) {
      const found = new Set(selected.map((u) => u.nodeId));
      const missing = input.nodeIds.filter((id) => !found.has(id));
      throw new BadRequestException({
        message: `Frame nodes not selectable in this curriculum: ${missing.join(', ')}`,
        code: 'course.frame_node_not_selectable',
      });
    }
    const existing = await this.repo.listSections(courseId);
    // Idempotent theo node: node đã neo vào một section của khoá này
    // (từ chính khung đang nạp) thì bỏ qua, không tạo section trùng.
    const existingAnchors = await this.repo.listAnchorsForSections(existing.map((s) => s.id));
    const alreadyApplied = new Set(
      existingAnchors.filter((a) => a.curriculumId === input.curriculumId).map((a) => a.nodeId),
    );
    const fresh = selected.filter((u) => !alreadyApplied.has(u.nodeId));
    if (fresh.length === 0) return [];
    const maxSection = existing.length ? Math.max(...existing.map((s) => s.section)) : -1;
    const insertAt = input.insertAtSection ?? maxSection + 1;
    if (insertAt > maxSection + 1) {
      throw new BadRequestException({
        message: `insertAtSection ${insertAt} is beyond the end of the outline`,
        code: 'course.frame_insert_beyond_end',
      });
    }
    const count = fresh.length;
    const created: (SectionRow & { frame: SectionFrameView })[] = [];
    await this.repo.dbHandle.transaction(async (tx) => {
      const handle = tx as never;
      if (input.insertAtSection !== undefined && insertAt <= maxSection) {
        // Hai pass qua vùng đệm +100000 để unique (course, section) không vỡ giữa chừng.
        await this.repo.shiftSections(handle, courseId, insertAt, 100000);
        await this.repo.shiftSections(handle, courseId, insertAt + 100000, count - 100000);
      }
      for (const [i, unit] of fresh.entries()) {
        const section = await this.repo.insertSection({
          course: courseId, section: insertAt + i, name: unit.title, summary: '', visible: true,
        }, handle);
        const anchor = await this.repo.insertSectionAnchor({
          sectionId: section.id, nodeId: unit.nodeId, curriculumId: input.curriculumId, nodeTitle: unit.title,
        }, handle);
        await this.repo.insertSectionAnchorOutcomes(
          unit.outcomes.map((o, j) => ({ anchorId: anchor.id, outcomeId: o.outcomeId, content: o.content, position: j + 1 })),
          handle,
        );
        created.push({
          ...section,
          frame: {
            nodeId: unit.nodeId, nodeTitle: unit.title,
            outcomes: unit.outcomes.map((o) => ({ outcomeId: o.outcomeId, content: o.content })),
          },
        });
      }
    });
    return created;
  }

  // --- K1: nhân bản & dùng lại nội dung -------------------------------------
  /**
   * Dịch một mốc thời gian theo delta nhân bản (null giữ nguyên null).
   */
  private shiftDate(d: Date | null, deltaMs: number): Date | null {
    if (!d || deltaMs === 0) return d;
    return new Date(d.getTime() + deltaMs);
  }

  /**
   * Dịch mọi lá `date` trong cây availability theo delta nhân bản: lá
   * date của hệ thống mang `time` là epoch giây (số) hoặc chuỗi ISO —
   * dịch đúng định dạng gốc, các lá khác giữ nguyên.
   */
  private shiftAvailability(node: unknown, deltaMs: number): unknown {
    if (deltaMs === 0 || node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((n) => this.shiftAvailability(n, deltaMs));
    const rec = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = this.shiftAvailability(v, deltaMs);
    if (rec.type === 'date') {
      if (typeof rec.time === 'number') out.time = rec.time + Math.round(deltaMs / 1000);
      else if (typeof rec.time === 'string') {
        const parsed = Date.parse(rec.time);
        if (!Number.isNaN(parsed)) out.time = new Date(parsed + deltaMs).toISOString();
      }
    }
    return out;
  }

  /**
   * Quyền đọc nội dung khoá nguồn cho các đường sao chép (K1): qua
   * cổng truy cập thường lệ, hoặc người có `course:update` tại khoá
   * nguồn (giáo viên soạn khoá nhưng chưa/không cần ghi danh).
   */
  private async assertCanCopyFrom(actorId: string, sourceCourseId: string): Promise<CourseRow> {
    const source = await this.getCourse(sourceCourseId);
    try {
      await this.assertCourseAccess(actorId, sourceCourseId);
      return source;
    } catch {
      const ctxId = await this.courseContextId(sourceCourseId);
      if (await this.evaluator.hasCapability(actorId, 'course:update', ctxId)) return source;
      throw new ForbiddenException({ message: 'User cannot access the source course content', code: 'course.copy_source_denied' });
    }
  }

  /**
   * Sao chép một course module sang khoá/section đích trong cùng
   * transaction: instance của quiz được nhân bản sâu (bảng quiz + toàn
   * bộ slot, KHÔNG chép lượt làm bài); các component khác hiện không có
   * bảng instance riêng do module sở hữu tạo qua API nên giữ nguyên
   * `instanceId` (thực tế là null). Trả cm mới và ghi map id.
   */
  private async copyCmRow(
    tx: DbTx, source: CmRow, targetCourseId: string, targetSectionId: string,
    deltaMs: number, cmMap: Map<string, string>,
  ): Promise<CmRow> {
    const db = tx as unknown as Database;
    let instanceId = source.instanceId;
    if (source.component === QUIZ_COMPONENT_NAME && source.instanceId) {
      const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, source.instanceId));
      if (quiz) {
        const [newQuiz] = await db.insert(quizzes).values({
          course: targetCourseId, cmId: null, name: quiz.name, intro: quiz.intro,
          timeOpen: this.shiftDate(quiz.timeOpen, deltaMs), timeClose: this.shiftDate(quiz.timeClose, deltaMs),
          timeLimit: quiz.timeLimit, attemptsAllowed: quiz.attemptsAllowed, gradeMethod: quiz.gradeMethod,
          grade: quiz.grade, shuffleAnswers: quiz.shuffleAnswers,
        }).returning();
        const slots = await db.select().from(quizSlots).where(eq(quizSlots.quizId, quiz.id)).orderBy(asc(quizSlots.slot));
        for (const s of slots) {
          await db.insert(quizSlots).values({
            quizId: newQuiz!.id, slot: s.slot, page: s.page, questionId: s.questionId, categoryId: s.categoryId, maxMark: s.maxMark,
          });
        }
        instanceId = newQuiz!.id;
      }
    }
    const [created] = await db.insert(courseModulesTable).values({
      course: targetCourseId, section: targetSectionId, component: source.component, instanceId,
      name: source.name, visible: source.visible, groupMode: source.groupMode,
      availability: (source.availability ? this.shiftAvailability(source.availability, deltaMs) : null) as never,
      completion: source.completion, completionView: source.completionView,
      completionUseGrade: source.completionUseGrade, completionManual: source.completionManual,
      completionExpected: this.shiftDate(source.completionExpected, deltaMs),
      openAt: this.shiftDate(source.openAt, deltaMs),
      sortOrder: source.sortOrder,
    }).returning();
    const newCm = created as CmRow;
    cmMap.set(source.id, newCm.id);
    if (source.component === QUIZ_COMPONENT_NAME && instanceId && instanceId !== source.instanceId) {
      await db.update(quizzes).set({ cmId: newCm.id }).where(eq(quizzes.id, instanceId));
    }
    // Context module cho cm mới (như createCm) — contexts nằm ngoài tx
    // của courses trong luồng tạo thường; ở đây tạo sau khi tx commit
    // qua danh sách chờ của caller là không khả thi, nên tạo trực tiếp:
    // ContextsService dùng cùng kết nối DB nền, chấp nhận được.
    await this.contexts.createContext(CONTEXT_LEVELS.MODULE, newCm.id, await this.courseContextId(targetCourseId));
    return newCm;
  }

  /**
   * Sao chép một section (kèm neo khung + toàn bộ cm) vào khoá đích tại
   * số section chỉ định, trong cùng transaction. Trả section mới.
   */
  private async copySectionRow(
    tx: DbTx, source: SectionRow, targetCourseId: string, targetNumber: number,
    deltaMs: number, cmMap: Map<string, string>,
  ): Promise<SectionRow> {
    const db = tx as unknown as Database;
    const [created] = await db.insert(courseSectionsTable).values({
      course: targetCourseId, section: targetNumber, name: source.name, summary: source.summary,
      visible: source.visible,
      availability: (source.availability ? this.shiftAvailability(source.availability, deltaMs) : null) as never,
      openAt: this.shiftDate(source.openAt, deltaMs),
    }).returning();
    const newSection = created as SectionRow;
    const anchors = await this.repo.listAnchorsForSections([source.id]);
    const anchor = anchors[0];
    if (anchor) {
      const outcomes = await this.repo.listAnchorOutcomes([anchor.id]);
      const [newAnchor] = await db.insert(courseSectionAnchors).values({
        sectionId: newSection.id, nodeId: anchor.nodeId, curriculumId: anchor.curriculumId, nodeTitle: anchor.nodeTitle,
      }).returning();
      if (outcomes.length) {
        await db.insert(courseSectionAnchorOutcomes).values(outcomes.map((o) => ({
          anchorId: newAnchor!.id, outcomeId: o.outcomeId, content: o.content, position: o.position,
        })));
      }
    }
    const cms = await this.repo.listCmsInSection(source.id);
    for (const cm of cms) await this.copyCmRow(tx, cm, targetCourseId, newSection.id, deltaMs, cmMap);
    return newSection;
  }

  /**
   * Sao chép cấu trúc điểm (chính sách điểm) của khoá nguồn sang khoá
   * đích: scale cấp khoá, outcome, cây category điểm, toàn bộ grade
   * item (map lại instance/category/course) — KHÔNG chép điểm của học
   * viên (grade_grades), theo đúng bảng sao chép Re-run của issue #68.
   */
  private async copyGradeStructure(
    tx: DbTx, sourceCourseId: string, targetCourseId: string, cmMap: Map<string, string>, deltaMs = 0,
  ): Promise<void> {
    const db = tx as unknown as Database;
    const scaleMap = new Map<string, string>();
    const sourceScales = await db.select().from(scales).where(eq(scales.courseId, sourceCourseId));
    for (const s of sourceScales) {
      const [row] = await db.insert(scales).values({ courseId: targetCourseId, name: s.name, scale: s.scale, description: s.description }).returning();
      scaleMap.set(s.id, row!.id);
    }
    const outcomeMap = new Map<string, string>();
    const sourceOutcomes = await db.select().from(gradeOutcomes).where(eq(gradeOutcomes.courseId, sourceCourseId));
    for (const o of sourceOutcomes) {
      const [row] = await db.insert(gradeOutcomes).values({
        courseId: targetCourseId, scaleId: scaleMap.get(o.scaleId) ?? o.scaleId, name: o.name, description: o.description,
      }).returning();
      outcomeMap.set(o.id, row!.id);
    }
    const categoryMap = new Map<string, string>();
    const sourceCategories = (await db.select().from(gradeCategories).where(eq(gradeCategories.courseId, sourceCourseId)))
      .sort((a: { depth: number }, b: { depth: number }) => a.depth - b.depth);
    const newPathByOldId = new Map<string, string>();
    for (const cat of sourceCategories) {
      const newParent = cat.parent ? categoryMap.get(cat.parent) ?? null : null;
      if (cat.parent && !newParent) continue;
      const [row] = await db.insert(gradeCategories).values({
        courseId: targetCourseId, parent: newParent, fullName: cat.fullName, aggregation: cat.aggregation,
        dropLow: cat.dropLow, keepHigh: cat.keepHigh, aggregateOnlyGraded: cat.aggregateOnlyGraded,
        depth: cat.depth, path: '', hidden: cat.hidden,
      }).returning();
      categoryMap.set(cat.id, row!.id);
      const parentPath = cat.parent ? newPathByOldId.get(cat.parent) ?? '' : '';
      const path = `${parentPath}/${row!.id}`;
      newPathByOldId.set(cat.id, path);
      await db.update(gradeCategories).set({ path }).where(eq(gradeCategories.id, row!.id));
    }
    const sourceItems = await db.select().from(gradeItems).where(eq(gradeItems.courseId, sourceCourseId));
    for (const item of sourceItems) {
      let itemInstance = item.itemInstance;
      if (item.itemType === 'mod') {
        itemInstance = item.itemInstance ? cmMap.get(item.itemInstance) ?? null : null;
        if (!itemInstance) continue; // cm không được chép (không xảy ra ở nhân bản toàn khoá) — bỏ item mồ côi.
      } else if (item.itemType === 'category') {
        itemInstance = item.itemInstance ? categoryMap.get(item.itemInstance) ?? null : null;
      } else if (item.itemType === 'course') {
        itemInstance = targetCourseId;
      }
      await db.insert(gradeItems).values({
        courseId: targetCourseId,
        categoryId: item.categoryId ? categoryMap.get(item.categoryId) ?? null : null,
        itemName: item.itemName, itemType: item.itemType, itemModule: item.itemModule, itemInstance,
        gradeType: item.gradeType, gradeMax: item.gradeMax, gradeMin: item.gradeMin, gradePass: item.gradePass,
        scaleId: item.scaleId ? scaleMap.get(item.scaleId) ?? item.scaleId : null,
        outcomeId: item.outcomeId ? outcomeMap.get(item.outcomeId) ?? item.outcomeId : null,
        idNumber: item.idNumber, calculation: item.calculation, weightOverride: item.weightOverride,
        aggregationCoef: item.aggregationCoef, extraCredit: item.extraCredit, multiplicator: item.multiplicator,
        plusFactor: item.plusFactor, hidden: item.hidden, locked: item.locked, sortOrder: item.sortOrder,
      });
    }
    // Cài đặt tổng hợp hoàn thành khoá + tiêu chí hoàn thành (cấu trúc, không phải tiến độ).
    const [settings] = await db.select().from(courseCompletionSettings).where(eq(courseCompletionSettings.course, sourceCourseId));
    if (settings) {
      await db.insert(courseCompletionSettings).values({ course: targetCourseId, method: settings.method }).onConflictDoNothing();
    }
    const criteria = await db.select().from(courseCompletionCriteria).where(eq(courseCompletionCriteria.course, sourceCourseId));
    for (const c of criteria) {
      await db.insert(courseCompletionCriteria).values({
        course: targetCourseId, criteriaType: c.criteriaType,
        moduleInstance: c.moduleInstance ? cmMap.get(c.moduleInstance) ?? null : null,
        date: this.shiftDate(c.date, deltaMs), courseInstance: c.courseInstance === sourceCourseId ? targetCourseId : c.courseInstance,
        enrolPeriodDays: c.enrolPeriodDays, roleId: c.roleId, sortOrder: c.sortOrder,
      });
    }
  }

  /**
   * Nhân bản khoá học (đường 3 của wizard K1 + nhân bản từ mẫu): sao
   * chép theo bảng Re-run của issue #68 — cấu trúc (section/cm kèm
   * instance quiz), cài đặt khoá, chính sách điểm, tiêu chí hoàn thành,
   * neo khung chương trình, trường tuỳ biến; KHÔNG chép người học, ghi
   * danh, lượt làm bài, điểm và tiến độ. Bản sao luôn ở trạng thái nháp
   * (visible=false); khi có `startDate` mới, mọi mốc hạn trong khoá
   * (ngày kết thúc, ngày mở, hạn hoàn thành, giờ mở/đóng quiz, lá date
   * trong availability) lùi theo delta so với ngày bắt đầu của nguồn.
   * Quyền: đọc được nội dung nguồn + `course:create` tại danh mục đích.
   */
  async duplicateCourse(actorId: string, sourceCourseId: string, input: {
    fullName: string; shortName: string; category?: string; startDate?: string;
  }): Promise<CourseRow> {
    const source = await this.assertCanCopyFrom(actorId, sourceCourseId);
    const targetCategory = input.category ? await this.getCategory(input.category) : await this.getCategory(source.category);
    const categoryCtxId = await this.categoryContextId(targetCategory.id);
    await this.evaluator.requireCapability(actorId, 'course:create', categoryCtxId);
    const shortName = input.shortName.trim();
    if (await this.repo.getCourseByShortname(shortName)) {
      throw new ConflictException({ message: `Course shortName ${shortName} is taken`, code: 'course.shortname_taken' });
    }
    const newStart = input.startDate ? new Date(input.startDate) : null;
    const deltaMs = newStart && source.startDate ? newStart.getTime() - source.startDate.getTime() : 0;
    const startDate = newStart ?? source.startDate;
    const endDate = this.shiftDate(source.endDate, deltaMs);
    if (startDate && endDate && endDate < startDate) {
      throw new BadRequestException({ message: 'Course end date is before its start date', code: 'course.invalid_dates' });
    }
    const siblings = await this.repo.listCourses(targetCategory.id);
    const created = await this.repo.dbHandle.transaction(async (tx) => {
      const row = await this.repo.insertCourse({
        category: targetCategory.id, fullName: input.fullName, shortName,
        idNumber: '', summary: source.summary,
        format: source.format, visible: false,
        startDate, endDate,
        groupMode: source.groupMode, groupModeForce: source.groupModeForce, sortOrder: siblings.length,
        subjectId: source.subjectId, grade: source.grade, isTemplate: false,
      }, tx as never);
      await this.outbox.enqueue(tx as never, { aggregate: 'course', type: 'course_created', payload: { courseId: row.id, categoryId: targetCategory.id, actorId, duplicatedFrom: sourceCourseId } });
      await this.outbox.enqueue(tx as never, { aggregate: 'course', type: 'course_duplicated', payload: { courseId: row.id, sourceCourseId, actorId } });
      return row;
    });
    await this.contexts.createContext(CONTEXT_LEVELS.COURSE, created.id, categoryCtxId);
    const cmMap = new Map<string, string>();
    await this.repo.dbHandle.transaction(async (tx) => {
      const sourceSections = await this.repo.listSections(sourceCourseId);
      const ordered = [...sourceSections].sort((a, b) => a.section - b.section);
      if (!ordered.some((s) => s.section === 0)) {
        await this.repo.insertSection({ course: created.id, section: 0, name: null, summary: '', visible: true }, tx as never);
      }
      for (const s of ordered) {
        await this.copySectionRow(tx as DbTx, s, created.id, s.section, deltaMs, cmMap);
      }
      await this.copyGradeStructure(tx as DbTx, sourceCourseId, created.id, cmMap, deltaMs);
      // Format options (sectionId map lại theo section mới khi có) —
      // đọc section mới ngay trong transaction để thấy dữ liệu vừa chèn.
      const db = tx as unknown as Database;
      const sectionMap = new Map<string, string>();
      const newSections = await db.select().from(courseSectionsTable).where(eq(courseSectionsTable.course, created.id));
      for (const s of ordered) {
        const match = newSections.find((n) => n.section === s.section);
        if (match) sectionMap.set(s.id, match.id);
      }
      const options = await this.repo.listFormatOptions(sourceCourseId);
      for (const opt of options) {
        await db.insert(courseFormatOptions).values({
          courseId: created.id, format: opt.format,
          sectionId: opt.sectionId ? sectionMap.get(opt.sectionId) ?? null : null,
          name: opt.name, value: opt.value,
        });
      }
    });
    const sourceFields = await this.getCourseCustomFields(sourceCourseId);
    if (sourceFields.length) {
      const values: Record<string, string> = {};
      for (const f of sourceFields) if (f.value !== null) values[f.shortName] = f.value;
      if (Object.keys(values).length) {
        await this.customFields.setValuesForInstance(COURSE_COMPONENT, COURSE_AREA, created.id, values);
      }
    }
    return this.getCourse(created.id);
  }

  /**
   * "Dùng lại từ khoá khác" (K1): chép các section nguyên vẹn và/hoặc
   * module lẻ từ khoá nguồn vào khoá đích, nối cuối outline. Module lẻ
   * được gom theo section nguồn của chúng — mỗi nhóm thành một section
   * mới mang tên section nguồn (trừ khi section đó đã được chép nguyên
   * vẹn trong cùng lệnh). Ngày tháng giữ nguyên như nguồn (không lùi
   * hạn — đây là dùng lại nội dung, không phải mở đợt học mới).
   */
  async copyCourseContent(actorId: string, targetCourseId: string, input: {
    sourceCourseId: string; sectionIds?: string[]; moduleIds?: string[];
  }): Promise<{ sections: SectionRow[]; modules: CmRow[] }> {
    await this.getCourse(targetCourseId);
    await this.evaluator.requireCapability(actorId, 'course:update', await this.courseContextId(targetCourseId));
    await this.assertCanCopyFrom(actorId, input.sourceCourseId);
    const sectionIds = input.sectionIds ?? [];
    const moduleIds = input.moduleIds ?? [];
    if (!sectionIds.length && !moduleIds.length) {
      throw new BadRequestException({ message: 'Nothing selected to copy', code: 'course.copy_nothing_selected' });
    }
    const sourceSections = await this.repo.listSections(input.sourceCourseId);
    const selectedSections = sourceSections.filter((s) => sectionIds.includes(s.id));
    if (selectedSections.length !== new Set(sectionIds).size) {
      throw new BadRequestException({ message: 'Some sections do not belong to the source course', code: 'course.copy_section_mismatch' });
    }
    const sourceCms = await this.repo.listCms(input.sourceCourseId);
    const selectedCms = sourceCms.filter((c) => moduleIds.includes(c.id));
    if (selectedCms.length !== new Set(moduleIds).size) {
      throw new BadRequestException({ message: 'Some modules do not belong to the source course', code: 'course.copy_module_mismatch' });
    }
    const copiedSectionIds = new Set(selectedSections.map((s) => s.id));
    const looseCms = selectedCms.filter((c) => !copiedSectionIds.has(c.section));
    const cmMap = new Map<string, string>();
    const createdSections: SectionRow[] = [];
    const createdCms: CmRow[] = [];
    await this.repo.dbHandle.transaction(async (tx) => {
      const existing = await this.repo.listSections(targetCourseId);
      let nextNumber = existing.length ? Math.max(...existing.map((s) => s.section)) + 1 : 0;
      for (const s of [...selectedSections].sort((a, b) => a.section - b.section)) {
        const created = await this.copySectionRow(tx as DbTx, s, targetCourseId, nextNumber++, 0, cmMap);
        createdSections.push(created);
      }
      // Nhóm module lẻ theo section nguồn: mỗi nhóm một section mới.
      const groups = new Map<string, CmRow[]>();
      for (const cm of looseCms) {
        const list = groups.get(cm.section) ?? [];
        list.push(cm);
        groups.set(cm.section, list);
      }
      for (const [sourceSectionId, cms] of groups) {
        const sourceSection = sourceSections.find((s) => s.id === sourceSectionId);
        if (!sourceSection) continue;
        const db = tx as unknown as Database;
        const [created] = await db.insert(courseSectionsTable).values({
          course: targetCourseId, section: nextNumber++, name: sourceSection.name, summary: sourceSection.summary,
          visible: sourceSection.visible, availability: sourceSection.availability as never, openAt: sourceSection.openAt,
        }).returning();
        const newSection = created as SectionRow;
        createdSections.push(newSection);
        for (const cm of cms) {
          createdCms.push(await this.copyCmRow(tx as DbTx, cm, targetCourseId, newSection.id, 0, cmMap));
        }
      }
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'course', type: 'course_content_imported',
      payload: { courseId: targetCourseId, sourceCourseId: input.sourceCourseId, actorId, sections: createdSections.length, modules: createdCms.length },
    });
    return { sections: createdSections, modules: createdCms };
  }

  /**
   * Nhân bản một section ngay tại outline (K1): bản sao (kèm cm +
   * instance quiz + neo khung) chèn ngay sau section gốc, các section
   * phía sau lùi một số.
   */
  async duplicateSection(actorId: string, sectionId: string): Promise<SectionRow> {
    const section = await this.getSection(sectionId);
    await this.evaluator.requireCapability(actorId, 'course:update', await this.courseContextId(section.course));
    const cmMap = new Map<string, string>();
    let created!: SectionRow;
    await this.repo.dbHandle.transaction(async (tx) => {
      const handle = tx as never;
      // Hai pass qua vùng đệm +100000 như đường chèn khung (K0a).
      await this.repo.shiftSections(handle, section.course, section.section + 1, 100000);
      await this.repo.shiftSections(handle, section.course, section.section + 1 + 100000, 1 - 100000);
      created = await this.copySectionRow(tx as DbTx, section, section.course, section.section + 1, 0, cmMap);
      // Item điểm 'mod' của các cm gốc trỏ sang cm bản sao (cùng category).
      const db = tx as unknown as Database;
      for (const [oldCmId, newCmId] of cmMap) {
        const items = await db.select().from(gradeItems).where(and(
          eq(gradeItems.courseId, section.course), eq(gradeItems.itemType, 'mod'), eq(gradeItems.itemInstance, oldCmId),
        ));
        for (const item of items) {
          await db.insert(gradeItems).values({
            courseId: section.course, categoryId: item.categoryId, itemName: item.itemName,
            itemType: item.itemType, itemModule: item.itemModule, itemInstance: newCmId,
            gradeType: item.gradeType, gradeMax: item.gradeMax, gradeMin: item.gradeMin, gradePass: item.gradePass,
            scaleId: item.scaleId, outcomeId: item.outcomeId, idNumber: null, calculation: item.calculation,
            weightOverride: item.weightOverride, aggregationCoef: item.aggregationCoef, extraCredit: item.extraCredit,
            multiplicator: item.multiplicator, plusFactor: item.plusFactor, hidden: item.hidden, locked: item.locked,
            sortOrder: item.sortOrder,
          });
        }
      }
    });
    return created;
  }

  /**
   * Nhân bản một course module tại dòng (K1): bản sao chèn ngay sau
   * module gốc trong cùng section (instance quiz nhân bản sâu; item
   * điểm 'mod' tương ứng được chép trỏ sang bản sao).
   */
  async duplicateCm(actorId: string, cmId: string): Promise<CmRow> {
    const cm = await this.getCm(cmId);
    await this.evaluator.requireCapability(actorId, 'course:manageactivities', await this.courseContextId(cm.course));
    const cmMap = new Map<string, string>();
    let created!: CmRow;
    await this.repo.dbHandle.transaction(async (tx) => {
      const db = tx as unknown as Database;
      // Đẩy các module sau module gốc xuống một bậc sortOrder.
      await db.update(courseModulesTable)
        .set({ sortOrder: sql`${courseModulesTable.sortOrder} + 1` })
        .where(and(
          eq(courseModulesTable.section, cm.section),
          sql`${courseModulesTable.sortOrder} > ${cm.sortOrder}`,
        ));
      created = await this.copyCmRow(tx as DbTx, { ...cm, sortOrder: cm.sortOrder + 1 }, cm.course, cm.section, 0, cmMap);
      const items = await db.select().from(gradeItems).where(and(
        eq(gradeItems.courseId, cm.course), eq(gradeItems.itemType, 'mod'), eq(gradeItems.itemInstance, cm.id),
      ));
      for (const item of items) {
        await db.insert(gradeItems).values({
          courseId: cm.course, categoryId: item.categoryId, itemName: item.itemName,
          itemType: item.itemType, itemModule: item.itemModule, itemInstance: created.id,
          gradeType: item.gradeType, gradeMax: item.gradeMax, gradeMin: item.gradeMin, gradePass: item.gradePass,
          scaleId: item.scaleId, outcomeId: item.outcomeId, idNumber: null, calculation: item.calculation,
          weightOverride: item.weightOverride, aggregationCoef: item.aggregationCoef, extraCredit: item.extraCredit,
          multiplicator: item.multiplicator, plusFactor: item.plusFactor, hidden: item.hidden, locked: item.locked,
          sortOrder: item.sortOrder,
        });
      }
    });
    return created;
  }

  /**
   * Đổi thứ tự section bằng danh sách id mới (K1 — kéo–thả + nút
   * lên/xuống ở Builder Outline): danh sách phải đủ mọi section của
   * khoá; số section được gán lại 0..n-1 theo đúng thứ tự truyền vào.
   */
  async reorderSections(actorId: string, courseId: string, sectionIds: string[]): Promise<SectionRow[]> {
    await this.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'course:update', await this.courseContextId(courseId));
    const existing = await this.repo.listSections(courseId);
    const existingIds = new Set(existing.map((s) => s.id));
    if (sectionIds.length !== existing.length || !sectionIds.every((id) => existingIds.has(id))) {
      throw new BadRequestException({ message: 'Reorder list must contain every section of the course exactly once', code: 'course.reorder_sections_mismatch' });
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      const handle = tx as never;
      // Vùng đệm +100000 tránh vỡ unique (course, section) giữa chừng.
      await this.repo.shiftSections(handle, courseId, 0, 100000);
      const db = tx as unknown as Database;
      for (const [i, id] of sectionIds.entries()) {
        await db.update(courseSectionsTable).set({ section: i, updatedAt: new Date() }).where(eq(courseSectionsTable.id, id));
      }
    });
    return this.repo.listSections(courseId);
  }

  /**
   * Đổi thứ tự module trong một section bằng danh sách id mới (K1):
   * danh sách phải đủ mọi module của section; sortOrder gán lại 0..n-1.
   */
  async reorderModules(actorId: string, sectionId: string, moduleIds: string[]): Promise<CmRow[]> {
    const section = await this.getSection(sectionId);
    await this.evaluator.requireCapability(actorId, 'course:manageactivities', await this.courseContextId(section.course));
    const existing = await this.repo.listCmsInSection(sectionId);
    const existingIds = new Set(existing.map((c) => c.id));
    if (moduleIds.length !== existing.length || !moduleIds.every((id) => existingIds.has(id))) {
      throw new BadRequestException({ message: 'Reorder list must contain every module of the section exactly once', code: 'course.reorder_modules_mismatch' });
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      const db = tx as unknown as Database;
      for (const [i, id] of moduleIds.entries()) {
        await db.update(courseModulesTable).set({ sortOrder: i }).where(eq(courseModulesTable.id, id));
      }
    });
    return this.repo.listCmsInSection(sectionId);
  }

  /**
   * Nạp khung SGK vào khoá (K0b — bản sao có neo kép): mỗi chủ đề được
   * chọn thành một section mới mang tựa của chủ đề; các bài trong chủ
   * đề thành mục của section, mỗi mục chụp toàn bộ YCCĐ suy qua ánh xạ
   * (bài → node chương trình → YCCĐ của node) tại thời điểm nạp.
   * `insertAtSection` như ở khung chương trình. Sửa cây sách hoặc ánh
   * xạ sau đó không đổi các section đã nạp vì chúng đọc từ bản chụp.
   * Quyền: course:update tại context khoá đích là cổng duy nhất (như
   * K0a — provider khung tin cậy cổng này).
   */
  async applyTextbookFrame(actorId: string, courseId: string, input: {
    textbookId: string; chapterNodeIds: string[]; insertAtSection?: number;
  }): Promise<(SectionRow & { textbookFrame: SectionTextbookFrameView })[]> {
    await this.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'course:update', await this.courseContextId(courseId));
    if (!this.textbookFrameProvider) {
      throw new BadRequestException({ message: 'Textbook frame provider is not registered', code: 'course.textbook_frame_provider_missing' });
    }
    const units = await this.textbookFrameProvider.getTextbookFrameUnits(actorId, input.textbookId);
    const wanted = new Set(input.chapterNodeIds);
    const selected = units.filter((u) => wanted.has(u.chapterNodeId));
    if (selected.length !== wanted.size) {
      const found = new Set(selected.map((u) => u.chapterNodeId));
      const missing = input.chapterNodeIds.filter((id) => !found.has(id));
      throw new BadRequestException({
        message: `Textbook chapters not selectable in this textbook: ${missing.join(', ')}`,
        code: 'course.textbook_chapter_not_selectable',
      });
    }
    const existing = await this.repo.listSections(courseId);
    const maxSection = existing.length ? Math.max(...existing.map((s) => s.section)) : -1;
    const insertAt = input.insertAtSection ?? maxSection + 1;
    if (insertAt > maxSection + 1) {
      throw new BadRequestException({
        message: `insertAtSection ${insertAt} is beyond the end of the outline`,
        code: 'course.textbook_frame_insert_beyond_end',
      });
    }
    const count = selected.length;
    const created: (SectionRow & { textbookFrame: SectionTextbookFrameView })[] = [];
    await this.repo.dbHandle.transaction(async (tx) => {
      const handle = tx as never;
      if (input.insertAtSection !== undefined && insertAt <= maxSection) {
        // Hai pass qua vùng đệm +100000 để unique (course, section) không vỡ giữa chừng (như khung chương trình).
        await this.repo.shiftSections(handle, courseId, insertAt, 100000);
        await this.repo.shiftSections(handle, courseId, insertAt + 100000, count - 100000);
      }
      for (const [i, unit] of selected.entries()) {
        const section = await this.repo.insertSection({
          course: courseId, section: insertAt + i, name: unit.title, summary: '', visible: true,
        }, handle);
        const anchor = await this.repo.insertSectionTextbookAnchor({
          sectionId: section.id, textbookNodeId: unit.chapterNodeId, textbookId: input.textbookId, nodeTitle: unit.title,
        }, handle);
        const items: SectionTextbookFrameView['items'] = [];
        for (const [j, item] of unit.items.entries()) {
          const itemRow = await this.repo.insertSectionTextbookItem({
            anchorId: anchor.id, textbookNodeId: item.lessonNodeId, title: item.title, position: j + 1,
          }, handle);
          await this.repo.insertSectionTextbookItemOutcomes(
            item.outcomes.map((o, k) => ({ itemId: itemRow.id, outcomeId: o.outcomeId, content: o.content, position: k + 1 })),
            handle,
          );
          items.push({
            nodeId: item.lessonNodeId, title: item.title,
            outcomes: item.outcomes.map((o) => ({ outcomeId: o.outcomeId, content: o.content })),
          });
        }
        created.push({
          ...section,
          textbookFrame: { nodeId: unit.chapterNodeId, textbookId: input.textbookId, nodeTitle: unit.title, items },
        });
      }
    });
    return created;
  }

  /** Full course-content view with per-item availability evaluated for THIS user; hidden-unavailable items are omitted. */
  /**
   * Dựng nội dung khoá học cho người xem: section + cm kèm kết quả availability đã đánh giá theo user.
   */
  async getCourseContent(userId: string, courseId: string): Promise<CourseContentView> {
    const courseRow = await this.assertCourseAccess(userId, courseId);
    const sections = await this.repo.listSections(courseId);
    const cms = await this.repo.listCms(courseId);
    // Neo khung (K0a): đọc bản chụp, không đọc lại cây chương trình.
    const anchors = await this.repo.listAnchorsForSections(sections.map((s) => s.id));
    const anchorOutcomes = await this.repo.listAnchorOutcomes(anchors.map((a) => a.id));
    const frameBySection = new Map<string, SectionFrameView>();
    for (const anchor of anchors) {
      frameBySection.set(anchor.sectionId, {
        nodeId: anchor.nodeId, nodeTitle: anchor.nodeTitle,
        outcomes: anchorOutcomes.filter((o) => o.anchorId === anchor.id)
          .map((o) => ({ outcomeId: o.outcomeId, content: o.content })),
      });
    }
    // Neo khung SGK (K0b): cũng đọc bản chụp (neo → mục bài → YCCĐ chụp).
    const textbookAnchors = await this.repo.listTextbookAnchorsForSections(sections.map((s) => s.id));
    const textbookItems = await this.repo.listTextbookItems(textbookAnchors.map((a) => a.id));
    const textbookItemOutcomes = await this.repo.listTextbookItemOutcomes(textbookItems.map((i) => i.id));
    const textbookFrameBySection = new Map<string, SectionTextbookFrameView>();
    for (const anchor of textbookAnchors) {
      textbookFrameBySection.set(anchor.sectionId, {
        nodeId: anchor.textbookNodeId, textbookId: anchor.textbookId, nodeTitle: anchor.nodeTitle,
        items: textbookItems.filter((i) => i.anchorId === anchor.id).map((i) => ({
          nodeId: i.textbookNodeId, title: i.title,
          outcomes: textbookItemOutcomes.filter((o) => o.itemId === i.id)
            .map((o) => ({ outcomeId: o.outcomeId, content: o.content })),
        })),
      });
    }
    const canSeeHidden = await this.canViewHiddenActivities(userId, courseId);
    const grades = this.gradeProvider ? await this.gradesForAvailability(userId, courseId) : undefined;
    const now = new Date();
    const outSections: CourseContentView['sections'] = [];
    for (const section of sections) {
      const sAccess = await this.checkSectionAccess(userId, section, grades);
      if (!sAccess.visible && !canSeeHidden) continue;
      const modules: CourseContentView['sections'][number]['modules'] = [];
      for (const cm of cms.filter((c) => c.section === section.id)) {
        const access = await this.checkCmAccess(userId, cm, grades);
        if (!access.visible && !canSeeHidden) continue;
        modules.push({ ...cm, status: courseItemStatus(cm.visible, cm.openAt, now), contextId: await this.cmContextId(cm.id), availabilityResult: access });
      }
      outSections.push({ ...section, status: courseItemStatus(section.visible, section.openAt, now), availabilityResult: sAccess, frame: frameBySection.get(section.id) ?? null, textbookFrame: textbookFrameBySection.get(section.id) ?? null, modules });
    }
    return {
      course: courseRow,
      contextId: await this.courseContextId(courseId),
      customFields: await this.getCourseCustomFields(courseId),
      sections: outSections,
    };
  }
}
