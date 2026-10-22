import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { AvailabilityService, type AvailabilityContext } from '../availability/availability.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { CoursesRepository, type CategoryRow, type CmRow, type CourseRow, type SectionRow } from './courses.repository';

export const GROUPMODE_NOGROUPS = 0;
export const GROUPMODE_SEPARATEGROUPS = 1;
export const GROUPMODE_VISIBLEGROUPS = 2;
export const COURSE_COMPONENT = 'core_course';
export const COURSE_AREA = 'course';

export type CategoryDeleteMode = 'moveup' | 'recursive';

/** Registered by EnrolModule at bootstrap — keeps Courses → Enrol import-free (dependency inversion, cf. Availability registry). */
export interface EnrolChecker {
  isEnrolled(courseId: number, userId: number, opts?: { onlyActive?: boolean }): Promise<boolean>;
}

export interface CourseContentView {
  course: CourseRow;
  contextId: number;
  customFields: { shortname: string; value: string | null }[];
  sections: (SectionRow & {
    availabilityResult?: { available: boolean; visible: boolean; failedDescriptions: string[] };
    modules: (CmRow & { contextId?: number; availabilityResult?: { available: boolean; visible: boolean; failedDescriptions: string[] } })[];
  })[];
}

/**
 * CoursesModule facade (Moodle core_course). Categories and courses form
 * trees/contexts: every category gets a coursecat context (40), every course
 * a course context (50) under its category, every cm a module context (70)
 * under its course — created through the AccessModule facade only.
 */
@Injectable()
export class CoursesService {
  private enrolChecker?: EnrolChecker;
  /** Registered by GradesModule (P3): grade percentages (0-100) per user+course for availability 'grade' leaves. */
  private gradeProvider?: (userId: number, courseId: number) => Promise<Record<string, number>>;

