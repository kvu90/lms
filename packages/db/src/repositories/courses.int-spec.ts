import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { CoursesRepository, type CategoryRow } from './courses';

/**
 * Spec tích hợp của repository khoá học trên Kysely (issue #645).
 *
 * Database trung tâm dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test (biến
 * `LMS_DB_TEST_ADMIN_URL` ghi đè cụm khi cần, mặc định suy từ
 * `DATABASE_URL`). Mọi ca chạy qua repository production ở
 * `courses.ts` — không mô phỏng handle.
 *
 * Các tính chất chốt tại đây:
 * - Insert không truyền id nhận id UUIDv7 do database sinh
 *   (phụ lục U) và đọc lại nguyên vẹn qua chính repository.
 * - Cây category: path vật chất hoá + `subtreeOf` theo tiền tố
 *   path + `countSiblingCategories` trả `number` thật (ép
 *   `::int`, T-7).
 * - Jsonb `availability`: ghi/đọc khớp cả object lẫn MẢNG ở tầng
 *   cao nhất (đường nhân bản cm chép mảng availability), và đủ ba
 *   trạng thái của T-4 ở update patch — `undefined` giữ nguyên,
 *   `null` ghi SQL NULL, giá trị ghi qua xâu hoá + `::jsonb`.
 * - `shiftSections` hai pass qua vùng đệm +100000 giữ unique
 *   (course, section) và cho đúng số section đích.
 * - `setFormatOption` giữ cả hai nhánh của hợp đồng cũ: upsert
 *   thủ công khi `sectionId` null và `onConflictDoUpdate` trên
 *   unique bốn cột khi có section.
 * - Giao dịch của repository nguyên tử: lỗi giữa chừng rollback
 *   sạch dòng vừa ghi.
 */

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g645_courses';
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let pool: Pool;
let db: CentreDb;
let repo: CoursesRepository;
let tenantId: string;

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec Kysely #645: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  repo = new CoursesRepository(db);
  const tenant = await db
    .insertInto('tenants')
    .values({ slug: 'g645-courses', name: 'Trung tâm spec G5 courses', kind: 'center' })
    .returning('id')
    .executeTakeFirstOrThrow();
  tenantId = tenant.id;
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

/** Tạo một category gốc hoàn chỉnh (path/depth như đường tạo của service). */
async function makeCategory(name: string, parent: CategoryRow | null = null): Promise<CategoryRow> {
  const cat = await repo.insertCategory({
    tenantId,
    name,
    parent: parent?.id ?? null,
    sortOrder: 0,
    path: '',
    depth: 1,
  });
  const path = parent ? `${parent.path}/${cat.id}` : `/${cat.id}`;
  const depth = parent ? parent.depth + 1 : 1;
  await repo.updateCategoryPath(cat.id, path, depth);
  return { ...cat, path, depth };
}

