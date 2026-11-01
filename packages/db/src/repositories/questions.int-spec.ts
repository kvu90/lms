import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import {
  curricula, curriculumNodes, learningOutcomes, questionLearningOutcomes,
  questionSubjects, type LearningOutcomeDoc,
} from '../curriculum.schema';
import {
  question, questionBankEntries, questionVersions,
} from '../questions.schema';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { QuestionsRepository, type EntryRow } from './questions';

/**
 * Spec tích hợp của repository câu hỏi trên Kysely (issue #642).
 *
 * Database trung tâm dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test (biến
 * `LMS_DB_TEST_ADMIN_URL` ghi đè cụm khi cần, mặc định suy từ
 * `DATABASE_URL`). Mọi ca chạy qua repository production ở
 * `questions.ts` — không mô phỏng handle.
 *
 * Các tính chất chốt tại đây:
 * - Insert không truyền id nhận id UUIDv7 do database sinh
 *   (phụ lục U) và đọc lại nguyên vẹn qua chính repository.
 * - Ghi/đọc jsonb nội dung khớp hai chiều Kysely ↔ Drizzle trên
 *   cùng dữ kiện mẫu, gồm điểm sắc nhất của T-4: cột jsonb
 *   nullable phân biệt `null` (SQL NULL) với giá trị và với
 *   `undefined` (không đổi) ở cả insert lẫn update patch.
 * - Giao dịch của repository nguyên tử: lỗi giữa chừng rollback
 *   sạch mọi bảng đã ghi; `markSystemImportDerived` đổi cờ trong
 *   giao dịch và rollback cùng giao dịch khi giao dịch huỷ.
 * - `countQuestionsByCurriculumFilterPerCategory` trả `number`
 *   thật (ép `::int` — rủi ro R-G2-1: `count(*)` là int8, qua pg
 *   sẽ là `string` nếu không ép).
 * - Bộ lọc chương trình tương đương hành vi với bản Drizzle cũ:
 *   oracle trong spec này là chính các truy vấn Drizzle của
 *   repository cũ chạy trên CÙNG dữ kiện mẫu (gồm YCCĐ đã rút,
 *   YCCĐ phái sinh từ gốc đã rút, và điều kiện khớp cùng dòng nối
 *   outcomeId + cognitiveLevel) — hai phía phải cho cùng tập id.
 */

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g642_questions';
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Ngữ cảnh/actor cố định — các cột `context_id`/`created_by` không có khoá ngoại nên chỉ cần uuid hợp lệ. */
const CONTEXT_ID = '019276a1-1111-7000-8000-0000000000c1';
const ACTOR_ID = '019276a1-1111-7000-8000-0000000000a1';

let pool: Pool;
let db: CentreDb;
let repo: QuestionsRepository;
let drizzleDb: NodePgDatabase;

/** Tài liệu rich-text mẫu cho các cột jsonb nội dung. */
const DOC_A = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nội dung A' }] }] };
const DOC_B = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nội dung B' }] }] };

interface Seed {
  bankId: string;
  catA: string;
  catB: string;
  subjectId: string;
  nodeId: string;
  outcomeActive: string;
  outcomeRetired: string;
  outcomeDerivedActive: string;
  outcomeDerivedRetired: string;
  q1: string;
  q2: string;
  q3: string;
  entry1: EntryRow;
}

let seed: Seed;

