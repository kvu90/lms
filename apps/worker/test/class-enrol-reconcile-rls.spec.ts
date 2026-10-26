import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { Client, Pool } from 'pg';
import { ClassEnrolReconcileProcessor } from '../src/processors/class-enrol-reconcile.processor';
import { TaskLogService } from '../src/task-log.service';
import { TenantAwarePool } from '../src/db/tenant-pool';
import { relations } from '../src/db/relations';
import {
  classes, cohort, cohortMembers, context, course, courseGroups, enrol,
  role, roleAssignments, userEnrolments, users,
} from '@lms/db-schema';

/**
 * Hồi quy issue #292 — job đối soát ghi danh lớp chạy bằng role DB
 * KHÔNG có BYPASSRLS (hình dạng kết nối production).
 *
 * Lớp lỗi: `ClassEnrolReconcileProcessor` là processor duy nhất không
 * bọc ngữ cảnh tenant/platform. `TenantAwarePool` ngoài ngữ cảnh gắn
 * `app.tenant_id = ''`, `app.platform = 'off'` → RLS fail-closed trên
 * bảng `classes` → lượt quét đọc 0 lớp, job vẫn báo "thành công" với
 * `classesChecked = 0` và lệch ghi danh không bao giờ được sửa. Spec
 * cũ (`class-enrol-reconcile.spec.ts`) chạy bằng superuser nên mù với
 * lớp lỗi này — spec này dựng lại đúng hình dạng production:
 *
 *  - fixture được nạp bằng kết nối quản trị (superuser) như đường seed;
 *  - processor chạy bằng MỘT pool `TenantAwarePool` đăng nhập bằng
 *    role `NOSUPERUSER NOBYPASSRLS` chỉ có quyền trên schema public;
 *  - ca kiểm chứng gồm cả chiều âm (ngoài ngữ cảnh, role thường không
 *    thấy lớp nào — chứng minh harness thật sự chịu RLS) và chiều
 *    dương (job thấy lớp, sửa đúng lệch: thành viên roster thiếu ghi
 *    danh được ghi danh + gán vai; ghi danh thừa ngoài roster bị đình
 *    chỉ; chạy lại không sửa thêm).
 *
 * Trên code TRƯỚC fix, ca dương FAIL vì `classesChecked = 0`; sau fix
 * phải PASS. Đây là test luồng nghiệp vụ đối soát, không kiểm chi
 * tiết triển khai của processor.
 */
