import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { RolesService } from '../access/roles.service';
import { CoursesService } from '../courses/courses.service';
import { FilesService } from '../files/files.service';
import { BackupRepository, type JobRow } from './backup.repository';
import {
  badge, badgeCriteria, calendarEvents, calendarSubscriptions,
  course, courseCompletions, courseCompletionCriteria, courseCompletionSettings,
  courseGroups, courseModules, courseModulesCompletion, courseSections, enrol, files as filesTable,
  gradeCategories, gradeGrades, gradeItems, groupings, groupingsGroups, groupsMembers,
  question, questionBankEntries, questionCategories, questionVersions,
  userEnrolments, users,
} from '../../db/schema';

/** Định dạng archive riêng có version (ADR-007) — không phải .mbz. */
export const BACKUP_FORMAT = 'lms-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** Ngữ cảnh import dùng chung cho các contributor: tra cứu và ghi id mapping của job restore. */
export interface RestoreMapping {
  map(itemtype: string, oldid: string, newid: string): Promise<void>;
  get(itemtype: string, oldid: string): string | undefined;
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
  const remap = (key: string, itemtype: string): void => {
    const value = out[key];
    if (typeof value === 'string') {
      const mapped = mapping.get(itemtype, value);
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
 * BackupModule facade (Moodle core_backup, §2#22).
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
            sectionId, component: cm.component, instanceid: undefined, name: cm.name, visible: cm.visible,
            groupmode: cm.groupmode, completion: cm.completion, completionview: cm.completionview,
            completionusegrade: cm.completionusegrade, completionmanual: cm.completionmanual,
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
        const instances = await db.select().from(enrol).where(eq(enrol.courseid, courseId));
        const ues = instances.length ? await db.select().from(userEnrolments).where(inArray(userEnrolments.enrolid, instances.map((i) => i.id))) : [];
        return {
          instances,
          enrolments: ues.map((ue) => ({ ...ue, userid: anonymize ? null : ue.userid })),
        };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as { instances: (typeof enrol.$inferSelect)[]; enrolments: (typeof userEnrolments.$inferSelect)[] };
        const targetCtx = await this.courses.courseContextId(targetCourseId);
        for (const inst of d.instances) {
          const [row] = await db.insert(enrol).values({
            courseid: targetCourseId, enrol: inst.enrol, status: inst.status, name: inst.name, roleid: inst.roleid,
            enrolperiod: inst.enrolperiod, customint1: inst.customint1, customint2: null, customtext1: inst.customtext1,
            cost: inst.cost, currency: inst.currency, paymentaccountid: inst.paymentaccountid,
          }).returning();
          await mapping.map('enrol', inst.id, row!.id);
        }
        for (const ue of d.enrolments) {
          if (!ue.userid) continue; // anonymize: không khôi phục danh tính
          const newInstance = mapping.get('enrol', ue.enrolid);
          if (!newInstance) continue;
          const [ueRow] = await db.insert(userEnrolments).values({
            enrolid: newInstance, userid: ue.userid, status: ue.status, timestart: ue.timestart, timeend: ue.timeend,
          }).onConflictDoNothing().returning();
          if (ueRow) await mapping.map('user_enrolment', ue.id, ueRow.id);
          const inst = d.instances.find((i) => i.id === ue.enrolid);
          if (inst?.roleid) await this.roles.assignRole(ue.userid, inst.roleid, targetCtx).catch(() => undefined);
        }
      },
    });
    // --- groups ---------------------------------------------------------------
    this.registerContributor({
      name: 'groups',
      export: async (courseId) => {
        if (!courseId) return { groups: [], members: [], groupings: [], links: [] };
        const groups = await db.select().from(courseGroups).where(eq(courseGroups.courseid, courseId));
        const members = groups.length ? await db.select().from(groupsMembers).where(inArray(groupsMembers.groupid, groups.map((g) => g.id))) : [];
        const gps = await db.select().from(groupings).where(eq(groupings.courseid, courseId));
        const links = gps.length ? await db.select().from(groupingsGroups).where(inArray(groupingsGroups.groupingid, gps.map((g) => g.id))) : [];
        return { groups, members, groupings: gps, links };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as {
          groups: (typeof courseGroups.$inferSelect)[]; members: (typeof groupsMembers.$inferSelect)[];
          groupings: (typeof groupings.$inferSelect)[]; links: (typeof groupingsGroups.$inferSelect)[];
        };
        for (const g of d.groups) {
          const [row] = await db.insert(courseGroups).values({ courseid: targetCourseId, name: g.name, idnumber: g.idnumber, description: g.description })
            .onConflictDoNothing().returning();
          const existing = row ?? (await db.select().from(courseGroups).where(and(eq(courseGroups.courseid, targetCourseId), eq(courseGroups.name, g.name))))[0];
          if (existing) await mapping.map('group', g.id, existing.id);
        }
        for (const m of d.members) {
          const ng = mapping.get('group', m.groupid); if (!ng) continue;
          await db.insert(groupsMembers).values({ groupid: ng, userid: m.userid, component: m.component, itemid: m.itemid }).onConflictDoNothing();
        }
        for (const gp of d.groupings) {
          const [row] = await db.insert(groupings).values({ courseid: targetCourseId, name: gp.name, idnumber: gp.idnumber, description: gp.description })
            .onConflictDoNothing().returning();
          const existing = row ?? (await db.select().from(groupings).where(and(eq(groupings.courseid, targetCourseId), eq(groupings.name, gp.name))))[0];
          if (existing) await mapping.map('grouping', gp.id, existing.id);
        }
        for (const link of d.links) {
          const ngp = mapping.get('grouping', link.groupingid); const ng = mapping.get('group', link.groupid);
          if (!ngp || !ng) continue;
          await db.insert(groupingsGroups).values({ groupingid: ngp, groupid: ng }).onConflictDoNothing();
        }
      },
    });
    // --- grades ---------------------------------------------------------------
    this.registerContributor({
      name: 'grades',
      export: async (courseId, anonymize) => {
        if (!courseId) return { categories: [], items: [], grades: [] };
        const categories = await db.select().from(gradeCategories).where(eq(gradeCategories.courseid, courseId));
        const items = await db.select().from(gradeItems).where(eq(gradeItems.courseid, courseId));
        const grades = items.length ? await db.select().from(gradeGrades).where(inArray(gradeGrades.itemid, items.map((i) => i.id))) : [];
        return { categories, items, grades: grades.map((g) => ({ ...g, userid: anonymize ? 0 : g.userid })) };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as {
          categories: (typeof gradeCategories.$inferSelect)[]; items: (typeof gradeItems.$inferSelect)[]; grades: (typeof gradeGrades.$inferSelect)[];
        };
        // Categories: lặp cho tới khi mọi parent đã được map (cây theo parent).
        const pending = [...d.categories].sort((a, b) => a.depth - b.depth);
        for (const cat of pending) {
          const newParent = cat.parent ? mapping.get('grade_category', cat.parent) ?? null : null;
          if (cat.parent && !newParent) continue;
          const [row] = await db.insert(gradeCategories).values({
            courseid: targetCourseId, parent: newParent, fullname: cat.fullname, aggregation: cat.aggregation,
            droplow: cat.droplow, keephigh: cat.keephigh, aggregateonlygraded: cat.aggregateonlygraded, depth: cat.depth, path: cat.path, hidden: cat.hidden,
          }).returning();
          await mapping.map('grade_category', cat.id, row!.id);
        }
        for (const item of d.items) {
          let instance = item.iteminstance;
          if (item.itemtype === 'mod') instance = item.iteminstance ? (mapping.get('cm', item.iteminstance) ?? null) : null;
          else if (item.itemtype === 'category') instance = item.iteminstance ? (mapping.get('grade_category', item.iteminstance) ?? null) : null;
          else if (item.itemtype === 'course') instance = targetCourseId;
          const categoryid = item.categoryid ? mapping.get('grade_category', item.categoryid) ?? null : null;
          const [row] = await db.insert(gradeItems).values({
            courseid: targetCourseId, categoryid, itemname: item.itemname, itemtype: item.itemtype,
            itemmodule: item.itemmodule, iteminstance: instance, gradetype: item.gradetype, grademax: item.grademax,
            grademin: item.grademin, gradepass: item.gradepass, weightoverride: item.weightoverride,
            aggregationcoef: item.aggregationcoef, extracredit: item.extracredit, hidden: item.hidden, sortorder: item.sortorder,
          }).onConflictDoNothing().returning();
          const existing = row ?? (await db.select().from(gradeItems).where(and(
            eq(gradeItems.courseid, targetCourseId), eq(gradeItems.itemtype, item.itemtype), instance === null ? isNull(gradeItems.iteminstance) : eq(gradeItems.iteminstance, instance),
          )))[0];
          if (existing) await mapping.map('grade_item', item.id, existing.id);
        }
        for (const g of d.grades) {
          if (!g.userid) continue;
          const newItem = mapping.get('grade_item', g.itemid); if (!newItem) continue;
          await db.insert(gradeGrades).values({
            itemid: newItem, userid: g.userid, rawgrade: g.rawgrade, rawgrademax: g.rawgrademax, rawgrademin: g.rawgrademin,
            finalgrade: g.finalgrade, hidden: g.hidden, overridden: g.overridden, excluded: g.excluded, frozen: g.frozen, feedback: g.feedback,
          }).onConflictDoNothing();
        }
      },
    });
    // --- completion -------------------------------------------------------------
    this.registerContributor({
      name: 'completion',
      export: async (courseId, anonymize) => {
        if (!courseId) return { cmCompletion: [], courseCompletions: [], criteria: [], settings: null };
        const cms = await db.select().from(courseModules).where(eq(courseModules.course, courseId));
        const cmComp = cms.length ? await db.select().from(courseModulesCompletion).where(inArray(courseModulesCompletion.coursemoduleid, cms.map((c) => c.id))) : [];
        const courseComp = await db.select().from(courseCompletions).where(eq(courseCompletions.course, courseId));
        const criteria = await db.select().from(courseCompletionCriteria).where(eq(courseCompletionCriteria.course, courseId));
        const [settings] = await db.select().from(courseCompletionSettings).where(eq(courseCompletionSettings.course, courseId));
        const scrub = <T extends { userid: string }>(rows: T[]): T[] => anonymize ? rows.map((r) => ({ ...r, userid: 0 })) : rows;
        return { cmCompletion: scrub(cmComp), courseCompletions: scrub(courseComp), criteria, settings: settings ?? null };
      },
      import: async (targetCourseId, data, mapping) => {
        if (!targetCourseId) return;
        const d = data as {
          cmCompletion: (typeof courseModulesCompletion.$inferSelect)[]; courseCompletions: (typeof courseCompletions.$inferSelect)[];
          criteria: (typeof courseCompletionCriteria.$inferSelect)[]; settings: (typeof courseCompletionSettings.$inferSelect) | null;
        };
        if (d.settings) {
          await db.insert(courseCompletionSettings).values({ course: targetCourseId, method: d.settings.method })
            .onConflictDoUpdate({ target: courseCompletionSettings.course, set: { method: d.settings.method } });
        }
        for (const crit of d.criteria) {
          const moduleinstance = crit.moduleinstance ? mapping.get('cm', crit.moduleinstance) ?? null : null;
          await db.insert(courseCompletionCriteria).values({
            course: targetCourseId, criteriatype: crit.criteriatype, moduleinstance, date: crit.date, sortorder: crit.sortorder,
          });
        }
        for (const row of d.cmCompletion) {
          if (!row.userid) continue;
          const newCm = mapping.get('cm', row.coursemoduleid); if (!newCm) continue;
          await db.insert(courseModulesCompletion).values({
            coursemoduleid: newCm, userid: row.userid, completionstate: row.completionstate, viewed: row.viewed, overrideby: row.overrideby,
          }).onConflictDoNothing();
        }
        for (const row of d.courseCompletions) {
          if (!row.userid) continue;
          await db.insert(courseCompletions).values({
            userid: row.userid, course: targetCourseId, status: row.status, timeenrolled: row.timeenrolled,
            timestarted: row.timestarted, timecompleted: row.timecompleted,
          }).onConflictDoNothing();
        }
      },
    });
    // --- files (theo contenthash) -------------------------------------------------
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
        const rows = await db.select().from(filesTable).where(inArray(filesTable.contextid, ctxIds));
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
          const oldCtx = await this.contexts.getContext(f.contextid).catch(() => undefined);
          if (oldCtx?.contextlevel === 70) {
            const newCm = oldCtx.instanceid ? mapping.get('cm', oldCtx.instanceid) : undefined;
            if (newCm) {
              const ctx = await this.contexts.getByLevelInstance(70, newCm);
              if (ctx) newContextId = ctx.id;
            }
          }
          const itemid = f.itemid ? (mapping.get('cm', f.itemid) ?? f.itemid) : null;
          const created = await this.files.upload({
            contextid: newContextId, component: f.component, filearea: f.filearea, itemid: itemid ?? undefined,
            filepath: f.filepath, filename: f.filename, data: Buffer.from(f.dataBase64, 'base64'),
            mimetype: f.mimetype ?? undefined, userid: f.userid ?? undefined,
          });
          await mapping.map('file', f.id, created.id);
        }
      },
    });
    // --- question bank ---------------------------------------------------------
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
        if (!ctxId) return { categories: [], questions: [], entries: [], versions: [] };
        const categories = await db.select().from(questionCategories).where(eq(questionCategories.contextid, ctxId));
        const catIds = categories.map((c) => c.id);
        const questions = catIds.length ? await db.select().from(question).where(inArray(question.category, catIds)) : [];
        const entries = catIds.length ? await db.select().from(questionBankEntries).where(inArray(questionBankEntries.questioncategoryid, catIds)) : [];
        const entryIds = entries.map((e) => e.id);
        const versions = entryIds.length ? await db.select().from(questionVersions).where(inArray(questionVersions.questionbankentryid, entryIds)) : [];
        return { categories, questions, entries, versions };
      },
      import: async (targetCourseId, data, mapping) => {
        const d = data as {
          categories: (typeof questionCategories.$inferSelect)[]; questions: (typeof question.$inferSelect)[];
          entries: (typeof questionBankEntries.$inferSelect)[]; versions: (typeof questionVersions.$inferSelect)[];
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
              name: cat.name, contextid: targetCtxId, info: cat.info,
              parent: cat.parent ? mapping.get('question_category', cat.parent)! : null,
              sortorder: cat.sortorder, stamp: cat.stamp,
            }).returning();
            await mapping.map('question_category', cat.id, row!.id);
            pending.splice(i, 1);
            progressed = true;
          }
        }
        for (const cat of pending) {
          const [row] = await db.insert(questionCategories).values({
            name: cat.name, contextid: targetCtxId, info: cat.info, parent: null, sortorder: cat.sortorder, stamp: cat.stamp,
          }).returning();
          await mapping.map('question_category', cat.id, row!.id);
        }
        for (const q of d.questions ?? []) {
          const newCategory = mapping.get('question_category', q.category);
          if (!newCategory) continue;
          const [row] = await db.insert(question).values({
            category: newCategory, qtype: q.qtype, name: q.name, createdby: q.createdby, modifiedby: q.modifiedby,
          }).returning();
          await mapping.map('question', q.id, row!.id);
        }
        for (const e of d.entries ?? []) {
          const newCategory = mapping.get('question_category', e.questioncategoryid);
          const newQuestion = mapping.get('question', e.questionid);
          if (!newCategory || !newQuestion) continue;
          const [row] = await db.insert(questionBankEntries).values({
            questioncategoryid: newCategory, questionid: newQuestion, latestversion: e.latestversion, status: e.status,
          }).onConflictDoNothing().returning();
          const created = row ?? (await db.select().from(questionBankEntries).where(eq(questionBankEntries.questionid, newQuestion)))[0];
          if (created) await mapping.map('question_bank_entry', e.id, created.id);
        }
        for (const v of [...(d.versions ?? [])].sort((a, b) => a.version - b.version)) {
          const newEntry = mapping.get('question_bank_entry', v.questionbankentryid);
          const newQuestion = mapping.get('question', v.questionid);
          if (!newEntry || !newQuestion) continue;
          const [row] = await db.insert(questionVersions).values({
            questionbankentryid: newEntry, questionid: newQuestion, version: v.version, status: v.status,
            questiontext: v.questiontext, defaultmark: v.defaultmark, answerdata: v.answerdata,
          }).onConflictDoNothing().returning();
          if (row) await mapping.map('question_version', v.id, row.id);
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
          ? await db.select().from(badge).where(eq(badge.courseid, courseId))
          : await db.select().from(badge).where(isNull(badge.courseid));
        const criteria = badges.length ? await db.select().from(badgeCriteria).where(inArray(badgeCriteria.badgeid, badges.map((b) => b.id))) : [];
        return { badges, criteria };
      },
      import: async (targetCourseId, data, mapping, actorId) => {
        const d = data as { badges: (typeof badge.$inferSelect)[]; criteria: (typeof badgeCriteria.$inferSelect)[] };
        // Pha 1: tạo badge trước để tiêu chí `badge` tham chiếu chéo trong
        // cùng archive tra được mapping ở pha 2.
        for (const b of d.badges ?? []) {
          const [row] = await db.insert(badge).values({
            name: b.name, description: b.description, type: targetCourseId ? 2 : b.type,
            courseid: targetCourseId ?? null,
            issuername: b.issuername, issuerurl: b.issuerurl, issuercontact: b.issuercontact,
            expiredate: b.expiredate ? new Date(b.expiredate as unknown as string) : null,
            expireperiod: b.expireperiod, status: b.status, version: b.version, language: b.language,
            usercreated: actorId, usermodified: actorId,
          }).returning();
          await mapping.map('badge', b.id, row!.id);
        }
        for (const c of d.criteria ?? []) {
          const newBadge = mapping.get('badge', c.badgeid);
          if (!newBadge) continue;
          const [row] = await db.insert(badgeCriteria).values({
            badgeid: newBadge, criteriatype: c.criteriatype, method: c.method,
            params: remapBadgeCriteriaParams(c.params, mapping), description: c.description,
          }).returning();
          if (row) await mapping.map('badge_criteria', c.id, row.id);
        }
      },
    });
    // --- calendar ------------------------------------------------------------------
    // Sự kiện mức khoá (course + group; group được map qua contributor groups
    // chạy trước) và subscription của khoá; ở phạm vi site là sự kiện
    // eventtype='site' + subscription mức site. Chuỗi lặp: repeatid /
    // exceptionof được nối lại ở pha 2 sau khi mọi sự kiện đã có id mới.
    this.registerContributor({
      name: 'calendar',
      supportsSite: true,
      export: async (courseId) => {
        const events = courseId
          ? await db.select().from(calendarEvents).where(eq(calendarEvents.courseid, courseId))
          : await db.select().from(calendarEvents).where(eq(calendarEvents.eventtype, 'site'));
        const subscriptions = courseId
          ? await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.courseid, courseId))
          : await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.eventtype, 'site'));
        return { events, subscriptions };
      },
      import: async (targetCourseId, data, mapping) => {
        const d = data as { events: (typeof calendarEvents.$inferSelect)[]; subscriptions: (typeof calendarSubscriptions.$inferSelect)[] };
        for (const s of d.subscriptions ?? []) {
          const [row] = await db.insert(calendarSubscriptions).values({
            name: s.name, url: s.url, icsdata: s.icsdata, eventtype: s.eventtype,
            courseid: s.courseid ? targetCourseId ?? null : null,
            categoryid: s.categoryid, userid: s.userid, pollinterval: s.pollinterval, lastupdated: s.lastupdated,
          }).returning();
          await mapping.map('calendar_subscription', s.id, row!.id);
        }
        const targetCtxId = targetCourseId ? await this.courses.courseContextId(targetCourseId).catch(() => null) : null;
        const systemCtxId = (await this.contexts.ensureSystemContext()).id;
        for (const e of d.events ?? []) {
          const newCourseId = e.courseid ? targetCourseId ?? null : null;
          const newContextId = newCourseId ? targetCtxId : e.eventtype === 'site' ? systemCtxId : e.contextid;
          const [row] = await db.insert(calendarEvents).values({
            name: e.name, description: e.description, eventtype: e.eventtype,
            courseid: newCourseId,
            groupid: e.groupid ? mapping.get('group', e.groupid) ?? null : null,
            categoryid: e.categoryid, userid: e.userid, contextid: newContextId,
            subscriptionid: e.subscriptionid ? mapping.get('calendar_subscription', e.subscriptionid) ?? null : null,
            uuid: e.uuid, repeatid: null, rrule: e.rrule,
            isexception: e.isexception, exceptionof: null,
            timestart: new Date(e.timestart as unknown as string), timeduration: e.timeduration,
            visible: e.visible, location: e.location,
          }).returning();
          await mapping.map('calendar_event', e.id, row!.id);
        }
        for (const e of d.events ?? []) {
          const newId = mapping.get('calendar_event', e.id);
          if (!newId) continue;
          const patch: { repeatid?: string | null; exceptionof?: string | null } = {};
          if (e.repeatid) patch.repeatid = mapping.get('calendar_event', e.repeatid) ?? null;
          if (e.exceptionof) patch.exceptionof = mapping.get('calendar_event', e.exceptionof) ?? null;
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
  async listJobs(): Promise<JobRow[]> { return this.repo.listJobs(); }
  async listSteps(jobId: string) { return this.repo.listSteps(jobId); }
  async listMappings(jobId: string) { return this.repo.listMappings(jobId); }

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
      await this.evaluator.requireCapability(actorId, 'lms/backup:backupcourse', await this.courses.courseContextId(courseId!));
    } else {
      await this.evaluator.requireCapability(actorId, 'lms/backup:backupcourse', (await this.contexts.ensureSystemContext()).id);
    }
    const job = await this.repo.insertJob({ type: 'backup', scope, courseid: courseId, userid: actorId, anonymize, status: 'running' });
    try {
      const contributorsData: Record<string, unknown> = {};
      for (const c of this.contributors) {
        if (scope === 'site' && !c.supportsSite) {
          const step = await this.repo.insertStep({ jobid: job.id, name: c.name, status: 'running' });
          await this.repo.updateStep(step.id, { status: 'completed', detail: { skipped: 'course-scope-only' } });
          continue;
        }
        const step = await this.repo.insertStep({ jobid: job.id, name: c.name, status: 'running' });
        const data = await c.export(courseId, anonymize);
        contributorsData[c.name] = data;
        await this.repo.updateStep(step.id, { status: 'completed', detail: { exported: true } });
      }
      const archive = {
        format: BACKUP_FORMAT, version: BACKUP_FORMAT_VERSION, scope, courseId,
        course: courseRow
          ? { fullname: courseRow.fullname, shortname: courseRow.shortname, category: courseRow.category, summary: courseRow.summary }
          : null,
        anonymize, contributors: contributorsData,
      };
      await this.repo.updateJob(job.id, { status: 'completed', archive, timefinished: new Date() });
    } catch (e) {
      await this.repo.updateJob(job.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), timefinished: new Date() });
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
      course: { fullname: string; shortname: string; category: string; summary: string } | null;
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
      await this.evaluator.requireCapability(actorId, 'lms/backup:restorecourse', (await this.contexts.ensureSystemContext()).id);
      const job = await this.repo.insertJob({
        type: 'restore', scope: 'site', courseid: null, targetcourseid: null, mode, userid: actorId, status: 'running',
      });
      const mappingState = new Map<string, string>();
      const mapping: RestoreMapping = {
        map: async (itemtype, oldid, newid) => {
          mappingState.set(`${itemtype}:${oldid}`, newid);
          await this.repo.insertMapping({ jobid: job.id, itemtype, oldid, newid });
        },
        get: (itemtype, oldid) => mappingState.get(`${itemtype}:${oldid}`),
      };
      try {
        for (const c of this.contributors) {
          const step = await this.repo.insertStep({ jobid: job.id, name: c.name, status: 'running' });
          const data = archive.contributors[c.name];
          if (data !== undefined) await c.import(null, data as never, mapping, actorId);
          await this.repo.updateStep(step.id, { status: 'completed' });
        }
        await this.repo.updateJob(job.id, { status: 'completed', timefinished: new Date() });
      } catch (e) {
        await this.repo.updateJob(job.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), timefinished: new Date() });
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
      await this.evaluator.requireCapability(actorId, 'lms/backup:restorecourse', await this.courses.categoryContextId(archive.course.category));
      const created = await this.courses.createCourse(actorId, {
        fullname: archive.course.fullname, shortname: `${archive.course.shortname}-r${Date.now().toString(36)}`,
        category: archive.course.category, summary: archive.course.summary,
      });
      targetId = created.id;
    } else {
      targetId = targetCourseId!;
      await this.evaluator.requireCapability(actorId, 'lms/backup:restorecourse', await this.courses.courseContextId(targetId));
    }

    const job = await this.repo.insertJob({
      type: 'restore', scope: 'course', courseid: backup.courseid, targetcourseid: targetId, mode, userid: actorId, status: 'running',
    });
    const mappingState = new Map<string, string>();
    const mapping: RestoreMapping = {
      map: async (itemtype, oldid, newid) => {
        mappingState.set(`${itemtype}:${oldid}`, newid);
        await this.repo.insertMapping({ jobid: job.id, itemtype, oldid, newid });
      },
      get: (itemtype, oldid) => mappingState.get(`${itemtype}:${oldid}`),
    };
    if (backup.courseid) await mapping.map('course', backup.courseid, targetId);
    try {
      if (mode === 'replace') await this.clearCourseContent(targetId);
      for (const c of this.contributors) {
        const step = await this.repo.insertStep({ jobid: job.id, name: c.name, status: 'running' });
        const data = archive.contributors[c.name];
        if (data !== undefined) await c.import(targetId, data as never, mapping, actorId);
        await this.repo.updateStep(step.id, { status: 'completed' });
      }
      await this.repo.updateJob(job.id, { status: 'completed', timefinished: new Date() });
    } catch (e) {
      await this.repo.updateJob(job.id, { status: 'failed', error: e instanceof Error ? e.message : String(e), timefinished: new Date() });
    }
    return this.getJob(job.id);
  }

  /** Replace mode: xoá nội dung hiện có của course đích trước khi khôi phục. */
  private async clearCourseContent(courseId: string): Promise<void> {
    const db = this.repo.dbHandle;
    await db.delete(courseSections).where(eq(courseSections.course, courseId));
    await db.delete(enrol).where(eq(enrol.courseid, courseId));
    await db.delete(gradeItems).where(eq(gradeItems.courseid, courseId));
    await db.delete(gradeCategories).where(eq(gradeCategories.courseid, courseId));
    await db.delete(courseCompletions).where(eq(courseCompletions.course, courseId));
    await db.delete(courseGroups).where(eq(courseGroups.courseid, courseId));
    await db.delete(groupings).where(eq(groupings.courseid, courseId));
    await db.delete(badge).where(eq(badge.courseid, courseId));
    await db.delete(calendarEvents).where(eq(calendarEvents.courseid, courseId));
    await db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.courseid, courseId));
    const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
    if (courseCtx) await db.delete(questionCategories).where(eq(questionCategories.contextid, courseCtx.id));
  }

  /**
   * Checklist tương đương giữa course nguồn và course đích của một restore job.
   * Với restore mức SITE không có khoá đích: phía đích sống CÙNG không gian
   * với phía nguồn (cùng context hệ thống) nên không đếm trực tiếp được —
   * `target` là số bản ghi MỚI mà job đã tạo theo từng itemtype trong
   * backup_id_mappings, `source` là tổng hiện có trừ đi phần mới tạo đó.
   */
  async restoreChecklist(restoreJobId: string): Promise<Record<string, { source: number; target: number }>> {
    const job = await this.getJob(restoreJobId);
    const db = this.repo.dbHandle;
    if (job.scope === 'site' || !job.targetcourseid) {
      const mappings = await this.repo.listMappings(job.id);
      const mapped = (itemtype: string) => mappings.filter((m) => m.itemtype === itemtype).length;
      const systemCtx = await this.contexts.ensureSystemContext();
      const siteCategories = await db.select().from(questionCategories).where(eq(questionCategories.contextid, systemCtx.id));
      const siteQuestions = siteCategories.length
        ? await db.select().from(question).where(inArray(question.category, siteCategories.map((c) => c.id)))
        : [];
      const siteBadges = await db.select().from(badge).where(isNull(badge.courseid));
      const siteEvents = await db.select().from(calendarEvents).where(eq(calendarEvents.eventtype, 'site'));
      const siteSubs = await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.eventtype, 'site'));
      const entry = (total: number, itemtype: string) => ({ source: Math.max(0, total - mapped(itemtype)), target: mapped(itemtype) });
      return {
        questionCategories: entry(siteCategories.length, 'question_category'),
        questions: entry(siteQuestions.length, 'question'),
        badges: entry(siteBadges.length, 'badge'),
        calendarEvents: entry(siteEvents.length, 'calendar_event'),
        calendarSubscriptions: entry(siteSubs.length, 'calendar_subscription'),
      };
    }
    const targetId = job.targetcourseid;
    const countFor = async (courseId: string) => {
      const sections = await db.select().from(courseSections).where(eq(courseSections.course, courseId));
      const cms = await db.select().from(courseModules).where(eq(courseModules.course, courseId));
      const instances = await db.select().from(enrol).where(eq(enrol.courseid, courseId));
      const ues = instances.length ? await db.select().from(userEnrolments).where(inArray(userEnrolments.enrolid, instances.map((i) => i.id))) : [];
      const items = await db.select().from(gradeItems).where(eq(gradeItems.courseid, courseId));
      const grades = items.length ? await db.select().from(gradeGrades).where(inArray(gradeGrades.itemid, items.map((i) => i.id))) : [];
      const cmComp = cms.length ? await db.select().from(courseModulesCompletion).where(inArray(courseModulesCompletion.coursemoduleid, cms.map((c) => c.id))) : [];
      const courseCtx = await this.contexts.getByLevelInstance(50, courseId);
      const qCats = courseCtx ? await db.select().from(questionCategories).where(eq(questionCategories.contextid, courseCtx.id)) : [];
      const qRows = qCats.length ? await db.select().from(question).where(inArray(question.category, qCats.map((c) => c.id))) : [];
      const qEntries = qCats.length ? await db.select().from(questionBankEntries).where(inArray(questionBankEntries.questioncategoryid, qCats.map((c) => c.id))) : [];
      const qVersions = qEntries.length ? await db.select().from(questionVersions).where(inArray(questionVersions.questionbankentryid, qEntries.map((e) => e.id))) : [];
      const courseBadges = await db.select().from(badge).where(eq(badge.courseid, courseId));
      const badgeCriteriaCount = courseBadges.length
        ? (await db.select().from(badgeCriteria).where(inArray(badgeCriteria.badgeid, courseBadges.map((b) => b.id)))).length
        : 0;
      const calEvents = await db.select().from(calendarEvents).where(eq(calendarEvents.courseid, courseId));
      const calSubs = await db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.courseid, courseId));
      // completion nguồn tính theo cms nguồn — hàm này chỉ gọi với course tương ứng nên cms ở đây là của course đó.
      return {
        sections: sections.length, cms: cms.length, enrolInstances: instances.length, enrolments: ues.length,
        gradeItems: items.length, grades: grades.length, cmCompletion: cmComp.length,
        questionCategories: qCats.length, questions: qRows.length, questionVersions: qVersions.length,
        badges: courseBadges.length, badgeCriteria: badgeCriteriaCount,
        calendarEvents: calEvents.length, calendarSubscriptions: calSubs.length,
      };
    };
    const source = await countFor(job.courseid!);
    const target = await countFor(targetId);
    const out: Record<string, { source: number; target: number }> = {};
    for (const k of Object.keys(source) as (keyof typeof source)[]) out[k] = { source: source[k], target: target[k] };
    void users;
    return out;
  }
}
