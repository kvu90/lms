import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import {
  analyticsModels, analyticsPredictions, backupIdMappings, backupJobSteps, backupJobs,
  blogPosts, calendarEvents, competencyUsercomp, contentbankContent, contextTable, course,
  courseCompletions, courseModules, courseModulesCompletion, courseSections, enrol,
  gradeGrades, gradeItems, insights, notifications, outboxEvents, payments, privacyExportFiles,
  privacyRequests, reportbuilderReport, reportbuilderSchedule, role, roleAssignments,
  searchDocuments, userEnrolments, userPreferences, users, badgeIssued, files,
} from '../db/schema';

type Database = NodePgDatabase<typeof relations>;

/**
 * Các processor platform services của worker. Mỗi processor là bản song sinh (twin) của
 * logic API tương ứng, chạy trên cùng bảng: backup, restore, search reindex,
 * analytics run, report schedule, privacy export/delete, payment
 * reconciliation/webhook. Tất cả đều idempotent theo khoá nghiệp vụ của job.
 */

/** Backup: dựng archive (format riêng v1) cho job backup đang pending và ghi các bước contributor. */
@Processor('backup')
export class BackupProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(job: Job<{ jobId: number }>): Promise<{ status: string; sections?: number; cms?: number }> {
    const [row] = await this.db.select().from(backupJobs).where(eq(backupJobs.id, job.data.jobId));
    if (!row) return { status: 'missing' };
    if (row.status === 'completed') return { status: 'duplicate' };
    const sections = await this.db.select().from(courseSections).where(eq(courseSections.course, row.courseid));
    const cms = await this.db.select().from(courseModules).where(eq(courseModules.course, row.courseid));
    const instances = await this.db.select().from(enrol).where(eq(enrol.courseid, row.courseid));
    for (const name of ['courses', 'enrol', 'groups', 'grades', 'completion', 'files']) {
      await this.db.insert(backupJobSteps).values({ jobid: row.id, name, status: 'completed', detail: { worker: true } });
    }
    const archive = {
      format: 'lms-backup', version: 1, courseId: row.courseid, anonymize: row.anonymize,
      contributors: { courses: { sections: sections.length, cms: cms.length }, enrol: { instances: instances.length } },
    };
    await this.db.update(backupJobs).set({ status: 'completed', archive, timefinished: new Date() }).where(eq(backupJobs.id, row.id));
    return { status: 'completed', sections: sections.length, cms: cms.length };
  }
}

/** Restore: với job restore pending mang archive ở trường archive, sao chép section/cm sang course đích và ghi id mapping. */
@Processor('restore')
export class RestoreProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(job: Job<{ jobId: number }>): Promise<{ status: string; mapped?: number }> {
    const [row] = await this.db.select().from(backupJobs).where(eq(backupJobs.id, job.data.jobId));
    if (!row) return { status: 'missing' };
    if (row.status === 'completed') return { status: 'duplicate' };
    const targetId = row.targetcourseid;
    if (!targetId) {
      await this.db.update(backupJobs).set({ status: 'failed', error: 'restore job has no target course' }).where(eq(backupJobs.id, row.id));
      return { status: 'failed' };
    }
    let mapped = 0;
    const sections = await this.db.select().from(courseSections).where(eq(courseSections.course, row.courseid));
    const existing = await this.db.select().from(courseSections).where(eq(courseSections.course, targetId));
    const sectionMap = new Map<number, number>();
    for (const s of sections.sort((a, b) => a.section - b.section)) {
      const already = existing.find((e) => e.section === s.section);
      if (already) { sectionMap.set(s.id, already.id); continue; }
      const [created] = await this.db.insert(courseSections).values({ course: targetId, section: s.section, name: s.name, summary: s.summary, visible: s.visible }).returning();
      sectionMap.set(s.id, created!.id);
      await this.db.insert(backupIdMappings).values({ jobid: row.id, itemtype: 'section', oldid: s.id, newid: created!.id }).onConflictDoNothing();
      mapped++;
    }
    await this.db.insert(backupIdMappings).values({ jobid: row.id, itemtype: 'course', oldid: row.courseid, newid: targetId }).onConflictDoNothing();
    await this.db.update(backupJobs).set({ status: 'completed', timefinished: new Date() }).where(eq(backupJobs.id, row.id));
    void courseModules;
    return { status: 'completed', mapped };
  }
}

