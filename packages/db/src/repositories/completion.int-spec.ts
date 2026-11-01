import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { createTestKysely } from '../test-support/create-test-kysely';
import {
  runInTestPlatformContext,
  runInTestTenantContext,
  TestTenantPool,
} from '../test-support/tenant-context';
import { CompletionRepository } from './completion';

/**
 * Spec tích hợp của repository hoàn thành trên Kysely (issue #649).
 *
 * Database trung tâm được dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test (biến
 * `LMS_DB_TEST_ADMIN_URL` ghi đè cụm khi cần, mặc định suy từ
 * `DATABASE_URL` của package). Mọi ca chạy qua repository production
 * trong ngữ cảnh tenant qua pool gắn GUC như đường production.
 *
 * Các bất biến được khoá ở đây là hợp đồng của đường Drizzle trước
 * đây mà tầng service dựa vào:
 * - Ba thao tác ghi/đè khoá theo khoá duy nhất tự nhiên và nhánh cập
 *   nhật khi trùng chỉ chạm đúng tập cột đã chốt: đặc biệt
 *   `time_enrolled` của bản ghi hoàn thành khoá học KHÔNG nằm trong
 *   nhánh cập nhật (ghi đè không được viết lại mốc ghi danh).
 * - Đọc cấu hình của khoá chưa cấu hình trả mặc định `{ method: 1 }`.
 * - Các danh sách theo tập rỗng trả mảng rỗng mà không lỗi.
 */
const TEST_DATABASE = 'lms_db_g649_completion';
const TEST_ROLE = 'lms_db_g649_completion';
const TEST_ROLE_PASSWORD = 'lms_db_g649_completion_pw';

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let tenantPool: TestTenantPool;
let db: CentreDb;
let repo: CompletionRepository;

