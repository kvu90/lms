import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { I18nService } from '@nestjs/i18n';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import {
  analyticsModels, analyticsPredictions, backupIdMappings, backupJobSteps, backupJobs,
  badge, badgeCriteria, calendarEvents, calendarSubscriptions, competencyUserComp,
  contentBankContent, context as contextTable, course,
  courseCompletions, courseModules, courseModulesCompletion, courseSections, enrol,
  gradeGrades, gradeItems, insights, notifications, outboxEvents, payments, privacyExportFiles,
  privacyRequests, question, questionBankEntries, questionCategories, questionVersions,
  reportBuilderReport, reportBuilderSchedule, role, roleAssignments,
  searchDocuments, userEnrolments, userPreferences, users, badgeIssued, files,
} from '@lms/db';
import { NotificationDeliveryService } from '../notification-delivery.service';
import { tenantAls } from '../db/tenant-als';
import { resolveDefaultTenantId } from '../db/default-tenant';
import { SpaceDatabaseService } from '../db/routing/space-database.service';

type Database = NodePgDatabase<typeof relations>;

/**
 * Các processor platform services của worker. Mỗi processor là bản song sinh (twin) của
 * logic API tương ứng, chạy trên cùng bảng: backup, restore, search reindex,
 * analytics run, report schedule, privacy export/delete, payment
 * reconciliation/webhook. Tất cả đều idempotent theo khoá nghiệp vụ của job.
 */

/** Backup: dựng archive (format riêng v1) cho job backup đang pending và ghi các bước contributor. */
@Processor('backup')
/**
 * Xử lý job sao lưu khoá học nền.
 */
export class BackupProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<{ jobId: string }>): Promise<{ status: string; sections?: number; cms?: number }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<{ jobId: string }>): Promise<{ status: string; sections?: number; cms?: number }> {
    const [row] = await this.db.select().from(backupJobs).where(eq(backupJobs.id, job.data.jobId));
    if (!row) return { status: 'missing' };
    if (row.status === 'completed') return { status: 'duplicate' };
    const scope = row.scope ?? 'course';
    // Question bank bám context: khoá → context của khoá; site → context hệ thống.
    const contexts = await this.db.select().from(contextTable);
    const bankCtx = scope === 'site'
      ? contexts.find((c) => c.contextLevel === 10)
      : contexts.find((c) => c.contextLevel === 50 && c.instanceId === row.courseId);
    const qCategories = bankCtx ? await this.db.select().from(questionCategories).where(eq(questionCategories.contextId, bankCtx.id)) : [];
    const qCatIds = qCategories.map((c) => c.id);
    const qRows = qCatIds.length ? await this.db.select().from(question).where(inArray(question.category, qCatIds)) : [];
    const qEntries = qCatIds.length ? await this.db.select().from(questionBankEntries).where(inArray(questionBankEntries.questionCategoryId, qCatIds)) : [];
    const qEntryIds = qEntries.map((e) => e.id);
    const qVersions = qEntryIds.length ? await this.db.select().from(questionVersions).where(inArray(questionVersions.questionBankEntryId, qEntryIds)) : [];
    const badges = scope === 'site'
      ? await this.db.select().from(badge).where(isNull(badge.courseId))
      : await this.db.select().from(badge).where(eq(badge.courseId, row.courseId!));
    const criteria = badges.length ? await this.db.select().from(badgeCriteria).where(inArray(badgeCriteria.badgeId, badges.map((b) => b.id))) : [];
    const calEvents = scope === 'site'
      ? await this.db.select().from(calendarEvents).where(eq(calendarEvents.eventType, 'site'))
      : await this.db.select().from(calendarEvents).where(eq(calendarEvents.courseId, row.courseId!));
    const calSubs = scope === 'site'
      ? await this.db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.eventType, 'site'))
      : await this.db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.courseId, row.courseId!));
    const contributorNames = scope === 'site'
      ? ['questions', 'badges', 'calendar']
      : ['courses', 'enrol', 'groups', 'grades', 'completion', 'files', 'questions', 'badges', 'calendar'];
    for (const name of contributorNames) {
      await this.db.insert(backupJobSteps).values({ jobId: row.id, name, status: 'completed', detail: { worker: true } });
    }
    // Archive dùng CHUNG định dạng lms-backup v1 với API: bản tóm
    // tắt của worker mang đủ các section contributor mới (questions/badges/
    // calendar) bên cạnh các section cũ; attempts/usages của question bank
    // và assertions của badge KHÔNG bao giờ vào archive (dữ liệu vận hành /
    // bằng chứng lịch sử của khoá gốc).
    const extended = {
      questions: { categories: qCategories.length, questions: qRows.length, entries: qEntries.length, versions: qVersions.length },
      badges: { badges: badges.length, criteria: criteria.length },
      calendar: { events: calEvents.length, subscriptions: calSubs.length },
    };
    if (scope === 'site') {
      const archive = { format: 'lms-backup', version: 1, scope, courseId: null, anonymize: row.anonymize, contributors: extended };
      await this.db.update(backupJobs).set({ status: 'completed', archive, timeFinished: new Date() }).where(eq(backupJobs.id, row.id));
      return { status: 'completed', sections: 0, cms: 0 };
    }
    const sections = await this.db.select().from(courseSections).where(eq(courseSections.course, row.courseId!));
    const cms = await this.db.select().from(courseModules).where(eq(courseModules.course, row.courseId!));
    const instances = await this.db.select().from(enrol).where(eq(enrol.courseId, row.courseId!));
    const archive = {
      format: 'lms-backup', version: 1, scope, courseId: row.courseId, anonymize: row.anonymize,
      contributors: { courses: { sections: sections.length, cms: cms.length }, enrol: { instances: instances.length }, ...extended },
    };
    await this.db.update(backupJobs).set({ status: 'completed', archive, timeFinished: new Date() }).where(eq(backupJobs.id, row.id));
    return { status: 'completed', sections: sections.length, cms: cms.length };
  }
}

