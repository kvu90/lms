import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from '@lms/db';
import { CompletionRecalculateProcessor } from '../../../src/processors/completion-recalculate.processor';
import { EnrolExpiryProcessor } from '../../../src/processors/enrol-expiry.processor';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Các job enrol & completion của worker. Oracles nghiệp vụ: ngữ nghĩa hết hạn ghi danh từ
 * enrol/tests/enrollib_test.php + report §2#5 (hết hạn ⇒ không còn active), và
 * reaggregation của completion từ lib/tests/completionlib_test.php
 * ::test_aggregate_completions (thay đổi criteria ⇒ tính lại có kiểm soát).
 * Các dòng được chèn trực tiếp vì schema API chuẩn sở hữu việc tạo;
 * các processor được kiểm thử vận hành trên góc nhìn của worker về cùng các bảng đó.
 *
 * Từ lát 2 của issue #294, spec này boot WorkerModule qua harness
 * role thường (`test/ordinary-worker-module.ts`): module chạy bằng
 * role NOSUPERUSER/NOBYPASSRLS như production, fixture và đọc kiểm
 * chứng đi qua kết nối quản trị của harness — khẳng định nghiệp vụ
 * của spec không đổi.
 */
describe('Ghi danh và hoàn thành của worker: bộ xử lý enrol-expiry + completion-recalculate', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: any;
  const suffix = Date.now();
  const userId = `01900000-0000-7000-8000-${String(900000 + (suffix % 10000)).padStart(12, '0')}`;
  const userIdB = `01900000-0000-7000-8000-${String(900100 + (suffix % 10000)).padStart(12, '0')}`;
  let instanceId = '';
  let courseId = '';
  let cmId = '';


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
    // Tạo category+course+section thật qua SQL thô (các FK trong DB dùng chung đòi hỏi dòng thật;
    // góc nhìn schema của worker chủ ý chỉ mang các bảng mà processor của nó chạm tới).
    const catRows = await sql`insert into course_categories (name, path, tenant_id) values (${`worker-cat-${suffix}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`.execute(db);
    const catId = (catRows.rows[0] as { id: string }).id;
    const courseRows = await sql`insert into course (category, tenant_id, full_name, short_name, class_id) values (${catId}, (select tenant_id from course_categories where id = ${catId}), 'Worker course', ${`wk${suffix}`}, ${await fixtureClassId()}) returning id`.execute(db);
    courseId = (courseRows.rows[0] as { id: string }).id;
    const sectionRows = await sql`insert into course_sections (course, section) values (${courseId}, 0) returning id`.execute(db);
    const sectionId = (sectionRows.rows[0] as { id: string }).id;
    const inst = await db.insertInto('enrol').values({ course_id: courseId, enrol: 'manual', status: 0 }).returningAll().executeTakeFirstOrThrow();
    instanceId = inst.id;
    const cmRows = await sql`insert into course_modules (course, section, component) values (${courseId}, ${sectionId}, 'mod_page') returning id`.execute(db);
    cmId = (cmRows.rows[0] as { id: string }).id;
  });
  afterAll(async () => { await harness.close(); });

  it('enrol-expiry chuyển ghi danh ACTIVE đã quá timeEnd thành SUSPENDED và ghi sự kiện outbox; ghi danh tương lai không động tới', async () => {
    const past = new Date(Date.now() - 3600_000);
    const future = new Date(Date.now() + 3600_000);
    const expired = await db.insertInto('user_enrolments').values({ enrol_id: instanceId, user_id: userId, status: 0, time_start: new Date(Date.now() - 7200_000), time_end: past }).returningAll().executeTakeFirstOrThrow();
    const alive = await db.insertInto('user_enrolments').values({ enrol_id: instanceId, user_id: userIdB, status: 0, time_start: new Date(), time_end: future }).returningAll().executeTakeFirstOrThrow();
    const processor = context.get(EnrolExpiryProcessor);
    const result = await processor.process({ data: {} } as never);
    expect(result.suspendedIds).toContain(expired.id);
    expect(result.suspendedIds).not.toContain(alive.id);
    const row = await db.selectFrom('user_enrolments').selectAll().where('id', '=', expired.id).executeTakeFirst();
    expect(row.status).toBe(1);
    const events = await db.selectFrom('outbox_events').selectAll().where('type', '=', 'user_enrolment_suspended').execute();
    expect((events as { payload: { enrolmentId?: string } }[]).some((e) => e.payload.enrolmentId === expired.id)).toBe(true);
    // Idempotent: lượt quét thứ hai không chuyển nó lần nữa.
    const second = await processor.process({ data: {} } as never);
    expect(second.suspendedIds).not.toContain(expired.id);
  });

  it('cảnh báo enrol-expiry: ghi danh ACTIVE hết hạn trong cửa sổ cảnh báo nhận đúng một sự kiện outbox enrol_expiry_warning; ngoài cửa sổ thì không có (issue #49)', async () => {
    const processor = context.get(EnrolExpiryProcessor);
    const inWindow = new Date(Date.now() + 3 * 24 * 3600_000);
    const outWindow = new Date(Date.now() + 30 * 24 * 3600_000);
    // Offset 900400/900500: 900200/900300 đã thuộc về userIdC/userIdD
    // của test criteria-types phía dưới (trùng (enrol_id, user_id) sẽ
    // vỡ ràng buộc duy nhất của user_enrolments).
    const userC = `01900000-0000-7000-8000-${String(900400 + (suffix % 10000)).padStart(12, '0')}`;
    const userD = `01900000-0000-7000-8000-${String(900500 + (suffix % 10000)).padStart(12, '0')}`;
    const soon = await db.insertInto('user_enrolments').values({ enrol_id: instanceId, user_id: userC, status: 0, time_start: new Date(), time_end: inWindow }).returningAll().executeTakeFirstOrThrow();
    const later = await db.insertInto('user_enrolments').values({ enrol_id: instanceId, user_id: userD, status: 0, time_start: new Date(), time_end: outWindow }).returningAll().executeTakeFirstOrThrow();
    const warningsFor = async (enrolmentId: string) => (await db.selectFrom('outbox_events').selectAll()
      .where('type', '=', 'enrol_expiry_warning').execute())
      .filter((e: { payload: { enrolmentId?: string } }) => e.payload.enrolmentId === enrolmentId);
    const first = await processor.process({ data: {} } as never);
    expect(first.warnedIds).toContain(soon.id);
    expect(first.warnedIds).not.toContain(later.id);
    const events = await warningsFor(soon.id) as { payload: { userId?: string; courseId?: string } }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.userId).toBe(userC);
    expect(events[0]!.payload.courseId).toBe(courseId);
    expect(await warningsFor(later.id)).toHaveLength(0);
    // Quét lại không phát trùng cảnh báo cho cùng một ghi danh.
    const second = await processor.process({ data: {} } as never);
    expect(second.warnedIds).not.toContain(soon.id);
    expect(await warningsFor(soon.id)).toHaveLength(1);
  });

  it('completion-recalculate tính lại hoàn thành khoá học từ tiêu chí hiện tại (AND), và mở lại khi tiêu chí thắt chặt', async () => {
    const processor = context.get(CompletionRecalculateProcessor);
    await db.insertInto('course_modules_completion').values({ course_module_id: cmId, user_id: userId, completion_state: 1, viewed: true }).execute();
    await db.insertInto('course_completion_settings').values({ course: courseId, method: 1 }).onConflict((oc: any) => oc.doNothing()).execute();
    await db.insertInto('course_completion_criteria').values({ course: courseId, criteria_type: 'module', module_instance: cmId, sort_order: 0 }).execute();
    const result = await processor.process({ data: { courseId } } as never);
    expect(result.users).toBeGreaterThan(0);
    let cc = await db.selectFrom('course_completions').selectAll()
      .where('course', '=', courseId).where('user_id', '=', userId).executeTakeFirst();
    expect(cc.status).toBe('complete');
    expect(cc.time_completed).toBeTruthy();

    // Thêm một tiêu chí date trong tương lai ⇒ việc tính lại mở lại completion.
    await db.insertInto('course_completion_criteria').values({ course: courseId, criteria_type: 'date', date: new Date('2100-01-01'), sort_order: 1 }).execute();
    await processor.process({ data: { courseId } } as never);
    cc = await db.selectFrom('course_completions').selectAll()
      .where('course', '=', courseId).where('user_id', '=', userId).executeTakeFirst();
    expect(cc.status).not.toBe('complete');
    expect(cc.time_completed).toBeNull();
  });

  it('completion-recalculate đánh giá các loại tiêu chí Moodle còn lại (course, self, duration, unenrol) như bộ đánh giá API', async () => {
    const processor = context.get(CompletionRecalculateProcessor);
    const statusOf = async (uid: string) => {
      const row = await db.selectFrom('course_completions').selectAll()
        .where('course', '=', courseId).where('user_id', '=', uid).executeTakeFirst();
      return row?.status as string | undefined;
    };
    const replaceCriteria = async (rows: Record<string, unknown>[]) => {
      await db.deleteFrom('course_completion_criteria').where('course', '=', courseId).execute();
      for (const [i, r] of rows.entries()) {
        await db.insertInto('course_completion_criteria').values({ course: courseId, sort_order: i, ...r }).execute();
      }
    };

    // course (tiên quyết): chưa hoàn thành cho tới khi dòng completion đã lưu
    // của khoá học tiên quyết hoàn thành.
    const prereqRows = await sql`insert into course (category, tenant_id, full_name, short_name, class_id) values ((select category from course where id = ${courseId}), (select tenant_id from course where id = ${courseId}), 'Prereq course', ${`wkpre${suffix}`}, ${await fixtureClassId()}) returning id`.execute(db);
    const prereqId = (prereqRows.rows[0] as { id: string }).id;
    await replaceCriteria([{ criteria_type: 'course', course_instance: prereqId }]);
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).not.toBe('complete');
    await db.insertInto('course_completions').values({ user_id: userId, course: prereqId, status: 'complete', time_completed: new Date() }).execute();
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).toBe('complete');

    // self: cần một dòng bằng chứng crit_compl cho tiêu chí.
    await db.deleteFrom('course_completion_criteria').where('course', '=', courseId).execute();
    const selfCritRow = await db.insertInto('course_completion_criteria')
      .values({ course: courseId, criteria_type: 'self', sort_order: 0 }).returningAll().executeTakeFirstOrThrow();
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).not.toBe('complete');
    await db.insertInto('course_completion_crit_compl').values({ criteria_id: selfCritRow.id, user_id: userId, marked_by: userId }).execute();
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).toBe('complete');

    // role: dùng chung đường bằng chứng markedKeys với self, nhưng
    // dòng crit_compl được ghi bởi một MARKER (markedBy ≠ người học) —
    // "manual completion by others". Worker chỉ đọc bằng chứng;
    // ai được phép ghi các dòng này là kiểm tra role phía API (issue #23 F1).
    // Cần một dòng role thật: criteria.role_id có FK tới role.id.
    const roleRows = await sql`insert into role (name, short_name) values ('Worker marker role', ${`wkmarker${suffix}`}) returning id`.execute(db);
    const markerRoleId = (roleRows.rows[0] as { id: string }).id;
    await db.deleteFrom('course_completion_criteria').where('course', '=', courseId).execute();
    const roleCritRow = await db.insertInto('course_completion_criteria')
      .values({ course: courseId, criteria_type: 'role', role_id: markerRoleId, sort_order: 0 }).returningAll().executeTakeFirstOrThrow();
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).not.toBe('complete');
    await db.insertInto('course_completion_crit_compl').values({ criteria_id: roleCritRow.id, user_id: userId, marked_by: userIdB }).execute();
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).toBe('complete');

    // duration: neo trên timeStart của ghi danh (cách đây 10 ngày ở đây).
    const userIdC = `01900000-0000-7000-8000-${String(900200 + (suffix % 10000)).padStart(12, '0')}`;
    await db.insertInto('user_enrolments').values({ enrol_id: instanceId, user_id: userIdC, status: 0, time_start: new Date(Date.now() - 10 * 86_400_000) }).execute();
    await replaceCriteria([{ criteria_type: 'duration', enrol_period_days: 30 }]);
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userIdC)).not.toBe('complete');
    await replaceCriteria([{ criteria_type: 'duration', enrol_period_days: 7 }]);
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userIdC)).toBe('complete');

    // unenrol: một user có dòng completion đã lưu nhưng không còn ghi danh sống.
    const userIdD = `01900000-0000-7000-8000-${String(900300 + (suffix % 10000)).padStart(12, '0')}`;
    await db.insertInto('course_completions').values({ user_id: userIdD, course: courseId, status: 'in_progress', time_started: new Date() }).execute();
    await replaceCriteria([{ criteria_type: 'unenrol' }]);
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userIdD)).toBe('complete');
    // ...trong khi một user vẫn đang ghi danh thì KHÔNG thoả mãn nó.
    expect(await statusOf(userIdC)).not.toBe('complete');
  });
});
