import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';
import { courseContextId } from '../../support/engagement-helpers';

/**
 * K0b (issue #67) — nạp khung SGK vào khoá bằng chính cơ chế nạp khung
 * của K0a: giáo viên có course:update TẠI CONTEXT KHOÁ (mô hình seed
 * teacher1, không vai hệ thống) đọc được bề mặt chọn khung SGK qua
 * forCourseId, nạp các chủ đề thành section — mỗi mục bài truy về được
 * YCCĐ chương trình qua bản chụp neo kép. Học sinh đã ghi danh thấy
 * cấu trúc khoá bình thường (section + mục bài + YCCĐ) nhưng bị chặn ở
 * mọi bề mặt quản trị ánh xạ/SGK; giáo viên khoá khác bị chặn với khoá
 * không phải của mình. Oracle YCCĐ: dataset chương trình + dataset SGK
 * đã kiểm chứng (hợp YCCĐ của các node được ánh xạ, khử trùng theo thứ
 * tự ánh xạ) — cùng quy tắc với spec nạp SGK.
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

interface ProgramRecord { id: string; outcomes: (string | OutcomeDoc)[]; outcome_text: string }

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
function expectedLessonOutcomes(record: BookRecord): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of record.program_records) {
    const programRecord = programFile.records.find((r) => r.id === code);
    for (const text of outcomeTexts(programRecord!)) {
      if (!seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
  }
  return out;
}
/** Các bản ghi của một chủ đề theo thứ tự sách. */
function chapterRecords(chapter: string, volume: number): BookRecord[] {
  return bookFile.records.filter((r) => r.chapter === chapter && r.volume === volume);
}

interface BookTreeBody {
  chapters: {
    id: string; title: string; volume: number | null;
    lessons: { id: string; title: string; recordId: string | null }[];
  }[];
}
interface ContentSection {
  id: string; section: number; name: string | null;
  frame: unknown;
  bookFrame: {
    nodeId: string | null; bookId: string | null; nodeTitle: string;
    items: { nodeId: string | null; title: string; outcomes: { outcomeId: string | null; content: string }[] }[];
  } | null;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('K0b book frame (SGK chapters → course sections with dual anchors)', () => {
  let app: INestApplication;
  let admin: string;
  let systemCtxId: string;
  let subjectId: string;
  let bookId: string;
  let tree: BookTreeBody;
  let courseA: string;
  let courseB: string;
  let teacherA: string;
  let teacherB: string;
  let studentA: string;
  let studentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    systemCtxId = await systemContextId(app, admin);
    const impProgram = await http(app).post('/api/v1/curriculum/program-import').set(bearer(admin)).send({ datasetKey: 'toan' });
    expect(impProgram.status).toBe(201);
    const impBook = await http(app).post('/api/v1/books/dataset-import').set(bearer(admin)).send({ datasetKey: 'sgk-toan-1' });
    expect(impBook.status).toBe(201);
    bookId = (impBook.body as { bookId: string }).bookId;

    const subjects = await http(app).get(`/api/v1/curriculum/subjects?contextId=${systemCtxId}`).set(bearer(admin));
    subjectId = (subjects.body as { id: string; slug: string }[]).find((s) => s.slug === 'toan')!.id;
    const treeRes = await http(app).get(`/api/v1/books/${bookId}/tree`).set(bearer(admin));
    expect(treeRes.status).toBe(200);
    tree = treeRes.body as BookTreeBody;

    const category = await createCategory(app, admin);
    courseA = (await createCourse(app, admin, category.id, { subjectId, grade: 1 })).id;
    courseB = (await createCourse(app, admin, category.id, { subjectId, grade: 1 })).id;
    const editingTeacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    const ctxA = await courseContextId(app, admin, courseA);
    const ctxB = await courseContextId(app, admin, courseB);

    const userA = await createUserViaApi(app, admin);
    await assignRole(app, admin, userA.id, editingTeacherRole, ctxA);
    teacherA = (await login(app, userA.username, STRONG_PASSWORD)).accessToken;
    const userB = await createUserViaApi(app, admin);
    await assignRole(app, admin, userB.id, editingTeacherRole, ctxB);
    teacherB = (await login(app, userB.username, STRONG_PASSWORD)).accessToken;

    const userS = await createUserViaApi(app, admin);
    studentId = userS.id;
    studentA = (await login(app, userS.username, STRONG_PASSWORD)).accessToken;
    const instance = await createEnrolInstance(app, admin, courseA);
    await enrolUser(app, admin, courseA, instance.id, studentId);
  }, 300_000);
  afterAll(async () => { await app.close(); });

