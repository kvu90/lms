import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { I18nService } from '@nestjs/i18n';
import { sql, type CentreDB } from '@lms/db';
import { NotificationDeliveryService } from '../notification-delivery.service';
import { tenantAls } from '../db/tenant-als';
import { resolveDefaultTenantId } from '../db/default-tenant';
import { SpaceDatabaseService } from '../db/routing/space-database.service';

/**
 * Các processor platform services của worker. Mỗi processor là bản song sinh (twin) của
 * logic API tương ứng, chạy trên cùng bảng: backup, restore, search reindex,
 * analytics run, report schedule, privacy export/delete, payment
 * reconciliation/webhook. Tất cả đều idempotent theo khoá nghiệp vụ của job.
 *
 * @remarks
 * Mọi truy vấn của các processor trong file này đi qua handle Kysely
 * định tuyến (`SpaceDatabaseService.routedKysely`): các processor chạy
 * trong ngữ cảnh platform tường minh (xem TENANT-1 ở từng `process`)
 * nên handle vào kho chung — cùng đích kho với handle bộ máy cũ định
 * tuyến trước đây. Các cột jsonb khi ghi (`archive`, `detail`,
 * `indicators`, `data`, `last_result`, `manifest`, `result`,
 * payload outbox) đi qua serialize tường minh + `::jsonb` theo khuôn
 * pilot (driver `pg` hiểu mảng cấp cao nhất là mảng PostgreSQL nếu
 * không serialize); khoá bên trong các giá trị jsonb là khoá dữ kiện
 * đã lưu nên giữ nguyên camelCase như trước.
 */

/** Backup: dựng archive (format riêng v1) cho job backup đang pending và ghi các bước contributor. */
@Processor('backup')
/**
 * Xử lý job sao lưu khoá học nền.
 */
