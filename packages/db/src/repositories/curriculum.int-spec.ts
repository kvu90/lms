import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { CurriculumRepository, type LearningOutcomeRow } from './curriculum';

/**
 * Spec tích hợp của CurriculumRepository phía Kysely (issue #646,
 * nhóm G6). Database kho trung tâm được dựng từ rỗng bằng cầu nối
 * migration của package trên cụm PostgreSQL thật của môi trường
 * test; mọi ca chạy qua repository production — không mô phỏng
 * handle.
 *
 * Spec này là nơi CHỐT THỬ NGHIỆM T-14 (chiếu toàn bảng trong
 * select) cho điểm đo duy nhất của repo: `searchOutcomes` của bản
 * Drizzle cũ chiếu `select({ outcome: learningOutcomes, … })` —
 * Kysely không có chiếu-gộp-cả-bảng nên bản mới liệt kê tường minh
 * MỌI cột của bảng YCCĐ dưới tiền tố `outcome…` rồi lồng lại thành
 * object `outcome` trong mã; ca T-14 dưới đây khoá hình dạng kết
 * quả bằng deep-equal với chính dòng đọc thẳng từ repository.
 * (Ca T-13 — hợp điều kiện động — được khoá qua
 * `countGuardedReferences` và lọc `listOutcomes`.)
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g646_curriculum';
const CONTEXT_ID = '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a1001';

let pool: Pool;
let db: CentreDb;
let repo: CurriculumRepository;

beforeAll(async () => {
  if (!adminUrl) throw new Error('Thiếu LMS_DB_TEST_ADMIN_URL/DATABASE_URL cho spec tích hợp');
  const url = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: url });
  db = createCentreKysely(pool);
  repo = new CurriculumRepository(db);
}, 300_000);

afterAll(async () => {
  await db.destroy().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB).catch(() => undefined);
});

/** Dựng một cây tối thiểu môn → chương trình → node → YCCĐ và trả các dòng đã tạo. */
async function seedTree(slug: string) {
  const subject = await repo.insertSubject({ contextId: CONTEXT_ID, name: `Môn ${slug}`, slug });
  const curriculum = await repo.insertCurriculum({ subjectId: subject.id, grade: 3 });
  const node = await repo.insertNode({
    curriculumId: curriculum.id, parentId: null, position: 1, title: `Chương ${slug}`,
  });
  const outcome = await repo.insertOutcome({
    nodeId: node.id,
    position: 1,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Mô tả ${slug}` }] }] },
  });
  return { subject, curriculum, node, outcome };
}

describe('CurriculumRepository (Kysely)', () => {
  it('chèn môn học rồi đọc lại theo context với đúng hình dạng dòng công khai', async () => {
    const { subject } = await seedTree('toan-g6');
    const listed = await repo.listSubjects(CONTEXT_ID);
    const found = listed.find((s) => s.id === subject.id);
    expect(found).toEqual(subject);
    expect(found?.position).toBeGreaterThanOrEqual(0);
  });

  it('ném lỗi pg thô mang code 23505 khi trùng slug môn học (không bọc cause)', async () => {
    await seedTree('trung-slug');
    const attempt = repo.insertSubject({ contextId: CONTEXT_ID, name: 'Môn trùng', slug: 'trung-slug' });
    await expect(attempt).rejects.toMatchObject({ code: '23505' });
  });

  it('đọc lại YCCĐ với nội dung jsonb nguyên vẹn sau khi ghi qua serialize + ép kiểu ::jsonb', async () => {
    const { outcome } = await seedTree('jsonb-content');
    const read = await repo.getOutcome(outcome.id);
    expect(read).toEqual(outcome);
    expect(read?.content).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mô tả jsonb-content' }] }],
    });
  });

  it('T-14: searchOutcomes trả outcome là object lồng chứa ĐẦY ĐỦ mọi cột của dòng YCCĐ', async () => {
    const { subject, node, outcome } = await seedTree('t14-search');
    const results = await repo.searchOutcomes({ query: 't14-search', limit: 10 });
    expect(results).toHaveLength(1);
    const [hit] = results;
    // Deep-equal với chính dòng repository đọc thẳng: mọi cột của
    // bảng YCCĐ phải có mặt dưới khoá `outcome`, không thừa không thiếu.
    expect(hit!.outcome).toEqual(outcome);
    expect(Object.keys(hit!.outcome).sort()).toEqual(Object.keys(outcome as LearningOutcomeRow).sort());
    expect(hit!.nodeTitle).toBe(node.title);
    expect(hit!.grade).toBe(3);
    expect(hit!.subjectId).toBe(subject.id);
    expect(hit!.subjectName).toBe(subject.name);
    expect(hit!.subjectContextId).toBe(CONTEXT_ID);
  });

  it('searchOutcomes lọc cứng theo môn và khối khi caller truyền, và bỏ qua YCCĐ đã rút', async () => {
    const a = await seedTree('loc-a');
    await seedTree('loc-b');
    const bySubject = await repo.searchOutcomes({ query: 'loc-', subjectId: a.subject.id, limit: 10 });
    expect(bySubject.map((r) => r.subjectId)).toEqual([a.subject.id]);
    const byGrade = await repo.searchOutcomes({ query: 'loc-', grade: 4, limit: 10 });
    expect(byGrade).toHaveLength(0);
    await repo.updateOutcome(a.outcome.id, { retiredAt: new Date() });
    const afterRetire = await repo.searchOutcomes({ query: 'loc-a', limit: 10 });
    expect(afterRetire).toHaveLength(0);
  });

  it('listOutcomes bỏ qua dòng đã rút theo mặc định và gồm cả chúng khi includeRetired bật', async () => {
    const { node, outcome } = await seedTree('retired-list');
    await repo.updateOutcome(outcome.id, { retiredAt: new Date() });
    const active = await repo.listOutcomes(node.id);
    expect(active.map((o) => o.id)).not.toContain(outcome.id);
    const all = await repo.listOutcomes(node.id, { includeRetired: true });
    expect(all.map((o) => o.id)).toContain(outcome.id);
    expect(all.find((o) => o.id === outcome.id)?.retiredAt).toBeInstanceOf(Date);
  });

  it('T-13: countGuardedReferences trả 0 cho cả ba đếm khi cả hai tập đều rỗng mà không lỗi', async () => {
    const counts = await repo.countGuardedReferences([], []);
    expect(counts).toEqual({ bookMappings: 0, examMatrixCells: 0, questionOutcomes: 0 });
  });

  it('T-13: countGuardedReferences đếm đúng từng bề mặt khi chỉ một phía có dữ kiện', async () => {
    const { subject, curriculum, node, outcome } = await seedTree('guard-count');
    // Ánh xạ sách trỏ vào YCCĐ (phía outcomeIds).
    const [book] = await db.insertInto('books').values({ title: 'Sách G6' }).returning(['id']).execute();
    const [bookNode] = await db.insertInto('book_nodes')
      .values({ book_id: book!.id, title: 'Bài G6' }).returning(['id']).execute();
    await db.insertInto('book_mappings')
      .values({ book_node_id: bookNode!.id, learning_outcome_id: outcome.id, position: 1 }).execute();
    // Ô ma trận neo node (phía nodeIds).
    const [matrix] = await db.insertInto('exam_matrices').values({
      name: 'Ma trận G6', subject_id: subject.id, curriculum_id: curriculum.id, context_id: CONTEXT_ID,
    }).returning(['id']).execute();
    const [version] = await db.insertInto('exam_matrix_versions').values({
      matrix_id: matrix!.id, version: 1, created_by: '01934f2a-7b6d-7c1e-9c4a-2f5d8e6a1099',
    }).returning(['id']).execute();
    await db.insertInto('exam_matrix_cells').values({
      matrix_id: matrix!.id, matrix_version_id: version!.id, curriculum_node_id: node.id,
      cognitive_level: 'biet', qtype: 'multichoice', question_count: 1, cell_score: 1,
    }).execute();
    // Liên kết câu hỏi ↔ YCCĐ (phía outcomeIds của đếm questionOutcomes).
    const [category] = await db.insertInto('question_categories').values({
      name: 'Danh mục G6', context_id: CONTEXT_ID,
    }).returning(['id']).execute();
    const [question] = await db.insertInto('question').values({
      category: category!.id, qtype: 'multichoice',
    }).returning(['id']).execute();
    await db.insertInto('question_learning_outcomes').values({
      question_id: question!.id, learning_outcome_id: outcome.id, cognitive_level: 'biet',
    }).execute();

    const both = await repo.countGuardedReferences([node.id], [outcome.id]);
    expect(both).toEqual({ bookMappings: 1, examMatrixCells: 1, questionOutcomes: 1 });
    const nodesOnly = await repo.countGuardedReferences([node.id], []);
    expect(nodesOnly).toEqual({ bookMappings: 0, examMatrixCells: 1, questionOutcomes: 0 });
    const outcomesOnly = await repo.countGuardedReferences([], [outcome.id]);
    expect(outcomesOnly).toEqual({ bookMappings: 1, examMatrixCells: 0, questionOutcomes: 1 });
  });

  it('countReadyQuestionsForOutcome đếm câu ready theo (mức × dạng) và bỏ qua câu chưa ready', async () => {
    const { outcome } = await seedTree('ready-count');
    const [category] = await db.insertInto('question_categories').values({
      name: 'Danh mục ready', context_id: CONTEXT_ID,
    }).returning(['id']).execute();
    const mkQuestion = async (status: string) => {
      const [q] = await db.insertInto('question').values({
        category: category!.id, qtype: 'multichoice',
      }).returning(['id']).execute();
      await db.insertInto('question_bank_entries').values({
        question_category_id: category!.id, question_id: q!.id, status,
      }).execute();
      await db.insertInto('question_learning_outcomes').values({
        question_id: q!.id, learning_outcome_id: outcome.id, cognitive_level: 'hieu',
      }).execute();
    };
    await mkQuestion('ready');
    await mkQuestion('draft');
    const counts = await repo.countReadyQuestionsForOutcome(outcome.id);
    expect(counts).toEqual([{ cognitiveLevel: 'hieu', qtype: 'multichoice', count: 1 }]);
  });

  it('ghi và đọc sổ chương trình: insertProgramRecord giữ nguyên source jsonb kể cả khi là mảng ở tầng trên cùng', async () => {
    const { subject, curriculum, node, outcome } = await seedTree('program-record');
    const source = [{ file: 'program-toan.json', page: 12 }];
    const record = await repo.insertProgramRecord({
      datasetKey: 'gdpt-2018', recordId: 'TOAN-G6-0001', subjectId: subject.id,
      curriculumId: curriculum.id, nodeId: node.id, contentHash: 'hash-g6', source,
    });
    expect(record.source).toEqual(source);
    const found = await repo.getProgramRecord('gdpt-2018', 'TOAN-G6-0001');
    expect(found?.id).toBe(record.id);
    expect(found?.nodeId).toBe(outcome.nodeId);
  });

  it('giao dịch của repository commit trọn vẹn và rollback khi callback ném lỗi', async () => {
    const attempt = repo.transaction(async (tx) => {
      await repo.insertSubject({ contextId: CONTEXT_ID, name: 'Môn rollback', slug: 'rollback-g6' }, tx);
      throw new Error('cố ý hủy giao dịch');
    });
    await expect(attempt).rejects.toThrow('cố ý hủy giao dịch');
    const listed = await repo.listSubjects(CONTEXT_ID);
    expect(listed.map((s) => s.slug)).not.toContain('rollback-g6');
    const subject = await repo.transaction(async (tx) =>
      repo.insertSubject({ contextId: CONTEXT_ID, name: 'Môn commit', slug: 'commit-g6' }, tx));
    expect(subject.slug).toBe('commit-g6');
  });
});
