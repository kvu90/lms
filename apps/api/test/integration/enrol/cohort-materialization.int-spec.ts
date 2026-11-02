import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CohortMaterializationSurface, type SharedOutboxPort } from '@lms/enrol';
import Redis from 'ioredis';
import { createTestApp } from '../../support/identity-access-helpers';
import { CompletionReaggregationOutboxConsumer } from '../../../src/modules/completion/completion-reaggregation-outbox.consumer';
import { CompletionService } from '../../../src/modules/completion/completion.service';
import { SpaceDatabaseService } from '../../../src/db/routing/space-database.service';
import { EnrolService } from '../../../src/modules/enrol/enrol.service';
import { OutboxService } from '../../../src/infra/events/outbox.service';
import { tenantAls } from '../../../src/modules/tenants/tenant-als';

/**
 * Spec đặc tả hoá (characterization) cho bề mặt vật chất hoá cohort
 * dùng chung `@lms/enrol` ở phía API (issue #527).
 *
 * Bối cảnh: đường đồng bộ cohort — thành viên cohort được vật chất
 * hoá thành ghi danh cấp khoá, rời cohort thì ghi danh bị rút hoặc
 * đình chỉ — trước đây sống trọn trong `EnrolService` của API và
 * phụ thuộc hai cơ chế đăng ký lúc khởi tạo tiến trình (probe dữ
 * liệu liên quan do CompletionModule/GradesModule đăng ký, hook tái
 * tổng hợp hoàn thành do CompletionModule đăng ký). Sau khi trích
 * xuất, toàn bộ funnel chạy qua bề mặt dùng chung ở tầng dữ liệu;
 * spec này ghim NGUYÊN hành vi quan sát được của đường đồng bộ qua
 * đúng hai handler sự kiện của API (`EnrolService.onCohortMemberAdded`
 * /`onCohortMemberRemoved`, cũng là hai handler mà consumer outbox
 * đồng bộ cohort của API gọi):
 *
 * - thêm thành viên: ghi danh ACTIVE, gán vai của instance tại
 *   context khoá với truy vết nguồn của instance, sự kiện
 *   `user_enrolled` + `role_assigned`, membership active tại tenant
 *   của khoá, và xếp vào nhóm đích của instance khi instance có
 *   nhóm đích;
 * - thành viên vi phạm chốt tách vai (đã có cấp quyền giảng dạy bao
 *   phủ khoá) bị bỏ qua riêng lẻ, không lỗi, không ghi danh;
 * - sự kiện phát lại lệch trạng thái hiện tại của `cohort_members`
 *   là no-op ở cả hai chiều (thêm cho người đã rời, rời cho người
 *   vẫn còn trong cohort);
 * - rời cohort ở chế độ suspend: ghi danh SUSPENDED với vết người
 *   thao tác bị xoá về null và sự kiện đình chỉ mang lý do
 *   `cohort_removed`;
 * - rời cohort ở chế độ unenrol: ma trận giữ/xoá theo dữ liệu liên
 *   quan (không dữ liệu → xoá cứng; chỉ hoàn thành → giữ WITHDRAWN;
 *   chỉ điểm → giữ WITHDRAWN; cả hai → giữ WITHDRAWN), sự kiện
 *   `user_unenrolled` mang đúng cờ `keptData`, gỡ đúng dòng gán do
 *   instance cấp kèm sự kiện `role_unassigned`, và MỌI lần rút đều
 *   phát sự kiện `course_completion_reaggregation_requested`;
 * - consumer tái tổng hợp của CompletionModule tiêu thụ sự kiện đó
 *   qua mốc seq riêng và biến một khoá có tiêu chí 'unenrol' thành
 *   hoàn thành cho người vừa rời (trước khi consumer chạy thì chưa
 *   hoàn thành — đường tái tổng hợp nay là đường sự kiện, không còn
 *   là hook đồng bộ trong lúc rút);
 * - consumer khởi tạo lần đầu (watermark chưa từng được lưu, khoá
 *   Redis vắng) vẫn tiêu thụ yêu cầu tái tổng hợp đã ghi TRƯỚC lúc
 *   khởi tạo — loại sự kiện này sinh ra cùng chính consumer nên
 *   không có lịch sử của chính nó để neo qua như khuôn consumer
 *   của các loại sự kiện cũ;
 * - ở nhánh xoá cứng, việc xoá dòng ghi danh nằm trong cùng
 *   transaction với hai sự kiện: sự kiện tái tổng hợp không bao
 *   giờ nhìn thấy được trong lúc dòng ghi danh còn tồn tại, và
 *   transaction rollback thì cả việc xoá lẫn hai sự kiện cùng
 *   biến mất, dòng ghi danh còn nguyên;
 * - funnel trực tiếp `enrolUserInternal` vẫn từ chối ghi danh học
 *   viên cho người có cấp quyền giảng dạy bao phủ khoá bằng lỗi 400
 *   mã `access.role_context_conflict`.
 *
 * Fixture dựng bằng SQL trực tiếp (tenant/context/khoá/cohort/
 * instance/người dùng) với id ngẫu nhiên theo từng ca để các ca
 * không giẫm nhau; khẳng định đọc thẳng từ cơ sở dữ liệu.
 */

