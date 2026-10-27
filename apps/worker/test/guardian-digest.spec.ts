import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { GuardianDigestProcessor } from '../src/processors/guardian-digest.processor';
import { guardianDigests, outboxEvents, userPreferences } from '@lms/db-schema';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from './ordinary-worker-module';

/**
 * PH-2 (issue #159) — phía phát hiện ở worker: lượt quét guardian-digests
 * chốt lượt digest định kỳ (cửa sổ tuần/ngày đã đóng, theo tần suất của
 * phụ huynh cho từng con, mặc định weekly) và lượt đẩy riêng quá hạn ≥7
 * ngày, mỗi lượt đúng MỘT lần nhờ dedupe_key unique của guardian_digests;
 * chỉ lượt thật sự mới chốt mới sinh sự kiện outbox cho consumer phía
 * API. Nửa API (sự kiện → tổng hợp đã công bố → thông báo) được kiểm
 * chứng ở apps/api/test/guardian-ph2-digest-flow.e2e-spec.ts bằng đúng
 * hình dạng sự kiện phát ở đây.
 *
 * Từ lát 2 của issue #294, spec này boot WorkerModule qua harness
 * role thường (`test/ordinary-worker-module.ts`): module chạy bằng
 * role NOSUPERUSER/NOBYPASSRLS như production, fixture và đọc kiểm
 * chứng đi qua kết nối quản trị của harness — khẳng định nghiệp vụ
 * của spec không đổi.
 */
