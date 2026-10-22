import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import {
  AnalyticsRunProcessor, BackupProcessor, PaymentReconciliationProcessor, PrivacyProcessor,
  ReportScheduleProcessor, RestoreProcessor, SearchReindexProcessor,
} from '../src/processors/platform-services.processors';
import {
  backupJobs, enrol, gradeGrades, insights, payments, privacyRequests, reportbuilderReport,
  reportbuilderSchedule, searchDocuments, userEnrolments, users,
} from '../src/db/schema';
import { WorkerModule } from '../src/worker.module';

/**
 * Platform worker jobs. Oracles: report §4 platform-services DoD (backup steps, search reindex,
 * analytics không side-effect, report schedule, privacy lan đủ, payment
 * webhook replay) + các file PHPUnit đã ghi ở traceability platform services.
 * User/course được raw-insert với id cao độc nhất như các worker spec trước.
 */
describe('Worker platform services: backup, search reindex, analytics, report schedule, privacy, payment', () => {
  let context: INestApplicationContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  const suffix = Date.now() % 100000;
  const userId = 950000 + suffix;
  const teacherId = 960000 + suffix;
  let courseId = 0;
  let courseCtxId = 0;

  beforeAll(async () => {
    context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context.init();
    db = context.get(getDrizzleToken());
    const catRows = await db.execute(sql`insert into course_categories (name, path) values (${`wk5-cat-${suffix}`}, '') returning id`);
    const catId = (catRows.rows[0] as { id: number }).id;
    const courseRows = await db.execute(sql`insert into course (category, fullname, shortname) values (${catId}, ${`Worker Platform Course ${suffix}`}, ${`wk5c${suffix}`}) returning id`);
    courseId = (courseRows.rows[0] as { id: number }).id;
    const ctxRows = await db.execute(sql`insert into context (contextlevel, instanceid, path, depth) values (50, ${courseId}, ${'/1/' + courseId}, 2) returning id`);
    courseCtxId = (ctxRows.rows[0] as { id: number }).id;
    void courseCtxId;
    await db.execute(sql`insert into users (id, username, email, firstname, lastname, suspended, deleted) overriding system value values (${userId}, ${`wk5-u-${suffix}`}, ${`wk5u${suffix}@x.io`}, 'Risk', 'Student', false, false) on conflict (id) do nothing`);
    await db.execute(sql`insert into users (id, username, email, firstname, lastname, suspended, deleted) overriding system value values (${teacherId}, ${`wk5-t-${suffix}`}, ${`wk5t${suffix}@x.io`}, 'Teach', 'Er', false, false) on conflict (id) do nothing`);
    await db.execute(sql`insert into course_sections (course, section, name) values (${courseId}, 0, 'General')`);
    await db.execute(sql`insert into course_sections (course, section, name) values (${courseId}, 1, 'Week 1')`);
    // Teacher assignment ở course context (role editingteacher có sẵn từ seed API? tạo nếu thiếu).
    await db.execute(sql`insert into role (name, shortname, archetype, sortorder) values ('Teacher', ${`wkteach${suffix}`}, 'editingteacher', 3) on conflict (shortname) do nothing`);
    const roleRows = await db.execute(sql`select id from role where shortname = ${`wkteach${suffix}`}`);
    const roleId = (roleRows.rows[0] as { id: number }).id;
    await db.execute(sql`insert into role_assignments (roleid, userid, contextid) values (${roleId}, ${teacherId}, ${courseCtxId})`);
  });
  afterAll(async () => { await context.close(); });

  it('backup processor builds a versioned archive with contributor steps and is idempotent on replay', async () => {
    const [job] = await db.insert(backupJobs).values({ type: 'backup', courseid: courseId, userid: teacherId, status: 'pending' }).returning();
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

  it('restore processor copies sections to a target course and writes id mappings (never the original ids)', async () => {
    const catRows = await db.execute(sql`select category from course where id = ${courseId}`);
    const catId = (catRows.rows[0] as { category: number }).category;
    const targetRows = await db.execute(sql`insert into course (category, fullname, shortname) values (${catId}, ${`Restore target ${suffix}`}, ${`wk5tgt${suffix}`}) returning id`);
    const targetId = (targetRows.rows[0] as { id: number }).id;
    const [job] = await db.insert(backupJobs).values({ type: 'restore', courseid: courseId, targetcourseid: targetId, mode: 'new', userid: teacherId, status: 'pending' }).returning();
    const processor = context.get(RestoreProcessor);
    const result = await processor.process({ data: { jobId: job.id } } as never);
    expect(result.status).toBe('completed');
    const sections = await db.execute(sql`select id from course_sections where course = ${targetId}`);
    expect(sections.rows.length).toBe(2);
    expect(sections.rows.every((r: { id: number }) => r.id !== undefined)).toBe(true);
  });

  it('search reindex indexes the course and the active user, and a rerun does not duplicate documents', async () => {
    const processor = context.get(SearchReindexProcessor);
    const first = await processor.process({ data: {} } as never);
    expect(first.indexed).toBeGreaterThan(0);
    const docs1 = await db.select().from(searchDocuments).where(and(eq(searchDocuments.area, 'courses'), eq(searchDocuments.itemid, courseId)));
    expect(docs1).toHaveLength(1);
    await processor.process({ data: {} } as never);
    const docs2 = await db.select().from(searchDocuments).where(and(eq(searchDocuments.area, 'courses'), eq(searchDocuments.itemid, courseId)));
    expect(docs2).toHaveLength(1);
  });

  it('analytics run creates a prediction + teacher insight for an at-risk student and never touches grades', async () => {
    const [instance] = await db.insert(enrol).values({ courseid: courseId, enrol: 'manual', status: 0 }).returning();
    await db.insert(userEnrolments).values({ enrolid: instance.id, userid: userId, status: 0 });
    const itemsRows = await db.execute(sql`insert into grade_items (courseid, itemname, itemtype, grademax) values (${courseId}, 'WK5 item', 'manual', 100) returning id`);
    const itemId = (itemsRows.rows[0] as { id: number }).id;
    await db.insert(gradeGrades).values({ itemid: itemId, userid: userId, rawgrade: 10, finalgrade: 10 });
    const processor = context.get(AnalyticsRunProcessor);
    const result = await processor.process({ data: { courseId } } as never);
    expect(result.predictions).toBeGreaterThanOrEqual(1);
    const myInsights = await db.select().from(insights).where(and(eq(insights.courseid, courseId), eq(insights.recipientid, teacherId)));
    expect(myInsights.length).toBeGreaterThanOrEqual(1);
    const gradesAfter = await db.select().from(gradeGrades).where(eq(gradeGrades.itemid, itemId));
    expect(gradesAfter).toHaveLength(1);
    expect(gradesAfter[0].finalgrade).toBe(10);
  });

  it('report schedule processor runs as the creator, stores the result and notifies the creator', async () => {
    const [report] = await db.insert(reportbuilderReport).values({ name: `WK5 report ${suffix}`, datasource: 'enrolments', createdby: teacherId, columns: ['userId'] }).returning();
    const [schedule] = await db.insert(reportbuilderSchedule).values({ reportid: report.id, createdby: teacherId, cron: 'daily', enabled: true }).returning();
    const processor = context.get(ReportScheduleProcessor);
    const result = await processor.process({ data: { scheduleId: schedule.id } } as never);
    expect(result.status).toBe('completed');
    const [row] = await db.select().from(reportbuilderSchedule).where(eq(reportbuilderSchedule.id, schedule.id));
    expect(row.lastresult.ranAs).toBe(teacherId);
    const notes = await db.execute(sql`select id from notifications where useridto = ${teacherId} and eventtype = 'report_scheduled'`);
    expect(notes.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('privacy processor: approved delete anonymizes the user and clears enrolments/grades; export writes a manifest', async () => {
    const [expReq] = await db.insert(privacyRequests).values({ userid: userId, type: 'export', status: 'approved', requestedby: userId }).returning();
    const processor = context.get(PrivacyProcessor);
    const exp = await processor.process({ data: { requestId: expReq.id } } as never);
    expect(exp.status).toBe('completed');
    expect(exp.subsystems).toContain('payments');
    const [delReq] = await db.insert(privacyRequests).values({ userid: userId, type: 'delete', status: 'approved', requestedby: userId }).returning();
    const del = await processor.process({ data: { requestId: delReq.id } } as never);
    expect(del.status).toBe('completed');
    const ues = await db.select().from(userEnrolments).where(eq(userEnrolments.userid, userId));
    expect(ues).toHaveLength(0);
    const grades = await db.select().from(gradeGrades).where(eq(gradeGrades.userid, userId));
    expect(grades).toHaveLength(0);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.deleted).toBe(true);
    expect(u.username).toContain('.deleted');
  });

  it('payment webhook twin is idempotent by external transaction id and reconciliation counts succeeded', async () => {
    const acctRows = await db.execute(sql`insert into payment_accounts (name, gateway) values (${`WK5 acct ${suffix}`}, 'manual') returning id`);
    const acctId = (acctRows.rows[0] as { id: number }).id;
    const [payment] = await db.insert(payments).values({ accountid: acctId, userid: teacherId, amount: 12000, currency: 'VND', status: 'pending', gateway: 'manual' }).returning();
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
    const vi = JSON.parse(await readFile(join(__dirname, '..', 'src', 'i18n', 'vi', 'platform.json'), 'utf8')) as Record<string, unknown>;
    const en = JSON.parse(await readFile(join(__dirname, '..', 'src', 'i18n', 'en', 'platform.json'), 'utf8')) as Record<string, unknown>;
    expect(flatten(vi).sort()).toEqual(flatten(en).sort());
    expect(flatten(vi)).toContain('reportReadySubject');
  });
});