let tenantId = '';
let userId = '';
let otherUserId = '';
let courseId = '';
let otherCourseId = '';
let cmId = '';
let cm2Id = '';

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error(
      'Thiếu kết nối quản trị cho spec tích hợp G9: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.',
    );
  }
  const adminStoreUrl = await buildTestDatabase({
    adminUrl,
    database: TEST_DATABASE,
    store: 'centre',
  });

  const admin = new Client({ connectionString: adminStoreUrl });
  await admin.connect();
  try {
    await admin.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TEST_ROLE}') THEN
           CREATE ROLE "${TEST_ROLE}" LOGIN NOSUPERUSER PASSWORD '${TEST_ROLE_PASSWORD}';
         END IF;
       END $$;`,
    );
    await admin.query(`ALTER ROLE "${TEST_ROLE}" WITH LOGIN NOSUPERUSER PASSWORD '${TEST_ROLE_PASSWORD}'`);
    await admin.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${TEST_ROLE}"`);
    await admin.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${TEST_ROLE}"`);
  } finally {
    await admin.end();
  }

  const roleUrl = new URL(adminStoreUrl);
  roleUrl.username = TEST_ROLE;
  roleUrl.password = TEST_ROLE_PASSWORD;

  tenantPool = new TestTenantPool({ connectionString: roleUrl.toString() });
  db = createTestKysely(tenantPool).centre;
  repo = new CompletionRepository(db);

  tenantId = await runInTestPlatformContext(async () => {
    const row = await db
      .insertInto('tenants')
      .values({ slug: 'g649-completion', name: 'Trung tâm G9 completion', kind: 'centre' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });

  await runInTestTenantContext(tenantId, async () => {
    const mkUser = async (username: string): Promise<string> => {
      const row = await db
        .insertInto('users')
        .values({ email: `${username}@example.test`, username })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    };
    userId = await mkUser('g649-c-user');
    otherUserId = await mkUser('g649-c-user-other');

    const category = await db
      .insertInto('course_categories')
      .values({ name: 'Danh mục G9 completion', tenant_id: tenantId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const mkCourse = async (shortName: string): Promise<string> => {
      const row = await db
        .insertInto('course')
        .values({ category: category.id, full_name: `Khoá ${shortName}`, short_name: shortName, tenant_id: tenantId, is_template: true })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    };
    courseId = await mkCourse('G9C');
    otherCourseId = await mkCourse('G9C2');
    const section = await db
      .insertInto('course_sections')
      .values({ course: courseId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const mkCm = async (): Promise<string> => {
      const row = await db
        .insertInto('course_modules')
        .values({ component: 'mod_page', course: courseId, section: section.id, completion: 2 })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    };
    cmId = await mkCm();
    cm2Id = await mkCm();
  });
}, 180_000);

afterAll(async () => {
  if (tenantPool) await tenantPool.end();
  if (adminUrl) {
    await dropTestDatabase(adminUrl, TEST_DATABASE);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS "${TEST_ROLE}"`);
    } finally {
      await admin.end();
    }
  }
}, 60_000);

describe('CompletionRepository — trạng thái hoàn thành của course module', () => {
  it('upsertCmCompletion chèn dòng mới với default của database cho trường vắng mặt, ghi lại thì cập nhật đúng dòng cũ', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const inserted = await repo.upsertCmCompletion({ courseModuleId: cmId, userId, completionState: 1 });
      expect(inserted.id).toMatch(UUIDV7_PATTERN);
      expect(inserted.completionState).toBe(1);
      expect(inserted.viewed).toBe(false);
      expect(inserted.overrideBy).toBeNull();

      const updated = await repo.upsertCmCompletion({
        courseModuleId: cmId,
        userId,
        completionState: 2,
        viewed: true,
        overrideBy: otherUserId,
      });
      expect(updated.id).toBe(inserted.id);
      expect(updated.completionState).toBe(2);
      expect(updated.viewed).toBe(true);
      expect(updated.overrideBy).toBe(otherUserId);

      await expect(repo.getCmCompletion(cmId, userId)).resolves.toMatchObject({ id: inserted.id, completionState: 2 });
      await expect(repo.getCmCompletion(cmId, otherUserId)).resolves.toBeUndefined();
    });
  });

  it('danh sách theo user/cm, probe hasAny và xoá theo cm trả đúng số dòng đã xoá', async () => {
    await runInTestTenantContext(tenantId, async () => {
      await repo.upsertCmCompletion({ courseModuleId: cm2Id, userId, completionState: 1, viewed: false, overrideBy: null });
      await expect(repo.listCmCompletionsForUser(userId, [])).resolves.toEqual([]);
      await expect(repo.listCmCompletionsForUser(userId, [cmId, cm2Id])).resolves.toHaveLength(2);
      await expect(repo.listCmCompletionsForCm(cm2Id)).resolves.toHaveLength(1);
      await expect(repo.hasAnyCmCompletion(userId, [cmId])).resolves.toBe(true);
      await expect(repo.hasAnyCmCompletion(otherUserId, [cmId])).resolves.toBe(false);
      await expect(repo.deleteCmCompletionsForCm(cm2Id)).resolves.toBe(1);
      await expect(repo.listCmCompletionsForCm(cm2Id)).resolves.toEqual([]);
    });
  });
});

describe('CompletionRepository — tiêu chí, dấu thủ công, cấu hình và bản ghi khoá học', () => {
  it('tiêu chí: chèn, liệt kê theo sortOrder, tra khoá phụ thuộc theo tiêu chí course, xoá', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const second = await repo.insertCriteria({
        course: courseId, criteriaType: 'self', moduleInstance: null, date: null,
        courseInstance: null, enrolPeriodDays: null, roleId: null, sortOrder: 1,
      });
      const first = await repo.insertCriteria({
        course: courseId, criteriaType: 'course', moduleInstance: null, date: null,
        courseInstance: otherCourseId, enrolPeriodDays: null, roleId: null, sortOrder: 0,
      });
      expect(first.id).toMatch(UUIDV7_PATTERN);
      const listed = await repo.listCriteria(courseId);
      expect(listed.map((c) => c.id)).toEqual([first.id, second.id]);
      await expect(repo.getCriteria(second.id)).resolves.toMatchObject({ criteriaType: 'self' });
      await expect(repo.listDependentCourseIds(otherCourseId)).resolves.toEqual([courseId]);
      await expect(repo.listDependentCourseIds(courseId)).resolves.toEqual([]);
      await repo.deleteCriteria(second.id);
      await expect(repo.listCriteria(courseId)).resolves.toHaveLength(1);
    });
  });

  it('dấu hoàn thành thủ công: ghi/đè theo cặp (tiêu chí, user), liệt kê theo tập tiêu chí, xoá', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const criterion = (await repo.listCriteria(courseId))[0]!;
      const inserted = await repo.upsertCritCompl({ criteriaId: criterion.id, userId, markedBy: userId });
      expect(inserted.markedBy).toBe(userId);
      const updated = await repo.upsertCritCompl({ criteriaId: criterion.id, userId, markedBy: otherUserId });
      expect(updated.id).toBe(inserted.id);
      expect(updated.markedBy).toBe(otherUserId);
      expect(updated.timeCompleted.getTime()).toBeGreaterThanOrEqual(inserted.timeCompleted.getTime());
      await expect(repo.getCritCompl(criterion.id, userId)).resolves.toMatchObject({ id: inserted.id });
      await expect(repo.listCritComplForUser([], userId)).resolves.toEqual([]);
      await expect(repo.listCritComplForUser([criterion.id], userId)).resolves.toHaveLength(1);
      await repo.deleteCritCompl(criterion.id, userId);
      await expect(repo.getCritCompl(criterion.id, userId)).resolves.toBeUndefined();
    });
  });

  it('cấu hình: chưa cấu hình trả mặc định { method: 1 }; ghi rồi ghi lại đổi đúng phương thức trên cùng một dòng', async () => {
    await runInTestTenantContext(tenantId, async () => {
      await expect(repo.getSettings(courseId)).resolves.toEqual({ method: 1 });
      await repo.setSettings(courseId, 2);
      await expect(repo.getSettings(courseId)).resolves.toEqual({ method: 2 });
      await repo.setSettings(courseId, 1);
      await expect(repo.getSettings(courseId)).resolves.toEqual({ method: 1 });
    });
  });

  it('bản ghi hoàn thành khoá học: ghi/đè giữ nguyên time_enrolled của dòng đã có, chỉ đổi trạng thái và các mốc hoàn thành', async () => {
    await runInTestTenantContext(tenantId, async () => {
      const enrolledAt = new Date('2026-09-01T08:00:00.000Z');
      const startedAt = new Date('2026-09-02T08:00:00.000Z');
      const inserted = await repo.upsertCourseCompletion({
        userId, course: courseId, status: 'in_progress',
        timeEnrolled: enrolledAt, timeStarted: startedAt, timeCompleted: null,
      });
      expect(inserted.timeEnrolled).toEqual(enrolledAt);
      expect(inserted.status).toBe('in_progress');

      const completedAt = new Date('2026-10-01T08:00:00.000Z');
      const updated = await repo.upsertCourseCompletion({
        userId, course: courseId, status: 'complete',
        timeEnrolled: new Date('2027-01-01T08:00:00.000Z'),
        timeStarted: startedAt, timeCompleted: completedAt,
      });
      expect(updated.id).toBe(inserted.id);
      expect(updated.status).toBe('complete');
      expect(updated.timeCompleted).toEqual(completedAt);
      // time_enrolled không nằm trong nhánh cập nhật khi trùng khoá:
      // giá trị truyền ở lượt ghi đè không được viết lại mốc ghi danh.
      expect(updated.timeEnrolled).toEqual(enrolledAt);
      expect(updated.reAggregate.getTime()).toBeGreaterThanOrEqual(inserted.reAggregate.getTime());

      await expect(repo.getCourseCompletion(userId, courseId)).resolves.toMatchObject({ id: inserted.id });
      await expect(repo.listCourseCompletions(courseId)).resolves.toHaveLength(1);
    });
  });
});