describe('CoursesRepository trên Kysely (issue #645)', () => {
  it('chèn category nhận id UUIDv7 và cây con đọc lại đúng theo tiền tố path', async () => {
    const root = await makeCategory('Danh mục gốc G5');
    const child = await makeCategory('Danh mục con G5', root);
    const other = await makeCategory('Danh mục khác G5');

    expect(root.id).toMatch(UUIDV7_PATTERN);
    expect((await repo.getCategory(child.id))?.parent).toBe(root.id);

    const subtreeIds = (await repo.subtreeOf(root)).map((c) => c.id).sort();
    expect(subtreeIds).toEqual([root.id, child.id].sort());
    expect((await repo.subtreeOf(other)).map((c) => c.id)).toEqual([other.id]);

    const roots = await repo.countSiblingCategories(null);
    expect(typeof roots).toBe('number');
    expect(roots).toBe(2);
    expect(await repo.countSiblingCategories(root.id)).toBe(1);
    expect(await repo.countSiblingCategories(other.id)).toBe(0);
  });

  it('chèn khoá học và đọc lại theo id, theo shortName và theo danh mục', async () => {
    const cat = await makeCategory('Danh mục khoá G5');
    const course = await repo.insertCourse({
      tenantId,
      category: cat.id,
      fullName: 'Khoá mẫu G5',
      shortName: 'g645-course',
      isTemplate: true,
      sortOrder: 0,
    });
    expect(course.id).toMatch(UUIDV7_PATTERN);
    expect((await repo.getCourse(course.id))?.shortName).toBe('g645-course');
    expect((await repo.getCourseByShortname('g645-course'))?.id).toBe(course.id);
    expect((await repo.listCourses(cat.id)).map((c) => c.id)).toEqual([course.id]);
    expect(await repo.listCourses('00000000-0000-4000-8000-000000000000')).toEqual([]);
  });

  it('ghi/đọc jsonb availability khớp cả object và mảng, và patch update giữ đủ ba trạng thái T-4', async () => {
    const cat = await makeCategory('Danh mục jsonb G5');
    const course = await repo.insertCourse({ tenantId, category: cat.id, fullName: 'Khoá jsonb', shortName: 'g645-jsonb', isTemplate: true });
    const availabilityObject = { type: 'group', id: 'grp-1' };
    const section = await repo.insertSection({
      course: course.id, section: 0, name: 'Section 0', summary: '', visible: true,
      availability: availabilityObject,
    });
    expect((await repo.getSection(section.id))?.availability).toEqual(availabilityObject);

    // Patch không nhắc tới availability: giá trị giữ nguyên (undefined = không đổi).
    await repo.updateSection(section.id, { name: 'Section 0 đổi tên' });
    expect((await repo.getSection(section.id))?.availability).toEqual(availabilityObject);
    // Patch availability = null: ghi SQL NULL thật.
    await repo.updateSection(section.id, { availability: null });
    expect((await repo.getSection(section.id))?.availability).toBeNull();

    // Availability dạng MẢNG ở tầng cao nhất (cây điều kiện của cm).
    const availabilityArray = [{ type: 'date', time: 1893456000 }, { type: 'grade' }];
    const cm = await repo.insertCm({
      course: course.id, section: section.id, component: 'mod_quiz', instanceId: null,
      name: 'Bài kiểm tra', availability: availabilityArray,
    });
    expect(cm.id).toMatch(UUIDV7_PATTERN);
    expect((await repo.getCm(cm.id))?.availability).toEqual(availabilityArray);
    expect((await repo.listCmsInSection(section.id)).map((c) => c.id)).toEqual([cm.id]);
  });

  it('shiftSections hai pass qua vùng đệm chèn đúng hai vị trí mà không vỡ unique', async () => {
    const cat = await makeCategory('Danh mục dịch section G5');
    const course = await repo.insertCourse({ tenantId, category: cat.id, fullName: 'Khoá dịch', shortName: 'g645-shift', isTemplate: true });
    const s0 = await repo.insertSection({ course: course.id, section: 0, name: 'S0', summary: '', visible: true });
    const s1 = await repo.insertSection({ course: course.id, section: 1, name: 'S1', summary: '', visible: true });
    const s2 = await repo.insertSection({ course: course.id, section: 2, name: 'S2', summary: '', visible: true });

    await repo.transaction(async (tx) => {
      // Đúng hai pass của đường chèn khung: đẩy lên vùng đệm rồi kéo về vị trí đích +2.
      await repo.shiftSections(tx, course.id, 1, 100000);
      await repo.shiftSections(tx, course.id, 1 + 100000, 2 - 100000);
    });

    const after = await repo.listSections(course.id);
    expect(after.map((s) => [s.id, s.section])).toEqual([
      [s0.id, 0],
      [s1.id, 3],
      [s2.id, 4],
    ]);
  });

  it('setFormatOption giữ cả hai nhánh: thủ công khi sectionId null và onConflict bốn cột khi có section', async () => {
    const cat = await makeCategory('Danh mục format G5');
    const course = await repo.insertCourse({ tenantId, category: cat.id, fullName: 'Khoá format', shortName: 'g645-format', isTemplate: true });
    const section = await repo.insertSection({ course: course.id, section: 0, name: null, summary: '', visible: true });

    await repo.setFormatOption(course.id, 'topics', 'numsections', '4');
    await repo.setFormatOption(course.id, 'topics', 'numsections', '5');
    await repo.setFormatOption(course.id, 'topics', 'hiddensections', '1', section.id);
    await repo.setFormatOption(course.id, 'topics', 'hiddensections', '0', section.id);

    const options = await repo.listFormatOptions(course.id);
    expect(options).toHaveLength(2);
    expect(options.find((o) => o.name === 'numsections')?.value).toBe('5');
    expect(options.find((o) => o.name === 'numsections')?.sectionId).toBeNull();
    expect(options.find((o) => o.name === 'hiddensections')?.value).toBe('0');
    expect(options.find((o) => o.name === 'hiddensections')?.sectionId).toBe(section.id);
  });

  it('giao dịch của repository rollback sạch khi lỗi giữa chừng', async () => {
    const cat = await makeCategory('Danh mục rollback G5');
    const attempt = repo.transaction(async (tx) => {
      await repo.insertCourse(
        { tenantId, category: cat.id, fullName: 'Khoá huỷ', shortName: 'g645-rollback', isTemplate: true },
        tx,
      );
      throw new Error('Lỗi giả lập giữa giao dịch');
    });
    await expect(attempt).rejects.toThrow('Lỗi giả lập giữa giao dịch');
    expect(await repo.getCourseByShortname('g645-rollback')).toBeUndefined();
  });
});
