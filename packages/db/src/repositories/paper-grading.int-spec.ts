import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaperQuality, PaperReading, PaperRosterEntry, PaperSlotLayout } from '@lms/contracts';
import { createCentreKysely, type CentreDb } from '../client';
import type { ExamVariant } from '../quiz.schema';
import { examBatches, examScans } from '../paper-grading.schema';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { PaperGradingRepository } from './paper-grading';

/**
 * Spec tích hợp của repository chấm bài giấy trên Kysely (issue
 * #644).
 *
 * Database trung tâm dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test (biến
 * `LMS_DB_TEST_ADMIN_URL` ghi đè cụm khi cần, mặc định suy từ
 * `DATABASE_URL`). Mọi ca chạy qua repository production ở
 * `paper-grading.ts` — không mô phỏng handle.
 *
 * Các tính chất chốt tại đây:
 * - Ghi/đọc jsonb nghiệp vụ (`layout`/`roster` của lô, `quality`/
 *   `readings` của phiếu) khớp hai chiều Kysely ↔ Drizzle trên
 *   cùng dữ kiện mẫu (mục `JSONColumnType` của tài liệu Kysely +
 *   thử nghiệm T-6): phía Kysely ghi qua helper xâu hoá +
 *   `::jsonb`, phía Drizzle đọc lại phải thấy đúng giá trị.
 * - `readings` có DEFAULT `[]` của database: insert không truyền
 *   thì nhận mảng rỗng, repository không tự điền.
 * - Patch phiếu theo T-4 với cột jsonb nullable đủ ba trạng
 *   thái: `undefined` giữ nguyên, giá trị thay mới, `null` ghi
 *   SQL NULL.
 * - Lọc theo trạng thái, thứ tự theo thời gian tạo và phiếu mới
 *   nhất giữ nguyên hành vi của repository cũ. Repository không
 *   có bề mặt giao dịch ở bản cũ nên bản Kysely cũng không thêm
 *   (rủi ro R-G4-3) — spec này không kiểm tra tham số tx nào.
 */

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g644_paper_grading';
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Định danh cố định cho các cột tham chiếu mềm (file/user) — không có khoá ngoại. */
const ACTOR = '019276a1-4444-7000-8000-0000000000a9';
const STUDENT = '019276a1-4444-7000-8000-0000000000a8';
const QUESTION_ID = '019276a1-4444-7000-8000-0000000000a7';
const VERSION_ID = '019276a1-4444-7000-8000-0000000000a6';
const ANSWER_ID = '019276a1-4444-7000-8000-0000000000a5';
const FILE_1 = '019276a1-4444-7000-8000-0000000000a4';
const FILE_2 = '019276a1-4444-7000-8000-0000000000a3';
const FILE_3 = '019276a1-4444-7000-8000-0000000000a2';

const LAYOUT: PaperSlotLayout[] = [{
  slot: 1, questionId: QUESTION_ID, versionId: VERSION_ID, qtype: 'multichoice',
  optionCount: 4, answerIds: [ANSWER_ID], statementIds: [], maxMark: 1,
}];
const ROSTER: PaperRosterEntry[] = [{ code: '0001', userId: STUDENT, displayName: 'Học sinh Một' }];
const READINGS: PaperReading[] = [{
  slot: 1, densities: [0.9, 0.1, 0.05, 0.02], chosen: 0, state: 'filled', margin: 0.8, resolvedBy: 'omr',
}];
const QUALITY: PaperQuality = { blurVariance: 120.5, glareRatio: 0.01, fiducialCount: 4 };
const QUALITY_2: PaperQuality = { blurVariance: 98.25, glareRatio: 0.03, fiducialCount: 3 };

let pool: Pool;
let db: CentreDb;
let repo: PaperGradingRepository;
let drizzleDb: NodePgDatabase;

interface Seed {
  pinId: string;
}

let seed: Seed;