/** Restore: với job restore pending mang archive ở trường archive, sao chép section/cm sang course đích và ghi id mapping. */
@Processor('restore')
/**
 * Xử lý job khôi phục khoá học nền.
 */
export class RestoreProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(job: Job<{ jobId: string }>): Promise<{ status: string; mapped?: number }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<{ jobId: string }>): Promise<{ status: string; mapped?: number }> {
    const [row] = await this.db.select().from(backupJobs).where(eq(backupJobs.id, job.data.jobId));
    if (!row) return { status: 'missing' };
    if (row.status === 'completed') return { status: 'duplicate' };
    const targetId = row.targetCourseId;
    if (!targetId || !row.courseId) {
      // Restore mức site không có khoá nguồn/đích: bản twin này chỉ xử lý
      // restore mức khoá; restore site chạy đồng bộ ở API (không qua queue).
      await this.db.update(backupJobs).set({ status: 'failed', error: 'restore job has no target course' }).where(eq(backupJobs.id, row.id));
      return { status: 'failed' };
    }
    let mapped = 0;
    const sections = await this.db.select().from(courseSections).where(eq(courseSections.course, row.courseId));
    const existing = await this.db.select().from(courseSections).where(eq(courseSections.course, targetId));
    const sectionMap = new Map<string, string>();
    for (const s of sections.sort((a, b) => a.section - b.section)) {
      const already = existing.find((e) => e.section === s.section);
      if (already) { sectionMap.set(s.id, already.id); continue; }
      const [created] = await this.db.insert(courseSections).values({ course: targetId, section: s.section, name: s.name, summary: s.summary, visible: s.visible }).returning();
      sectionMap.set(s.id, created!.id);
      await this.db.insert(backupIdMappings).values({ jobId: row.id, itemType: 'section', oldId: s.id, newId: created!.id }).onConflictDoNothing();
      mapped++;
    }
    await this.db.insert(backupIdMappings).values({ jobId: row.id, itemType: 'course', oldId: row.courseId, newId: targetId }).onConflictDoNothing();
    await this.db.update(backupJobs).set({ status: 'completed', timeFinished: new Date() }).where(eq(backupJobs.id, row.id));
    void courseModules;
    return { status: 'completed', mapped };
  }
}

