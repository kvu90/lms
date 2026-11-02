import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from '@lms/db';
import { ClassEnrolReconcileProcessor } from '../../../src/processors/class-enrol-reconcile.processor';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * CLASS-0 (issue #184) — job đối soát ghi danh cấp lớp
 * `class-enrol-reconcile`: nguồn sự thật là cohort_members của backing
 * cohort; user_enrolments trên instance cohort của khoá là bản vật
 * chất hoá. Các ca bắt buộc của hồ sơ:
 *  - thành viên roster thiếu ghi danh → ghi danh + gán vai + group;
 *  - ghi danh ACTIVE thừa (không còn trong roster) → đình chỉ theo
 *    chế độ rời lớp;
 *  - UE SUSPENDED bởi đồng bộ (modifier_id null) khi user quay lại
 *    roster → kích hoạt lại; UE WITHDRAWN → kích hoạt lại;
 *  - UE ACTIVE thiếu gán vai của instance → cấp bổ sung;
 *  - CA "MIỄN MÔN": UE SUSPENDED mang modifier_id của một NGƯỜI
 *    (đình chỉ thủ công theo khoá) → job KHÔNG đụng vào, kể cả khi
 *    user vẫn ở trong roster;
 *  - chạy lại lần hai trên trạng thái đã khớp → không sửa gì.
 * Hàng được chèn trực tiếp vì API là phía sở hữu đường tạo; processor
 * chỉ đọc/ghi trên cùng các bảng qua schema dùng chung.
 *
 * Từ lát 2 của issue #294, spec này boot WorkerModule qua harness
 * role thường (`test/ordinary-worker-module.ts`): module chạy bằng
 * role NOSUPERUSER/NOBYPASSRLS như production — cùng lớp lỗi RLS mà
 * ca mẫu `class-enrol-reconcile-rls.spec.ts` khoá ở mức processor —
 * fixture và đọc kiểm chứng đi qua kết nối quản trị của harness;
 * khẳng định nghiệp vụ của spec không đổi.
 */
describe('Đối chiếu ghi danh lớp của worker (CLASS-0, #184)', () => {
  let context_: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: any;
  const suffix = `${Date.now() % 100000000}`;
  const uid = (n: number) => `01900000-0000-7000-8000-${String(700000 + n).padStart(12, '0')}`;
  const teacherId = uid(1);
  // A: trong roster, chưa có UE → phải được ghi danh.
  const memberA = uid(2);
  // B: trong roster, UE SUSPENDED bởi đồng bộ (modifier null) → kích hoạt lại.
  const memberB = uid(3);
  // C: trong roster, UE SUSPENDED THỦ CÔNG (modifier = giáo viên) → không đụng.
  const memberC = uid(4);
  // D: trong roster, UE ACTIVE nhưng thiếu gán vai → cấp bổ sung vai.
  const memberD = uid(5);
  // E: KHÔNG còn trong roster, UE ACTIVE → đình chỉ.
  const outsiderE = uid(6);
  // F: trong roster, UE WITHDRAWN → kích hoạt lại.
  const memberF = uid(7);

  let classId = '';
  let instanceId = '';
  let courseCtxId = '';
  let roleId = '';

  async function ueOf(userId: string) {
    const rows = await db.selectFrom('user_enrolments').selectAll()
      .where('enrol_id', '=', instanceId)
      .where('user_id', '=', userId)
      .execute();
    return rows[0];
  }

  async function assignmentOf(userId: string) {
    const rows = await db.selectFrom('role_assignments').selectAll()
      .where('user_id', '=', userId)
      .where('context_id', '=', courseCtxId)
      .where('component', '=', 'enrol')
      .where('item_id', '=', instanceId)
      .execute();
    return rows[0];
  }

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context_ = harness.context;
    db = harness.adminDb;

    await sql`insert into tenants (slug, name, kind, status) values (${`recon-fixture-${suffix}`}, 'Reconcile fixture tenant', 'school', 'active') on conflict (slug) do nothing`.execute(db);
    const tenantRows = await sql`select id from tenants where slug = ${`recon-fixture-${suffix}`}`.execute(db);
    const tenantId = (tenantRows.rows[0] as { id: string }).id;

    await db.insertInto('users').values({ id: teacherId, username: `recon-teacher-${suffix}`, email: `recon-teacher-${suffix}@example.com` }).execute();

    const catRows = await sql`insert into course_categories (name, path, tenant_id) values (${`recon-cat-${suffix}`}, '', ${tenantId}) returning id`.execute(db);
    const catId = (catRows.rows[0] as { id: string }).id;

    const cohortRow = await db.insertInto('cohort').values({
      tenant_id: tenantId, name: `recon-cohort-${suffix}`, context_id: teacherId, component: 'class', visible: false,
    }).returningAll().executeTakeFirstOrThrow();

    const classRow = await db.insertInto('classes').values({
      tenant_id: tenantId, name: `Lớp reconcile ${suffix}`, owner_id: teacherId, cohort_id: cohortRow.id, status: 'active',
    }).returningAll().executeTakeFirstOrThrow();
    classId = classRow.id;

    const courseRow = await db.insertInto('course').values({
      tenant_id: tenantId, category: catId, full_name: 'Reconcile course', short_name: `recon${suffix}`, class_id: classId,
    }).returningAll().executeTakeFirstOrThrow();

    const ctxRow = await db.insertInto('context').values({
      context_level: 50, instance_id: courseRow.id, path: '/recon', depth: 3,
    }).returningAll().executeTakeFirstOrThrow();
    courseCtxId = ctxRow.id;

    const groupRow = await db.insertInto('course_groups').values({ course_id: courseRow.id, name: 'Cả lớp' }).returningAll().executeTakeFirstOrThrow();
    const roleRow = await db.insertInto('role').values({
      name: 'Student (reconcile fixture)', short_name: `recon-student-${suffix}`, archetype: 'student',
    }).returningAll().executeTakeFirstOrThrow();
    roleId = roleRow.id;

    const instance = await db.insertInto('enrol').values({
      course_id: courseRow.id, enrol: 'cohort', status: 0, role_id: roleId,
      custom_int1: cohortRow.id, custom_int2: groupRow.id, custom_text1: 'suspend',
    }).returningAll().executeTakeFirstOrThrow();
    instanceId = instance.id;

    // Roster: A, B, C, D, F (E đã rời lớp).
    for (const userId of [memberA, memberB, memberC, memberD, memberF]) {
      await db.insertInto('cohort_members').values({ cohort_id: cohortRow.id, user_id: userId }).execute();
    }
    // Trạng thái vật chất hoá ban đầu (lệch có chủ đích):
    await db.insertInto('user_enrolments').values([
      { enrol_id: instanceId, user_id: memberB, status: 1, modifier_id: null },
      { enrol_id: instanceId, user_id: memberC, status: 1, modifier_id: teacherId },
      { enrol_id: instanceId, user_id: memberD, status: 0, modifier_id: null },
      { enrol_id: instanceId, user_id: outsiderE, status: 0, modifier_id: null },
      { enrol_id: instanceId, user_id: memberF, status: 2, modifier_id: null },
    ]).execute();
    // D có ghi danh nhưng dòng gán vai của instance đã mất (lỗ hổng cần lấp).
  });

  afterAll(async () => { await harness.close(); });

  it('đối soát sửa đúng các lệch và tôn trọng đình chỉ thủ công theo khoá', async () => {
    const processor = context_.get(ClassEnrolReconcileProcessor);
    const result = await processor.process({ data: {} } as never);

    expect(result.skippedClassIds).not.toContain(classId);
    expect(result.enrolled).toBeGreaterThanOrEqual(1);
    expect(result.reactivated).toBeGreaterThanOrEqual(2);
    expect(result.suspended).toBeGreaterThanOrEqual(1);
    expect(result.rolesRestored).toBeGreaterThanOrEqual(1);

    // A: đã ghi danh ACTIVE + có gán vai của instance.
    expect((await ueOf(memberA))?.status).toBe(0);
    expect(await assignmentOf(memberA)).toBeTruthy();
    // B: kích hoạt lại, vết đồng bộ giữ null.
    const ueB = await ueOf(memberB);
    expect(ueB?.status).toBe(0);
    expect(ueB?.modifier_id).toBeNull();
    // C — CA MIỄN MÔN: vẫn SUSPENDED, vết giáo viên nguyên vẹn.
    const ueC = await ueOf(memberC);
    expect(ueC?.status).toBe(1);
    expect(ueC?.modifier_id).toBe(teacherId);
    // D: vai đã được cấp bổ sung.
    expect(await assignmentOf(memberD)).toBeTruthy();
    // E: bị đình chỉ vì không còn trong roster.
    expect((await ueOf(outsiderE))?.status).toBe(1);
    // F: WITHDRAWN → ACTIVE.
    expect((await ueOf(memberF))?.status).toBe(0);
  });

  it('chạy lại lần hai: không còn gì để sửa cho lớp này (idempotent), ca miễn môn vẫn nguyên', async () => {
    const processor = context_.get(ClassEnrolReconcileProcessor);
    const before = await ueOf(memberC);
    const result = await processor.process({ data: {} } as never);
    expect(result.skippedClassIds).not.toContain(classId);
    const ueC = await ueOf(memberC);
    expect(ueC?.status).toBe(1);
    expect(ueC?.modifier_id).toBe(teacherId);
    expect(ueC?.updated_at.getTime()).toBe(before?.updated_at.getTime());
  });
});
