import { createCentreKysely, sql, type CentreDb } from '@lms/db';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '@lms/db/test-support';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadProgramDumpSql,
  restoreProgramDumpSql,
} from '../../../src/modules/curriculum/program-dump';

/**
 * Spec tích hợp ĐÓNG THỬ NGHIỆM T-12 (issue #646, nhóm G6):
 * `sql.raw` thi hành một script SQL NHIỀU câu lệnh (artifact
 * chương trình thật: 13.856 câu INSERT, không tham số, không
 * BEGIN/COMMIT, không SET LOCAL) bên trong MỘT transaction của
 * Kysely, với các câu builder (select trước, select + update neo
 * sau) chạy cùng transaction đó.
 *
 * Cơ sở hành vi: script không có tham số nên driver `pg` dùng
 * giao thức đơn giản (simple protocol) cho câu truy vấn — giao
 * thức này chấp nhận nhiều câu lệnh trong một lần gửi và cả khối
 * chạy trong transaction bao ngoài; một câu lỗi giữa script làm
 * transaction abort và rollback TOÀN BỘ, kể cả các câu INSERT đã
 * chạy trước nó. Hai ca dưới đây khoá cả hai phía trên database
 * thật dựng từ rỗng bằng cầu nối migration của `@lms/db`:
 * - Ca đầy đủ: restore trọn artifact thật, đếm dòng từng bảng
 *   khớp số đếm của artifact và mọi môn học được neo về context
 *   đích (bước update bằng builder chạy SAU sql.raw trong cùng
 *   transaction — bằng chứng các câu sau raw vẫn thuộc cùng
 *   transaction và commit cùng nhau).
 * - Ca rollback: chèn một câu INSERT sai cú pháp vào giữa script
 *   — restore phải ném lỗi và cả năm bảng đích vẫn 0 dòng.
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  withDatabase(
    process.env.DATABASE_URL ??
      process.env.LMS_TEST_DATABASE_URL ??
      'postgres://postgres:postgres@localhost:5432/lms_test_api',
    'postgres',
  );

const FULL_DB = 'lms_db_g646_t12_full';
const ROLLBACK_DB = 'lms_db_g646_t12_rollback';
const ANCHOR_CONTEXT_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a5001';

/** Số dòng kỳ vọng của artifact chương trình (đếm tại artifact `program-dump.sql` đi kèm module). */
const EXPECTED_COUNTS = {
  subjects: 19,
  curricula: 146,
  curriculum_nodes: 3718,
  learning_outcomes: 7802,
  curriculum_program_records: 2171,
} as const;

let fullDb: CentreDb;
let rollbackDb: CentreDb;

beforeAll(async () => {
  const fullUrl = await buildTestDatabase({ adminUrl, database: FULL_DB, store: 'centre' });
  fullDb = createCentreKysely(new Pool({ connectionString: fullUrl }));
  const rollbackUrl = await buildTestDatabase({ adminUrl, database: ROLLBACK_DB, store: 'centre' });
  rollbackDb = createCentreKysely(new Pool({ connectionString: rollbackUrl }));
}, 600_000);

afterAll(async () => {
  await fullDb.destroy().catch(() => undefined);
  await rollbackDb.destroy().catch(() => undefined);
  await dropTestDatabase(adminUrl, FULL_DB).catch(() => undefined);
  await dropTestDatabase(adminUrl, ROLLBACK_DB).catch(() => undefined);
});

/** Đếm dòng một bảng qua chính handle Kysely đang kiểm chứng. */
async function countRows(db: CentreDb, table: keyof typeof EXPECTED_COUNTS): Promise<number> {
  const result = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(db);
  return result.rows[0]?.n ?? -1;
}

describe('T-12: restoreProgramDumpSql trên Kysely (sql.raw đa câu lệnh trong transaction)', () => {
  it('restore trọn artifact thật: mọi bảng khớp số dòng của artifact và mọi môn học được neo về context đích', async () => {
    await restoreProgramDumpSql(fullDb, loadProgramDumpSql(), { anchorContextId: ANCHOR_CONTEXT_ID });
    for (const [table, expected] of Object.entries(EXPECTED_COUNTS)) {
      expect(await countRows(fullDb, table as keyof typeof EXPECTED_COUNTS)).toBe(expected);
    }
    const unanchored = await sql<{ n: number }>`
      select count(*)::int as n from subjects where context_id <> ${ANCHOR_CONTEXT_ID}
    `.execute(fullDb);
    expect(unanchored.rows[0]?.n).toBe(0);
  }, 300_000);

  it('một câu INSERT lỗi giữa script làm restore ném lỗi và rollback toàn bộ: cả năm bảng vẫn 0 dòng', async () => {
    const lines = loadProgramDumpSql().split('\n');
    const middle = Math.floor(lines.length / 2);
    lines.splice(
      middle,
      0,
      "INSERT INTO subjects (id, context_id, name, slug) VALUES ('khong-phai-uuid', 'x', 'y', 'z');",
    );
    const corrupted = lines.join('\n');
    await expect(
      restoreProgramDumpSql(rollbackDb, corrupted, { anchorContextId: ANCHOR_CONTEXT_ID }),
    ).rejects.toThrow();
    for (const table of Object.keys(EXPECTED_COUNTS) as (keyof typeof EXPECTED_COUNTS)[]) {
      expect(await countRows(rollbackDb, table)).toBe(0);
    }
  }, 300_000);
});
