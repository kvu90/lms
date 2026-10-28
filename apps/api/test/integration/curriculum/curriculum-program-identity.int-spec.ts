import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, adminToken, createTestApp, http, login, systemContextId, uniqueName } from '../../support/identity-access-helpers';
import { ProgramImportService } from '../../../src/modules/curriculum/program-import.service';
import { ProgramDumpService } from '../../../src/modules/curriculum/program-dump.service';
import { CurriculumService } from '../../../src/modules/curriculum/curriculum.service';
import { QuestionsRepository } from '../../../src/modules/questions/questions.repository';
import { QuizService } from '../../../src/modules/quiz/quiz.service';
import {
  loadProgramDataset, programAncestorNodeId, programCurriculumId, programDatasetByKey, programLessonNodeId,
  programOutcomeDocText, programRecordOutcomeEntries, programSubjectId, type ProgramDatasetFile,
  type ProgramOutcomeDoc, type ProgramRecord,
} from '../../../src/modules/curriculum/program-datasets';

/**
 * Định danh + phân phối dữ liệu chương trình chuẩn (issue #161) —
 * MÔ HÌNH DUMP ĐÔNG CỨNG — CHỐT CUỐI (Quyết định 20:09 ngày 26/10/2026,
 * sổ quyết định mục E; thay mô hình UUIDv5 cho YCCĐ trước đó):
 *
 * 1. SẢN XUẤT Ở TRUNG TÂM: importer nạp GDCD vào DB chuẩn; id của
 *    YCCĐ là **uuidv7 mờ do DB cấp** — không tính từ nội dung, vị
 *    trí hay bất kỳ thuộc tính nào (id của môn/chương trình/node vẫn
 *    là UUIDv5 theo khoá tự nhiên như phương án D).
 * 2. PHÂN PHỐI: xuất dump → xoá trắng → RESTORE dump cho tập id khớp
 *    100%; restore lần nữa trên DB đã có dữ liệu là bỏ qua (không
 *    nhân đôi). Nạp lại bằng importer trên DB đã restore là no-op.
 * 3. PATCH Ở TRUNG TÂM — sửa chữ một YCCĐ: CÙNG id, nội dung cập
 *    nhật tại chỗ, mọi tham chiếu (ánh xạ sách, gắn câu hỏi, derived)
 *    nguyên vẹn; báo cáo có đúng 1 mục text-changed.
 * 4. PATCH — chèn một dòng vào giữa: dòng mới có id MỚI, các dòng cũ
 *    giữ id và chỉ dời position; báo cáo gồm added + moved.
 * 5. PATCH — rút một dòng: dòng còn trong DB với retired_at có giá
 *    trị; pool theo ĐVK và bản đặc tả không còn thấy nó (đặc tả vẫn
 *    trả position/code cho dòng hiện hành); dòng nối câu hỏi còn
 *    nguyên; tra đích danh theo id vẫn thấy dòng.
 * 6. Hai dòng trùng hệt nhau: hai id khác nhau; rút một dòng thì
 *    dòng còn lại giữ id + còn hiện hành, mục removed gắn
 *    identicalTextAmbiguous.
 * 7. Rút cả bản ghi → mọi dòng của nó bị rút; bản ghi quay lại →
 *    hồi sinh đúng các dòng cũ (cùng id, retired_at về null).
 * 8. FK restrict chặn xoá thật (giữ từ phương án D): bề mặt quản trị
 *    trả 409 `curriculum.delete_referenced`; gỡ tham chiếu xong xoá
 *    được.
 * 9. Restore artifact CỦA MÔI TRƯỜNG KHÁC (issue #233): dump luôn
 *    mang context_id của máy sinh dump; bước restore neo lại các
 *    môn mới nạp về context hệ thống của chính môi trường đích —
 *    nếu không, môn thành mồ côi (context lạ không tồn tại ở đích)
 *    và mọi bề mặt theo môn gãy dù dữ liệu nguyên vẹn.
 */

