import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { setGrade } from './assessment-helpers';

/**
 * Issue #180 — học sinh xem ĐTB của CHÍNH MÌNH qua cổng công bố PH-0.
 * Endpoint `GET /courses/:courseId/grades/vn-results/mine`: server tự
 * duyệt sổ VN của khoá (danh sách sổ gác grade:viewall nên HS không tự
 * khám phá bookId được) và chỉ trả dữ liệu qua đúng cổng công bố như bề
 * mặt phụ huynh: kỳ/năm chưa công bố thì published=false, bookId và mọi
 * trường điểm/nhận xét đều null. Đã công bố thì cùng nguồn với phụ huynh
 * (bản chốt mới nhất; thiếu bản chốt thì tính trực tiếp sau cổng).
 */
describe('Issue #180: kết quả VN của chính học sinh qua cổng công bố', () => {
  let app: INestApplication;
  let admin: string;
  let catId: string;

  interface BookItem { id: string; vnRole: string | null }
  interface BookView { book: { id: string; courseId: string }; items: BookItem[] }
  interface MyTerm { bookId: string | null; term: string; published: boolean; dtbHk: number | null; commentResult: string | null; comment: string | null; awaitingMakeup: boolean }
  interface MyResults { courseId: string; terms: MyTerm[]; year: { published: boolean; dtbYear: number | null; comment: string | null } | null; levels: { hk1: string | null; hk2: string | null; year: string | null } }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    catId = (await createCategory(app, admin)).id;
  }, 120000);
  afterAll(async () => { await app.close(); });

  /** Khoá mới + các học sinh ghi danh + một giáo viên editingteacher tại context khoá. */
  async function courseWithPeople(studentCount = 1) {
    const course = await createCourse(app, admin, catId);
    const instance = await createEnrolInstance(app, admin, course.id);
    const students: { id: string; token: string }[] = [];
    for (let i = 0; i < studentCount; i += 1) {
      const u = await createUserViaApi(app, admin);
      await enrolUser(app, admin, course.id, instance.id, u.id);
      students.push({ id: u.id, token: (await login(app, u.username, STRONG_PASSWORD)).accessToken });
    }
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;
    return { course, students, teacher };
  }

  const mineUrl = (courseId: string) => `/api/v1/courses/${courseId}/grades/vn-results/mine`;

  async function getMine(token: string, courseId: string) {
    const res = await http(app).get(mineUrl(courseId)).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as MyResults;
  }

  /** Mở sổ VN một kỳ + điền điểm cho một học sinh + chốt (chưa công bố). */
  async function bookWithGrades(courseId: string, term: string, userId: string, values: number[]) {
    const res = await http(app).post(`/api/v1/courses/${courseId}/grades/vn-books`)
      .set('Authorization', `Bearer ${admin}`).send({ term, subjectPeriodsPerYear: 35 });
    expect(res.status).toBe(201);
    const view = res.body as BookView;
    for (let i = 0; i < values.length; i += 1) await setGrade(app, admin, view.items[i]!.id, userId, values[i]!);
    const fin = await http(app).post(`/api/v1/courses/${courseId}/grades/vn-books/${view.book.id}/results/${userId}/finalize`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(fin.status).toBe(201);
    return view;
  }

  async function publishTerm(courseId: string, bookId: string, userId: string, action: 'publish' | 'unpublish' = 'publish') {
    const res = await http(app).post(`/api/v1/courses/${courseId}/grades/vn-books/${bookId}/results/${userId}/${action}`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(res.status).toBe(201);
  }

  it('chưa công bố: /mine null hoá bookId + mọi điểm/nhận xét; đường khám phá sổ vẫn gác staff', async () => {
    const { course, students } = await courseWithPeople();
    const student = students[0]!;
    const hk1 = await bookWithGrades(course.id, 'hk1', student.id, [8, 9, 7, 8]); // ĐTBmhk 7,9 sau chốt
    const hk2 = await bookWithGrades(course.id, 'hk2', student.id, [9, 9, 9, 9]);
    const yearFin = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}/finalize`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(yearFin.status).toBe(201);

    const mine = await getMine(student.token, course.id);
    expect(mine.terms).toHaveLength(2);
    for (const term of mine.terms) {
      expect(term.published).toBe(false);
      expect(term.bookId).toBeNull();
      expect(term.dtbHk).toBeNull();
      expect(term.commentResult).toBeNull();
      expect(term.comment).toBeNull();
      expect(term.awaitingMakeup).toBe(false);
    }
    expect(mine.year).toEqual({ published: false, dtbYear: null, comment: null });

    // Không một định danh sổ hay con điểm nào rò qua thân phản hồi.
    const raw = JSON.stringify(mine);
    expect(raw).not.toContain(hk1.book.id);
    expect(raw).not.toContain(hk2.book.id);
    expect(raw).not.toContain('7.9');

    // Học sinh vẫn không tự khám phá được sổ: danh sách sổ gác grade:viewall.
    const list = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-books`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(list.status).toBe(403);
    const one = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-books/${hk1.book.id}`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(one.status).toBe(403);
  }, 120000);

  it('đã công bố: HS xem được ĐTB của mình và khớp số với bề mặt phụ huynh + bề mặt theo-HS', async () => {
    const { course, students, teacher } = await courseWithPeople();
    const student = students[0]!;
    const hk1 = await bookWithGrades(course.id, 'hk1', student.id, [8, 9, 7, 8]); // ĐTBmhk 7,9
    await bookWithGrades(course.id, 'hk2', student.id, [9, 9, 9, 9]); // ĐTBmhk 9,0
    const yearFin = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}/finalize`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(yearFin.status).toBe(201);

    await publishTerm(course.id, hk1.book.id, student.id);
    const pubYear = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}/publish`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(pubYear.status).toBe(201);

    const mine = await getMine(student.token, course.id);
    const mineHk1 = mine.terms.find((t) => t.term === 'hk1')!;
    expect(mineHk1.published).toBe(true);
    expect(mineHk1.bookId).toBe(hk1.book.id);
    expect(mineHk1.dtbHk).toBe(7.9);
    const mineHk2 = mine.terms.find((t) => t.term === 'hk2')!;
    expect(mineHk2.published).toBe(false);
    expect(mineHk2.dtbHk).toBeNull();
    expect(mine.year).toEqual({ published: true, dtbYear: 8.6, comment: null });

    // Đối chiếu bề mặt phụ huynh (liên kết do GV của khoá xác lập): cùng một ĐTB.
    const guardian = await createUserViaApi(app, admin);
    const guardianToken = (await login(app, guardian.username, STRONG_PASSWORD)).accessToken;
    const link = await http(app).post('/api/v1/guardian-links').set('Authorization', `Bearer ${teacher}`)
      .send({ guardianUserId: guardian.id, studentUserId: student.id, relationship: 'Cha' });
    expect(link.status).toBe(201);
    const gVn = await http(app).get(`/api/v1/guardian/students/${student.id}/courses/${course.id}/vn-books/${hk1.book.id}/results`)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(gVn.status).toBe(200);
    expect(gVn.body.dtbHk).toBe(mineHk1.dtbHk);

    // Đối chiếu bề mặt theo-HS sẵn có cho kết quả năm: cùng một ĐTB năm.
    const ownYear = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}`)
      .set('Authorization', `Bearer ${student.token}`);
    expect(ownYear.status).toBe(200);
    expect(ownYear.body.dtbYear).toBe(mine.year?.dtbYear);

    // Rút công bố kì → /mine mất điểm lại ngay (cổng sống, không cache).
    await publishTerm(course.id, hk1.book.id, student.id, 'unpublish');
    const after = await getMine(student.token, course.id);
    const afterHk1 = after.terms.find((t) => t.term === 'hk1')!;
    expect(afterHk1.published).toBe(false);
    expect(afterHk1.bookId).toBeNull();
    expect(afterHk1.dtbHk).toBeNull();
  }, 120000);

  it('mỗi học sinh chỉ thấy kết quả của mình; người ngoài khoá bị chặn ở cổng truy cập khoá', async () => {
    const { course, students } = await courseWithPeople(2);
    const [a, b] = students as [{ id: string; token: string }, { id: string; token: string }];
    const res = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books`)
      .set('Authorization', `Bearer ${admin}`).send({ term: 'hk1', subjectPeriodsPerYear: 35 });
    expect(res.status).toBe(201);
    const view = res.body as BookView;
    const fillFor = async (userId: string, values: number[]) => {
      for (let i = 0; i < values.length; i += 1) await setGrade(app, admin, view.items[i]!.id, userId, values[i]!);
      const fin = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${view.book.id}/results/${userId}/finalize`)
        .set('Authorization', `Bearer ${admin}`).send({});
      expect(fin.status).toBe(201);
      await publishTerm(course.id, view.book.id, userId);
    };
    await fillFor(a.id, [8, 9, 7, 8]); // ĐTBmhk 7,9
    await fillFor(b.id, [10, 10, 10, 10]); // ĐTBmhk 10

    const mineA = await getMine(a.token, course.id);
    expect(mineA.terms.find((t) => t.term === 'hk1')?.dtbHk).toBe(7.9);
    const mineB = await getMine(b.token, course.id);
    expect(mineB.terms.find((t) => t.term === 'hk1')?.dtbHk).toBe(10);

    // Người không ghi danh: /mine bị chặn 403 ở cổng truy cập khoá.
    const outsider = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    const blocked = await http(app).get(mineUrl(course.id)).set('Authorization', `Bearer ${outsiderToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('course.not_enrolled');
  }, 120000);

  it('khoá chưa có sổ VN nào: terms rỗng, year null, vẫn 200', async () => {
    const { course, students } = await courseWithPeople();
    const mine = await getMine(students[0]!.token, course.id);
    expect(mine.terms).toEqual([]);
    expect(mine.year).toBeNull();
  }, 120000);
});
