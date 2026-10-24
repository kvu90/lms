import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { getGradebook, setGrade } from './assessment-helpers';

/**
 * Sổ điểm TT 22 cho môn điểm số (GB-VN-1, issue #95). Oracle: nguyên văn
 * TT 22/2021/TT-BGDĐT — quota cột Điều 6.2b, cấu trúc kì Điều 7.3, công thức
 * và xếp mức Điều 9 (số kỳ vọng tính tay trong từng test, không suy từ code).
 */
describe('Sổ điểm VN TT 22 (GB-VN-1, issue #95)', () => {
  let app: INestApplication;
  let admin: string;
  let catId: string;

  interface VnItem { id: string; itemName: string; vnRole: string | null; vnOrdinal: number | null; aggregationCoef: number; gradeMax: number }
  interface VnBookView { book: { id: string; courseId: string; term: string; assessmentMode: string; dgtxQuota: number; categoryId: string | null; subjectPeriodsPerYear: number | null }; items: VnItem[] }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    catId = (await createCategory(app, admin)).id;
  });
  afterAll(async () => { await app.close(); });

  async function newCourseWithStudent() {
    const course = await createCourse(app, admin, catId);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    return { course, student };
  }

  async function createBook(courseId: string, body: Record<string, unknown>): Promise<{ status: number; body: VnBookView & { code?: string } }> {
    const res = await http(app).post(`/api/v1/courses/${courseId}/grades/vn-books`).set('Authorization', `Bearer ${admin}`).send(body);
    return { status: res.status, body: res.body as VnBookView & { code?: string } };
  }

  async function finalize(courseId: string, bookId: string, userId: string) {
    return http(app).post(`/api/v1/courses/${courseId}/grades/vn-books/${bookId}/results/${userId}/finalize`)
      .set('Authorization', `Bearer ${admin}`).send({});
  }

  /** Nhập điểm cho mọi cột của sổ theo thứ tự items (ĐĐGtx… rồi gk, ck). */
  async function fillGrades(view: VnBookView, userId: string, values: number[]) {
    expect(view.items.length).toBe(values.length);
    for (let i = 0; i < values.length; i += 1) {
      await setGrade(app, admin, view.items[i]!.id, userId, values[i]!);
    }
  }

  it('sinh cấu trúc cột đúng quota ở cả 3 mức số tiết (Điều 6.2b + 7.3)', async () => {
    const cases = [
      { periods: 35, quota: 2 },
      { periods: 70, quota: 3 },
      { periods: 105, quota: 4 },
    ];
    for (const c of cases) {
      const { course } = await newCourseWithStudent();
      const { status, body } = await createBook(course.id, { term: 'hk1', subjectPeriodsPerYear: c.periods });
      expect(status).toBe(201);
      expect(body.book.dgtxQuota).toBe(c.quota);
      expect(body.book.subjectPeriodsPerYear).toBe(c.periods);
      expect(body.book.assessmentMode).toBe('score');
      expect(body.items.length).toBe(c.quota + 2);
      const tx = body.items.filter((i) => i.vnRole === 'dgtx');
      const gk = body.items.filter((i) => i.vnRole === 'dggk');
      const ck = body.items.filter((i) => i.vnRole === 'dgck');
      expect(tx.map((i) => i.vnOrdinal)).toEqual(Array.from({ length: c.quota }, (_, k) => k + 1));
      expect(gk.length).toBe(1);
      expect(ck.length).toBe(1);
      // Hệ số Điều 9: ĐGtx 1, giữa kì 2, cuối kì 3; mọi cột thang 10.
      expect(tx.every((i) => i.aggregationCoef === 1 && i.gradeMax === 10)).toBe(true);
      expect(gk[0]!.aggregationCoef).toBe(2);
      expect(ck[0]!.aggregationCoef).toBe(3);
      // Category của sổ là weightedmean.
      const cats = await http(app).get(`/api/v1/courses/${course.id}/grades/categories`).set('Authorization', `Bearer ${admin}`);
      const vnCat = (cats.body as { id: string; aggregation: string }[]).find((x) => x.id === body.book.categoryId);
      expect(vnCat?.aggregation).toBe('weightedmean');
    }
  }, 90000);

  it('mở trùng sổ cùng kì bị từ chối; môn điểm số thiếu số tiết cũng bị từ chối', async () => {
    const { course } = await newCourseWithStudent();
    const first = await createBook(course.id, { term: 'hk2', subjectPeriodsPerYear: 35 });
    expect(first.status).toBe(201);
    const dup = await createBook(course.id, { term: 'hk2', subjectPeriodsPerYear: 35 });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('grades.vn_book_exists');
    const { course: course2 } = await newCourseWithStudent();
    const noPeriods = await createBook(course2.id, { term: 'hk1' });
    expect(noPeriods.status).toBe(400);
    expect(noPeriods.body.code).toBe('grades.vn_periods_required');
  });

  it('ĐTBmhk đúng công thức Điều 9, khớp engine weightedmean, chốt snapshot và ĐTBmcn từ hai kì đã chốt', async () => {
    const { course, student } = await newCourseWithStudent();
    const hk1 = (await createBook(course.id, { term: 'hk1', subjectPeriodsPerYear: 105 })).body;
    const hk2 = (await createBook(course.id, { term: 'hk2', subjectPeriodsPerYear: 105 })).body;

    // Chưa đủ cột: tính trực tiếp báo thiếu, chốt bị từ chối (không tự điền 0).
    await setGrade(app, admin, hk1.items[0]!.id, student.id, 8);
    const partial = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-books/${hk1.book.id}/results/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(partial.body.complete).toBe(false);
    expect(partial.body.dtbHk).toBeNull();
    expect((partial.body.missingRoles as string[]).length).toBe(5);
    const earlyFinalize = await finalize(course.id, hk1.book.id, student.id);
    expect(earlyFinalize.status).toBe(400);
    expect(earlyFinalize.body.code).toBe('grades.vn_result_incomplete');

    // HK I: ĐĐGtx 8/7/9/6, gk 7, ck 8 → (30 + 14 + 24)/9 = 7,555… → 7,6 (ví dụ kiểm chứng của research).
    await fillGrades(hk1, student.id, [8, 7, 9, 6, 7, 8]);
    const computed = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-books/${hk1.book.id}/results/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(computed.body.complete).toBe(true);
    expect(computed.body.dtbHk).toBe(7.6);

    // Engine: tổng category weightedmean của sổ (chưa làm tròn) phải là 68/9 = 7,555…
    const gradebook = await getGradebook(app, admin, course.id, student.id);
    type CatView = { category: { id: string }; total: { item: { gradeMax: number }; grade: { finalGrade: number | null } | null } | null; children: CatView[] };
    const findCat = (cats: CatView[], id: string): CatView | undefined => {
      for (const c of cats) {
        if (c.category.id === id) return c;
        const hit = findCat(c.children ?? [], id);
        if (hit) return hit;
      }
      return undefined;
    };
    const vnCategory = findCat(gradebook.categories as unknown as CatView[], hk1.book.categoryId!);
    expect(vnCategory?.total?.grade?.finalGrade).toBeCloseTo(68 / 9, 3);
    expect(vnCategory?.total?.item.gradeMax).toBe(10);

    const snap1 = await finalize(course.id, hk1.book.id, student.id);
    expect(snap1.status).toBe(201);
    expect(snap1.body.dtbHk).toBe(7.6);
    expect(snap1.body.version).toBe(1);
    expect(snap1.body.scope).toBe('term');

    // HK II: ĐĐGtx 8/8/8/8, gk 8, ck 8,6 → (32 + 16 + 25,8)/9 = 8,2.
    await fillGrades(hk2, student.id, [8, 8, 8, 8, 8, 8.6]);
    const snap2 = await finalize(course.id, hk2.book.id, student.id);
    expect(snap2.status).toBe(201);
    expect(snap2.body.dtbHk).toBe(8.2);

    // Cả năm: (7,6 + 2×8,2)/3 = 8,0 — tính trên ĐTBmhk đã làm tròn.
    const year = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}/finalize`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(year.status).toBe(201);
    expect(year.body.dtbYear).toBe(8.0);
    expect(year.body.scope).toBe('year');
    const latestYear = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(latestYear.body.dtbYear).toBe(8.0);
  }, 90000);

  it('môn chỉ-nhận-xét: không sinh cột điểm, ghi được kết quả Đạt/Chưa đạt (Điều 5.3a)', async () => {
    const { course, student } = await newCourseWithStudent();
    const { status, body } = await createBook(course.id, { term: 'hk1', assessmentMode: 'comment' });
    expect(status).toBe(201);
    expect(body.book.assessmentMode).toBe('comment');
    expect(body.book.categoryId).toBeNull();
    expect(body.items.length).toBe(0);

    const compute = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-books/${body.book.id}/results/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(compute.status).toBe(400);
    expect(compute.body.code).toBe('grades.vn_comment_book');

    const recorded = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${body.book.id}/results/${student.id}/comment-result`)
      .set('Authorization', `Bearer ${admin}`).send({ result: 'Đạt', comment: 'Tích cực trong giờ học' });
    expect(recorded.status).toBe(201);
    expect(recorded.body.commentResult).toBe('Đạt');
    expect(recorded.body.dtbHk).toBeNull();
  });

  it('suy chế độ nhận xét từ tên môn của khoá (Giáo dục thể chất → comment, Toán → score)', async () => {
    const systemCtxId = await systemContextId(app, admin);
    const peRes = await http(app).post('/api/v1/curriculum/subjects').set('Authorization', `Bearer ${admin}`)
      .send({ contextId: systemCtxId, name: 'Giáo dục thể chất', slug: uniqueName('gdthechat') });
    expect(peRes.status).toBe(201);
    const peCourse = await createCourse(app, admin, catId, { subjectId: (peRes.body as { id: string }).id });
    const peBook = await createBook(peCourse.id, { term: 'hk1' });
    expect(peBook.status).toBe(201);
    expect(peBook.body.book.assessmentMode).toBe('comment');
    expect(peBook.body.items.length).toBe(0);

    const mathRes = await http(app).post('/api/v1/curriculum/subjects').set('Authorization', `Bearer ${admin}`)
      .send({ contextId: systemCtxId, name: 'Toán', slug: uniqueName('toan') });
    expect(mathRes.status).toBe(201);
    const mathCourse = await createCourse(app, admin, catId, { subjectId: (mathRes.body as { id: string }).id });
    const mathBook = await createBook(mathCourse.id, { term: 'hk1', subjectPeriodsPerYear: 140 });
    expect(mathBook.body.book.assessmentMode).toBe('score');
    expect(mathBook.body.book.dgtxQuota).toBe(4);
  });

  it('xếp mức chung Điều 9: 6 môn 9,0 + 1 môn 4,0 → gốc Đạt, nâng lên Khá theo Điều 9.3', async () => {
    // Một học sinh học 7 môn điểm số trong cùng học kì I.
    const student = await createUserViaApi(app, admin);
    const courseIds: string[] = [];
    let badCourseId = '';
    for (let m = 0; m < 7; m += 1) {
      const course = await createCourse(app, admin, catId);
      const instance = await createEnrolInstance(app, admin, course.id);
      await enrolUser(app, admin, course.id, instance.id, student.id);
      courseIds.push(course.id);
      const view = (await createBook(course.id, { term: 'hk1', subjectPeriodsPerYear: 35 })).body;
      // quota 2 ĐĐGtx: điểm đồng nhất x cho mọi cột → ĐTBmhk = x.
      const x = m === 6 ? 4 : 9;
      if (m === 6) badCourseId = course.id;
      await fillGrades(view, student.id, [x, x, x, x]);
      const snap = await finalize(course.id, view.book.id, student.id);
      expect(snap.status).toBe(201);
      expect(snap.body.dtbHk).toBe(x);
    }

    const asAdmin = await http(app).get(`/api/v1/grades/vn/students/${student.id}/classification`).query({ period: 'hk1' }).set('Authorization', `Bearer ${admin}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.subjects.length).toBe(7);
    expect(asAdmin.body.baseLevel).toBe('Đạt');
    expect(asAdmin.body.adjusted).toBe(true);
    expect(asAdmin.body.adjustedDueToSubjectKey).toBe(badCourseId);
    expect(asAdmin.body.level).toBe('Khá');

    // Chính học sinh đọc được mức của mình; học sinh khác thì bị chặn.
    const studentLogin = await login(app, student.username, STRONG_PASSWORD);
    const asSelf = await http(app).get(`/api/v1/grades/vn/students/${student.id}/classification`).query({ period: 'hk1' }).set('Authorization', `Bearer ${studentLogin.accessToken}`);
    expect(asSelf.status).toBe(200);
    expect(asSelf.body.level).toBe('Khá');
    const stranger = await createUserViaApi(app, admin);
    const strangerLogin = await login(app, stranger.username, STRONG_PASSWORD);
    const asStranger = await http(app).get(`/api/v1/grades/vn/students/${student.id}/classification`).query({ period: 'hk1' }).set('Authorization', `Bearer ${strangerLogin.accessToken}`);
    expect(asStranger.status).toBe(403);
  }, 120000);

  it('gác actor route kết quả theo học sinh: bạn học bị 403, chính chủ và giáo viên có grade:viewall đọc được (vá rò điểm #95)', async () => {
    // Khoá có hai học sinh cùng ghi danh và một giáo viên (editingteacher tại context khoá).
    const course = await createCourse(app, admin, catId);
    const instance = await createEnrolInstance(app, admin, course.id);
    const peer = await createUserViaApi(app, admin);
    const owner = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, peer.id);
    await enrolUser(app, admin, course.id, instance.id, owner.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;
    const peerToken = (await login(app, peer.username, STRONG_PASSWORD)).accessToken;
    const ownerToken = (await login(app, owner.username, STRONG_PASSWORD)).accessToken;

    // Sổ hai kì (35 tiết → quota 2 ĐĐGtx); nhập điểm + chốt kì + chốt năm cho owner bằng admin.
    const hk1 = (await createBook(course.id, { term: 'hk1', subjectPeriodsPerYear: 35 })).body;
    const hk2 = (await createBook(course.id, { term: 'hk2', subjectPeriodsPerYear: 35 })).body;
    await fillGrades(hk1, owner.id, [8, 9, 7, 8]); // ĐTBmhk = (17 + 2×7 + 3×8)/7 = 55/7 → 7,9
    const snap1 = await finalize(course.id, hk1.book.id, owner.id);
    expect(snap1.status).toBe(201);
    expect(snap1.body.dtbHk).toBe(7.9);
    await fillGrades(hk2, owner.id, [9, 9, 9, 9]); // ĐTBmhk = 9,0
    const snap2 = await finalize(course.id, hk2.book.id, owner.id);
    expect(snap2.status).toBe(201);
    const yearFinalize = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-year-results/${owner.id}/finalize`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(yearFinalize.status).toBe(201);
    expect(yearFinalize.body.dtbYear).toBe(8.6); // (7,9 + 2×9,0)/3 = 8,633… → 8,6

    const resultsUrl = `/api/v1/courses/${course.id}/grades/vn-books/${hk1.book.id}/results/${owner.id}`;
    const snapshotsUrl = `${resultsUrl}/snapshots`;
    const yearUrl = `/api/v1/courses/${course.id}/grades/vn-year-results/${owner.id}`;

    // (a) Bạn học cùng lớp đọc trộm kết quả của owner → 403 cả ba bề mặt, đúng mã của requireCapability.
    for (const url of [resultsUrl, snapshotsUrl, yearUrl]) {
      const res = await http(app).get(url).set('Authorization', `Bearer ${peerToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('access.capability_denied');
    }
    // Người ngoài khoá đọc "của chính mình" trong khoá chưa ghi danh → 403 (assertCourseAccess).
    const outsider = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    const notEnrolled = await http(app).get(`/api/v1/courses/${course.id}/grades/vn-books/${hk1.book.id}/results/${outsider.id}`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(notEnrolled.status).toBe(403);

    // (b) Chính chủ đọc được cả ba bề mặt và thấy đúng điểm của mình.
    const own = await http(app).get(resultsUrl).set('Authorization', `Bearer ${ownerToken}`);
    expect(own.status).toBe(200);
    expect(own.body.complete).toBe(true);
    expect(own.body.dtbHk).toBe(7.9);
    const ownSnaps = await http(app).get(snapshotsUrl).set('Authorization', `Bearer ${ownerToken}`);
    expect(ownSnaps.status).toBe(200);
    expect((ownSnaps.body as unknown[]).length).toBe(1);
    const ownYear = await http(app).get(yearUrl).set('Authorization', `Bearer ${ownerToken}`);
    expect(ownYear.status).toBe(200);
    expect(ownYear.body.dtbYear).toBe(8.6);

    // (c) Giáo viên có grade:viewall tại khoá đọc được kết quả của học sinh.
    const asTeacher = await http(app).get(resultsUrl).set('Authorization', `Bearer ${teacher}`);
    expect(asTeacher.status).toBe(200);
    expect(asTeacher.body.dtbHk).toBe(7.9);
    const teacherSnaps = await http(app).get(snapshotsUrl).set('Authorization', `Bearer ${teacher}`);
    expect(teacherSnaps.status).toBe(200);
    const teacherYear = await http(app).get(yearUrl).set('Authorization', `Bearer ${teacher}`);
    expect(teacherYear.status).toBe(200);
    expect(teacherYear.body.dtbYear).toBe(8.6);
  }, 120000);
});
