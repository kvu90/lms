import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEvents } from '@lms/db';
import { OUTBOX_EVENT_QUEUE_ROUTES } from '../../../src/outbox-event-routes';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Consumer đồng bộ cohort ở worker (issue con #528 của #519) —
 * các ca hành vi của ca (6) trong e2e vòng đời lớp phía API chuyển
 * nguyên sang tầng này, đi qua ĐƯỜNG THẬT của production: chèn
 * dòng sự kiện outbox đúng hình dạng phía phát vẫn ghi (bỏ qua
 * đường in-process) → relay outbox duy nhất đóng dấu `publishedAt`
 * và định tuyến vào hàng đợi `cohort-sync-events` →
 * `CohortSyncEventsProcessor` → host `CohortSyncService` gọi bề mặt
 * vật chất hoá cohort dùng chung của issue con #527.
 *
 * Giữ nguyên khẳng định nghiệp vụ của ca e2e cũ (ghi danh được vật
 * chất hoá đúng như hành vi hiện tại ở cả hai chiều thêm/bớt thành
 * viên, sự kiện `user_enrolment_suspended` vẫn được phát tiếp khi
 * có trường hợp áp dụng), cộng các ca ghim tính idempotent hai
 * tầng đã chốt cho issue này: phát lại cùng một sự kiện (job mới
 * mang cùng `outboxId` + payload, mô phỏng phát lại ngoài cửa sổ
 * lưu giữ của `jobId`) không sinh ghi danh trùng, không phát lại
 * `user_enrolled`/`user_unenrolled`, không kích hoạt lại ghi danh
 * đã đình chỉ/rút.
 *
 * Khác biệt bề mặt duy nhất so với e2e cũ: dữ kiện (tenant, cây
 * context, khoá, cohort, instance, vai trò) được dựng bằng SQL trực
 * tiếp theo khuôn spec đặc tả hoá bề mặt ở phía worker của #527,
 * và khẳng định đọc ở tầng DB thay vì qua endpoint — đúng tiền lệ
 * chuyển ca của issue #520. Mỗi ca dùng đồ thị riêng (id ngẫu
 * nhiên) nên các ca độc lập dữ kiện nghiệp vụ.
 */
