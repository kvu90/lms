import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { enrol, notifications, outboxEvents, userEnrolments, userPreferences } from '@lms/db';
import { NotificationEventsMarker } from '../../../src/notification-events-marker.service';
import { NotificationEventsProcessor } from '../../../src/processors/notification-events.processor';
import type { OutboxEventJobData } from '../../../src/outbox-event-routes';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Cơ chế hàng đợi của consumer thông báo sự kiện (issue con #520
 * của #491) — viết lại spec neo-lại-watermark phía API trước đây
 * (`notification-events-reanchor.int-spec.ts`, đã xoá cùng consumer
 * polling) theo cơ chế mới, giữ nguyên Ý ĐỊNH nghiệp vụ của ba ca
 * gốc và cộng ca phát lại thật theo ràng buộc chống trùng của đợt
 * chuyển consumer:
 *
 *  1. (Từ ca gốc 1 — sự kiện sau mốc neo được xử lý đúng một lần)
 *     Một dòng outbox chưa có `publishedAt` được relay phát vào
 *     hàng đợi, consumer xử lý và sinh đúng một thông báo; dòng
 *     được đóng dấu sau khi phát và không bị phát lại ở các nhịp
 *     relay sau (hàng đợi giữ đúng một job của dòng).
 *  2. (Từ ca gốc 2+3 — DB dựng lại, seq thụt lùi) Consumer hàng
 *     đợi KHÔNG giữ watermark `seq` nào nên không tồn tại trạng
 *     thái "watermark kẹt trên seq của đời DB mới": một sự kiện
 *     mang `seq` NHỎ HƠN seq của các sự kiện đã xử lý (đúng hình
 *     dạng sau reset DB) vẫn được relay phát và xử lý bình thường,
 *     vì relay chỉ quét theo `publishedAt IS NULL` và consumer
 *     không so sánh seq. Đây là khẳng định tương đương của phép
 *     neo-lại: cơ chế cần neo đã bị loại bỏ tận gốc thay vì được
 *     vá.
 *  3. (Ca mới của #520 — phát lại thật) Cùng một job được processor
 *     gọi xử lý hai lần với cùng `outboxId`: lần hai kết luận
 *     trùng nhờ dấu đã xử lý ở Redis và không sinh thông báo thứ
 *     hai.
 *  4. (Marker) Lease đang xử lý chỉ nhả được bởi đúng token của
 *     chủ: token lạ không mở được lease của lượt khác.
 *
 * Các ca hành vi nội dung/điều kiện phát của mười loại sự kiện nằm
 * ở spec `notification-events-delivery.int-spec.ts` cùng thư mục.
 */
describe('Worker notification events queue mechanism (viết lại reanchor ở #520)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: OrdinaryWorkerModuleHarness['adminDb'];
  let eventsQueue: Queue;
  let processor: NotificationEventsProcessor;
  let marker: NotificationEventsMarker;
  let fixtureTenantId = '';
  const suffix = Date.now();
  const DAY = 24 * 3600_000;

  const uid = (n: number) => `01900000-0000-7000-8000-${String(620000 + n * 37 + (suffix % 991)).padStart(12, '0')}`;

  async function execRows<T>(query: SQL): Promise<T[]> {
    const result = (await db.execute(query)) as unknown as { rows: T[] };
    return result.rows;
  }

  async function makeUser(id: string) {
    await db.execute(sql`insert into users (id, username, email, first_name, last_name, suspended, deleted) values (${id}, ${`nq520-${id.slice(-6)}-${suffix}`}, ${`nq520-${id.slice(-6)}-${suffix}@x.io`}, 'An', 'Nguyễn Văn', false, false) on conflict (id) do nothing`);
    // Tần suất email immediate cho hai provider dùng ở spec này —
    // tránh dispatch nằm chờ digest trong DB dùng chung (xem spec
    // delivery cùng thư mục).
    for (const provider of ['grade_updated', 'enrol_expiry_warning']) {
      await db.insert(userPreferences).values({
        userId: id, name: `message_provider_${provider}_email_v2`, value: 'immediate',
      }).onConflictDoNothing();
    }
  }

  async function fixtureClassId(): Promise<string> {
    const ownerId = '01980000-0000-7000-8000-00000000c1a5';
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${ownerId}, 'wk-class-owner', 'wk-class-owner@x.io', false, false) on conflict (id) do nothing`);
    const coh = await execRows<{ id: string }>(sql`insert into cohort (tenant_id, name, context_id, component, visible) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture cohort', '01990000-0000-7000-8000-0000000000a1', 'class', false) returning id`);
    const cls = await execRows<{ id: string }>(sql`insert into classes (tenant_id, name, owner_id, cohort_id) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture class', ${ownerId}, ${coh[0]!.id}) returning id`);
    return cls[0]!.id;
  }

  async function makeCourse(name: string): Promise<string> {
    const cat = await execRows<{ id: string }>(sql`insert into course_categories (name, path, tenant_id) values (${`nq520-cat-${suffix}-${Math.random()}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const short = `nq520${suffix}${Math.floor(Math.random() * 1e9)}`;
    const rows = await execRows<{ id: string }>(sql`insert into course (category, tenant_id, full_name, short_name, visible, class_id) values (${cat[0]!.id}, (select tenant_id from course_categories where id = ${cat[0]!.id}), ${name}, ${short}, true, ${await fixtureClassId()}) returning id`);
    return rows[0]!.id;
  }

  async function enrolStudent(courseId: string, userId: string): Promise<void> {
    const [inst] = await db.insert(enrol).values({ courseId, enrol: 'manual', status: 0 }).returning();
    await db.insert(userEnrolments).values({
      enrolId: inst!.id as string, userId, status: 0, timeStart: new Date(Date.now() - DAY),
    });
  }

  async function emitExpiryWarning(userId: string, courseId: string): Promise<string> {
    const [row] = await db.insert(outboxEvents).values({
      aggregate: 'enrol', type: 'enrol_expiry_warning', tenantId: fixtureTenantId,
      payload: {
        userId, enrolmentId: uid(950), enrolId: uid(951), courseId,
        timeEnd: new Date(Date.now() + 3 * DAY).toISOString(),
      },
    }).returning({ id: outboxEvents.id });
    return row!.id as string;
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
    processor = context.get(NotificationEventsProcessor);
    marker = context.get(NotificationEventsMarker);
  });
  afterAll(async () => { await harness.close(); });

  it('một sự kiện qua relay vào hàng đợi được xử lý đúng một lần, dòng được đóng dấu publishedAt sau khi phát và hàng đợi giữ đúng một job của dòng', async () => {
    const student = uid(1);
    await makeUser(student);
    const courseId = await makeCourse('NQ520 Khoá cơ chế');
    await enrolStudent(courseId, student);

    const outboxId = await emitExpiryWarning(student, courseId);
    await waitJobCompleted(outboxId);

    expect(await notificationsOf(student, 'enrol_expiry_warning')).toHaveLength(1);
    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, outboxId));
    expect((row as { publishedAt: Date | null }).publishedAt).not.toBeNull();

    // Các nhịp relay sau không phát lại dòng đã đóng dấu: trên hàng
    // đợi vẫn đúng một job mang id của dòng, và số thông báo không đổi.
    const jobs = await eventsQueue.getJobs(['waiting', 'active', 'completed', 'delayed']);
    expect(jobs.filter((j) => j.id === outboxId)).toHaveLength(1);
    expect(await notificationsOf(student, 'enrol_expiry_warning')).toHaveLength(1);
  }, 180000);

  it('sự kiện mang seq nhỏ hơn seq của sự kiện đã xử lý vẫn được xử lý — consumer hàng đợi không giữ watermark seq để bị kẹt sau reset DB', async () => {
    const student = uid(2);
    await makeUser(student);
    const courseId = await makeCourse('NQ520 Khoá seq thụt');
    await enrolStudent(courseId, student);

    // Sự kiện thứ nhất xử lý trọn như thường.
    const firstId = await emitExpiryWarning(student, courseId);
    await waitJobCompleted(firstId);
    expect(await notificationsOf(student, 'enrol_expiry_warning')).toHaveLength(1);
    const [firstRow] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, firstId));
    const firstSeq = Number((firstRow as { seq: number }).seq);

    // Sự kiện thứ hai được chèn với seq NHỎ HƠN seq đã xử lý — đúng
    // hình dạng một đời DB mới sau reset mà consumer polling cũ
    // phải neo-lại-watermark mới thấy được. Cột seq là identity
    // GENERATED ALWAYS nên câu chèn phải khai OVERRIDING SYSTEM
    // VALUE mới gán được seq tường minh. Relay chỉ quét publishedAt
    // rỗng và consumer không so seq nên sự kiện vẫn tới nơi.
    const secondPayload = {
      userId: student, enrolmentId: uid(952), enrolId: uid(953), courseId,
      timeEnd: new Date(Date.now() + 3 * DAY).toISOString(),
    };
    // seq có ràng buộc duy nhất và DB test dùng chung đã có các dòng
    // khác giữ những seq nhỏ: dò xuống từ firstSeq - 1 tới khi gặp
    // một seq còn trống (mọi ứng viên đều nhỏ hơn seq đã xử lý).
    let secondId: string | undefined;
    for (let candidate = firstSeq - 1; candidate > firstSeq - 200 && !secondId; candidate--) {
      try {
        const secondRows = await execRows<{ id: string }>(sql`
          insert into outbox_events (aggregate, type, tenant_id, payload, seq)
          overriding system value
          values ('enrol', 'enrol_expiry_warning', ${fixtureTenantId}, ${JSON.stringify(secondPayload)}::jsonb, ${candidate})
          returning id`);
        secondId = secondRows[0]!.id;
      } catch {
        // seq ứng viên đã có dòng khác giữ — thử giá trị nhỏ hơn.
      }
    }
    if (!secondId) throw new Error('không tìm được seq trống nhỏ hơn seq của sự kiện đã xử lý');
    await waitJobCompleted(secondId);
    expect(await notificationsOf(student, 'enrol_expiry_warning')).toHaveLength(2);
  }, 180000);

  it('phát lại thật: processor xử lý cùng một job hai lần thì lần hai kết luận trùng và không sinh thông báo thứ hai', async () => {
    const student = uid(3);
    await makeUser(student);
    const courseId = await makeCourse('NQ520 Khoá phát lại');
    await enrolStudent(courseId, student);
    const item = await execRows<{ id: string }>(sql`insert into grade_items (course_id, item_name, item_type, grade_max, posting_policy) values (${courseId}, 'Bài phát lại', 'manual', 100, 'auto') returning id`);

    // Job dựng tay với outboxId riêng, gọi thẳng processor hai lần —
    // đường relay không chen vào, khẳng định thuần về chốt chống
    // trùng theo outboxId của processor + marker.
    const jobData: OutboxEventJobData = {
      outboxId: uid(960), seq: 0, aggregate: 'grades', type: 'grade_updated',
      tenantId: fixtureTenantId, occurredAt: new Date().toISOString(),
      payload: {
        courseId, itemId: item[0]!.id, userId: student,
        rawGrade: 9, finalGrade: 9, actorId: uid(961),
      },
    };
    const fakeJob = {
      data: jobData,
      moveToDelayed: async () => undefined,
    };
    const first = await processor.process(fakeJob as never, 'worker-token');
    expect(first).toEqual({ handled: true });
    expect(await notificationsOf(student, 'grade_updated')).toHaveLength(1);

    const second = await processor.process(fakeJob as never, 'worker-token');
    expect(second).toEqual({ handled: true, duplicate: true });
    expect(await notificationsOf(student, 'grade_updated')).toHaveLength(1);
  }, 180000);

  it('lease đang xử lý chỉ nhả được bởi đúng token của chủ — token lạ không mở được lease của lượt khác', async () => {
    const outboxId = uid(970);
    const token = await marker.claimProcessing(outboxId);
    expect(token).not.toBeNull();
    // Lượt khác không chiếm được khi lease còn hạn.
    expect(await marker.claimProcessing(outboxId)).toBeNull();
    // Nhả bằng token lạ: lease vẫn giữ nguyên.
    await marker.releaseProcessing(outboxId, 'token-khong-phai-cua-chu');
    expect(await marker.claimProcessing(outboxId)).toBeNull();
    // Nhả bằng đúng token của chủ: lease mở, lượt sau chiếm được.
    await marker.releaseProcessing(outboxId, token!);
    const next = await marker.claimProcessing(outboxId);
    expect(next).not.toBeNull();
    await marker.releaseProcessing(outboxId, next!);
    // Dấu đã xử lý độc lập với lease: chưa ghi thì đọc là chưa.
    expect(await marker.hasProcessed(outboxId)).toBe(false);
    await marker.markProcessed(outboxId);
    expect(await marker.hasProcessed(outboxId)).toBe(true);
  }, 180000);
});