/** Gieo đồ thị dữ kiện mẫu qua chính repository (phần câu hỏi) + Kysely thô (phần chương trình/bank). */
async function seedData(): Promise<Seed> {
  const bank = await db
    .insertInto('question_banks')
    .values({ name: 'Bank mẫu', scope: 'platform', context_id: CONTEXT_ID, created_by: ACTOR_ID })
    .returning('id')
    .executeTakeFirstOrThrow();
  const catA = await repo.insertCategory({ name: 'Danh mục A', contextId: CONTEXT_ID, bankId: bank.id, info: '', parent: null, stamp: 'seed-a' });
  const catB = await repo.insertCategory({ name: 'Danh mục B', contextId: CONTEXT_ID, bankId: bank.id, info: '', parent: null, stamp: 'seed-b' });

  const subject = await db.insertInto('subjects')
    .values({ context_id: CONTEXT_ID, name: 'Toán', slug: 'toan-g642' })
    .returning('id').executeTakeFirstOrThrow();
  const curriculum = await db.insertInto('curricula')
    .values({ subject_id: subject.id, grade: 10 })
    .returning('id').executeTakeFirstOrThrow();
  const node = await db.insertInto('curriculum_nodes')
    .values({ curriculum_id: curriculum.id, title: 'Chương 1', kind: 'topic' })
    .returning('id').executeTakeFirstOrThrow();
  const outcomeDoc = sql<LearningOutcomeDoc>`${JSON.stringify({ type: 'doc', content: [] })}::jsonb`;
  const outcomeActive = await db.insertInto('learning_outcomes')
    .values({ node_id: node.id, content: outcomeDoc, source_kind: 'program' })
    .returning('id').executeTakeFirstOrThrow();
  const outcomeRetired = await db.insertInto('learning_outcomes')
    .values({ node_id: node.id, content: outcomeDoc, source_kind: 'program', retired_at: new Date() })
    .returning('id').executeTakeFirstOrThrow();
  const outcomeDerivedActive = await db.insertInto('learning_outcomes')
    .values({ node_id: node.id, content: outcomeDoc, source_kind: 'derived', derived_from_id: outcomeActive.id })
    .returning('id').executeTakeFirstOrThrow();
  const outcomeDerivedRetired = await db.insertInto('learning_outcomes')
    .values({ node_id: node.id, content: outcomeDoc, source_kind: 'derived', derived_from_id: outcomeRetired.id })
    .returning('id').executeTakeFirstOrThrow();

  const mkQuestion = async (categoryId: string, qtype: string, status: string) => {
    const q = await repo.insertQuestion({ category: categoryId, qtype, createdBy: ACTOR_ID, modifiedBy: ACTOR_ID });
    const entry = await repo.insertEntry({ questionCategoryId: categoryId, questionId: q.id, latestVersion: 1, status });
    return { q, entry };
  };
  const one = await mkQuestion(catA.id, 'multichoice', 'ready');
  const two = await mkQuestion(catA.id, 'essay', 'ready');
  const three = await mkQuestion(catB.id, 'multichoice', 'draft');

  await repo.insertQuestionSubjectLink({ questionId: one.q.id, subjectId: subject.id });
  await repo.insertQuestionOutcomeLink({ questionId: one.q.id, learningOutcomeId: outcomeActive.id, cognitiveLevel: 'biet' });
  await repo.insertQuestionOutcomeLink({ questionId: two.q.id, learningOutcomeId: outcomeRetired.id, cognitiveLevel: 'biet' });
  await repo.insertQuestionOutcomeLink({ questionId: three.q.id, learningOutcomeId: outcomeDerivedActive.id, cognitiveLevel: 'hieu' });
  await repo.insertQuestionOutcomeLink({ questionId: three.q.id, learningOutcomeId: outcomeDerivedRetired.id, cognitiveLevel: 'hieu' });

  return {
    bankId: bank.id, catA: catA.id, catB: catB.id,
    subjectId: subject.id, nodeId: node.id,
    outcomeActive: outcomeActive.id, outcomeRetired: outcomeRetired.id,
    outcomeDerivedActive: outcomeDerivedActive.id, outcomeDerivedRetired: outcomeDerivedRetired.id,
    q1: one.q.id, q2: two.q.id, q3: three.q.id, entry1: one.entry,
  };
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec Kysely #642: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  repo = new QuestionsRepository(db);
  drizzleDb = drizzle({ client: pool });
  seed = await seedData();
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

// ---------------------------------------------------------------------------
// Oracle Drizzle: nguyên văn đường phân giải + lọc của repository cũ
// (apps/api trước #642) để đối chiếu tương đương trên cùng dữ kiện.
// ---------------------------------------------------------------------------

type OracleFilter = {
  subjectId?: string; outcomeId?: string; nodeId?: string; cognitiveLevel?: string; qtype?: string; status?: string;
};

async function oracleResolveCandidateIds(filter: OracleFilter): Promise<Set<string> | null> {
  const outcomeRoot = alias(learningOutcomes, 'learning_outcome_root');
  const activeOutcomeConditions = [
    isNull(learningOutcomes.retiredAt),
    or(isNull(learningOutcomes.derivedFromId), isNull(outcomeRoot.retiredAt)),
  ];
  const idSets: Set<string>[] = [];
  if (filter.subjectId !== undefined) {
    const viaSubjects = await drizzleDb.select({ questionId: questionSubjects.questionId })
      .from(questionSubjects).where(eq(questionSubjects.subjectId, filter.subjectId));
    const viaOutcomes = await drizzleDb.select({ questionId: questionLearningOutcomes.questionId })
      .from(questionLearningOutcomes)
      .innerJoin(learningOutcomes, eq(learningOutcomes.id, questionLearningOutcomes.learningOutcomeId))
      .leftJoin(outcomeRoot, eq(outcomeRoot.id, learningOutcomes.derivedFromId))
      .innerJoin(curriculumNodes, eq(curriculumNodes.id, learningOutcomes.nodeId))
      .innerJoin(curricula, eq(curricula.id, curriculumNodes.curriculumId))
      .where(and(eq(curricula.subjectId, filter.subjectId), ...activeOutcomeConditions));
    idSets.push(new Set([...viaSubjects.map((r) => r.questionId), ...viaOutcomes.map((r) => r.questionId)]));
  }
  if (filter.outcomeId !== undefined || filter.nodeId !== undefined || filter.cognitiveLevel !== undefined) {
    const conditions = [];
    if (filter.outcomeId !== undefined) conditions.push(eq(questionLearningOutcomes.learningOutcomeId, filter.outcomeId));
    if (filter.nodeId !== undefined) conditions.push(eq(learningOutcomes.nodeId, filter.nodeId));
    if (filter.cognitiveLevel !== undefined) conditions.push(eq(questionLearningOutcomes.cognitiveLevel, filter.cognitiveLevel));
    const rows = filter.nodeId !== undefined
      ? await drizzleDb.select({ questionId: questionLearningOutcomes.questionId })
        .from(questionLearningOutcomes)
        .innerJoin(learningOutcomes, eq(learningOutcomes.id, questionLearningOutcomes.learningOutcomeId))
        .leftJoin(outcomeRoot, eq(outcomeRoot.id, learningOutcomes.derivedFromId))
        .where(and(...conditions, ...activeOutcomeConditions))
      : await drizzleDb.select({ questionId: questionLearningOutcomes.questionId })
        .from(questionLearningOutcomes).where(and(...conditions));
    idSets.push(new Set(rows.map((r) => r.questionId)));
  }
  let candidateIds: Set<string> | null = null;
  for (const set of idSets) {
    if (candidateIds === null) { candidateIds = set; continue; }
    const current: Set<string> = candidateIds;
    candidateIds = new Set([...current].filter((id) => set.has(id)));
  }
  return candidateIds;
}

async function oracleFilterIds(filter: OracleFilter): Promise<string[]> {
  const candidateIds = await oracleResolveCandidateIds(filter);
  if (candidateIds !== null && candidateIds.size === 0) return [];
  const conditions = [];
  if (candidateIds !== null) conditions.push(inArray(question.id, [...candidateIds]));
  if (filter.qtype !== undefined) conditions.push(eq(question.qtype, filter.qtype));
  if (filter.status !== undefined) conditions.push(eq(questionBankEntries.status, filter.status));
  const rows = await drizzleDb.select({ id: question.id }).from(question)
    .innerJoin(questionBankEntries, eq(questionBankEntries.questionId, question.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return rows.map((r) => r.id).sort();
}

describe('QuestionsRepository trên Kysely (issue #642)', () => {
  it('insert không truyền id nhận id UUIDv7 do database sinh và đọc lại nguyên vẹn', async () => {
    const cat = await repo.insertCategory({ name: 'Danh mục uuidv7', contextId: CONTEXT_ID, bankId: seed.bankId, info: '', parent: null, stamp: 'uuidv7' });
    expect(cat.id).toMatch(UUIDV7_PATTERN);
    const back = await repo.getCategory(cat.id);
    expect(back).toMatchObject({ id: cat.id, name: 'Danh mục uuidv7', bankId: seed.bankId, stamp: 'uuidv7' });
  });

  it('ghi jsonb qua Kysely đọc khớp qua Drizzle và ngược lại, kể cả đáp án và stimulus', async () => {
    const version = await repo.insertVersion({
      questionBankEntryId: seed.entry1.id, questionId: seed.q1, version: 1,
      questionText: DOC_A, generalFeedback: DOC_B, defaultMark: 1, penalty: 0, stimulusId: null,
    });
    // Đọc qua Drizzle (oracle ORM còn lại): nội dung phải khớp từng phần tử.
    const [viaDrizzle] = await drizzleDb.select().from(questionVersions).where(eq(questionVersions.id, version.id));
    expect(viaDrizzle!.questionText).toEqual(DOC_A);
    expect(viaDrizzle!.generalFeedback).toEqual(DOC_B);

    // Ghi qua Drizzle, đọc qua Kysely: cùng một tài liệu phải khớp.
    const [drizzleVersion] = await drizzleDb.insert(questionVersions).values({
      questionBankEntryId: seed.entry1.id, questionId: seed.q1, version: 2,
      questionText: DOC_B as never, generalFeedback: DOC_A as never, defaultMark: 2, penalty: 0, stimulusId: null,
    }).returning();
    const viaRepo = await repo.getVersion(drizzleVersion!.id);
    expect(viaRepo!.questionText).toEqual(DOC_B);
    expect(viaRepo!.generalFeedback).toEqual(DOC_A);

    const stimulus = await repo.insertStimulus({ categoryId: seed.catA, createdBy: ACTOR_ID, content: DOC_A });
    expect((await repo.getStimulus(stimulus.id))!.content).toEqual(DOC_A);
    const answer = await repo.insertAnswer({ questionVersionId: version.id, answer: DOC_B, isCorrect: true, feedback: DOC_A, sortOrder: 0 });
    const answers = await repo.listAnswers(version.id);
    expect(answers.map((a) => a.id)).toEqual([answer.id]);
    expect(answers[0]!.answer).toEqual(DOC_B);
    expect(answers[0]!.feedback).toEqual(DOC_A);
  });

  it('cột jsonb nullable phân biệt null (SQL NULL) với giá trị, và patch undefined không đổi cột (T-4)', async () => {
    const version = await repo.insertVersion({
      questionBankEntryId: seed.entry1.id, questionId: seed.q1, version: 3,
      questionText: DOC_A, generalFeedback: null, defaultMark: 1, penalty: 0, stimulusId: null,
    });
    // null ghi xuống phải là SQL NULL khi đọc qua ORM còn lại — không phải JSON `null` dạng object/chuỗi.
    const [raw] = await drizzleDb.select().from(questionVersions).where(eq(questionVersions.id, version.id));
    expect(raw!.generalFeedback).toBeNull();
    expect((await repo.getVersion(version.id))!.generalFeedback).toBeNull();

    await repo.updateVersion(version.id, { generalFeedback: DOC_B });
    expect((await repo.getVersion(version.id))!.generalFeedback).toEqual(DOC_B);
    // Patch không nhắc tới questionText/generalFeedback thì cả hai giữ nguyên.
    await repo.updateVersion(version.id, { defaultMark: 5 });
    const after = await repo.getVersion(version.id);
    expect(after!.questionText).toEqual(DOC_A);
    expect(after!.generalFeedback).toEqual(DOC_B);
    expect(after!.defaultMark).toBe(5);
    await repo.updateVersion(version.id, { generalFeedback: null });
    expect((await repo.getVersion(version.id))!.generalFeedback).toBeNull();
  });

  it('giao dịch của repository rollback sạch khi callback ném lỗi, commit khi hoàn tất', async () => {
    const marker = `rollback-${Date.now().toString(36)}`;
    await expect(repo.transaction(async (tx) => {
      await repo.insertCategory({ name: marker, contextId: CONTEXT_ID, bankId: seed.bankId, info: '', parent: null, stamp: marker }, tx);
      throw new Error('cố ý huỷ giao dịch');
    })).rejects.toThrow('cố ý huỷ giao dịch');
    const afterRollback = await repo.listCategories(CONTEXT_ID);
    expect(afterRollback.some((c) => c.stamp === marker)).toBe(false);

    const committed = await repo.transaction(async (tx) => repo.insertCategory(
      { name: 'Danh mục commit', contextId: CONTEXT_ID, bankId: seed.bankId, info: '', parent: null, stamp: 'commit-ok' }, tx));
    expect((await repo.getCategory(committed.id))!.stamp).toBe('commit-ok');
  });

  it('markSystemImportDerived đổi pristine thành derived trong giao dịch và rollback cùng giao dịch khi huỷ', async () => {
    const q = await repo.insertQuestion({ category: seed.catA, qtype: 'essay', createdBy: ACTOR_ID, modifiedBy: ACTOR_ID });
    await db.insertInto('system_question_imports').values({
      question_id: q.id, source_question_id: '019276a1-1111-7000-8000-000000000051', source_version_id: '019276a1-1111-7000-8000-000000000052',
      source_version_number: 1, package_checksum: 'sum', imported_version_number: 1, imported_by: ACTOR_ID,
    }).execute();
    await expect(repo.transaction(async (tx) => {
      await repo.markSystemImportDerived(q.id, tx);
      throw new Error('huỷ');
    })).rejects.toThrow('huỷ');
    const stillPristine = await db.selectFrom('system_question_imports').select('kind')
      .where('question_id', '=', q.id).executeTakeFirstOrThrow();
    expect(stillPristine.kind).toBe('pristine');

    await repo.transaction(async (tx) => { await repo.markSystemImportDerived(q.id, tx); });
    const derived = await db.selectFrom('system_question_imports').select('kind')
      .where('question_id', '=', q.id).executeTakeFirstOrThrow();
    expect(derived.kind).toBe('derived');
  });

  it('count theo category trả number thật nhờ ép ::int (R-G2-1) và khớp số câu đã gieo', async () => {
    const rows = await repo.countQuestionsByCurriculumFilterPerCategory({});
    const byCategory = new Map(rows.map((r) => [r.categoryId, r.count]));
    expect(byCategory.get(seed.catA)).toBe(2);
    expect(byCategory.get(seed.catB)).toBe(1);
    for (const row of rows) expect(typeof row.count).toBe('number');
  });

  it('bộ lọc chương trình cho cùng tập id với oracle Drizzle trên mọi tổ hợp điều kiện', async () => {
    const filters: OracleFilter[] = [
      {},
      { qtype: 'multichoice' },
      { qtype: 'essay' },
      { status: 'ready' },
      { status: 'draft' },
      { subjectId: seed.subjectId },
      { subjectId: seed.subjectId, qtype: 'essay' },
      { outcomeId: seed.outcomeRetired },
      { outcomeId: seed.outcomeActive, cognitiveLevel: 'biet' },
      { outcomeId: seed.outcomeActive, cognitiveLevel: 'hieu' },
      { nodeId: seed.nodeId },
      { nodeId: seed.nodeId, cognitiveLevel: 'hieu' },
      { cognitiveLevel: 'hieu' },
      { subjectId: seed.subjectId, nodeId: seed.nodeId },
    ];
    for (const filter of filters) {
      const viaRepo = (await repo.filterQuestionsByCurriculumLinks(filter)).map((q) => q.id).sort();
      const viaOracle = await oracleFilterIds(filter);
      expect(viaRepo, `bộ lọc ${JSON.stringify(filter)}`).toEqual(viaOracle);
    }
    // Chốt cứng ba kỳ vọng nghiệp vụ của dữ kiện mẫu (không chỉ so hai phía với nhau):
    expect((await repo.filterQuestionsByCurriculumLinks({ subjectId: seed.subjectId })).map((q) => q.id).sort())
      .toEqual([seed.q1, seed.q3].sort());
    expect((await repo.filterQuestionsByCurriculumLinks({ nodeId: seed.nodeId })).map((q) => q.id).sort())
      .toEqual([seed.q1, seed.q3].sort());
    expect(await repo.filterQuestionsByCurriculumLinks({ outcomeId: seed.outcomeActive, cognitiveLevel: 'hieu' }))
      .toEqual([]);
  });

  it('getLatestVersionsByEntries nối đúng version theo con trỏ latestVersion của entry', async () => {
    await repo.updateEntry(seed.entry1.id, { latestVersion: 2 });
    const latest = await repo.getLatestVersionsByEntries([{ ...seed.entry1, latestVersion: 2 }]);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ questionBankEntryId: seed.entry1.id, version: 2 });
    expect(latest[0]!.questionText).toEqual(DOC_B);
  });
});
