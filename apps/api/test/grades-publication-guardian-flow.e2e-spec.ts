import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelayService } from '../src/infra/events/outbox-relay.service';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { createGradeItem, getGradebook, setGrade } from './assessment-helpers';

/**
 * PH-0 — nền công bố điểm/lời phê + liên kết giám hộ PH–HS + audit
 * (issue #116). Oracle: research phụ huynh/HS mục 2.2/5.1/5.2 (Canvas
 * Grade Posting Policy; TT 22/2021 Đ.20.6 thông báo riêng cho cha mẹ;
 * chốt chặn ở CÔNG BỐ — finalize chỉ là chốt nội bộ của giáo viên).
 */
describe('PH-0: công bố điểm + liên kết giám hộ + audit (issue #116)', () => {
  let app: INestApplication;
  let admin: string;
  let catId: string;

  interface BookItem { id: string; vnRole: string | null }
  interface BookView { book: { id: string; courseId: string }; items: BookItem[] }
  interface BookGrade { item: { id: string }; grade: { finalGrade: number | null; feedback: string | null } | null; publication: { policy: string; published: boolean } }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    catId = (await createCategory(app, admin)).id;
  }, 120000);
  afterAll(async () => { await app.close(); });

  /** Khoá mới + một học sinh ghi danh + một giáo viên editingteacher tại context khoá. */
  async function courseWithPeople() {
    const course = await createCourse(app, admin, catId);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    return { course, student, studentToken, teacher, teacherUser };
  }

  function flattenGrades(book: { categories: { items: BookGrade[]; total: BookGrade | null; children: never[] }[] }): BookGrade[] {
    const out: BookGrade[] = [];
    const walk = (cats: { items: BookGrade[]; total: BookGrade | null; children: never[] }[]) => {
      for (const c of cats) {
        out.push(...c.items);
        if (c.total) out.push(c.total);
        walk(c.children as never[]);
      }
    };
    walk(book.categories);
    return out;
  }

  async function flushRelay() {
    const relay = app.get(OutboxRelayService);
    for (let i = 0; i < 20; i += 1) {
      const n = await relay.publishPending(500);
      if (n === 0) break;
    }
  }

  async function queryLogs(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    const res = await http(app).get(`/api/v1/event-logs?${qs}`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    return res.body as { items: { eventType: string; userId: string | null; relatedUserId: string | null; payload: Record<string, unknown> | null }[] };
  }

  it('công bố theo hoạt động: policy manual ẩn điểm + tổng phía học sinh cho tới khi GV công bố; rút công bố thì mất lại', async () => {
    const { course, student, studentToken, teacher } = await courseWithPeople();
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Kiểm tra 15 phút', gradeMax: 10 });
    await setGrade(app, admin, item.id, student.id, 8, 'Làm tốt');

    // Mặc định auto: học sinh thấy điểm ngay (hành vi hiện hữu giữ nguyên).
    let mine = flattenGrades(await getGradebook(app, studentToken, course.id) as never);
    let leaf = mine.find((g) => g.item.id === item.id);
    expect(leaf?.grade?.finalGrade).toBe(8);
    expect(leaf?.publication).toEqual({ policy: 'auto', published: true });

    // Học sinh không tự đặt policy / không tự công bố được.
    const selfPolicy = await http(app).put(`/api/v1/courses/grades/items/${item.id}/posting-policy`)
      .set('Authorization', `Bearer ${studentToken}`).send({ policy: 'manual' });
    expect(selfPolicy.status).toBe(403);
    const selfPublish = await http(app).post(`/api/v1/courses/grades/items/${item.id}/publish`)
      .set('Authorization', `Bearer ${studentToken}`).send({});
    expect(selfPublish.status).toBe(403);

    // GV đặt policy manual → điểm + lời phê + điểm tổng khoá đều bị che phía học sinh.
    const setPolicy = await http(app).put(`/api/v1/courses/grades/items/${item.id}/posting-policy`)
      .set('Authorization', `Bearer ${teacher}`).send({ policy: 'manual' });
    expect(setPolicy.status).toBe(200);
    mine = flattenGrades(await getGradebook(app, studentToken, course.id) as never);
    leaf = mine.find((g) => g.item.id === item.id);
    expect(leaf?.grade).toBeNull();
    expect(leaf?.publication).toEqual({ policy: 'manual', published: false });
    const totals = mine.filter((g) => g.item.id !== item.id);
    expect(totals.every((g) => g.grade === null || g.grade.finalGrade === null)).toBe(true);

    // Giáo viên (grade:viewall) vẫn thấy đủ điểm chưa công bố.
    const teacherBook = flattenGrades(await getGradebook(app, teacher, course.id, student.id) as never);
    expect(teacherBook.find((g) => g.item.id === item.id)?.grade?.finalGrade).toBe(8);

    // Công bố → học sinh thấy lại điểm + lời phê.
    const pub = await http(app).post(`/api/v1/courses/grades/items/${item.id}/publish`)
      .set('Authorization', `Bearer ${teacher}`).send({});
    expect(pub.status).toBe(201);
    expect(pub.body.published).toBe(true);
    mine = flattenGrades(await getGradebook(app, studentToken, course.id) as never);
    leaf = mine.find((g) => g.item.id === item.id);
    expect(leaf?.grade?.finalGrade).toBe(8);
    expect(leaf?.grade?.feedback).toBe('Làm tốt');

    // Rút công bố → mất quyền thấy lại.
    const unpub = await http(app).post(`/api/v1/courses/grades/items/${item.id}/unpublish`)
      .set('Authorization', `Bearer ${teacher}`).send({});
    expect(unpub.status).toBe(201);
    expect(unpub.body.published).toBe(false);
    mine = flattenGrades(await getGradebook(app, studentToken, course.id) as never);
    expect(mine.find((g) => g.item.id === item.id)?.grade).toBeNull();

    // Audit: publish vào event_log; sửa điểm sau công bố cũng có vết riêng.
    const repub = await http(app).post(`/api/v1/courses/grades/items/${item.id}/publish`)
      .set('Authorization', `Bearer ${teacher}`).send({});
    expect(repub.status).toBe(201);
    await setGrade(app, teacher, item.id, student.id, 9);
    await flushRelay();
    const publishLogs = await queryLogs({ eventType: 'grade_item_published', courseId: course.id });
    expect(publishLogs.items.some((i) => i.payload?.itemId === item.id)).toBe(true);
    const changedLogs = await queryLogs({ eventType: 'grade_changed_after_publish', courseId: course.id });
    const changed = changedLogs.items.find((i) => i.payload?.itemId === item.id);
    expect(changed).toBeDefined();
    expect(changed!.relatedUserId).toBe(student.id);
  }, 120000);

  it('kết quả VN: finalize là chốt nội bộ — học sinh chỉ đọc kết quả kì/năm sau khi GV công bố', async () => {
    const { course, student, studentToken } = await courseWithPeople();
    const mkBook = async (term: string) => {
      const res = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books`)
        .set('Authorization', `Bearer ${admin}`).send({ term, subjectPeriodsPerYear: 35 });
      expect(res.status).toBe(201);
      return res.body as BookView;
    };
    const fill = async (view: BookView, values: number[]) => {
      for (let i = 0; i < values.length; i += 1) await setGrade(app, admin, view.items[i]!.id, student.id, values[i]!);
    };
    const hk1 = await mkBook('hk1');
    const hk2 = await mkBook('hk2');
    await fill(hk1, [8, 9, 7, 8]); // ĐTBmhk = (17 + 14 + 24)/7 = 55/7 → 7,9
    await fill(hk2, [9, 9, 9, 9]);
    for (const [view] of [[hk1], [hk2]] as const) {
      const fin = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${view.book.id}/results/${student.id}/finalize`)
        .set('Authorization', `Bearer ${admin}`).send({});
      expect(fin.status).toBe(201);
    }
    const yearFin = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}/finalize`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(yearFin.status).toBe(201);

    const resultsUrl = `/api/v1/courses/${course.id}/grades/vn-books/${hk1.book.id}/results/${student.id}`;
    const yearUrl = `/api/v1/courses/${course.id}/grades/vn-year-results/${student.id}`;

    // Chưa công bố: results + year → 403 đúng mã; snapshots → rỗng. Giáo viên vẫn đọc được.
    const blocked = await http(app).get(resultsUrl).set('Authorization', `Bearer ${studentToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('grades.vn_result_not_published');
    const snaps = await http(app).get(`${resultsUrl}/snapshots`).set('Authorization', `Bearer ${studentToken}`);
    expect(snaps.status).toBe(200);
    expect((snaps.body as unknown[]).length).toBe(0);
    const yearBlocked = await http(app).get(yearUrl).set('Authorization', `Bearer ${studentToken}`);
    expect(yearBlocked.status).toBe(403);
    const asAdmin = await http(app).get(resultsUrl).set('Authorization', `Bearer ${admin}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.dtbHk).toBe(7.9);

    // Học sinh không tự công bố kết quả của mình.
    const selfPub = await http(app).post(`${resultsUrl}/publish`).set('Authorization', `Bearer ${studentToken}`).send({});
    expect(selfPub.status).toBe(403);

    // Công bố kì → đọc được; công bố năm → đọc được; rút công bố năm → 403 lại.
    const pub = await http(app).post(`${resultsUrl}/publish`).set('Authorization', `Bearer ${admin}`).send({});
    expect(pub.status).toBe(201);
    const own = await http(app).get(resultsUrl).set('Authorization', `Bearer ${studentToken}`);
    expect(own.status).toBe(200);
    expect(own.body.dtbHk).toBe(7.9);
    const ownSnaps = await http(app).get(`${resultsUrl}/snapshots`).set('Authorization', `Bearer ${studentToken}`);
    expect((ownSnaps.body as unknown[]).length).toBe(1);
    const pubYear = await http(app).post(`${yearUrl}/publish`).set('Authorization', `Bearer ${admin}`).send({});
    expect(pubYear.status).toBe(201);
    const ownYear = await http(app).get(yearUrl).set('Authorization', `Bearer ${studentToken}`);
    expect(ownYear.status).toBe(200);
    expect(ownYear.body.dtbYear).toBe(8.6);
    const unpubYear = await http(app).post(`${yearUrl}/unpublish`).set('Authorization', `Bearer ${admin}`).send({});
    expect(unpubYear.status).toBe(201);
    const yearGone = await http(app).get(yearUrl).set('Authorization', `Bearer ${studentToken}`);
    expect(yearGone.status).toBe(403);
    expect(yearGone.body.code).toBe('grades.vn_result_not_published');
  }, 120000);

  it('liên kết giám hộ: trường xác lập, phụ huynh chỉ đọc dữ liệu đã công bố của đúng con mình, mọi lần xem có audit', async () => {
    const { course, student, teacher } = await courseWithPeople();
    const guardian = await createUserViaApi(app, admin);
    const guardianToken = (await login(app, guardian.username, STRONG_PASSWORD)).accessToken;
    const stranger = await createUserViaApi(app, admin);
    const strangerToken = (await login(app, stranger.username, STRONG_PASSWORD)).accessToken;
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;

    // Điểm hoạt động: một item auto (thấy) + một item manual chưa công bố (không thấy).
    const autoItem = await createGradeItem(app, admin, course.id, { itemName: 'Luyện tập', gradeMax: 10 });
    const manualItem = await createGradeItem(app, admin, course.id, { itemName: 'Kiểm tra định kỳ', gradeMax: 10 });
    await setGrade(app, admin, autoItem.id, student.id, 7);
    await setGrade(app, admin, manualItem.id, student.id, 5);
    await http(app).put(`/api/v1/courses/grades/items/${manualItem.id}/posting-policy`)
      .set('Authorization', `Bearer ${teacher}`).send({ policy: 'manual' });

    // Kết quả VN của khoá: chốt + công bố.
    const bookRes = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books`)
      .set('Authorization', `Bearer ${admin}`).send({ term: 'hk1', subjectPeriodsPerYear: 35 });
    const book = bookRes.body as BookView;
    for (let i = 0; i < book.items.length; i += 1) await setGrade(app, admin, book.items[i]!.id, student.id, 8);
    const fin = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/results/${student.id}/finalize`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(fin.status).toBe(201);
    const pubRes = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/results/${student.id}/publish`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(pubRes.status).toBe(201);

    // Chưa có liên kết: phụ huynh không đọc được gì của học sinh.
    const noLink = await http(app).get(`/api/v1/guardian/students/${student.id}/courses/${course.id}/gradebook`)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(noLink.status).toBe(403);
    expect(noLink.body.code).toBe('guardian.no_active_link');

    // Phụ huynh và học sinh đều không tự xác lập liên kết.
    const byGuardian = await http(app).post('/api/v1/guardian-links').set('Authorization', `Bearer ${guardianToken}`)
      .send({ guardianUserId: guardian.id, studentUserId: student.id, relationship: 'Cha' });
    expect(byGuardian.status).toBe(403);
    const byStudent = await http(app).post('/api/v1/guardian-links').set('Authorization', `Bearer ${studentToken}`)
      .send({ guardianUserId: guardian.id, studentUserId: student.id, relationship: 'Cha' });
    expect(byStudent.status).toBe(403);

    // Giáo viên của khoá xác lập liên kết → 201; tạo trùng → 409.
    const created = await http(app).post('/api/v1/guardian-links').set('Authorization', `Bearer ${teacher}`)
      .send({ guardianUserId: guardian.id, studentUserId: student.id, relationship: 'Cha' });
    expect(created.status).toBe(201);
    const linkId = (created.body as { id: string }).id;
    const dup = await http(app).post('/api/v1/guardian-links').set('Authorization', `Bearer ${teacher}`)
      .send({ guardianUserId: guardian.id, studentUserId: student.id, relationship: 'Cha' });
    expect(dup.status).toBe(409);

    // Hai phía tự xem được liên kết của mình.
    const myStudents = await http(app).get('/api/v1/guardian-links/mine/students').set('Authorization', `Bearer ${guardianToken}`);
    expect(myStudents.status).toBe(200);
    expect((myStudents.body as { student: { id: string } }[]).map((x) => x.student.id)).toContain(student.id);
    const myGuardians = await http(app).get('/api/v1/guardian-links/mine/guardians').set('Authorization', `Bearer ${studentToken}`);
    expect((myGuardians.body as { guardianUserId: string }[]).map((x) => x.guardianUserId)).toContain(guardian.id);

    // Phụ huynh đọc sổ điểm của con: thấy điểm auto đã công bố, không thấy điểm manual chưa công bố.
    const gBook = await http(app).get(`/api/v1/guardian/students/${student.id}/courses/${course.id}/gradebook`)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(gBook.status).toBe(200);
    const gGrades = flattenGrades(gBook.body as never);
    expect(gGrades.find((g) => g.item.id === autoItem.id)?.grade?.finalGrade).toBe(7);
    expect(gGrades.find((g) => g.item.id === manualItem.id)?.grade).toBeNull();

    // Phụ huynh đọc kết quả VN đã công bố của con.
    const gVn = await http(app).get(`/api/v1/guardian/students/${student.id}/courses/${course.id}/vn-books/${book.book.id}/results`)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(gVn.status).toBe(200);
    expect(gVn.body.dtbHk).toBe(8);

    // Người lạ (không liên kết) đọc → 403 cả hai bề mặt.
    for (const url of [
      `/api/v1/guardian/students/${student.id}/courses/${course.id}/gradebook`,
      `/api/v1/guardian/students/${student.id}/courses/${course.id}/vn-books/${book.book.id}/results`,
    ]) {
      const res = await http(app).get(url).set('Authorization', `Bearer ${strangerToken}`);
      expect(res.status).toBe(403);
    }

    // Audit: tạo liên kết + phụ huynh xem đều có bản ghi event_log.
    await flushRelay();
    const linkLogs = await queryLogs({ eventType: 'guardian_link_created', relatedUserId: student.id });
    expect(linkLogs.items.some((i) => i.payload?.guardianUserId === guardian.id)).toBe(true);
    const viewLogs = await queryLogs({ eventType: 'guardian_student_results_viewed', relatedUserId: student.id });
    expect(viewLogs.items.some((i) => i.userId === guardian.id)).toBe(true);

    // Thu hồi liên kết → phụ huynh mất quyền đọc; tạo lại được sau thu hồi.
    const revoked = await http(app).delete(`/api/v1/guardian-links/${linkId}`).set('Authorization', `Bearer ${teacher}`);
    expect(revoked.status).toBe(200);
    expect((revoked.body as { status: string }).status).toBe('revoked');
    const afterRevoke = await http(app).get(`/api/v1/guardian/students/${student.id}/courses/${course.id}/gradebook`)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(afterRevoke.status).toBe(403);
    const recreated = await http(app).post('/api/v1/guardian-links').set('Authorization', `Bearer ${teacher}`)
      .send({ guardianUserId: guardian.id, studentUserId: student.id, relationship: 'Cha' });
    expect(recreated.status).toBe(201);

    await flushRelay();
    const revokeLogs = await queryLogs({ eventType: 'guardian_link_revoked', relatedUserId: student.id });
    expect(revokeLogs.items.some((i) => i.payload?.guardianUserId === guardian.id)).toBe(true);
  }, 120000);
});