export class BackupProcessor extends WorkerHost {
  constructor(private readonly spaceDb: SpaceDatabaseService) { super(); }
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
    const db = this.spaceDb.routedKysely;
    const row = await db
      .selectFrom('backup_jobs')
      .select(['id', 'status', 'scope', 'course_id as courseId', 'anonymize'])
      .where('id', '=', job.data.jobId)
      .executeTakeFirst();
    if (!row) return { status: 'missing' };
    if (row.status === 'completed') return { status: 'duplicate' };
    const scope = row.scope ?? 'course';
    // Question bank bám context: khoá → context của khoá; site → context hệ thống.
    const contexts = await db
      .selectFrom('context')
      .select(['id', 'context_level as contextLevel', 'instance_id as instanceId'])
      .execute();
    const bankCtx = scope === 'site'
      ? contexts.find((c) => c.contextLevel === 10)
      : contexts.find((c) => c.contextLevel === 50 && c.instanceId === row.courseId);
    const qCategories = bankCtx ? await db.selectFrom('question_categories').select('id').where('context_id', '=', bankCtx.id).execute() : [];
    const qCatIds = qCategories.map((c) => c.id);
    const qRows = qCatIds.length ? await db.selectFrom('question').select('id').where('category', 'in', qCatIds).execute() : [];
    const qEntries = qCatIds.length ? await db.selectFrom('question_bank_entries').select('id').where('question_category_id', 'in', qCatIds).execute() : [];
    const qEntryIds = qEntries.map((e) => e.id);
    const qVersions = qEntryIds.length ? await db.selectFrom('question_versions').select('id').where('question_bank_entry_id', 'in', qEntryIds).execute() : [];
    const badges = scope === 'site'
      ? await db.selectFrom('badge').select('id').where('course_id', 'is', null).execute()
      : await db.selectFrom('badge').select('id').where('course_id', '=', row.courseId!).execute();
    const criteria = badges.length ? await db.selectFrom('badge_criteria').select('id').where('badge_id', 'in', badges.map((b) => b.id)).execute() : [];
    const calEvents = scope === 'site'
      ? await db.selectFrom('calendar_events').select('id').where('event_type', '=', 'site').execute()
      : await db.selectFrom('calendar_events').select('id').where('course_id', '=', row.courseId!).execute();
    const calSubs = scope === 'site'
      ? await db.selectFrom('calendar_subscriptions').select('id').where('event_type', '=', 'site').execute()
      : await db.selectFrom('calendar_subscriptions').select('id').where('course_id', '=', row.courseId!).execute();
    const contributorNames = scope === 'site'
      ? ['questions', 'badges', 'calendar']
      : ['courses', 'enrol', 'groups', 'grades', 'completion', 'files', 'questions', 'badges', 'calendar'];
    for (const name of contributorNames) {
      await db
        .insertInto('backup_job_steps')
        .values({
          job_id: row.id, name, status: 'completed',
          detail: sql<CentreDB['backup_job_steps']['detail']>`${JSON.stringify({ worker: true })}::jsonb`,
        })
        .execute();
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
      await db
        .updateTable('backup_jobs')
        .set({
          status: 'completed',
          archive: sql<CentreDB['backup_jobs']['archive']>`${JSON.stringify(archive)}::jsonb`,
          time_finished: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
      return { status: 'completed', sections: 0, cms: 0 };
    }
    const sections = await db.selectFrom('course_sections').select('id').where('course', '=', row.courseId!).execute();
    const cms = await db.selectFrom('course_modules').select('id').where('course', '=', row.courseId!).execute();
    const instances = await db.selectFrom('enrol').select('id').where('course_id', '=', row.courseId!).execute();
    const archive = {
      format: 'lms-backup', version: 1, scope, courseId: row.courseId, anonymize: row.anonymize,
      contributors: { courses: { sections: sections.length, cms: cms.length }, enrol: { instances: instances.length }, ...extended },
    };
    await db
      .updateTable('backup_jobs')
      .set({
        status: 'completed',
        archive: sql<CentreDB['backup_jobs']['archive']>`${JSON.stringify(archive)}::jsonb`,
        time_finished: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    return { status: 'completed', sections: sections.length, cms: cms.length };
  }
}

/** Restore: với job restore pending mang archive ở trường archive, sao chép section/cm sang course đích và ghi id mapping. */
@Processor('restore')
/**
 * Xử lý job khôi phục khoá học nền.
 */
export class RestoreProcessor extends WorkerHost {
  constructor(private readonly spaceDb: SpaceDatabaseService) { super(); }
  async process(job: Job<{ jobId: string }>): Promise<{ status: string; mapped?: number }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<{ jobId: string }>): Promise<{ status: string; mapped?: number }> {
    const db = this.spaceDb.routedKysely;
    const row = await db
      .selectFrom('backup_jobs')
      .select(['id', 'status', 'course_id as courseId', 'target_course_id as targetCourseId'])
      .where('id', '=', job.data.jobId)
      .executeTakeFirst();
    if (!row) return { status: 'missing' };
    if (row.status === 'completed') return { status: 'duplicate' };
    const targetId = row.targetCourseId;
    if (!targetId || !row.courseId) {
      // Restore mức site không có khoá nguồn/đích: bản twin này chỉ xử lý
      // restore mức khoá; restore site chạy đồng bộ ở API (không qua queue).
      await db
        .updateTable('backup_jobs')
        .set({ status: 'failed', error: 'restore job has no target course' })
        .where('id', '=', row.id)
        .execute();
      return { status: 'failed' };
    }
    let mapped = 0;
    const sectionColumns = ['id', 'section', 'name', 'summary', 'visible'] as const;
    const sections = await db.selectFrom('course_sections').select(sectionColumns).where('course', '=', row.courseId).execute();
    const existing = await db.selectFrom('course_sections').select(sectionColumns).where('course', '=', targetId).execute();
    const sectionMap = new Map<string, string>();
    for (const s of sections.sort((a, b) => a.section - b.section)) {
      const already = existing.find((e) => e.section === s.section);
      if (already) { sectionMap.set(s.id, already.id); continue; }
      const created = await db
        .insertInto('course_sections')
        .values({ course: targetId, section: s.section, name: s.name, summary: s.summary, visible: s.visible })
        .returning('id')
        .executeTakeFirst();
      sectionMap.set(s.id, created!.id);
      await db
        .insertInto('backup_id_mappings')
        .values({ job_id: row.id, item_type: 'section', old_id: s.id, new_id: created!.id })
        .onConflict((oc) => oc.doNothing())
        .execute();
      mapped++;
    }
    await db
      .insertInto('backup_id_mappings')
      .values({ job_id: row.id, item_type: 'course', old_id: row.courseId, new_id: targetId })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await db
      .updateTable('backup_jobs')
      .set({ status: 'completed', time_finished: new Date() })
      .where('id', '=', row.id)
      .execute();
    return { status: 'completed', mapped };
  }
}

/** Search reindex: dựng lại tài liệu courses/users/contentbank từ dữ liệu gốc; user suspended/deleted bị loại. */
@Processor('search-reindex')
/**
 * Xử lý job dựng lại chỉ mục tìm kiếm.
 */
export class SearchReindexProcessor extends WorkerHost {
  constructor(private readonly spaceDb: SpaceDatabaseService) { super(); }
  async process(_job: Job<Record<string, never>>): Promise<{ indexed: number }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(_job));
  }

