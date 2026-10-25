import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { setGrade } from './assessment-helpers';

/**
 * Sổ điểm VN — chốt cả lớp nguyên tử + lưới GV + cờ lệch nguồn (issue #183).
 * Oracle: nguyên văn TT 22/2021/TT-BGDĐT — chốt sổ bị chặn khi còn học sinh
 * chờ kiểm tra bù (Điều 7.4); ĐTBmhk = (TĐĐGtx + 2×ĐĐGgk + 3×ĐĐGck)/(số ĐĐGtx + 5),
 * làm tròn 1 chữ số thập phân (Điều 9). Số kỳ vọng tính tay, không suy từ code.
 */
describe('Sổ điểm VN: chốt cả lớp + lưới + lệch nguồn (#183)', () => {
  let app: INestApplication;
  let admin: string;
  let catId: string;

  interface VnItem { id: string; itemName: string; vnRole: string | null; vnOrdinal: number | null }
  interface VnBookView { book: { id: string; courseId: string; term: string; assessmentMode: string }; items: VnItem[] }
  interface GridRow { userId: string; computation: { dtbHk: number | null; complete: boolean } | null; snapshot: { dtbHk: number | null } | null; sourceDiverged: boolean }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    catId = (await createCategory(app, admin)).id;
  });
  afterAll(async () => { await app.close(); });

  async function newCourseWithStudents(count: number) {
    const course = await createCourse(app, admin, catId);
    const instance = await createEnrolInstance(app, admin, course.id);
    const students: { id: string }[] = [];
    for (let i = 0; i < count; i += 1) {
      const student = await createUserViaApi(app, admin);
      await enrolUser(app, admin, course.id, instance.id, student.id);
      students.push(student);
    }
    return { course, students };
  }

  async function createBook(courseId: string): Promise<VnBookView> {
    const res = await http(app).post(`/api/v1/courses/${courseId}/grades/vn-books`)
      .set('Authorization', `Bearer ${admin}`).send({ term: 'hk1', subjectPeriodsPerYear: 35 });
    expect(res.status).toBe(201);
    return res.body as VnBookView;
  }

  function columnOf(book: VnBookView, role: string, ordinal?: number): VnItem {
    const item = book.items.find((i) => i.vnRole === role && (ordinal === undefined || i.vnOrdinal === ordinal));
    if (!item) throw new Error(`missing column ${role}/${ordinal}`);
    return item;
  }

  /** Điền đủ 4 cột (quota 35 tiết: 2 ĐĐGtx + giữa kì + cuối kì) cho một học sinh. */
  async function fillAll(book: VnBookView, userId: string, tx: [number, number], gk: number, ck: number) {
    await setGrade(app, admin, columnOf(book, 'dgtx', 1).id, userId, tx[0]);
    await setGrade(app, admin, columnOf(book, 'dgtx', 2).id, userId, tx[1]);
    await setGrade(app, admin, columnOf(book, 'dggk').id, userId, gk);
    await setGrade(app, admin, columnOf(book, 'dgck').id, userId, ck);
  }

  function finalizeAll(courseId: string, bookId: string) {
    return http(app).post(`/api/v1/courses/${courseId}/grades/vn-books/${bookId}/finalize-all`)
      .set('Authorization', `Bearer ${admin}`).send({});
  }

  async function grid(courseId: string, bookId: string): Promise<{ students: GridRow[] }> {
    const res = await http(app).get(`/api/v1/courses/${courseId}/grades/vn-books/${bookId}/grid`)
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    return res.body as { students: GridRow[] };
  }

  async function snapshots(courseId: string, bookId: string, userId: string): Promise<unknown[]> {
    const res = await http(app).get(`/api/v1/courses/${courseId}/grades/vn-books/${bookId}/results/${userId}/snapshots`)
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    return res.body as unknown[];
  }

  it('chốt cả lớp một lượt: mọi học sinh có bản chốt trong cùng lượt, ĐTBmhk khớp công thức Điều 9 tính tay', async () => {
    const { course, students } = await newCourseWithStudents(2);
    const [a, b] = students as [{ id: string }, { id: string }];
    const book = await createBook(course.id);
    // A: (8+9 + 2×7 + 3×9)/7 = 58/7 = 8,2857… → 8,3. B: (6+7 + 2×8 + 3×6)/7 = 47/7 = 6,714… → 6,7.
    await fillAll(book, a.id, [8, 9], 7, 9);
    await fillAll(book, b.id, [6, 7], 8, 6);

    const res = await finalizeAll(course.id, book.book.id);
    expect(res.status).toBe(201);
    expect(res.body.finalizedCount).toBe(2);
    const byUser = new Map((res.body.results as { userId: string; dtbHk: number }[]).map((r) => [r.userId, r.dtbHk]));
    expect(byUser.get(a.id)).toBe(8.3);
    expect(byUser.get(b.id)).toBe(6.7);

    const g = await grid(course.id, book.book.id);
    expect(g.students).toHaveLength(2);
    for (const row of g.students) {
      expect(row.snapshot?.dtbHk).toBe(byUser.get(row.userId));
      expect(row.sourceDiverged).toBe(false);
    }
  }, 90000);

  it('có học sinh chờ kiểm tra bù (Điều 7.4): cả lượt bị chặn, nêu đúng học sinh bị chặn, KHÔNG bản chốt nào được ghi', async () => {
    const { course, students } = await newCourseWithStudents(2);
    const [ready, waiting] = students as [{ id: string }, { id: string }];
    const book = await createBook(course.id);
    await fillAll(book, ready.id, [9, 9], 9, 9);
    // Học sinh chờ bù: đủ cột trừ giữa kì, cột giữa kì đánh dấu chờ kiểm tra bù.
    await setGrade(app, admin, columnOf(book, 'dgtx', 1).id, waiting.id, 8);
    await setGrade(app, admin, columnOf(book, 'dgtx', 2).id, waiting.id, 8);
    await setGrade(app, admin, columnOf(book, 'dgck').id, waiting.id, 8);
    const makeup = await http(app)
      .post(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/columns/${columnOf(book, 'dggk').id}/students/${waiting.id}/makeup-status`)
      .set('Authorization', `Bearer ${admin}`).send({ state: 'awaiting_makeup' });
    expect(makeup.status).toBe(201);

    const res = await finalizeAll(course.id, book.book.id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('grades.vn_finalize_book_blocked');
    expect(res.body.blockedStudents).toEqual([
      { userId: waiting.id, reason: 'awaiting_makeup', roles: ['dggk'] },
    ]);
    // Nguyên tử: học sinh đã sẵn sàng cũng không có bản chốt nào.
    expect(await snapshots(course.id, book.book.id, ready.id)).toHaveLength(0);
    expect(await snapshots(course.id, book.book.id, waiting.id)).toHaveLength(0);
  }, 90000);

  it('sửa cột sau khi đã chốt: lưới báo lệch nguồn cho đúng học sinh đã sửa, học sinh còn lại không lệch', async () => {
    const { course, students } = await newCourseWithStudents(2);
    const [edited, untouched] = students as [{ id: string }, { id: string }];
    const book = await createBook(course.id);
    await fillAll(book, edited.id, [8, 9], 7, 9);
    await fillAll(book, untouched.id, [6, 7], 8, 6);
    const fin = await finalizeAll(course.id, book.book.id);
    expect(fin.status).toBe(201);

    // Sửa điểm cuối kì của một học sinh sau khi chốt → bản chốt lệch nguồn.
    await setGrade(app, admin, columnOf(book, 'dgck').id, edited.id, 4);

    const g = await grid(course.id, book.book.id);
    const rowEdited = g.students.find((s) => s.userId === edited.id);
    const rowUntouched = g.students.find((s) => s.userId === untouched.id);
    expect(rowEdited?.sourceDiverged).toBe(true);
    // ĐTB tính lại theo điểm mới: (8+9 + 2×7 + 3×4)/7 = 43/7 = 6,142… → 6,1; bản chốt vẫn giữ 8,3 cũ.
    expect(rowEdited?.computation?.dtbHk).toBe(6.1);
    expect(rowEdited?.snapshot?.dtbHk).toBe(8.3);
    expect(rowUntouched?.sourceDiverged).toBe(false);
  }, 90000);
});
