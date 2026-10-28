import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId,
} from '../../support/identity-access-helpers';

/**
 * K0b (issue #67) — nạp dữ liệu SGK "Kết nối tri thức với cuộc sống"
 * (Toán 1) vào cây sách + ánh xạ sang chương trình GDPT 2018.
 * Oracle: file dataset đã kiểm chứng nguyên văn với mục lục in trong
 * cuốn SGK Toán 1 (Tập 1 + Tập 2) và mục lục Sách giáo viên Toán 1 của
 * NXB Giáo dục Việt Nam (nguồn khai ở Bước 0 trên issue #67) — bản sao
 * vendor tại `src/modules/books/book-data/`. Spec đối chiếu
 * TỪNG bản ghi qua API cây sách: đúng chủ đề/tựa bài/thứ tự, ánh xạ
 * đúng mã bản ghi chương trình, và YCCĐ của bài đúng bằng hợp YCCĐ của
 * các node chương trình được ánh xạ (đọc từ cây chương trình, truy vết
 * qua source_ref chứa mã bản ghi). Kèm khẳng định phủ định của issue:
 * không node SGK nào lọt vào cây chương trình chuẩn.
 */

interface BookRecord {
  id: string; volume: number; chapter: string; chapter_number: number;
  lesson: string; lesson_number: number | null; program_records: string[];
}
/** Node của một YCCĐ dạng Tiptap doc trong dataset (doc/paragraph/text + bulletList/listItem cho ý con). */
interface OutcomeDocNode {
  type: string;
  text?: string;
  content?: OutcomeDocNode[];
}
interface OutcomeDoc {
  type: 'doc';
  content?: OutcomeDocNode[];
}

interface ProgramRecord {
  id: string; grade: number; outcomes: (string | OutcomeDoc)[]; outcome_text: string;
}

const bookFile = JSON.parse(
  readFileSync(join(process.cwd(), 'src/modules/books/book-data/book-toan-1.json'), 'utf8'),
) as { records: BookRecord[] };
const programFile = JSON.parse(
  readFileSync(join(process.cwd(), 'src/modules/curriculum/program-data/program-toan.json'), 'utf8'),
) as { records: ProgramRecord[] };

/**
 * Text của một YCCĐ dạng doc — ORACLE trích độc lập trong spec (không
 * dùng code nạp, giữ tính độc lập của oracle): mỗi paragraph là một
 * dòng, listItem cho dòng của paragraph của nó rồi tới các dòng của
 * bulletList lồng bên trong (đệ quy); các dòng nối bằng '\n', cắt
 * khoảng trắng hai đầu — đúng semantics text canonical mà hệ lưu vào
 * `learning_outcomes.content` nay là cột jsonb lưu trực tiếp tài liệu
 * này; text canonical trích từ tài liệu bằng đúng semantics này.
 */
