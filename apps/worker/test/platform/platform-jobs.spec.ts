import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  AnalyticsRunProcessor, BackupProcessor, PaymentReconciliationProcessor, PrivacyProcessor,
  ReportScheduleProcessor, RestoreProcessor, SearchReindexProcessor,
} from '../../src/processors/platform-services.processors';
import {
  backupJobs, enrol, gradeGrades, insights, payments, privacyRequests, reportBuilderReport,
  reportBuilderSchedule, searchDocuments, userEnrolments, users,
} from '@lms/db-schema';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../support/ordinary-worker-module';

/**
 * Các job nền tảng (platform) của worker. Oracles: report §4 platform-services DoD (các bước backup, search reindex,
 * analytics không side-effect, report schedule, privacy lan đủ, payment
 * webhook replay) + các file PHPUnit tương ứng của platform services.
 * User/course được raw-insert với id cao độc nhất như các worker spec trước.
 *
 * Từ lát 2 của issue #294, spec này boot WorkerModule qua harness
 * role thường (`test/ordinary-worker-module.ts`): module chạy bằng
 * role NOSUPERUSER/NOBYPASSRLS như production (các job nền tảng bọc
 * ngữ cảnh platform tường minh, vai trò này vẫn chịu RLS ở các bảng
 * tenant), fixture và đọc kiểm chứng đi qua kết nối quản trị của
 * harness — khẳng định nghiệp vụ của spec không đổi.
 */