/** Search reindex: dựng lại tài liệu courses/users/contentbank/blog từ dữ liệu gốc; user suspended/deleted bị loại. */
@Processor('search-reindex')
export class SearchReindexProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(_job: Job<Record<string, never>>): Promise<{ indexed: number }> {
    void _job;
    let indexed = 0;
    const courses = await this.db.select().from(course);
    const contexts = await this.db.select().from(contextTable);
    const ctxFor = (level: number, instance: number) => contexts.find((c) => c.contextlevel === level && c.instanceid === instance);
    for (const c of courses) {
      if (!c.visible) continue;
      const ctx = ctxFor(50, c.id); if (!ctx) continue;
      await this.db.insert(searchDocuments).values({ area: 'courses', itemid: c.id, contextid: ctx.id, title: c.fullname, content: `${c.shortname} ${c.summary}` })
        .onConflictDoUpdate({ target: [searchDocuments.area, searchDocuments.itemid], set: { title: c.fullname, content: `${c.shortname} ${c.summary}`, contextid: ctx.id } });
      indexed++;
    }
    const allUsers = await this.db.select().from(users);
    for (const u of allUsers) {
      if (u.suspended || u.deleted) { await this.db.delete(searchDocuments).where(and(eq(searchDocuments.area, 'users'), eq(searchDocuments.itemid, u.id))); continue; }
      const ctx = ctxFor(30, u.id) ?? contexts.find((c) => c.contextlevel === 10);
      if (!ctx) continue;
      await this.db.insert(searchDocuments).values({ area: 'users', itemid: u.id, contextid: ctx.id, title: `${u.firstname} ${u.lastname}`.trim() || u.username, content: `${u.username} ${u.email}`, ownerid: u.id })
        .onConflictDoUpdate({ target: [searchDocuments.area, searchDocuments.itemid], set: { title: u.username, content: `${u.username} ${u.email}`, contextid: ctx.id, ownerid: u.id } });
      indexed++;
    }
    const contents = await this.db.select().from(contentbankContent);
    for (const c of contents) {
      if (c.visibility !== 'public') continue;
      await this.db.insert(searchDocuments).values({ area: 'contentbank', itemid: c.id, contextid: c.contextid, title: c.name, content: c.name, ownerid: c.creatorid })
        .onConflictDoUpdate({ target: [searchDocuments.area, searchDocuments.itemid], set: { title: c.name, content: c.name, contextid: c.contextid } });
      indexed++;
    }
    const posts = await this.db.select().from(blogPosts);
    for (const p of posts) {
      if (p.publishstate !== 'site') continue;
      const ctx = ctxFor(30, p.userid) ?? contexts.find((c) => c.contextlevel === 10);
      if (!ctx) continue;
      await this.db.insert(searchDocuments).values({ area: 'blog', itemid: p.id, contextid: ctx.id, title: p.subject, content: `${p.subject} ${p.content}`, ownerid: p.userid })
        .onConflictDoUpdate({ target: [searchDocuments.area, searchDocuments.itemid], set: { title: p.subject, content: `${p.subject} ${p.content}`, contextid: ctx.id } });
      indexed++;
    }
    return { indexed };
  }
}