function docOutcomeText(doc: OutcomeDoc): string {
  const lines: string[] = [];
  const walk = (node: OutcomeDocNode): void => {
    if (node.type === 'paragraph') {
      lines.push((node.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''));
      return;
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return lines.join('\n').trim();
}

/** Các dòng YCCĐ kỳ vọng của một bản ghi (phần tử dạng doc trích text bằng docOutcomeText). */
function outcomeTexts(r: ProgramRecord): string[] {
  if (r.outcomes.length > 0) {
    return r.outcomes.map((o) => (typeof o === 'string' ? o : docOutcomeText(o)));
  }
  if (r.outcome_text.trim().length > 0) return [r.outcome_text];
  return [];
}
/** YCCĐ kỳ vọng của một bài: hợp theo thứ tự ánh xạ, khử trùng theo nội dung (khớp quy tắc của BookService). */
function expectedLessonOutcomes(record: BookRecord): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of record.program_records) {
    const programRecord = programFile.records.find((r) => r.id === code);
    expect(programRecord, `program record ${code}`).toBeTruthy();
    for (const text of outcomeTexts(programRecord!)) {
      if (!seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
  }
  return out;
}

interface ProgTreeNode {
  id: string; title: string; kind: string;
  outcomes: { id: string; content: string; sourceRef: string | null }[];
  children: ProgTreeNode[];
}
function gradeOneLessons(nodes: ProgTreeNode[], out: ProgTreeNode[] = []): ProgTreeNode[] {
  for (const node of nodes) {
    if (node.kind === 'lesson') out.push(node);
    gradeOneLessons(node.children, out);
  }
  return out;
}

interface BookTreeBody {
  book: { id: string; grade: number; title: string };
  chapters: {
    id: string; title: string; volume: number | null; position: number;
    lessons: {
      id: string; title: string; lessonNumber: number | null; recordId: string | null;
      mappings: { curriculumNodeId: string | null; learningOutcomeId: string | null; programRecordId: string | null }[];
      outcomes: { outcomeId: string; content: string }[];
    }[];
  }[];
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('K0b book import (verified Toán 1 TOC → book tree + programme mappings)', () => {
  let app: INestApplication;
  let admin: string;
  let systemCtxId: string;
  let plainToken: string;
  let teacherToken: string;
  let bookId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    systemCtxId = await systemContextId(app, admin);
    const plain = await createUserViaApi(app, admin);
    plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;
    const teacher = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'editingteacher'), systemCtxId);
    teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
  }, 120_000);
  afterAll(async () => { await app.close(); });

  it('reports book dataset status and denies users without curriculum capabilities', async () => {
    const status = await http(app).get('/api/v1/books/dataset-import').set(bearer(admin));
    expect(status.status).toBe(200);
    const rows = status.body as { datasetKey: string; totalRecords: number; mappedRecords: number }[];
    const row = rows.find((r) => r.datasetKey === 'sgk-toan-1');
    expect(row?.totalRecords).toBe(42);
    expect(row?.mappedRecords).toBe(41);

    const plainStatus = await http(app).get('/api/v1/books/dataset-import').set(bearer(plainToken));
    expect(plainStatus.status).toBe(403);
    expect(plainStatus.body.code).toBe('access.capability_denied');
    const plainImport = await http(app).post('/api/v1/books/dataset-import').set(bearer(plainToken)).send({ datasetKey: 'sgk-toan-1' });
    expect(plainImport.status).toBe(403);
    // Giáo viên hệ thống có curriculum:view nhưng không có curriculum:manage → đọc được, nạp bị từ chối.
    const teacherStatus = await http(app).get('/api/v1/books/dataset-import').set(bearer(teacherToken));
    expect(teacherStatus.status).toBe(200);
    const teacherImport = await http(app).post('/api/v1/books/dataset-import').set(bearer(teacherToken)).send({ datasetKey: 'sgk-toan-1' });
    expect(teacherImport.status).toBe(403);
    // Dataset không có trong manifest → 404 tường minh.
    const bogus = await http(app).post('/api/v1/books/dataset-import').set(bearer(admin)).send({ datasetKey: 'sgk-ngu-van-1' });
    expect(bogus.status).toBe(404);
    expect(bogus.body.code).toBe('book.dataset_not_found');
  });

  it('refuses to import when the programme dataset is missing, then imports after it', async () => {
    // Thứ tự spec trong cùng DB không bảo đảm: nếu dataset chương trình
    // chưa từng được nạp ở DB này, lượt nạp SGK phải lỗi cứng
    // book_mapping_unresolved và KHÔNG ghi dở; nếu đã nạp rồi thì
    // lượt nạp SGK chạy thẳng. Cả hai đường đều phải kết thúc ở trạng
    // thái đã nạp xong chương trình rồi mới nạp SGK thành công.
    const probe = await http(app).get('/api/v1/curriculum/program-import').set(bearer(admin));
    const toanRow = (probe.body as { datasetKey: string; importedRecords: number }[]).find((r) => r.datasetKey === 'toan');
    if ((toanRow?.importedRecords ?? 0) === 0) {
      const early = await http(app).post('/api/v1/books/dataset-import').set(bearer(admin)).send({ datasetKey: 'sgk-toan-1' });
      expect(early.status).toBe(400);
      expect(early.body.code).toBe('book.mapping_unresolved');
      const books = await http(app).get('/api/v1/books').set(bearer(admin));
      expect((books.body as unknown[]).length).toBe(0);
    }
    const imp = await http(app).post('/api/v1/curriculum/program-import').set(bearer(admin)).send({ datasetKey: 'toan' });
    expect(imp.status).toBe(201);

    const res = await http(app).post('/api/v1/books/dataset-import').set(bearer(admin)).send({ datasetKey: 'sgk-toan-1' });
    expect(res.status).toBe(201);
    const result = res.body as {
      bookId: string; totalRecords: number; created: number; updated: number; skipped: number; mappingsWritten: number;
    };
    bookId = result.bookId;
    expect(result.totalRecords).toBe(42);
    expect(result.created + result.updated + result.skipped).toBe(42);
    const expectedMappings = bookFile.records.reduce((n, r) => n + r.program_records.length, 0);
    if (result.created === 42) expect(result.mappingsWritten).toBe(expectedMappings);
  }, 300_000);

  it('book tree matches the verified dataset record by record, with programme outcomes resolved through mappings', async () => {
    const treeRes = await http(app).get(`/api/v1/books/${bookId}/tree`).set(bearer(admin));
    expect(treeRes.status).toBe(200);
    const tree = treeRes.body as BookTreeBody;
    expect(tree.book.title).toBe('Toán 1');
    expect(tree.book.grade).toBe(1);

    // Chủ đề: đúng số lượng, đúng tựa + tập theo thứ tự dataset.
    const expectedChapters: { title: string; volume: number }[] = [];
    for (const r of bookFile.records) {
      if (!expectedChapters.some((c) => c.title === r.chapter && c.volume === r.volume)) {
        expectedChapters.push({ title: r.chapter, volume: r.volume });
      }
    }
    expect(tree.chapters.length).toBe(expectedChapters.length);
    expect(tree.chapters.map((c) => ({ title: c.title, volume: c.volume }))).toEqual(expectedChapters);

    // Từng bài: đúng chủ đề, tựa, số bài, mã bản ghi, ánh xạ và YCCĐ.
    const allLessons = tree.chapters.flatMap((c) => c.lessons.map((l) => ({ chapter: c, lesson: l })));
    expect(allLessons.length).toBe(42);
    for (const record of bookFile.records) {
      const found = allLessons.find((x) => x.lesson.recordId === record.id);
      expect(found, `record ${record.id}`).toBeTruthy();
      expect(found!.chapter.title, `${record.id} chapter`).toBe(record.chapter);
      expect(found!.lesson.title, `${record.id} lesson title`).toBe(record.lesson);
      expect(found!.lesson.lessonNumber, `${record.id} lesson number`).toBe(record.lesson_number);
      expect(
        found!.lesson.mappings.map((m) => m.programRecordId),
        `${record.id} mapping codes`,
      ).toEqual(record.program_records.map((code) => code));
      for (const m of found!.lesson.mappings) {
        expect(m.curriculumNodeId, `${record.id} mapping target`).toBeTruthy();
        expect(m.learningOutcomeId).toBeNull();
      }
      expect(
        found!.lesson.outcomes.map((o) => o.content),
        `${record.id} resolved outcomes`,
      ).toEqual(expectedLessonOutcomes(record));
    }
    // Bài chưa ánh xạ duy nhất: "Tiết học đầu tiên" — không ánh xạ, không YCCĐ.
    const unmapped = allLessons.filter((x) => x.lesson.mappings.length === 0);
    expect(unmapped.length).toBe(1);
    expect(unmapped[0]!.lesson.title).toBe('Tiết học đầu tiên');
    expect(unmapped[0]!.lesson.outcomes).toEqual([]);
  }, 120_000);

  it('no book node leaks into the standard programme tree', async () => {
    const subjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}`).set(bearer(admin));
    const subject = (subjects.body as { id: string; slug: string }[]).find((s) => s.slug === 'toan');
    const curricula = await http(app).get(`/api/v1/curriculum/curricula?subjectId=${subject!.id}`).set(bearer(admin));
    const curriculum1 = (curricula.body as { id: string; grade: number }[]).find((c) => c.grade === 1);
    const tree = await http(app).get(`/api/v1/curriculum/curricula/${curriculum1!.id}/tree`).set(bearer(admin));
    expect(tree.status).toBe(200);
    const lessons = gradeOneLessons((tree.body as { nodes: ProgTreeNode[] }).nodes);
    // Cây chuẩn lớp 1 vẫn đúng 12 node nội dung của dataset chương trình.
    expect(lessons.length).toBe(programFile.records.filter((r) => r.grade === 1).length);
    const programTitles = new Set(lessons.map((l) => l.title));
    for (const record of bookFile.records) {
      expect(programTitles.has(record.lesson), `book lesson "${record.lesson}" leaked`).toBe(false);
      expect(programTitles.has(record.chapter), `book chapter "${record.chapter}" leaked`).toBe(false);
    }
  });

  it('re-importing the book dataset is a no-op: every record skipped', async () => {
    const res = await http(app).post('/api/v1/books/dataset-import').set(bearer(admin)).send({ datasetKey: 'sgk-toan-1' });
    expect(res.status).toBe(201);
    const result = res.body as { created: number; updated: number; skipped: number };
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(42);
    const status = await http(app).get('/api/v1/books/dataset-import').set(bearer(admin));
    const row = (status.body as { datasetKey: string; importedRecords: number }[]).find((r) => r.datasetKey === 'sgk-toan-1');
    expect(row?.importedRecords).toBe(42);
  }, 120_000);
});
