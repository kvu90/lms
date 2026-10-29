import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CohortMaterializationSurface, type SharedOutboxPort } from '@lms/enrol';
import { outboxEvents } from '@lms/db';
import { relations } from '../../../src/db/relations';
import { tenantAls } from '../../../src/db/tenant-als';

/**
 * Spec đặc tả hoá cho bề mặt vật chất hoá cohort dùng chung
 * `@lms/enrol` ở phía WORKER (issue #527, tiêu chí nghiệm thu về
 * tính gọi được từ worker).
 *
 * Bối cảnh: đường đồng bộ cohort trước đây chỉ chạy được trong
 * tiến trình API — funnel ghi danh sống trong `EnrolService` và phụ
 * thuộc các cơ chế đăng ký lúc khởi tạo của tiến trình API (probe
 * dữ liệu liên quan, hook tái tổng hợp). Spec này chứng minh bề mặt
 * đã trích xuất dựng và chạy trọn vẹn trong NGỮ CẢNH CỦA WORKER:
 * chính tiến trình test của worker import package, dựng bề mặt
 * bằng tay cầm Drizzle trên cơ sở dữ liệu test của worker
 * (`lms_test_worker`), cổng outbox do phía gọi tự cấp (chèn thẳng
 * vào `outbox_events` trên schema dùng chung, gương `tenantId` vào
 * payload như dịch vụ outbox của API vẫn làm) và cổng ngữ cảnh
 * platform là `tenantAls` của worker — không qua bất kỳ service
 * nào của API. Kết quả trên cơ sở dữ liệu phải khớp từng khẳng
 * định với đường vật chất hoá ở phía API:
 *
 * - thêm thành viên: ghi danh ACTIVE, gán vai của instance tại
 *   context khoá với truy vết nguồn của instance, sự kiện
 *   `user_enrolled`, membership active tại tenant của khoá;
 * - thành viên vi phạm chốt tách vai bị bỏ qua riêng lẻ;
 * - rời cohort ở chế độ rút khi không còn dữ liệu liên quan: xoá
 *   cứng ghi danh, gỡ vai của instance, phát `user_unenrolled` và
 *   `course_completion_reaggregation_requested` trong cùng đường
 *   rút;
 * - rời cohort ở chế độ đình chỉ: ghi danh SUSPENDED, vết người
 *   thao tác về null, sự kiện đình chỉ mang lý do `cohort_removed`.
 *
 * Việc DÂY consumer đồng bộ cohort của worker vào bề mặt này là
 * việc của issue con tiếp theo trong chuỗi; spec này chỉ ghim tính
 * gọi được và tính đúng hành vi của chính bề mặt từ phía worker.
 * Fixture dựng bằng SQL trực tiếp với id ngẫu nhiên theo từng ca.
 */

interface CourseGraph {
  courseId: string;
  cohortId: string;
  instanceId: string;
  courseCtxId: string;
}