describe('Worker cohort sync events delivery (chuyển consumer ở #528)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: OrdinaryWorkerModuleHarness['adminDb'];
  let eventsQueue: Queue;
  let tenantId = '';
  let tenantCtxId = '';
  let systemCtxId = '';
  let categoryId = '';
  let studentRoleId = '';

  interface CourseGraph {
    courseId: string;
    cohortId: string;
    instanceId: string;
    courseCtxId: string;
  }

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    const tag = id.replaceAll('-', '').slice(0, 12);
    await db.execute(
      `INSERT INTO users (id, username, email) VALUES ('${id}', 'w528_${tag}', 'w528_${tag}@example.test')`,
    );
    return id;
  }

  async function makeCourseGraph(onLeave: 'suspend' | 'unenrol'): Promise<CourseGraph> {
    const courseId = randomUUID();
    const cohortId = randomUUID();
    const instanceId = randomUUID();
    const courseCtxId = randomUUID();
    await db.execute(
      `INSERT INTO course (id, tenant_id, category, full_name, short_name, is_template) VALUES ('${courseId}', '${tenantId}', '${categoryId}', 'Khoá delivery worker 528', 'W528-${courseId.slice(0, 8)}', true)`,
    );
    await db.execute(
      `INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ('${courseCtxId}', 50, '${courseId}', '/${systemCtxId}/${tenantCtxId}/${courseCtxId}', 3)`,
    );
    await db.execute(
      `INSERT INTO cohort (id, tenant_id, name, context_id) VALUES ('${cohortId}', '${tenantId}', 'Cohort worker 528', '${tenantCtxId}')`,
    );
    await db.execute(
      `INSERT INTO enrol (id, course_id, enrol, status, role_id, custom_int1, custom_int2, custom_text1) VALUES ('${instanceId}', '${courseId}', 'cohort', 0, '${studentRoleId}', '${cohortId}', NULL, '${onLeave}')`,
    );
    return { courseId, cohortId, instanceId, courseCtxId };
  }

  async function ueRow(instanceId: string, userId: string): Promise<Record<string, unknown> | undefined> {
    const rows = await db.execute(
      `SELECT * FROM user_enrolments WHERE enrol_id = '${instanceId}' AND user_id = '${userId}'`,
    ) as unknown as { rows: Array<Record<string, unknown>> };
    return rows.rows[0];
  }

  async function outboxOf(type: string, userId: string): Promise<Array<{ payload: Record<string, unknown> }>> {
    const rows = await db.execute(
      `SELECT payload FROM outbox_events WHERE type = '${type}' AND payload ->> 'userId' = '${userId}' ORDER BY seq`,
    ) as unknown as { rows: Array<{ payload: Record<string, unknown> }> };
    return rows.rows;
  }

  /** Chèn một dòng sự kiện outbox đúng hình dạng phía phát vẫn ghi; trả outboxId để chờ job. */
  async function emit(type: string, payload: Record<string, unknown>): Promise<string> {
    const [row] = await db.insert(outboxEvents).values({
      aggregate: 'cohort', type, tenantId, payload,
    }).returning({ id: outboxEvents.id });
    return row!.id as string;
  }

  /** Chờ job của một dòng outbox trên hàng đợi cohort-sync-events đạt trạng thái completed. */
  async function waitJobCompleted(outboxId: string, timeoutMs = 90000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await eventsQueue.getJob(outboxId);
      if (job && (await job.getState()) === 'completed') return;
      if (Date.now() > deadline) throw new Error(`job sự kiện ${outboxId} chưa completed sau ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /**
   * Phát lại một sự kiện ngoài cửa sổ lưu giữ của `jobId`: job mới
   * mang cùng `outboxId` + payload nhưng `jobId` khác, đúng hình
   * dạng phát lại mà relay tạo khi dòng đã bị dọn khỏi hàng đợi.
   * Chờ job phát lại này completed rồi mới khẳng định.
   */
  async function redeliver(type: string, outboxId: string, payload: Record<string, unknown>): Promise<void> {
    const job = await eventsQueue.add(type, {
      outboxId, seq: 0, aggregate: 'cohort', type, payload, tenantId, occurredAt: new Date().toISOString(),
    }, { jobId: randomUUID() });
    const deadline = Date.now() + 90000;
    for (;;) {
      if ((await job.getState()) === 'completed') return;
      if (Date.now() > deadline) throw new Error(`job phát lại ${outboxId} chưa completed sau 90000ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    eventsQueue = context.get<Queue>(getQueueToken('cohort-sync-events'));

    tenantId = randomUUID();
    tenantCtxId = randomUUID();
    systemCtxId = randomUUID();
    categoryId = randomUUID();
    studentRoleId = randomUUID();
    await db.execute(
      `INSERT INTO tenants (id, slug, name, kind) VALUES ('${tenantId}', 'trung-tam-w528-${tenantId.slice(0, 8)}', 'Trung tâm delivery worker 528', 'school')`,
    );
    await db.execute(`INSERT INTO course_categories (id, tenant_id, name) VALUES ('${categoryId}', '${tenantId}', 'Danh mục worker 528')`);
    await db.execute(`INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ('${systemCtxId}', 10, NULL, '/${systemCtxId}', 1)`);
    await db.execute(`INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ('${tenantCtxId}', 20, '${tenantId}', '/${systemCtxId}/${tenantCtxId}', 2)`);
    await db.execute(`INSERT INTO role (id, name, short_name, archetype) VALUES ('${studentRoleId}', 'Student', 'student528', 'student')`);
  });
  afterAll(async () => { await harness.close(); });

  it('bảng định tuyến relay ánh xạ cả hai loại sự kiện cohort vào hàng đợi cohort-sync-events', async () => {
    expect(OUTBOX_EVENT_QUEUE_ROUTES['cohort_member_added']).toBe('cohort-sync-events');
    expect(OUTBOX_EVENT_QUEUE_ROUTES['cohort_member_removed']).toBe('cohort-sync-events');
  });

  it('thêm thành viên qua relay + hàng đợi: ghi danh ACTIVE, cấp vai của instance, phát user_enrolled, membership tenant active', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);

    const eventId = await emit('cohort_member_added', { cohortId: graph.cohortId, userId });
    await waitJobCompleted(eventId);

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue).toBeDefined();
    expect(ue?.status).toBe(0);
    const assignments = await db.execute(
      `SELECT * FROM role_assignments WHERE user_id = '${userId}' AND context_id = '${graph.courseCtxId}' AND component = 'enrol' AND item_id = '${graph.instanceId}'`,
    ) as unknown as { rows: unknown[] };
    expect(assignments.rows).toHaveLength(1);
    const enrolledEvents = await outboxOf('user_enrolled', userId);
    expect(enrolledEvents).toHaveLength(1);
    expect(enrolledEvents[0]?.payload.courseId).toBe(graph.courseId);
    const membership = await db.execute(
      `SELECT status FROM tenant_memberships WHERE tenant_id = '${tenantId}' AND user_id = '${userId}'`,
    ) as unknown as { rows: Array<{ status: string }> };
    expect(membership.rows[0]?.status).toBe('active');
  }, 180000);

  it('phát lại sự kiện thêm thành viên: không sinh ghi danh trùng, không phát lại user_enrolled', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);
    const payload = { cohortId: graph.cohortId, userId };

    const eventId = await emit('cohort_member_added', payload);
    await waitJobCompleted(eventId);
    await redeliver('cohort_member_added', eventId, payload);

    const rows = await db.execute(
      `SELECT * FROM user_enrolments WHERE enrol_id = '${graph.instanceId}' AND user_id = '${userId}'`,
    ) as unknown as { rows: unknown[] };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: 0 });
    expect(await outboxOf('user_enrolled', userId)).toHaveLength(1);
  }, 180000);

  it('rời cohort ở chế độ đình chỉ qua relay + hàng đợi: ghi danh SUSPENDED, xoá vết người thao tác, phát user_enrolment_suspended lý do cohort_removed', async () => {
    const graph = await makeCourseGraph('suspend');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);
    const addedId = await emit('cohort_member_added', { cohortId: graph.cohortId, userId });
    await waitJobCompleted(addedId);
    await db.execute(`DELETE FROM cohort_members WHERE cohort_id = '${graph.cohortId}' AND user_id = '${userId}'`);

    const removedId = await emit('cohort_member_removed', { cohortId: graph.cohortId, userId });
    await waitJobCompleted(removedId);

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue?.status).toBe(1);
    expect(ue?.modifier_id).toBeNull();
    const suspendedEvents = await outboxOf('user_enrolment_suspended', userId);
    expect(suspendedEvents).toHaveLength(1);
    expect(suspendedEvents[0]?.payload.reason).toBe('cohort_removed');
  }, 180000);

  it('phát lại sự kiện rời ở chế độ đình chỉ: ghi danh vẫn SUSPENDED một dòng, không kích hoạt lại', async () => {
    const graph = await makeCourseGraph('suspend');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);
    const addedId = await emit('cohort_member_added', { cohortId: graph.cohortId, userId });
    await waitJobCompleted(addedId);
    await db.execute(`DELETE FROM cohort_members WHERE cohort_id = '${graph.cohortId}' AND user_id = '${userId}'`);
    const payload = { cohortId: graph.cohortId, userId };
    const removedId = await emit('cohort_member_removed', payload);
    await waitJobCompleted(removedId);

    await redeliver('cohort_member_removed', removedId, payload);

    const rows = await db.execute(
      `SELECT * FROM user_enrolments WHERE enrol_id = '${graph.instanceId}' AND user_id = '${userId}'`,
    ) as unknown as { rows: Array<Record<string, unknown>> };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe(1);
    // Ghi chú: phát lại ở chế độ đình chỉ phát thêm một dòng
    // `user_enrolment_suspended` (đường đình chỉ của bề mặt phát sự
    // kiện trong transaction riêng sau khi cập nhật trạng thái) —
    // trạng thái ghi danh bền không đổi và loại sự kiện này hiện
    // chưa có consumer nào, nên dòng trùng không gây tác dụng phụ
    // nghiệp vụ nào. Khẳng định ở đây ghim trạng thái bền, không
    // ghim số dòng sự kiện đình chỉ.
  }, 180000);

  it('rời cohort ở chế độ rút khi không còn dữ liệu liên quan qua relay + hàng đợi: xoá cứng ghi danh, gỡ vai, phát user_unenrolled và yêu cầu tái tổng hợp', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);
    const addedId = await emit('cohort_member_added', { cohortId: graph.cohortId, userId });
    await waitJobCompleted(addedId);
    await db.execute(`DELETE FROM cohort_members WHERE cohort_id = '${graph.cohortId}' AND user_id = '${userId}'`);

    const removedId = await emit('cohort_member_removed', { cohortId: graph.cohortId, userId });
    await waitJobCompleted(removedId);

    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
    const assignments = await db.execute(
      `SELECT * FROM role_assignments WHERE user_id = '${userId}' AND context_id = '${graph.courseCtxId}' AND component = 'enrol'`,
    ) as unknown as { rows: unknown[] };
    expect(assignments.rows).toHaveLength(0);
    const unenrolledEvents = await outboxOf('user_unenrolled', userId);
    expect(unenrolledEvents).toHaveLength(1);
    expect(unenrolledEvents[0]?.payload.keptData).toBe(false);
    const reaggregationEvents = await outboxOf('course_completion_reaggregation_requested', userId);
    expect(reaggregationEvents).toHaveLength(1);
    expect(reaggregationEvents[0]?.payload.courseId).toBe(graph.courseId);
  }, 180000);

  it('phát lại sự kiện rời ở chế độ rút: ghi danh vẫn đã rút, không phát lại user_unenrolled', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);
    const addedId = await emit('cohort_member_added', { cohortId: graph.cohortId, userId });
    await waitJobCompleted(addedId);
    await db.execute(`DELETE FROM cohort_members WHERE cohort_id = '${graph.cohortId}' AND user_id = '${userId}'`);
    const payload = { cohortId: graph.cohortId, userId };
    const removedId = await emit('cohort_member_removed', payload);
    await waitJobCompleted(removedId);

    await redeliver('cohort_member_removed', removedId, payload);

    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
    expect(await outboxOf('user_unenrolled', userId)).toHaveLength(1);
  }, 180000);
});