describe('Worker class enrol reconcile dưới RLS (hồi quy #292)', () => {
  const RLS_ROLE = 'lms_recon_rls';
  const RLS_PASSWORD = 'lms-recon-rls-test-password';
  const suffix = `${Date.now() % 100000000}`;
  // ID fixture mang dấu lượt chạy để spec chạy lại trên cùng DB không
  // đụng khoá chính của lượt trước (DB CI luôn mới, DB local thì không).
  const runTag = String(Date.now() % 100000).padStart(5, '0');
  const uid = (n: number) => `01900000-0000-7000-8000-${runTag}${String(710000 + n).padStart(7, '0')}`;
  const teacherId = uid(1);
  // A: trong roster, chưa có UE → job phải ghi danh + gán vai.
  const memberA = uid(2);
  // Ok: trong roster, UE ACTIVE + đã có gán vai → job không đụng.
  const memberOk = uid(3);
  // E: KHÔNG còn trong roster, UE ACTIVE → job phải đình chỉ.
  const outsiderE = uid(4);

  let adminDb: ReturnType<typeof drizzle>;
  let adminPool: Pool;
  let rlsDb: ReturnType<typeof drizzle>;
  let rlsPool: TenantAwarePool;
  let processor: ClassEnrolReconcileProcessor;
  let classId = '';
  let instanceId = '';
  let courseCtxId = '';

  async function ueOf(userId: string) {
    const [row] = await adminDb.select().from(userEnrolments)
      .where(and(eq(userEnrolments.enrolId, instanceId), eq(userEnrolments.userId, userId)));
    return row;
  }

  beforeAll(async () => {
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error('DATABASE_URL chưa được đặt cho suite worker');

    // Role ứng dụng không BYPASSRLS — tạo idempotent (role là đối
    // tượng cấp cụm, chạy lại suite không được vỡ).
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(
      `DO $$ BEGIN CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    );
    await admin.query(`ALTER ROLE ${RLS_ROLE} WITH LOGIN PASSWORD '${RLS_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`);
    await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`);
    await admin.end();

    adminPool = new Pool({ connectionString: adminUrl });
    adminDb = drizzle({ client: adminPool, relations });

    // Fixture (nạp bằng quản trị, như đường seed production).
    await adminDb.execute(sql`insert into tenants (slug, name, kind, status) values (${`recon-rls-${suffix}`}, 'Reconcile RLS fixture tenant', 'school', 'active') on conflict (slug) do nothing`);
    const tenantRows = await adminDb.execute(sql`select id from tenants where slug = ${`recon-rls-${suffix}`}`);
    const tenantId = ((tenantRows as unknown as { rows: { id: string }[] }).rows[0]).id;

    await adminDb.insert(users).values({ id: teacherId, username: `recon-rls-teacher-${suffix}`, email: `recon-rls-teacher-${suffix}@example.com` });

    const catRows = await adminDb.execute(sql`insert into course_categories (name, path, tenant_id) values (${`recon-rls-cat-${suffix}`}, '', ${tenantId}) returning id`);
    const catId = ((catRows as unknown as { rows: { id: string }[] }).rows[0]).id;

    const [cohortRow] = await adminDb.insert(cohort).values({
      tenantId, name: `recon-rls-cohort-${suffix}`, contextId: teacherId, component: 'class', visible: false,
    }).returning();

    const [classRow] = await adminDb.insert(classes).values({
      tenantId, name: `Lớp reconcile RLS ${suffix}`, ownerId: teacherId, cohortId: cohortRow.id, status: 'active',
    }).returning();
    classId = classRow.id;

    const [courseRow] = await adminDb.insert(course).values({
      tenantId, category: catId, fullName: 'Reconcile RLS course', shortName: `reconrls${suffix}`, classId,
    }).returning();

    const [ctxRow] = await adminDb.insert(context).values({
      contextLevel: 50, instanceId: courseRow.id, path: '/recon-rls', depth: 3,
    }).returning();
    courseCtxId = ctxRow.id;

    const [groupRow] = await adminDb.insert(courseGroups).values({ courseId: courseRow.id, name: 'Cả lớp' }).returning();
    const [roleRow] = await adminDb.insert(role).values({
      name: 'Student (reconcile RLS fixture)', shortName: `recon-rls-student-${suffix}`, archetype: 'student',
    }).returning();

    const [instance] = await adminDb.insert(enrol).values({
      courseId: courseRow.id, enrol: 'cohort', status: 0, roleId: roleRow.id,
      customInt1: cohortRow.id, customInt2: groupRow.id, customText1: 'suspend',
    }).returning();
    instanceId = instance.id;

    // Roster: A (thiếu UE) + Ok (đã khớp). E đã rời roster.
    for (const userId of [memberA, memberOk]) {
      await adminDb.insert(cohortMembers).values({ cohortId: cohortRow.id, userId });
    }
    await adminDb.insert(userEnrolments).values([
      { enrolId: instanceId, userId: memberOk, status: 0, modifierId: null },
      { enrolId: instanceId, userId: outsiderE, status: 0, modifierId: null },
    ]);
    await adminDb.insert(roleAssignments).values({
      roleId: roleRow.id, userId: memberOk, contextId: courseCtxId, component: 'enrol', itemId: instanceId,
    });

    // Processor chạy bằng role thường qua đúng TenantAwarePool của worker.
    const rlsUrl = new URL(adminUrl);
    rlsUrl.username = RLS_ROLE;
    rlsUrl.password = RLS_PASSWORD;
    rlsPool = new TenantAwarePool({ connectionString: rlsUrl.toString() });
    rlsDb = drizzle({ client: rlsPool, relations });
    processor = new ClassEnrolReconcileProcessor(
      rlsDb as never,
      new TaskLogService(rlsDb as never),
    );
  });

  afterAll(async () => {
    await rlsPool?.end();
    await adminPool?.end();
  });

  it('chiều âm: ngoài ngữ cảnh tenant, role thường không thấy lớp nào (RLS fail-closed)', async () => {
    const rows = await rlsDb.select().from(classes).where(eq(classes.id, classId));
    expect(rows).toHaveLength(0);
  });

  it('job đối soát thấy lớp và sửa đúng lệch dưới role không BYPASSRLS', async () => {
    const result = await processor.process({ data: {} } as never);

    expect(result.skippedClassIds).not.toContain(classId);
    expect(result.classesChecked).toBeGreaterThanOrEqual(1);
    expect(result.enrolled).toBeGreaterThanOrEqual(1);
    expect(result.suspended).toBeGreaterThanOrEqual(1);

    // A: đã ghi danh ACTIVE + có gán vai của instance.
    expect((await ueOf(memberA))?.status).toBe(0);
    const [assignmentA] = await adminDb.select().from(roleAssignments).where(and(
      eq(roleAssignments.userId, memberA),
      eq(roleAssignments.contextId, courseCtxId),
      eq(roleAssignments.component, 'enrol'),
      eq(roleAssignments.itemId, instanceId),
    ));
    expect(assignmentA).toBeTruthy();
    // E: bị đình chỉ vì không còn trong roster.
    expect((await ueOf(outsiderE))?.status).toBe(1);
    // Ok: nguyên trạng ACTIVE.
    expect((await ueOf(memberOk))?.status).toBe(0);
  });

  it('chạy lại lần hai: trạng thái đã khớp thì không sửa thêm (idempotent)', async () => {
    const before = await ueOf(outsiderE);
    await processor.process({ data: {} } as never);
    const ueE = await ueOf(outsiderE);
    expect(ueE?.status).toBe(1);
    expect(ueE?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    const ueA = await ueOf(memberA);
    expect(ueA?.status).toBe(0);
  });
});
