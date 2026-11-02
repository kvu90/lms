import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { ContentBankRepository } from './content-bank';

/**
 * Spec tích hợp của ContentBankRepository phía Kysely (issue
 * #646, nhóm G6). Database kho trung tâm dựng từ rỗng bằng cầu
 * nối migration của package trên cụm PostgreSQL thật; mọi ca chạy
 * qua repository production. Các ca khoá: chuyển đổi tường minh
 * `size_bytes` int8 (đọc là string theo luật T-7) về `number` ở
 * biên repository; ghi các cột jsonb dạng mảng/object qua
 * serialize + `::jsonb`; bộ lọc động của `listFiltered`; và hình
 * dạng CohortRow của `listCohortsForUser` qua join
 * cohort_members → cohort.
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g646_content_bank';
const CONTEXT_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a4001';
const CREATOR_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a4002';
const TENANT_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a4003';

let pool: Pool;
let db: CentreDb;
let repo: ContentBankRepository;

beforeAll(async () => {
  if (!adminUrl) throw new Error('Thiếu LMS_DB_TEST_ADMIN_URL/DATABASE_URL cho spec tích hợp');
  const url = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: url });
  db = createCentreKysely(pool);
  repo = new ContentBankRepository(db);
}, 300_000);

afterAll(async () => {
  await db.destroy().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB).catch(() => undefined);
});

describe('ContentBankRepository (Kysely)', () => {
  it('chèn học liệu rồi đọc lại: sizeBytes là number (chuyển từ int8 string ở biên), các cột jsonb nguyên vẹn kể cả mảng', async () => {
    const created = await repo.insert({
      name: 'Học liệu G6', contextId: CONTEXT_ID, creatorId: CREATOR_ID,
      sizeBytes: 1234567, outcomeIds: ['o-1', 'o-2'], keywords: ['toán', 'lớp 3'],
      configData: { pages: 12 }, reviewChecklist: [{ key: 'copyright', ok: true }],
    });
    expect(typeof created.sizeBytes).toBe('number');
    expect(created.sizeBytes).toBe(1234567);
    const read = await repo.get(created.id);
    expect(read).toEqual(created);
    expect(read?.outcomeIds).toEqual(['o-1', 'o-2']);
    expect(read?.keywords).toEqual(['toán', 'lớp 3']);
    expect(read?.configData).toEqual({ pages: 12 });
    expect(read?.reviewChecklist).toEqual([{ key: 'copyright', ok: true }]);
  });

  it('học liệu không có sizeBytes đọc lại sizeBytes là null chứ không phải NaN hay 0', async () => {
    const created = await repo.insert({ name: 'Không dung lượng', contextId: CONTEXT_ID, creatorId: CREATOR_ID });
    expect(created.sizeBytes).toBeNull();
  });

  it('listFiltered áp từng điều kiện được truyền và bỏ qua điều kiện vắng mặt', async () => {
    // subject_id là FK thật tới subjects: dựng hai môn học trước.
    const [subjectA] = await db.insertInto('subjects').values({
      context_id: CONTEXT_ID, name: 'Môn lọc A', slug: 'loc-a-g6',
    }).returning(['id']).execute();
    const [subjectB] = await db.insertInto('subjects').values({
      context_id: CONTEXT_ID, name: 'Môn lọc B', slug: 'loc-b-g6',
    }).returning(['id']).execute();
    await repo.insert({
      name: 'Lọc A', contextId: CONTEXT_ID, creatorId: CREATOR_ID,
      subjectId: subjectA!.id, grade: 3, reviewStatus: 'approved',
    });
    await repo.insert({
      name: 'Lọc B', contextId: CONTEXT_ID, creatorId: CREATOR_ID,
      subjectId: subjectB!.id, grade: 4, reviewStatus: 'pending',
    });
    const byGrade = await repo.listFiltered({ grade: 3 });
    expect(byGrade.map((r) => r.name)).toEqual(['Lọc A']);
    const byStatus = await repo.listFiltered({ reviewStatus: 'pending' });
    expect(byStatus.map((r) => r.name)).toEqual(['Lọc B']);
    const unfiltered = await repo.listFiltered({});
    expect(unfiltered.length).toBeGreaterThanOrEqual(2);
  });

  it('update áp một phần: trường truyền vào đổi, trường vắng mặt giữ nguyên, jsonb ghi lại đúng', async () => {
    const created = await repo.insert({
      name: 'Sửa một phần', contextId: CONTEXT_ID, creatorId: CREATOR_ID, keywords: ['cũ'],
    });
    await repo.update(created.id, { name: 'Đã sửa', keywords: ['mới', 'bổ sung'] });
    const read = await repo.get(created.id);
    expect(read?.name).toBe('Đã sửa');
    expect(read?.keywords).toEqual(['mới', 'bổ sung']);
    expect(read?.contextId).toBe(CONTEXT_ID);
  });

  it('listCohortsForUser trả đúng CohortRow của các cohort user là thành viên, isCohortMember khớp theo từng phía', async () => {
    // cohort.tenant_id là FK thật tới tenants: dựng tenant trước.
    await db.insertInto('tenants').values({
      id: TENANT_ID, slug: 'g6-content-bank', name: 'Tenant G6', kind: 'center',
    }).execute();
    const [cohort] = await db.insertInto('cohort').values({
      tenant_id: TENANT_ID, name: 'Tổ Toán', context_id: CONTEXT_ID,
    }).returning(['id']).execute();
    await db.insertInto('cohort_members').values({ cohort_id: cohort!.id, user_id: CREATOR_ID }).execute();
    const cohorts = await repo.listCohortsForUser(CREATOR_ID);
    const mine = cohorts.find((c) => c.id === cohort!.id);
    expect(mine?.name).toBe('Tổ Toán');
    expect(mine?.tenantId).toBe(TENANT_ID);
    expect(await repo.isCohortMember(cohort!.id, CREATOR_ID)).toBe(true);
    expect(await repo.isCohortMember(cohort!.id, '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a4099')).toBe(false);
  });
});