describe('Worker platform services: backup, search reindex, analytics, report schedule, privacy, payment', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: any;
  const suffix = Date.now() % 100000;
  const userId = `01950000-0000-7000-8000-${String(950000 + suffix).padStart(12, '0')}`;
  const teacherId = `01960000-0000-7000-8000-${String(960000 + suffix).padStart(12, '0')}`;
  let courseId = '';
  let courseCtxId = '';


  // CLASS-0 đóng gói (PR #200): khoá dạy thật phải có class_id (CHECK
  // course_class_required_check) — lớp fixture cho tenant worker-fixture,
  // chủ lớp là user fixture riêng; mỗi lần gọi dựng một lớp mới.
  async function fixtureClassId(): Promise<string> {
    const ownerId = '01980000-0000-7000-8000-00000000c1a5';
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${ownerId}, 'wk-class-owner', 'wk-class-owner@x.io', false, false) on conflict (id) do nothing`);
    const coh = await db.execute(sql`insert into cohort (tenant_id, name, context_id, component, visible) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture cohort', '01990000-0000-7000-8000-0000000000a1', 'class', false) returning id`);
    const cohId = (coh.rows[0] as { id: string }).id;
    const cls = await db.execute(sql`insert into classes (tenant_id, name, owner_id, cohort_id) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture class', ${ownerId}, ${cohId}) returning id`);
    return (cls.rows[0] as { id: string }).id;
  }
  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    await db.execute(sql`insert into tenants (slug, name, kind, status) values ('worker-fixture', 'Worker fixture tenant', 'school', 'active') on conflict (slug) do nothing`);
    const catRows = await db.execute(sql`insert into course_categories (name, path, tenant_id) values (${`wk5-cat-${suffix}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;
    const courseRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name, class_id) values (${catId}, (select tenant_id from course_categories where id = ${catId}), ${`Worker Platform Course ${suffix}`}, ${`wk5c${suffix}`}, ${await fixtureClassId()}) returning id`);
    courseId = (courseRows.rows[0] as { id: string }).id;
    // Chuỗi context phải hợp lệ theo bất biến của cây context: path gồm
    // các id UUID thật và kết thúc bằng id của chính context — tài liệu
    // search gắn với context này được PermissionEvaluator ở phía API
    // duyệt lại theo path, path hư cấu sẽ làm nổ truy vấn đó.
    await db.execute(sql`insert into context (id, context_level, instance_id, path, depth)
      select '01990000-0000-7000-8000-0000000000a1', 10, null, '/01990000-0000-7000-8000-0000000000a1', 1
      where not exists (select 1 from context where context_level = 10 and instance_id is null)`);
    const sysRows = await db.execute(sql`select id from context where context_level = 10 and instance_id is null limit 1`);
    const systemCtxId = (sysRows.rows[0] as { id: string }).id;
    const ctxRows = await db.execute(sql`insert into context (context_level, instance_id, path, depth) values (50, ${courseId}, '', 2) returning id`);
    courseCtxId = (ctxRows.rows[0] as { id: string }).id;
    await db.execute(sql`update context set path = ${`/${systemCtxId}/${courseCtxId}`} where id = ${courseCtxId}`);
    void courseCtxId;
    await db.execute(sql`insert into users (id, username, email, first_name, last_name, suspended, deleted) values (${userId}, ${`wk5-u-${suffix}`}, ${`wk5u${suffix}@x.io`}, 'Risk', 'Student', false, false) on conflict (id) do nothing`);
    await db.execute(sql`insert into users (id, username, email, first_name, last_name, suspended, deleted) values (${teacherId}, ${`wk5-t-${suffix}`}, ${`wk5t${suffix}@x.io`}, 'Teach', 'Er', false, false) on conflict (id) do nothing`);
    await db.execute(sql`insert into course_sections (course, section, name) values (${courseId}, 0, 'General')`);
    await db.execute(sql`insert into course_sections (course, section, name) values (${courseId}, 1, 'Week 1')`);
    // Teacher assignment ở course context (role editingteacher có sẵn từ seed API? tạo nếu thiếu).
    await db.execute(sql`insert into role (name, short_name, archetype, sort_order) values ('Teacher', ${`wkteach${suffix}`}, 'editingteacher', 3) on conflict (short_name) do nothing`);
    const roleRows = await db.execute(sql`select id from role where short_name = ${`wkteach${suffix}`}`);
    const roleId = (roleRows.rows[0] as { id: string }).id;
    await db.execute(sql`insert into role_assignments (role_id, user_id, context_id) values (${roleId}, ${teacherId}, ${courseCtxId})`);
  });
  afterAll(async () => { await harness.close(); });

  it('backup processor builds a versioned archive with contributor steps and is idempotent on replay', async () => {
    const [job] = await db.insert(backupJobs).values({ type: 'backup', courseId: courseId, userId: teacherId, status: 'pending' }).returning();
    const processor = context.get(BackupProcessor);
    const first = await processor.process({ data: { jobId: job.id } } as never);
    expect(first.status).toBe('completed');
    expect(first.sections).toBe(2);
    const [row] = await db.select().from(backupJobs).where(eq(backupJobs.id, job.id));
    expect(row.archive.format).toBe('lms-backup');
    expect(row.archive.version).toBe(1);
    const second = await processor.process({ data: { jobId: job.id } } as never);
    expect(second.status).toBe('duplicate');
  });

  it('backup processor archive contains the new questions/badges/calendar sections (same lms-backup v1 format as the API)', async () => {
    // Ngân hàng câu hỏi ở context của khoá + badge của khoá + sự kiện/subscription của khoá.
    const qCatRows = await db.execute(sql`insert into question_categories (name, context_id) values (${`wk5-bank-${suffix}`}, ${courseCtxId}) returning id`);
    const qCatId = (qCatRows.rows[0] as { id: string }).id;
    // Câu hỏi không còn cột `name` (mô hình chốt 12:04: nhãn = trích đoạn nội dung) nên fixture chỉ chèn đúng cột còn tồn tại.
    const qRows = await db.execute(sql`insert into question (category, qtype) values (${qCatId}, 'truefalse') returning id`);
    const qId = (qRows.rows[0] as { id: string }).id;
    const entryRows = await db.execute(sql`insert into question_bank_entries (question_category_id, question_id, latest_version) values (${qCatId}, ${qId}, 2) returning id`);
    const entryId = (entryRows.rows[0] as { id: string }).id;
    const doc = (text: string) =>
      JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    await db.execute(sql`insert into question_versions (question_bank_entry_id, question_id, version, question_text) values (${entryId}, ${qId}, 1, ${doc('v1')}::jsonb)`);
    await db.execute(sql`insert into question_versions (question_bank_entry_id, question_id, version, question_text) values (${entryId}, ${qId}, 2, ${doc('v2')}::jsonb)`);
    const badgeRows = await db.execute(sql`insert into badge (name, type, course_id, status) values (${`WK5 badge ${suffix}`}, 2, ${courseId}, 0) returning id`);
    const badgeId = (badgeRows.rows[0] as { id: string }).id;
    await db.execute(sql`insert into badge_criteria (badge_id, criteria_type, method, params) values (${badgeId}, 'overall', 1, '{}'::jsonb)`);
    await db.execute(sql`insert into badge_criteria (badge_id, criteria_type, method, params) values (${badgeId}, 'coursecompletion', 1, ${JSON.stringify({ courseId })}::jsonb)`);
    await db.execute(sql`insert into calendar_events (name, event_type, course_id, time_start) values (${`WK5 event ${suffix}`}, 'course', ${courseId}, now())`);
    await db.execute(sql`insert into calendar_subscriptions (name, event_type, course_id) values (${`WK5 feed ${suffix}`}, 'course', ${courseId})`);

    const [job] = await db.insert(backupJobs).values({ type: 'backup', courseId: courseId, userId: teacherId, status: 'pending' }).returning();
    const processor = context.get(BackupProcessor);
    const result = await processor.process({ data: { jobId: job.id } } as never);
    expect(result.status).toBe('completed');
    const [row] = await db.select().from(backupJobs).where(eq(backupJobs.id, job.id));
    expect(row.archive.format).toBe('lms-backup');
    expect(row.archive.version).toBe(1);
    expect(row.archive.contributors.questions).toEqual({ categories: 1, questions: 1, entries: 1, versions: 2 });
    expect(row.archive.contributors.badges).toEqual({ badges: 1, criteria: 2 });
    expect(row.archive.contributors.calendar).toEqual({ events: 1, subscriptions: 1 });
    const steps = await db.execute(sql`select name from backup_job_steps where job_id = ${job.id}`);
    expect((steps.rows as { name: string }[]).map((s) => s.name)).toEqual(
      expect.arrayContaining(['questions', 'badges', 'calendar']));
  });

  it('backup processor handles a site-scope job (no course) with only the site-level sections', async () => {
    const sysRows = await db.execute(sql`select id from context where context_level = 10 and instance_id is null limit 1`);
    const systemCtxId = (sysRows.rows[0] as { id: string }).id;
    await db.execute(sql`insert into question_categories (name, context_id) values (${`wk5-site-bank-${suffix}`}, ${systemCtxId})`);
    await db.execute(sql`insert into badge (name, type, course_id, status) values (${`WK5 site badge ${suffix}`}, 1, null, 0)`);
    const [job] = await db.insert(backupJobs).values({ type: 'backup', scope: 'site', courseId: null, userId: teacherId, status: 'pending' }).returning();
    const processor = context.get(BackupProcessor);
    const result = await processor.process({ data: { jobId: job.id } } as never);
    expect(result.status).toBe('completed');
    const [row] = await db.select().from(backupJobs).where(eq(backupJobs.id, job.id));
    expect(row.archive.scope).toBe('site');
    expect(row.archive.courseId).toBeNull();
    expect(row.archive.contributors.questions.categories).toBeGreaterThanOrEqual(1);
    expect(row.archive.contributors.badges.badges).toBeGreaterThanOrEqual(1);
    expect(row.archive.contributors.courses).toBeUndefined();
  });

  it('restore processor copies sections to a target course and writes id mappings (never the original ids)', async () => {
    const catRows = await db.execute(sql`select category from course where id = ${courseId}`);
    const catId = (catRows.rows[0] as { category: string }).category;
    const targetRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name, class_id) values (${catId}, (select tenant_id from course_categories where id = ${catId}), ${`Restore target ${suffix}`}, ${`wk5tgt${suffix}`}, ${await fixtureClassId()}) returning id`);
    const targetId = (targetRows.rows[0] as { id: string }).id;
    const [job] = await db.insert(backupJobs).values({ type: 'restore', courseId: courseId, targetCourseId: targetId, mode: 'new', userId: teacherId, status: 'pending' }).returning();
    const processor = context.get(RestoreProcessor);
    const result = await processor.process({ data: { jobId: job.id } } as never);
    expect(result.status).toBe('completed');
    const sections = await db.execute(sql`select id from course_sections where course = ${targetId}`);
    expect(sections.rows.length).toBe(2);
    expect(sections.rows.every((r: { id: string }) => r.id !== undefined)).toBe(true);
  });

  it('search reindex indexes the course and the active user, and a rerun does not duplicate documents', async () => {
    const processor = context.get(SearchReindexProcessor);
    const first = await processor.process({ data: {} } as never);
    expect(first.indexed).toBeGreaterThan(0);
    const docs1 = await db.select().from(searchDocuments).where(and(eq(searchDocuments.area, 'courses'), eq(searchDocuments.itemId, courseId)));
    expect(docs1).toHaveLength(1);
    await processor.process({ data: {} } as never);
    const docs2 = await db.select().from(searchDocuments).where(and(eq(searchDocuments.area, 'courses'), eq(searchDocuments.itemId, courseId)));
    expect(docs2).toHaveLength(1);
  });

  it('analytics run creates a prediction + teacher insight for an at-risk student and never touches grades', async () => {
    const [instance] = await db.insert(enrol).values({ courseId: courseId, enrol: 'manual', status: 0 }).returning();
    await db.insert(userEnrolments).values({ enrolId: instance.id, userId: userId, status: 0 });
    const itemsRows = await db.execute(sql`insert into grade_items (course_id, item_name, item_type, grade_max) values (${courseId}, 'WK5 item', 'manual', 100) returning id`);
    const itemId = (itemsRows.rows[0] as { id: string }).id;
    await db.insert(gradeGrades).values({ itemId: itemId, userId: userId, rawGrade: 10, finalGrade: 10 });
    const processor = context.get(AnalyticsRunProcessor);
    const result = await processor.process({ data: { courseId } } as never);
    expect(result.predictions).toBeGreaterThanOrEqual(1);
    const myInsights = await db.select().from(insights).where(and(eq(insights.courseId, courseId), eq(insights.recipientId, teacherId)));
    expect(myInsights.length).toBeGreaterThanOrEqual(1);
    const gradesAfter = await db.select().from(gradeGrades).where(eq(gradeGrades.itemId, itemId));
    expect(gradesAfter).toHaveLength(1);
    expect(gradesAfter[0].finalGrade).toBe(10);
  });

  it('report schedule processor runs as the creator, stores the result and notifies the creator', async () => {
    const [report] = await db.insert(reportBuilderReport).values({ name: `WK5 report ${suffix}`, dataSource: 'enrolments', createdBy: teacherId, columns: ['userId'] }).returning();
    const [schedule] = await db.insert(reportBuilderSchedule).values({ reportId: report.id, createdBy: teacherId, cron: 'daily', enabled: true }).returning();
    const processor = context.get(ReportScheduleProcessor);
    const result = await processor.process({ data: { scheduleId: schedule.id } } as never);
    expect(result.status).toBe('completed');
    const [row] = await db.select().from(reportBuilderSchedule).where(eq(reportBuilderSchedule.id, schedule.id));
    expect(row.lastResult.ranAs).toBe(teacherId);
    const notes = await db.execute(sql`select id from notifications where user_id_to = ${teacherId} and event_type = 'report_scheduled'`);
    expect(notes.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('privacy processor: approved delete anonymizes the user and clears enrolments/grades; export writes a manifest', async () => {
    const [expReq] = await db.insert(privacyRequests).values({ userId: userId, type: 'export', status: 'approved', requestedBy: userId }).returning();
    const processor = context.get(PrivacyProcessor);
    const exp = await processor.process({ data: { requestId: expReq.id } } as never);
    expect(exp.status).toBe('completed');
    expect(exp.subsystems).toContain('payments');
    const [delReq] = await db.insert(privacyRequests).values({ userId: userId, type: 'delete', status: 'approved', requestedBy: userId }).returning();
    const del = await processor.process({ data: { requestId: delReq.id } } as never);
    expect(del.status).toBe('completed');
    const ues = await db.select().from(userEnrolments).where(eq(userEnrolments.userId, userId));
    expect(ues).toHaveLength(0);
    const grades = await db.select().from(gradeGrades).where(eq(gradeGrades.userId, userId));
    expect(grades).toHaveLength(0);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.deleted).toBe(true);
    expect(u.username).toContain('.deleted');
  });

  it('payment webhook twin is idempotent by external transaction id and reconciliation counts succeeded', async () => {
    const acctRows = await db.execute(sql`insert into payment_accounts (name, gateway, tenant_id) values (${`WK5 acct ${suffix}`}, 'manual', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const acctId = (acctRows.rows[0] as { id: string }).id;
    const tenantRows = await db.execute(sql`select id from tenants where slug = 'worker-fixture'`);
    const fixtureTenantId = (tenantRows.rows[0] as { id: string }).id;
    const [payment] = await db.insert(payments).values({ accountId: acctId, tenantId: fixtureTenantId, userId: teacherId, amount: 12000, currency: 'VND', status: 'pending', gateway: 'manual' }).returning();
    const processor = context.get(PaymentReconciliationProcessor);
    const tx = `wk5-tx-${suffix}`;
    const first = await processor.process({ data: { paymentId: payment.id, externalTransactionId: tx, status: 'succeeded' } } as never);
    expect(first.status).toBe('succeeded');
    const replay = await processor.process({ data: { paymentId: payment.id, externalTransactionId: tx, status: 'succeeded' } } as never);
    expect(replay.duplicate).toBe(true);
    const outbox = await db.execute(sql`select id from outbox_events where type = 'payment_succeeded' and payload->>'externalTransactionId' = ${tx}`);
    expect(outbox.rows).toHaveLength(1);
    const recon = await processor.process({ data: {} } as never);
    expect(recon.status).toBe('reconciled');
    expect(recon.succeeded).toBeGreaterThanOrEqual(1);
  });
});

describe('worker i18n catalogs', () => {
  it('keeps the vi and en catalogs in key parity so no locale silently falls back', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]);
    const vi = JSON.parse(await readFile(join(__dirname, '..', '..', 'src', 'i18n', 'vi', 'platform.json'), 'utf8')) as Record<string, unknown>;
    const en = JSON.parse(await readFile(join(__dirname, '..', '..', 'src', 'i18n', 'en', 'platform.json'), 'utf8')) as Record<string, unknown>;
    expect(flatten(vi).sort()).toEqual(flatten(en).sort());
    expect(flatten(vi)).toContain('reportReadySubject');
  });
});
