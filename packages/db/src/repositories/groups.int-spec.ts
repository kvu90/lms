import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { GroupsRepository } from './groups';

/**
 * Spec tích hợp của repository nhóm/cohort trên Kysely (issue
 * #645).
 *
 * Database trung tâm dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test. Mọi
 * ca chạy qua repository production ở `groups.ts` — không mô
 * phỏng handle.
 *
 * Các tính chất chốt tại đây:
 * - Ba điểm `onConflictDoNothing` của bản Drizzle cũ giữ đúng
 *   ngữ nghĩa: thêm thành viên nhóm trùng không lỗi, đưa nhóm
 *   vào grouping trùng không nhân đôi liên kết, và
 *   `addCohortMember` trả `true` đúng lần chèn thật, `false`
 *   khi đã là thành viên (hợp đồng sự kiện của GroupsService
 *   neo vào cờ này).
 * - `removeCohortMember` trả `true` đúng khi có dòng bị xoá.
 * - Insert không truyền id nhận id UUIDv7 do database sinh
 *   (phụ lục U); các truy vấn thành viên/nhóm của user khớp
 *   dữ kiện đã gieo.
 */

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g645_groups';
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let pool: Pool;
let db: CentreDb;
let repo: GroupsRepository;
let tenantId: string;
let courseId: string;

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec Kysely #645: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  repo = new GroupsRepository(db);

  const tenant = await db
    .insertInto('tenants')
    .values({ slug: 'g645-groups', name: 'Trung tâm spec G5 groups', kind: 'center' })
    .returning('id')
    .executeTakeFirstOrThrow();
  tenantId = tenant.id;
  const category = await db
    .insertInto('course_categories')
    .values({ tenant_id: tenant.id, name: 'Danh mục G5 groups' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const course = await db
    .insertInto('course')
    .values({ tenant_id: tenant.id, category: category.id, full_name: 'Khoá G5 groups', short_name: 'g645-groups-course', is_template: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  courseId = course.id;
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

describe('GroupsRepository trên Kysely (issue #645)', () => {
  it('thêm thành viên nhóm và chống nhân đôi đúng phạm vi của unique thật', async () => {
    const group = await repo.insertGroup({ courseId, name: 'Nhóm G5', idNumber: '', description: '', enrolmentKey: null });
    expect(group.id).toMatch(UUIDV7_PATTERN);
    const userId = randomUUID();
    await repo.addMember(group.id, userId);
    expect(await repo.listMembers(group.id)).toHaveLength(1);
    expect(await repo.isMember(group.id, userId)).toBe(true);
    expect((await repo.groupsOfUser(courseId, userId)).map((g) => g.id)).toEqual([group.id]);

    // Unique thật của `groups_members` là (group, user, component,
    // item_id): chống trùng của `onConflictDoNothing` chỉ neo được
    // khi item_id khác null — đúng hành vi của bản Drizzle cũ.
    const componentUser = randomUUID();
    const itemId = randomUUID();
    await repo.addMember(group.id, componentUser, 'auto', itemId);
    await repo.addMember(group.id, componentUser, 'auto', itemId);
    expect((await repo.listMembers(group.id)).filter((m) => m.userId === componentUser)).toHaveLength(1);

    await repo.removeMember(group.id, userId);
    expect(await repo.isMember(group.id, userId)).toBe(false);
  });

  it('đưa nhóm vào grouping trùng không nhân đôi liên kết', async () => {
    const grouping = await repo.insertGrouping({ courseId, name: 'Cụm G5', idNumber: '', description: '' });
    const group = await repo.insertGroup({ courseId, name: 'Nhóm trong cụm', idNumber: '', description: '', enrolmentKey: null });
    await repo.addGroupToGrouping(grouping.id, group.id);
    await repo.addGroupToGrouping(grouping.id, group.id);
    expect((await repo.groupsInGrouping(grouping.id)).map((g) => g.id)).toEqual([group.id]);
    await repo.removeGroupFromGrouping(grouping.id, group.id);
    expect(await repo.groupsInGrouping(grouping.id)).toEqual([]);
  });

  it('addCohortMember trả true đúng lần chèn thật và removeCohortMember trả true đúng khi có dòng bị xoá', async () => {
    const cohort = await repo.insertCohort({
      tenantId, name: 'Cohort G5', idNumber: '', description: '', contextId: randomUUID(), visible: true,
    });
    expect(cohort.id).toMatch(UUIDV7_PATTERN);
    const userId = randomUUID();
    expect(await repo.addCohortMember(cohort.id, userId)).toBe(true);
    expect(await repo.addCohortMember(cohort.id, userId)).toBe(false);
    expect(await repo.isCohortMember(cohort.id, userId)).toBe(true);
    expect((await repo.listCohortMembers(cohort.id)).map((m) => m.userId)).toEqual([userId]);

    expect(await repo.removeCohortMember(cohort.id, userId)).toBe(true);
    expect(await repo.removeCohortMember(cohort.id, userId)).toBe(false);
    expect(await repo.isCohortMember(cohort.id, userId)).toBe(false);
  });
});