  registerGradeProvider(fn: (userId: number, courseId: number) => Promise<Record<string, number>>): void {
    this.gradeProvider = fn;
  }
  async gradesForAvailability(userId: number, courseId: number): Promise<Record<string, number> | undefined> {
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

  registerEnrolChecker(checker: EnrolChecker): void { this.enrolChecker = checker; }

  // --- context helpers -----------------------------------------------------
  async categoryContextId(categoryId: number): Promise<number> {
    const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSECAT, categoryId);
    if (!ctx) throw new NotFoundException({ message: `No context for category ${categoryId}`, code: 'course.category_context_missing' });
    return ctx.id;
  }
  async courseContextId(courseId: number): Promise<number> {
    const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, courseId);
    if (!ctx) throw new NotFoundException({ message: `No context for course ${courseId}`, code: 'course.context_missing' });
    return ctx.id;
  }
  async cmContextId(cmId: number): Promise<number | undefined> {
    return (await this.contexts.getByLevelInstance(CONTEXT_LEVELS.MODULE, cmId))?.id;
  }

  // --- categories ------------------------------------------------------------
  async createCategory(actorId: number, input: { name: string; idnumber?: string; description?: string; parent?: number; visible?: boolean }): Promise<CategoryRow> {
    const parent = input.parent ?? 0;
    let parentCtxId: number;
    if (parent === 0) {
      parentCtxId = (await this.contexts.ensureSystemContext()).id;
    } else {
      const parentCat = await this.getCategory(parent);
      parentCtxId = await this.categoryContextId(parentCat.id);
    }
    await this.evaluator.requireCapability(actorId, 'moodle/category:manage', parentCtxId);
    const sortorder = await this.repo.countSiblingCategories(parent);
    const cat = await this.repo.insertCategory({
      name: input.name, idnumber: input.idnumber ?? null, description: input.description ?? '',
      parent, sortorder, visible: input.visible ?? true, path: '', depth: 1,
    });
    const parentRow = parent === 0 ? null : await this.getCategory(parent);
    const path = parentRow ? `${parentRow.path}/${cat.id}` : `/${cat.id}`;
    const depth = parentRow ? parentRow.depth + 1 : 1;
    await this.repo.updateCategoryPath(cat.id, path, depth);
    await this.contexts.createContext(CONTEXT_LEVELS.COURSECAT, cat.id, parentCtxId);
    await this.outbox.enqueueStandalone({ aggregate: 'course_category', type: 'category_created', payload: { categoryId: cat.id, parent } });
    return { ...cat, path, depth };
  }

  async getCategory(id: number): Promise<CategoryRow> {
    const row = await this.repo.getCategory(id);
    if (!row) throw new NotFoundException({ message: `Category ${id} not found`, code: 'course.category_not_found' });
    return row;
  }
  async listCategories(): Promise<CategoryRow[]> { return this.repo.listCategories(); }

  /** Category tree for UI: nested children arrays. */
  async categoryTree(): Promise<(CategoryRow & { children: unknown[] })[]> {
    const all = await this.repo.listCategories();
    const byId = new Map<number, CategoryRow & { children: unknown[] }>(all.map((c) => [c.id, { ...c, children: [] }]));
    const roots: (CategoryRow & { children: unknown[] })[] = [];
    for (const c of byId.values()) {
      if (c.parent !== 0 && byId.has(c.parent)) (byId.get(c.parent)!.children as unknown[]).push(c);
      else roots.push(c);
    }
    return roots;
  }

  async updateCategory(actorId: number, id: number, input: { name?: string; idnumber?: string; description?: string; visible?: boolean; parent?: number }): Promise<CategoryRow> {
    const cat = await this.getCategory(id);
    await this.evaluator.requireCapability(actorId, 'moodle/category:manage', await this.categoryContextId(id));
    if (input.parent !== undefined && input.parent !== cat.parent) {
      await this.moveCategory(cat, input.parent);
    }
    const patch: Partial<CategoryRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.idnumber !== undefined) patch.idnumber = input.idnumber;
    if (input.description !== undefined) patch.description = input.description;
    if (input.visible !== undefined) patch.visible = input.visible;
    if (Object.keys(patch).length) await this.repo.updateCategory(id, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'course_category', type: 'category_updated', payload: { categoryId: id } });
    return this.getCategory(id);
  }

  /** Move a category under a new parent, rewriting path/depth of the whole subtree and reparenting its context. */
  private async moveCategory(cat: CategoryRow, newParent: number): Promise<void> {
    if (newParent === cat.id) throw new BadRequestException({ message: 'A category cannot be its own parent', code: 'course.category_cycle' });
    const subtree = await this.repo.subtreeOf(cat);
    if (subtree.some((c) => c.id === newParent)) {
      throw new BadRequestException({ message: 'A category cannot be moved under its own descendant', code: 'course.category_cycle' });
    }
    const newParentRow = newParent === 0 ? null : await this.getCategory(newParent);
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
    await this.outbox.enqueueStandalone({ aggregate: 'course_category', type: 'category_moved', payload: { categoryId: cat.id, fromParent: cat.parent, toParent: newParent } });
  }

  /**
   * Delete a category — the fate of contained courses/subcategories MUST be
   * explicit (Moodle rule, report §2#4): 'moveup' re-parents children and
   * courses to the deleted category's parent; 'recursive' deletes them.
   * Refuses (400) when the category is non-empty and no mode is given.
   */
  async deleteCategory(actorId: number, id: number, mode?: CategoryDeleteMode): Promise<{ deleted: true; mode: CategoryDeleteMode | 'empty' }> {
    const cat = await this.getCategory(id);
    await this.evaluator.requireCapability(actorId, 'moodle/category:manage', await this.categoryContextId(id));
    const children = await this.repo.childrenOf(id);
    const coursesHere = await this.repo.listCourses(id);
    if ((children.length || coursesHere.length) && !mode) {
      throw new BadRequestException({
        message: 'Category is not empty: pass mode=moveup (move contents to the parent category) or mode=recursive (delete contents)',
        code: 'course.category_not_empty',
      });
    }
    const effectiveMode: CategoryDeleteMode | 'empty' = mode ?? 'empty';
    if (mode === 'moveup' && cat.parent === 0 && coursesHere.length) {
      throw new BadRequestException({ message: 'Cannot move courses up from a top-level category (no parent category)', code: 'course.category_moveup_no_parent' });
    }
    if (mode === 'moveup') {
      for (const child of children) await this.moveCategory(child, cat.parent);
      for (const c of coursesHere) {
        await this.repo.updateCourse(c.id, { category: cat.parent });
        const courseCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, c.id);
        if (courseCtx) await this.contexts.reparentContext(courseCtx.id, await this.categoryContextId(cat.parent));
      }
    } else if (mode === 'recursive') {
      const subtree = await this.repo.subtreeOf(cat);
      for (const sub of subtree) {
        for (const c of await this.repo.listCourses(sub.id)) await this.deleteCourseInternal(c);
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
    await this.outbox.enqueueStandalone({ aggregate: 'course_category', type: 'category_deleted', payload: { categoryId: id, mode: effectiveMode } });
    return { deleted: true, mode: effectiveMode };
  }

  // --- courses ---------------------------------------------------------------
  async createCourse(actorId: number, input: {
    fullname: string; shortname: string; category: number; idnumber?: string; summary?: string;
    format?: string; visible?: boolean; startdate?: string; enddate?: string; groupmode?: number;
    formatOptions?: Record<string, string>; customFields?: Record<string, string>;
  }): Promise<CourseRow> {
    const category = await this.getCategory(input.category);
    const categoryCtxId = await this.categoryContextId(category.id);
    // Creating a course requires the capability in the CATEGORY context (Moodle rule).
    await this.evaluator.requireCapability(actorId, 'moodle/course:create', categoryCtxId);
    const shortname = input.shortname.trim();
    if (await this.repo.getCourseByShortname(shortname)) {
      throw new ConflictException({ message: `Course shortname ${shortname} is taken`, code: 'course.shortname_taken' });
    }
    if (input.startdate && input.enddate && new Date(input.enddate) < new Date(input.startdate)) {
      throw new BadRequestException({ message: 'Course end date is before its start date', code: 'course.invalid_dates' });
    }
    if (input.customFields) await this.customFields.validateValuesForInstance(COURSE_COMPONENT, COURSE_AREA, input.customFields);
    const siblings = await this.repo.listCourses(category.id);
    const created = await this.repo.dbHandle.transaction(async (tx) => {
      const row = await this.repo.insertCourse({
        category: category.id, fullname: input.fullname, shortname,
        idnumber: input.idnumber ?? '', summary: input.summary ?? '',
        format: input.format ?? 'topics', visible: input.visible ?? true,
        startdate: input.startdate ? new Date(input.startdate) : null,
        enddate: input.enddate ? new Date(input.enddate) : null,
        groupmode: input.groupmode ?? GROUPMODE_NOGROUPS, sortorder: siblings.length,
      }, tx as never);
      await this.outbox.enqueue(tx as never, { aggregate: 'course', type: 'course_created', payload: { courseId: row.id, categoryId: category.id } });
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

  async getCourse(id: number): Promise<CourseRow> {
    const row = await this.repo.getCourse(id);
    if (!row) throw new NotFoundException({ message: `Course ${id} not found`, code: 'course.not_found' });
    return row;
  }
  async listCourses(categoryId?: number): Promise<CourseRow[]> { return this.repo.listCourses(categoryId); }
  async getFormatOptions(courseId: number): Promise<(typeof import('../../db/schema').courseFormatOptions.$inferSelect)[]> {
    return this.repo.listFormatOptions(courseId);
  }
  async getCourseCustomFields(courseId: number): Promise<{ shortname: string; value: string | null }[]> {
    const values = await this.customFields.getValuesForInstance(COURSE_COMPONENT, COURSE_AREA, courseId);
    return values.map((v) => ({ shortname: v.field.shortname, value: v.value }));
  }

  async updateCourse(actorId: number, id: number, input: {
    fullname?: string; shortname?: string; category?: number; idnumber?: string; summary?: string;
    format?: string; visible?: boolean; startdate?: string | null; enddate?: string | null; groupmode?: number;
    formatOptions?: Record<string, string>; customFields?: Record<string, string>;
  }): Promise<CourseRow> {
    const existing = await this.getCourse(id);
    await this.evaluator.requireCapability(actorId, 'moodle/course:update', await this.courseContextId(id));
    if (input.shortname !== undefined && input.shortname.trim() !== existing.shortname) {
      if (await this.repo.getCourseByShortname(input.shortname.trim())) {
        throw new ConflictException({ message: `Course shortname ${input.shortname} is taken`, code: 'course.shortname_taken' });
      }
    }
    if (input.customFields) await this.customFields.validateValuesForInstance(COURSE_COMPONENT, COURSE_AREA, input.customFields);
    const patch: Partial<CourseRow> = {};
    if (input.fullname !== undefined) patch.fullname = input.fullname;
    if (input.shortname !== undefined) patch.shortname = input.shortname.trim();
    if (input.idnumber !== undefined) patch.idnumber = input.idnumber;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.format !== undefined) patch.format = input.format;
    if (input.visible !== undefined) patch.visible = input.visible;
    if (input.startdate !== undefined) patch.startdate = input.startdate ? new Date(input.startdate) : null;
    if (input.enddate !== undefined) patch.enddate = input.enddate ? new Date(input.enddate) : null;
    if (input.groupmode !== undefined) patch.groupmode = input.groupmode;
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
    await this.outbox.enqueueStandalone({ aggregate: 'course', type: 'course_updated', payload: { courseId: id } });
    return this.getCourse(id);
  }

  async deleteCourse(actorId: number, id: number): Promise<void> {
    const courseRow = await this.getCourse(id);
    await this.evaluator.requireCapability(actorId, 'moodle/course:delete', await this.courseContextId(id));
    await this.deleteCourseInternal(courseRow);
  }

  /** Delete without a capability re-check (category recursive delete already checked the category capability). */
  private async deleteCourseInternal(courseRow: CourseRow): Promise<void> {
    const cms = await this.repo.listCms(courseRow.id);
    for (const cm of cms) await this.emitCmDeleted(cm);
    await this.contexts.deleteByLevelInstance(CONTEXT_LEVELS.COURSE, courseRow.id);
    await this.repo.deleteCourse(courseRow.id);
    await this.outbox.enqueueStandalone({ aggregate: 'course', type: 'course_deleted', payload: { courseId: courseRow.id } });
  }

  // --- access gate -------------------------------------------------------------
  /**
   * The course-content gate (report §2#5): enrolment and capability are
   * INDEPENDENT conditions. Access = site admin, OR an ACTIVE enrolment, OR
   * a real (non-student) role assignment granting moodle/course:view.
   * A suspended enrolment therefore blocks even a user who holds the student
   * role — the role alone never opens the course.
   */
  async assertCourseAccess(userId: number, courseId: number): Promise<CourseRow> {
    const courseRow = await this.getCourse(courseId);
    if (await this.evaluator.isSiteAdmin(userId)) return courseRow;
    const ctxId = await this.courseContextId(courseId);
    if (!courseRow.visible && !(await this.evaluator.hasCapability(userId, 'moodle/course:viewhiddencourses', ctxId))) {
      throw new ForbiddenException({ message: 'Course is hidden', code: 'course.hidden' });
    }
    if (this.enrolChecker && (await this.enrolChecker.isEnrolled(courseId, userId, { onlyActive: true }))) return courseRow;
    if (await this.evaluator.hasCapabilityFromRealAssignment(userId, 'moodle/course:view', ctxId, { excludeArchetypes: ['student'] })) return courseRow;
    throw new ForbiddenException({ message: 'User is not enrolled in this course (or the enrolment is not active)', code: 'course.not_enrolled' });
  }

  async canViewHiddenActivities(userId: number, courseId: number): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    return this.evaluator.hasCapability(userId, 'moodle/course:viewhiddenactivities', await this.courseContextId(courseId));
  }

  // --- sections & modules ------------------------------------------------------
  async createSection(actorId: number, courseId: number, input: { name?: string; summary?: string; visible?: boolean; availability?: unknown }): Promise<SectionRow> {
    await this.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'moodle/course:update', await this.courseContextId(courseId));
    if (input.availability !== undefined) this.availability.parse(input.availability);
    const existing = await this.repo.listSections(courseId);
    const nextNumber = existing.length ? Math.max(...existing.map((s) => s.section)) + 1 : 0;
    return this.repo.insertSection({
      course: courseId, section: nextNumber, name: input.name ?? null,
      summary: input.summary ?? '', visible: input.visible ?? true,
      availability: (input.availability ?? null) as never,
    });
  }
  async getSection(id: number): Promise<SectionRow> {
    const row = await this.repo.getSection(id);
    if (!row) throw new NotFoundException({ message: `Section ${id} not found`, code: 'course.section_not_found' });
    return row;
  }
  async listSections(courseId: number): Promise<SectionRow[]> { return this.repo.listSections(courseId); }
  async updateSection(actorId: number, id: number, input: { name?: string; summary?: string; visible?: boolean; availability?: unknown }): Promise<SectionRow> {
    const section = await this.getSection(id);
    await this.evaluator.requireCapability(actorId, 'moodle/course:update', await this.courseContextId(section.course));
    if (input.availability !== undefined) this.availability.parse(input.availability);
    const patch: Partial<SectionRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.visible !== undefined) patch.visible = input.visible;
    if (input.availability !== undefined) patch.availability = input.availability as never;
    if (Object.keys(patch).length) await this.repo.updateSection(id, patch);
    return this.getSection(id);
  }
  async deleteSection(actorId: number, id: number): Promise<void> {
    const section = await this.getSection(id);
    await this.evaluator.requireCapability(actorId, 'moodle/course:update', await this.courseContextId(section.course));
    const cms = await this.repo.listCmsInSection(id);
    for (const cm of cms) await this.deleteCmInternal(cm);
    await this.repo.deleteSection(id);
  }

  async createCm(actorId: number, courseId: number, input: {
    sectionId: number; component: string; instanceid?: number; name?: string; visible?: boolean; groupmode?: number;
    availability?: unknown; completion?: number; completionview?: boolean; completionusegrade?: boolean;
    completionmanual?: boolean; completionexpected?: string;
  }): Promise<CmRow> {
    const courseRow = await this.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'moodle/course:manageactivities', await this.courseContextId(courseId));
    const section = await this.getSection(input.sectionId);
    if (section.course !== courseId) throw new BadRequestException({ message: 'Section does not belong to this course', code: 'course.section_course_mismatch' });
    if (input.availability !== undefined) this.availability.parse(input.availability);
    const cm = await this.repo.insertCm({
      course: courseId, section: section.id, component: input.component, instanceid: input.instanceid ?? 0,
      name: input.name ?? '', visible: input.visible ?? true, groupmode: input.groupmode ?? 0,
      availability: (input.availability ?? null) as never,
      completion: input.completion ?? (input.completionmanual ? 1 : 0),
      completionview: input.completionview ?? false, completionusegrade: input.completionusegrade ?? false,
      completionmanual: input.completionmanual ?? false,
      completionexpected: input.completionexpected ? new Date(input.completionexpected) : null,
    });
    const courseCtxId = await this.courseContextId(courseId);
    await this.contexts.createContext(CONTEXT_LEVELS.MODULE, cm.id, courseCtxId);
    await this.outbox.enqueueStandalone({ aggregate: 'course_module', type: 'cm_created', payload: { cmId: cm.id, courseId, component: cm.component, instanceid: cm.instanceid } });
    void courseRow;
    return cm;
  }
  async getCm(id: number): Promise<CmRow> {
    const row = await this.repo.getCm(id);
    if (!row) throw new NotFoundException({ message: `Course module ${id} not found`, code: 'course.cm_not_found' });
    return row;
  }
  async listCms(courseId: number): Promise<CmRow[]> { return this.repo.listCms(courseId); }
  async updateCm(actorId: number, id: number, input: {
    name?: string; visible?: boolean; groupmode?: number; availability?: unknown; completion?: number;
    completionview?: boolean; completionusegrade?: boolean; completionmanual?: boolean; completionexpected?: string | null; sectionId?: number;
  }): Promise<CmRow> {
    const cm = await this.getCm(id);
    await this.evaluator.requireCapability(actorId, 'moodle/course:manageactivities', await this.courseContextId(cm.course));
    if (input.availability !== undefined) this.availability.parse(input.availability);
    const patch: Partial<CmRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.visible !== undefined) patch.visible = input.visible;
    if (input.groupmode !== undefined) patch.groupmode = input.groupmode;
    if (input.availability !== undefined) patch.availability = input.availability as never;
    if (input.completion !== undefined) patch.completion = input.completion;
    if (input.completionview !== undefined) patch.completionview = input.completionview;
    if (input.completionusegrade !== undefined) patch.completionusegrade = input.completionusegrade;
    if (input.completionmanual !== undefined) patch.completionmanual = input.completionmanual;
    if (input.completionexpected !== undefined) patch.completionexpected = input.completionexpected ? new Date(input.completionexpected) : null;
    if (input.sectionId !== undefined) {
      const section = await this.getSection(input.sectionId);
      if (section.course !== cm.course) throw new BadRequestException({ message: 'Section does not belong to this course', code: 'course.section_course_mismatch' });
      patch.section = section.id;
    }
    if (Object.keys(patch).length) await this.repo.updateCm(id, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'course_module', type: 'cm_updated', payload: { cmId: id, courseId: cm.course } });
    return this.getCm(id);
  }

  private async emitCmDeleted(cm: CmRow): Promise<void> {
    const contextId = await this.cmContextId(cm.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'course_module', type: 'cm_deleted',
      payload: { cmId: cm.id, courseId: cm.course, contextId: contextId ?? null, component: cm.component, instanceid: cm.instanceid },
    });
    // In-process delivery for the owning modules' handlers (completion, files);
    // handlers are idempotent, so the durable outbox relay may replay safely.
    await this.emitter.emitAsync('cm_deleted', { cmId: cm.id, courseId: cm.course, contextId: contextId ?? null, component: cm.component, instanceid: cm.instanceid });
    if (contextId) await this.contexts.deleteContext(contextId);
  }

  private async deleteCmInternal(cm: CmRow): Promise<void> {
    await this.emitCmDeleted(cm);
    await this.repo.deleteCm(cm.id);
  }
  async deleteCm(actorId: number, id: number): Promise<void> {
    const cm = await this.getCm(id);
    await this.evaluator.requireCapability(actorId, 'moodle/course:manageactivities', await this.courseContextId(cm.course));
    await this.deleteCmInternal(cm);
  }

  /**
   * Record that a user viewed a cm: enqueues the durable `cm_viewed` outbox
   * event AND delivers it in-process so CompletionModule's listener writes
   * the completionview state (handlers are idempotent).
   */
  async recordCmView(userId: number, cmId: number): Promise<CmRow> {
    const cm = await this.getCm(cmId);
    await this.assertCourseAccess(userId, cm.course);
    const access = await this.checkCmAccess(userId, cm);
    if (!access.available) throw new ForbiddenException({ message: 'This activity is not available to you yet', code: 'availability.not_available' });
    await this.outbox.enqueueStandalone({ aggregate: 'course_module', type: 'cm_viewed', payload: { cmId, courseId: cm.course, userId } });
    await this.emitter.emitAsync('cm_viewed', { cmId, courseId: cm.course, userId });
    return cm;
  }

  /** Server-side availability check for one cm (section availability AND cm availability must both pass). */
  async checkCmAccess(userId: number, cm: CmRow, grades?: Record<string, number>): Promise<{ available: boolean; visible: boolean; failedDescriptions: string[] }> {
    const resolvedGrades = grades ?? (this.gradeProvider ? await this.gradesForAvailability(userId, cm.course) : undefined);
    const ctx: AvailabilityContext = { userId, courseId: cm.course, grades: resolvedGrades };
    const section = await this.repo.getSection(cm.section);
    if (section?.availability) {
      const s = await this.availability.evaluate(section.availability, ctx);
      if (!s.available) return { available: false, visible: s.visible, failedDescriptions: s.failedDescriptions };
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

  async checkSectionAccess(userId: number, section: SectionRow, grades?: Record<string, number>): Promise<{ available: boolean; visible: boolean; failedDescriptions: string[] }> {
    if (!section.visible && !(await this.canViewHiddenActivities(userId, section.course))) {
      return { available: false, visible: false, failedDescriptions: [] };
    }
    const resolvedGrades = grades ?? (this.gradeProvider ? await this.gradesForAvailability(userId, section.course) : undefined);
    const r = await this.availability.evaluate(section.availability, { userId, courseId: section.course, grades: resolvedGrades });
    return { available: r.available, visible: r.visible, failedDescriptions: r.failedDescriptions };
  }

  /** Full course-content view with per-item availability evaluated for THIS user; hidden-unavailable items are omitted. */
  async getCourseContent(userId: number, courseId: number): Promise<CourseContentView> {
    const courseRow = await this.assertCourseAccess(userId, courseId);
    const sections = await this.repo.listSections(courseId);
    const cms = await this.repo.listCms(courseId);
    const canSeeHidden = await this.canViewHiddenActivities(userId, courseId);
    const grades = this.gradeProvider ? await this.gradesForAvailability(userId, courseId) : undefined;
    const outSections: CourseContentView['sections'] = [];
    for (const section of sections) {
      const sAccess = await this.checkSectionAccess(userId, section, grades);
      if (!sAccess.visible && !canSeeHidden) continue;
      const modules: CourseContentView['sections'][number]['modules'] = [];
      for (const cm of cms.filter((c) => c.section === section.id)) {
        const access = await this.checkCmAccess(userId, cm, grades);
        if (!access.visible && !canSeeHidden) continue;
        modules.push({ ...cm, contextId: await this.cmContextId(cm.id), availabilityResult: access });
      }
      outSections.push({ ...section, availabilityResult: sAccess, modules });
    }
    return {
      course: courseRow,
      contextId: await this.courseContextId(courseId),
      customFields: await this.getCourseCustomFields(courseId),
      sections: outSections,
    };
  }
}
