import { and, asc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { gradeGrades, gradeItems, gradePublications } from '../grades.schema';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { GradesRepository, type GradeRow, type ItemRow } from './grades';

/**
 * Spec tích hợp của repository điểm theo bài trên Kysely (issue
 * #644).
 *
 * Database trung tâm dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test (biến
 * `LMS_DB_TEST_ADMIN_URL` ghi đè cụm khi cần, mặc định suy từ
 * `DATABASE_URL`). Mọi ca chạy qua repository production ở
 * `grades.ts` — không mô phỏng handle.
 *
 * Các tính chất chốt tại đây:
 * - CRUD item và các đường tìm item khớp oracle Drizzle (nguyên
 *   văn truy vấn của repository cũ) trên CÙNG dữ kiện mẫu.
 * - `upsertGrade` hai nhánh insert/xung đột theo khoá composite
 *   (item, user) cho kết quả TỪNG TRƯỜNG bằng oracle Drizzle —
 *   gồm điểm sắc nhất của nhóm theo T-4 (rủi ro R-G4-2): trường
 *   phía gọi không truyền (`undefined`) phải được GIỮ NGUYÊN ở
 *   nhánh xung đột ở cả hai phía, còn `null` tường minh thì ghi
 *   NULL ở cả hai phía; `updated_at` luôn làm mới.
 * - Patch item/grade theo T-4: trường không truyền không đổi.
 * - Lịch sử điểm và vết công bố giữ đúng thứ tự của bản cũ.
 * - Giao dịch của repository nguyên tử: lỗi giữa chừng rollback
 *   sạch dòng điểm đã ghi trong giao dịch.
 */

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g644_grades';
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** User/actor cố định — `grade_grades.user_id` không có khoá ngoại nên chỉ cần uuid hợp lệ. */
const U1 = '019276a1-4444-7000-8000-0000000000e1';
const U2 = '019276a1-4444-7000-8000-0000000000e2';
const ACTOR = '019276a1-4444-7000-8000-0000000000e3';
const CM_ID = '019276a1-4444-7000-8000-0000000000f1';
const CM_TWIN_ID = '019276a1-4444-7000-8000-0000000000f2';
const EMPTY_COURSE = '019276a1-4444-7000-8000-0000000000f2';

let pool: Pool;
let db: CentreDb;
let repo: GradesRepository;
let drizzleDb: NodePgDatabase;

interface Seed {
  courseId: string;
  itemA: ItemRow;
  itemB: ItemRow;
  itemTwin: ItemRow;
}

let seed: Seed;

/** Gieo tenant + khoá qua Kysely thô, item qua chính repository. */
async function seedData(): Promise<Seed> {
  const tenant = await db.insertInto('tenants')
    .values({ slug: 'g644-grades', name: 'Tenant điểm G644', kind: 'centre' })
    .returning('id').executeTakeFirstOrThrow();
  const category = await db.insertInto('course_categories')
    .values({ name: 'Danh mục khoá điểm G644', tenant_id: tenant.id })
    .returning('id').executeTakeFirstOrThrow();
  const courseRow = await db.insertInto('course')
    .values({
      tenant_id: tenant.id, category: category.id,
      full_name: 'Khoá điểm G644', short_name: 'KH-DIEM-G644', is_template: true,
    })
    .returning('id').executeTakeFirstOrThrow();

  const itemA = await repo.insertItem({
    courseId: courseRow.id, itemType: 'mod', itemModule: 'quiz', itemInstance: CM_ID,
    itemName: 'Bài kiểm tra 1', idNumber: 'IDN-1', sortOrder: 2, gradeMax: 10,
  });
  const itemB = await repo.insertItem({
    courseId: courseRow.id, itemType: 'manual', itemName: 'Bài tay 2', sortOrder: 1,
  });
  // Item sinh đôi cho oracle upsert: cùng hình dạng với itemA để hai phía
  // chạy độc lập; itemInstance phải khác itemA vì ràng buộc unique
  // (course_id, item_type, item_instance, item_module) của bảng grade_items.
  const itemTwin = await repo.insertItem({
    courseId: courseRow.id, itemType: 'mod', itemModule: 'quiz', itemInstance: CM_TWIN_ID,
    itemName: 'Bài kiểm tra 1 (sinh đôi)', sortOrder: 3, gradeMax: 10,
  });
  return { courseId: courseRow.id, itemA, itemB, itemTwin };
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec Kysely #644: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  repo = new GradesRepository(db);
  drizzleDb = drizzle({ client: pool });
  seed = await seedData();
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

// ---------------------------------------------------------------------------
// Oracle Drizzle: nguyên văn `upsertGrade` của repository cũ (apps/api
// trước #644) để đối chiếu tương đương trên cùng chuỗi lệnh ghi.
// ---------------------------------------------------------------------------

async function oracleUpsertGrade(v: typeof gradeGrades.$inferInsert): Promise<GradeRow> {
  const [row] = await drizzleDb.insert(gradeGrades).values(v)
    .onConflictDoUpdate({
      target: [gradeGrades.itemId, gradeGrades.userId],
      set: {
        rawGrade: v.rawGrade, finalGrade: v.finalGrade, hidden: v.hidden, locked: v.locked,
        overridden: v.overridden, excluded: v.excluded, frozen: v.frozen, feedback: v.feedback,
        aggregationStatus: v.aggregationStatus, aggregationWeight: v.aggregationWeight,
        lockTime: v.lockTime, updatedAt: new Date(),
      },
    }).returning();
  return row! as GradeRow;
}

/** Chiếu dòng điểm xuống các trường nghiệp vụ để so hai phía (bỏ định danh/thời gian). */
function comparableGrade(row: GradeRow) {
  return {
    userId: row.userId, rawGrade: row.rawGrade, finalGrade: row.finalGrade,
    rawGradeMax: row.rawGradeMax, rawGradeMin: row.rawGradeMin, hidden: row.hidden,
    locked: row.locked, overridden: row.overridden, excluded: row.excluded,
    feedback: row.feedback, frozen: row.frozen, aggregationStatus: row.aggregationStatus,
    aggregationWeight: row.aggregationWeight, lockTime: row.lockTime, information: row.information,
  };
}

describe('GradesRepository trên Kysely (issue #644)', () => {
  it('insertItem nhận id UUIDv7 và các mặc định của database; listItems sắp xếp theo sort_order rồi id', async () => {
    expect(seed.itemA.id).toMatch(UUIDV7_PATTERN);
    expect(seed.itemB.gradeMax).toBe(100);
    expect(seed.itemB.postingPolicy).toBe('auto');
    const items = await repo.listItems(seed.courseId);
    expect(items.map((i) => i.id)).toEqual([seed.itemB.id, seed.itemA.id, seed.itemTwin.id]);
    const oracle = await drizzleDb.select().from(gradeItems)
      .where(eq(gradeItems.courseId, seed.courseId))
      .orderBy(asc(gradeItems.sortOrder), asc(gradeItems.id));
    expect(items).toEqual(oracle);
  });

  it('các đường tìm item theo (type, instance), theo course module và theo idNumber khớp oracle', async () => {
    expect(await repo.findItemByTypeInstance(seed.courseId, 'mod', CM_ID)).toEqual(seed.itemA);
    expect(await repo.findItemForCm(seed.courseId, CM_ID)).toEqual(seed.itemA);
    expect(await repo.findItemByIdnumber(seed.courseId, 'IDN-1')).toEqual(seed.itemA);
    expect(await repo.findItemByIdnumber(seed.courseId, 'KHONG-CO')).toBeUndefined();
    expect(await repo.getItem(seed.itemB.id)).toEqual(seed.itemB);
  });

  it('updateItem chỉ đổi trường được truyền trong patch, trường còn lại giữ nguyên', async () => {
    await repo.updateItem(seed.itemB.id, { itemName: 'Bài tay 2 (đổi tên)', gradePass: 5 });
    const after = await repo.getItem(seed.itemB.id);
    expect(after?.itemName).toBe('Bài tay 2 (đổi tên)');
    expect(after?.gradePass).toBe(5);
    expect(after?.gradeMax).toBe(seed.itemB.gradeMax);
    expect(after?.sortOrder).toBe(seed.itemB.sortOrder);
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(seed.itemB.updatedAt.getTime());
  });

  it('upsertGrade nhánh insert trả dòng đầy đủ và đọc lại được qua getGrade', async () => {
    const saved = await repo.upsertGrade({
      itemId: seed.itemA.id, userId: U1, rawGrade: 8, rawGradeMin: 0, rawGradeMax: 10,
      finalGrade: 8, feedback: 'Tốt', hidden: false, locked: false, overridden: false,
      excluded: false, frozen: false, aggregationStatus: 'used', aggregationWeight: null,
    });
    expect(saved.id).toMatch(UUIDV7_PATTERN);
    expect(saved.finalGrade).toBe(8);
    expect(await repo.getGrade(seed.itemA.id, U1)).toEqual(saved);
  });

  it('upsertGrade nhánh xung đột: trường không truyền được giữ nguyên, null tường minh ghi NULL — khớp oracle Drizzle từng trường', async () => {
    // Chuỗi hai lần ghi GIỐNG HỆT nhau cho hai phía trên hai item độc lập.
    const first = {
      rawGrade: 7, rawGradeMin: 0, rawGradeMax: 10, finalGrade: 7, feedback: 'Lần 1',
      hidden: true, locked: false, overridden: false, excluded: false, frozen: false,
      aggregationStatus: 'used', aggregationWeight: 0.5, lockTime: new Date('2026-01-10T00:00:00Z'),
    };
    await repo.upsertGrade({ itemId: seed.itemA.id, userId: U2, ...first });
    await oracleUpsertGrade({ itemId: seed.itemTwin.id, userId: U2, ...first });

    // Lần hai: feedback/hidden/aggregationWeight KHÔNG truyền (undefined);
    // lockTime truyền null tường minh; finalGrade đổi.
    const second = {
      rawGrade: 9, rawGradeMin: 0, rawGradeMax: 10, finalGrade: 9,
      locked: false, overridden: true, excluded: false, frozen: false,
      aggregationStatus: 'used', lockTime: null,
    };
    const mine = await repo.upsertGrade({ itemId: seed.itemA.id, userId: U2, ...second });
    const oracle = await oracleUpsertGrade({ itemId: seed.itemTwin.id, userId: U2, ...second });

    expect(comparableGrade(mine)).toEqual(comparableGrade(oracle));
    // Chốt tường minh ba trạng thái của T-4 ở phía Kysely:
    expect(mine.feedback).toBe('Lần 1');
    expect(mine.hidden).toBe(true);
    expect(mine.aggregationWeight).toBe(0.5);
    expect(mine.lockTime).toBeNull();
    expect(mine.finalGrade).toBe(9);
  });

  it('updateGrade theo patch và lịch sử điểm giữ thứ tự theo id như bản cũ', async () => {
    await repo.insertHistory({
      action: 1, oldId: null, itemId: seed.itemA.id, userId: U1,
      rawGrade: 8, finalGrade: 8, overridden: false, excluded: false, frozen: false,
      source: 'manual', loggedUser: ACTOR,
    });
    await repo.updateGrade((await repo.getGrade(seed.itemA.id, U1))!.id, { overridden: true, feedback: 'Đã ghi đè' });
    await repo.insertHistory({
      action: 2, oldId: null, itemId: seed.itemA.id, userId: U1,
      rawGrade: 8, finalGrade: 8, overridden: true, excluded: false, frozen: false,
      source: 'override', loggedUser: ACTOR,
    });

    const grade = await repo.getGrade(seed.itemA.id, U1);
    expect(grade?.overridden).toBe(true);
    expect(grade?.feedback).toBe('Đã ghi đè');
    expect(grade?.rawGrade).toBe(8);

    const history = await repo.listHistory(seed.itemA.id, U1);
    expect(history.map((h) => h.action)).toEqual([1, 2]);
    expect(history.map((h) => h.source)).toEqual(['manual', 'override']);
  });

  it('listGradesForCourse gom điểm qua các item của khoá, lọc được theo user; khoá rỗng trả []', async () => {
    const all = await repo.listGradesForCourse(seed.courseId);
    expect(all.map((g) => `${g.itemId}:${g.userId}`).sort()).toEqual([
      `${seed.itemA.id}:${U1}`, `${seed.itemA.id}:${U2}`, `${seed.itemTwin.id}:${U2}`,
    ].sort());
    const onlyU1 = await repo.listGradesForCourse(seed.courseId, U1);
    expect(onlyU1).toHaveLength(1);
    expect(onlyU1[0]?.userId).toBe(U1);
    expect(await repo.listGradesForCourse(EMPTY_COURSE)).toEqual([]);
    expect((await repo.listGradesForItem(seed.itemA.id)).map((g) => g.userId).sort()).toEqual([U1, U2].sort());
  });

  it('vết công bố: chèn và liệt kê theo thứ tự thời gian khớp oracle', async () => {
    await repo.insertPublication({
      courseId: seed.courseId, itemId: seed.itemA.id, action: 'publish', scope: 'item',
      actorId: ACTOR, note: 'Công bố lần 1', createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.insertPublication({
      courseId: seed.courseId, itemId: seed.itemA.id, action: 'unpublish', scope: 'item',
      actorId: ACTOR, createdAt: new Date('2026-01-02T00:00:00Z'),
    });
    const mine = await repo.listPublications(seed.courseId);
    expect(mine.map((p) => p.action)).toEqual(['publish', 'unpublish']);
    const oracle = await drizzleDb.select().from(gradePublications)
      .where(eq(gradePublications.courseId, seed.courseId))
      .orderBy(asc(gradePublications.createdAt), asc(gradePublications.id));
    expect(mine).toEqual(oracle);
  });

  it('transaction của repository rollback sạch dòng điểm khi hàm truyền vào ném lỗi', async () => {
    const ghostItem = await repo.insertItem({ courseId: seed.courseId, itemName: 'Item rollback' });
    await expect(repo.transaction(async (tx) => {
      await repo.upsertGrade({ itemId: ghostItem.id, userId: U1, rawGrade: 1, finalGrade: 1 }, tx);
      throw new Error('huỷ giao dịch mẫu');
    })).rejects.toThrow('huỷ giao dịch mẫu');
    expect(await repo.getGrade(ghostItem.id, U1)).toBeUndefined();
  });

  it('deleteItem xoá item và điểm của item bị cascade dọn theo', async () => {
    const item = await repo.insertItem({ courseId: seed.courseId, itemName: 'Item xoá' });
    await repo.upsertGrade({ itemId: item.id, userId: U1, rawGrade: 3, finalGrade: 3 });
    await repo.deleteItem(item.id);
    expect(await repo.getItem(item.id)).toBeUndefined();
    const left = await drizzleDb.select().from(gradeGrades)
      .where(and(eq(gradeGrades.itemId, item.id)));
    expect(left).toEqual([]);
  });
});
