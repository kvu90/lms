import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import { ClassEnrolReconcileProcessor } from '../src/processors/class-enrol-reconcile.processor';
import {
  classes, cohort, cohortMembers, context, course, courseGroups, enrol,
  role, roleAssignments, userEnrolments, users,
} from '@lms/db-schema';
import { WorkerModule } from '../src/worker.module';

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
 */
describe('Worker class enrol reconcile (CLASS-0, #184)', () => {
  let context_: INestApplicationContext;
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
    const [row] = await db.select().from(userEnrolments)
      .where(and(eq(userEnrolments.enrolId, instanceId), eq(userEnrolments.userId, userId)));
    return row;
  }

  async function assignmentOf(userId: string) {
    const rows = await db.select().from(roleAssignments).where(and(
      eq(roleAssignments.userId, userId),
      eq(roleAssignments.contextId, courseCtxId),
      eq(roleAssignments.component, 'enrol'),
      eq(roleAssignments.itemId, instanceId),
    ));
    return rows[0];
  }

  beforeAll(async () => {
    context_ = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context_.init();
    db = context_.get(getDrizzleToken());

    await db.execute(sql`insert into tenants (slug, name, kind, status) values (${`recon-fixture-${suffix}`}, 'Reconcile fixture tenant', 'school', 'active') on conflict (slug) do nothing`);
    const tenantRows = await db.execute(sql`select id from tenants where slug = ${`recon-fixture-${suffix}`}`);
    const tenantId = (tenantRows.rows[0] as { id: string }).id;

    await db.insert(users).values({ id: teacherId, username: `recon-teacher-${suffix}`, email: `recon-teacher-${suffix}@example.com` });

    const catRows = await db.execute(sql`insert into course_categories (name, path, tenant_id) values (${`recon-cat-${suffix}`}, '', ${tenantId}) returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;

    const [cohortRow] = await db.insert(cohort).values({
      tenantId, name: `recon-cohort-${suffix}`, contextId: teacherId, component: 'class', visible: false,
    }).returning();

    const [classRow] = await db.insert(classes).values({
      tenantId, name: `Lớp reconcile ${suffix}`, ownerId: teacherId, cohortId: cohortRow.id, status: 'active',
    }).returning();
    classId = classRow.id;

    const [courseRow] = await db.insert(course).values({
      tenantId, category: catId, fullName: 'Reconcile course', shortName: `recon${suffix}`, classId,
    }).returning();

    const [ctxRow] = await db.insert(context).values({
      contextLevel: 50, instanceId: courseRow.id, path: '/recon', depth: 3,
    }).returning();
    courseCtxId = ctxRow.id;

    const [groupRow] = await db.insert(courseGroups).values({ courseId: courseRow.id, name: 'Cả lớp' }).returning();
    const [roleRow] = await db.insert(role).values({
      name: 'Student (reconcile fixture)', shortName: `recon-student-${suffix}`, archetype: 'student',
    }).returning();
    roleId = roleRow.id;

    const [instance] = await db.insert(enrol).values({
      courseId: courseRow.id, enrol: 'cohort', status: 0, roleId,
      customInt1: cohortRow.id, customInt2: groupRow.id, customText1: 'suspend',
    }).returning();
    instanceId = instance.id;

    // Roster: A, B, C, D, F (E đã rời lớp).
    for (const userId of [memberA, memberB, memberC, memberD, memberF]) {
      await db.insert(cohortMembers).values({ cohortId: cohortRow.id, userId });
    }
    // Trạng thái vật chất hoá ban đầu (lệch có chủ đích):
    await db.insert(userEnrolments).values([
      { enrolId: instanceId, userId: memberB, status: 1, modifierId: null },
      { enrolId: instanceId, userId: memberC, status: 1, modifierId: teacherId },
      { enrolId: instanceId, userId: memberD, status: 0, modifierId: null },
      { enrolId: instanceId, userId: outsiderE, status: 0, modifierId: null },
      { enrolId: instanceId, userId: memberF, status: 2, modifierId: null },
    ]);
    // D có ghi danh nhưng dòng gán vai của instance đã mất (lỗ hổng cần lấp).
  });

  afterAll(async () => { await context_.close(); });

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
    expect(ueB?.modifierId).toBeNull();
    // C — CA MIỄN MÔN: vẫn SUSPENDED, vết giáo viên nguyên vẹn.
    const ueC = await ueOf(memberC);
    expect(ueC?.status).toBe(1);
    expect(ueC?.modifierId).toBe(teacherId);
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
    expect(ueC?.modifierId).toBe(teacherId);
    expect(ueC?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });
});
