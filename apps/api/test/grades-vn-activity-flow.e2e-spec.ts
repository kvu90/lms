import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { setGrade } from './assessment-helpers';

/**
 * Luồng điểm hoạt động → cột sổ TT 22 (GB-VN-2, issue #104). Oracle: hồ sơ
 * research vn-gradebook-scoring-research-2026-10-24 mục 3/5.2.4/6.1 — điểm
 * hoạt động chỉ là ỨNG VIÊN, giáo viên chốt mới vào cột; quy đổi thang 10
 * theo Điều 5.3b; trạng thái chờ kiểm tra bù (Điều 7.4) phân biệt với 0 điểm
 * (Điều 7.5). Số kỳ vọng (7,5 từ 30/40; 9,0 từ 18/20; ĐTBmhk 5,4) tính tay.
 */
describe('Luồng hoạt động → cột sổ VN (GB-VN-2, issue #104)', () => {
  let app: INestApplication;
  let admin: string;
  let catId: string;

  interface VnItem { id: string; vnRole: string | null; vnOrdinal: number | null }
  interface VnBookView { book: { id: string; dgtxQuota: number }; items: VnItem[] }
  interface MappingView { id: string; cmId: string; itemId: string; targetItemId: string; targetRole: string | null; component: string | null }
  interface Candidate { mappingId: string; userId: string; convertedGrade: number; state: string; activityGradeChanged: boolean; committedValue: number | null; component: string | null }
  interface ColumnScore { itemId: string; role: string; grade: number | null; status: string }

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
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    return { course, student, studentToken };
  }

  /** Sổ hk1 môn 35 tiết/năm → quota ĐĐGtx = 2 (cột: dgtx1, dgtx2, dggk, dgck). */
  async function createBook(courseId: string): Promise<VnBookView> {
    const res = await http(app).post(`/api/v1/courses/${courseId}/grades/vn-books`)
      .set('Authorization', `Bearer ${admin}`).send({ term: 'hk1', subjectPeriodsPerYear: 35 });
    expect(res.status).toBe(201);
    return res.body as VnBookView;
  }

  async function createQuiz(courseId: string, sectionId: string, name: string, grade: number): Promise<{ id: string; cmId: string }> {
    const res = await http(app).post(`/api/v1/courses/${courseId}/quizzes`)
      .set('Authorization', `Bearer ${admin}`).send({ sectionId, name, grade });
    expect(res.status).toBe(201);
    return res.body as { id: string; cmId: string };
  }

  function mapActivity(courseId: string, bookId: string, body: Record<string, unknown>, token = admin) {
    return http(app).post(`/api/v1/courses/${courseId}/grades/vn-books/${bookId}/activity-mappings`)
      .set('Authorization', `Bearer ${token}`).send(body);
  }

  async function candidates(courseId: string, bookId: string): Promise<Candidate[]> {
    const res = await http(app).get(`/api/v1/courses/${courseId}/grades/vn-books/${bookId}/candidates`)
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    return (res.body as { candidates: Candidate[] }).candidates;
  }

  async function compute(courseId: string, bookId: string, userId: string) {
    const res = await http(app).get(`/api/v1/courses/${courseId}/grades/vn-books/${bookId}/results/${userId}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    return res.body as { complete: boolean; dtbHk: number | null; awaitingMakeupRoles: string[]; columns: ColumnScore[] };
  }

  function columnOf(view: VnBookView, role: string, ordinal?: number): VnItem {
    const item = view.items.find((i) => i.vnRole === role && (ordinal === undefined || i.vnOrdinal === ordinal));
    expect(item, `column ${role}/${ordinal}`).toBeTruthy();
    return item!;
  }

  it('khai vai trò: vai/ordinal/cm không hợp lệ bị từ chối đúng mã, khai trùng bị chặn', async () => {
    const { course, studentToken } = await newCourseWithStudent();
    const book = await createBook(course.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const quiz = await createQuiz(course.id, sectionId, 'KT giữa kì', 40);
    const bookId = book.book.id;

    // dggk kèm ordinal → 400 ordinal_forbidden.
    let res = await mapActivity(course.id, bookId, { cmId: quiz.cmId, role: 'dggk', ordinal: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('grades.vn_mapping_ordinal_forbidden');
    // dgtx thiếu ordinal → 400 ordinal_required.
    res = await mapActivity(course.id, bookId, { cmId: quiz.cmId, role: 'dgtx' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('grades.vn_mapping_ordinal_required');
    // dgtx ordinal 3 vượt quota 2 → 400 ordinal_out_of_range.
    res = await mapActivity(course.id, bookId, { cmId: quiz.cmId, role: 'dgtx', ordinal: 3 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('grades.vn_mapping_ordinal_out_of_range');
    // cm không tồn tại/không có grade item → 400 vn_activity_not_gradable.
    res = await mapActivity(course.id, bookId, { cmId: randomUUID(), role: 'dggk' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('grades.vn_activity_not_gradable');
    // Học sinh không có quyền khai (grade:manage) → 403.
    res = await mapActivity(course.id, bookId, { cmId: quiz.cmId, role: 'dggk' }, studentToken);
    expect(res.status).toBe(403);
    // Khai hợp lệ → 201, truy vết đúng cột đích + loại hoạt động.
    res = await mapActivity(course.id, bookId, { cmId: quiz.cmId, role: 'dggk' });
    expect(res.status).toBe(201);
    const mapping = res.body as MappingView;
    expect(mapping.targetItemId).toBe(columnOf(book, 'dggk').id);
    expect(mapping.targetRole).toBe('dggk');
    expect(mapping.component).toBe('mod_quiz');
    // Khai lại cùng hoạt động → 400 vn_mapping_exists.
    res = await mapActivity(course.id, bookId, { cmId: quiz.cmId, role: 'dgck' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('grades.vn_mapping_exists');
  });

  it('ứng viên: quy đổi thang 10, chốt nguyên, sửa-chốt mang overridden, điểm đổi thì hiện lại chờ quyết', async () => {
    const { course, student, studentToken } = await newCourseWithStudent();
    const book = await createBook(course.id);
    const bookId = book.book.id;
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const quizGk = await createQuiz(course.id, sectionId, 'KT giữa kì (thang 40)', 40);
    const quizTx = await createQuiz(course.id, sectionId, 'KT thường xuyên (thang 20)', 20);
    const mapGk = (await mapActivity(course.id, bookId, { cmId: quizGk.cmId, role: 'dggk' })).body as MappingView;
    const mapTx = (await mapActivity(course.id, bookId, { cmId: quizTx.cmId, role: 'dgtx', ordinal: 1 })).body as MappingView;

    // Chưa có điểm hoạt động: hộp ứng viên rỗng; chốt ngay → 400 vn_candidate_not_found.
    expect(await candidates(course.id, bookId)).toEqual([]);
    let res = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${bookId}/candidates/${mapGk.id}/students/${student.id}/commit`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('grades.vn_candidate_not_found');

    // Điểm hoạt động 30/40 → ứng viên pending, quy đổi 7,5 (tính tay: 30/40 × 10).
    await setGrade(app, admin, mapGk.itemId, student.id, 30);
    let list = await candidates(course.id, bookId);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ mappingId: mapGk.id, userId: student.id, convertedGrade: 7.5, state: 'pending', activityGradeChanged: false });

    // Học sinh chốt ứng viên → 403 (grade:edit).
    res = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${bookId}/candidates/${mapGk.id}/students/${student.id}/commit`)
      .set('Authorization', `Bearer ${studentToken}`).send({});
    expect(res.status).toBe(403);

    // GV chốt nguyên giá trị quy đổi → cột ĐĐGgk = 7,5; ứng viên chuyển committed.
    res = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${bookId}/candidates/${mapGk.id}/students/${student.id}/commit`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ action: 'commit', committedValue: 7.5, convertedGrade: 7.5 });
    let computed = await compute(course.id, bookId, student.id);
    expect(computed.columns.find((c) => c.role === 'dggk')).toMatchObject({ grade: 7.5, status: 'graded' });
    list = await candidates(course.id, bookId);
    expect(list[0]).toMatchObject({ state: 'committed', committedValue: 7.5 });

    // Điểm hoạt động đổi 30 → 20: ứng viên hiện lại pending + cờ đã-đổi, quy đổi mới 5,0.
    await setGrade(app, admin, mapGk.itemId, student.id, 20);
    list = await candidates(course.id, bookId);
    expect(list[0]).toMatchObject({ state: 'pending', activityGradeChanged: true, convertedGrade: 5 });

    // Sửa-chốt 6,0 (khác quy đổi 5,0) → cột = 6,0 và mang overridden:
    // đường ghi tay của engine bị chặn đúng mã grades.grade_overridden.
    res = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${bookId}/candidates/${mapGk.id}/students/${student.id}/commit`)
      .set('Authorization', `Bearer ${admin}`).send({ value: 6 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ action: 'commit', committedValue: 6, convertedGrade: 5 });
    computed = await compute(course.id, bookId, student.id);
    expect(computed.columns.find((c) => c.role === 'dggk')?.grade).toBe(6);
    const rawSet = await http(app).post(`/api/v1/courses/grades/items/${mapGk.targetItemId}/grades`)
      .set('Authorization', `Bearer ${admin}`).send({ userId: student.id, rawGrade: 9 });
    expect(rawSet.status).toBe(403);
    expect(rawSet.body.code).toBe('grades.grade_overridden');
    // Nhưng GV vẫn sửa-chốt lại được qua đúng luồng ứng viên.
    res = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${bookId}/candidates/${mapGk.id}/students/${student.id}/commit`)
      .set('Authorization', `Bearer ${admin}`).send({ value: 6.5 });
    expect(res.status).toBe(201);
    computed = await compute(course.id, bookId, student.id);
    expect(computed.columns.find((c) => c.role === 'dggk')?.grade).toBe(6.5);

    // Bỏ qua: điểm quiz thường xuyên 18/20 → ứng viên 9,0 pending → dismiss → dismissed;
    // điểm đổi còn 10/20 → hiện lại pending, quy đổi 5,0.
    await setGrade(app, admin, mapTx.itemId, student.id, 18);
    list = await candidates(course.id, bookId);
    const txCandidate = list.find((c) => c.mappingId === mapTx.id);
    expect(txCandidate).toMatchObject({ convertedGrade: 9, state: 'pending' });
    res = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${bookId}/candidates/${mapTx.id}/students/${student.id}/dismiss`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ action: 'dismiss' });
    list = await candidates(course.id, bookId);
    expect(list.find((c) => c.mappingId === mapTx.id)).toMatchObject({ state: 'dismissed' });
    await setGrade(app, admin, mapTx.itemId, student.id, 10);
    list = await candidates(course.id, bookId);
    expect(list.find((c) => c.mappingId === mapTx.id)).toMatchObject({ state: 'pending', activityGradeChanged: true, convertedGrade: 5 });
    // Chốt nguyên ứng viên thường xuyên → cột dgtx1 = 5,0, KHÔNG overridden (ghi tay engine vẫn mở).
    res = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${bookId}/candidates/${mapTx.id}/students/${student.id}/commit`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(res.status).toBe(201);
    const manual = await http(app).post(`/api/v1/courses/grades/items/${mapTx.targetItemId}/grades`)
      .set('Authorization', `Bearer ${admin}`).send({ userId: student.id, rawGrade: 5 });
    expect(manual.status).toBeLessThan(300);
  });

  it('kiểm tra bù: chờ bù chặn chốt sổ bằng mã riêng; ghi 0 theo Điều 7.5 thì chốt được với ĐTBmhk tính tay', async () => {
    const { course, student } = await newCourseWithStudent();
    const book = await createBook(course.id);
    const bookId = book.book.id;
    const gk = columnOf(book, 'dggk');
    // Đủ các cột khác: dgtx1 = 8, dgtx2 = 9, dgck = 7; cột giữa kì để trống.
    await setGrade(app, admin, columnOf(book, 'dgtx', 1).id, student.id, 8);
    await setGrade(app, admin, columnOf(book, 'dgtx', 2).id, student.id, 9);
    await setGrade(app, admin, columnOf(book, 'dgck').id, student.id, 7);

    const makeup = (itemId: string, state: string) => http(app)
      .post(`/api/v1/courses/${course.id}/grades/vn-books/${bookId}/columns/${itemId}/students/${student.id}/makeup-status`)
      .set('Authorization', `Bearer ${admin}`).send({ state });
    const finalize = () => http(app)
      .post(`/api/v1/courses/${course.id}/grades/vn-books/${bookId}/results/${student.id}/finalize`)
      .set('Authorization', `Bearer ${admin}`).send({});

    // Trạng thái bù chỉ áp cột định kì — áp lên cột thường xuyên → 400.
    let res = await makeup(columnOf(book, 'dgtx', 1).id, 'awaiting_makeup');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('grades.vn_makeup_role_invalid');

    // Đánh dấu chờ kiểm tra bù → compute báo trạng thái riêng; chốt sổ bị chặn bằng mã riêng.
    res = await makeup(gk.id, 'awaiting_makeup');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'awaiting_makeup', grade: null });
    let computed = await compute(course.id, bookId, student.id);
    expect(computed.columns.find((c) => c.role === 'dggk')).toMatchObject({ grade: null, status: 'awaiting_makeup' });
    expect(computed.awaitingMakeupRoles).toEqual(['dggk']);
    res = await finalize();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('grades.vn_result_awaiting_makeup');

    // Gỡ đánh dấu → thiếu thường: chốt sổ chặn bằng mã incomplete như GB-VN-1.
    res = await makeup(gk.id, 'clear');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'missing' });
    res = await finalize();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('grades.vn_result_incomplete');

    // Chờ bù rồi ghi hẳn 0 điểm theo Điều 7.5 → cột có điểm 0 thật, chốt sổ thành công.
    // ĐTBmhk tính tay: (8 + 9 + 2×0 + 3×7) / (2 + 5) = 38/7 = 5,428… → 5,4.
    await makeup(gk.id, 'awaiting_makeup');
    res = await makeup(gk.id, 'zero');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'graded', grade: 0 });
    res = await finalize();
    expect(res.status).toBe(201);
    expect(res.body.dtbHk).toBe(5.4);
    computed = await compute(course.id, bookId, student.id);
    expect(computed.complete).toBe(true);
  });
});
