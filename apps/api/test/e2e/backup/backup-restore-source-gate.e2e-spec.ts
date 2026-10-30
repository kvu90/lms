import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse } from '../../support/course-enrolment-helpers';
import { courseContextId } from '../../support/engagement-helpers';

/**
 * Cổng đọc tại khoá NGUỒN cho đường restore backup: restore là đường
 * chép toàn bộ dữ kiện của khoá nguồn (ngân hàng câu hỏi kèm đáp án và
 * lời giải, điểm, ghi danh, tệp) sang khoá khác, nên người gọi phải qua
 * cùng cổng đọc job như các đường đọc (`backup:backupcourse` hoặc
 * `backup:restorecourse` tại context của khoá thuộc job) TRƯỚC mọi xử
 * lý archive và trước mọi kiểm tra phía đích. Biết ID của job không
 * đồng nghĩa có quyền trên dữ kiện của job.
 *
 * Kịch bản: giáo viên có `backup:restorecourse` tại khoá ĐÍCH của mình
 * (quyền mặc định của editingteacher tại context khoá) nhưng không có
 * quyền gì tại khoá NGUỒN:
 *  - đọc job nguồn: 403 `backup.job_forbidden` (hành vi sẵn có, đối chứng);
 *  - restore `merge` vào khoá của mình: 403 `backup.job_forbidden`,
 *    không job restore nào được tạo, ngân hàng câu hỏi của khoá đích
 *    vẫn trống;
 *  - restore `new`: cũng 403 `backup.job_forbidden` — cổng nguồn chạy
 *    trước kiểm tra phía đích nên mã lỗi là của cổng nguồn, không còn
 *    là lỗi capability phía đích như trước khi vá;
 *  - sau khi được cấp quyền tại khoá nguồn, cùng lời gọi `merge` chạy
 *    hoàn tất và dữ kiện nguồn (danh mục câu hỏi + câu hỏi) xuất hiện
 *    ở khoá đích.
 */
