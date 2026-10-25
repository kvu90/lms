import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, http, systemContextId, uniqueName } from './identity-access-helpers';
import { ProgramImportService } from '../src/modules/curriculum/program-import.service';
import {
  loadProgramDataset, programAncestorNodeId, programCurriculumId, programDatasetByKey, programLessonNodeId,
  programOutcomeId, programRecordOutcomeEntries, programSubjectId, type ProgramDatasetFile, type ProgramRecord,
} from '../src/modules/curriculum/program-datasets';

/**
 * GDPT-SEED (issue #161) — kiểm chứng bắt buộc của phương án D (hồ sơ
 * gdpt-reference-data-loading-research-2026-10-25.md, mục 6) trên
 * dataset GDCD (116 bản ghi, đủ section/topic/YCCĐ):
 *
 * 1. Mọi id do dataset sinh ra khớp công thức UUIDv5 theo khoá tự
 *    nhiên (môn, chương trình, node tổ tiên, node nội dung, YCCĐ).
 * 2. Nạp lại nguyên bản là no-op (created=0, updated=0).
 * 3. Xoá trắng rồi nạp lại → tập id khớp 100% (tính xác định: nền của
 *    khẳng định "hai DB độc lập cho cùng tập id").
 * 4. Nạp lại với dataset đính chính 3 kiểu (sửa tựa qua topic, sửa chữ
 *    một YCCĐ, đổi khối một bản ghi) SAU KHI đã có ánh xạ sách (cả hai
 *    loại đích), gắn câu hỏi–YCCĐ, ô ma trận và một YCCĐ 'derived':
 *    node giữ id (kể cả khi đổi khối), YCCĐ sửa chữ thành orphaned mà
 *    dòng cũ còn nguyên, mọi tham chiếu nguyên vẹn từng dòng, derived
 *    không bị đụng.
 * 5. FK restrict chặn xoá thật: bề mặt quản trị trả 409 nghiệp vụ
 *    `curriculum.delete_referenced`, SQL xoá thô bị Postgres chặn;
 *    gỡ tham chiếu xong thì xoá được (cổng không phải cấm tuyệt đối).
 */

