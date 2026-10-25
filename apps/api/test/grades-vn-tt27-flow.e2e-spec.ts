import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';

/**
 * GB-VN-3 (issue #213): regime TT 27 cho tiểu học + luồng môn chỉ-nhận-xét
 * đầy đủ. Oracle: nguyên văn TT 27/2020/TT-BGDĐT (hồ sơ
 * vn-gradebook-scoring-research-2026-10-24.md) — Điều 7.1a: kết quả môn là
 * MỨC tổng hợp Hoàn thành tốt / Hoàn thành / Chưa hoàn thành do giáo viên
 * chốt; không cột điểm thường xuyên, không công thức trung bình.
 */
describe('Sổ điểm VN TT 27 + lưới môn nhận xét (GB-VN-3, issue #213)', () => {
  let app: INestApplication;
  let admin: string;
  let catId: string;

  interface VnBookView {
    book: { id: string; courseId: string; term: string; regime: string; assessmentMode: string };
    items: unknown[];
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    catId = (await createCategory(app, admin)).id;
  });
  afterAll(async () => { await app.close(); });

  async function newCourse(studentCount = 1) {
    const course = await createCourse(app, admin, catId);
    const instance = await createEnrolInstance(app, admin, course.id);
    const students: { id: string; username: string }[] = [];
    for (let i = 0; i < studentCount; i += 1) {
      const student = await createUserViaApi(app, admin);
      await enrolUser(app, admin, course.id, instance.id, student.id);
      students.push(student);
    }
    return { course, students };
  }

  async function createBook(courseId: string, body: Record<string, unknown>): Promise<{ status: number; body: VnBookView & { code?: string } }> {
    const res = await http(app).post(`/api/v1/courses/${courseId}/grades/vn-books`).set('Authorization', `Bearer ${admin}`).send(body);
    return { status: res.status, body: res.body as VnBookView & { code?: string } };
  }

  function batch(courseId: string, bookId: string, body: Record<string, unknown>) {
    return http(app).post(`/api/v1/courses/${courseId}/grades/vn-books/${bookId}/comment-results/batch`)
      .set('Authorization', `Bearer ${admin}`).send(body);
  }

  it('mở được sổ tt27 cho khoá tiểu học: regime tt27, chế độ nhận xét, không sinh cột điểm', async () => {
    const { course } = await newCourse();
    const { status, body } = await createBook(course.id, { term: 'hk1', regime: 'tt27' });
    expect(status).toBe(201);
    expect(body.book.regime).toBe('tt27');
    expect(body.book.assessmentMode).toBe('comment');
    expect(body.items.length).toBe(0);

    // tt27 không có chế độ điểm số (không cột điểm thường xuyên ở tiểu học).
    const { course: course2 } = await newCourse();
    const scoreMode = await createBook(course2.id, { term: 'hk1', regime: 'tt27', assessmentMode: 'score', subjectPeriodsPerYear: 70 });
    expect(scoreMode.status).toBe(400);
    expect(scoreMode.body.code).toBe('grades.vn_tt27_score_mode_unsupported');

    // Regime chưa mở vẫn bị từ chối tường minh như trước.
    const free = await createBook(course2.id, { term: 'hk2', regime: 'free' });
    expect(free.status).toBe(400);
    expect(free.body.code).toBe('grades.vn_regime_unsupported');
  }, 60000);

  it('nhập mức lưới 30 học sinh (mặc định + ngoại lệ) lưu đúng từng học sinh trong một lượt', async () => {
    const { course, students } = await newCourse(30);
    const book = (await createBook(course.id, { term: 'hk1', regime: 'tt27' })).body;
    const s1 = students[0]!;
    const s2 = students[1]!;
    const s3 = students[2]!;

    const res = await batch(course.id, book.book.id, {
      defaultResult: 'Hoàn thành',
      overrides: [
        { userId: s1.id, result: 'Hoàn thành tốt' },
        { userId: s2.id, result: 'Chưa hoàn thành' },
        { userId: s3.id, result: 'Hoàn thành tốt', comment: 'Tiến bộ rõ rệt' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.savedCount).toBe(30);

    const grid = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/grid`)
      .set('Authorization', `Bearer ${admin}`);
    expect(grid.status).toBe(200);
    const byUser = new Map((grid.body.students as { userId: string; snapshot: { commentResult: string | null; comment: string | null } | null }[])
      .map((row) => [row.userId, row.snapshot]));
    expect(byUser.size).toBe(30);
    expect(byUser.get(s1.id)?.commentResult).toBe('Hoàn thành tốt');
    expect(byUser.get(s2.id)?.commentResult).toBe('Chưa hoàn thành');
    expect(byUser.get(s3.id)?.commentResult).toBe('Hoàn thành tốt');
    expect(byUser.get(s3.id)?.comment).toBe('Tiến bộ rõ rệt');
    for (const student of students.slice(3)) {
      expect(byUser.get(student.id)?.commentResult).toBe('Hoàn thành');
    }
  }, 180000);

  it('từ chối giá trị mức thuộc regime khác và học sinh ngoài ghi danh, không ghi dòng nào', async () => {
    const { course, students } = await newCourse(2);
    const book = (await createBook(course.id, { term: 'hk1', regime: 'tt27' })).body;
    const outsider = await createUserViaApi(app, admin);

    // 'Đạt' là mức của TT 22 — không hợp lệ trong sổ tt27.
    const wrongRegime = await batch(course.id, book.book.id, { defaultResult: 'Đạt' });
    expect(wrongRegime.status).toBe(400);
    expect(wrongRegime.body.code).toBe('grades.vn_comment_result_invalid');

    const wrongOverride = await batch(course.id, book.book.id, {
      defaultResult: 'Hoàn thành',
      overrides: [{ userId: students[0]!.id, result: 'Chưa đạt' }],
    });
    expect(wrongOverride.status).toBe(400);
    expect(wrongOverride.body.code).toBe('grades.vn_comment_result_invalid');

    const notEnrolled = await batch(course.id, book.book.id, {
      overrides: [{ userId: outsider.id, result: 'Hoàn thành' }],
    });
    expect(notEnrolled.status).toBe(400);
    expect(notEnrolled.body.code).toBe('grades.vn_comment_student_not_enrolled');

    // Đường ghi lẻ cũng đối chiếu regime.
    const single = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/results/${students[0]!.id}/comment-result`)
      .set('Authorization', `Bearer ${admin}`).send({ result: 'Đạt' });
    expect(single.status).toBe(400);
    expect(single.body.code).toBe('grades.vn_comment_result_invalid');

    // Không lượt nào ở trên được ghi dòng: lưới vẫn trống mức.
    const grid = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/grid`)
      .set('Authorization', `Bearer ${admin}`);
    for (const row of grid.body.students as { snapshot: unknown }[]) expect(row.snapshot).toBeNull();
  }, 90000);

  it('chốt cả lớp bị chặn khi còn học sinh chưa nhập mức; đủ mức thì chốt được', async () => {
    const { course, students } = await newCourse(3);
    const book = (await createBook(course.id, { term: 'hk1', regime: 'tt27' })).body;
    await batch(course.id, book.book.id, {
      overrides: [
        { userId: students[0]!.id, result: 'Hoàn thành' },
        { userId: students[1]!.id, result: 'Hoàn thành tốt' },
      ],
    });
    const blockedRes = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/finalize-all`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(blockedRes.status).toBe(400);
    expect(blockedRes.body.code).toBe('grades.vn_finalize_book_blocked');
    expect(blockedRes.body.blockedStudents).toEqual([
      { userId: students[2]!.id, reason: 'incomplete', roles: ['commentResult'] },
    ]);

    await batch(course.id, book.book.id, { overrides: [{ userId: students[2]!.id, result: 'Hoàn thành' }] });
    const okRes = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/finalize-all`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(okRes.status).toBe(201);
    expect(okRes.body.finalizedCount).toBe(3);
  }, 90000);

  it('công bố qua cùng cổng PH-0: học sinh chỉ thấy mức của mình sau khi công bố', async () => {
    const { course, students } = await newCourse(2);
    const book = (await createBook(course.id, { term: 'hk1', regime: 'tt27' })).body;
    const publishedStudent = students[0]!;
    const hiddenStudent = students[1]!;
    await batch(course.id, book.book.id, {
      defaultResult: 'Hoàn thành',
      overrides: [{ userId: publishedStudent.id, result: 'Hoàn thành tốt' }],
    });
    await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/finalize-all`)
      .set('Authorization', `Bearer ${admin}`).send({});
    await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/results/${publishedStudent.id}/publish`)
      .set('Authorization', `Bearer ${admin}`).send({});

    const publishedLogin = await login(app, publishedStudent.username, STRONG_PASSWORD);
    const minePublished = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-results/mine`)
      .set('Authorization', `Bearer ${publishedLogin.accessToken}`);
    expect(minePublished.status).toBe(200);
    const termPublished = (minePublished.body.terms as { published: boolean; commentResult: string | null }[])[0]!;
    expect(termPublished.published).toBe(true);
    expect(termPublished.commentResult).toBe('Hoàn thành tốt');

    const hiddenLogin = await login(app, hiddenStudent.username, STRONG_PASSWORD);
    const mineHidden = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-results/mine`)
      .set('Authorization', `Bearer ${hiddenLogin.accessToken}`);
    expect(mineHidden.status).toBe(200);
    const termHidden = (mineHidden.body.terms as { published: boolean; commentResult: string | null; bookId: string | null }[])[0]!;
    expect(termHidden.published).toBe(false);
    expect(termHidden.commentResult).toBeNull();
    expect(termHidden.bookId).toBeNull();
  }, 90000);

  it('kết quả năm của môn nhận xét chốt từ mức HK II vào cùng bản chốt năm và công bố cùng cổng vn_year', async () => {
    const { course, students } = await newCourse(1);
    const student = students[0]!;
    const hk1 = (await createBook(course.id, { term: 'hk1', regime: 'tt27' })).body;
    const hk2 = (await createBook(course.id, { term: 'hk2', regime: 'tt27' })).body;
    await batch(course.id, hk1.book.id, { defaultResult: 'Hoàn thành' });
    await batch(course.id, hk2.book.id, { defaultResult: 'Hoàn thành tốt' });

    const finalizeYear = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}/finalize`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(finalizeYear.status).toBe(201);
    expect(finalizeYear.body.scope).toBe('year');
    expect(finalizeYear.body.commentResult).toBe('Hoàn thành tốt');
    expect(finalizeYear.body.dtbYear).toBeNull();

    // Chưa công bố năm: chính chủ đọc bản chốt năm bị chặn bởi cổng công bố.
    const studentLogin = await login(app, student.username, STRONG_PASSWORD);
    const beforePublish = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}`)
      .set('Authorization', `Bearer ${studentLogin.accessToken}`);
    expect(beforePublish.status).toBe(403);
    expect(beforePublish.body.code).toBe('grades.vn_result_not_published');

    await http(app).post(`/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}/publish`)
      .set('Authorization', `Bearer ${admin}`).send({});
    const mine = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-results/mine`)
      .set('Authorization', `Bearer ${studentLogin.accessToken}`);
    expect(mine.body.year.published).toBe(true);
    expect(mine.body.year.commentResult).toBe('Hoàn thành tốt');
  }, 90000);

  it('sổ nhận xét TT 22 giữ nguyên tập Đạt/Chưa đạt và bị từ chối mức TT 27', async () => {
    const { course, students } = await newCourse(1);
    const book = (await createBook(course.id, { term: 'hk1', assessmentMode: 'comment' })).body;
    expect(book.book.regime).toBe('tt22');
    const okRes = await batch(course.id, book.book.id, { defaultResult: 'Đạt' });
    expect(okRes.status).toBe(201);
    expect(okRes.body.savedCount).toBe(1);
    const wrong = await batch(course.id, book.book.id, { defaultResult: 'Hoàn thành' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('grades.vn_comment_result_invalid');
    expect(students.length).toBe(1);
  }, 60000);
});