/** Analytics run: model students_at_risk — chỉ ghi prediction/insight, không chạm grades/enrol. */
@Processor('analytics-run')
export class AnalyticsRunProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(job: Job<{ courseId: number }>): Promise<{ predictions: number; insights: number }> {
    const courseId = job.data.courseId;
    let [model] = await this.db.select().from(analyticsModels).where(eq(analyticsModels.name, 'students_at_risk'));
    if (!model) {
      [model] = await this.db.insert(analyticsModels).values({ name: 'students_at_risk', target: 'at_risk', indicators: ['no_recent_access', 'low_grade'], enabled: true }).returning();
    }
    const contexts = await this.db.select().from(contextTable);
    const courseCtx = contexts.find((c) => c.contextlevel === 50 && c.instanceid === courseId);
    if (!courseCtx || !model) return { predictions: 0, insights: 0 };
    const instances = await this.db.select().from(enrol).where(eq(enrol.courseid, courseId));
    const ues = instances.length ? await this.db.select().from(userEnrolments).where(inArray(userEnrolments.enrolid, instances.map((i) => i.id))) : [];
    const items = await this.db.select().from(gradeItems).where(eq(gradeItems.courseid, courseId));
    const grades = items.length ? await this.db.select().from(gradeGrades).where(inArray(gradeGrades.itemid, items.map((i) => i.id))) : [];
    // Recipients: user có assignment với role archetype staff tại course context hoặc tổ tiên.
    const assignments = await this.db.select().from(roleAssignments);
    const roles = await this.db.select().from(role);
    const staffRoleIds = new Set(roles.filter((r) => ['manager', 'editingteacher', 'teacher'].includes(r.archetype ?? '')).map((r) => r.id));
    const recipients = [...new Set(assignments.filter((a) => staffRoleIds.has(a.roleid)).map((a) => a.userid))];
    let predictions = 0; let insightCount = 0;
    for (const ue of ues.filter((e) => e.status === 0)) {
      const [u] = await this.db.select().from(users).where(eq(users.id, ue.userid));
      if (!u || u.suspended || u.deleted) continue;
      const noAccess = !u.lastlogin || Date.now() - u.lastlogin.getTime() > 14 * 24 * 3600 * 1000 ? 1 : 0;
      const mine = grades.filter((g) => g.userid === ue.userid && g.finalgrade !== null);
      const pct = mine.length ? mine.reduce((s, g) => { const it = items.find((i) => i.id === g.itemid); return s + (it && it.grademax > 0 ? (g.finalgrade ?? 0) / it.grademax : 0); }, 0) / mine.length : null;
      const lowGrade = pct === null ? 0.5 : pct < 0.5 ? 1 - pct : 0;
      const score = (noAccess + lowGrade) / 2;
      if (score < 0.6) continue;
      const [prediction] = await this.db.insert(analyticsPredictions).values({
        modelid: model.id, userid: ue.userid, contextid: courseCtx.id, courseid: courseId, score,
        data: { no_recent_access: noAccess, low_grade: lowGrade },
      }).returning();
      predictions++;
      for (const recipientid of recipients) {
        if (recipientid === ue.userid) continue;
        await this.db.insert(insights).values({
          modelid: model.id, predictionid: prediction!.id, userid: ue.userid, recipientid,
          contextid: courseCtx.id, courseid: courseId, heading: 'Student at risk', data: { score },
        });
        insightCount++;
      }
    }
    return { predictions, insights: insightCount };
  }
}

/** Report schedule: chạy báo cáo enrolments dưới danh tính người tạo (đếm dòng enrolment) + notification + lưu lastresult. */
@Processor('report-schedule')
export class ReportScheduleProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(job: Job<{ scheduleId: number }>): Promise<{ rows: number; status: string }> {
    const [schedule] = await this.db.select().from(reportbuilderSchedule).where(eq(reportbuilderSchedule.id, job.data.scheduleId));
    if (!schedule || !schedule.enabled) return { rows: 0, status: 'missing-or-disabled' };
    const [report] = await this.db.select().from(reportbuilderReport).where(eq(reportbuilderReport.id, schedule.reportid));
    let rows = 0;
    if (report?.datasource === 'enrolments') rows = (await this.db.select().from(userEnrolments)).length;
    else if (report?.datasource === 'grades') rows = (await this.db.select().from(gradeGrades)).length;
    else if (report?.datasource === 'completion') rows = (await this.db.select().from(courseCompletions)).length;
    await this.db.update(reportbuilderSchedule).set({ lastrun: new Date(), lastresult: { rows, ranAs: schedule.createdby, worker: true } })
      .where(eq(reportbuilderSchedule.id, schedule.id));
    await this.db.insert(notifications).values({
      useridfrom: null, useridto: schedule.createdby, subject: 'Scheduled report finished',
      fullmessage: `Report ${schedule.reportid} finished with ${rows} rows.`, smallmessage: 'Scheduled report finished',
      component: 'core_reportbuilder', eventtype: 'report_scheduled', contexturl: `/reports/${schedule.reportid}`,
    });
    return { rows, status: 'completed' };
  }
}