describe('Cổng đọc nguồn khôi phục sao lưu', () => {
  let app: INestApplication;
  let admin: string;
  let sourceCourseId: string;
  let targetCourseId: string;
  let targetCtxId: string;
  let backupJobId: string;
  let actorId: string;
  let actor: string;

  const tfBody = (stem: string, values: boolean[]) => ({
    qtype: 'truefalse',
    questionText: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: stem }] },
        {
          type: 'statementList',
          content: values.map((v, i) => ({
            type: 'statement',
            attrs: { id: `s${i + 1}` },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `${stem} — ý ${i + 1}` }] }],
          })),
        },
      ],
    },
    solution: { answers: values.map((v, i) => ({ statementId: `s${i + 1}`, value: v })) },
  });

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const suffix = `${Date.now()}`;

    // Khoá NGUỒN thuộc danh mục riêng, có ngân hàng câu hỏi trong
    // context của khoá (1 danh mục + 1 câu đúng/sai kèm lời giải qua
    // solution) để archive chứa dữ kiện nhạy cảm thật.
    const sourceCat = await createCategory(app, admin, { name: `Source cat ${suffix}` });
    const source = await createCourse(app, admin, sourceCat.id);
    sourceCourseId = source.id;
    const sourceCtx = await courseContextId(app, admin, sourceCourseId);
    const bankCat = await http(app).post('/api/v1/questions/categories')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: `Source bank ${suffix}`, contextId: sourceCtx });
    expect(bankCat.status).toBeLessThan(300);
    const q = await http(app).post('/api/v1/questions')
      .set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: bankCat.body.id, ...tfBody('Source secret question.', [true, false, true, false]) });
    expect(q.status).toBeLessThan(300);

    const backup = await http(app).post('/api/v1/backup/jobs')
      .set('Authorization', `Bearer ${admin}`).send({ courseId: sourceCourseId });
    expect(backup.status).toBeLessThan(300);
    expect(backup.body.status).toBe('completed');
    backupJobId = backup.body.id as string;

    // Khoá ĐÍCH thuộc danh mục khác; actor là editingteacher tại khoá
    // đích (có sẵn backup:restorecourse tại context khoá đích theo
    // archetype) và không có quyền gì ở phía nguồn.
    const targetCat = await createCategory(app, admin, { name: `Target cat ${suffix}` });
    const target = await createCourse(app, admin, targetCat.id);
    targetCourseId = target.id;
    targetCtxId = await courseContextId(app, admin, targetCourseId);
    const actorUser = await createUserViaApi(app, admin);
    actorId = actorUser.id;
    const teacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, actorUser.id, teacherRole, targetCtxId);
    actor = (await login(app, actorUser.username, STRONG_PASSWORD)).accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('từ chối đọc job sao lưu nguồn đối với actor thiếu quyền nguồn (đối chứng)', async () => {
    const read = await http(app).get(`/api/v1/backup/jobs/${backupJobId}`)
      .set('Authorization', `Bearer ${actor}`);
    expect(read.status).toBe(403);
    expect(read.body.code).toBe('backup.job_forbidden');
    const list = await http(app).get('/api/v1/backup/jobs').set('Authorization', `Bearer ${actor}`);
    expect((list.body as { id: string }[]).map((j) => j.id)).not.toContain(backupJobId);
  });

  it('từ chối restore merge bằng backup.job_forbidden và không ghi gì vào khoá đích', async () => {
    const denied = await http(app).post('/api/v1/backup/restore')
      .set('Authorization', `Bearer ${actor}`)
      .send({ backupJobId, mode: 'merge', targetCourseId });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('backup.job_forbidden');

    // Không job restore nào được tạo cho lần gọi bị từ chối.
    const jobs = await http(app).get('/api/v1/backup/jobs').set('Authorization', `Bearer ${admin}`);
    const actorRestores = (jobs.body as { type: string; userId: string }[])
      .filter((j) => j.type === 'restore' && j.userId === actorId);
    expect(actorRestores).toHaveLength(0);

    // Khoá đích không đổi: ngân hàng câu hỏi của khoá đích vẫn trống.
    const cats = await http(app).get('/api/v1/questions/categories')
      .query({ contextId: targetCtxId }).set('Authorization', `Bearer ${admin}`);
    expect(cats.body).toHaveLength(0);
  });

  it('từ chối restore new tại cổng nguồn trước mọi kiểm tra đích', async () => {
    const denied = await http(app).post('/api/v1/backup/restore')
      .set('Authorization', `Bearer ${actor}`)
      .send({ backupJobId, mode: 'new' });
    expect(denied.status).toBe(403);
    // Mã lỗi phải là của cổng NGUỒN: trước khi vá, lời gọi này bị chặn
    // ở kiểm tra capability tại context danh mục của khoá nguồn với mã
    // access.capability_denied (hoặc chạy qua nếu có quyền danh mục).
    expect(denied.body.code).toBe('backup.job_forbidden');
  });

  it('khôi phục như trước khi actor đọc được job nguồn', async () => {
    const sourceCtx = await courseContextId(app, admin, sourceCourseId);
    const teacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, actorId, teacherRole, sourceCtx);

    const restore = await http(app).post('/api/v1/backup/restore')
      .set('Authorization', `Bearer ${actor}`)
      .send({ backupJobId, mode: 'merge', targetCourseId });
    expect(restore.status).toBeLessThan(300);
    expect(restore.body.status).toBe('completed');
    expect(restore.body.targetCourseId).toBe(targetCourseId);

    // Dữ kiện nguồn đã sang đích: danh mục câu hỏi kèm câu hỏi của
    // khoá nguồn xuất hiện trong context của khoá đích.
    const cats = await http(app).get('/api/v1/questions/categories')
      .query({ contextId: targetCtxId }).set('Authorization', `Bearer ${admin}`);
    expect((cats.body as { id: string }[]).length).toBeGreaterThanOrEqual(1);
    const restoredCat = (cats.body as { id: string }[])[0]!;
    const questions = await http(app).get(`/api/v1/questions/categories/${restoredCat.id}/questions`)
      .set('Authorization', `Bearer ${admin}`);
    expect(questions.body).toHaveLength(1);
  });
});