/** Search reindex: dựng lại tài liệu courses/users/contentbank từ dữ liệu gốc; user suspended/deleted bị loại. */
@Processor('search-reindex')
/**
 * Xử lý job dựng lại chỉ mục tìm kiếm.
 */
export class SearchReindexProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(_job: Job<Record<string, never>>): Promise<{ indexed: number }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(_job));
  }

  private async processInContext(_job: Job<Record<string, never>>): Promise<{ indexed: number }> {
    void _job;
    let indexed = 0;
    const courses = await this.db.select().from(course);
    const contexts = await this.db.select().from(contextTable);
    const ctxFor = (level: number, instance: string) => contexts.find((c) => c.contextLevel === level && c.instanceId === instance);
    for (const c of courses) {
      if (!c.visible) continue;
      const ctx = ctxFor(50, c.id); if (!ctx) continue;
      await this.db.insert(searchDocuments).values({ area: 'courses', itemId: c.id, contextId: ctx.id, title: c.fullName, content: `${c.shortName} ${c.summary}` })
        .onConflictDoUpdate({ target: [searchDocuments.area, searchDocuments.itemId], set: { title: c.fullName, content: `${c.shortName} ${c.summary}`, contextId: ctx.id } });
      indexed++;
    }
    const allUsers = await this.db.select().from(users);
    for (const u of allUsers) {
      if (u.suspended || u.deleted) { await this.db.delete(searchDocuments).where(and(eq(searchDocuments.area, 'users'), eq(searchDocuments.itemId, u.id))); continue; }
      const ctx = ctxFor(30, u.id) ?? contexts.find((c) => c.contextLevel === 10);
      if (!ctx) continue;
      await this.db.insert(searchDocuments).values({ area: 'users', itemId: u.id, contextId: ctx.id, title: `${u.firstName} ${u.lastName}`.trim() || u.username, content: `${u.username} ${u.email}`, ownerId: u.id })
        .onConflictDoUpdate({ target: [searchDocuments.area, searchDocuments.itemId], set: { title: u.username, content: `${u.username} ${u.email}`, contextId: ctx.id, ownerId: u.id } });
      indexed++;
    }
    const contents = await this.db.select().from(contentBankContent);
    for (const c of contents) {
      if (c.visibility !== 'public') continue;
      await this.db.insert(searchDocuments).values({ area: 'contentbank', itemId: c.id, contextId: c.contextId, title: c.name, content: c.name, ownerId: c.creatorId })
        .onConflictDoUpdate({ target: [searchDocuments.area, searchDocuments.itemId], set: { title: c.name, content: c.name, contextId: c.contextId } });
      indexed++;
    }
    return { indexed };
  }
}

/** Analytics run: model students_at_risk — chỉ ghi prediction/insight, không chạm grades/enrol. */
@Processor('analytics-run')
/**
 * Xử lý job chạy mô hình phân tích (insights).
 */
