import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { getGradebook } from './assessment-helpers';

/**
 * Hoạt động Bài tập nộp tệp/ảnh (issue #88, lát C2 của Đợt 3) — đối
 * chiếu mod_assign của Moodle (submission type file/ảnh), đã hấp thụ hồ
 * sơ "Chấm bài và phản hồi theo năng lực GDPT 2018" (mục 6.1):
 *  - học sinh tải 1–nhiều ảnh/tệp vào bài nộp nháp (Files: dedup theo
 *    content hash, xem qua signed URL), chốt nộp; nộp sau hạn vẫn nhận
 *    nhưng bị đánh dấu trễ;
 *  - giáo viên chấm trên bề mặt nộp: dấu VECTOR trên ảnh (đúng/sai/ghi
 *    chú), điểm/mức + lời phê cấu trúc 3 ô — tất cả ở trạng thái NHÁP:
 *    học sinh chưa thấy gì, sổ điểm chưa nhận điểm;
 *  - TRẢ BÀI là hành động công bố nguyên tử: gói chấm hiện với học
 *    sinh, điểm ghi vào grade item 'mod' tại thời điểm trả nên hiện ở
 *    sổ điểm; sửa sau khi trả ghi vết kiểm toán; bài đã trả thì khoá;
 *  - bảng chấm rubric neo YCCĐ công khai trước khi nộp; chế độ chỉ-mức
 *    (Đạt/Chưa đạt) cho nhóm môn chỉ nhận xét; ngân hàng lời phê cá
 *    nhân của giáo viên; hội thoại phản hồi mở sau khi trả bài.
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

  async function submitFile(token: string, assignmentId: string, content = 'anh-bai-lam'): Promise<void> {
    const up = await upload(token, assignmentId, 'bai-lam.jpg', content);
    expect(up.status).toBe(201);
    const sub = await http(app).post(`/api/v1/assignments/${assignmentId}/submission/submit`).set('Authorization', `Bearer ${token}`);
    expect(sub.status).toBe(201);
  }

  async function gradebookGrade(ctx: Ctx, itemName: string, userId: string): Promise<number | null> {
    const book = await getGradebook(app, ctx.teacher, ctx.course.id, userId);
    const items = book.categories.flatMap((c) => c.items);
    const item = items.find((i) => i.item.itemName === itemName);
    expect(item).toBeTruthy();
    return item?.grade?.finalGrade ?? null;
  }

  it('nộp → chấm nháp (HS chưa thấy, sổ điểm chưa có) → trả bài (điểm hiện sổ điểm) → sửa sau trả ghi vết', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx, { dueDate: new Date(Date.now() + 86_400_000).toISOString() });

    const up1 = await upload(ctx.studentToken, assignment.id, 'trang-1.jpg', 'anh-bai-lam-trang-1');
    expect(up1.status).toBe(201);
    expect(up1.body.signedUrl).toBeTruthy();
    const up2 = await upload(ctx.studentToken, assignment.id, 'trang-2.jpg', 'anh-bai-lam-trang-2');
    expect(up2.status).toBe(201);
    expect(up2.body.contentHash).not.toBe(up1.body.contentHash);

    const draft = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(draft.status).toBe(200);
    expect(draft.body.mySubmission.status).toBe('draft');
    expect(draft.body.mySubmission.files).toHaveLength(2);
    expect(draft.body.mySubmission.grade).toBeNull();

    const submitted = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(submitted.status).toBe(201);
    expect(submitted.body.mySubmission.status).toBe('submitted');
    expect(submitted.body.mySubmission.late).toBe(false);

    const list = await http(app).get(`/api/v1/assignments/${assignment.id}/submissions`).set('Authorization', `Bearer ${ctx.teacher}`);
    expect(list.status).toBe(200);
    const row = (list.body as { userId: string; status: string; fileCount: number; gradeStatus: string }[]).find((r) => r.userId === ctx.student.id);
    expect(row?.status).toBe('submitted');
    expect(row?.fileCount).toBe(2);
    expect(row?.gradeStatus).toBe('none');
    const row2 = (list.body as { userId: string; status: string }[]).find((r) => r.userId === ctx.student2.id);
    expect(row2?.status).toBe('none');

    const detail = await http(app).get(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}`).set('Authorization', `Bearer ${ctx.teacher}`);
    expect(detail.status).toBe(200);
    expect(detail.body.files).toHaveLength(2);
    expect(detail.body.files[0].signedUrl).toBeTruthy();

    // Giáo viên thả dấu chấm VECTOR trên ảnh: 1 dấu đúng + 1 ghi chú tại vị trí.
    const ann1 = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/annotations`)
      .set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ fileId: up1.body.fileId, page: 1, x: 12.5, y: 30, kind: 'correct' });
    expect(ann1.status).toBe(201);
    expect(ann1.body.kind).toBe('correct');
    const ann2 = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/annotations`)
      .set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ fileId: up1.body.fileId, page: 1, x: 55, y: 61.25, kind: 'note', text: 'Chỗ này thiếu bước biến đổi.' });
    expect(ann2.status).toBe(201);

    // Lưu gói chấm NHÁP: 8.5 + lời phê cấu trúc 3 ô theo TT 22.
    const graded = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`)
      .send({
        grade: 8.5,
        feedbackStrengths: 'Trình bày rõ ràng, đủ các bước.',
        feedbackWeaknesses: 'Câu 2 còn thiếu bước biến đổi.',
        feedbackProgress: 'Tiến bộ rõ so với bài trước.',
      });
    expect(graded.status).toBe(201);
    expect(graded.body.grade.grade).toBe(8.5);
    expect(graded.body.grade.status).toBe('draft');
    expect(graded.body.grade.feedbackStrengths).toBe('Trình bày rõ ràng, đủ các bước.');
    expect(graded.body.status).toBe('submitted');
    expect(graded.body.annotations).toHaveLength(2);

    // Học sinh CHƯA thấy gì của gói nháp: không điểm, không annotation; sổ điểm chưa có điểm.
    const mineDraft = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(mineDraft.body.mySubmission.status).toBe('submitted');
    expect(mineDraft.body.mySubmission.grade).toBeNull();
    expect(mineDraft.body.mySubmission.annotations).toHaveLength(0);
    expect(await gradebookGrade(ctx, 'Bài tập chụp vở', ctx.student.id)).toBeNull();

    // TRẢ BÀI: công bố nguyên tử.
    const released = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/release`)
      .set('Authorization', `Bearer ${ctx.teacher}`);
    expect(released.status).toBe(201);
    expect(released.body.status).toBe('graded');
    expect(released.body.grade.status).toBe('released');
    expect(released.body.grade.releasedAt).toBeTruthy();

    const mine = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(mine.body.mySubmission.status).toBe('graded');
    expect(mine.body.mySubmission.grade.grade).toBe(8.5);
    expect(mine.body.mySubmission.grade.feedbackWeaknesses).toBe('Câu 2 còn thiếu bước biến đổi.');
    expect(mine.body.mySubmission.annotations).toHaveLength(2);
    expect(mine.body.mySubmission.annotations[0].kind).toBe('correct');
    expect(await gradebookGrade(ctx, 'Bài tập chụp vở', ctx.student.id)).toBe(8.5);

    // Sửa điểm SAU khi trả: ghi vết kiểm toán + sổ điểm cập nhật.
    const edited = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 9 });
    expect(edited.status).toBe(201);
    expect(edited.body.grade.grade).toBe(9);
    expect(edited.body.revisions).toHaveLength(1);
    expect(edited.body.revisions[0].previousGrade).toBe(8.5);
    expect(edited.body.revisions[0].newGrade).toBe(9);
    expect(await gradebookGrade(ctx, 'Bài tập chụp vở', ctx.student.id)).toBe(9);

    // Giáo viên xoá bớt một dấu: học sinh xem lại còn 1.
    const del = await http(app).delete(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/annotations/${ann2.body.id}`)
      .set('Authorization', `Bearer ${ctx.teacher}`);
    expect(del.status).toBe(200);
    const mineAfter = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(mineAfter.body.mySubmission.annotations).toHaveLength(1);
  });

  it('trả bài theo đợt: gói đầy đủ được trả, gói nháp dở dang bị bỏ qua và kê rõ', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx);
    await submitFile(ctx.studentToken, assignment.id, 'bai-s1');
    await submitFile(ctx.student2Token, assignment.id, 'bai-s2');

    await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 6 });
    // student2 mới có lời phê nháp, chưa có điểm → chưa đầy đủ để trả.
    await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student2.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ feedback: 'Cần bổ sung điểm.' });

    const batch = await http(app).post(`/api/v1/assignments/${assignment.id}/release-batch`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({});
    expect(batch.status).toBe(201);
    expect(batch.body.releasedCount).toBe(1);
    expect(batch.body.skippedUserIds).toEqual([ctx.student2.id]);

    // Trả lẻ gói chưa đầy đủ → 400; bổ sung điểm xong thì trả được.
    const incomplete = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student2.id}/release`)
      .set('Authorization', `Bearer ${ctx.teacher}`);
    expect(incomplete.status).toBe(400);
    await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student2.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 7.5 });
    const single = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student2.id}/release`)
      .set('Authorization', `Bearer ${ctx.teacher}`);
    expect(single.status).toBe(201);
    expect(await gradebookGrade(ctx, 'Bài tập chụp vở', ctx.student2.id)).toBe(7.5);
    // Trả lại lần hai → 409.
    const again = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student2.id}/release`)
      .set('Authorization', `Bearer ${ctx.teacher}`);
    expect(again.status).toBe(409);
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

  it('quy tắc nộp/chấm: rỗng không nộp được, sai loại tệp bị chặn, chưa nộp không chấm được, đã TRẢ mới khoá', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx, { acceptedFileTypes: 'jpg,png' });

    const submitEmpty = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(submitEmpty.status).toBe(404);

    const badType = await upload(ctx.studentToken, assignment.id, 'ghi-chu.txt', 'van-ban');
    expect(badType.status).toBe(400);
    const okType = await upload(ctx.studentToken, assignment.id, 'anh.png', 'anh-hop-le');
    expect(okType.status).toBe(201);

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

    // Chấm NHÁP chưa khoá: học sinh vẫn mở lại được (lần nộp tăng) — gói nháp cũ thành stale,
    // trả bài cho lần nộp cũ → 409 không có gì để trả.
    const draftSaved = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 7 });
    expect(draftSaved.status).toBe(201);
    const reopened = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/reopen`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(reopened.status).toBe(201);
    expect(reopened.body.mySubmission.status).toBe('draft');
    expect(reopened.body.mySubmission.attemptNumber).toBe(2);
    const staleRelease = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/release`)
      .set('Authorization', `Bearer ${ctx.teacher}`);
    expect(staleRelease.status).toBe(409);
    const resubmitted = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(resubmitted.status).toBe(201);
    expect(resubmitted.body.mySubmission.attemptNumber).toBe(2);

    // Chấm + trả bài xong thì khoá hẳn: mở lại 409, tải thêm tệp 409.
    await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 7, feedback: 'Đạt yêu cầu.' });
    const rel = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/release`)
      .set('Authorization', `Bearer ${ctx.teacher}`);
    expect(rel.status).toBe(201);
    const reopenLocked = await http(app).post(`/api/v1/assignments/${assignment.id}/submission/reopen`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(reopenLocked.status).toBe(409);
    const uploadLocked = await upload(ctx.studentToken, assignment.id, 'them.png', 'anh-them');
    expect(uploadLocked.status).toBe(409);
  });

  it('rubric neo YCCĐ + chế độ chỉ-mức: tiêu chí công khai trước khi nộp, mức Đạt/Chưa đạt khi trả bài', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx, { name: 'Bài tập thể chất', resultMode: 'level' });

    // Giáo viên dựng bảng chấm TRƯỚC khi có bài nộp: 1 tiêu chí chọn mức (neo YCCĐ) + 1 tiêu chí nhập điểm.
    const rubric = await http(app).put(`/api/v1/assignments/${assignment.id}/rubric`)
      .set('Authorization', `Bearer ${ctx.teacher}`)
      .send({
        title: 'Bảng chấm kỹ năng',
        criteria: [
          {
            name: 'Thực hiện đúng kỹ thuật', mode: 'levels',
            descriptionForStudent: 'Làm đúng các bước kỹ thuật đã học.',
            descriptionForGrader: 'Quan sát cả hai lượt thực hiện.',
            outcomeId: 'YCCD-GDTC-01', outcomeText: 'Thực hiện được động tác đúng kỹ thuật cơ bản.',
            levels: [{ label: 'Chưa đạt', score: 0 }, { label: 'Đạt', score: 1 }],
          },
          { name: 'Tinh thần luyện tập', mode: 'score', maxScore: 10 },
        ],
      });
    expect(rubric.status).toBe(200);
    expect(rubric.body.criteria).toHaveLength(2);
    const criterionLevels = rubric.body.criteria[0];
    const criterionScore = rubric.body.criteria[1];

    // Học sinh thấy bảng chấm công khai trong trang bài TRƯỚC khi nộp; mô tả nội bộ của người chấm bị ẩn.
    const view = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(view.status).toBe(200);
    expect(view.body.assignment.resultMode).toBe('level');
    expect(view.body.rubric.criteria).toHaveLength(2);
    expect(view.body.rubric.criteria[0].outcomeText).toContain('động tác');
    expect(view.body.rubric.criteria[0].descriptionForGrader).toBeNull();
    expect(view.body.rubric.criteria[0].levels.map((l: { label: string }) => l.label)).toEqual(['Chưa đạt', 'Đạt']);

    await submitFile(ctx.studentToken, assignment.id, 'clip-bai-lam');

    // Chấm chế độ chỉ-mức: mức 'dat' + kết quả theo tiêu chí; không cần điểm tổng.
    const graded = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`)
      .send({
        level: 'dat',
        feedbackStrengths: 'Động tác chắc, đúng nhịp.',
        evaluations: [
          { criterionId: criterionLevels.id, levelId: criterionLevels.levels[1].id },
          { criterionId: criterionScore.id, score: 8, note: 'Tích cực.' },
        ],
      });
    expect(graded.status).toBe(201);
    expect(graded.body.grade.level).toBe('dat');
    expect(graded.body.rubricEvaluations).toHaveLength(2);

    // Chưa trả: học sinh chưa thấy mức; trả xong thì thấy mức + kết quả rubric, sổ điểm nhận 1 (Đạt trên thang 1).
    const before = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(before.body.mySubmission.grade).toBeNull();
    const rel = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/release`)
      .set('Authorization', `Bearer ${ctx.teacher}`);
    expect(rel.status).toBe(201);
    const after = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(after.body.mySubmission.grade.level).toBe('dat');
    expect(after.body.mySubmission.rubricEvaluations).toHaveLength(2);
    expect(await gradebookGrade(ctx, 'Bài tập thể chất', ctx.student.id)).toBe(1);

    // Bảng chấm bị khoá sau khi đã có bài được trả.
    const locked = await http(app).put(`/api/v1/assignments/${assignment.id}/rubric`)
      .set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ criteria: [{ name: 'Tiêu chí khác', mode: 'score', maxScore: 5 }] });
    expect(locked.status).toBe(409);
  });

  it('ngân hàng lời phê cá nhân + hội thoại phản hồi sau trả bài', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx);

    // Comment bank: giáo viên thêm 2 câu, thấy đúng kho của mình; học sinh có kho riêng (rỗng).
    const e1 = await http(app).post('/api/v1/assign-comment-bank').set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ text: 'Trình bày sạch đẹp, tiếp tục phát huy.', category: 'strengths' });
    expect(e1.status).toBe(201);
    const e2 = await http(app).post('/api/v1/assign-comment-bank').set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ text: 'Cần trình bày đủ các bước biến đổi.' });
    expect(e2.status).toBe(201);
    const bank = await http(app).get('/api/v1/assign-comment-bank').set('Authorization', `Bearer ${ctx.teacher}`);
    expect(bank.body).toHaveLength(2);
    const bankStudent = await http(app).get('/api/v1/assign-comment-bank').set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(bankStudent.body).toHaveLength(0);
    const delEntry = await http(app).delete(`/api/v1/assign-comment-bank/${e2.body.id}`).set('Authorization', `Bearer ${ctx.teacher}`);
    expect(delEntry.status).toBe(200);
    const bankAfter = await http(app).get('/api/v1/assign-comment-bank').set('Authorization', `Bearer ${ctx.teacher}`);
    expect(bankAfter.body).toHaveLength(1);

    // Hội thoại phản hồi: chưa trả bài thì chưa mở.
    await submitFile(ctx.studentToken, assignment.id, 'bai-hoi-thoai');
    const tooEarly = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/messages`)
      .set('Authorization', `Bearer ${ctx.studentToken}`).send({ body: 'Thầy ơi em hỏi?' });
    expect(tooEarly.status).toBe(409);
    await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 8, feedbackStrengths: 'Làm tốt.' });
    await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/release`)
      .set('Authorization', `Bearer ${ctx.teacher}`);

    const m1 = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/messages`)
      .set('Authorization', `Bearer ${ctx.studentToken}`).send({ body: 'Thưa thầy, câu 2 em sai ở bước nào ạ?' });
    expect(m1.status).toBe(201);
    const m2 = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/messages`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ body: 'Em xem dấu ghi chú trên ảnh trang 1 nhé.' });
    expect(m2.status).toBe(201);
    const thread = await http(app).get(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/messages`)
      .set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(thread.body).toHaveLength(2);
    // Học sinh khác không xem được hội thoại của bạn.
    const otherThread = await http(app).get(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/messages`)
      .set('Authorization', `Bearer ${ctx.student2Token}`);
    expect(otherThread.status).toBe(403);
  });

  it('gác quyền: người ngoài khoá không xem được bài tập, học sinh không chấm/trả bài/đặt dấu thay giáo viên', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx);
    const outsider = await http(app).get(`/api/v1/assignments/${assignment.id}`).set('Authorization', `Bearer ${ctx.outsiderToken}`);
    expect(outsider.status).toBe(403);
    const outsiderList = await http(app).get(`/api/v1/assignments/${assignment.id}/submissions`).set('Authorization', `Bearer ${ctx.outsiderToken}`);
    expect(outsiderList.status).toBe(403);
    const up = await upload(ctx.studentToken, assignment.id, 'bai.jpg', 'bai-cua-student');
    await http(app).post(`/api/v1/assignments/${assignment.id}/submission/submit`).set('Authorization', `Bearer ${ctx.studentToken}`);
    const studentGrades = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.student2Token}`).send({ grade: 1 });
    expect(studentGrades.status).toBe(403);
    const studentRelease = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/release`)
      .set('Authorization', `Bearer ${ctx.student2Token}`);
    expect(studentRelease.status).toBe(403);
    const studentAnnotates = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/annotations`)
      .set('Authorization', `Bearer ${ctx.student2Token}`)
      .send({ fileId: up.body.fileId, x: 1, y: 1, kind: 'correct' });
    expect(studentAnnotates.status).toBe(403);
    const studentRubric = await http(app).put(`/api/v1/assignments/${assignment.id}/rubric`)
      .set('Authorization', `Bearer ${ctx.student2Token}`)
      .send({ criteria: [{ name: 'X', mode: 'score', maxScore: 5 }] });
    expect(studentRubric.status).toBe(403);
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