interface ConsumerInternals {
  watermark: number | null;
  timer: NodeJS.Timeout | null;
  tick(): Promise<void>;
}

interface CourseGraph {
  courseId: string;
  cohortId: string;
  instanceId: string;
  courseCtxId: string;
  groupId: string | null;
}

describe('Vật chất hoá cohort dùng chung — đặc tả hoá hành vi ở phía API', () => {
  let app: INestApplication;
  let pg: Client;
  let enrol: EnrolService;
  let consumer: ConsumerInternals;
  let systemCtxId: string;
  let tenantId: string;
  let tenantCtxId: string;
  let categoryId: string;
  let studentRoleId: string;
  let teacherRoleId: string;

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    const tag = id.replaceAll('-', '').slice(0, 12);
    await pg.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [id, `u527_${tag}`, `u527_${tag}@example.test`]);
    return id;
  }

  async function makeCourseGraph(opts: { onLeave: 'suspend' | 'unenrol'; withGroup?: boolean }): Promise<CourseGraph> {
    const courseId = randomUUID();
    const cohortId = randomUUID();
    const instanceId = randomUUID();
    const courseCtxId = randomUUID();
    const groupId = opts.withGroup ? randomUUID() : null;
    await pg.query(
      'INSERT INTO course (id, tenant_id, category, full_name, short_name, is_template) VALUES ($1, $2, $3, $4, $5, true)',
      [courseId, tenantId, categoryId, 'Khoá đặc tả hoá 527', `K527-${courseId.slice(0, 8)}`],
    );
    await pg.query(
      'INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 50, $2, $3, 3)',
      [courseCtxId, courseId, `/${systemCtxId}/${tenantCtxId}/${courseCtxId}`],
    );
    await pg.query(
      'INSERT INTO cohort (id, tenant_id, name, context_id) VALUES ($1, $2, $3, $4)',
      [cohortId, tenantId, 'Cohort 527', tenantCtxId],
    );
    if (groupId) {
      await pg.query('INSERT INTO course_groups (id, course_id, name) VALUES ($1, $2, $3)', [groupId, courseId, 'Cả lớp']);
    }
    await pg.query(
      `INSERT INTO enrol (id, course_id, enrol, status, role_id, custom_int1, custom_int2, custom_text1)
       VALUES ($1, $2, 'cohort', 0, $3, $4, $5, $6)`,
      [instanceId, courseId, studentRoleId, cohortId, groupId, opts.onLeave],
    );
    return { courseId, cohortId, instanceId, courseCtxId, groupId };
  }

  async function addMember(graph: CourseGraph, userId: string): Promise<void> {
    await pg.query('INSERT INTO cohort_members (cohort_id, user_id) VALUES ($1, $2)', [graph.cohortId, userId]);
    await enrol.onCohortMemberAdded({ cohortId: graph.cohortId, userId });
  }

  async function removeMember(graph: CourseGraph, userId: string): Promise<void> {
    await pg.query('DELETE FROM cohort_members WHERE cohort_id = $1 AND user_id = $2', [graph.cohortId, userId]);
    await enrol.onCohortMemberRemoved({ cohortId: graph.cohortId, userId });
  }

  async function ueRow(instanceId: string, userId: string): Promise<Record<string, unknown> | undefined> {
    const res = await pg.query('SELECT * FROM user_enrolments WHERE enrol_id = $1 AND user_id = $2', [instanceId, userId]);
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  async function outboxOf(type: string, userId: string): Promise<Array<{ payload: Record<string, unknown>; seq: string }>> {
    const res = await pg.query(
      "SELECT payload, seq FROM outbox_events WHERE type = $1 AND payload ->> 'userId' = $2 ORDER BY seq",
      [type, userId],
    );
    return res.rows as Array<{ payload: Record<string, unknown>; seq: string }>;
  }

  async function enrolAssignments(graph: CourseGraph, userId: string): Promise<Array<Record<string, unknown>>> {
    const res = await pg.query(
      "SELECT * FROM role_assignments WHERE user_id = $1 AND context_id = $2 AND component = 'enrol'",
      [userId, graph.courseCtxId],
    );
    return res.rows as Array<Record<string, unknown>>;
  }

  /**
   * Dựng hình dạng dòng enrol (camelCase) mà funnel nhận từ các
   * đường gọi trong tiến trình — cùng khuôn ca kiểm funnel trực
   * tiếp ở trên, dùng cho các ca lái thẳng bề mặt dùng chung.
   */
  function instanceLiteral(graph: CourseGraph): Parameters<CohortMaterializationSurface['unenrolInternal']>[0] {
    return {
      id: graph.instanceId, courseId: graph.courseId, enrol: 'cohort', status: 0,
      roleId: studentRoleId, enrolPeriod: 0, customInt1: graph.cohortId,
      customInt2: graph.groupId, customText1: 'unenrol',
    } as unknown as Parameters<CohortMaterializationSurface['unenrolInternal']>[0];
  }

  beforeAll(async () => {
    app = await createTestApp();
    enrol = app.get(EnrolService);
    consumer = app.get(CompletionReaggregationOutboxConsumer) as unknown as ConsumerInternals;
    // Dừng nhịp tự động của consumer tái tổng hợp: spec lái tick()
    // thủ công để tất định, theo khuôn các spec consumer hiện hữu.
    if (consumer.timer) {
      clearInterval(consumer.timer);
      consumer.timer = null;
    }
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const sys = await pg.query("SELECT id FROM context WHERE context_level = 10 ORDER BY path LIMIT 1");
    systemCtxId = (sys.rows[0] as { id: string }).id;
    const student = await pg.query("SELECT id FROM role WHERE short_name = 'student'");
    studentRoleId = (student.rows[0] as { id: string }).id;
    const teacher = await pg.query("SELECT id FROM role WHERE short_name = 'editingteacher'");
    teacherRoleId = (teacher.rows[0] as { id: string }).id;
    tenantId = randomUUID();
    tenantCtxId = randomUUID();
    categoryId = randomUUID();
    await pg.query('INSERT INTO tenants (id, slug, name, kind) VALUES ($1, $2, $3, $4)', [
      tenantId, `trung-tam-527-${tenantId.slice(0, 8)}`, 'Trung tâm đặc tả hoá 527', 'school',
    ]);
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 20, $2, $3, 2)', [
      tenantCtxId, tenantId, `/${systemCtxId}/${tenantCtxId}`,
    ]);
    await pg.query('INSERT INTO course_categories (id, tenant_id, name) VALUES ($1, $2, $3)', [
      categoryId, tenantId, 'Danh mục 527',
    ]);
  });

  afterAll(async () => {
    await pg.end();
    await app.close();
  });

  it('thêm thành viên cohort thì ghi danh đang hiệu lực, cấp vai của instance, phát user_enrolled và đảm bảo membership tenant', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();

    await addMember(graph, userId);

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue).toBeDefined();
    expect(ue?.status).toBe(0);
    const assignments = await enrolAssignments(graph, userId);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.role_id).toBe(studentRoleId);
    expect(assignments[0]?.item_id).toBe(graph.instanceId);
    const enrolledEvents = await outboxOf('user_enrolled', userId);
    expect(enrolledEvents).toHaveLength(1);
    expect(enrolledEvents[0]?.payload.courseId).toBe(graph.courseId);
    expect(enrolledEvents[0]?.payload.instanceId).toBe(graph.instanceId);
    const assignedEvents = await outboxOf('role_assigned', userId);
    expect(assignedEvents.some((e) => e.payload.component === 'enrol' && e.payload.itemId === graph.instanceId)).toBe(true);
    const membership = await pg.query(
      'SELECT status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId],
    );
    expect((membership.rows[0] as { status: string } | undefined)?.status).toBe('active');
  });

  it('thêm thành viên qua instance có nhóm đích thì xếp người dùng vào nhóm đó', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol', withGroup: true });
    const userId = await insertUser();

    await addMember(graph, userId);

    const res = await pg.query(
      "SELECT * FROM groups_members WHERE group_id = $1 AND user_id = $2 AND component = 'enrol_cohort'",
      [graph.groupId, userId],
    );
    expect(res.rows).toHaveLength(1);
  });

  it('thêm thành viên đã có cấp quyền giảng dạy bao phủ khoá thì bỏ qua riêng lẻ: không ghi danh, không lỗi', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    // Gán tay vai giảng dạy tại context khoá (nguồn không phải ghi danh).
    await pg.query(
      "INSERT INTO role_assignments (role_id, user_id, context_id, component, item_id) VALUES ($1, $2, $3, '', NULL)",
      [teacherRoleId, userId, graph.courseCtxId],
    );

    await addMember(graph, userId);

    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
    expect(await enrolAssignments(graph, userId)).toHaveLength(0);
    expect(await outboxOf('user_enrolled', userId)).toHaveLength(0);
  });

  it('sự kiện thêm cho người hiện không còn trong cohort thì không ghi danh', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();

    // Không chèn cohort_members: sự kiện tới muộn sau khi user đã rời.
    await enrol.onCohortMemberAdded({ cohortId: graph.cohortId, userId });

    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
  });

  it('ghi danh trực tiếp qua funnel cho người có cấp quyền giảng dạy bao phủ khoá thì bị từ chối 400 với mã xung đột vai', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    await pg.query(
      "INSERT INTO role_assignments (role_id, user_id, context_id, component, item_id) VALUES ($1, $2, $3, '', NULL)",
      [teacherRoleId, userId, graph.courseCtxId],
    );
    const instanceRes = await pg.query('SELECT * FROM enrol WHERE id = $1', [graph.instanceId]);
    expect(instanceRes.rows).toHaveLength(1);
    // Dựng đúng hình dạng EnrolRow (camelCase) mà funnel nhận từ các
    // đường gọi trong tiến trình — chỉ các trường funnel thật sự đọc.
    const instance = {
      id: graph.instanceId, courseId: graph.courseId, enrol: 'cohort', status: 0,
      roleId: studentRoleId, enrolPeriod: 0, customInt1: graph.cohortId,
      customInt2: null, customText1: 'unenrol',
    } as unknown as Parameters<EnrolService['enrolUserInternal']>[0];

    const err = await enrol.enrolUserInternal(instance, userId).catch((e: unknown) => e) as {
      getStatus?: () => number; getResponse?: () => { code?: string };
    };
    expect(err.getStatus?.()).toBe(400);
    expect(err.getResponse?.().code).toBe('access.role_context_conflict');
    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
  });

  it('rời cohort ở chế độ đình chỉ thì ghi danh chuyển đình chỉ, xoá vết người thao tác và phát sự kiện với lý do rời cohort', async () => {
    const graph = await makeCourseGraph({ onLeave: 'suspend' });
    const userId = await insertUser();
    await addMember(graph, userId);

    await removeMember(graph, userId);

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue).toBeDefined();
    expect(ue?.status).toBe(1);
    expect(ue?.modifier_id).toBeNull();
    const suspendedEvents = await outboxOf('user_enrolment_suspended', userId);
    expect(suspendedEvents).toHaveLength(1);
    expect(suspendedEvents[0]?.payload.reason).toBe('cohort_removed');
    expect(suspendedEvents[0]?.payload.courseId).toBe(graph.courseId);
  });

  it('sự kiện rời cho người vẫn còn trong cohort thì giữ nguyên ghi danh', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    await addMember(graph, userId);

    // Không xoá cohort_members: sự kiện rời phát lại muộn là no-op.
    await enrol.onCohortMemberRemoved({ cohortId: graph.cohortId, userId });

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue?.status).toBe(0);
    expect(await outboxOf('user_unenrolled', userId)).toHaveLength(0);
  });

  it('rời cohort ở chế độ rút khi không còn dữ liệu liên quan thì xoá cứng ghi danh, gỡ vai của instance và phát đủ sự kiện', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    await addMember(graph, userId);

    await removeMember(graph, userId);

    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
    expect(await enrolAssignments(graph, userId)).toHaveLength(0);
    const unenrolledEvents = await outboxOf('user_unenrolled', userId);
    expect(unenrolledEvents).toHaveLength(1);
    expect(unenrolledEvents[0]?.payload.keptData).toBe(false);
    const unassignedEvents = await outboxOf('role_unassigned', userId);
    expect(unassignedEvents.some((e) => e.payload.contextId === graph.courseCtxId)).toBe(true);
    const reaggregationEvents = await outboxOf('course_completion_reaggregation_requested', userId);
    expect(reaggregationEvents).toHaveLength(1);
    expect(reaggregationEvents[0]?.payload.courseId).toBe(graph.courseId);
  });

  it('rời cohort ở chế độ rút khi chỉ có dữ liệu hoàn thành thì giữ ghi danh dạng đã rút và keptData là true', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    await addMember(graph, userId);
    const sectionId = randomUUID();
    const cmId = randomUUID();
    await pg.query('INSERT INTO course_sections (id, course, section) VALUES ($1, $2, 0)', [sectionId, graph.courseId]);
    await pg.query(
      'INSERT INTO course_modules (id, course, section, component) VALUES ($1, $2, $3, $4)',
      [cmId, graph.courseId, sectionId, 'page'],
    );
    await pg.query(
      'INSERT INTO course_modules_completion (course_module_id, user_id, completion_state) VALUES ($1, $2, 1)',
      [cmId, userId],
    );

    await removeMember(graph, userId);

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue?.status).toBe(2);
    const unenrolledEvents = await outboxOf('user_unenrolled', userId);
    expect(unenrolledEvents[0]?.payload.keptData).toBe(true);
    expect(await outboxOf('course_completion_reaggregation_requested', userId)).toHaveLength(1);
  });

  it('rời cohort ở chế độ rút khi chỉ có dữ liệu điểm thì giữ ghi danh dạng đã rút và keptData là true', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    await addMember(graph, userId);
    const itemId = randomUUID();
    await pg.query('INSERT INTO grade_items (id, course_id) VALUES ($1, $2)', [itemId, graph.courseId]);
    await pg.query('INSERT INTO grade_grades (item_id, user_id, final_grade) VALUES ($1, $2, 8.5)', [itemId, userId]);

    await removeMember(graph, userId);

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue?.status).toBe(2);
    const unenrolledEvents = await outboxOf('user_unenrolled', userId);
    expect(unenrolledEvents[0]?.payload.keptData).toBe(true);
  });

  it('rời cohort ở chế độ rút khi có cả dữ liệu hoàn thành và dữ liệu điểm thì giữ ghi danh dạng đã rút', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    await addMember(graph, userId);
    const sectionId = randomUUID();
    const cmId = randomUUID();
    await pg.query('INSERT INTO course_sections (id, course, section) VALUES ($1, $2, 0)', [sectionId, graph.courseId]);
    await pg.query(
      'INSERT INTO course_modules (id, course, section, component) VALUES ($1, $2, $3, $4)',
      [cmId, graph.courseId, sectionId, 'page'],
    );
    await pg.query(
      'INSERT INTO course_modules_completion (course_module_id, user_id, completion_state) VALUES ($1, $2, 1)',
      [cmId, userId],
    );
    const itemId = randomUUID();
    await pg.query('INSERT INTO grade_items (id, course_id) VALUES ($1, $2)', [itemId, graph.courseId]);
    await pg.query('INSERT INTO grade_grades (item_id, user_id, final_grade) VALUES ($1, $2, 7)', [itemId, userId]);

    await removeMember(graph, userId);

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue?.status).toBe(2);
    const unenrolledEvents = await outboxOf('user_unenrolled', userId);
    expect(unenrolledEvents[0]?.payload.keptData).toBe(true);
  });

  it('consumer tái tổng hợp biến khoá có tiêu chí rời khoá thành hoàn thành cho người vừa rời, qua sự kiện outbox', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    await pg.query(
      "INSERT INTO course_completion_criteria (course, criteria_type) VALUES ($1, 'unenrol')",
      [graph.courseId],
    );
    await addMember(graph, userId);
    const seqRes = await pg.query('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM outbox_events');
    const seqBeforeRemoval = Number((seqRes.rows[0] as { max_seq: string }).max_seq);

    await removeMember(graph, userId);

    // Trước khi consumer chạy: chưa có hoàn thành — đường tái tổng
    // hợp nay đi qua sự kiện, không còn chạy đồng bộ trong lúc rút.
    const before = await pg.query(
      "SELECT status FROM course_completions WHERE user_id = $1 AND course = $2 AND status = 'complete'",
      [userId, graph.courseId],
    );
    expect(before.rows).toHaveLength(0);

    consumer.watermark = seqBeforeRemoval;
    await consumer.tick();

    const after = await pg.query(
      'SELECT status FROM course_completions WHERE user_id = $1 AND course = $2',
      [userId, graph.courseId],
    );
    expect((after.rows[0] as { status: string } | undefined)?.status).toBe('complete');
  });

  it('consumer khởi tạo lần đầu khi khoá watermark chưa từng được lưu thì vẫn xử lý yêu cầu tái tổng hợp đã ghi trước lúc khởi tạo', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    await pg.query(
      "INSERT INTO course_completion_criteria (course, criteria_type) VALUES ($1, 'unenrol')",
      [graph.courseId],
    );
    await addMember(graph, userId);
    await removeMember(graph, userId);

    // Yêu cầu tái tổng hợp đã nằm trong outbox TRƯỚC khi consumer
    // khởi tạo, và trước khi consumer chạy thì khoá chưa hoàn thành.
    expect(await outboxOf('course_completion_reaggregation_requested', userId)).toHaveLength(1);
    const before = await pg.query(
      "SELECT status FROM course_completions WHERE user_id = $1 AND course = $2 AND status = 'complete'",
      [userId, graph.courseId],
    );
    expect(before.rows).toHaveLength(0);

    // Trạng thái khởi tạo thật của một tiến trình mới: watermark
    // trong bộ nhớ chưa có và khoá watermark trong Redis vắng —
    // consumer phải tự quyết mốc bắt đầu qua đường OnModuleInit
    // của chính nó, không được neo qua yêu cầu đã ghi ở trên.
    const databaseName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, '');
    const redis = new Redis(process.env.REDIS_URL!);
    await redis.del(`lms:completion-reaggregation:${databaseName}:seq`);
    const fresh = new CompletionReaggregationOutboxConsumer(
      app.get(ConfigService),
      app.get(SpaceDatabaseService).routedDatabase,
      app.get(CompletionService),
    );
    try {
      fresh.onModuleInit();
      // Consumer quét theo nhịp 1 giây của chính nó: chờ nó tiêu
      // thụ yêu cầu đã ghi trước và biến khoá thành hoàn thành.
      const deadline = Date.now() + 20_000;
      let status: string | undefined;
      while (Date.now() < deadline) {
        const res = await pg.query(
          'SELECT status FROM course_completions WHERE user_id = $1 AND course = $2',
          [userId, graph.courseId],
        );
        status = (res.rows[0] as { status: string } | undefined)?.status;
        if (status === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(status).toBe('complete');
    } finally {
      await fresh.onModuleDestroy();
      await redis.quit();
    }
  });

  it('rời khoá ở nhánh xoá cứng thì sự kiện tái tổng hợp chỉ nhìn thấy được sau khi dòng ghi danh đã biến mất', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    await addMember(graph, userId);

    // Bề mặt dựng bằng tay cầm DB bọc quanh tay cầm thật: ngay khi
    // transaction của unenrolInternal commit xong — thời điểm sự
    // kiện trở nên nhìn thấy được với mọi kết nối khác — mà TRƯỚC
    // khi hàm chạy bất kỳ bước nào tiếp theo, đọc lại từ kết nối
    // độc lập của spec xem sự kiện và dòng ghi danh có cùng tồn
    // tại hay không. Consumer quét mỗi giây chỉ được phép quan
    // sát sự kiện khi dòng ghi danh đã biến mất, vì tiêu chí
    // 'unenrol' đọc chính dòng đó.
    const realDb = app.get(SpaceDatabaseService).routedDatabase;
    const observed: { current: { eventVisible: boolean; enrolmentPresent: boolean } | null } = { current: null };
    const wrappedDb = new Proxy(realDb, {
      get(target, prop) {
        if (prop === 'transaction') {
          return async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
            const result = await Reflect.apply(target.transaction, target, [callback]) as unknown;
            if (observed.current === null) {
              const ev = await pg.query(
                "SELECT COUNT(*)::int AS n FROM outbox_events WHERE type = 'course_completion_reaggregation_requested' AND payload ->> 'userId' = $1",
                [userId],
              );
              observed.current = {
                eventVisible: Number((ev.rows[0] as { n: number }).n) > 0,
                enrolmentPresent: (await ueRow(graph.instanceId, userId)) !== undefined,
              };
            }
            return result;
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
      },
    });
    const surface = new CohortMaterializationSurface({
      db: wrappedDb,
      outbox: app.get(OutboxService),
      runInPlatformScope: (fn) => tenantAls.run({ platform: true }, fn),
    });

    await surface.unenrolInternal(instanceLiteral(graph), userId);

    expect(observed.current).not.toBeNull();
    expect(observed.current?.eventVisible).toBe(true);
    expect(observed.current?.enrolmentPresent).toBe(false);
    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
    expect(await enrolAssignments(graph, userId)).toHaveLength(0);
    expect(await outboxOf('course_completion_reaggregation_requested', userId)).toHaveLength(1);
  });

  it('rời khoá ở nhánh xoá cứng mà transaction rollback thì không phát sự kiện nào và dòng ghi danh còn nguyên', async () => {
    const graph = await makeCourseGraph({ onLeave: 'unenrol' });
    const userId = await insertUser();
    await addMember(graph, userId);

    // Cổng outbox giả lập lỗi ngay khi ghi sự kiện tái tổng hợp —
    // sự kiện này được ghi sau lệnh xoá trong cùng transaction,
    // nên rollback phải cuốn theo cả việc xoá lẫn sự kiện
    // user_unenrolled đã ghi trước đó trong transaction.
    const realOutbox = app.get(OutboxService);
    const failingOutbox: SharedOutboxPort = {
      enqueue: async (tx, input) => {
        if (input.type === 'course_completion_reaggregation_requested') {
          throw new Error('Lỗi giả lập: ghi sự kiện tái tổng hợp hoàn thành thất bại');
        }
        await realOutbox.enqueue(tx, input);
      },
      enqueueStandalone: async (input) => {
        await realOutbox.enqueueStandalone(input);
      },
    };
    const surface = new CohortMaterializationSurface({
      db: app.get(SpaceDatabaseService).routedDatabase,
      outbox: failingOutbox,
      runInPlatformScope: (fn) => tenantAls.run({ platform: true }, fn),
    });

    await expect(surface.unenrolInternal(instanceLiteral(graph), userId)).rejects.toThrow(
      'Lỗi giả lập: ghi sự kiện tái tổng hợp hoàn thành thất bại',
    );

    const ue = await ueRow(graph.instanceId, userId);
    expect(ue).toBeDefined();
    expect(ue?.status).toBe(0);
    expect(await enrolAssignments(graph, userId)).toHaveLength(1);
    expect(await outboxOf('user_unenrolled', userId)).toHaveLength(0);
    expect(await outboxOf('course_completion_reaggregation_requested', userId)).toHaveLength(0);
  });
});
