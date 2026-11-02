import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { ContentRepository } from './content';

/**
 * Spec tích hợp của ContentRepository phía Kysely (issue #646,
 * nhóm G6). Database kho trung tâm dựng từ rỗng bằng cầu nối
 * migration của package trên cụm PostgreSQL thật; mọi ca chạy qua
 * repository production. Dữ kiện nền dựng theo đồ thị FK thật của
 * cụm (tenant → danh mục khoá → khoá → section → course module)
 * vì `pages.course`, `course_last_access.cm_id`,
 * `course_module_progress.cm_id` và `learning_records.cm_id` đều
 * là khoá ngoại thật. Các ca khoá: upsert onConflict của
 * last-access và module-progress (percent chỉ tăng, tính ở phía
 * mã), hai đường đọc lọc-trong-bộ-nhớ giữ nguyên từ repository cũ
 * (`getLastAccess` khớp khoá trong mã, `getModuleProgress` đối
 * chiếu user trong mã), và doNothing của learning record.
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g646_content';
const USER_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a3001';
const OTHER_USER_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a3002';
const OTHER_COURSE_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a3004';

let pool: Pool;
let db: CentreDb;
let repo: ContentRepository;
let courseId = '';
let cmIds: string[] = [];

beforeAll(async () => {
  if (!adminUrl) throw new Error('Thiếu LMS_DB_TEST_ADMIN_URL/DATABASE_URL cho spec tích hợp');
  const url = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: url });
  db = createCentreKysely(pool);
  repo = new ContentRepository(db);

  const [tenant] = await db.insertInto('tenants').values({
    slug: 'g6-content', name: 'Tenant G6 content', kind: 'center',
  }).returning(['id']).execute();
  const [category] = await db.insertInto('course_categories').values({
    tenant_id: tenant!.id, name: 'Danh mục G6',
  }).returning(['id']).execute();
  // Khoá mẫu (is_template) để qua check `course_class_required_check`
  // (khoá thường phải thuộc một lớp; spec này chỉ cần khoá làm đích FK).
  const [course] = await db.insertInto('course').values({
    tenant_id: tenant!.id, category: category!.id, full_name: 'Khoá G6', short_name: 'G6-CONTENT',
    is_template: true,
  }).returning(['id']).execute();
  courseId = course!.id;
  const [section] = await db.insertInto('course_sections').values({
    course: courseId,
  }).returning(['id']).execute();
  for (let i = 0; i < 5; i += 1) {
    const [cm] = await db.insertInto('course_modules').values({
      course: courseId, section: section!.id, component: 'page', name: `Mục ${i + 1}`,
    }).returning(['id']).execute();
    cmIds.push(cm!.id);
  }
}, 300_000);

afterAll(async () => {
  await db.destroy().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB).catch(() => undefined);
});

describe('ContentRepository (Kysely)', () => {
  it('chèn trang rồi liệt kê theo khoá, xoá theo cm thì trang biến mất', async () => {
    const page = await repo.insertPage({ course: courseId, cmId: cmIds[0]!, name: 'Trang G6', content: '<p>Nội dung</p>' });
    expect(page.content).toBe('<p>Nội dung</p>');
    const listed = await repo.listPages(courseId);
    expect(listed.map((p) => p.id)).toContain(page.id);
    await repo.deletePageByCm(cmIds[0]!);
    expect(await repo.getPage(page.id)).toBeUndefined();
  });

  it('upsertLastAccess lần hai trên cùng (user, khoá) cập nhật cm trên CÙNG một dòng', async () => {
    const first = await repo.upsertLastAccess(USER_ID, courseId, cmIds[1]!);
    const second = await repo.upsertLastAccess(USER_ID, courseId, cmIds[2]!);
    expect(second.id).toBe(first.id);
    expect(second.cmId).toBe(cmIds[2]!);
    const read = await repo.getLastAccess(USER_ID, courseId);
    expect(read?.cmId).toBe(cmIds[2]!);
  });

  it('getLastAccess trả undefined cho khoá khác dù user đã có dấu vết ở khoá khác (khớp khoá trong bộ nhớ)', async () => {
    await repo.upsertLastAccess(OTHER_USER_ID, courseId, cmIds[1]!);
    expect(await repo.getLastAccess(OTHER_USER_ID, OTHER_COURSE_ID)).toBeUndefined();
  });

  it('upsertModuleProgress giữ percent cao nhất đã đạt: báo thấp hơn không hạ tiến độ, báo cao hơn thì nâng', async () => {
    const cm = cmIds[3]!;
    await repo.upsertModuleProgress(USER_ID, courseId, cm, { percent: 40, positionSeconds: 30 });
    const lower = await repo.upsertModuleProgress(USER_ID, courseId, cm, { percent: 25, positionSeconds: 55 });
    expect(lower.percent).toBe(40);
    expect(lower.positionSeconds).toBe(55);
    const higher = await repo.upsertModuleProgress(USER_ID, courseId, cm, { percent: 80 });
    expect(higher.percent).toBe(80);
    expect(higher.positionSeconds).toBe(55);
  });

  it('getModuleProgress trả undefined khi cm thuộc về user khác (đối chiếu user trong bộ nhớ)', async () => {
    const cm = cmIds[4]!;
    await repo.upsertModuleProgress(USER_ID, courseId, cm, { percent: 10 });
    expect(await repo.getModuleProgress(OTHER_USER_ID, cm)).toBeUndefined();
    expect((await repo.getModuleProgress(USER_ID, cm))?.percent).toBe(10);
  });

  it('insertLearningRecord lần hai trên cùng (user, cm) bị bỏ qua: chỉ một bản ghi hoàn thành tồn tại', async () => {
    const cm = cmIds[2]!;
    await repo.insertLearningRecord({ userId: USER_ID, courseId, cmId: cm, cmName: 'Mục G6' });
    await repo.insertLearningRecord({ userId: USER_ID, courseId, cmId: cm, cmName: 'Mục G6 (lặp)' });
    const records = await repo.listLearningRecords(courseId);
    const mine = records.filter((r) => r.cmId === cm);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.cmName).toBe('Mục G6');
  });
});