export class AnalyticsRunProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(job: Job<{ courseId: string }>): Promise<{ predictions: number; insights: number }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<{ courseId: string }>): Promise<{ predictions: number; insights: number }> {
    const courseId = job.data.courseId;
    let [model] = await this.db.select().from(analyticsModels).where(eq(analyticsModels.name, 'students_at_risk'));
    if (!model) {
      [model] = await this.db.insert(analyticsModels).values({ name: 'students_at_risk', target: 'at_risk', indicators: ['no_recent_access', 'low_grade'], enabled: true }).returning();
    }
    const contexts = await this.db.select().from(contextTable);
    const courseCtx = contexts.find((c) => c.contextLevel === 50 && c.instanceId === courseId);
    if (!courseCtx || !model) return { predictions: 0, insights: 0 };
    const instances = await this.db.select().from(enrol).where(eq(enrol.courseId, courseId));
    const ues = instances.length ? await this.db.select().from(userEnrolments).where(inArray(userEnrolments.enrolId, instances.map((i) => i.id))) : [];
    const items = await this.db.select().from(gradeItems).where(eq(gradeItems.courseId, courseId));
    const grades = items.length ? await this.db.select().from(gradeGrades).where(inArray(gradeGrades.itemId, items.map((i) => i.id))) : [];
    // Người nhận: user có assignment với role archetype staff tại course context hoặc tổ tiên.
    const assignments = await this.db.select().from(roleAssignments);
    const roles = await this.db.select().from(role);
    const staffRoleIds = new Set(roles.filter((r) => ['manager', 'editingteacher', 'teacher'].includes(r.archetype ?? '')).map((r) => r.id));
    const recipients = [...new Set(assignments.filter((a) => staffRoleIds.has(a.roleId)).map((a) => a.userId))];
    let predictions = 0; let insightCount = 0;
    for (const ue of ues.filter((e) => e.status === 0)) {
      const [u] = await this.db.select().from(users).where(eq(users.id, ue.userId));
      if (!u || u.suspended || u.deleted) continue;
      const noAccess = !u.lastLogin || Date.now() - u.lastLogin.getTime() > 14 * 24 * 3600 * 1000 ? 1 : 0;
      const mine = grades.filter((g) => g.userId === ue.userId && g.finalGrade !== null);
      const pct = mine.length ? mine.reduce((s, g) => { const it = items.find((i) => i.id === g.itemId); return s + (it && it.gradeMax > 0 ? (g.finalGrade ?? 0) / it.gradeMax : 0); }, 0) / mine.length : null;
      const lowGrade = pct === null ? 0.5 : pct < 0.5 ? 1 - pct : 0;
      const score = (noAccess + lowGrade) / 2;
      if (score < 0.6) continue;
      const [prediction] = await this.db.insert(analyticsPredictions).values({
        modelId: model.id, userId: ue.userId, contextId: courseCtx.id, courseId: courseId, score,
        data: { no_recent_access: noAccess, low_grade: lowGrade },
      }).returning();
      predictions++;
      for (const recipientId of recipients) {
        if (recipientId === ue.userId) continue;
        await this.db.insert(insights).values({
          modelId: model.id, predictionId: prediction!.id, userId: ue.userId, recipientId,
          contextId: courseCtx.id, courseId: courseId, heading: 'Student at risk', data: { score },
        });
        insightCount++;
      }
    }
    return { predictions, insights: insightCount };
  }
}

/** Report schedule: chạy báo cáo enrolments dưới danh tính người tạo (đếm dòng enrolment) + notification + lưu lastResult. */
@Processor('report-schedule')
/**
 * Xử lý job báo cáo theo lịch: sinh báo cáo và gửi notification (nội dung từ catalog i18n).
 * Thông báo đi qua hàm luật phân phối dùng chung ({@link NotificationDeliveryService},
 * NB-6): trước lát này processor insert thẳng vào bảng notifications —
 * không kiểm đình chỉ, không kiểm tuỳ chọn, không ghi dispatch log; nay áp
 * đúng luật như `notify()` phía API cho kênh trong-app.
 */
