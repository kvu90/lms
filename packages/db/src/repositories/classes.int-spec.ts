import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { ClassesRepository } from './classes';

/**
 * Spec tích hợp của repository lớp học trên Kysely (issue #645).
 *
 * Database trung tâm dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test. Mọi
 * ca chạy qua repository production ở `classes.ts` — không mô
 * phỏng handle. (Ba lệnh ghi của giao dịch tạo lớp không thuộc
 * repository này — chúng ở repository chuyển tiếp phía api theo
 * điểm dừng của điểm nối C-8/B.)
 *
 * Các tính chất chốt tại đây:
 * - Tra lớp theo mã tham gia giữ đúng hành vi của bản Drizzle:
 *   mã là unique toàn hệ khi có đặt nên tra KHÔNG kèm tenant
 *   (lớp thuộc tenant khác vẫn phân giải được — đường tự báo
 *   danh xuyên tenant), trong khi tra theo mã lớp thì bó trong
 *   đúng tenant.
 * - `countCoursesInClass` trả `number` thật (ép `::int`, T-7).
 * - Hai truy vấn `distinct` (khoá đang ghi danh ACTIVE của một
 *   học sinh; học sinh đã đình chỉ của một cohort) khử trùng
 *   đúng khi dữ kiện có nhiều dòng ghi danh cho cùng một đích.
 * - Hàng chờ tự báo danh: chèn, tra đang chờ, quyết định.
 */

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g645_classes';

let pool: Pool;
let db: CentreDb;
let repo: ClassesRepository;
let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let cohortId: string;
let classId: string;

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec Kysely #645: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  repo = new ClassesRepository(db);

  const tenant = await db
    .insertInto('tenants')
    .values({ slug: 'g645-classes', name: 'Trung tâm spec G5 classes', kind: 'center' })
    .returning('id')
    .executeTakeFirstOrThrow();
  tenantId = tenant.id;
  const otherTenant = await db
    .insertInto('tenants')
    .values({ slug: 'g645-classes-other', name: 'Trung tâm khác spec G5 classes', kind: 'center' })
    .returning('id')
    .executeTakeFirstOrThrow();
  otherTenantId = otherTenant.id;
  const owner = await db
    .insertInto('users')
    .values({ username: 'g645-owner', email: 'g645-owner@example.com' })
    .returning('id')
    .executeTakeFirstOrThrow();
  ownerId = owner.id;
  const cohort = await db
    .insertInto('cohort')
    .values({ tenant_id: tenantId, name: 'Cohort nền G5', context_id: randomUUID(), component: 'class', visible: false })
    .returning('id')
    .executeTakeFirstOrThrow();
  cohortId = cohort.id;
  const cls = await db
    .insertInto('classes')
    .values({
      tenant_id: tenantId, name: 'Lớp G5', code: 'LOP-G5', owner_id: ownerId, cohort_id: cohortId,
      join_code: 'G5JOIN01', allow_self_report: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  classId = cls.id;
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

/** Gieo một khoá thuộc lớp kèm một instance ghi danh theo phương thức cho trước. */
async function makeCourseWithInstance(method: string, customInt1: string | null): Promise<{ courseId: string; instanceId: string }> {
  const category = await db
    .insertInto('course_categories')
    .values({ tenant_id: tenantId, name: `Danh mục ${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const course = await db
    .insertInto('course')
    .values({ tenant_id: tenantId, category: category.id, class_id: classId, full_name: 'Khoá của lớp', short_name: `g645-${randomUUID()}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const instance = await db
    .insertInto('enrol')
    .values({ course_id: course.id, enrol: method, custom_int1: customInt1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { courseId: course.id, instanceId: instance.id };
}

describe('ClassesRepository trên Kysely (issue #645)', () => {
  it('tra theo mã tham gia không kèm tenant, tra theo mã lớp bó trong tenant', async () => {
    expect((await repo.getClassByJoinCode('G5JOIN01'))?.id).toBe(classId);
    expect(await repo.getClassByJoinCode('KHONG-CO')).toBeUndefined();
    expect((await repo.getClassByCode(tenantId, 'LOP-G5'))?.id).toBe(classId);
    // Mã lớp chỉ có nghĩa trong tenant sở hữu: tenant khác tra cùng mã thì không thấy.
    expect(await repo.getClassByCode(otherTenantId, 'LOP-G5')).toBeUndefined();
    expect((await repo.getClassByCohortId(cohortId))?.id).toBe(classId);
    expect((await repo.listClassesByTenant(tenantId)).map((c) => c.id)).toEqual([classId]);
  });

  it('đếm khoá trong lớp trả number và distinct khử trùng đúng hai truy vấn vật chất hoá', async () => {
    const studentA = randomUUID();
    const studentB = randomUUID();
    // Hai khoá của lớp, học sinh A ghi danh ACTIVE ở cả hai qua hai instance khác nhau.
    const first = await makeCourseWithInstance('cohort', cohortId);
    const second = await makeCourseWithInstance('manual', null);
    await db.insertInto('user_enrolments').values({ enrol_id: first.instanceId, user_id: studentA, status: 0 }).execute();
    await db.insertInto('user_enrolments').values({ enrol_id: second.instanceId, user_id: studentA, status: 0 }).execute();
    // Học sinh B: hai dòng SUSPENDED trên instance cohort của lớp.
    const third = await makeCourseWithInstance('cohort', cohortId);
    await db.insertInto('user_enrolments').values({ enrol_id: first.instanceId, user_id: studentB, status: 1 }).execute();
    await db.insertInto('user_enrolments').values({ enrol_id: third.instanceId, user_id: studentB, status: 1 }).execute();

    const count = await repo.countCoursesInClass(classId);
    expect(typeof count).toBe('number');
    expect(count).toBe(3);
    expect((await repo.listCoursesInClass(classId)).map((c) => c.id).sort())
      .toEqual([first.courseId, second.courseId, third.courseId].sort());

    const activeIds = await repo.listActiveEnrolledCourseIds(classId, studentA);
    expect(activeIds.sort()).toEqual([first.courseId, second.courseId].sort());
    // B có hai dòng đình chỉ trên hai instance cohort khác nhau của cùng lớp: vẫn chỉ một id.
    expect(await repo.listSuspendedMemberIds(cohortId)).toEqual([studentB]);
  });

  it('hàng chờ tự báo danh: chèn, tra đang chờ theo cặp lớp/học sinh, rồi quyết định', async () => {
    // `class_join_requests.user_id` có khoá ngoại sang `users` —
    // phải gieo một user thật (khác với `user_enrolments`, bảng
    // không neo khoá ngoại này).
    const student = await db
      .insertInto('users')
      .values({ username: 'g645-joiner', email: 'g645-joiner@example.com' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const userId = student.id;
    const request = await repo.insertJoinRequest({ tenantId, classId, userId, status: 'pending' });
    expect((await repo.findPendingJoinRequest(classId, userId))?.id).toBe(request.id);
    expect(await repo.findPendingJoinRequest(classId, randomUUID())).toBeUndefined();
    expect((await repo.listJoinRequests(classId, 'pending')).map((r) => r.id)).toEqual([request.id]);

    await repo.updateJoinRequest(request.id, { status: 'approved', decidedBy: ownerId, decidedAt: new Date() });
    expect(await repo.findPendingJoinRequest(classId, userId)).toBeUndefined();
    const decided = await repo.getJoinRequest(request.id);
    expect(decided?.status).toBe('approved');
    expect(decided?.decidedBy).toBe(ownerId);
  });
});
