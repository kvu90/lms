import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { EnrolRepository } from './enrol';

/**
 * Spec tích hợp của repository ghi danh trên Kysely (issue #645).
 *
 * Database trung tâm dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test. Mọi
 * ca chạy qua repository production ở `enrol.ts` — không mô
 * phỏng handle.
 *
 * Các tính chất chốt tại đây:
 * - Insert instance/ghi danh không truyền id nhận id UUIDv7 do
 *   database sinh (phụ lục U) và đọc lại nguyên vẹn.
 * - Giao dịch của repository nguyên tử cho đường tự mở giao
 *   dịch của `setSuspended`/`expireEnrolments`: cập nhật trong
 *   giao dịch rồi huỷ thì trạng thái dòng không đổi.
 * - Patch cập nhật loại `undefined` tường minh (T-4): trường
 *   không nhắc tới giữ nguyên giá trị.
 * - `listExpiredActive` giữ đúng hợp đồng lọc tại bộ nhớ của
 *   bản cũ: chỉ dòng ACTIVE (status = 0) có `timeEnd` đã qua.
 * - `listUserEnrolmentsForCourse` gắn đúng phương thức của
 *   instance sở hữu lên từng dòng.
 */

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g645_enrol';
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let pool: Pool;
let db: CentreDb;
let repo: EnrolRepository;
let courseId: string;

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec Kysely #645: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  repo = new EnrolRepository(db);

  const tenant = await db
    .insertInto('tenants')
    .values({ slug: 'g645-enrol', name: 'Trung tâm spec G5 enrol', kind: 'center' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const category = await db
    .insertInto('course_categories')
    .values({ tenant_id: tenant.id, name: 'Danh mục G5 enrol' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const course = await db
    .insertInto('course')
    .values({ tenant_id: tenant.id, category: category.id, full_name: 'Khoá G5 enrol', short_name: 'g645-enrol-course', is_template: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  courseId = course.id;
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

describe('EnrolRepository trên Kysely (issue #645)', () => {
  it('chèn instance và ghi danh nhận id UUIDv7, đọc lại nguyên vẹn', async () => {
    const instance = await repo.insertInstance({
      courseId, enrol: 'manual', name: null, roleId: null, status: 0, enrolPeriod: 0,
      customInt1: null, customInt2: null, customText1: 'suspend',
      cost: 0, currency: '', paymentAccountId: null, enrolmentKey: null,
      sendWelcomeMessage: false, welcomeMessage: null,
    });
    expect(instance.id).toMatch(UUIDV7_PATTERN);
    expect((await repo.listInstances(courseId)).map((i) => i.id)).toContain(instance.id);

    const userId = randomUUID();
    const ue = await repo.insertUserEnrolment({ enrolId: instance.id, userId, status: 0 });
    expect(ue.id).toMatch(UUIDV7_PATTERN);
    expect(ue.timeStart).toBeInstanceOf(Date);
    expect((await repo.getUserEnrolment(instance.id, userId))?.id).toBe(ue.id);
  });

  it('cập nhật trong giao dịch của repository huỷ thì trạng thái không đổi; patch bỏ trống giữ nguyên trường khác', async () => {
    const instance = await repo.insertInstance({ courseId, enrol: 'self', customText1: 'suspend' });
    const userId = randomUUID();
    const ue = await repo.insertUserEnrolment({ enrolId: instance.id, userId, status: 0 });

    const attempt = repo.transaction(async (tx) => {
      await repo.updateUserEnrolment(ue.id, { status: 1, modifierId: userId }, tx);
      throw new Error('Lỗi giả lập giữa giao dịch');
    });
    await expect(attempt).rejects.toThrow('Lỗi giả lập giữa giao dịch');
    expect((await repo.getUserEnrolment(instance.id, userId))?.status).toBe(0);

    await repo.transaction(async (tx) => {
      await repo.updateUserEnrolment(ue.id, { status: 1, modifierId: userId }, tx);
    });
    const after = await repo.getUserEnrolment(instance.id, userId);
    expect(after?.status).toBe(1);
    expect(after?.modifierId).toBe(userId);

    // T-4: patch chỉ nhắc `name` — `customText1` và `status` của instance giữ nguyên.
    await repo.updateInstance(instance.id, { name: 'Tên mới' });
    const patched = await repo.getInstance(instance.id);
    expect(patched?.name).toBe('Tên mới');
    expect(patched?.customText1).toBe('suspend');
    expect(patched?.status).toBe(0);
  });

  it('listExpiredActive chỉ lấy dòng ACTIVE đã quá hạn và listUserEnrolmentsForCourse gắn đúng phương thức', async () => {
    const instance = await repo.insertInstance({ courseId, enrol: 'cohort', customInt1: randomUUID(), customText1: 'suspend' });
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const expiredUser = randomUUID();
    await repo.insertUserEnrolment({ enrolId: instance.id, userId: expiredUser, status: 0, timeEnd: past });
    await repo.insertUserEnrolment({ enrolId: instance.id, userId: randomUUID(), status: 0, timeEnd: future });
    await repo.insertUserEnrolment({ enrolId: instance.id, userId: randomUUID(), status: 0, timeEnd: null });
    await repo.insertUserEnrolment({ enrolId: instance.id, userId: randomUUID(), status: 1, timeEnd: past });

    const expired = await repo.listExpiredActive(new Date());
    expect(expired.map((r) => r.userId)).toEqual([expiredUser]);

    const forCourse = await repo.listUserEnrolmentsForCourse(courseId);
    const cohortRows = forCourse.filter((r) => r.enrolId === instance.id);
    expect(cohortRows).toHaveLength(4);
    expect(cohortRows.every((r) => r.enrolMethod === 'cohort')).toBe(true);
  });
});
