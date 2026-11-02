import { asc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql as drizzleSql } from 'drizzle-orm';
import { sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import type { LearningOutcomeDoc } from '../curriculum.schema';
import type { ExamVariant } from '../quiz.schema';
import {
  question, questionBankContributions, questionBankEntries, questionBanks, questionCategories,
} from '../questions.schema';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { QuestionBanksRepository, type QuestionBankRow } from './question-banks';

/**
 * Spec tích hợp của repository ngân hàng câu hỏi trên Kysely
 * (issue #644).
 *
 * Database trung tâm dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test (biến
 * `LMS_DB_TEST_ADMIN_URL` ghi đè cụm khi cần, mặc định suy từ
 * `DATABASE_URL`). Mọi ca chạy qua repository production ở
 * `question-banks.ts` — không mô phỏng handle.
 *
 * Các tính chất chốt tại đây:
 * - Insert bank không truyền id nhận id UUIDv7 do database sinh
 *   (phụ lục U); insert có id tường minh (hình dạng `buildBank`
 *   cấp id trước để dựng context) giữ đúng id đó.
 * - Mọi đường đọc bank/category/câu hỏi-kèm-entry khớp oracle
 *   Drizzle (nguyên văn truy vấn của repository cũ) trên CÙNG dữ
 *   kiện mẫu, gồm hình dạng lồng `{ q, entry }` của phép nối.
 * - CTE đệ quy gom YCCĐ theo node cho cùng tập id với chính thân
 *   SQL cũ chạy qua đường execute của Drizzle (điểm nóng của
 *   nhóm: bản Kysely bỏ lớp ép kiểu `as unknown as { rows }` nhờ
 *   `QueryResult.rows` đã có kiểu — kết quả phải không đổi).
 * - Tín hiệu sử dụng (đếm slot theo `count(*)::int`, đề chứa câu,
 *   pin dùng câu có distinct) và tra cứu người (tên hiển thị có
 *   đường lui về username, danh sách theo archetype có distinct)
 *   khớp oracle.
 * - Patch đóng góp/entry theo T-4: trường `undefined` không đổi,
 *   trường được truyền đổi đúng, `updated_at` luôn làm mới.
 * - Giao dịch của repository nguyên tử: lỗi giữa chừng rollback
 *   sạch dòng bank đã ghi trong giao dịch.
 */

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g644_question_banks';
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Ngữ cảnh cố định — các cột `context_id` không có khoá ngoại nên chỉ cần uuid hợp lệ. */
const CONTEXT_ID = '019276a1-4444-7000-8000-0000000000c1';
const COURSE_ID = '019276a1-4444-7000-8000-0000000000d1';
const EXPLICIT_BANK_ID = '019276a1-4444-7000-8000-0000000000b1';
const TX_BANK_ID = '019276a1-4444-7000-8000-0000000000b2';

let pool: Pool;
let db: CentreDb;
let repo: QuestionBanksRepository;
let drizzleDb: NodePgDatabase;

interface Seed {
  tenantId: string;
  u1: string;
  u2: string;
  platformBank: QuestionBankRow;
  schoolBank: QuestionBankRow;
  personalBank: QuestionBankRow;
  courseBank: QuestionBankRow;
  catA: string;
  catA2: string;
  catB: string;
  q1: string;
  q2: string;
  q3: string;
  e3: string;
  nodeRoot: string;
  nodeChild: string;
  oRoot: string;
  oChild: string;
  oGrand: string;
  oOther: string;
  v1: string;
  v2: string;
  pin1: string;
  pin2: string;
  pin3: string;
  c1: string;
  c2: string;
}

let seed: Seed;

/** Gieo đồ thị dữ kiện mẫu: tenant/người/vai, bank qua repository, phần còn lại qua Kysely thô. */
async function seedData(): Promise<Seed> {
  const tenant = await db.insertInto('tenants')
    .values({ slug: 'g644-tenant', name: 'Tenant G644', kind: 'centre' })
    .returning('id').executeTakeFirstOrThrow();
  const u1 = await db.insertInto('users')
    .values({ email: 'gv1@g644.test', username: 'gv1', first_name: 'Giang', last_name: 'Pham' })
    .returning('id').executeTakeFirstOrThrow();
  const u2 = await db.insertInto('users')
    .values({ email: 'hs1@g644.test', username: 'hs1', first_name: '', last_name: '' })
    .returning('id').executeTakeFirstOrThrow();
  const rTeacher = await db.insertInto('role')
    .values({ short_name: 'editingteacher', archetype: 'editingteacher' })
    .returning('id').executeTakeFirstOrThrow();
  const rStudent = await db.insertInto('role')
    .values({ short_name: 'student', archetype: 'student' })
    .returning('id').executeTakeFirstOrThrow();
  // role_assignments.context_id có khoá ngoại thật tới bảng context:
  // gieo hai context tối thiểu mang đúng các id hằng số dùng bên dưới.
  await db.insertInto('context')
    .values({ id: CONTEXT_ID, context_level: 10, depth: 1, path: '/1', instance_id: null }).execute();
  await db.insertInto('context')
    .values({ id: COURSE_ID, context_level: 50, depth: 2, path: '/1/2', instance_id: COURSE_ID }).execute();
  await db.insertInto('role_assignments')
    .values({ user_id: u1.id, role_id: rTeacher.id, context_id: CONTEXT_ID }).execute();
  await db.insertInto('role_assignments')
    .values({ user_id: u2.id, role_id: rStudent.id, context_id: CONTEXT_ID }).execute();
  // Gán trùng vai cho u1 ở context khác: phép distinct của listUserIdsWithArchetypes phải khử.
  await db.insertInto('role_assignments')
    .values({ user_id: u1.id, role_id: rTeacher.id, context_id: COURSE_ID }).execute();

  const category = await db.insertInto('course_categories')
    .values({ name: 'Danh mục khoá G644', tenant_id: tenant.id })
    .returning('id').executeTakeFirstOrThrow();
  await db.insertInto('course')
    .values({
      id: COURSE_ID, tenant_id: tenant.id, category: category.id,
      full_name: 'Khoá G644', short_name: 'KH-G644', is_template: true,
    })
    .execute();

  const platformBank = await repo.insertBank({
    name: 'Ngân hàng hệ thống', scope: 'platform', tenantId: null, ownerId: null,
    scopeRefId: null, contextId: CONTEXT_ID, createdBy: u1.id,
  });
  const schoolBank = await repo.insertBank({
    name: 'Bank trường', scope: 'school', tenantId: tenant.id, ownerId: null,
    scopeRefId: null, contextId: CONTEXT_ID, createdBy: u1.id,
  });
  const personalBank = await repo.insertBank({
    name: 'Bank cá nhân', scope: 'personal', tenantId: tenant.id, ownerId: u1.id,
    scopeRefId: null, contextId: CONTEXT_ID, createdBy: u1.id,
  });
  const courseBank = await repo.insertBank({
    name: 'Bank khoá', scope: 'course', tenantId: tenant.id, ownerId: null,
    scopeRefId: COURSE_ID, contextId: CONTEXT_ID, createdBy: u1.id,
  });

  const mkCategory = async (name: string, bankId: string, stamp: string, createdAt: string) => {
    const row = await db.insertInto('question_categories')
      .values({
        name, context_id: CONTEXT_ID, bank_id: bankId, info: '', parent: null,
        stamp, created_at: new Date(createdAt),
      })
      .returning('id').executeTakeFirstOrThrow();
    return row.id;
  };
  const catA = await mkCategory('Danh mục A', schoolBank.id, 'g644-a', '2026-01-01T00:00:00Z');
  const catA2 = await mkCategory('Danh mục A2', schoolBank.id, 'g644-a2', '2026-01-02T00:00:00Z');
  const catB = await mkCategory('Danh mục B', schoolBank.id, 'g644-b', '2026-01-03T00:00:00Z');
  await mkCategory('Danh mục platform', platformBank.id, 'g644-p', '2026-01-01T00:00:00Z');

  const mkQuestion = async (categoryId: string, qtype: string, createdAt: string) => {
    const row = await db.insertInto('question')
      .values({ category: categoryId, qtype, created_by: u1.id, created_at: new Date(createdAt) })
      .returning('id').executeTakeFirstOrThrow();
    return row.id;
  };
  const q1 = await mkQuestion(catA, 'multichoice', '2026-01-01T00:00:00Z');
  const q2 = await mkQuestion(catA, 'essay', '2026-01-02T00:00:00Z');
  const q3 = await mkQuestion(catB, 'multichoice', '2026-01-03T00:00:00Z');
  const mkEntry = async (categoryId: string, questionId: string, latestVersion: number, status: string) => {
    const row = await db.insertInto('question_bank_entries')
      .values({ question_category_id: categoryId, question_id: questionId, latest_version: latestVersion, status })
      .returning('id').executeTakeFirstOrThrow();
    return row.id;
  };
  await mkEntry(catA, q1, 1, 'ready');
  await mkEntry(catA, q2, 2, 'draft');
  const e3 = await mkEntry(catB, q3, 1, 'ready');

  const subject = await db.insertInto('subjects')
    .values({ context_id: CONTEXT_ID, name: 'Toán', slug: 'toan-g644' })
    .returning('id').executeTakeFirstOrThrow();
  const curriculum = await db.insertInto('curricula')
    .values({ subject_id: subject.id, grade: 10 })
    .returning('id').executeTakeFirstOrThrow();
  const mkNode = async (title: string, parentId: string | null) => {
    const row = await db.insertInto('curriculum_nodes')
      .values({ curriculum_id: curriculum.id, title, kind: 'topic', parent_id: parentId })
      .returning('id').executeTakeFirstOrThrow();
    return row.id;
  };
  const nodeRoot = await mkNode('Chương gốc', null);
  const nodeChild = await mkNode('Bài con', nodeRoot);
  const nodeGrand = await mkNode('Mục cháu', nodeChild);
  const nodeOther = await mkNode('Chương khác', null);
  const outcomeDoc = sql<LearningOutcomeDoc>`'{"type":"doc","content":[]}'::jsonb`;
  const mkOutcome = async (nodeId: string) => {
    const row = await db.insertInto('learning_outcomes')
      .values({ node_id: nodeId, content: outcomeDoc, source_kind: 'program' })
      .returning('id').executeTakeFirstOrThrow();
    return row.id;
  };
  const oRoot = await mkOutcome(nodeRoot);
  const oChild = await mkOutcome(nodeChild);
  const oGrand = await mkOutcome(nodeGrand);
  const oOther = await mkOutcome(nodeOther);

  const exam = await db.insertInto('exams')
    .values({ bank_id: schoolBank.id, created_by: u1.id })
    .returning('id').executeTakeFirstOrThrow();
  const mkVersion = async (version: number, name: string, createdAt: string) => {
    const row = await db.insertInto('exam_versions')
      .values({ exam_id: exam.id, version, name, created_by: u1.id, created_at: new Date(createdAt) })
      .returning('id').executeTakeFirstOrThrow();
    return row.id;
  };
  const v1 = await mkVersion(1, 'Đề mẫu 1', '2026-01-01T00:00:00Z');
  const v2 = await mkVersion(2, 'Đề mẫu 2', '2026-01-02T00:00:00Z');
  await db.insertInto('exam_slots').values({ exam_version_id: v1, question_id: q1, position: 1 }).execute();
  await db.insertInto('exam_slots').values({ exam_version_id: v1, question_id: q2, position: 2 }).execute();
  await db.insertInto('exam_slots').values({ exam_version_id: v2, question_id: q1, position: 1 }).execute();
  const mkPin = async (versionId: string) => {
    const row = await db.insertInto('exam_pins')
      .values({ exam_id: exam.id, exam_version_id: versionId, course_id: COURSE_ID, created_by: u1.id, variants: sql<ExamVariant[]>`'[]'::jsonb` })
      .returning('id').executeTakeFirstOrThrow();
    return row.id;
  };
  const pin1 = await mkPin(v1);
  const pin2 = await mkPin(v1);
  const pin3 = await mkPin(v2);

  const usage = await db.insertInto('question_usages')
    .values({ component: 'mod_quiz', instance_id: pin1, owning_context_id: CONTEXT_ID, user_id: u1.id })
    .returning('id').executeTakeFirstOrThrow();
  await db.insertInto('question_attempts')
    .values({ question_usage_id: usage.id, slot: 1, question_id: q1 }).execute();
  await db.insertInto('question_attempts')
    .values({ question_usage_id: usage.id, slot: 2, question_id: q1 }).execute();

  const c1 = await repo.insertContribution({ targetBankId: schoolBank.id, questionId: q3, proposerId: u2.id });
  const c2 = await repo.insertContribution({ targetBankId: schoolBank.id, questionId: q1, proposerId: u1.id });

  return {
    tenantId: tenant.id, u1: u1.id, u2: u2.id,
    platformBank, schoolBank, personalBank, courseBank,
    catA, catA2, catB, q1, q2, q3, e3,
    nodeRoot, nodeChild, oRoot, oChild, oGrand, oOther,
    v1, v2, pin1, pin2, pin3, c1: c1.id, c2: c2.id,
  };
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec Kysely #644: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  repo = new QuestionBanksRepository(db);
  drizzleDb = drizzle({ client: pool });
  seed = await seedData();
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

describe('QuestionBanksRepository trên Kysely (issue #644)', () => {
  it('insertBank không truyền id nhận id UUIDv7 do database sinh và đọc lại nguyên vẹn', async () => {
    expect(seed.schoolBank.id).toMatch(UUIDV7_PATTERN);
    const back = await repo.getBank(seed.schoolBank.id);
    expect(back).toEqual(seed.schoolBank);
  });

  it('insertBank giữ id do phía gọi cấp trước (hình dạng buildBank dựng context trỏ về bank)', async () => {
    const bank = await repo.insertBank({
      id: EXPLICIT_BANK_ID, name: 'Bank id tường minh', scope: 'platform', tenantId: null,
      ownerId: null, scopeRefId: null, contextId: CONTEXT_ID, createdBy: seed.u1,
    });
    expect(bank.id).toBe(EXPLICIT_BANK_ID);
    expect(await repo.getBank(EXPLICIT_BANK_ID)).toEqual(bank);
  });

  it('tra cứu bank theo scope và theo lô khớp oracle Drizzle trên cùng dữ kiện', async () => {
    const personal = await drizzleDb.select().from(questionBanks)
      .where(eq(questionBanks.scope, 'personal'));
    expect(await repo.getPersonalBank(seed.u1)).toEqual(personal[0]);
    expect(await repo.getSchoolBank(seed.tenantId)).toEqual(seed.schoolBank);
    expect(await repo.getPlatformBank()).toEqual(seed.platformBank);
    expect(await repo.getBankByScopeRef('course', COURSE_ID)).toEqual(seed.courseBank);
    expect(await repo.getCourseTenantId(COURSE_ID)).toBe(seed.tenantId);

    const byIds = await repo.getBanksByIds([seed.schoolBank.id, seed.personalBank.id]);
    expect(byIds.map((b) => b.id).sort()).toEqual([seed.personalBank.id, seed.schoolBank.id].sort());
    expect(await repo.getBanksByIds([])).toEqual([]);

    const schoolByTenants = await repo.listSchoolBanksByTenantIds([seed.tenantId]);
    expect(schoolByTenants.map((b) => b.id)).toEqual([seed.schoolBank.id]);
    const byScopeRefs = await repo.listBanksByScopeRefs('course', [COURSE_ID]);
    expect(byScopeRefs.map((b) => b.id)).toEqual([seed.courseBank.id]);

    const oracleAll = await drizzleDb.select().from(questionBanks)
      .orderBy(asc(questionBanks.createdAt), asc(questionBanks.id));
    const mine = await repo.listBanks();
    // Bỏ bank id tường minh vừa thêm ở ca trên khỏi phép so tập đầy đủ.
    expect(mine.filter((b) => b.id !== EXPLICIT_BANK_ID)).toEqual(
      oracleAll.filter((b) => b.id !== EXPLICIT_BANK_ID),
    );
  });

  it('listCategoriesOfBank chỉ gồm category của bank, sắp xếp theo thời gian tạo rồi id như bản cũ', async () => {
    const oracle = (await drizzleDb.select().from(questionCategories)
      .where(eq(questionCategories.bankId, seed.schoolBank.id)))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const mine = await repo.listCategoriesOfBank(seed.schoolBank.id);
    expect(mine.map((c) => c.id)).toEqual([seed.catA, seed.catA2, seed.catB]);
    expect(mine).toEqual(oracle);
  });

  it('listQuestionsWithEntryInCategories trả hình dạng lồng { q, entry } khớp oracle Drizzle', async () => {
    const oracle = await drizzleDb.select({ q: question, entry: questionBankEntries }).from(question)
      .innerJoin(questionBankEntries, eq(questionBankEntries.questionId, question.id))
      .where(eq(question.category, seed.catA));
    const mine = await repo.listQuestionsWithEntryInCategories([seed.catA]);
    expect(mine.map((r) => r.q.id)).toEqual([seed.q1, seed.q2]);
    expect(mine).toEqual(oracle);
    expect(await repo.listQuestionsWithEntryInCategories([])).toEqual([]);
  });

  it('tín hiệu sử dụng: đếm slot, đề chứa câu và pin dùng câu (distinct) khớp oracle', async () => {
    const counts = await repo.countSlotsByQuestionIds([seed.q1, seed.q2, seed.q3]);
    expect(counts.get(seed.q1)).toBe(2);
    expect(counts.get(seed.q2)).toBe(1);
    expect(counts.has(seed.q3)).toBe(false);
    expect(await repo.countSlotsByQuestionIds([])).toEqual(new Map());

    const containing = await repo.listContainingExams(seed.q1);
    expect(containing).toEqual([
      { examId: expect.any(String), examVersionId: seed.v1, version: 1, name: 'Đề mẫu 1' },
      { examId: expect.any(String), examVersionId: seed.v2, version: 2, name: 'Đề mẫu 2' },
    ]);

    const pins = await repo.listPinIdsUsingQuestion(seed.q1);
    expect([...pins].sort()).toEqual([seed.pin1, seed.pin2, seed.pin3].sort());

    expect(await repo.countAttemptsOfQuestion(seed.q1)).toBe(2);
    expect(await repo.countAttemptsOfQuestion(seed.q2)).toBe(0);
  });

  it('tên hiển thị có đường lui về username và danh sách theo archetype khử trùng như bản cũ', async () => {
    const names = await repo.getUserDisplayNames([seed.u1, seed.u2, seed.u1]);
    expect(names.get(seed.u1)).toBe('Giang Pham');
    expect(names.get(seed.u2)).toBe('hs1');
    expect(await repo.getUserDisplayNames([])).toEqual(new Map());

    expect(await repo.listUserIdsWithArchetypes(['editingteacher'])).toEqual([seed.u1]);
    expect(await repo.listUserIdsWithArchetypes(['student'])).toEqual([seed.u2]);
  });

  it('listOutcomeIdsForNode gom YCCĐ của node và mọi node con cháu — cùng tập với thân SQL cũ qua Drizzle', async () => {
    const oracleFor = async (nodeId: string): Promise<string[]> => {
      const result = await drizzleDb.execute(drizzleSql`
        WITH RECURSIVE tree AS (
          SELECT id FROM curriculum_nodes WHERE id = ${nodeId}
          UNION ALL
          SELECT n.id FROM curriculum_nodes n JOIN tree t ON n.parent_id = t.id
        )
        SELECT id FROM learning_outcomes WHERE node_id IN (SELECT id FROM tree)
      `);
      return (result as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
    };
    expect([...(await repo.listOutcomeIdsForNode(seed.nodeRoot))].sort())
      .toEqual([seed.oRoot, seed.oChild, seed.oGrand].sort());
    expect([...(await repo.listOutcomeIdsForNode(seed.nodeChild))].sort())
      .toEqual([seed.oChild, seed.oGrand].sort());
    expect([...(await repo.listOutcomeIdsForNode(seed.nodeRoot))].sort())
      .toEqual([...(await oracleFor(seed.nodeRoot))].sort());
    expect(await repo.outcomeIdsOfNode(seed.nodeChild)).toEqual([seed.oChild]);
  });

  it('đóng góp: chèn nhận mặc định của database, lọc động theo trạng thái/người đề xuất khớp oracle', async () => {
    const c1 = await repo.getContribution(seed.c1);
    expect(c1?.status).toBe('pending');
    expect(c1?.proposerId).toBe(seed.u2);

    const oracle = await drizzleDb.select().from(questionBankContributions)
      .where(eq(questionBankContributions.targetBankId, seed.schoolBank.id))
      .orderBy(asc(questionBankContributions.createdAt), asc(questionBankContributions.id));
    expect(await repo.listContributions({ targetBankId: seed.schoolBank.id })).toEqual(oracle);
    expect((await repo.listContributions({ targetBankId: seed.schoolBank.id, proposerId: seed.u1 })).map((c) => c.id))
      .toEqual([seed.c2]);
    expect(await repo.listContributions({ targetBankId: seed.schoolBank.id, status: 'approved' })).toEqual([]);
  });

  it('updateContribution chỉ đổi trường được truyền, trường còn lại giữ nguyên và updated_at làm mới', async () => {
    const before = await repo.getContribution(seed.c2);
    await repo.updateContribution(seed.c2, { status: 'approved', reviewerId: seed.u1 });
    const after = await repo.getContribution(seed.c2);
    expect(after?.status).toBe('approved');
    expect(after?.reviewerId).toBe(seed.u1);
    expect(after?.note).toBe(before?.note);
    expect(after?.contentHash).toBe(before?.contentHash);
    expect(after?.proposerId).toBe(before?.proposerId);
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  it('updateEntry đổi trạng thái rút câu; deleteQuestionRow xoá câu và entry bị cascade dọn theo', async () => {
    const withdrawnAt = new Date('2026-02-01T00:00:00Z');
    await repo.updateEntry(seed.e3, {
      status: 'withdrawn', withdrawnReason: 'Câu trùng', withdrawnBy: seed.u1, withdrawnAt,
    });
    const rows = await repo.listQuestionsWithEntryInCategories([seed.catB]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entry.status).toBe('withdrawn');
    expect(rows[0]?.entry.withdrawnReason).toBe('Câu trùng');
    expect(rows[0]?.entry.withdrawnAt).toEqual(withdrawnAt);

    await repo.deleteQuestionRow(seed.q2);
    expect(await repo.listQuestionsWithEntryInCategories([seed.catA])).toHaveLength(1);
    const left = await drizzleDb.select().from(questionBankEntries)
      .where(eq(questionBankEntries.questionId, seed.q2));
    expect(left).toEqual([]);
  });

  it('transaction của repository rollback sạch dòng bank khi hàm truyền vào ném lỗi', async () => {
    await expect(repo.transaction(async (tx) => {
      await repo.insertBank({
        id: TX_BANK_ID, name: 'Bank rollback', scope: 'platform', tenantId: null,
        ownerId: null, scopeRefId: null, contextId: CONTEXT_ID, createdBy: seed.u1,
      }, tx);
      throw new Error('huỷ giao dịch mẫu');
    })).rejects.toThrow('huỷ giao dịch mẫu');
    expect(await repo.getBank(TX_BANK_ID)).toBeUndefined();
  });
});