describe('Worker guardian digest sweep (PH-2, issue #159)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: any;
  let processor: GuardianDigestProcessor;
  let fixtureTenantId = '';
  const suffix = Date.now();
  const DAY = 24 * 3600_000;

  const uid = (n: number) => `01900000-0000-7000-8000-${String(920000 + n * 41 + (suffix % 997)).padStart(12, '0')}`;

  async function makeUser(id: string) {
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${id}, ${`ph2-${id.slice(-6)}-${suffix}`}, ${`ph2-${id.slice(-6)}-${suffix}@x.io`}, false, false) on conflict (id) do nothing`);
  }

  async function makeLink(guardianId: string, studentId: string, createdDaysAgo = 10, status = 'active') {
    // SQL thô: bảng thật còn các cột NOT NULL (relationship, created_by)
    // nằm ngoài view subset của worker.
    const rows = await db.execute(sql`insert into guardian_links (guardian_user_id, student_user_id, relationship, status, created_by, created_at, updated_at, tenant_id) values (${guardianId}, ${studentId}, 'Cha', ${status}, ${guardianId}, ${new Date(Date.now() - createdDaysAgo * DAY)}, now(), (select id from tenants where slug = 'worker-fixture')) returning id`);
    return (rows.rows[0] as { id: string }).id;
  }

  async function setFrequency(guardianId: string, studentId: string, value: string) {
    await db.insert(userPreferences).values({
      userId: guardianId, name: `guardian_digest_frequency:${studentId}`, value,
    });
  }

  async function digestsFor(guardianId: string, studentId: string) {
    return db.select().from(guardianDigests).where(and(
      eq(guardianDigests.guardianUserId, guardianId), eq(guardianDigests.studentUserId, studentId),
    ));
  }

  async function eventsFor(type: string, guardianId: string) {
    const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.type, type));
    return (rows as { payload: { guardianUserId?: string } }[]).filter((e) => e.payload.guardianUserId === guardianId);
  }

  /** Khoá + lần ghim đề có hạn đóng cách đây `closedDaysAgo` ngày + ghi danh cho học sinh. */
  async function makeOverdueQuiz(studentId: string, closedDaysAgo: number) {
    const catRows = await db.execute(sql`insert into course_categories (name, path, tenant_id) values (${`ph2-cat-${suffix}-${Math.random()}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;
    const short = `ph2${suffix}${Math.floor(Math.random() * 1e9)}`;
    const courseRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name, visible, class_id) values (${catId}, (select tenant_id from course_categories where id = ${catId}), 'PH2 course', ${short}, true, ${await fixtureClassId()}) returning id`);
    const courseId = (courseRows.rows[0] as { id: string }).id;
    const secRows = await db.execute(sql`insert into course_sections (course, section) values (${courseId}, 0) returning id`);
    const secId = (secRows.rows[0] as { id: string }).id;
    // Sau gộp Đề (#226): hoạt động quá hạn là LẦN GHIM (exam_pins).
    const cmRows0 = await db.execute(sql`insert into course_modules (course, section, component, visible, deletion_in_progress) values (${courseId}, ${secId}, 'mod_quiz', true, false) returning id`);
    const cmId = (cmRows0.rows[0] as { id: string }).id;
    const tenantRows = await db.execute(sql`insert into tenants (slug, name, kind, status) values ('worker-fixture', 'Worker fixture tenant', 'school', 'active') on conflict (slug) do update set slug = excluded.slug returning id`);
    const tenantId = (tenantRows.rows[0] as { id: string }).id;
    const bankRows = await db.execute(sql`insert into question_banks (name, bank_kind, scope, context_id, created_by, tenant_id) values ('PH2 bank', 'exam', 'personal', ${studentId}, ${studentId}, ${tenantId}) returning id`);
    const bankId = (bankRows.rows[0] as { id: string }).id;
    const examRows = await db.execute(sql`insert into exams (bank_id, created_by, status) values (${bankId}, ${studentId}, 'ready') returning id`);
    const examId = (examRows.rows[0] as { id: string }).id;
    const verRows = await db.execute(sql`insert into exam_versions (exam_id, version, name, created_by) values (${examId}, 1, 'PH2 quiz', ${studentId}) returning id`);
    const versionId = (verRows.rows[0] as { id: string }).id;
    const pinRows = await db.execute(sql`insert into exam_pins (exam_id, exam_version_id, course_id, cm_id, time_close, variants, created_by) values (${examId}, ${versionId}, ${courseId}, ${cmId}, ${new Date(Date.now() - closedDaysAgo * DAY)}, '[]'::jsonb, ${studentId}) returning id`);
    const quizId = (pinRows.rows[0] as { id: string }).id;
    await db.execute(sql`update course_modules set instance_id = ${quizId} where id = ${cmId}`);
    const instRows = await db.execute(sql`insert into enrol (course_id, enrol, status) values (${courseId}, 'manual', 0) returning id`);
    const instId = (instRows.rows[0] as { id: string }).id;
    await db.execute(sql`insert into user_enrolments (enrol_id, user_id, status, time_start) values (${instId}, ${studentId}, 0, ${new Date(Date.now() - 30 * DAY)})`);
    return { courseId, quizId, cmId };
  }

  async function sweep() {
    return processor.process({} as never);
  }


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
    const tenantRows = await db.execute(sql`select id from tenants where slug = 'worker-fixture'`);
    fixtureTenantId = (tenantRows.rows[0] as { id: string }).id;
    processor = context.get(GuardianDigestProcessor);
  });
  afterAll(async () => { await harness.close(); });

  it('weekly mặc định: chốt đúng 1 digest cho cửa sổ tuần vừa đóng + 1 sự kiện; quét lại không trùng', async () => {
    const guardian = uid(1); const student = uid(2);
    await makeUser(guardian); await makeUser(student);
    await makeLink(guardian, student, 10);

    const result = await sweep();
    const mine = result.queued.filter((q) => q.guardianUserId === guardian);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe('weekly');

    const rows = await digestsFor(guardian, student);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('weekly');
    expect(rows[0].status).toBe('queued');
    // Cửa sổ tuần: [Thứ Hai tuần trước 00:00 UTC, Thứ Hai tuần này 00:00 UTC).
    const end = rows[0].windowEnd as Date;
    const start = rows[0].windowStart as Date;
    expect(end.getTime() - start.getTime()).toBe(7 * DAY);
    expect(end.getUTCDay()).toBe(1);
    expect(end.getTime()).toBeLessThanOrEqual(Date.now());

    const events = await eventsFor('guardian_digest_due', guardian);
    expect(events).toHaveLength(1);

    const again = await sweep();
    expect(again.queued.filter((q) => q.guardianUserId === guardian)).toHaveLength(0);
    expect(await digestsFor(guardian, student)).toHaveLength(1);
    expect(await eventsFor('guardian_digest_due', guardian)).toHaveLength(1);
  });

  it('daily: chốt digest ngày cho cửa sổ hôm qua; đổi tần suất hiệu lực từ cửa sổ kế tiếp', async () => {
    const guardian = uid(3); const student = uid(4);
    await makeUser(guardian); await makeUser(student);
    await makeLink(guardian, student, 10);
    await setFrequency(guardian, student, 'daily');

    const result = await sweep();
    const mine = result.queued.filter((q) => q.guardianUserId === guardian);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe('daily');
    const rows = await digestsFor(guardian, student);
    expect(rows).toHaveLength(1);
    expect((rows[0].windowEnd as Date).getTime() - (rows[0].windowStart as Date).getTime()).toBe(DAY);
  });

  it('off: không digest định kỳ, nhưng đẩy riêng quá hạn ≥7 ngày vẫn chạy đúng 1 lần', async () => {
    const guardian = uid(5); const student = uid(6);
    await makeUser(guardian); await makeUser(student);
    await makeLink(guardian, student, 10);
    await setFrequency(guardian, student, 'off');
    const overdue = await makeOverdueQuiz(student, 9);

    // `off` là tần suất CỦA digest: digest định kỳ tắt hẳn, nhưng đẩy
    // riêng quá hạn là ngoại lệ tách khỏi digest (research điểm chính
    // sách 6) — vẫn chốt đúng 1 lượt + 1 sự kiện cho phụ huynh này.
    const result = await sweep();
    const mine = result.queued.filter((q) => q.guardianUserId === guardian);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe('overdue_alert');
    expect(mine[0]!.dedupeKey).toBe(`overdue:${fixtureTenantId}:${guardian}:${student}:${overdue.cmId}`);

    const rows = await digestsFor(guardian, student);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('overdue_alert');
    expect(await eventsFor('guardian_digest_due', guardian)).toHaveLength(0);
    expect(await eventsFor('guardian_overdue_alert', guardian)).toHaveLength(1);

    const again = await sweep();
    expect(again.queued.filter((q) => q.guardianUserId === guardian)).toHaveLength(0);
    expect(await eventsFor('guardian_overdue_alert', guardian)).toHaveLength(1);
  });

  it('quá hạn ≥7 ngày: đẩy riêng đúng 1 lần; <7 ngày hoặc đã nộp thì không', async () => {
    const guardian = uid(7); const student = uid(8);
    await makeUser(guardian); await makeUser(student);
    await makeLink(guardian, student, 10);
    const overdue = await makeOverdueQuiz(student, 8);
    await makeOverdueQuiz(student, 6); // chưa đủ 7 ngày
    const done = await makeOverdueQuiz(student, 9);
    // Attempt đã hoàn tất cho quiz thứ ba → không còn tính quá hạn chưa nộp.
    const usageRows = await db.execute(sql`insert into question_usages (component, user_id) values ('mod_quiz', ${student}) returning id`);
    const usageId = (usageRows.rows[0] as { id: string }).id;
    await db.execute(sql`insert into exam_attempts (pin_id, user_id, attempt_number, usage_id, state, preview) values (${done.quizId}, ${student}, 1, ${usageId}, 'finished', false)`);

    const result = await sweep();
    const alerts = result.queued.filter((q) => q.guardianUserId === guardian && q.kind === 'overdue_alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.dedupeKey).toBe(`overdue:${fixtureTenantId}:${guardian}:${student}:${overdue.cmId}`);

    const rows = await digestsFor(guardian, student);
    const alertRows = rows.filter((r: { kind: string }) => r.kind === 'overdue_alert');
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].activityCmId).toBe(overdue.cmId);
    expect(await eventsFor('guardian_overdue_alert', guardian)).toHaveLength(1);

    const again = await sweep();
    expect(again.queued.filter((q) => q.guardianUserId === guardian)).toHaveLength(0);
    expect(await eventsFor('guardian_overdue_alert', guardian)).toHaveLength(1);
  });

  it('liên kết đã thu hồi hoặc mới tạo sau cửa sổ: không chốt digest nào', async () => {
    const gRevoked = uid(9); const sRevoked = uid(10);
    await makeUser(gRevoked); await makeUser(sRevoked);
    await makeLink(gRevoked, sRevoked, 10, 'revoked');
    const gFresh = uid(11); const sFresh = uid(12);
    await makeUser(gFresh); await makeUser(sFresh);
    await makeLink(gFresh, sFresh, 0); // tạo hôm nay — sau khi cửa sổ tuần/ngày vừa đóng kết thúc

    const result = await sweep();
    expect(result.queued.filter((q) => q.guardianUserId === gRevoked)).toHaveLength(0);
    expect(result.queued.filter((q) => q.guardianUserId === gFresh)).toHaveLength(0);
    expect(await digestsFor(gRevoked, sRevoked)).toHaveLength(0);
    expect(await digestsFor(gFresh, sFresh)).toHaveLength(0);
  });

  it('hai phụ huynh của cùng một con: mỗi người một lượt riêng', async () => {
    const student = uid(13); const g1 = uid(14); const g2 = uid(15);
    await makeUser(student); await makeUser(g1); await makeUser(g2);
    await makeLink(g1, student, 10);
    await makeLink(g2, student, 10);

    const result = await sweep();
    expect(result.queued.filter((q) => q.guardianUserId === g1)).toHaveLength(1);
    expect(result.queued.filter((q) => q.guardianUserId === g2)).toHaveLength(1);
    expect(await digestsFor(g1, student)).toHaveLength(1);
    expect(await digestsFor(g2, student)).toHaveLength(1);
  });
});