const DATASET_KEY = 'gdcd';
const SLUG = 'giao-duc-cong-dan';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('GDPT-SEED deterministic program identity (phương án D)', () => {
  let app: INestApplication;
  let admin: string;
  let systemCtxId: string;
  let pg: Client;
  let svc: ProgramImportService;
  let file: ProgramDatasetFile;

  // Ba bản ghi mục tiêu của lượt đính chính + các id/tham chiếu dựng quanh chúng.
  let recA: ProgramRecord; // sửa tựa (qua topic)
  let recB: ProgramRecord; // sửa chữ YCCĐ đầu tiên
  let recC: ProgramRecord; // đổi khối (+1)
  let lessonA = '';
  let lessonB = '';
  let lessonC = '';
  let outcomeA1 = ''; // YCCĐ ổn định của A — đích ánh xạ sách theo outcome + gốc của derived
  let outcomeB1 = ''; // YCCĐ bị sửa chữ của B — đích gắn câu hỏi
  let outcomeC1 = ''; // YCCĐ của C — đích ô ma trận
  let derivedId = '';
  let bookNodeId = '';

  async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await pg.query(text, params);
    return res.rows as T[];
  }

  /** Xoá sạch môn GDCD (cây + sổ) để mỗi lượt chạy spec bắt đầu từ DB trắng cho môn này. */
  async function wipeSubject(): Promise<void> {
    await pg.query(`delete from curriculum_program_records where dataset_key = $1`, [DATASET_KEY]);
    await pg.query(`delete from subjects where slug = $1`, [SLUG]);
  }

  /** Tập id node + YCCĐ của môn, đã sắp xếp — đơn vị đối chiếu tính xác định. */
  async function snapshotIds(): Promise<{ nodes: string[]; outcomes: string[] }> {
    const nodes = await sql<{ id: string }>(
      `select n.id from curriculum_nodes n
       join curricula c on c.id = n.curriculum_id join subjects s on s.id = c.subject_id
       where s.slug = $1 order by n.id`, [SLUG]);
    const outcomes = await sql<{ id: string }>(
      `select o.id from learning_outcomes o
       join curriculum_nodes n on n.id = o.node_id
       join curricula c on c.id = n.curriculum_id join subjects s on s.id = c.subject_id
       where s.slug = $1 order by o.id`, [SLUG]);
    return { nodes: nodes.map((r) => r.id), outcomes: outcomes.map((r) => r.id) };
  }

  async function lessonIdOf(recordId: string): Promise<string> {
    const rows = await sql<{ node_id: string }>(
      `select node_id from curriculum_program_records where dataset_key = $1 and record_id = $2`, [DATASET_KEY, recordId]);
    expect(rows.length, `ledger row for ${recordId}`).toBe(1);
    return rows[0]!.node_id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    systemCtxId = await systemContextId(app, admin);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    svc = app.get(ProgramImportService, { strict: false });
    file = loadProgramDataset(programDatasetByKey(DATASET_KEY)!);
    expect(file.records.length).toBe(116);
    const withOutcomes = file.records.filter((r) => (r.outcomes?.length ?? 0) >= 1);
    recA = withOutcomes.find((r) => (r.outcomes?.length ?? 0) >= 2 && r.topic)!;
    recB = withOutcomes.find((r) => r.id !== recA.id && r.grade === recA.grade)!;
    const grades = new Set(file.records.map((r) => r.grade));
    recC = withOutcomes.find((r) => r.id !== recA.id && r.id !== recB.id && r.grade !== null && grades.has(r.grade + 1))!;
    expect(recA && recB && recC).toBeTruthy();
    await wipeSubject();
  }, 120_000);
  afterAll(async () => {
    // Dọn sạch dấu vết trong DB test dùng chung (sách + câu hỏi + ma
    // trận + môn GDCD dựng cho kiểm chứng) để các spec khác không bị
    // nhiễu bởi dữ liệu của spec này; thứ tự xoá tôn trọng FK restrict:
    // gỡ các bề mặt tham chiếu trước, môn xoá sau cùng (cascade cây).
    try {
      await pg.query(`delete from books where title like 'Sach kiem chung GDPT-SEED%'`);
      await pg.query(`delete from question where name = 'Câu kiểm chứng GDPT-SEED'`);
      await pg.query(`delete from exam_matrices where name = 'Ma trận kiểm chứng GDPT-SEED'`);
      await pg.query(`delete from question_categories where name like 'cat-gdpt-seed%'`);
      await wipeSubject();
    } catch { /* dọn dẹp thất bại không được làm đỏ suite */ }
    await pg.end();
    await app.close();
  });

  it('imports GDCD with deterministic UUIDv5 ids matching the natural-key formulas', async () => {
    const res = await svc.importDatasetInternal(DATASET_KEY);
    expect(res.totalRecords).toBe(116);
    expect(res.created).toBe(116);
    expect(res.updated).toBe(0);
    expect(res.orphanedNodes).toBe(0);
    expect(res.orphanedOutcomes).toBe(0);

    const subjects = await sql<{ id: string }>(`select id from subjects where slug = $1`, [SLUG]);
    expect(subjects[0]!.id).toBe(programSubjectId(SLUG));
    expect(res.subjectId).toBe(programSubjectId(SLUG));

    const grade = recA.grade!;
    const curricula = await sql<{ id: string }>(
      `select id from curricula where subject_id = $1 and grade = $2`, [subjects[0]!.id, grade]);
    expect(curricula[0]!.id).toBe(programCurriculumId(SLUG, grade));

    lessonA = await lessonIdOf(recA.id);
    expect(lessonA).toBe(programLessonNodeId(DATASET_KEY, recA.id));

    // Node tổ tiên: section là bậc đầu ('strand'), topic là bậc hai ('topic').
    const ancestors = await sql<{ id: string; kind: string; title: string }>(
      `with recursive chain as (
         select id, parent_id, kind, title, 1 as depth from curriculum_nodes where id =
           (select parent_id from curriculum_nodes where id = $1)
         union all
         select n.id, n.parent_id, n.kind, n.title, chain.depth + 1 from curriculum_nodes n
         join chain on chain.parent_id = n.id
       ) select id, kind, title from chain order by depth desc`, [lessonA]);
    expect(ancestors.map((a) => [a.kind, a.title])).toEqual([
      ['strand', recA.section], ['topic', recA.topic],
    ]);
    expect(ancestors[0]!.id).toBe(programAncestorNodeId(SLUG, grade, [['strand', recA.section!]]));
    expect(ancestors[1]!.id).toBe(programAncestorNodeId(SLUG, grade, [['strand', recA.section!], ['topic', recA.topic!]]));

    // YCCĐ: id neo sha256 nội dung theo đúng thứ tự dataset.
    const expected = programRecordOutcomeEntries(DATASET_KEY, recA);
    const outcomes = await sql<{ id: string; content: string; position: number }>(
      `select id, content, position from learning_outcomes where node_id = $1 order by position`, [lessonA]);
    expect(outcomes.map((o) => o.id)).toEqual(expected.map((e) => e.id));
    expect(outcomes.map((o) => o.content)).toEqual(expected.map((e) => e.text));
    outcomeA1 = expected[0]!.id;
    expect(outcomeA1).toBe(programOutcomeId(DATASET_KEY, recA.id, recA.outcomes![0]!));
  }, 180_000);

  it('re-importing the untouched dataset is a no-op', async () => {
    const res = await svc.importDatasetInternal(DATASET_KEY);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(116);
    expect(res.orphanedNodes).toBe(0);
    expect(res.orphanedOutcomes).toBe(0);
  }, 180_000);

  it('wipe + re-import reproduces the identical id set', async () => {
    const before = await snapshotIds();
    expect(before.nodes.length).toBeGreaterThan(116);
    await wipeSubject();
    const res = await svc.importDatasetInternal(DATASET_KEY);
    expect(res.created).toBe(116);
    const after = await snapshotIds();
    expect(after.nodes).toEqual(before.nodes);
    expect(after.outcomes).toEqual(before.outcomes);
    lessonA = await lessonIdOf(recA.id);
    lessonB = await lessonIdOf(recB.id);
    lessonC = await lessonIdOf(recC.id);
    const bOutcomes = await sql<{ id: string }>(
      `select id from learning_outcomes where node_id = $1 order by position limit 1`, [lessonB]);
    outcomeB1 = bOutcomes[0]!.id;
    const cOutcomes = await sql<{ id: string }>(
      `select id from learning_outcomes where node_id = $1 order by position limit 1`, [lessonC]);
    outcomeC1 = cOutcomes[0]!.id;
    const aOutcomes = await sql<{ id: string }>(
      `select id from learning_outcomes where node_id = $1 order by position limit 1`, [lessonA]);
    outcomeA1 = aOutcomes[0]!.id;
  }, 180_000);

  it('corrected re-import keeps every reference: node ids stable across title/text/grade corrections', async () => {
    // --- dựng tham chiếu quanh cây vừa nạp -------------------------------
    // YCCĐ derived của tổ chuyên môn trên node A (suy ra từ outcomeA1).
    const derivedRes = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin))
      .send({ nodeId: lessonA, content: 'YCCĐ suy ra phục vụ kiểm chứng GDPT-SEED.', sourceKind: 'derived', derivedFromId: outcomeA1 });
    expect(derivedRes.status).toBe(201);
    derivedId = (derivedRes.body as { id: string }).id;

    // Sách + bài + hai ánh xạ (đích node và đích YCCĐ) bằng SQL tối thiểu.
    const book = await sql<{ id: string }>(
      `insert into books (title, subject_id, grade) values ($1, $2, $3) returning id`,
      [uniqueName('Sach kiem chung GDPT-SEED'), programSubjectId(SLUG), recA.grade]);
    const bookNode = await sql<{ id: string }>(
      `insert into book_nodes (book_id, title, kind) values ($1, 'Bài kiểm chứng', 'lesson') returning id`, [book[0]!.id]);
    bookNodeId = bookNode[0]!.id;
    await pg.query(
      `insert into book_mappings (book_node_id, curriculum_node_id, position) values ($1, $2, 1)`, [bookNodeId, lessonA]);
    await pg.query(
      `insert into book_mappings (book_node_id, learning_outcome_id, position) values ($1, $2, 2)`, [bookNodeId, outcomeA1]);

    // Gắn câu hỏi vào outcomeB1 (YCCĐ sắp bị sửa chữ) bằng SQL tối thiểu.
    const category = await sql<{ id: string }>(
      `insert into question_categories (name, context_id) values ($1, $2) returning id`, [uniqueName('cat-gdpt-seed'), systemCtxId]);
    const question = await sql<{ id: string }>(
      `insert into question (category, qtype, name) values ($1, 'multichoice', 'Câu kiểm chứng GDPT-SEED') returning id`, [category[0]!.id]);
    await pg.query(
      `insert into question_learning_outcomes (question_id, learning_outcome_id, cognitive_level) values ($1, $2, 'biet')`,
      [question[0]!.id, outcomeB1]);

    // Ô ma trận trỏ outcomeC1 (bản ghi sắp đổi khối).
    const matrix = await sql<{ id: string }>(
      `insert into exam_matrices (name, subject_id, curriculum_id, context_id)
       values ('Ma trận kiểm chứng GDPT-SEED', $1,
               (select curriculum_id from curriculum_program_records where dataset_key = $2 and record_id = $3), $4)
       returning id`,
      [programSubjectId(SLUG), DATASET_KEY, recC.id, systemCtxId]);
    await pg.query(
      `insert into exam_matrix_cells (matrix_id, learning_outcome_id, cognitive_level, qtype, question_count, cell_score)
       values ($1, $2, 'hieu', 'multichoice', 1, 1)`, [matrix[0]!.id, outcomeC1]);

    const refsBefore = await referenceSnapshot();
    const outcomeTotalBefore = (await snapshotIds()).outcomes.length;

    // --- dataset đính chính 3 kiểu ---------------------------------------
    const mutated = structuredClone(file) as ProgramDatasetFile;
    const mA = mutated.records.find((r) => r.id === recA.id)!;
    mA.topic = `${recA.topic} (đính chính)`;
    const mB = mutated.records.find((r) => r.id === recB.id)!;
    const newTextB = `${recB.outcomes![0]} [bản đính chính]`;
    mB.outcomes = [newTextB, ...recB.outcomes!.slice(1)];
    const mC = mutated.records.find((r) => r.id === recC.id)!;
    mC.grade = recC.grade! + 1;

    const res = await svc.importDatasetFileInternal(DATASET_KEY, mutated);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(3);
    expect(res.orphanedNodes).toBe(0);
    expect(res.orphanedOutcomes).toBe(1);

    // (a) Sửa tựa: node giữ id, tựa mới theo topic đã đính chính.
    const nodeA = await sql<{ id: string; title: string }>(`select id, title from curriculum_nodes where id = $1`, [lessonA]);
    expect(nodeA.length).toBe(1);
    expect(nodeA[0]!.title).toBe(mA.topic);

    // (b) Sửa chữ YCCĐ: dòng cũ thành orphaned (còn nguyên), dòng mới có id xác định theo nội dung mới.
    const bRows = await sql<{ id: string; content: string; source_kind: string }>(
      `select id, content, source_kind from learning_outcomes where node_id = $1`, [lessonB]);
    const orphan = bRows.find((r) => r.id === outcomeB1);
    expect(orphan, 'old outcome row must survive as orphaned').toBeTruthy();
    expect(orphan!.content).toBe(recB.outcomes![0]);
    const fresh = bRows.find((r) => r.content === newTextB);
    expect(fresh, 'corrected outcome must exist').toBeTruthy();
    expect(fresh!.id).toBe(programOutcomeId(DATASET_KEY, recB.id, newTextB));
    // Tổng YCCĐ của môn chỉ tăng đúng 1 (dòng mới của B); không dòng nào bị xoá.
    expect((await snapshotIds()).outcomes.length).toBe(outcomeTotalBefore + 1);

    // (c) Đổi khối: node giữ id, chuyển curriculum_id sang chương trình của khối mới.
    const nodeC = await sql<{ id: string; curriculum_id: string }>(
      `select id, curriculum_id from curriculum_nodes where id = $1`, [lessonC]);
    expect(nodeC.length).toBe(1);
    expect(nodeC[0]!.curriculum_id).toBe(programCurriculumId(SLUG, recC.grade! + 1));
    const ledgerC = await sql<{ curriculum_id: string }>(
      `select curriculum_id from curriculum_program_records where dataset_key = $1 and record_id = $2`, [DATASET_KEY, recC.id]);
    expect(ledgerC[0]!.curriculum_id).toBe(programCurriculumId(SLUG, recC.grade! + 1));

    // Mọi tham chiếu nguyên vẹn từng dòng; derived còn nguyên trên node A.
    const refsAfter = await referenceSnapshot();
    expect(refsAfter).toEqual(refsBefore);
    const derived = await sql<{ id: string; node_id: string; source_kind: string }>(
      `select id, node_id, source_kind from learning_outcomes where id = $1`, [derivedId]);
    expect(derived.length).toBe(1);
    expect(derived[0]!.node_id).toBe(lessonA);
    expect(derived[0]!.source_kind).toBe('derived');
  }, 180_000);

  it('restrict blocks deletion with a business error until references are removed', async () => {
    // Xoá YCCĐ còn ánh xạ sách trỏ vào → 409 nghiệp vụ, không phải lỗi FK thô.
    const delOutcome = await http(app).delete(`/api/v1/curriculum/outcomes/${outcomeA1}`).set(bearer(admin));
    expect(delOutcome.status).toBe(409);
    expect(delOutcome.body.code).toBe('curriculum.delete_referenced');
    // Xoá node còn ánh xạ + derived trong subtree → 409 nghiệp vụ.
    const delNode = await http(app).delete(`/api/v1/curriculum/nodes/${lessonA}`).set(bearer(admin));
    expect(delNode.status).toBe(409);
    expect(delNode.body.code).toBe('curriculum.delete_referenced');
    // SQL xoá thô cũng bị FK restrict chặn ở tầng DB.
    let pgCode = '';
    try {
      await pg.query(`delete from learning_outcomes where id = $1`, [outcomeA1]);
    } catch (err) {
      pgCode = (err as { code?: string }).code ?? '';
    }
    expect(['23001', '23503']).toContain(pgCode);
    const stillThere = await sql<{ id: string }>(`select id from learning_outcomes where id = $1`, [outcomeA1]);
    expect(stillThere.length).toBe(1);

    // Gỡ tham chiếu của outcomeB1 (liên kết câu hỏi) → xoá qua API được.
    await pg.query(`delete from question_learning_outcomes where learning_outcome_id = $1`, [outcomeB1]);
    const delOrphan = await http(app).delete(`/api/v1/curriculum/outcomes/${outcomeB1}`).set(bearer(admin));
    expect(delOrphan.status).toBeLessThan(300);
    const gone = await sql<{ id: string }>(`select id from learning_outcomes where id = $1`, [outcomeB1]);
    expect(gone.length).toBe(0);
  }, 120_000);

  /** Ảnh chụp các dòng tham chiếu dựng trong spec (so nguyên vẹn trước/sau đính chính). */
  async function referenceSnapshot(): Promise<unknown> {
    const mappings = await sql(
      `select id, book_node_id, curriculum_node_id, learning_outcome_id from book_mappings where book_node_id = $1 order by position`, [bookNodeId]);
    const links = await sql(
      `select id, question_id, learning_outcome_id from question_learning_outcomes where learning_outcome_id = $1`, [outcomeB1]);
    const cells = await sql(
      `select id, matrix_id, learning_outcome_id from exam_matrix_cells where learning_outcome_id = $1`, [outcomeC1]);
    return { mappings, links, cells };
  }
});