export class ReportScheduleProcessor extends WorkerHost {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly i18n: I18nService,
    private readonly delivery: NotificationDeliveryService,
    private readonly spaceDb: SpaceDatabaseService,
  ) { super(); }
  async process(job: Job<{ scheduleId: string }>): Promise<{ rows: number; status: string }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<{ scheduleId: string }>): Promise<{ rows: number; status: string }> {
    const [schedule] = await this.db.select().from(reportBuilderSchedule).where(eq(reportBuilderSchedule.id, job.data.scheduleId));
    if (!schedule || !schedule.enabled) return { rows: 0, status: 'missing-or-disabled' };
    const [report] = await this.db.select().from(reportBuilderReport).where(eq(reportBuilderReport.id, schedule.reportId));
    let rows = 0;
    if (report?.dataSource === 'enrolments') rows = (await this.db.select().from(userEnrolments)).length;
    else if (report?.dataSource === 'grades') rows = (await this.db.select().from(gradeGrades)).length;
    else if (report?.dataSource === 'completion') rows = (await this.db.select().from(courseCompletions)).length;
    await this.db.update(reportBuilderSchedule).set({ lastRun: new Date(), lastResult: { rows, ranAs: schedule.createdBy, worker: true } })
      .where(eq(reportBuilderSchedule.id, schedule.id));
    /**
     * Text thông báo tra trong catalog i18n theo ngôn ngữ của người nhận:
     * worker chạy ngoài request context nên truyền `locale` tường minh vào
     * `I18nService.t()` (mẫu dịch ngoài request của docs @nestjs/i18n). Hệ
     * thống chưa lưu locale riêng cho từng user nên dùng locale mặc định 'vi';
     * khi có user preference về ngôn ngữ, chỉ cần thay hằng số này.
     */
    const recipientLocale = 'vi';
    const subject = this.i18n.t('platform.reportReadySubject', { locale: recipientLocale });
    // TENANT-1 (#196): báo cáo chưa mang tenant riêng — notification
    // gắn tenant mặc định của người tạo lịch theo membership (người
    // sẽ đọc thông báo), truyền xuống hàm luật dùng chung để dòng
    // thông báo + dispatch log mang đúng tenant.
    const tenantId = await resolveDefaultTenantId(this.spaceDb.routedKysely, schedule.createdBy);
    await this.delivery.deliverInApp(schedule.createdBy, 'report_scheduled', {
      subject,
      body: this.i18n.t('platform.reportReadyBody', { locale: recipientLocale, args: { name: report?.name ?? String(schedule.reportId) } }),
      smallMessage: subject,
      contextUrl: `/reports/${schedule.reportId}`,
      tenantId,
    });
    return { rows, status: 'completed' };
  }
}

/** Privacy: export ghi manifest theo subsystem; delete lan qua các bảng đã khai trong schema worker và ẩn danh user. */
@Processor('privacy')
/**
 * Xử lý job quyền riêng tư (xuất/xoá dữ liệu cá nhân).
 */