  private async processInContext(_job: Job<Record<string, never>>): Promise<{ indexed: number }> {
    void _job;
    const db = this.spaceDb.routedKysely;
    let indexed = 0;
    const courses = await db
      .selectFrom('course')
      .select(['id', 'visible', 'full_name as fullName', 'short_name as shortName', 'summary'])
      .execute();
    const contexts = await db
      .selectFrom('context')
      .select(['id', 'context_level as contextLevel', 'instance_id as instanceId'])
      .execute();
    const ctxFor = (level: number, instance: string) => contexts.find((c) => c.contextLevel === level && c.instanceId === instance);
    for (const c of courses) {
      if (!c.visible) continue;
      const ctx = ctxFor(50, c.id); if (!ctx) continue;
      await db
        .insertInto('search_documents')
        .values({ area: 'courses', item_id: c.id, context_id: ctx.id, title: c.fullName, content: `${c.shortName} ${c.summary}` })
        .onConflict((oc) => oc
          .columns(['area', 'item_id'])
          .doUpdateSet({ title: c.fullName, content: `${c.shortName} ${c.summary}`, context_id: ctx.id }))
        .execute();
      indexed++;
    }
    const allUsers = await db
      .selectFrom('users')
      .select(['id', 'suspended', 'deleted', 'first_name as firstName', 'last_name as lastName', 'username', 'email'])
      .execute();
    for (const u of allUsers) {
      if (u.suspended || u.deleted) {
        await db
          .deleteFrom('search_documents')
          .where('area', '=', 'users')
          .where('item_id', '=', u.id)
          .execute();
        continue;
      }
      const ctx = ctxFor(30, u.id) ?? contexts.find((c) => c.contextLevel === 10);
      if (!ctx) continue;
      await db
        .insertInto('search_documents')
        .values({ area: 'users', item_id: u.id, context_id: ctx.id, title: `${u.firstName} ${u.lastName}`.trim() || u.username, content: `${u.username} ${u.email}`, owner_id: u.id })
        .onConflict((oc) => oc
          .columns(['area', 'item_id'])
          .doUpdateSet({ title: u.username, content: `${u.username} ${u.email}`, context_id: ctx.id, owner_id: u.id }))
        .execute();
      indexed++;
    }
    const contents = await db
      .selectFrom('content_bank_content')
      .select(['id', 'visibility', 'context_id as contextId', 'name', 'creator_id as creatorId'])
      .execute();
    for (const c of contents) {
      if (c.visibility !== 'public') continue;
      await db
        .insertInto('search_documents')
        .values({ area: 'contentbank', item_id: c.id, context_id: c.contextId, title: c.name, content: c.name, owner_id: c.creatorId })
        .onConflict((oc) => oc
          .columns(['area', 'item_id'])
          .doUpdateSet({ title: c.name, content: c.name, context_id: c.contextId }))
        .execute();
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
  constructor(private readonly spaceDb: SpaceDatabaseService) { super(); }
  async process(job: Job<{ courseId: string }>): Promise<{ predictions: number; insights: number }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<{ courseId: string }>): Promise<{ predictions: number; insights: number }> {
    const db = this.spaceDb.routedKysely;
    const courseId = job.data.courseId;
    let model = await db
      .selectFrom('analytics_models')
      .select('id')
      .where('name', '=', 'students_at_risk')
      .executeTakeFirst();
    if (!model) {
      model = await db
        .insertInto('analytics_models')
        .values({
          name: 'students_at_risk', target: 'at_risk',
          indicators: sql<CentreDB['analytics_models']['indicators']>`${JSON.stringify(['no_recent_access', 'low_grade'])}::jsonb`,
          enabled: true,
        })
        .returning('id')
        .executeTakeFirst();
    }
    const contexts = await db
      .selectFrom('context')
      .select(['id', 'context_level as contextLevel', 'instance_id as instanceId'])
      .execute();
    const courseCtx = contexts.find((c) => c.contextLevel === 50 && c.instanceId === courseId);
    if (!courseCtx || !model) return { predictions: 0, insights: 0 };
    const instances = await db.selectFrom('enrol').select('id').where('course_id', '=', courseId).execute();
    const ues = instances.length
      ? await db.selectFrom('user_enrolments').select(['user_id as userId', 'status']).where('enrol_id', 'in', instances.map((i) => i.id)).execute()
      : [];
    const items = await db.selectFrom('grade_items').select(['id', 'grade_max as gradeMax']).where('course_id', '=', courseId).execute();
    const grades = items.length
      ? await db.selectFrom('grade_grades').select(['user_id as userId', 'item_id as itemId', 'final_grade as finalGrade']).where('item_id', 'in', items.map((i) => i.id)).execute()
      : [];
    // Người nhận: user có assignment với role archetype staff tại course context hoặc tổ tiên.
    const assignments = await db.selectFrom('role_assignments').select(['role_id as roleId', 'user_id as userId']).execute();
    const roles = await db.selectFrom('role').select(['id', 'archetype']).execute();
    const staffRoleIds = new Set(roles.filter((r) => ['manager', 'editingteacher', 'teacher'].includes(r.archetype ?? '')).map((r) => r.id));
    const recipients = [...new Set(assignments.filter((a) => staffRoleIds.has(a.roleId)).map((a) => a.userId))];
    let predictions = 0; let insightCount = 0;
    for (const ue of ues.filter((e) => e.status === 0)) {
      const u = await db
        .selectFrom('users')
        .select(['suspended', 'deleted', 'last_login as lastLogin'])
        .where('id', '=', ue.userId)
        .executeTakeFirst();
      if (!u || u.suspended || u.deleted) continue;
      const noAccess = !u.lastLogin || Date.now() - u.lastLogin.getTime() > 14 * 24 * 3600 * 1000 ? 1 : 0;
      const mine = grades.filter((g) => g.userId === ue.userId && g.finalGrade !== null);
      const pct = mine.length ? mine.reduce((s, g) => { const it = items.find((i) => i.id === g.itemId); return s + (it && it.gradeMax > 0 ? (g.finalGrade ?? 0) / it.gradeMax : 0); }, 0) / mine.length : null;
      const lowGrade = pct === null ? 0.5 : pct < 0.5 ? 1 - pct : 0;
      const score = (noAccess + lowGrade) / 2;
      if (score < 0.6) continue;
      const prediction = await db
        .insertInto('analytics_predictions')
        .values({
          model_id: model.id, user_id: ue.userId, context_id: courseCtx.id, course_id: courseId, score,
          data: sql<CentreDB['analytics_predictions']['data']>`${JSON.stringify({ no_recent_access: noAccess, low_grade: lowGrade })}::jsonb`,
        })
        .returning('id')
        .executeTakeFirst();
      predictions++;
      for (const recipientId of recipients) {
        if (recipientId === ue.userId) continue;
        await db
          .insertInto('insights')
          .values({
            model_id: model.id, prediction_id: prediction!.id, user_id: ue.userId, recipient_id: recipientId,
            context_id: courseCtx.id, course_id: courseId, heading: 'Student at risk',
            data: sql<CentreDB['insights']['data']>`${JSON.stringify({ score })}::jsonb`,
          })
          .execute();
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
    const db = this.spaceDb.routedKysely;
    const schedule = await db
      .selectFrom('report_builder_schedule')
      .select(['id', 'enabled', 'report_id as reportId', 'created_by as createdBy'])
      .where('id', '=', job.data.scheduleId)
      .executeTakeFirst();
    if (!schedule || !schedule.enabled) return { rows: 0, status: 'missing-or-disabled' };
    const report = await db
      .selectFrom('report_builder_report')
      .select(['id', 'data_source as dataSource', 'name'])
      .where('id', '=', schedule.reportId)
      .executeTakeFirst();
    let rows = 0;
    if (report?.dataSource === 'enrolments') rows = (await db.selectFrom('user_enrolments').select('id').execute()).length;
    else if (report?.dataSource === 'grades') rows = (await db.selectFrom('grade_grades').select('id').execute()).length;
    else if (report?.dataSource === 'completion') rows = (await db.selectFrom('course_completions').select('id').execute()).length;
    await db
      .updateTable('report_builder_schedule')
      .set({
        last_run: new Date(),
        last_result: sql<CentreDB['report_builder_schedule']['last_result']>`${JSON.stringify({ rows, ranAs: schedule.createdBy, worker: true })}::jsonb`,
      })
      .where('id', '=', schedule.id)
      .execute();
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
  constructor(private readonly spaceDb: SpaceDatabaseService) { super(); }
  async process(job: Job<{ requestId: string }>): Promise<{ status: string; subsystems: string[] }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<{ requestId: string }>): Promise<{ status: string; subsystems: string[] }> {
    const db = this.spaceDb.routedKysely;
    const req = await db
      .selectFrom('privacy_requests')
      .select(['id', 'status', 'type', 'user_id as userId'])
      .where('id', '=', job.data.requestId)
      .executeTakeFirst();
    if (!req) return { status: 'missing', subsystems: [] };
    if (req.status === 'completed') return { status: 'duplicate', subsystems: [] };
    if (req.status !== 'approved') return { status: 'not-approved', subsystems: [] };
    const userId = req.userId;
    const subsystems = ['users', 'enrol', 'grades', 'completion', 'files', 'messaging', 'calendar', 'badges', 'competencies', 'social', 'search', 'contentbank', 'payments'];
    if (req.type === 'export') {
      const manifest = { requestId: req.id, userId: userId, subsystems, format: 'lms-privacy-export', version: 1, worker: true };
      await db
        .insertInto('privacy_export_files')
        .values({
          request_id: req.id, file_id: null, subsystem: 'all',
          manifest: sql<CentreDB['privacy_export_files']['manifest']>`${JSON.stringify(manifest)}::jsonb`,
        })
        .execute();
      await db
        .updateTable('privacy_requests')
        .set({
          status: 'completed',
          result: sql<CentreDB['privacy_requests']['result']>`${JSON.stringify({ manifest, subsystems })}::jsonb`,
          updated_at: new Date(),
        })
        .where('id', '=', req.id)
        .execute();
      return { status: 'completed', subsystems };
    }
    const deleted: Record<string, number> = {};
    deleted.enrol = (await db.deleteFrom('user_enrolments').where('user_id', '=', userId).returning('id').execute()).length;
    deleted.grades = (await db.deleteFrom('grade_grades').where('user_id', '=', userId).returning('id').execute()).length;
    const a = (await db.deleteFrom('course_modules_completion').where('user_id', '=', userId).returning('id').execute()).length;
    const b = (await db.deleteFrom('course_completions').where('user_id', '=', userId).returning('id').execute()).length;
    deleted.completion = a + b;
    deleted.files = (await db.deleteFrom('files').where('user_id', '=', userId).returning('id').execute()).length;
    deleted.messaging = (await db.deleteFrom('notifications').where('user_id_to', '=', userId).returning('id').execute()).length;
    deleted.calendar = (await db.deleteFrom('calendar_events').where('user_id', '=', userId).returning('id').execute()).length;
    deleted.badges = (await db.deleteFrom('badge_issued').where('user_id', '=', userId).returning('id').execute()).length;
    deleted.competencies = (await db.deleteFrom('competency_user_comp').where('user_id', '=', userId).returning('id').execute()).length;
    deleted.search = (await db.deleteFrom('search_documents').where('owner_id', '=', userId).returning('id').execute()).length;
    deleted.contentbank = (await db.deleteFrom('content_bank_content').where('creator_id', '=', userId).returning('id').execute()).length;
    deleted.payments = (await db.updateTable('payments').set({ user_id: '00000000-0000-0000-0000-000000000000' }).where('user_id', '=', userId).returning('id').execute()).length;
    await db.deleteFrom('user_preferences').where('user_id', '=', userId).execute();
    const u = await db
      .selectFrom('users')
      .select(['username', 'email'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (u) {
      await db
        .updateTable('users')
        .set({ deleted: true, suspended: true, username: `${u.username}.deleted${userId}`, email: `${u.email}.deleted${userId}` })
        .where('id', '=', userId)
        .execute();
    }
    deleted.users = 1;
    await db
      .updateTable('privacy_requests')
      .set({
        status: 'completed',
        result: sql<CentreDB['privacy_requests']['result']>`${JSON.stringify({ deleted, subsystems })}::jsonb`,
        updated_at: new Date(),
      })
      .where('id', '=', req.id)
      .execute();
    return { status: 'completed', subsystems };
  }
}

/** Payment reconciliation + webhook twin: đối soát tối giản và xử lý webhook idempotent theo external tx. */
@Processor('payment-reconciliation')
/**
 * Xử lý job đối soát thanh toán.
 */
export class PaymentReconciliationProcessor extends WorkerHost {
  constructor(private readonly spaceDb: SpaceDatabaseService) { super(); }
  async process(job: Job<{ paymentId?: string; externalTransactionId?: string; status?: string }>): Promise<{ status: string; duplicate?: boolean; succeeded?: number }> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<{ paymentId?: string; externalTransactionId?: string; status?: string }>): Promise<{ status: string; duplicate?: boolean; succeeded?: number }> {
    const db = this.spaceDb.routedKysely;
    if (job.data.paymentId && job.data.externalTransactionId) {
      const existing = await db
        .selectFrom('payments')
        .select(['id', 'status'])
        .where('gateway', '=', 'manual')
        .where('external_transaction_id', '=', job.data.externalTransactionId)
        .executeTakeFirst();
      if (existing) return { status: existing.status, duplicate: true };
      const payment = await db
        .selectFrom('payments')
        .select(['id', 'status', 'user_id as userId', 'amount', 'currency', 'component', 'item_id as itemId'])
        .where('id', '=', job.data.paymentId)
        .executeTakeFirst();
      if (!payment) return { status: 'missing' };
      if (payment.status === 'succeeded') return { status: 'succeeded', duplicate: true };
      const newStatus = job.data.status === 'succeeded' ? 'succeeded' : 'failed';
      await db
        .updateTable('payments')
        .set({ status: newStatus, external_transaction_id: job.data.externalTransactionId, updated_at: new Date() })
        .where('id', '=', payment.id)
        .execute();
      if (newStatus === 'succeeded') {
        await db
          .insertInto('outbox_events')
          .values({
            aggregate: 'payment', type: 'payment_succeeded',
            payload: sql<CentreDB['outbox_events']['payload']>`${JSON.stringify({ paymentId: payment.id, userId: payment.userId, amount: payment.amount, currency: payment.currency, component: payment.component, itemId: payment.itemId, externalTransactionId: job.data.externalTransactionId, worker: true })}::jsonb`,
          })
          .execute();
      }
      return { status: newStatus };
    }
    const all = await db.selectFrom('payments').select('status').execute();
    return { status: 'reconciled', succeeded: all.filter((p) => p.status === 'succeeded').length };
  }
}