/** Gieo chuỗi neo tối thiểu tenant → khoá → bank → đề → version → pin qua Kysely thô. */
async function seedData(): Promise<Seed> {
  const tenant = await db.insertInto('tenants')
    .values({ slug: 'g644-paper', name: 'Tenant giấy G644', kind: 'centre' })
    .returning('id').executeTakeFirstOrThrow();
  const category = await db.insertInto('course_categories')
    .values({ name: 'Danh mục khoá giấy G644', tenant_id: tenant.id })
    .returning('id').executeTakeFirstOrThrow();
  const courseRow = await db.insertInto('course')
    .values({
      tenant_id: tenant.id, category: category.id,
      full_name: 'Khoá giấy G644', short_name: 'KH-GIAY-G644', is_template: true,
    })
    .returning('id').executeTakeFirstOrThrow();
  const bank = await db.insertInto('question_banks')
    .values({
      name: 'Bank giấy', scope: 'school', tenant_id: tenant.id,
      context_id: courseRow.id, created_by: ACTOR,
    })
    .returning('id').executeTakeFirstOrThrow();
  const exam = await db.insertInto('exams')
    .values({ bank_id: bank.id, created_by: ACTOR })
    .returning('id').executeTakeFirstOrThrow();
  const version = await db.insertInto('exam_versions')
    .values({ exam_id: exam.id, version: 1, name: 'Đề giấy 1', created_by: ACTOR })
    .returning('id').executeTakeFirstOrThrow();
  const pin = await db.insertInto('exam_pins')
    .values({ exam_id: exam.id, exam_version_id: version.id, course_id: courseRow.id, created_by: ACTOR, variants: sql<ExamVariant[]>`'[]'::jsonb` })
    .returning('id').executeTakeFirstOrThrow();
  return { pinId: pin.id };
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec Kysely #644: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  repo = new PaperGradingRepository(db);
  drizzleDb = drizzle({ client: pool });
  seed = await seedData();
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

describe('PaperGradingRepository trên Kysely (issue #644)', () => {
  it('insertBatch ghi layout/roster jsonb đọc lại nguyên vẹn qua cả Kysely và Drizzle', async () => {
    const batch = await repo.insertBatch({
      examPinId: seed.pinId, variantCode: 'A', examCode: '1001', codeDigits: 4,
      layout: LAYOUT, roster: ROSTER, createdBy: ACTOR,
    });
    expect(batch.id).toMatch(UUIDV7_PATTERN);
    expect(batch.layout).toEqual(LAYOUT);
    expect(batch.roster).toEqual(ROSTER);

    const mine = await repo.getBatch(batch.id);
    expect(mine).toEqual(batch);
    const oracle = await drizzleDb.select().from(examBatches).where(eq(examBatches.id, batch.id));
    expect(oracle[0]).toEqual(batch);

    const forPin = await repo.listBatchesForPin(seed.pinId);
    expect(forPin.map((b) => b.id)).toEqual([batch.id]);
  });

  it('insertScan tối thiểu nhận readings mặc định [] và status mặc định của database', async () => {
    const scan = await repo.insertScan({
      examPinId: seed.pinId, fileId: FILE_1, uploadedBy: ACTOR,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(scan.id).toMatch(UUIDV7_PATTERN);
    expect(scan.readings).toEqual([]);
    expect(scan.status).toBe('needs_identity');
    expect(scan.quality).toBeNull();
    expect(await repo.getScan(scan.id)).toEqual(scan);
  });

  it('insertScan đầy đủ: quality/readings jsonb khớp hai chiều Kysely ↔ Drizzle', async () => {
    const scan = await repo.insertScan({
      examPinId: seed.pinId, fileId: FILE_2, uploadedBy: ACTOR,
      status: 'needs_review', quality: QUALITY, readings: READINGS,
      variantCodeRead: '1001', identityCode: '0001', identitySource: 'bubbles',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });
    expect(scan.quality).toEqual(QUALITY);
    expect(scan.readings).toEqual(READINGS);
    const oracle = await drizzleDb.select().from(examScans).where(eq(examScans.id, scan.id));
    expect(oracle[0]).toEqual(scan);
  });

  it('updateScan với cột jsonb nullable đủ ba trạng thái: giữ nguyên / thay giá trị / ghi NULL', async () => {
    const scan = await repo.insertScan({
      examPinId: seed.pinId, fileId: FILE_3, uploadedBy: ACTOR, quality: QUALITY, readings: READINGS,
      createdAt: new Date('2026-01-03T00:00:00Z'),
    });
    // Không truyền quality → giữ nguyên; đổi status + gán học sinh.
    const step1 = await repo.updateScan(scan.id, { status: 'ready', studentId: STUDENT, identitySource: 'manual' });
    expect(step1.quality).toEqual(QUALITY);
    expect(step1.status).toBe('ready');
    expect(step1.studentId).toBe(STUDENT);
    // Truyền giá trị mới → thay.
    const step2 = await repo.updateScan(scan.id, { quality: QUALITY_2 });
    expect(step2.quality).toEqual(QUALITY_2);
    expect(step2.readings).toEqual(READINGS);
    // Truyền null tường minh → SQL NULL; readings thay bằng mảng mới.
    const step3 = await repo.updateScan(scan.id, { quality: null, readings: [] });
    expect(step3.quality).toBeNull();
    expect(step3.readings).toEqual([]);
    expect(step3.updatedAt.getTime()).toBeGreaterThanOrEqual(step2.updatedAt.getTime());
  });

  it('listScansForPin lọc theo trạng thái và giữ thứ tự tạo; latestScanForQuiz trả phiếu mới nhất; deleteScan xoá hẳn', async () => {
    const all = await repo.listScansForPin(seed.pinId);
    expect(all).toHaveLength(3);
    // Ba phiếu có created_at tường minh tăng dần 01-01 → 01-02 → 01-03.
    expect(all.map((s) => s.fileId)).toEqual([FILE_1, FILE_2, FILE_3]);
    const byStatus = await repo.listScansForPin(seed.pinId, 'needs_review');
    expect(byStatus.map((s) => s.fileId)).toEqual([FILE_2]);
    expect(await repo.listScansForPin(seed.pinId, 'recorded')).toEqual([]);

    const latest = await repo.latestScanForQuiz(seed.pinId);
    expect(latest?.fileId).toBe(FILE_3);

    await repo.deleteScan(latest!.id);
    expect(await repo.getScan(latest!.id)).toBeUndefined();
    expect(await repo.listScansForPin(seed.pinId)).toHaveLength(2);
  });
});