export class PrivacyProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(job: Job<{ requestId: string }>): Promise<{ status: string; subsystems: string[] }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<{ requestId: string }>): Promise<{ status: string; subsystems: string[] }> {
    const [req] = await this.db.select().from(privacyRequests).where(eq(privacyRequests.id, job.data.requestId));
    if (!req) return { status: 'missing', subsystems: [] };
    if (req.status === 'completed') return { status: 'duplicate', subsystems: [] };
    if (req.status !== 'approved') return { status: 'not-approved', subsystems: [] };
    const userId = req.userId;
    const subsystems = ['users', 'enrol', 'grades', 'completion', 'files', 'messaging', 'calendar', 'badges', 'competencies', 'social', 'search', 'contentbank', 'payments'];
    if (req.type === 'export') {
      const manifest = { requestId: req.id, userId: userId, subsystems, format: 'lms-privacy-export', version: 1, worker: true };
      await this.db.insert(privacyExportFiles).values({ requestId: req.id, fileId: null, subsystem: 'all', manifest });
      await this.db.update(privacyRequests).set({ status: 'completed', result: { manifest, subsystems }, updatedAt: new Date() }).where(eq(privacyRequests.id, req.id));
      return { status: 'completed', subsystems };
    }
    const deleted: Record<string, number> = {};
    deleted.enrol = (await this.db.delete(userEnrolments).where(eq(userEnrolments.userId, userId)).returning()).length;
    deleted.grades = (await this.db.delete(gradeGrades).where(eq(gradeGrades.userId, userId)).returning()).length;
    const a = (await this.db.delete(courseModulesCompletion).where(eq(courseModulesCompletion.userId, userId)).returning()).length;
    const b = (await this.db.delete(courseCompletions).where(eq(courseCompletions.userId, userId)).returning()).length;
    deleted.completion = a + b;
    deleted.files = (await this.db.delete(files).where(eq(files.userId, userId)).returning()).length;
    deleted.messaging = (await this.db.delete(notifications).where(eq(notifications.userIdTo, userId)).returning()).length;
    deleted.calendar = (await this.db.delete(calendarEvents).where(eq(calendarEvents.userId, userId)).returning()).length;
    deleted.badges = (await this.db.delete(badgeIssued).where(eq(badgeIssued.userId, userId)).returning()).length;
    deleted.competencies = (await this.db.delete(competencyUserComp).where(eq(competencyUserComp.userId, userId)).returning()).length;
    deleted.search = (await this.db.delete(searchDocuments).where(eq(searchDocuments.ownerId, userId)).returning()).length;
    deleted.contentbank = (await this.db.delete(contentBankContent).where(eq(contentBankContent.creatorId, userId)).returning()).length;
    deleted.payments = (await this.db.update(payments).set({ userId: '00000000-0000-0000-0000-000000000000' }).where(eq(payments.userId, userId)).returning()).length;
    await this.db.delete(userPreferences).where(eq(userPreferences.userId, userId));
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (u) {
      await this.db.update(users).set({ deleted: true, suspended: true, username: `${u.username}.deleted${userId}`, email: `${u.email}.deleted${userId}` }).where(eq(users.id, userId));
    }
    deleted.users = 1;
    await this.db.update(privacyRequests).set({ status: 'completed', result: { deleted, subsystems }, updatedAt: new Date() }).where(eq(privacyRequests.id, req.id));
    return { status: 'completed', subsystems };
  }
}

/** Payment reconciliation + webhook twin: đối soát tối giản và xử lý webhook idempotent theo external tx. */
@Processor('payment-reconciliation')
/**
 * Xử lý job đối soát thanh toán.
 */
export class PaymentReconciliationProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(job: Job<{ paymentId?: string; externalTransactionId?: string; status?: string }>): Promise<{ status: string; duplicate?: boolean; succeeded?: number }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<{ paymentId?: string; externalTransactionId?: string; status?: string }>): Promise<{ status: string; duplicate?: boolean; succeeded?: number }> {
    if (job.data.paymentId && job.data.externalTransactionId) {
      const [existing] = await this.db.select().from(payments)
        .where(and(eq(payments.gateway, 'manual'), eq(payments.externalTransactionId, job.data.externalTransactionId)));
      if (existing) return { status: existing.status, duplicate: true };
      const [payment] = await this.db.select().from(payments).where(eq(payments.id, job.data.paymentId));
      if (!payment) return { status: 'missing' };
      if (payment.status === 'succeeded') return { status: 'succeeded', duplicate: true };
      const newStatus = job.data.status === 'succeeded' ? 'succeeded' : 'failed';
      await this.db.update(payments).set({ status: newStatus, externalTransactionId: job.data.externalTransactionId, updatedAt: new Date() }).where(eq(payments.id, payment.id));
      if (newStatus === 'succeeded') {
        await this.db.insert(outboxEvents).values({
          aggregate: 'payment', type: 'payment_succeeded',
          payload: { paymentId: payment.id, userId: payment.userId, amount: payment.amount, currency: payment.currency, component: payment.component, itemId: payment.itemId, externalTransactionId: job.data.externalTransactionId, worker: true },
        });
      }
      return { status: newStatus };
    }
    const all = await this.db.select().from(payments);
    return { status: 'reconciled', succeeded: all.filter((p) => p.status === 'succeeded').length };
  }
}
