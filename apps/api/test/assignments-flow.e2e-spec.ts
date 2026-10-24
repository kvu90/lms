import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { getGradebook } from './assessment-helpers';

/**
 * Hoạt động Bài tập nộp tệp/ảnh (issue #88, lát C2 của Đợt 3) — đối
 * chiếu mod_assign của Moodle (submission type file/ảnh):
 *  - học sinh tải 1–nhiều ảnh/tệp vào bài nộp nháp (nội dung qua module
 *    Files: dedup theo content hash, xem qua signed URL), chốt nộp;
 *    nộp sau hạn vẫn được nhận nhưng bị đánh dấu trễ;
 *  - giáo viên xem danh sách bài nộp cả lớp, mở chi tiết kèm signed URL
 *    để xem toàn màn, nhập điểm + lời phê ngay trên bề mặt nộp — điểm
 *    ghi thẳng vào grade item 'mod' của course module nên hiện ở sổ
 *    điểm (gradebook) mà không cần nhập lần hai;
 *  - bài đã chấm thì khoá hẳn: không sửa, không mở lại được.
 */
describe('Assignment file submission (mod_assign)', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  interface Ctx {
    course: { id: string };
    sectionId: string;
    teacher: string;
    student: { id: string; username: string };
    studentToken: string;
    student2: { id: string; username: string };
    student2Token: string;
    outsiderToken: string;
  }

  async function setup(): Promise<Ctx> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;

    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const student2 = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student2.id);
    const student2Token = (await login(app, student2.username, STRONG_PASSWORD)).accessToken;

    const outsider = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    return { course, sectionId, teacher, student, studentToken, student2, student2Token, outsiderToken };
  }

  async function createAssignment(ctx: Ctx, overrides: Record<string, unknown> = {}): Promise<{ id: string; cmId: string; name: string; grade: number }> {
    const res = await http(app).post(`/api/v1/courses/${ctx.course.id}/assignments`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ sectionId: ctx.sectionId, name: 'Bài tập chụp vở', grade: 10, ...overrides });
    if (res.status !== 200 && res.status !== 201) throw new Error(`create assignment failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async function upload(token: string, assignmentId: string, fileName: string, content: string) {
    return http(app).post(`/api/v1/assignments/${assignmentId}/submission/files`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(content), fileName);
  }

  it('nộp → chấm → điểm hiện ở sổ điểm, học sinh thấy điểm + lời phê trong khoá', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx, { dueDate: new Date(Date.now() + 86_400_000).toISOString() });

    // Học sinh tải hai ảnh bài làm vào bài nộp nháp.
    const up1 = await upload(ctx.studentToken, assignment.id, 'trang-1.jpg', 'anh-bai-lam-trang-1');
    expect(up1.status).toBe(201);
    expect(up1.body.signedUrl).toBeTruthy();
    const up2 = await upload(ctx.studentToken, assignment.id, 'trang-2.jpg', 'anh-bai-lam-trang-2');
    expect(up2.status).toBe(201);
    expect(up2.body.contentHash).not.toBe(up1.body.contentHash);

    // Chưa nộp: trạng thái draft, 2 tệp.
    const draft = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(draft.status).toBe(200);
    expect(draft.body.mySubmission.status).toBe('draft');
    expect(draft.body.mySubmission.files).toHaveLength(2);
    expect(draft.body.mySubmission.grade).toBeNull();

    // Chốt nộp đúng hạn.
    const submitted = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(submitted.status).toBe(201);
    expect(submitted.body.mySubmission.status).toBe('submitted');
    expect(submitted.body.mySubmission.late).toBe(false);

    // Giáo viên: danh sách bài nộp cả lớp — student đã nộp 2 tệp; student2 chưa nộp (none).
    const list = await http(app).get(`/api/v1/assignments/${assignment.id}/submissions`).set('Authorization', `Bearer ${ctx.teacher}`);
    expect(list.status).toBe(200);
    const row = (list.body as { userId: string; status: string; fileCount: number }[]).find((r) => r.userId === ctx.student.id);
    expect(row?.status).toBe('submitted');
    expect(row?.fileCount).toBe(2);
    const row2 = (list.body as { userId: string; status: string }[]).find((r) => r.userId === ctx.student2.id);
    expect(row2?.status).toBe('none');

    // Giáo viên mở chi tiết: tệp kèm signed URL để xem toàn màn.
    const detail = await http(app).get(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}`).set('Authorization', `Bearer ${ctx.teacher}`);
    expect(detail.status).toBe(200);
    expect(detail.body.files).toHaveLength(2);
    expect(detail.body.files[0].signedUrl).toBeTruthy();

    // Chấm 8.5 + lời phê.
    const graded = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 8.5, feedback: 'Bài làm tốt, trình bày rõ ràng.' });
    expect(graded.status).toBe(201);
    expect(graded.body.status).toBe('graded');
    expect(graded.body.grade.grade).toBe(8.5);

    // Học sinh thấy điểm + lời phê ngay trong khoá.
    const mine = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(mine.body.mySubmission.status).toBe('graded');
    expect(mine.body.mySubmission.grade.grade).toBe(8.5);
    expect(mine.body.mySubmission.grade.feedback).toBe('Bài làm tốt, trình bày rõ ràng.');

    // Điểm đã chảy vào sổ điểm ở đúng grade item của hoạt động — không nhập lần hai.
    const book = await getGradebook(app, ctx.teacher, ctx.course.id, ctx.student.id);
    const items = book.categories.flatMap((c) => c.items);
    const item = items.find((i) => i.item.itemName === 'Bài tập chụp vở');
    expect(item).toBeTruthy();
    expect(item?.grade?.finalGrade).toBe(8.5);
  });

  it('nộp sau hạn vẫn được nhận nhưng bị đánh dấu trễ', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx, { dueDate: new Date(Date.now() - 3_600_000).toISOString() });
    const up = await upload(ctx.studentToken, assignment.id, 'bai-lam.jpg', 'anh-nop-tre');
    expect(up.status).toBe(201);
    const submitted = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(submitted.status).toBe(201);
    expect(submitted.body.mySubmission.late).toBe(true);
    const list = await http(app).get(`/api/v1/assignments/${assignment.id}/submissions`).set('Authorization', `Bearer ${ctx.teacher}`);
    const row = (list.body as { userId: string; late: boolean }[]).find((r) => r.userId === ctx.student.id);
    expect(row?.late).toBe(true);
  });

  it('quy tắc nộp/chấm: rỗng không nộp được, sai loại tệp bị chặn, chưa nộp không chấm được, đã chấm thì khoá', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx, { acceptedFileTypes: 'jpg,png' });

    // Chưa có tệp nào: mở lại/chốt nộp đều không có bài nộp.
    const submitEmpty = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(submitEmpty.status).toBe(404);

    // Sai loại tệp bị chặn; đúng loại thì được.
    const badType = await upload(ctx.studentToken, assignment.id, 'ghi-chu.txt', 'van-ban');
    expect(badType.status).toBe(400);
    const okType = await upload(ctx.studentToken, assignment.id, 'anh.png', 'anh-hop-le');
    expect(okType.status).toBe(201);

    // Bài nộp rỗng (có nháp nhưng gỡ hết tệp) không chốt nộp được.
    const removed = await http(app).delete(`/api/v1/assignments/${assignment.id}/submission/files/${okType.body.fileId}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(removed.status).toBe(200);
    const submitNoFiles = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(submitNoFiles.status).toBe(400);

    // Chấm bài chưa chốt nộp → 409; điểm vượt thang → 400 (sau khi đã nộp).
    await upload(ctx.studentToken, assignment.id, 'anh-2.png', 'anh-hop-le-2');
    const gradeDraft = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 5 });
    expect(gradeDraft.status).toBe(409);
    await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    const gradeTooHigh = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 11 });
    expect(gradeTooHigh.status).toBe(400);

    // Mở lại khi chưa chấm: về draft, lần nộp tăng; nộp lại được.
    const reopened = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/reopen`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(reopened.status).toBe(201);
    expect(reopened.body.mySubmission.status).toBe('draft');
    expect(reopened.body.mySubmission.attemptNumber).toBe(2);
    const resubmitted = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(resubmitted.status).toBe(201);
    expect(resubmitted.body.mySubmission.attemptNumber).toBe(2);

    // Chấm xong thì khoá: mở lại 409, tải thêm tệp 409.
    const graded = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 7, feedback: 'Đạt yêu cầu.' });
    expect(graded.status).toBe(201);
    const reopenLocked = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/reopen`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(reopenLocked.status).toBe(409);
    const uploadLocked = await upload(ctx.studentToken, assignment.id, 'them.png', 'anh-them');
    expect(uploadLocked.status).toBe(409);
  });

  it('gác quyền: người ngoài khoá không xem được bài tập, học sinh không chấm được bài của bạn', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx);
    const outsider = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.outsiderToken}`);
    expect(outsider.status).toBe(403);
    const outsiderList = await http(app).get(`/api/v1/assignments/${assignment.id}/submissions`).set('Authorization', `Bearer ${ctx.outsiderToken}`);
    expect(outsiderList.status).toBe(403);
    await upload(ctx.studentToken, assignment.id, 'bai.jpg', 'bai-cua-student');
    await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    const studentGrades = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.student2Token}`).send({ grade: 1 });
    expect(studentGrades.status).toBe(403);
  });

  it('hai học sinh nộp cùng một ảnh: nội dung được dedup theo content hash', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx);
    const sameBytes = 'anh-giong-nhau-ca-lop';
    const up1 = await upload(ctx.studentToken, assignment.id, 'a.jpg', sameBytes);
    const up2 = await upload(ctx.student2Token, assignment.id, 'b.jpg', sameBytes);
    expect(up1.status).toBe(201);
    expect(up2.status).toBe(201);
    expect(up2.body.contentHash).toBe(up1.body.contentHash);
    expect(up2.body.fileId).not.toBe(up1.body.fileId);
  });
});
