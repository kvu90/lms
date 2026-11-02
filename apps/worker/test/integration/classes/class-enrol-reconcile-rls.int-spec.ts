import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ClassEnrolReconcileProcessor } from '../../../src/processors/class-enrol-reconcile.processor';
import { TaskLogService } from '../../../src/task-log.service';
import { TenantAwarePool } from '../../../src/db/tenant-pool';
import { adminDatabaseUrl, ensureOrdinaryRole, ordinaryRoleUrl } from '../../support/ordinary-role';
import { createCentreKysely, sql, type CentreDb } from '@lms/db';

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
 *
 * Từ lát PR-294.1 (issue #294), việc dựng role + cấp quyền của spec
 * này đi qua harness dùng chung `test/ordinary-role.ts` thay vì dựng
 * inline trong `beforeAll` như bản đầu — khẳng định nghiệp vụ của
 * spec không đổi, đây là ca mẫu cho các spec RLS/tenant còn lại của
 * suite worker chuyển sang harness ở các lát tiếp theo của #294.
 */
describe('Worker class enrol reconcile dưới RLS (hồi quy #292)', () => {
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

  let adminDb: CentreDb;
  let adminPool: Pool;
  let rlsDb: CentreDb;
  let rlsPool: TenantAwarePool;
  let processor: ClassEnrolReconcileProcessor;
  let classId = '';
  let instanceId = '';
  let courseCtxId = '';

  async function ueOf(userId: string) {
    return adminDb
      .selectFrom('user_enrolments')
      .selectAll()
      .where('enrol_id', '=', instanceId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }

  beforeAll(async () => {
    const adminUrl = adminDatabaseUrl();

    // Role ứng dụng không BYPASSRLS: dựng qua harness dùng chung của
    // suite worker (issue #294) — tạo idempotent + cấp quyền tối thiểu
    // trên schema public, cùng một role cho mọi spec đụng RLS/tenant.
    await ensureOrdinaryRole(adminUrl);

    adminPool = new Pool({ connectionString: adminUrl });
    adminDb = createCentreKysely(adminPool);

    // Fixture (nạp bằng quản trị, như đường seed production).
    await sql`insert into tenants (slug, name, kind, status) values (${`recon-rls-${suffix}`}, 'Reconcile RLS fixture tenant', 'school', 'active') on conflict (slug) do nothing`.execute(adminDb);
    const tenantRows = await sql<{ id: string }>`select id from tenants where slug = ${`recon-rls-${suffix}`}`.execute(adminDb);
    const tenantId = tenantRows.rows[0]!.id;

    await adminDb.insertInto('users').values({ id: teacherId, username: `recon-rls-teacher-${suffix}`, email: `recon-rls-teacher-${suffix}@example.com` }).execute();

    const catRows = await sql<{ id: string }>`insert into course_categories (name, path, tenant_id) values (${`recon-rls-cat-${suffix}`}, '', ${tenantId}) returning id`.execute(adminDb);
    const catId = catRows.rows[0]!.id;

    const cohortRow = await adminDb.insertInto('cohort').values({
      tenant_id: tenantId, name: `recon-rls-cohort-${suffix}`, context_id: teacherId, component: 'class', visible: false,
    }).returningAll().executeTakeFirstOrThrow();

    const classRow = await adminDb.insertInto('classes').values({
      tenant_id: tenantId, name: `Lớp reconcile RLS ${suffix}`, owner_id: teacherId, cohort_id: cohortRow.id, status: 'active',
    }).returningAll().executeTakeFirstOrThrow();
    classId = classRow.id;

    const courseRow = await adminDb.insertInto('course').values({
      tenant_id: tenantId, category: catId, full_name: 'Reconcile RLS course', short_name: `reconrls${suffix}`, class_id: classId,
    }).returningAll().executeTakeFirstOrThrow();

    const ctxRow = await adminDb.insertInto('context').values({
      context_level: 50, instance_id: courseRow.id, path: '/recon-rls', depth: 3,
    }).returningAll().executeTakeFirstOrThrow();
    courseCtxId = ctxRow.id;

    const groupRow = await adminDb.insertInto('course_groups').values({ course_id: courseRow.id, name: 'Cả lớp' }).returningAll().executeTakeFirstOrThrow();
    const roleRow = await adminDb.insertInto('role').values({
      name: 'Student (reconcile RLS fixture)', short_name: `recon-rls-student-${suffix}`, archetype: 'student',
    }).returningAll().executeTakeFirstOrThrow();

    const instance = await adminDb.insertInto('enrol').values({
      course_id: courseRow.id, enrol: 'cohort', status: 0, role_id: roleRow.id,
      custom_int1: cohortRow.id, custom_int2: groupRow.id, custom_text1: 'suspend',
    }).returningAll().executeTakeFirstOrThrow();
    instanceId = instance.id;

    // Roster: A (thiếu UE) + Ok (đã khớp). E đã rời roster.
    for (const userId of [memberA, memberOk]) {
      await adminDb.insertInto('cohort_members').values({ cohort_id: cohortRow.id, user_id: userId }).execute();
    }
    await adminDb.insertInto('user_enrolments').values([
      { enrol_id: instanceId, user_id: memberOk, status: 0, modifier_id: null },
      { enrol_id: instanceId, user_id: outsiderE, status: 0, modifier_id: null },
    ]).execute();
    await adminDb.insertInto('role_assignments').values({
      role_id: roleRow.id, user_id: memberOk, context_id: courseCtxId, component: 'enrol', item_id: instanceId,
    }).execute();

    // Processor chạy bằng role thường qua đúng TenantAwarePool của worker.
    rlsPool = new TenantAwarePool({ connectionString: ordinaryRoleUrl(adminUrl) });
    rlsDb = createCentreKysely(rlsPool);
    processor = new ClassEnrolReconcileProcessor(
      // Processor chạy trên handle Kysely định tuyến
      // (`SpaceDatabaseService.routedKysely`): cấp một khung định
      // tuyến tối thiểu mà `routedKysely` trỏ vào đúng pool role
      // thường của ca này, để mọi đường đọc/ghi của processor
      // giữ nguyên hình dạng kết nối production (role không
      // BYPASSRLS) như trước.
      { routedKysely: createCentreKysely(rlsPool) } as never,
      // TaskLogService chạy trên handle Kysely định tuyến: cấp một
      // khung định tuyến tối thiểu mà `routedKysely` trỏ vào đúng
      // pool role thường của ca này, để đường ghi task_log giữ
      // nguyên hình dạng kết nối production (role không BYPASSRLS)
      // như trước.
      new TaskLogService({ routedKysely: createCentreKysely(rlsPool) } as never),
    );
  });

  afterAll(async () => {
    await rlsPool?.end();
    await adminPool?.end();
  });

  it('chiều âm: ngoài ngữ cảnh tenant, role thường không thấy lớp nào (RLS fail-closed)', async () => {
    const rows = await rlsDb.selectFrom('classes').selectAll().where('id', '=', classId).execute();
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
    const assignmentA = await adminDb.selectFrom('role_assignments').selectAll()
      .where('user_id', '=', memberA)
      .where('context_id', '=', courseCtxId)
      .where('component', '=', 'enrol')
      .where('item_id', '=', instanceId)
      .executeTakeFirst();
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
    expect((ueE?.updated_at as Date).getTime()).toBe((before?.updated_at as Date).getTime());
    const ueA = await ueOf(memberA);
    expect(ueA?.status).toBe(0);
  });
});
