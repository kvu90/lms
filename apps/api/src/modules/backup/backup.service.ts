import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { ENROL_ASSIGNMENT_COMPONENT, RolesService } from '../access/roles.service';
import { CoursesService } from '../courses/courses.service';
import { FilesService } from '../files/files.service';
import { BackupRepository, type JobRow } from './backup.repository';
import {
  badge, badgeCriteria, calendarEvents, calendarSubscriptions,
  course, courseCompletions, courseCompletionCriteria, courseCompletionCritCompl, courseCompletionSettings,
  courseGroups, courseModules, courseModulesCompletion, courseSections, enrol, files as filesTable,
  gradeGrades, gradeItems, groupings, groupingsGroups, groupsMembers,
  question, questionAnswerKeys, questionAnswers, questionBankEntries, questionCategories, questionTruefalse, questionVersions,
  qtypeEssayOptions, qtypeMultichoiceOptions, qtypeShortanswerOptions, stimuli,
  userEnrolments, users,
} from '../../db/schema';

/** Định dạng archive riêng có version — không phải .mbz. */
export const BACKUP_FORMAT = 'lms-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** Ngữ cảnh import dùng chung cho các contributor: tra cứu và ghi id mapping của job restore. */
export interface RestoreMapping {
  map(itemType: string, oldId: string, newId: string): Promise<void>;
  get(itemType: string, oldId: string): string | undefined;
}

/**
 * Một BackupContributor đăng ký đảo ngược (§3.12): export phần dữ liệu của
 * mình theo course và import với id-mapping. BackupService không import
 * service của module khác để lấy dữ liệu — contributor tự biết bảng của mình.
 * `courseId = null` nghĩa là phạm vi SITE (sao lưu mức hệ thống): chỉ các
 * contributor có `supportsSite = true` mới tham gia job site; các contributor
 * chỉ-mức-khoá bị bỏ qua ở cả export lẫn import của job site.
 */
export interface BackupContributor {
  name: string;
  /** Contributor có dữ liệu ở phạm vi hệ thống (site) hay không. */
  supportsSite?: boolean;
  export(courseId: string | null, anonymize: boolean): Promise<unknown>;
  import(targetCourseId: string | null, data: never, mapping: RestoreMapping, actorId: string): Promise<void>;
}

/**
 * Viết lại các tham chiếu id trong `params` của một lá tiêu chí badge qua
 * id-mapping của job restore: `courseId` → khoá mới, `cmId` → cm mới,
 * `competencyId` → năng lực mới (chỉ khi có mapping — năng lực là thực thể
 * mức site dùng chung, không nằm trong archive nên thường giữ nguyên),
 * `badgeId` → badge mới (khi badge được tham chiếu cũng nằm trong cùng
 * archive). Các khoá khác (cohortId/cohortIds/roleId/field/byDate…) là
 * tham chiếu mức site dùng chung nên giữ nguyên.
 */
export function remapBadgeCriteriaParams(
  params: unknown,
  mapping: RestoreMapping,
): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  const remap = (key: string, itemType: string): void => {
    const value = out[key];
    if (typeof value === 'string') {
      const mapped = mapping.get(itemType, value);
      if (mapped) out[key] = mapped;
    }
  };
  remap('courseId', 'course');
  remap('cmId', 'cm');
  remap('competencyId', 'competency');
  remap('badgeId', 'badge');
  return out;
}

/**
 * Facade của BackupModule (Moodle core_backup, §2#22).
 * Backup là một kế hoạch nhiều bước theo contributor; restore map lại mọi id
 * qua backup_id_mappings — không bao giờ giữ id gốc. Ba chế độ: new/merge/replace.
 */
@Injectable()
export class BackupService {
  private readonly contributors: BackupContributor[] = [];

  constructor(
    private readonly repo: BackupRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly roles: RolesService,
    private readonly courses: CoursesService,
    private readonly files: FilesService,
  ) {
    this.registerBuiltinContributors();
  }

  /** Đăng ký contributor — thứ tự đăng ký là thứ tự export/import. */
  registerContributor(c: BackupContributor): void { this.contributors.push(c); }
  listContributors(): string[] { return this.contributors.map((c) => c.name); }