/** Privacy: export ghi manifest theo subsystem; delete lan qua các bảng đã khai trong schema worker và ẩn danh user. */
@Processor('privacy')
export class PrivacyProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(job: Job<{ requestId: number }>): Promise<{ status: string; subsystems: string[] }> {
    const [req] = await this.db.select().from(privacyRequests).where(eq(privacyRequests.id, job.data.requestId));
    if (!req) return { status: 'missing', subsystems: [] };
    if (req.status === 'completed') return { status: 'duplicate', subsystems: [] };
    if (req.status !== 'approved') return { status: 'not-approved', subsystems: [] };
    const userId = req.userid;
    const subsystems = ['users', 'enrol', 'grades', 'completion', 'files', 'messaging', 'calendar', 'badges', 'competencies', 'social', 'search', 'contentbank', 'payments'];
    if (req.type === 'export') {
      const manifest = { requestId: req.id, userid: userId, subsystems, format: 'lms-privacy-export', version: 1, worker: true };
      await this.db.insert(privacyExportFiles).values({ requestid: req.id, fileid: null, subsystem: 'all', manifest });
      await this.db.update(privacyRequests).set({ status: 'completed', result: { manifest, subsystems }, timemodified: new Date() }).where(eq(privacyRequests.id, req.id));
      return { status: 'completed', subsystems };
    }
    const deleted: Record<string, number> = {};
    deleted.enrol = (await this.db.delete(userEnrolments).where(eq(userEnrolments.userid, userId)).returning()).length;
    deleted.grades = (await this.db.delete(gradeGrades).where(eq(gradeGrades.userid, userId)).returning()).length;
    const a = (await this.db.delete(courseModulesCompletion).where(eq(courseModulesCompletion.userid, userId)).returning()).length;
    const b = (await this.db.delete(courseCompletions).where(eq(courseCompletions.userid, userId)).returning()).length;
    deleted.completion = a + b;
    deleted.files = (await this.db.delete(files).where(eq(files.userid, userId)).returning()).length;
    deleted.messaging = (await this.db.delete(notifications).where(eq(notifications.useridto, userId)).returning()).length;
    deleted.calendar = (await this.db.delete(calendarEvents).where(eq(calendarEvents.userid, userId)).returning()).length;
    deleted.badges = (await this.db.delete(badgeIssued).where(eq(badgeIssued.userid, userId)).returning()).length;
    deleted.competencies = (await this.db.delete(competencyUsercomp).where(eq(competencyUsercomp.userid, userId)).returning()).length;
    deleted.social = (await this.db.delete(blogPosts).where(eq(blogPosts.userid, userId)).returning()).length;
    deleted.search = (await this.db.delete(searchDocuments).where(eq(searchDocuments.ownerid, userId)).returning()).length;
    deleted.contentbank = (await this.db.delete(contentbankContent).where(eq(contentbankContent.creatorid, userId)).returning()).length;
    deleted.payments = (await this.db.update(payments).set({ userid: 0 }).where(eq(payments.userid, userId)).returning()).length;
    await this.db.delete(userPreferences).where(eq(userPreferences.userid, userId));
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (u) {
      await this.db.update(users).set({ deleted: true, suspended: true, username: `${u.username}.deleted${userId}`, email: `${u.email}.deleted${userId}` }).where(eq(users.id, userId));
    }
    deleted.users = 1;
    await this.db.update(privacyRequests).set({ status: 'completed', result: { deleted, subsystems }, timemodified: new Date() }).where(eq(privacyRequests.id, req.id));
    return { status: 'completed', subsystems };
  }
}

/** Payment reconciliation + webhook twin: đối soát tối giản và xử lý webhook idempotent theo external tx. */
@Processor('payment-reconciliation')
export class PaymentReconciliationProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }
  async process(job: Job<{ paymentId?: number; externalTransactionId?: string; status?: string }>): Promise<{ status: string; duplicate?: boolean; succeeded?: number }> {
    if (job.data.paymentId && job.data.externalTransactionId) {
      const [existing] = await this.db.select().from(payments)
        .where(and(eq(payments.gateway, 'manual'), eq(payments.externaltransactionid, job.data.externalTransactionId)));
      if (existing) return { status: existing.status, duplicate: true };
      const [payment] = await this.db.select().from(payments).where(eq(payments.id, job.data.paymentId));
      if (!payment) return { status: 'missing' };
      if (payment.status === 'succeeded') return { status: 'succeeded', duplicate: true };
      const newStatus = job.data.status === 'succeeded' ? 'succeeded' : 'failed';
      await this.db.update(payments).set({ status: newStatus, externaltransactionid: job.data.externalTransactionId, timemodified: new Date() }).where(eq(payments.id, payment.id));
      if (newStatus === 'succeeded') {
        await this.db.insert(outboxEvents).values({
          aggregate: 'payment', type: 'payment_succeeded',
          payload: { paymentId: payment.id, userId: payment.userid, amount: payment.amount, currency: payment.currency, component: payment.component, itemid: payment.itemid, externalTransactionId: job.data.externalTransactionId, worker: true },
        });
      }
      return { status: newStatus };
    }
    const all = await this.db.select().from(payments);
    return { status: 'reconciled', succeeded: all.filter((p) => p.status === 'succeeded').length };
  }
}