  it('course teacher reads the book picker surface for their own course via forCourseId, other-course teacher and student are denied', async () => {
    const books = await http(app).get(`/api/v1/books?subjectId=${subjectId}&forCourseId=${courseA}`).set(bearer(teacherA));
    expect(books.status).toBe(200);
    expect((books.body as { id: string }[]).some((b) => b.id === bookId)).toBe(true);
    const ownTree = await http(app).get(`/api/v1/books/${bookId}/tree?forCourseId=${courseA}`).set(bearer(teacherA));
    expect(ownTree.status).toBe(200);

    // Giáo viên khoá B đọc bề mặt SGK cho khoá A → 403.
    const otherTree = await http(app).get(`/api/v1/books/${bookId}/tree?forCourseId=${courseA}`).set(bearer(teacherB));
    expect(otherTree.status).toBe(403);
    // Học sinh: mọi bề mặt quản trị SGK/ánh xạ đều 403, kể cả kèm forCourseId của khoá mình học.
    const studentBooks = await http(app).get(`/api/v1/books?subjectId=${subjectId}&forCourseId=${courseA}`).set(bearer(studentA));
    expect(studentBooks.status).toBe(403);
    const studentTree = await http(app).get(`/api/v1/books/${bookId}/tree`).set(bearer(studentA));
    expect(studentTree.status).toBe(403);
    const studentImport = await http(app).post('/api/v1/books/dataset-import').set(bearer(studentA)).send({ datasetKey: 'sgk-toan-1' });
    expect(studentImport.status).toBe(403);
  });

  it('teacher applies two chapters: sections carry items whose captured outcomes match the mapped programme outcomes', async () => {
    const chapter1 = tree.chapters.find((c) => c.title === 'Các số từ 0 đến 10')!;
    const chapter3 = tree.chapters.find((c) => c.title === 'Phép cộng, phép trừ trong phạm vi 10')!;
    expect(chapter1).toBeTruthy();
    expect(chapter3).toBeTruthy();

    // Học sinh không nạp được khung; giáo viên khoá khác cũng không.
    const byStudent = await http(app).post(`/api/v1/courses/${courseA}/book-frame`).set(bearer(studentA))
      .send({ bookId, chapterNodeIds: [chapter1.id] });
    expect(byStudent.status).toBe(403);
    const byOther = await http(app).post(`/api/v1/courses/${courseA}/book-frame`).set(bearer(teacherB))
      .send({ bookId, chapterNodeIds: [chapter1.id] });
    expect(byOther.status).toBe(403);
    // Node bài (không phải chủ đề) không phải đơn vị chọn được → 400.
    const lessonId = chapter1.lessons[0]!.id;
    const badUnit = await http(app).post(`/api/v1/courses/${courseA}/book-frame`).set(bearer(teacherA))
      .send({ bookId, chapterNodeIds: [lessonId] });
    expect(badUnit.status).toBe(400);
    expect(badUnit.body.code).toBe('course.book_chapter_not_selectable');

    const applied = await http(app).post(`/api/v1/courses/${courseA}/book-frame`).set(bearer(teacherA))
      .send({ bookId, chapterNodeIds: [chapter1.id, chapter3.id] });
    expect(applied.status).toBe(201);
    const created = applied.body as { id: string; name: string; bookFrame: ContentSection['bookFrame'] }[];
    expect(created.length).toBe(2);
    expect(created.map((s) => s.name)).toEqual([chapter1.title, chapter3.title]);

    // Đối chiếu từng section qua nội dung khoá (đọc từ bản chụp neo).
    const content = await http(app).get(`/api/v1/courses/${courseA}/content`).set(bearer(teacherA));
    expect(content.status).toBe(200);
    const sections = (content.body as { sections: ContentSection[] }).sections
      .filter((s) => s.bookFrame !== null);
    expect(sections.length).toBe(2);
    for (const chapter of [chapter1, chapter3]) {
      const section = sections.find((s) => s.bookFrame!.nodeId === chapter.id);
      expect(section, `section for chapter ${chapter.title}`).toBeTruthy();
      expect(section!.bookFrame!.bookId).toBe(bookId);
      expect(section!.bookFrame!.nodeTitle).toBe(chapter.title);
      expect(section!.frame).toBeNull();
      const expected = chapterRecords(chapter.title, chapter.volume ?? 1);
      expect(section!.bookFrame!.items.length).toBe(expected.length);
      section!.bookFrame!.items.forEach((item, i) => {
        const record = expected[i]!;
        expect(item.title, `${record.id} item title`).toBe(record.lesson);
        expect(item.nodeId, `${record.id} item anchor`).toBe(chapter.lessons.find((l) => l.recordId === record.id)?.id);
        expect(item.outcomes.map((o) => o.content), `${record.id} captured outcomes`)
          .toEqual(expectedLessonOutcomes(record));
        for (const o of item.outcomes) expect(o.outcomeId).toBeTruthy();
      });
    }
  }, 120_000);

  it('enrolled student sees the applied structure as ordinary course content', async () => {
    const content = await http(app).get(`/api/v1/courses/${courseA}/content`).set(bearer(studentA));
    expect(content.status).toBe(200);
    const sections = (content.body as { sections: ContentSection[] }).sections
      .filter((s) => s.bookFrame !== null);
    expect(sections.length).toBe(2);
    const first = sections.find((s) => s.name === 'Các số từ 0 đến 10');
    expect(first).toBeTruthy();
    expect(first!.bookFrame!.items.map((i) => i.title)).toContain('Các số 0, 1, 2, 3, 4, 5');
    // Mục bài truy được về YCCĐ ngay trong nội dung học sinh thấy.
    const bai1 = first!.bookFrame!.items.find((i) => i.title === 'Các số 0, 1, 2, 3, 4, 5');
    expect(bai1!.outcomes.length).toBeGreaterThan(0);
  });
});