describe('Vật chất hoá cohort dùng chung — gọi được và đúng hành vi từ phía worker', () => {
  let pg: Client;
  let pool: Pool;
  let surface: CohortMaterializationSurface;
  let tenantId: string;
  let tenantCtxId: string;
  let categoryId: string;
  let studentRoleId: string;
  let teacherRoleId: string;

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    const tag = id.replaceAll('-', '').slice(0, 12);
    await pg.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [id, `w527_${tag}`, `w527_${tag}@example.test`]);
    return id;
  }

  async function makeCourseGraph(onLeave: 'suspend' | 'unenrol'): Promise<CourseGraph> {
    const courseId = randomUUID();
    const cohortId = randomUUID();
    const instanceId = randomUUID();
    const courseCtxId = randomUUID();
    const systemCtxId = randomUUID();
    // Mỗi đồ thị dựng cây context riêng (hệ thống → tenant → khoá)
    // để các ca hoàn toàn độc lập trên cùng một cơ sở dữ liệu.
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 10, NULL, $2, 1)', [
      systemCtxId, `/${systemCtxId}`,
    ]);
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 20, $2, $3, 2)', [
      tenantCtxId, tenantId, `/${systemCtxId}/${tenantCtxId}`,
    ]);
    await pg.query(
      'INSERT INTO course (id, tenant_id, category, full_name, short_name, is_template) VALUES ($1, $2, $3, $4, $5, true)',
      [courseId, tenantId, categoryId, 'Khoá đặc tả hoá worker 527', `W527-${courseId.slice(0, 8)}`],
    );
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 50, $2, $3, 3)', [
      courseCtxId, courseId, `/${systemCtxId}/${tenantCtxId}/${courseCtxId}`,
    ]);
    await pg.query('INSERT INTO cohort (id, tenant_id, name, context_id) VALUES ($1, $2, $3, $4)', [
      cohortId, tenantId, 'Cohort worker 527', tenantCtxId,
    ]);
    await pg.query(
      `INSERT INTO enrol (id, course_id, enrol, status, role_id, custom_int1, custom_int2, custom_text1)
       VALUES ($1, $2, 'cohort', 0, $3, $4, NULL, $5)`,
      [instanceId, courseId, studentRoleId, cohortId, onLeave],
    );
    return { courseId, cohortId, instanceId, courseCtxId };
  }

  async function ueRow(instanceId: string, userId: string): Promise<Record<string, unknown> | undefined> {
    const res = await pg.query('SELECT * FROM user_enrolments WHERE enrol_id = $1 AND user_id = $2', [instanceId, userId]);
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  async function outboxOf(type: string, userId: string): Promise<Array<{ payload: Record<string, unknown> }>> {
    const res = await pg.query(
      "SELECT payload FROM outbox_events WHERE type = $1 AND payload ->> 'userId' = $2 ORDER BY seq",
      [type, userId],
    );
    return res.rows as Array<{ payload: Record<string, unknown> }>;
  }

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    pg = new Client({ connectionString });
    await pg.connect();
    pool = new Pool({ connectionString });
    const db = drizzle({ client: pool, relations });
    // Cổng outbox phía worker tự cấp cho bề mặt: chèn thẳng vào
    // outbox_events trên schema dùng chung; enqueue ghi trong
    // transaction được truyền vào, enqueueStandalone ghi độc lập —
    // đúng hợp đồng cổng mà package khai báo.
    const outbox: SharedOutboxPort = {
      async enqueue(tx, input) {
        const tenantIdValue = input.tenantId ?? null;
        const payload = tenantIdValue && input.payload['tenantId'] === undefined
          ? { ...input.payload, tenantId: tenantIdValue }
          : input.payload;
        await tx.insert(outboxEvents).values({ aggregate: input.aggregate, type: input.type, payload, tenantId: tenantIdValue });
      },
      async enqueueStandalone(input) {
        const tenantIdValue = input.tenantId ?? null;
        const payload = tenantIdValue && input.payload['tenantId'] === undefined
          ? { ...input.payload, tenantId: tenantIdValue }
          : input.payload;
        await db.insert(outboxEvents).values({ aggregate: input.aggregate, type: input.type, payload, tenantId: tenantIdValue });
      },
    };
    surface = new CohortMaterializationSurface({
      db,
      outbox,
      runInPlatformScope: (fn) => tenantAls.run({ platform: true }, fn),
    });

    tenantId = randomUUID();
    tenantCtxId = randomUUID();
    categoryId = randomUUID();
    studentRoleId = randomUUID();
    teacherRoleId = randomUUID();
    await pg.query('INSERT INTO tenants (id, slug, name, kind) VALUES ($1, $2, $3, $4)', [
      tenantId, `trung-tam-w527-${tenantId.slice(0, 8)}`, 'Trung tâm đặc tả hoá worker 527', 'school',
    ]);
    await pg.query('INSERT INTO course_categories (id, tenant_id, name) VALUES ($1, $2, $3)', [
      categoryId, tenantId, 'Danh mục worker 527',
    ]);
    // Worker không có seed vai trò: dựng hai vai trò archetype cần
    // cho các ca (học viên cho instance, giảng dạy cho ca xung đột).
    await pg.query("INSERT INTO role (id, name, short_name, archetype) VALUES ($1, 'Student', 'student527', 'student')", [studentRoleId]);
    await pg.query("INSERT INTO role (id, name, short_name, archetype) VALUES ($1, 'Teacher', 'teacher527', 'editingteacher')", [teacherRoleId]);
  });

  afterAll(async () => {
    await pg.end();
    await pool.end();
  });

  it('thêm thành viên cohort từ phía worker thì ghi danh đang hiệu lực, cấp vai của instance, phát user_enrolled và đảm bảo membership tenant', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await pg.query('INSERT INTO cohort_members (cohort_id, user_id) VALUES ($1, $2)', [graph.cohortId, userId]);

    await surface.materializeCohortMemberAdded({ cohortId: graph.cohortId, userId });

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue).toBeDefined();
    expect(ue?.status).toBe(0);
    const assignments = await pg.query(
      "SELECT * FROM role_assignments WHERE user_id = $1 AND context_id = $2 AND component = 'enrol' AND item_id = $3",
      [userId, graph.courseCtxId, graph.instanceId],
    );
    expect(assignments.rows).toHaveLength(1);
    expect((assignments.rows[0] as { role_id: string }).role_id).toBe(studentRoleId);
    const enrolledEvents = await outboxOf('user_enrolled', userId);
    expect(enrolledEvents).toHaveLength(1);
    expect(enrolledEvents[0]?.payload.courseId).toBe(graph.courseId);
    const membership = await pg.query(
      'SELECT status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId],
    );
    expect((membership.rows[0] as { status: string } | undefined)?.status).toBe('active');
  });

  it('thêm thành viên đã có cấp quyền giảng dạy bao phủ khoá từ phía worker thì bỏ qua riêng lẻ: không ghi danh, không lỗi', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await pg.query(
      "INSERT INTO role_assignments (role_id, user_id, context_id, component, item_id) VALUES ($1, $2, $3, '', NULL)",
      [teacherRoleId, userId, graph.courseCtxId],
    );
    await pg.query('INSERT INTO cohort_members (cohort_id, user_id) VALUES ($1, $2)', [graph.cohortId, userId]);

    await surface.materializeCohortMemberAdded({ cohortId: graph.cohortId, userId });

    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
    expect(await outboxOf('user_enrolled', userId)).toHaveLength(0);
  });

  it('rời cohort ở chế độ rút khi không còn dữ liệu liên quan từ phía worker thì xoá cứng ghi danh, gỡ vai và phát sự kiện tái tổng hợp', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await pg.query('INSERT INTO cohort_members (cohort_id, user_id) VALUES ($1, $2)', [graph.cohortId, userId]);
    await surface.materializeCohortMemberAdded({ cohortId: graph.cohortId, userId });
    await pg.query('DELETE FROM cohort_members WHERE cohort_id = $1 AND user_id = $2', [graph.cohortId, userId]);

    await surface.materializeCohortMemberRemoved({ cohortId: graph.cohortId, userId });

    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
    const assignments = await pg.query(
      "SELECT * FROM role_assignments WHERE user_id = $1 AND context_id = $2 AND component = 'enrol'",
      [userId, graph.courseCtxId],
    );
    expect(assignments.rows).toHaveLength(0);
    const unenrolledEvents = await outboxOf('user_unenrolled', userId);
    expect(unenrolledEvents).toHaveLength(1);
    expect(unenrolledEvents[0]?.payload.keptData).toBe(false);
    const reaggregationEvents = await outboxOf('course_completion_reaggregation_requested', userId);
    expect(reaggregationEvents).toHaveLength(1);
    expect(reaggregationEvents[0]?.payload.courseId).toBe(graph.courseId);
  });

  it('rời cohort ở chế độ đình chỉ từ phía worker thì ghi danh chuyển đình chỉ, xoá vết người thao tác và phát sự kiện với lý do rời cohort', async () => {
    const graph = await makeCourseGraph('suspend');
    const userId = await insertUser();
    await pg.query('INSERT INTO cohort_members (cohort_id, user_id) VALUES ($1, $2)', [graph.cohortId, userId]);
    await surface.materializeCohortMemberAdded({ cohortId: graph.cohortId, userId });
    await pg.query('DELETE FROM cohort_members WHERE cohort_id = $1 AND user_id = $2', [graph.cohortId, userId]);

    await surface.materializeCohortMemberRemoved({ cohortId: graph.cohortId, userId });

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue?.status).toBe(1);
    expect(ue?.modifier_id).toBeNull();
    const suspendedEvents = await outboxOf('user_enrolment_suspended', userId);
    expect(suspendedEvents).toHaveLength(1);
    expect(suspendedEvents[0]?.payload.reason).toBe('cohort_removed');
  });
});
