import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { enrol, notifications, outboxEvents, userEnrolments, userPreferences } from '@lms/db';
import { redisConnectionFromUrl } from '../../../src/config/env';
import { NotificationEventsCatchupService } from '../../../src/notification-events-catchup.service';
import { NotificationEventsMarker } from '../../../src/notification-events-marker.service';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Cơ chế chuyển tiếp một lần của consumer thông báo sự kiện (điểm
 * sửa theo phân xử trên PR #542, issue con #520 của #491): khi
 * consumer polling phía API bị gỡ, các dòng outbox thuộc mười loại
 * sự kiện thông báo có `seq` lớn hơn watermark cuối của consumer cũ
 * nhưng đã bị relay đóng dấu `publishedAt` (vì trước đây relay đóng
 * dấu cả loại chưa định tuyến) sẽ không thành job và không còn ai
 * đọc theo watermark — mất vĩnh viễn nếu không phát bù.
 *
 * Spec này dựng đúng trạng thái chuyển đổi đó và khẳng định:
 *  1. Dòng trên watermark cũ, đã đóng dấu `publishedAt`, được phát
 *     bù thành job và xử lý đúng một lần (đúng một thông báo).
 *  2. Dòng dưới watermark cũ không bị xử lý lại (không thông báo,
 *     không job).
 *  3. Dòng trên watermark đã có dấu đã xử lý theo `outboxId` thì
 *     job phát bù kết luận trùng ở processor và không sinh thông
 *     báo thứ hai.
 *  4. Sau khi rút cạn, khoá watermark cũ bị xoá và lần phát bù sau
 *     là no-op — cơ chế không thành consumer polling thường trực.
 *  5. Hệ mới tinh (không có khoá watermark cũ) thì không phát bù
 *     gì: dòng đã đóng dấu không thành job, không có thông báo.
 */
describe('Worker notification events catch-up (phát bù tồn đọng theo watermark cũ ở #520)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: OrdinaryWorkerModuleHarness['adminDb'];
  let eventsQueue: Queue;
  let catchup: NotificationEventsCatchupService;
  let marker: NotificationEventsMarker;
  let redis: Redis;
  let legacyWatermarkKey = '';
  let fixtureTenantId = '';
  const suffix = Date.now();
  const DAY = 24 * 3600_000;

  const uid = (n: number) => `01900000-0000-7000-8000-${String(720000 + n * 37 + (suffix % 991)).padStart(12, '0')}`;

  async function execRows<T>(query: SQL): Promise<T[]> {
    const result = (await db.execute(query)) as unknown as { rows: T[] };
    return result.rows;
  }

  async function makeUser(id: string) {
    await db.execute(sql`insert into users (id, username, email, first_name, last_name, suspended, deleted) values (${id}, ${`nc520-${id.slice(-6)}-${suffix}`}, ${`nc520-${id.slice(-6)}-${suffix}@x.io`}, 'An', 'Nguyễn Văn', false, false) on conflict (id) do nothing`);
    await db.insert(userPreferences).values({
      userId: id, name: 'message_provider_enrol_expiry_warning_email_v2', value: 'immediate',
    }).onConflictDoNothing();
  }

  async function fixtureClassId(): Promise<string> {
    const ownerId = '01980000-0000-7000-8000-00000000c1a5';
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${ownerId}, 'wk-class-owner', 'wk-class-owner@x.io', false, false) on conflict (id) do nothing`);
    const coh = await execRows<{ id: string }>(sql`insert into cohort (tenant_id, name, context_id, component, visible) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture cohort', '01990000-0000-7000-8000-0000000000a1', 'class', false) returning id`);
    const cls = await execRows<{ id: string }>(sql`insert into classes (tenant_id, name, owner_id, cohort_id) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture class', ${ownerId}, ${coh[0]!.id}) returning id`);
    return cls[0]!.id;
  }

  async function makeCourse(name: string): Promise<string> {
    const cat = await execRows<{ id: string }>(sql`insert into course_categories (name, path, tenant_id) values (${`nc520-cat-${suffix}-${Math.random()}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const short = `nc520${suffix}${Math.floor(Math.random() * 1e9)}`;
    const rows = await execRows<{ id: string }>(sql`insert into course (category, tenant_id, full_name, short_name, visible, class_id) values (${cat[0]!.id}, (select tenant_id from course_categories where id = ${cat[0]!.id}), ${name}, ${short}, true, ${await fixtureClassId()}) returning id`);
    return rows[0]!.id;
  }

  async function enrolStudent(courseId: string, userId: string): Promise<void> {
    const [inst] = await db.insert(enrol).values({ courseId, enrol: 'manual', status: 0 }).returning();
    await db.insert(userEnrolments).values({
      enrolId: inst!.id as string, userId, status: 0, timeStart: new Date(Date.now() - DAY),
    });
  }

  /** Chèn một dòng outbox ĐÃ bị relay đóng dấu `publishedAt` — đúng hình dạng tồn đọng tại thời điểm chuyển đổi. */
  async function emitMarkedRow(userId: string, courseId: string): Promise<{ id: string; seq: number }> {
    const [row] = await db.insert(outboxEvents).values({
      aggregate: 'enrol', type: 'enrol_expiry_warning', tenantId: fixtureTenantId,
      publishedAt: new Date(),
      payload: {
        userId, enrolmentId: uid(950), enrolId: uid(951), courseId,
        timeEnd: new Date(Date.now() + 3 * DAY).toISOString(),
      },
    }).returning({ id: outboxEvents.id, seq: outboxEvents.seq });
    return { id: row!.id as string, seq: Number(row!.seq) };
  }

  async function waitJobCompleted(outboxId: string, timeoutMs = 90000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await eventsQueue.getJob(outboxId);
      if (job && (await job.getState()) === 'completed') return;
      if (Date.now() > deadline) throw new Error(`job sự kiện ${outboxId} chưa completed sau ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function notificationsOf(userId: string, eventType: string) {
    return db.select().from(notifications).where(and(
      eq(notifications.userIdTo, userId), eq(notifications.eventType, eventType),
    ));
  }

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    await db.execute(sql`insert into tenants (slug, name, kind, status) values ('worker-fixture', 'Worker fixture tenant', 'school', 'active') on conflict (slug) do nothing`);
    const tenantRows = await execRows<{ id: string }>(sql`select id from tenants where slug = 'worker-fixture'`);
    fixtureTenantId = tenantRows[0]!.id;
    eventsQueue = context.get<Queue>(getQueueToken('notification-events'));
    catchup = context.get(NotificationEventsCatchupService);
    marker = context.get(NotificationEventsMarker);
    redis = new Redis({
      ...redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    });
    // Khoá watermark của consumer polling cũ, dựng đúng cách consumer
    // cũ dựng: tên database lấy từ path của DATABASE_URL.
    const databaseName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, '') || 'default';
    legacyWatermarkKey = `lms:messaging:notifications:${databaseName}:seq`;
    await redis.del(legacyWatermarkKey);
  });
  afterAll(async () => {
    await redis.del(legacyWatermarkKey).catch(() => undefined);
    redis.disconnect();
    await harness.close();
  });

  async function makeStudentCourse(n: number): Promise<{ student: string; courseId: string }> {
    const student = uid(n);
    await makeUser(student);
    const courseId = await makeCourse(`NC520 Khoá chuyển đổi ${n}`);
    await enrolStudent(courseId, student);
    return { student, courseId };
  }

  it('phát bù đúng các dòng trên watermark cũ đã bị đóng dấu: dòng trên được xử lý đúng một lần, dòng dưới không xử lý lại, dòng đã có dấu không sinh thông báo trùng, khoá cũ bị xoá sau khi rút cạn', async () => {
    const belowFixture = await makeStudentCourse(1);
    const aboveFixture = await makeStudentCourse(2);
    const markedFixture = await makeStudentCourse(3);
    const belowStudent = belowFixture.student;
    const aboveStudent = aboveFixture.student;
    const markedStudent = markedFixture.student;

    // Ba dòng đã đóng dấu, seq tăng dần: watermark cũ dừng đúng ở
    // dòng đầu — hai dòng sau là tồn đọng chưa từng thành job.
    const below = await emitMarkedRow(belowStudent, belowFixture.courseId);
    const above = await emitMarkedRow(aboveStudent, aboveFixture.courseId);
    const marked = await emitMarkedRow(markedStudent, markedFixture.courseId);
    expect(above.seq).toBeGreaterThan(below.seq);
    expect(marked.seq).toBeGreaterThan(above.seq);
    // Dòng thứ ba mô phỏng sự kiện đã được xử lý ở một đường khác:
    // dấu đã xử lý theo outboxId đã có trước khi phát bù.
    await marker.markProcessed(marked.id);
    await redis.set(legacyWatermarkKey, String(below.seq));

    const enqueued = await catchup.drainLegacyBacklog();
    expect(enqueued).toBe(2);

    await waitJobCompleted(above.id);
    await waitJobCompleted(marked.id);

    // Dòng trên watermark: đúng một thông báo. Dòng đã có dấu: job
    // kết luận trùng ở processor, không thông báo. Dòng dưới
    // watermark: không job, không thông báo.
    expect(await notificationsOf(aboveStudent, 'enrol_expiry_warning')).toHaveLength(1);
    expect(await notificationsOf(markedStudent, 'enrol_expiry_warning')).toHaveLength(0);
    expect(await notificationsOf(belowStudent, 'enrol_expiry_warning')).toHaveLength(0);
    expect(await eventsQueue.getJob(below.id)).toBeFalsy();

    // Rút cạn xong thì khoá cũ bị xoá; lượt phát bù sau là no-op.
    expect(await redis.get(legacyWatermarkKey)).toBeNull();
    expect(await catchup.drainLegacyBacklog()).toBe(0);
  }, 180000);

  it('hệ mới tinh không có watermark cũ thì không phát bù gì: dòng đã đóng dấu không thành job và không sinh thông báo', async () => {
    const student = uid(4);
    await makeUser(student);
    const courseId = await makeCourse('NC520 Khoá hệ mới');
    await enrolStudent(courseId, student);
    const row = await emitMarkedRow(student, courseId);

    expect(await redis.get(legacyWatermarkKey)).toBeNull();
    expect(await catchup.drainLegacyBacklog()).toBe(0);
    expect(await eventsQueue.getJob(row.id)).toBeFalsy();
    expect(await notificationsOf(student, 'enrol_expiry_warning')).toHaveLength(0);
  }, 180000);
});
