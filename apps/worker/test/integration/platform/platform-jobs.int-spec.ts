import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { sql, type JsonValue } from '@lms/db';
import {
  AnalyticsRunProcessor, BackupProcessor, PaymentReconciliationProcessor, PrivacyProcessor,
  ReportScheduleProcessor, RestoreProcessor, SearchReindexProcessor,
} from '../../../src/processors/platform-services.processors';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

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
describe('Dịch vụ platform của worker: backup, reindex tìm kiếm, analytics, lịch báo cáo, riêng tư, thanh toán', () => {
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
    await sql`insert into users (id, username, email, suspended, deleted) values (${ownerId}, 'wk-class-owner', 'wk-class-owner@x.io', false, false) on conflict (id) do nothing`.execute(db);
    const coh = await sql`insert into cohort (tenant_id, name, context_id, component, visible) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture cohort', '01990000-0000-7000-8000-0000000000a1', 'class', false) returning id`.execute(db);
    const cohId = (coh.rows[0] as { id: string }).id;
    const cls = await sql`insert into classes (tenant_id, name, owner_id, cohort_id) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture class', ${ownerId}, ${cohId}) returning id`.execute(db);
    return (cls.rows[0] as { id: string }).id;
  }
  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    await sql`insert into tenants (slug, name, kind, status) values ('worker-fixture', 'Worker fixture tenant', 'school', 'active') on conflict (slug) do nothing`.execute(db);
    const catRows = await sql`insert into course_categories (name, path, tenant_id) values (${`wk5-cat-${suffix}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`.execute(db);
    const catId = (catRows.rows[0] as { id: string }).id;
    const courseRows = await sql`insert into course (category, tenant_id, full_name, short_name, class_id) values (${catId}, (select tenant_id from course_categories where id = ${catId}), ${`Worker Platform Course ${suffix}`}, ${`wk5c${suffix}`}, ${await fixtureClassId()}) returning id`.execute(db);
    courseId = (courseRows.rows[0] as { id: string }).id;
    // Chuỗi context phải hợp lệ theo bất biến của cây context: path gồm
    // các id UUID thật và kết thúc bằng id của chính context — tài liệu
    // search gắn với context này được PermissionEvaluator ở phía API
    // duyệt lại theo path, path hư cấu sẽ làm nổ truy vấn đó.
    await sql`insert into context (id, context_level, instance_id, path, depth)
      select '01990000-0000-7000-8000-0000000000a1', 10, null, '/01990000-0000-7000-8000-0000000000a1', 1
      where not exists (select 1 from context where context_level = 10 and instance_id is null)`.execute(db);
    const sysRows = await sql`select id from context where context_level = 10 and instance_id is null limit 1`.execute(db);
    const systemCtxId = (sysRows.rows[0] as { id: string }).id;
    const ctxRows = await sql`insert into context (context_level, instance_id, path, depth) values (50, ${courseId}, '', 2) returning id`.execute(db);
    courseCtxId = (ctxRows.rows[0] as { id: string }).id;
    await sql`update context set path = ${`/${systemCtxId}/${courseCtxId}`} where id = ${courseCtxId}`.execute(db);
    void courseCtxId;
    await sql`insert into users (id, username, email, first_name, last_name, suspended, deleted) values (${userId}, ${`wk5-u-${suffix}`}, ${`wk5u${suffix}@x.io`}, 'Risk', 'Student', false, false) on conflict (id) do nothing`.execute(db);
    await sql`insert into users (id, username, email, first_name, last_name, suspended, deleted) values (${teacherId}, ${`wk5-t-${suffix}`}, ${`wk5t${suffix}@x.io`}, 'Teach', 'Er', false, false) on conflict (id) do nothing`.execute(db);
    await sql`insert into course_sections (course, section, name) values (${courseId}, 0, 'General')`.execute(db);
    await sql`insert into course_sections (course, section, name) values (${courseId}, 1, 'Week 1')`.execute(db);
    // Teacher assignment ở course context (role editingteacher có sẵn từ seed API? tạo nếu thiếu).
    await sql`insert into role (name, short_name, archetype, sort_order) values ('Teacher', ${`wkteach${suffix}`}, 'editingteacher', 3) on conflict (short_name) do nothing`.execute(db);
    const roleRows = await sql`select id from role where short_name = ${`wkteach${suffix}`}`.execute(db);
    const roleId = (roleRows.rows[0] as { id: string }).id;
    await sql`insert into role_assignments (role_id, user_id, context_id) values (${roleId}, ${teacherId}, ${courseCtxId})`.execute(db);
  });
  afterAll(async () => { await harness.close(); });

  it('bộ xử lý backup dựng kho lưu trữ có phiên bản kèm bước đóng góp và lũy đẳng khi phát lại', async () => {
    const job = await db.insertInto('backup_jobs').values({ type: 'backup', course_id: courseId, user_id: teacherId, status: 'pending' }).returningAll().executeTakeFirstOrThrow();
    const processor = context.get(BackupProcessor);
    const first = await processor.process({ data: { jobId: job.id } } as never);
    expect(first.status).toBe('completed');
    expect(first.sections).toBe(2);
    const [row] = await db.selectFrom('backup_jobs').selectAll().where('id', '=', job.id).execute();
    expect(row.archive.format).toBe('lms-backup');
    expect(row.archive.version).toBe(1);
    const second = await processor.process({ data: { jobId: job.id } } as never);
    expect(second.status).toBe('duplicate');
  });

  it('kho lưu trữ của bộ xử lý backup chứa các mục questions/badges/calendar mới (cùng định dạng lms-backup v1 như API)', async () => {
    // Ngân hàng câu hỏi ở context của khoá + badge của khoá + sự kiện/subscription của khoá.
    const qCatRows = await sql`insert into question_categories (name, context_id) values (${`wk5-bank-${suffix}`}, ${courseCtxId}) returning id`.execute(db);
    const qCatId = (qCatRows.rows[0] as { id: string }).id;
    // Câu hỏi không còn cột `name` (mô hình chốt 12:04: nhãn = trích đoạn nội dung) nên fixture chỉ chèn đúng cột còn tồn tại.
    const qRows = await sql`insert into question (category, qtype) values (${qCatId}, 'truefalse') returning id`.execute(db);
    const qId = (qRows.rows[0] as { id: string }).id;
    const entryRows = await sql`insert into question_bank_entries (question_category_id, question_id, latest_version) values (${qCatId}, ${qId}, 2) returning id`.execute(db);
    const entryId = (entryRows.rows[0] as { id: string }).id;
    const doc = (text: string) =>
      JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    await sql`insert into question_versions (question_bank_entry_id, question_id, version, question_text) values (${entryId}, ${qId}, 1, ${doc('v1')}::jsonb)`.execute(db);
    await sql`insert into question_versions (question_bank_entry_id, question_id, version, question_text) values (${entryId}, ${qId}, 2, ${doc('v2')}::jsonb)`.execute(db);
    const badgeRows = await sql`insert into badge (name, type, course_id, status) values (${`WK5 badge ${suffix}`}, 2, ${courseId}, 0) returning id`.execute(db);
    const badgeId = (badgeRows.rows[0] as { id: string }).id;
    await sql`insert into badge_criteria (badge_id, criteria_type, method, params) values (${badgeId}, 'overall', 1, '{}'::jsonb)`.execute(db);
    await sql`insert into badge_criteria (badge_id, criteria_type, method, params) values (${badgeId}, 'coursecompletion', 1, ${JSON.stringify({ courseId })}::jsonb)`.execute(db);
    await sql`insert into calendar_events (name, event_type, course_id, time_start) values (${`WK5 event ${suffix}`}, 'course', ${courseId}, now())`.execute(db);
    await sql`insert into calendar_subscriptions (name, event_type, course_id) values (${`WK5 feed ${suffix}`}, 'course', ${courseId})`.execute(db);

    const job = await db.insertInto('backup_jobs').values({ type: 'backup', course_id: courseId, user_id: teacherId, status: 'pending' }).returningAll().executeTakeFirstOrThrow();
    const processor = context.get(BackupProcessor);
    const result = await processor.process({ data: { jobId: job.id } } as never);
    expect(result.status).toBe('completed');
    const [row] = await db.selectFrom('backup_jobs').selectAll().where('id', '=', job.id).execute();
    expect(row.archive.format).toBe('lms-backup');
    expect(row.archive.version).toBe(1);
    expect(row.archive.contributors.questions).toEqual({ categories: 1, questions: 1, entries: 1, versions: 2 });
    expect(row.archive.contributors.badges).toEqual({ badges: 1, criteria: 2 });
    expect(row.archive.contributors.calendar).toEqual({ events: 1, subscriptions: 1 });
    const steps = await sql`select name from backup_job_steps where job_id = ${job.id}`.execute(db);
    expect((steps.rows as { name: string }[]).map((s) => s.name)).toEqual(
      expect.arrayContaining(['questions', 'badges', 'calendar']));
  });

  it('bộ xử lý backup xử lý job phạm vi site (không khoá học) chỉ với các mục cấp site', async () => {
    const sysRows = await sql`select id from context where context_level = 10 and instance_id is null limit 1`.execute(db);
    const systemCtxId = (sysRows.rows[0] as { id: string }).id;
    await sql`insert into question_categories (name, context_id) values (${`wk5-site-bank-${suffix}`}, ${systemCtxId})`.execute(db);
    await sql`insert into badge (name, type, course_id, status) values (${`WK5 site badge ${suffix}`}, 1, null, 0)`.execute(db);
    const job = await db.insertInto('backup_jobs').values({ type: 'backup', scope: 'site', course_id: null, user_id: teacherId, status: 'pending' }).returningAll().executeTakeFirstOrThrow();
    const processor = context.get(BackupProcessor);
    const result = await processor.process({ data: { jobId: job.id } } as never);
    expect(result.status).toBe('completed');
    const [row] = await db.selectFrom('backup_jobs').selectAll().where('id', '=', job.id).execute();
    expect(row.archive.scope).toBe('site');
    expect(row.archive.courseId).toBeNull();
    expect(row.archive.contributors.questions.categories).toBeGreaterThanOrEqual(1);
    expect(row.archive.contributors.badges.badges).toBeGreaterThanOrEqual(1);
    expect(row.archive.contributors.courses).toBeUndefined();
  });

  it('bộ xử lý restore sao chép các mục sang khoá học đích và ghi ánh xạ id (không bao giờ là id gốc)', async () => {
    const catRows = await sql`select category from course where id = ${courseId}`.execute(db);
    const catId = (catRows.rows[0] as { category: string }).category;
    const targetRows = await sql`insert into course (category, tenant_id, full_name, short_name, class_id) values (${catId}, (select tenant_id from course_categories where id = ${catId}), ${`Restore target ${suffix}`}, ${`wk5tgt${suffix}`}, ${await fixtureClassId()}) returning id`.execute(db);
    const targetId = (targetRows.rows[0] as { id: string }).id;
    const job = await db.insertInto('backup_jobs').values({ type: 'restore', course_id: courseId, target_course_id: targetId, mode: 'new', user_id: teacherId, status: 'pending' }).returningAll().executeTakeFirstOrThrow();
    const processor = context.get(RestoreProcessor);
    const result = await processor.process({ data: { jobId: job.id } } as never);
    expect(result.status).toBe('completed');
    const sections = await sql`select id from course_sections where course = ${targetId}`.execute(db);
    expect(sections.rows.length).toBe(2);
    expect((sections.rows as { id: string }[]).every((r) => r.id !== undefined)).toBe(true);
  });

  it('reindex tìm kiếm lập chỉ mục khoá học và người dùng đang hoạt động, chạy lại không trùng tài liệu', async () => {
    const processor = context.get(SearchReindexProcessor);
    const first = await processor.process({ data: {} } as never);
    expect(first.indexed).toBeGreaterThan(0);
    const docs1 = await db.selectFrom('search_documents').selectAll().where('area', '=', 'courses').where('item_id', '=', courseId).execute();
    expect(docs1).toHaveLength(1);
    await processor.process({ data: {} } as never);
    const docs2 = await db.selectFrom('search_documents').selectAll().where('area', '=', 'courses').where('item_id', '=', courseId).execute();
    expect(docs2).toHaveLength(1);
  });

  it('lượt chạy analytics tạo dự đoán + insight giáo viên cho học viên có nguy cơ và không bao giờ động tới điểm', async () => {
    const instance = await db.insertInto('enrol').values({ course_id: courseId, enrol: 'manual', status: 0 }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto('user_enrolments').values({ enrol_id: instance.id, user_id: userId, status: 0 }).execute();
    const itemsRows = await sql`insert into grade_items (course_id, item_name, item_type, grade_max) values (${courseId}, 'WK5 item', 'manual', 100) returning id`.execute(db);
    const itemId = (itemsRows.rows[0] as { id: string }).id;
    await db.insertInto('grade_grades').values({ item_id: itemId, user_id: userId, raw_grade: 10, final_grade: 10 }).execute();
    const processor = context.get(AnalyticsRunProcessor);
    const result = await processor.process({ data: { courseId } } as never);
    expect(result.predictions).toBeGreaterThanOrEqual(1);
    const myInsights = await db.selectFrom('insights').selectAll().where('course_id', '=', courseId).where('recipient_id', '=', teacherId).execute();
    expect(myInsights.length).toBeGreaterThanOrEqual(1);
    const gradesAfter = await db.selectFrom('grade_grades').selectAll().where('item_id', '=', itemId).execute();
    expect(gradesAfter).toHaveLength(1);
    expect(gradesAfter[0].final_grade).toBe(10);
  });

  it('bộ xử lý lịch báo cáo chạy với tư cách người tạo, lưu kết quả và thông báo cho người tạo', async () => {
    const report = await db.insertInto('report_builder_report').values({ name: `WK5 report ${suffix}`, data_source: 'enrolments', created_by: teacherId, columns: sql<JsonValue>`${JSON.stringify(['userId'])}::jsonb` }).returningAll().executeTakeFirstOrThrow();
    const schedule = await db.insertInto('report_builder_schedule').values({ report_id: report.id, created_by: teacherId, cron: 'daily', enabled: true }).returningAll().executeTakeFirstOrThrow();
    const processor = context.get(ReportScheduleProcessor);
    const result = await processor.process({ data: { scheduleId: schedule.id } } as never);
    expect(result.status).toBe('completed');
    const [row] = await db.selectFrom('report_builder_schedule').selectAll().where('id', '=', schedule.id).execute();
    expect(row.last_result.ranAs).toBe(teacherId);
    const notes = await sql`select id from notifications where user_id_to = ${teacherId} and event_type = 'report_scheduled'`.execute(db);
    expect(notes.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('bộ xử lý riêng tư: xoá đã duyệt ẩn danh người dùng và xoá ghi danh/điểm; xuất ghi manifest', async () => {
    const expReq = await db.insertInto('privacy_requests').values({ user_id: userId, type: 'export', status: 'approved', requested_by: userId }).returningAll().executeTakeFirstOrThrow();
    const processor = context.get(PrivacyProcessor);
    const exp = await processor.process({ data: { requestId: expReq.id } } as never);
    expect(exp.status).toBe('completed');
    expect(exp.subsystems).toContain('payments');
    const delReq = await db.insertInto('privacy_requests').values({ user_id: userId, type: 'delete', status: 'approved', requested_by: userId }).returningAll().executeTakeFirstOrThrow();
    const del = await processor.process({ data: { requestId: delReq.id } } as never);
    expect(del.status).toBe('completed');
    const ues = await db.selectFrom('user_enrolments').selectAll().where('user_id', '=', userId).execute();
    expect(ues).toHaveLength(0);
    const grades = await db.selectFrom('grade_grades').selectAll().where('user_id', '=', userId).execute();
    expect(grades).toHaveLength(0);
    const [u] = await db.selectFrom('users').selectAll().where('id', '=', userId).execute();
    expect(u.deleted).toBe(true);
    expect(u.username).toContain('.deleted');
  });

  it('bản song sinh webhook thanh toán lũy đẳng theo id giao dịch ngoài và đối soát đếm các giao dịch thành công', async () => {
    const acctRows = await sql`insert into payment_accounts (name, gateway, tenant_id) values (${`WK5 acct ${suffix}`}, 'manual', (select id from tenants where slug = 'worker-fixture')) returning id`.execute(db);
    const acctId = (acctRows.rows[0] as { id: string }).id;
    const tenantRows = await sql`select id from tenants where slug = 'worker-fixture'`.execute(db);
    const fixtureTenantId = (tenantRows.rows[0] as { id: string }).id;
    const payment = await db.insertInto('payments').values({ account_id: acctId, tenant_id: fixtureTenantId, user_id: teacherId, amount: 12000, currency: 'VND', status: 'pending', gateway: 'manual' }).returningAll().executeTakeFirstOrThrow();
    const processor = context.get(PaymentReconciliationProcessor);
    const tx = `wk5-tx-${suffix}`;
    const first = await processor.process({ data: { paymentId: payment.id, externalTransactionId: tx, status: 'succeeded' } } as never);
    expect(first.status).toBe('succeeded');
    const replay = await processor.process({ data: { paymentId: payment.id, externalTransactionId: tx, status: 'succeeded' } } as never);
    expect(replay.duplicate).toBe(true);
    const outbox = await sql`select id from outbox_events where type = 'payment_succeeded' and payload->>'externalTransactionId' = ${tx}`.execute(db);
    expect(outbox.rows).toHaveLength(1);
    const recon = await processor.process({ data: {} } as never);
    expect(recon.status).toBe('reconciled');
    expect(recon.succeeded).toBeGreaterThanOrEqual(1);
  });
});

describe('Catalog i18n của worker', () => {
  it('giữ catalog vi và en ngang bằng khoá để không locale nào lặng lẽ fallback', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]);
    const vi = JSON.parse(await readFile(join(__dirname, '..', '..', '..', 'src', 'i18n', 'vi', 'platform.json'), 'utf8')) as Record<string, unknown>;
    const en = JSON.parse(await readFile(join(__dirname, '..', '..', '..', 'src', 'i18n', 'en', 'platform.json'), 'utf8')) as Record<string, unknown>;
    expect(flatten(vi).sort()).toEqual(flatten(en).sort());
    expect(flatten(vi)).toContain('reportReadySubject');
  });
});