const DATASET_KEY = 'gdcd';
const SLUG = 'giao-duc-cong-dan';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('Program identity + frozen dump distribution (issue #161)', () => {
  let app: INestApplication;
  let admin: string;
  let adminId: string;
  let systemCtxId: string;
  let pg: Client;
  let svc: ProgramImportService;
  let dumpSvc: ProgramDumpService;
  let curriculumSvc: CurriculumService;
  let questionsRepo: QuestionsRepository;
  let quizSvc: QuizService;
  let file: ProgramDatasetFile;

  let recA: ProgramRecord; // sửa tựa (qua topic)
  let recB: ProgramRecord; // sửa chữ YCCĐ đầu tiên
  let recC: ProgramRecord; // đổi khối (+1)
  let recD: ProgramRecord; // chèn dòng vào giữa (≥4 dòng phân biệt)
  let recE: ProgramRecord; // rút dòng — kiểm pool + đặc tả
  let recF: ProgramRecord; // hai dòng trùng hệt nhau
  let recG: ProgramRecord; // rút cả bản ghi rồi quay lại
  let lessonA = '';
  let lessonB = '';
  let lessonC = '';
  let lessonE = '';
  let outcomeA1 = '';
  let outcomeB1 = '';
  let outcomeE1 = '';
  let questionE = '';
  let matrixE = '';
  let derivedId = '';
  let bookNodeId = '';

  async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await pg.query(text, params);
    return res.rows as T[];
  }

  /** Xoá sạch môn GDCD (cây + sổ) để mỗi lượt bắt đầu từ DB trắng cho môn này. */
  async function wipeSubject(): Promise<void> {
    await pg.query(`delete from curriculum_program_records where dataset_key = $1`, [DATASET_KEY]);
    await pg.query(`delete from subjects where slug = $1`, [SLUG]);
  }

  /** Tập id node + YCCĐ của môn, đã sắp xếp — đơn vị đối chiếu tính khớp giữa các lần restore. */
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

  /**
   * Đọc các dòng YCCĐ thô của một node: cột content nay là tài liệu
   * JSONB (issue #334), nên kiểu trả về là tài liệu; mọi khẳng định
   * so text phải trích text canonical qua programOutcomeDocText
   * trước khi so, giữ nguyên độ chặt của khẳng định cũ.
   */
  async function outcomesOf(nodeId: string): Promise<{ id: string; content: ProgramOutcomeDoc; position: number; retired_at: Date | null }[]> {
    return sql(`select id, content, position, retired_at from learning_outcomes where node_id = $1 order by position`, [nodeId]);
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    adminId = (await login(app, ADMIN.username, ADMIN.password)).userId;
    systemCtxId = await systemContextId(app, admin);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    svc = app.get(ProgramImportService, { strict: false });
    dumpSvc = app.get(ProgramDumpService, { strict: false });
    curriculumSvc = app.get(CurriculumService, { strict: false });
    questionsRepo = app.get(QuestionsRepository, { strict: false });
    quizSvc = app.get(QuizService, { strict: false });
    file = loadProgramDataset(programDatasetByKey(DATASET_KEY)!);
    expect(file.records.length).toBe(116);
    const withOutcomes = file.records.filter((r) => (r.outcomes?.length ?? 0) >= 1);
    recA = withOutcomes.find((r) => (r.outcomes?.length ?? 0) >= 2 && r.topic)!;
    recB = withOutcomes.find((r) => r.id !== recA.id && r.grade === recA.grade)!;
    const grades = new Set(file.records.map((r) => r.grade));
    recC = withOutcomes.find((r) => r.id !== recA.id && r.id !== recB.id && r.grade !== null && grades.has(r.grade + 1))!;
    const used = new Set([recA.id, recB.id, recC.id]);
    recD = withOutcomes.find((r) => !used.has(r.id) && (r.outcomes?.length ?? 0) >= 4
      && new Set(programRecordOutcomeEntries(r).map((e) => e.text)).size === (r.outcomes?.length ?? 0))!;
    used.add(recD.id);
    recE = withOutcomes.find((r) => !used.has(r.id) && (r.outcomes?.length ?? 0) >= 2)!;
    used.add(recE.id);
    recF = withOutcomes.find((r) => !used.has(r.id))!;
    used.add(recF.id);
    recG = withOutcomes.find((r) => !used.has(r.id))!;
    expect(recA && recB && recC && recD && recE && recF && recG).toBeTruthy();
    await wipeSubject();
  }, 120_000);
  afterAll(async () => {
    try {
      await pg.query(`delete from books where title like 'Sach kiem chung GDPT-SEED%'`);
      // Câu hỏi không còn cột name sau đợt port (quyết 12:04/12:12):
      // dọn theo category kiểm chứng của spec, trước khi xoá category.
      await pg.query(`delete from question where category in (select id from question_categories where name like 'cat-gdpt-seed%')`);
      await pg.query(`delete from exam_matrices where name like 'Ma trận kiểm chứng %'`);
      await pg.query(`delete from question_categories where name like 'cat-gdpt-seed%'`);
      await wipeSubject();
    } catch { /* dọn dẹp thất bại không được làm đỏ suite */ }
    await pg.end();
    await app.close();
  });

  it('central production: importer loads GDCD; outcome ids are DB-assigned uuidv7, not derived from any attribute', async () => {
    const res = await svc.importDatasetInternal(DATASET_KEY);
    expect(res.totalRecords).toBe(116);
    expect(res.created).toBe(116);
    expect(res.updated).toBe(0);
    expect(res.orphanedNodes).toBe(0);
    expect(res.retiredOutcomes).toBe(0);
    expect(res.changeCounts.added).toBeGreaterThan(0);
    // GDCD có dưới 500 dòng YCCĐ: toàn bộ thay đổi nằm trong danh sách chi tiết, không cắt.
    expect(res.changesOmitted).toBe(0);
    expect(res.changes.length).toBe(res.changeCounts.added);

    const subjects = await sql<{ id: string }>(`select id from subjects where slug = $1`, [SLUG]);
    expect(subjects[0]!.id).toBe(programSubjectId(SLUG));
    expect(res.subjectId).toBe(programSubjectId(SLUG));

    const grade = recA.grade!;
    const curricula = await sql<{ id: string }>(
      `select id from curricula where subject_id = $1 and grade = $2`, [subjects[0]!.id, grade]);
    expect(curricula[0]!.id).toBe(programCurriculumId(SLUG, grade));

    lessonA = await lessonIdOf(recA.id);
    expect(lessonA).toBe(programLessonNodeId(DATASET_KEY, recA.id));

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

    // YCCĐ: nội dung + position khớp dataset theo thứ tự; id là
    // uuidv7 MỜ do DB cấp (không công thức nào suy được từ nội dung
    // hay vị trí — hai dòng cùng nội dung ở hai vị trí vẫn khác id,
    // và id không đổi khi nội dung đổi — khẳng định ở các ca patch).
    const expected = programRecordOutcomeEntries(recA);
    const outcomes = await outcomesOf(lessonA);
    expect(outcomes.map((o) => programOutcomeDocText(o.content))).toEqual(expected.map((e) => e.text));
    expect(outcomes.map((o) => o.position)).toEqual(expected.map((e) => e.position));
    for (const o of outcomes) expect(o.id).toMatch(UUID_V7);
    outcomeA1 = outcomes[0]!.id;
  }, 180_000);

  it('frozen dump: export → wipe → restore reproduces the identical id set; restore on populated DB is a no-op', async () => {
    const before = await snapshotIds();
    expect(before.nodes.length).toBeGreaterThan(116);
    expect(before.outcomes.length).toBeGreaterThan(300);

    // Suite chạy trên DB dùng chung với các spec khác: dump phải
    // giới hạn ở cây của GDCD (đường sản xuất ở trung tâm dùng DB
    // chuyên dụng nên xuất toàn bộ — cùng một hàm, khác phạm vi).
    const dumpSql = await dumpSvc.buildDumpSql({ datasetKey: DATASET_KEY });
    expect(dumpSql).toContain('DUMP ĐÔNG CỨNG');

    await wipeSubject();
    await dumpSvc.restoreDumpSql(dumpSql);
    const afterFirst = await snapshotIds();
    expect(afterFirst).toEqual(before);

    // DB đã có dữ liệu chương trình: restoreIfEmpty bỏ qua (đây là
    // đường seed của các môi trường — không nhân đôi, không ghi đè).
    const second = await dumpSvc.restoreIfEmpty();
    expect(second.restored).toBe(false);
    expect(await snapshotIds()).toEqual(before);

    // Xoá trắng lần nữa, restore lại từ CÙNG artifact: vẫn khớp 100%.
    await wipeSubject();
    await dumpSvc.restoreDumpSql(dumpSql);
    expect(await snapshotIds()).toEqual(before);

    // Importer trên DB đã restore là no-op tuyệt đối (sổ + hash khớp).
    const res = await svc.importDatasetInternal(DATASET_KEY);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(116);
    expect(res.changes).toEqual([]);
    expect(res.retiredOutcomes).toBe(0);

    lessonA = await lessonIdOf(recA.id);
    lessonB = await lessonIdOf(recB.id);
    lessonC = await lessonIdOf(recC.id);
    outcomeB1 = (await outcomesOf(lessonB))[0]!.id;
    outcomeA1 = (await outcomesOf(lessonA))[0]!.id;
  }, 180_000);

  it('restore dump của môi trường khác: môn neo lại về context hệ thống của môi trường đích (issue #233)', async () => {
    // Ca này đứng ngay sau ca xuất → restore ở trên, khi cây vừa
    // restore còn "sạch" (chưa có ánh xạ sách/liên kết câu hỏi nào
    // tham chiếu node — các ca patch phía sau mới dựng chúng, và
    // FK restrict sẽ chặn wipeSubject từ lúc đó).
    // Chụp tập id hiện hành để đối chiếu tính nguyên vẹn sau restore.
    const before = await snapshotIds();
    // Dump sinh từ trạng thái hiện tại, rồi GIẢ LẬP artifact của
    // một môi trường khác: thay context hệ thống trong dump bằng
    // một id context không tồn tại ở đây — đúng hiện tượng đã xảy
    // ra trên production (artifact mang context_id của máy sinh
    // dump; cột không có FK nên trước đây restore nhận im lặng và
    // môn thành mồ côi, mọi lần đọc theo môn ném
    // access.context_not_found).
    const dump = await dumpSvc.buildDumpSql({ datasetKey: DATASET_KEY });
    const foreignCtx = randomUUID();
    const foreignDump = dump.split(systemCtxId).join(foreignCtx);
    expect(foreignDump).toContain(foreignCtx);

    await wipeSubject();
    await dumpSvc.restoreDumpSql(foreignDump);

    // Môn neo về context hệ thống CỦA MÔI TRƯỜNG ĐÍCH; cây + sổ
    // giữ nguyên tập id như trước khi xoá.
    const rows = await sql<{ id: string; context_id: string }>(
      `select id, context_id from subjects where slug = $1`, [SLUG]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.context_id).toBe(systemCtxId);
    expect(await snapshotIds()).toEqual(before);
    // Bề mặt đọc công khai đọc được môn (khi chưa có bước neo,
    // lần đọc này ném access.context_not_found vì context lạ
    // không tồn tại ở môi trường đích).
    const view = await curriculumSvc.getSubject(adminId, rows[0]!.id);
    expect(view.id).toBe(rows[0]!.id);
  }, 180_000);

  it('central patch — text correction keeps the same outcome id and every reference', async () => {
    // --- dựng tham chiếu quanh cây vừa restore ---------------------
    const derivedRes = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin))
      .send({ nodeId: lessonA, content: 'YCCĐ suy ra phục vụ kiểm chứng.', sourceKind: 'derived', derivedFromId: outcomeA1 });
    expect(derivedRes.status).toBe(201);
    derivedId = (derivedRes.body as { id: string }).id;

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

    const category = await sql<{ id: string }>(
      `insert into question_categories (name, context_id) values ($1, $2) returning id`, [uniqueName('cat-gdpt-seed'), systemCtxId]);
    const question = await sql<{ id: string }>(
      `insert into question (category, qtype) values ($1, 'multichoice') returning id`, [category[0]!.id]);
    await pg.query(
      `insert into question_bank_entries (question_category_id, question_id, status) values ($1, $2, 'ready')`, [category[0]!.id, question[0]!.id]);
    await pg.query(
      `insert into question_learning_outcomes (question_id, learning_outcome_id, cognitive_level) values ($1, $2, 'biet')`,
      [question[0]!.id, outcomeB1]);

    const matrix = await sql<{ id: string }>(
      `insert into exam_matrices (name, subject_id, curriculum_id, context_id)
       values ('Ma trận kiểm chứng sửa chữ', $1,
               (select curriculum_id from curriculum_program_records where dataset_key = $2 and record_id = $3), $4)
       returning id`,
      [programSubjectId(SLUG), DATASET_KEY, recC.id, systemCtxId]);
    // Ô phải thuộc về một version bất biến của ma trận (bất biến từ
    // đợt version hoá ma trận, issue #228 S1): fixture dựng kèm
    // hàng version 1 như đường tạo ma trận thật.
    const matrixVersion = await sql<{ id: string }>(
      `insert into exam_matrix_versions (matrix_id, version, created_by) values ($1, 1, $2) returning id`,
      [matrix[0]!.id, adminId]);
    await pg.query(
      `insert into exam_matrix_cells (matrix_id, matrix_version_id, curriculum_node_id, cognitive_level, qtype, question_count, cell_score)
       values ($1, $2, $3, 'hieu', 'multichoice', 1, 1)`, [matrix[0]!.id, matrixVersion[0]!.id, lessonC]);

    const refsBefore = await referenceSnapshot();
    const outcomeTotalBefore = (await snapshotIds()).outcomes.length;

    // --- dataset đính chính 3 kiểu --------------------------------
    const mutated = structuredClone(file) as ProgramDatasetFile;
    const mA = mutated.records.find((r) => r.id === recA.id)!;
    mA.topic = `${recA.topic} (đính chính)`;
    const mB = mutated.records.find((r) => r.id === recB.id)!;
    const firstTextB = programRecordOutcomeEntries(recB)[0]!.text;
    const newTextB = `${firstTextB} [bản đính chính]`;
    mB.outcomes = [newTextB, ...recB.outcomes!.slice(1)];
    const mC = mutated.records.find((r) => r.id === recC.id)!;
    mC.grade = recC.grade! + 1;

    const res = await svc.importDatasetFileInternal(DATASET_KEY, mutated);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(3);
    expect(res.orphanedNodes).toBe(0);
    expect(res.changeCounts.textChanged).toBe(1);
    const textChange = res.changes.find((c) => c.kind === 'text-changed');
    expect(textChange).toMatchObject({ recordId: recB.id, position: 1, oldText: firstTextB, newText: newTextB });

    // (a) Sửa tựa: node giữ id, tựa mới theo topic đã đính chính.
    const nodeA = await sql<{ id: string; title: string }>(`select id, title from curriculum_nodes where id = $1`, [lessonA]);
    expect(nodeA[0]!.title).toBe(mA.topic);

    // (b) Sửa chữ YCCĐ: CÙNG dòng, CÙNG id — nội dung cập nhật tại
    // chỗ; không sinh dòng mới, không dòng nào bị rút.
    const bRows = await outcomesOf(lessonB);
    const corrected = bRows.find((r) => r.id === outcomeB1);
    expect(corrected, 'the corrected outcome keeps its row and id').toBeTruthy();
    expect(programOutcomeDocText(corrected!.content)).toBe(newTextB);
    expect(corrected!.retired_at).toBeNull();
    expect((await snapshotIds()).outcomes.length).toBe(outcomeTotalBefore);

    // (c) Đổi khối: node giữ id, chuyển curriculum_id sang khối mới.
    const nodeC = await sql<{ id: string; curriculum_id: string }>(
      `select id, curriculum_id from curriculum_nodes where id = $1`, [lessonC]);
    expect(nodeC[0]!.curriculum_id).toBe(programCurriculumId(SLUG, recC.grade! + 1));

    // Mọi tham chiếu nguyên vẹn từng dòng; derived không bị đụng.
    expect(await referenceSnapshot()).toEqual(refsBefore);
    const derived = await sql<{ id: string; node_id: string; source_kind: string; content: string; derived_from_id: string }>(
      `select id, node_id, source_kind, content, derived_from_id from learning_outcomes where id = $1`, [derivedId]);
    expect(derived.length).toBe(1);
    expect(derived[0]!.derived_from_id).toBe(outcomeA1);
  }, 180_000);

  it('central patch — inserting a line in the middle gives it a fresh id and only resequences positions', async () => {
    const lessonD = await lessonIdOf(recD.id);
    const beforeRows = await outcomesOf(lessonD);
    expect(beforeRows.length).toBeGreaterThanOrEqual(4);
    const idsBefore = new Set(beforeRows.map((r) => r.id));

    const insertedText = 'Ý mới chèn giữa phục vụ kiểm chứng neo định danh.';
    const mutated = structuredClone(file) as ProgramDatasetFile;
    const mD = mutated.records.find((r) => r.id === recD.id)!;
    // Dataset hiện tại của recD trong DB vẫn là bản gốc (chưa patch lần nào).
    mD.outcomes = [...recD.outcomes!.slice(0, 2), insertedText, ...recD.outcomes!.slice(2)];

    const res = await svc.importDatasetFileInternal(DATASET_KEY, mutated);
    expect(res.changeCounts.added).toBe(1);
    expect(res.changeCounts.moved).toBe(beforeRows.length - 2);
    const added = res.changes.find((c) => c.kind === 'added' && c.recordId === recD.id);
    expect(added).toMatchObject({ position: 3, newText: insertedText });

    const afterRows = await outcomesOf(lessonD);
    expect(afterRows.length).toBe(beforeRows.length + 1);
    // Hai dòng đầu giữ nguyên id + vị trí.
    expect(afterRows[0]!.id).toBe(beforeRows[0]!.id);
    expect(afterRows[1]!.id).toBe(beforeRows[1]!.id);
    // Dòng chèn: id MỚI (uuidv7, chưa từng có), ở vị trí 3.
    expect(programOutcomeDocText(afterRows[2]!.content)).toBe(insertedText);
    expect(afterRows[2]!.id).toMatch(UUID_V7);
    expect(idsBefore.has(afterRows[2]!.id)).toBe(false);
    // Các dòng sau giữ id, chỉ dời vị trí +1.
    for (let i = 3; i < afterRows.length; i += 1) {
      expect(afterRows[i]!.id).toBe(beforeRows[i - 1]!.id);
      expect(afterRows[i]!.position).toBe(beforeRows[i - 1]!.position + 1);
    }
  }, 180_000);

  it('retiring a line removes it from the question pool and the specification, but never deletes it', async () => {
    lessonE = await lessonIdOf(recE.id);
    outcomeE1 = (await outcomesOf(lessonE))[0]!.id;

    // Câu ready gắn vào outcomeE1 + ma trận có ô neo node của recE.
    const category = await sql<{ id: string }>(
      `insert into question_categories (name, context_id) values ($1, $2) returning id`, [uniqueName('cat-gdpt-seed'), systemCtxId]);
    const question = await sql<{ id: string }>(
      `insert into question (category, qtype) values ($1, 'multichoice') returning id`, [category[0]!.id]);
    questionE = question[0]!.id;
    await pg.query(
      `insert into question_bank_entries (question_category_id, question_id, status) values ($1, $2, 'ready')`, [category[0]!.id, questionE]);
    await pg.query(
      `insert into question_learning_outcomes (question_id, learning_outcome_id, cognitive_level) values ($1, $2, 'biet')`,
      [questionE, outcomeE1]);
    const matrix = await sql<{ id: string }>(
      `insert into exam_matrices (name, subject_id, curriculum_id, context_id)
       values ('Ma trận kiểm chứng rút dòng', $1,
               (select curriculum_id from curriculum_program_records where dataset_key = $2 and record_id = $3), $4)
       returning id`,
      [programSubjectId(SLUG), DATASET_KEY, recE.id, systemCtxId]);
    matrixE = matrix[0]!.id;
    // Như fixture phía trên: ô thuộc về version 1 bất biến của ma trận.
    const matrixVersionE = await sql<{ id: string }>(
      `insert into exam_matrix_versions (matrix_id, version, created_by) values ($1, 1, $2) returning id`,
      [matrixE, adminId]);
    await pg.query(
      `insert into exam_matrix_cells (matrix_id, matrix_version_id, curriculum_node_id, cognitive_level, qtype, question_count, cell_score)
       values ($1, $2, $3, 'biet', 'multichoice', 1, 1)`, [matrixE, matrixVersionE[0]!.id, lessonE]);

    // Trước khi rút: pool có câu; đặc tả có outcome kèm position + code.
    const poolBefore = await questionsRepo.filterQuestionsByCurriculumLinks({
      nodeId: lessonE, cognitiveLevel: 'biet', qtype: 'multichoice', status: 'ready',
    });
    expect(poolBefore.map((q) => q.id)).toContain(questionE);
    const specBefore = await quizSvc.getMatrixSpecification(adminId, matrixE);
    const specOutcomesBefore = specBefore.topics.flatMap((t) => t.nodes).find((n) => n.nodeId === lessonE)?.outcomes ?? [];
    const specEntry = specOutcomesBefore.find((o) => o.outcomeId === outcomeE1);
    expect(specEntry).toBeTruthy();
    expect(specEntry!.position).toBe(1);
    expect(specEntry!.code).toBe(`${recE.id}.01`);

    // Patch trung tâm: bỏ dòng đầu của recE khỏi dataset.
    const mutated = structuredClone(file) as ProgramDatasetFile;
    const mE = mutated.records.find((r) => r.id === recE.id)!;
    mE.outcomes = recE.outcomes!.slice(1);
    const res = await svc.importDatasetFileInternal(DATASET_KEY, mutated);
    const removed = res.changes.find((c) => c.kind === 'removed' && c.recordId === recE.id);
    expect(removed).toBeTruthy();
    expect(removed!.linkedQuestions).toBeGreaterThanOrEqual(1);

    // Dòng còn nguyên trong DB với retired_at có giá trị; dòng nối
    // câu hỏi còn nguyên; tra đích danh theo id vẫn thấy dòng.
    const row = await sql<{ id: string; retired_at: Date | null }>(
      `select id, retired_at from learning_outcomes where id = $1`, [outcomeE1]);
    expect(row.length).toBe(1);
    expect(row[0]!.retired_at).not.toBeNull();
    const links = await sql(`select id from question_learning_outcomes where learning_outcome_id = $1`, [outcomeE1]);
    expect(links.length).toBe(1);
    const byId = await curriculumSvc.getOutcome(adminId, outcomeE1);
    expect(byId.id).toBe(outcomeE1);

    // Pool và đặc tả không còn thấy dòng đã rút.
    const poolAfter = await questionsRepo.filterQuestionsByCurriculumLinks({
      nodeId: lessonE, cognitiveLevel: 'biet', qtype: 'multichoice', status: 'ready',
    });
    expect(poolAfter.map((q) => q.id)).not.toContain(questionE);
    const specAfter = await quizSvc.getMatrixSpecification(adminId, matrixE);
    const specOutcomeIds = specAfter.topics.flatMap((t) => t.nodes).flatMap((n) => n.outcomes).map((o) => o.outcomeId);
    expect(specOutcomeIds).not.toContain(outcomeE1);
  }, 180_000);

  it('identical twin lines get distinct ids; retiring one keeps the other active and flags the ambiguity', async () => {
    const lessonF = await lessonIdOf(recF.id);
    const twin = 'Ý trùng hệt nhau phục vụ kiểm chứng.';
    const third = 'Ý thứ ba phân biệt phục vụ kiểm chứng.';
    const step1 = structuredClone(file) as ProgramDatasetFile;
    step1.records.find((r) => r.id === recF.id)!.outcomes = [twin, twin, third];
    await svc.importDatasetFileInternal(DATASET_KEY, step1);
    const allRows = await outcomesOf(lessonF);
    // Luật không-xoá: các dòng gốc bị thay thế nằm lại ở trạng thái
    // đã rút; tập HIỆN HÀNH phải đúng 3 dòng mới theo thứ tự dataset.
    const rows = allRows.filter((r) => r.retired_at === null);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => programOutcomeDocText(r.content))).toEqual([twin, twin, third]);
    expect(programOutcomeDocText(rows[0]!.content)).toBe(twin);
    expect(programOutcomeDocText(rows[1]!.content)).toBe(twin);
    expect(programOutcomeDocText(rows[2]!.content)).toBe(third);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    for (const r of rows) expect(r.id).toMatch(UUID_V7);

    const step2 = structuredClone(file) as ProgramDatasetFile;
    step2.records.find((r) => r.id === recF.id)!.outcomes = [twin, third];
    const res = await svc.importDatasetFileInternal(DATASET_KEY, step2);
    const removed = res.changes.find((c) => c.kind === 'removed' && c.recordId === recF.id);
    expect(removed).toBeTruthy();
    expect(removed!.identicalTextAmbiguous).toBe(true);

    const after = await outcomesOf(lessonF);
    const keptTwin = after.find((r) => r.id === rows[0]!.id);
    expect(keptTwin!.retired_at).toBeNull(); // quy ước: giữ dòng ở vị trí thấp
    const retiredTwin = after.find((r) => r.id === rows[1]!.id);
    expect(retiredTwin!.retired_at).not.toBeNull();
  }, 180_000);

  it('removing a whole record retires all its lines; the record returning revives the same rows', async () => {
    const lessonG = await lessonIdOf(recG.id);
    const beforeRows = await outcomesOf(lessonG);
    expect(beforeRows.length).toBeGreaterThan(0);

    const removedFile = structuredClone(file) as ProgramDatasetFile;
    removedFile.records = removedFile.records.filter((r) => r.id !== recG.id);
    const resRemoved = await svc.importDatasetFileInternal(DATASET_KEY, removedFile);
    expect(resRemoved.orphanedNodes).toBe(1);
    expect(resRemoved.changeCounts.removed).toBe(beforeRows.length);
    const duringRows = await outcomesOf(lessonG);
    expect(duringRows.length).toBe(beforeRows.length);
    for (const r of duringRows) expect(r.retired_at).not.toBeNull();

    const resBack = await svc.importDatasetFileInternal(DATASET_KEY, file);
    expect(resBack.changeCounts.revived).toBe(beforeRows.length);
    const backRows = await outcomesOf(lessonG);
    expect(backRows.map((r) => r.id)).toEqual(beforeRows.map((r) => r.id));
    for (const r of backRows) expect(r.retired_at).toBeNull();
  }, 180_000);

  it('restrict blocks deletion with a business error until references are removed', async () => {
    const delOutcome = await http(app).delete(`/api/v1/curriculum/outcomes/${outcomeA1}`).set(bearer(admin));
    expect(delOutcome.status).toBe(409);
    expect(delOutcome.body.code).toBe('curriculum.delete_referenced');
    const delNode = await http(app).delete(`/api/v1/curriculum/nodes/${lessonA}`).set(bearer(admin));
    expect(delNode.status).toBe(409);
    expect(delNode.body.code).toBe('curriculum.delete_referenced');
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
    const delCorrected = await http(app).delete(`/api/v1/curriculum/outcomes/${outcomeB1}`).set(bearer(admin));
    expect(delCorrected.status).toBeLessThan(300);
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
      `select id, matrix_id, curriculum_node_id from exam_matrix_cells where curriculum_node_id = $1`, [lessonC]);
    return { mappings, links, cells };
  }
});