  private registerBuiltinContributors(): void {
    const db = this.repo.dbHandle;
    // --- courses/sections/cm -------------------------------------------------
    this.registerContributor({
      name: 'courses',
      export: async (courseId) => {
        if (!courseId) return { course: null, sections: [], cms: [] };
        const [c] = await db.select().from(course).where(eq(course.id, courseId));
        const sections = await db.select().from(courseSections).where(eq(courseSections.course, courseId));
        const cms = await db.select().from(courseModules).where(eq(courseModules.course, courseId));
        return { course: c, sections, cms };
      },
      import: async (targetCourseId, data, mapping, actorId) => {
        if (!targetCourseId) return;
        const d = data as { sections: (typeof courseSections.$inferSelect)[]; cms: (typeof courseModules.$inferSelect)[] };
        const existing = await this.courses.listSections(targetCourseId);
        const sorted = [...d.sections].sort((a, b) => a.section - b.section);
        for (const s of sorted) {
          const already = existing.find((e) => e.section === s.section);
          if (already) { await mapping.map('section', s.id, already.id); continue; }
          const created = await this.courses.createSection(actorId, targetCourseId, { name: s.name ?? undefined, summary: s.summary, visible: s.visible });
          await mapping.map('section', s.id, created.id);
        }
        for (const cm of d.cms) {
          const sectionId = mapping.get('section', cm.section);
          if (!sectionId) continue;
          const created = await this.courses.createCm(actorId, targetCourseId, {
            sectionId, component: cm.component, instanceId: undefined, name: cm.name, visible: cm.visible,
            groupMode: cm.groupMode, completion: cm.completion, completionView: cm.completionView,
            completionUseGrade: cm.completionUseGrade, completionManual: cm.completionManual,
          });
          await mapping.map('cm', cm.id, created.id);
        }
      },
    });
    // --- enrol ---------------------------------------------------------------
    this.registerContributor({
      name: 'enrol',
      export: async (courseId, anonymize) => {
        if (!courseId) return { instances: [], enrolments: [] };
        const instances = await db.select().from(enrol).where(eq(enrol.courseId, courseId));
        const ues = instances.length ? await db.select().from(userEnrolments).where(inArray(userEnrolments.enrolId, instances.map((i) => i.id))) : [];
        return {
          instances,
          enrolments: ues.map((ue) => ({ ...ue, userId: anonymize ? null : ue.userId })),
        };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as { instances: (typeof enrol.$inferSelect)[]; enrolments: (typeof userEnrolments.$inferSelect)[] };
        const targetCtx = await this.courses.courseContextId(targetCourseId);
        for (const inst of d.instances) {
          const [row] = await db.insert(enrol).values({
            courseId: targetCourseId, enrol: inst.enrol, status: inst.status, name: inst.name, roleId: inst.roleId,
            enrolPeriod: inst.enrolPeriod, customInt1: inst.customInt1, customInt2: null, customText1: inst.customText1,
            cost: inst.cost, currency: inst.currency, paymentAccountId: inst.paymentAccountId,
          }).returning();
          await mapping.map('enrol', inst.id, row!.id);
        }
        for (const ue of d.enrolments) {
          if (!ue.userId) continue; // anonymize: không khôi phục danh tính
          const newInstance = mapping.get('enrol', ue.enrolId);
          if (!newInstance) continue;
          const [ueRow] = await db.insert(userEnrolments).values({
            enrolId: newInstance, userId: ue.userId, status: ue.status, timeStart: ue.timeStart, timeEnd: ue.timeEnd,
          }).onConflictDoNothing().returning();
          if (ueRow) await mapping.map('user_enrolment', ue.id, ueRow.id);
          const inst = d.instances.find((i) => i.id === ue.enrolId);
          // Ghi danh khôi phục vẫn là gán do enrol cấp: mang truy vết của
          // instance MỚI ở khoá đích để unenrol sau này gỡ đúng dòng này
          // (issue #157).
          if (inst?.roleId) await this.roles.assignRole(ue.userId, inst.roleId, targetCtx, undefined, { component: ENROL_ASSIGNMENT_COMPONENT, itemId: newInstance }).catch(() => undefined);
        }
      },
    });
    // --- groups ---------------------------------------------------------------
    this.registerContributor({
      name: 'groups',
      export: async (courseId) => {
        if (!courseId) return { groups: [], members: [], groupings: [], links: [] };
        const groups = await db.select().from(courseGroups).where(eq(courseGroups.courseId, courseId));
        const members = groups.length ? await db.select().from(groupsMembers).where(inArray(groupsMembers.groupId, groups.map((g) => g.id))) : [];
        const gps = await db.select().from(groupings).where(eq(groupings.courseId, courseId));
        const links = gps.length ? await db.select().from(groupingsGroups).where(inArray(groupingsGroups.groupingId, gps.map((g) => g.id))) : [];
        return { groups, members, groupings: gps, links };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as {
          groups: (typeof courseGroups.$inferSelect)[]; members: (typeof groupsMembers.$inferSelect)[];
          groupings: (typeof groupings.$inferSelect)[]; links: (typeof groupingsGroups.$inferSelect)[];
        };
        for (const g of d.groups) {
          const [row] = await db.insert(courseGroups).values({ courseId: targetCourseId, name: g.name, idNumber: g.idNumber, description: g.description })
            .onConflictDoNothing().returning();
          const existing = row ?? (await db.select().from(courseGroups).where(and(eq(courseGroups.courseId, targetCourseId), eq(courseGroups.name, g.name))))[0];
          if (existing) await mapping.map('group', g.id, existing.id);
        }
        for (const m of d.members) {
          const ng = mapping.get('group', m.groupId); if (!ng) continue;
          await db.insert(groupsMembers).values({ groupId: ng, userId: m.userId, component: m.component, itemId: m.itemId }).onConflictDoNothing();
        }
        for (const gp of d.groupings) {
          const [row] = await db.insert(groupings).values({ courseId: targetCourseId, name: gp.name, idNumber: gp.idNumber, description: gp.description })
            .onConflictDoNothing().returning();
          const existing = row ?? (await db.select().from(groupings).where(and(eq(groupings.courseId, targetCourseId), eq(groupings.name, gp.name))))[0];
          if (existing) await mapping.map('grouping', gp.id, existing.id);
        }
        for (const link of d.links) {
          const ngp = mapping.get('grouping', link.groupingId); const ng = mapping.get('group', link.groupId);
          if (!ngp || !ng) continue;
          await db.insert(groupingsGroups).values({ groupingId: ngp, groupId: ng }).onConflictDoNothing();
        }
      },
    });
    // --- grades ---------------------------------------------------------------
    this.registerContributor({
      name: 'grades',
      export: async (courseId, anonymize) => {
        if (!courseId) return { items: [], grades: [] };
        const items = await db.select().from(gradeItems).where(eq(gradeItems.courseId, courseId));
        const grades = items.length ? await db.select().from(gradeGrades).where(inArray(gradeGrades.itemId, items.map((i) => i.id))) : [];
        return { items, grades: grades.map((g) => ({ ...g, userId: anonymize ? 0 : g.userId })) };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        // Bản backup cũ có thể mang trường categories/item loại
        // category/course của gradebook tổng hợp đã gỡ (issue #224) —
        // các phần đó bị BỎ QUA khi khôi phục, chỉ item điểm theo bài
        // (manual/mod) và điểm của chúng được khôi phục.
        const d = data as {
          items: (typeof gradeItems.$inferSelect)[]; grades: (typeof gradeGrades.$inferSelect)[];
        };
        for (const item of d.items) {
          if (item.itemType !== 'mod' && item.itemType !== 'manual') continue;
          let instance = item.itemInstance;
          if (item.itemType === 'mod') instance = item.itemInstance ? (mapping.get('cm', item.itemInstance) ?? null) : null;
          const [row] = await db.insert(gradeItems).values({
            courseId: targetCourseId, itemName: item.itemName, itemType: item.itemType,
            itemModule: item.itemModule, itemInstance: instance, gradeType: item.gradeType, gradeMax: item.gradeMax,
            gradeMin: item.gradeMin, gradePass: item.gradePass,
            multiplicator: item.multiplicator, plusFactor: item.plusFactor,
            hidden: item.hidden, sortOrder: item.sortOrder, postingPolicy: item.postingPolicy,
          }).onConflictDoNothing().returning();
          const existing = row ?? (await db.select().from(gradeItems).where(and(
            eq(gradeItems.courseId, targetCourseId), eq(gradeItems.itemType, item.itemType), instance === null ? isNull(gradeItems.itemInstance) : eq(gradeItems.itemInstance, instance),
          )))[0];
          if (existing) await mapping.map('grade_item', item.id, existing.id);
        }
        for (const g of d.grades) {
          if (!g.userId) continue;
          const newItem = mapping.get('grade_item', g.itemId); if (!newItem) continue;
          await db.insert(gradeGrades).values({
            itemId: newItem, userId: g.userId, rawGrade: g.rawGrade, rawGradeMax: g.rawGradeMax, rawGradeMin: g.rawGradeMin,
            finalGrade: g.finalGrade, hidden: g.hidden, overridden: g.overridden, excluded: g.excluded, frozen: g.frozen, feedback: g.feedback,
          }).onConflictDoNothing();
        }
      },
    });
    // --- completion -------------------------------------------------------------
    this.registerContributor({
      name: 'completion',
      export: async (courseId, anonymize) => {
        if (!courseId) return { cmCompletion: [], courseCompletions: [], criteria: [], critCompl: [], settings: null };
        const cms = await db.select().from(courseModules).where(eq(courseModules.course, courseId));
        const cmComp = cms.length ? await db.select().from(courseModulesCompletion).where(inArray(courseModulesCompletion.courseModuleId, cms.map((c) => c.id))) : [];
        const courseComp = await db.select().from(courseCompletions).where(eq(courseCompletions.course, courseId));
        const criteria = await db.select().from(courseCompletionCriteria).where(eq(courseCompletionCriteria.course, courseId));
        // Bằng chứng đánh dấu thủ công (self/role crit_compl) đi kèm với
        // tiêu chí mà nó thuộc về, giống bản backup các dòng crit_compl của Moodle.
        const critCompl = criteria.length ? await db.select().from(courseCompletionCritCompl).where(inArray(courseCompletionCritCompl.criteriaId, criteria.map((c) => c.id))) : [];
        const [settings] = await db.select().from(courseCompletionSettings).where(eq(courseCompletionSettings.course, courseId));
        const scrub = <T extends { userId: string }>(rows: T[]): T[] => anonymize ? rows.map((r) => ({ ...r, userId: 0 })) : rows;
        return { cmCompletion: scrub(cmComp), courseCompletions: scrub(courseComp), criteria, critCompl: scrub(critCompl), settings: settings ?? null };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as {
          cmCompletion: (typeof courseModulesCompletion.$inferSelect)[]; courseCompletions: (typeof courseCompletions.$inferSelect)[];
          criteria: (typeof courseCompletionCriteria.$inferSelect)[]; critCompl?: (typeof courseCompletionCritCompl.$inferSelect)[];
          settings: (typeof courseCompletionSettings.$inferSelect) | null;
        };
        if (d.settings) {
          await db.insert(courseCompletionSettings).values({ course: targetCourseId, method: d.settings.method })
            .onConflictDoUpdate({ target: courseCompletionSettings.course, set: { method: d.settings.method } });
        }
        const criteriaIdMap = new Map<string, string>();
        for (const crit of d.criteria) {
          const moduleInstance = crit.moduleInstance ? mapping.get('cm', crit.moduleInstance) ?? null : null;
          const [inserted] = await db.insert(courseCompletionCriteria).values({
            course: targetCourseId, criteriaType: crit.criteriaType, moduleInstance, date: crit.date,
            // courseInstance/roleId tham chiếu tới các đối tượng NGOÀI bản backup của
            // khoá học này (khoá học tiên quyết, role hệ thống) và được giữ nguyên như cũ.
            courseInstance: crit.courseInstance ?? null, enrolPeriodDays: crit.enrolPeriodDays ?? null, roleId: crit.roleId ?? null,
            sortOrder: crit.sortOrder,
          }).returning();
          if (inserted) criteriaIdMap.set(crit.id, inserted.id);
        }
        for (const mark of d.critCompl ?? []) {
          if (!mark.userId) continue;
          const newCriteriaId = criteriaIdMap.get(mark.criteriaId); if (!newCriteriaId) continue;
          await db.insert(courseCompletionCritCompl).values({
            criteriaId: newCriteriaId, userId: mark.userId, markedBy: mark.markedBy, timeCompleted: mark.timeCompleted,
          }).onConflictDoNothing();
        }
        for (const row of d.cmCompletion) {
          if (!row.userId) continue;
          const newCm = mapping.get('cm', row.courseModuleId); if (!newCm) continue;
          await db.insert(courseModulesCompletion).values({
            courseModuleId: newCm, userId: row.userId, completionState: row.completionState, viewed: row.viewed, overrideBy: row.overrideBy,
          }).onConflictDoNothing();
        }
        for (const row of d.courseCompletions) {
          if (!row.userId) continue;
          await db.insert(courseCompletions).values({
            userId: row.userId, course: targetCourseId, status: row.status, timeEnrolled: row.timeEnrolled,
            timeStarted: row.timeStarted, timeCompleted: row.timeCompleted,
          }).onConflictDoNothing();
        }
      },
    });
    // --- files (theo contentHash) -------------------------------------------------
    this.registerContributor({
      name: 'files',
      export: async (courseId) => {
        if (!courseId) return { files: [] };
        const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
        const cms = await db.select().from(courseModules).where(eq(courseModules.course, courseId));
        const ctxIds: string[] = courseCtx ? [courseCtx.id] : [];
        for (const cm of cms) {
          const ctx = await this.contexts.getByLevelInstance(70, cm.id);
          if (ctx) ctxIds.push(ctx.id);
        }
        if (!ctxIds.length) return { files: [] };
        const rows = await db.select().from(filesTable).where(inArray(filesTable.contextId, ctxIds));
        const out = [];
        for (const f of rows) {
          const { data } = await this.files.readContent(f.id);
          out.push({ ...f, dataBase64: data.toString('base64') });
        }
        return { files: out };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as { files: ((typeof filesTable.$inferSelect) & { dataBase64: string })[] };
        const newCourseCtx = await this.courses.courseContextId(targetCourseId);
        for (const f of d.files) {
          // Context mới: cm context nếu item thuộc cm đã map, ngược lại course context mới.
          let newContextId = newCourseCtx;
          const oldCtx = await this.contexts.getContext(f.contextId).catch(() => undefined);
          if (oldCtx?.contextLevel === 70) {
            const newCm = oldCtx.instanceId ? mapping.get('cm', oldCtx.instanceId) : undefined;
            if (newCm) {
              const ctx = await this.contexts.getByLevelInstance(70, newCm);
              if (ctx) newContextId = ctx.id;
            }
          }
          const itemId = f.itemId ? (mapping.get('cm', f.itemId) ?? f.itemId) : null;
          const created = await this.files.upload({
            contextId: newContextId, component: f.component, fileArea: f.fileArea, itemId: itemId ?? undefined,
            filePath: f.filePath, fileName: f.fileName, data: Buffer.from(f.dataBase64, 'base64'),
            mimeType: f.mimeType ?? undefined, userId: f.userId ?? undefined,
          });
          await mapping.map('file', f.id, created.id);
        }
      },
    });
    // --- ngân hàng câu hỏi ---------------------------------------------------------
    // Ngân hàng câu hỏi bám theo CONTEXT (bản model hiện hữu): category của
    // khoá nằm ở context của khoá (level 50), category mức site nằm ở context
    // hệ thống (level 10). Export cây category + question + bank entry + MỌI
    // version. KHÔNG export question_usages / question_attempts / steps:
    // đó là dữ liệu vận hành (lượt làm bài) chứ không phải nội dung bank.
    this.registerContributor({
      name: 'questions',
      supportsSite: true,
      export: async (courseId) => {
        const ctxId = courseId
          ? (await this.contexts.getByLevelInstance(50, courseId))?.id
          : (await this.contexts.ensureSystemContext()).id;
        if (!ctxId) return { categories: [], questions: [], entries: [], versions: [], stimuli: [], answers: [], answerKeys: [], multichoiceOptions: [], truefalseOptions: [], shortanswerOptions: [], essayOptions: [] };
        const categories = await db.select().from(questionCategories).where(eq(questionCategories.contextId, ctxId));
        const catIds = categories.map((c) => c.id);
        const questions = catIds.length ? await db.select().from(question).where(inArray(question.category, catIds)) : [];
        const entries = catIds.length ? await db.select().from(questionBankEntries).where(inArray(questionBankEntries.questionCategoryId, catIds)) : [];
        const entryIds = entries.map((e) => e.id);
        const versions = entryIds.length ? await db.select().from(questionVersions).where(inArray(questionVersions.questionBankEntryId, entryIds)) : [];
        const versionIds = versions.map((v) => v.id);
        // Nội dung chấm của version (answers + options từng qtype) và ngữ
        // liệu của category đi cùng archive — thiếu chúng thì bản restore
        // mất toàn bộ dữ liệu chấm.
        const stimuliRows = catIds.length ? await db.select().from(stimuli).where(inArray(stimuli.categoryId, catIds)) : [];
        const answers = versionIds.length ? await db.select().from(questionAnswers).where(inArray(questionAnswers.questionVersionId, versionIds)) : [];
        // Bản ghi phía đáp án (guidance + solution) của từng version —
        // thiếu nó thì bản restore mất hướng dẫn và lời giải mẫu.
        const answerKeys = versionIds.length ? await db.select().from(questionAnswerKeys).where(inArray(questionAnswerKeys.questionVersionId, versionIds)) : [];
        const multichoiceOptions = versionIds.length ? await db.select().from(qtypeMultichoiceOptions).where(inArray(qtypeMultichoiceOptions.questionVersionId, versionIds)) : [];
        const truefalseOptions = versionIds.length ? await db.select().from(questionTruefalse).where(inArray(questionTruefalse.questionVersionId, versionIds)) : [];
        const shortanswerOptions = versionIds.length ? await db.select().from(qtypeShortanswerOptions).where(inArray(qtypeShortanswerOptions.questionVersionId, versionIds)) : [];
        const essayOptions = versionIds.length ? await db.select().from(qtypeEssayOptions).where(inArray(qtypeEssayOptions.questionVersionId, versionIds)) : [];
        return { categories, questions, entries, versions, stimuli: stimuliRows, answers, answerKeys, multichoiceOptions, truefalseOptions, shortanswerOptions, essayOptions };
      },
      import: async (targetCourseId, data, mapping) => {
        const d = data as {
          categories: (typeof questionCategories.$inferSelect)[]; questions: (typeof question.$inferSelect)[];
          entries: (typeof questionBankEntries.$inferSelect)[]; versions: (typeof questionVersions.$inferSelect)[];
          stimuli?: (typeof stimuli.$inferSelect)[]; answers?: (typeof questionAnswers.$inferSelect)[];
          answerKeys?: (typeof questionAnswerKeys.$inferSelect)[];
          multichoiceOptions?: (typeof qtypeMultichoiceOptions.$inferSelect)[]; truefalseOptions?: (typeof questionTruefalse.$inferSelect)[];
          shortanswerOptions?: (typeof qtypeShortanswerOptions.$inferSelect)[]; essayOptions?: (typeof qtypeEssayOptions.$inferSelect)[];
        };
        if (!d.categories?.length && !d.questions?.length) return;
        const targetCtxId = targetCourseId
          ? await this.courses.courseContextId(targetCourseId)
          : (await this.contexts.ensureSystemContext()).id;
        // Category là cây theo `parent`: tạo cha trước con (lặp tới khi hết
        // tiến triển); category nào có cha NGOÀI phạm vi archive thì gắn gốc.
        const pending = [...(d.categories ?? [])];
        let progressed = true;
        while (pending.length && progressed) {
          progressed = false;
          for (let i = pending.length - 1; i >= 0; i--) {
            const cat = pending[i]!;
            if (cat.parent && !mapping.get('question_category', cat.parent)) continue;
            const [row] = await db.insert(questionCategories).values({
              name: cat.name, contextId: targetCtxId, info: cat.info,
              parent: cat.parent ? mapping.get('question_category', cat.parent)! : null,
              sortOrder: cat.sortOrder, stamp: cat.stamp,
            }).returning();
            await mapping.map('question_category', cat.id, row!.id);
            pending.splice(i, 1);
            progressed = true;
          }
        }
        for (const cat of pending) {
          const [row] = await db.insert(questionCategories).values({
            name: cat.name, contextId: targetCtxId, info: cat.info, parent: null, sortOrder: cat.sortOrder, stamp: cat.stamp,
          }).returning();
          await mapping.map('question_category', cat.id, row!.id);
        }
        for (const q of d.questions ?? []) {
          const newCategory = mapping.get('question_category', q.category);
          if (!newCategory) continue;
          const [row] = await db.insert(question).values({
            category: newCategory, qtype: q.qtype, createdBy: q.createdBy, modifiedBy: q.modifiedBy,
          }).returning();
          await mapping.map('question', q.id, row!.id);
        }
        for (const e of d.entries ?? []) {
          const newCategory = mapping.get('question_category', e.questionCategoryId);
          const newQuestion = mapping.get('question', e.questionId);
          if (!newCategory || !newQuestion) continue;
          const [row] = await db.insert(questionBankEntries).values({
            questionCategoryId: newCategory, questionId: newQuestion, latestVersion: e.latestVersion, status: e.status,
          }).onConflictDoNothing().returning();
          const created = row ?? (await db.select().from(questionBankEntries).where(eq(questionBankEntries.questionId, newQuestion)))[0];
          if (created) await mapping.map('question_bank_entry', e.id, created.id);
        }
        for (const s of d.stimuli ?? []) {
          const newCategory = mapping.get('question_category', s.categoryId);
          if (!newCategory) continue;
          const [row] = await db.insert(stimuli).values({
            categoryId: newCategory, createdBy: s.createdBy, content: s.content,
          }).returning();
          await mapping.map('stimulus', s.id, row!.id);
        }
        for (const v of [...(d.versions ?? [])].sort((a, b) => a.version - b.version)) {
          const newEntry = mapping.get('question_bank_entry', v.questionBankEntryId);
          const newQuestion = mapping.get('question', v.questionId);
          if (!newEntry || !newQuestion) continue;
          const [row] = await db.insert(questionVersions).values({
            questionBankEntryId: newEntry, questionId: newQuestion, version: v.version, status: v.status,
            questionText: v.questionText, generalFeedback: v.generalFeedback,
            defaultMark: v.defaultMark, penalty: v.penalty,
            stimulusId: v.stimulusId ? (mapping.get('stimulus', v.stimulusId) ?? null) : null,
          }).onConflictDoNothing().returning();
          if (row) await mapping.map('question_version', v.id, row.id);
        }
        for (const a of d.answers ?? []) {
          const newVersion = mapping.get('question_version', a.questionVersionId);
          if (!newVersion) continue;
          const [row] = await db.insert(questionAnswers).values({
            questionVersionId: newVersion, answer: a.answer, isCorrect: a.isCorrect,
            feedback: a.feedback, sortOrder: a.sortOrder,
          }).returning();
          await mapping.map('question_answer', a.id, row!.id);
        }
        for (const k of d.answerKeys ?? []) {
          const newVersion = mapping.get('question_version', k.questionVersionId);
          if (!newVersion) continue;
          await db.insert(questionAnswerKeys).values({
            questionVersionId: newVersion, guidance: k.guidance, solution: k.solution,
          }).onConflictDoNothing();
        }
        for (const o of d.multichoiceOptions ?? []) {
          const newVersion = mapping.get('question_version', o.questionVersionId);
          if (!newVersion) continue;
          await db.insert(qtypeMultichoiceOptions).values({
            questionVersionId: newVersion, shuffleAnswers: o.shuffleAnswers,
            answerNumbering: o.answerNumbering, correctFeedback: o.correctFeedback,
            incorrectFeedback: o.incorrectFeedback,
            showStandardInstruction: o.showStandardInstruction,
          }).onConflictDoNothing();
        }
        for (const o of d.truefalseOptions ?? []) {
          const newVersion = mapping.get('question_version', o.questionVersionId);
          const newTrue = mapping.get('question_answer', o.trueAnswer);
          const newFalse = mapping.get('question_answer', o.falseAnswer);
          if (!newVersion || !newTrue || !newFalse) continue;
          await db.insert(questionTruefalse).values({
            questionVersionId: newVersion, trueAnswer: newTrue, falseAnswer: newFalse,
            showStandardInstruction: o.showStandardInstruction,
          }).onConflictDoNothing();
        }
        for (const o of d.shortanswerOptions ?? []) {
          const newVersion = mapping.get('question_version', o.questionVersionId);
          if (!newVersion) continue;
          await db.insert(qtypeShortanswerOptions).values({
            questionVersionId: newVersion, useCase: o.useCase,
          }).onConflictDoNothing();
        }
        for (const o of d.essayOptions ?? []) {
          const newVersion = mapping.get('question_version', o.questionVersionId);
          if (!newVersion) continue;
          await db.insert(qtypeEssayOptions).values({
            questionVersionId: newVersion, responseFormat: o.responseFormat, responseRequired: o.responseRequired,
            responseFieldLines: o.responseFieldLines, minWordLimit: o.minWordLimit, maxWordLimit: o.maxWordLimit,
            graderInfo: o.graderInfo, responseTemplate: o.responseTemplate,
          }).onConflictDoNothing();
        }
      },
    });
    // --- badges ------------------------------------------------------------------
    // Định nghĩa badge của khoá (type=2) hoặc mức site (type=1) + toàn bộ
    // criteria; params của criteria được viết lại qua mapping (xem
    // remapBadgeCriteriaParams). KHÔNG export badge_issued (lượt đã cấp —
    // assertion là bằng chứng lịch sử của khoá gốc) và badge_manual_award.
    this.registerContributor({
      name: 'badges',
      supportsSite: true,
      export: async (courseId) => {
        const badges = courseId
          ? await db.select().from(badge).where(eq(badge.courseId, courseId))
          : await db.select().from(badge).where(isNull(badge.courseId));
        const criteria = badges.length ? await db.select().from(badgeCriteria).where(inArray(badgeCriteria.badgeId, badges.map((b) => b.id))) : [];
        return { badges, criteria };
      },
      import: async (targetCourseId, data, mapping, actorId) => {
        const d = data as { badges: (typeof badge.$inferSelect)[]; criteria: (typeof badgeCriteria.$inferSelect)[] };
        // Pha 1: tạo badge trước để tiêu chí `badge` tham chiếu chéo trong
        // cùng archive tra được mapping ở pha 2.
        for (const b of d.badges ?? []) {
          const [row] = await db.insert(badge).values({
            name: b.name, description: b.description, type: targetCourseId ? 2 : b.type,
            courseId: targetCourseId ?? null,
            issuerName: b.issuerName, issuerUrl: b.issuerUrl, issuerContact: b.issuerContact,
            expireDate: b.expireDate ? new Date(b.expireDate as unknown as string) : null,
            expirePeriod: b.expirePeriod, status: b.status, version: b.version, language: b.language,
            userCreated: actorId, userModified: actorId,
          }).returning();
          await mapping.map('badge', b.id, row!.id);
        }
        for (const c of d.criteria ?? []) {
          const newBadge = mapping.get('badge', c.badgeId);
          if (!newBadge) continue;
          const [row] = await db.insert(badgeCriteria).values({
            badgeId: newBadge, criteriaType: c.criteriaType, method: c.method,
            params: remapBadgeCriteriaParams(c.params, mapping), description: c.description,
          }).returning();
          if (row) await mapping.map('badge_criteria', c.id, row.id);
        }
      },
    });
    // --- calendar ------------------------------------------------------------------
    // Sự kiện mức khoá (course + group; group được map qua contributor groups
    // chạy trước) và subscription của khoá; ở phạm vi site là sự kiện
    // eventType='site' + subscription mức site. Chuỗi lặp: repeatId /
    // exceptionOf được nối lại ở pha 2 sau khi mọi sự kiện đã có id mới.
    this.registerContributor({
      name: 'calendar',
      supportsSite: true,
      export: async (courseId) => {
        const events = courseId
          ? await db.select().from(calendarEvents).where(eq(calendarEvents.courseId, courseId))
          : await db.select().from(calendarEvents).where(eq(calendarEvents.eventType, 'site'));
        const subscriptions = courseId
          ? await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.courseId, courseId))
          : await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.eventType, 'site'));
        return { events, subscriptions };
      },
      import: async (targetCourseId, data, mapping) => {
        const d = data as { events: (typeof calendarEvents.$inferSelect)[]; subscriptions: (typeof calendarSubscriptions.$inferSelect)[] };
        for (const s of d.subscriptions ?? []) {
          const [row] = await db.insert(calendarSubscriptions).values({
            name: s.name, url: s.url, icsData: s.icsData, eventType: s.eventType,
            courseId: s.courseId ? targetCourseId ?? null : null,
            categoryId: s.categoryId, userId: s.userId, pollInterval: s.pollInterval, lastUpdated: s.lastUpdated,
          }).returning();
          await mapping.map('calendar_subscription', s.id, row!.id);
        }
        const targetCtxId = targetCourseId ? await this.courses.courseContextId(targetCourseId).catch(() => null) : null;
        const systemCtxId = (await this.contexts.ensureSystemContext()).id;
        for (const e of d.events ?? []) {
          const newCourseId = e.courseId ? targetCourseId ?? null : null;
          const newContextId = newCourseId ? targetCtxId : e.eventType === 'site' ? systemCtxId : e.contextId;
          const [row] = await db.insert(calendarEvents).values({
            name: e.name, description: e.description, eventType: e.eventType,
            courseId: newCourseId,
            groupId: e.groupId ? mapping.get('group', e.groupId) ?? null : null,
            categoryId: e.categoryId, userId: e.userId, contextId: newContextId,
            subscriptionId: e.subscriptionId ? mapping.get('calendar_subscription', e.subscriptionId) ?? null : null,
            uuid: e.uuid, repeatId: null, rrule: e.rrule,
            isException: e.isException, exceptionOf: null,
            timeStart: new Date(e.timeStart as unknown as string), timeDuration: e.timeDuration,
            visible: e.visible, location: e.location,
          }).returning();
          await mapping.map('calendar_event', e.id, row!.id);
        }
        for (const e of d.events ?? []) {
          const newId = mapping.get('calendar_event', e.id);
          if (!newId) continue;
          const patch: { repeatId?: string | null; exceptionOf?: string | null } = {};
          if (e.repeatId) patch.repeatId = mapping.get('calendar_event', e.repeatId) ?? null;
          if (e.exceptionOf) patch.exceptionOf = mapping.get('calendar_event', e.exceptionOf) ?? null;
          if (Object.keys(patch).length) {
            await db.update(calendarEvents).set(patch).where(eq(calendarEvents.id, newId));
          }
        }
      },
    });
  }

  async getJob(id: string): Promise<JobRow> {
    const row = await this.repo.getJob(id);
    if (!row) throw new NotFoundException({ message: `Backup job ${id} not found`, code: 'backup.job_not_found' });
    return row;
  }

  /**
   * Cổng đọc job (H7, rà soát #134): các đường đọc job/steps/mappings/
   * checklist trước đây không gác gì trong khi create/restore đã đòi
   * capability — nay người đọc phải có `backup:backupcourse` hoặc
   * `backup:restorecourse` tại context của khoá thuộc job (job site-scope
   * thì tại context hệ thống), đúng khuôn hai đường ghi.
   */
  private async jobReadContextId(job: JobRow): Promise<string> {
    if (job.scope === 'course' && job.courseId) return this.courses.courseContextId(job.courseId);
    return (await this.contexts.ensureSystemContext()).id;
  }
  private async canReadJob(actorId: string, job: JobRow): Promise<boolean> {
    const ctxId = await this.jobReadContextId(job);
    if (await this.evaluator.hasCapability(actorId, 'backup:backupcourse', ctxId)) return true;
    return this.evaluator.hasCapability(actorId, 'backup:restorecourse', ctxId);
  }
  private async assertJobReadable(actorId: string, job: JobRow): Promise<void> {
    if (await this.canReadJob(actorId, job)) return;
    throw new ForbiddenException({ message: 'You cannot view this backup job', code: 'backup.job_forbidden' });
  }
  /** Chi tiết job qua HTTP: qua cổng đọc job (H7). */
  async getJobForRead(actorId: string, id: string): Promise<JobRow> {
    const job = await this.getJob(id);
    await this.assertJobReadable(actorId, job);
    return job;
  }
  /** Danh sách job qua HTTP: chỉ các job người gọi qua được cổng đọc (H7). */
  async listJobs(actorId: string): Promise<JobRow[]> {
    const rows = await this.repo.listJobs();
    const out: JobRow[] = [];
    for (const row of rows) if (await this.canReadJob(actorId, row)) out.push(row);
    return out;
  }
  async listSteps(actorId: string, jobId: string) {
    await this.assertJobReadable(actorId, await this.getJob(jobId));
    return this.repo.listSteps(jobId);
  }
  async listMappings(actorId: string, jobId: string) {
    await this.assertJobReadable(actorId, await this.getJob(jobId));
    return this.repo.listMappings(jobId);
  }

  /**
   * Tạo và chạy backup job (API twin của worker processor): ghi bước cho từng
   * contributor. Phạm vi `course` cần `courseId`; phạm vi `site` sao lưu mức
   * hệ thống (courseId = null, chỉ các contributor `supportsSite` tham gia —
   * question bank mức site, badge mức site, calendar mức site) và kiểm tra
   * capability tại context hệ thống.
   */
  async createBackup(actorId: string, courseId: string | null, anonymize = false, scope: 'course' | 'site' = 'course'): Promise<JobRow> {
    if (scope === 'site' && courseId) {
      throw new BadRequestException({ message: 'A site backup must not be attached to a course', code: 'backup.site_course_forbidden' });
    }
    if (scope === 'course' && !courseId) {
      throw new BadRequestException({ message: 'A course backup requires a course', code: 'backup.course_required' });
    }
    const courseRow = scope === 'course' ? await this.courses.getCourse(courseId!) : null;
    if (scope === 'course') {
      await this.evaluator.requireCapability(actorId, 'backup:backupcourse', await this.courses.courseContextId(courseId!));
    } else {
      await this.evaluator.requireCapability(actorId, 'backup:backupcourse', (await this.contexts.ensureSystemContext()).id);
    }
    const job = await this.repo.insertJob({ type: 'backup', scope, courseId: courseId, userId: actorId, anonymize, status: 'running' });
    try {
      const contributorsData: Record<string, unknown> = {};
      for (const c of this.contributors) {
        if (scope === 'site' && !c.supportsSite) {
          const step = await this.repo.insertStep({ jobId: job.id, name: c.name, status: 'running' });
          await this.repo.updateStep(step.id, { status: 'completed', detail: { skipped: 'course-scope-only' } });
          continue;
        }
        const step = await this.repo.insertStep({ jobId: job.id, name: c.name, status: 'running' });
        const data = await c.export(courseId, anonymize);
        contributorsData[c.name] = data;
        await this.repo.updateStep(step.id, { status: 'completed', detail: { exported: true } });
      }
      const archive = {
        format: BACKUP_FORMAT, version: BACKUP_FORMAT_VERSION, scope, courseId,
        course: courseRow
          ? { fullName: courseRow.fullName, shortName: courseRow.shortName, category: courseRow.category, summary: courseRow.summary }
          : null,
        anonymize, contributors: contributorsData,
      };
      await this.repo.updateJob(job.id, { status: 'completed', archive, timeFinished: new Date() });
    } catch (e) {
      await this.repo.updateJob(job.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), timeFinished: new Date() });
    }
    return this.getJob(job.id);
  }

  /**
   * Tạo và chạy restore job với 3 chế độ tường minh. Backup mức SITE chỉ
   * khôi phục ở chế độ `new` (tạo dữ liệu mức site MỚI, không có khoá đích):
   * merge/replace/khoá đích đều bị từ chối vì không có course đích để gộp.
   */
  async restore(actorId: string, backupJobId: string, mode: 'new' | 'merge' | 'replace', targetCourseId?: string): Promise<JobRow> {
    const backup = await this.getJob(backupJobId);
    if (backup.type !== 'backup' || backup.status !== 'completed' || !backup.archive) {
      throw new BadRequestException({ message: 'Backup job is not a completed backup', code: 'backup.not_completed' });
    }
    const archive = backup.archive as {
      format: string; version: number; scope?: string;
      course: { fullName: string; shortName: string; category: string; summary: string } | null;
      contributors: Record<string, unknown>;
    };
    if (archive.format !== BACKUP_FORMAT || archive.version !== BACKUP_FORMAT_VERSION) {
      throw new BadRequestException({ message: `Unsupported backup format ${archive.format} v${archive.version}`, code: 'backup.unsupported_format' });
    }
    const scope: 'course' | 'site' = backup.scope === 'site' || archive.scope === 'site' ? 'site' : 'course';

    if (scope === 'site') {
      if (mode !== 'new' || targetCourseId) {
        throw new BadRequestException({ message: 'A site backup can only be restored as new site-level data, without a target course', code: 'backup.site_target_forbidden' });
      }
      await this.evaluator.requireCapability(actorId, 'backup:restorecourse', (await this.contexts.ensureSystemContext()).id);
      const job = await this.repo.insertJob({
        type: 'restore', scope: 'site', courseId: null, targetCourseId: null, mode, userId: actorId, status: 'running',
      });
      const mappingState = new Map<string, string>();
      const mapping: RestoreMapping = {
        map: async (itemType, oldId, newId) => {
          mappingState.set(`${itemType}:${oldId}`, newId);
          await this.repo.insertMapping({ jobId: job.id, itemType, oldId, newId });
        },
        get: (itemType, oldId) => mappingState.get(`${itemType}:${oldId}`),
      };
      try {
        for (const c of this.contributors) {
          const step = await this.repo.insertStep({ jobId: job.id, name: c.name, status: 'running' });
          const data = archive.contributors[c.name];
          if (data !== undefined) await c.import(null, data as never, mapping, actorId);
          await this.repo.updateStep(step.id, { status: 'completed' });
        }
        await this.repo.updateJob(job.id, { status: 'completed', timeFinished: new Date() });
      } catch (e) {
        await this.repo.updateJob(job.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), timeFinished: new Date() });
      }
      return this.getJob(job.id);
    }

    if (!archive.course) {
      throw new BadRequestException({ message: 'Backup archive has no course payload', code: 'backup.not_completed' });
    }
    if (mode !== 'new' && !targetCourseId) throw new BadRequestException({ message: `Restore mode ${mode} requires targetCourseId`, code: 'backup.target_required' });
    if (mode === 'new' && targetCourseId) throw new BadRequestException({ message: 'Restore mode new must not pass targetCourseId', code: 'backup.target_forbidden' });

    let targetId: string;
    if (mode === 'new') {
      await this.evaluator.requireCapability(actorId, 'backup:restorecourse', await this.courses.categoryContextId(archive.course.category));
      const created = await this.courses.createCourse(actorId, {
        fullName: archive.course.fullName, shortName: `${archive.course.shortName}-r${Date.now().toString(36)}`,
        category: archive.course.category, summary: archive.course.summary,
      });
      targetId = created.id;
    } else {
      targetId = targetCourseId!;
      await this.evaluator.requireCapability(actorId, 'backup:restorecourse', await this.courses.courseContextId(targetId));
    }

    const job = await this.repo.insertJob({
      type: 'restore', scope: 'course', courseId: backup.courseId, targetCourseId: targetId, mode, userId: actorId, status: 'running',
    });
    const mappingState = new Map<string, string>();
    const mapping: RestoreMapping = {
      map: async (itemType, oldId, newId) => {
        mappingState.set(`${itemType}:${oldId}`, newId);
        await this.repo.insertMapping({ jobId: job.id, itemType, oldId, newId });
      },
      get: (itemType, oldId) => mappingState.get(`${itemType}:${oldId}`),
    };
    if (backup.courseId) await mapping.map('course', backup.courseId, targetId);
    try {
      if (mode === 'replace') await this.clearCourseContent(targetId);
      for (const c of this.contributors) {
        const step = await this.repo.insertStep({ jobId: job.id, name: c.name, status: 'running' });
        const data = archive.contributors[c.name];
        if (data !== undefined) await c.import(targetId, data as never, mapping, actorId);
        await this.repo.updateStep(step.id, { status: 'completed' });
      }
      await this.repo.updateJob(job.id, { status: 'completed', timeFinished: new Date() });
    } catch (e) {
      await this.repo.updateJob(job.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), timeFinished: new Date() });
    }
    return this.getJob(job.id);
  }

  /** Replace mode: xoá nội dung hiện có của course đích trước khi khôi phục. */
  private async clearCourseContent(courseId: string): Promise<void> {
    const db = this.repo.dbHandle;
    await db.delete(courseSections).where(eq(courseSections.course, courseId));
    await db.delete(enrol).where(eq(enrol.courseId, courseId));
    await db.delete(gradeItems).where(eq(gradeItems.courseId, courseId));
    await db.delete(courseCompletions).where(eq(courseCompletions.course, courseId));
    await db.delete(courseGroups).where(eq(courseGroups.courseId, courseId));
    await db.delete(groupings).where(eq(groupings.courseId, courseId));
    await db.delete(badge).where(eq(badge.courseId, courseId));
    await db.delete(calendarEvents).where(eq(calendarEvents.courseId, courseId));
    await db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.courseId, courseId));
    const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
    if (courseCtx) await db.delete(questionCategories).where(eq(questionCategories.contextId, courseCtx.id));
  }

  /**
   * Checklist tương đương giữa course nguồn và course đích của một restore job.
   * Với restore mức SITE không có khoá đích: phía đích sống CÙNG không gian
   * với phía nguồn (cùng context hệ thống) nên không đếm trực tiếp được —
   * `target` là số bản ghi MỚI mà job đã tạo theo từng itemType trong
   * backup_id_mappings, `source` là tổng hiện có trừ đi phần mới tạo đó.
   */
  async restoreChecklist(actorId: string, restoreJobId: string): Promise<Record<string, { source: number; target: number }>> {
    const job = await this.getJob(restoreJobId);
    await this.assertJobReadable(actorId, job);
    const db = this.repo.dbHandle;
    if (job.scope === 'site' || !job.targetCourseId) {
      const mappings = await this.repo.listMappings(job.id);
      const mapped = (itemType: string) => mappings.filter((m) => m.itemType === itemType).length;
      const systemCtx = await this.contexts.ensureSystemContext();
      const siteCategories = await db.select().from(questionCategories).where(eq(questionCategories.contextId, systemCtx.id));
      const siteQuestions = siteCategories.length
        ? await db.select().from(question).where(inArray(question.category, siteCategories.map((c) => c.id)))
        : [];
      const siteBadges = await db.select().from(badge).where(isNull(badge.courseId));
      const siteEvents = await db.select().from(calendarEvents).where(eq(calendarEvents.eventType, 'site'));
      const siteSubs = await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.eventType, 'site'));
      const entry = (total: number, itemType: string) => ({ source: Math.max(0, total - mapped(itemType)), target: mapped(itemType) });
      return {
        questionCategories: entry(siteCategories.length, 'question_category'),
        questions: entry(siteQuestions.length, 'question'),
        badges: entry(siteBadges.length, 'badge'),
        calendarEvents: entry(siteEvents.length, 'calendar_event'),
        calendarSubscriptions: entry(siteSubs.length, 'calendar_subscription'),
      };
    }
    const targetId = job.targetCourseId;
    const countFor = async (courseId: string) => {
      const sections = await db.select().from(courseSections).where(eq(courseSections.course, courseId));
      const cms = await db.select().from(courseModules).where(eq(courseModules.course, courseId));
      const instances = await db.select().from(enrol).where(eq(enrol.courseId, courseId));
      const ues = instances.length ? await db.select().from(userEnrolments).where(inArray(userEnrolments.enrolId, instances.map((i) => i.id))) : [];
      const items = await db.select().from(gradeItems).where(eq(gradeItems.courseId, courseId));
      const grades = items.length ? await db.select().from(gradeGrades).where(inArray(gradeGrades.itemId, items.map((i) => i.id))) : [];
      const cmComp = cms.length ? await db.select().from(courseModulesCompletion).where(inArray(courseModulesCompletion.courseModuleId, cms.map((c) => c.id))) : [];
      const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
      const qCats = courseCtx ? await db.select().from(questionCategories).where(eq(questionCategories.contextId, courseCtx.id)) : [];
      const qRows = qCats.length ? await db.select().from(question).where(inArray(question.category, qCats.map((c) => c.id))) : [];
      const qEntries = qCats.length ? await db.select().from(questionBankEntries).where(inArray(questionBankEntries.questionCategoryId, qCats.map((c) => c.id))) : [];
      const qVersions = qEntries.length ? await db.select().from(questionVersions).where(inArray(questionVersions.questionBankEntryId, qEntries.map((e) => e.id))) : [];
      const courseBadges = await db.select().from(badge).where(eq(badge.courseId, courseId));
      const badgeCriteriaCount = courseBadges.length
        ? (await db.select().from(badgeCriteria).where(inArray(badgeCriteria.badgeId, courseBadges.map((b) => b.id)))).length
        : 0;
      const calEvents = await db.select().from(calendarEvents).where(eq(calendarEvents.courseId, courseId));
      const calSubs = await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.courseId, courseId));
      // completion nguồn tính theo cms nguồn — hàm này chỉ gọi với course tương ứng nên cms ở đây là của course đó.
      return {
        sections: sections.length, cms: cms.length, enrolInstances: instances.length, enrolments: ues.length,
        gradeItems: items.length, grades: grades.length, cmCompletion: cmComp.length,
        questionCategories: qCats.length, questions: qRows.length, questionVersions: qVersions.length,
        badges: courseBadges.length, badgeCriteria: badgeCriteriaCount,
        calendarEvents: calEvents.length, calendarSubscriptions: calSubs.length,
      };
    };
    const source = await countFor(job.courseId!);
    const target = await countFor(targetId);
    const out: Record<string, { source: number; target: number }> = {};
    for (const k of Object.keys(source) as (keyof typeof source)[]) out[k] = { source: source[k], target: target[k] };
    void users;
    return out;
  }
}
