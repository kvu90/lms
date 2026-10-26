import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { addExamSlot, createExamDraft, pinExam } from './exam-pin-helpers';

/**
 * Issue #248 (lát QE-2) — luồng ảnh nhúng trong câu hỏi, đầu-cuối:
 * giáo viên tải ảnh vào bank CÁ NHÂN của mình (endpoint chỉ nhận ảnh
 * thật theo magic bytes), ảnh nằm trong thân câu bằng định danh bền;
 * học sinh ghi danh trong khoá làm bài thì THẤY ảnh (server phát URL
 * ký ở bề mặt attempt) và tải được byte ảnh từ URL ký đó mà không cần
 * đăng nhập — nhưng học sinh KHÔNG tự mint được URL ký cũng như
 * không đọc thẳng được file qua các đường có gác, vì em không có
 * quyền tại context bank cá nhân của giáo viên.
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface BankBody { id: string; scope: string; bankKind: string; ownerId: string | null; defaultCategoryId: string | null }
interface CtxBody { id: string; contextLevel: number; instanceId: string }

function imageSrcOf(doc: unknown): string | null {
  let found: string | null = null;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      if (rec.type === 'image' && rec.attrs && typeof rec.attrs === 'object') {
        const src = (rec.attrs as Record<string, unknown>).src;
        if (typeof src === 'string') found = src;
      }
      Object.values(rec).forEach(walk);
    }
  };
  walk(doc);
  return found;
}

describe('Ảnh nhúng câu hỏi: GV tải vào bank cá nhân → HS thấy trong bài làm (issue #248)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  }, 180_000);
  afterAll(async () => { await pg.end(); await app.close(); });

  async function mkUser(): Promise<{ id: string; token: string }> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, token: session.accessToken };
  }

  interface Flow {
    teacher: { id: string; token: string };
    student: { id: string; token: string };
    courseId: string; sectionId: string;
    bankCtxId: string; personalCatId: string;
    fileId: string; canonicalSrc: string;
  }
  let flowPromise: Promise<Flow> | null = null;
  function flow(): Promise<Flow> {
    if (!flowPromise) flowPromise = buildFlow();
    return flowPromise;
  }

  async function buildFlow(): Promise<Flow> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const ctxList = contexts.body as CtxBody[];
    const courseCtx = ctxList.find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;

    const teacher = await mkUser();
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const student = await mkUser();
    await enrolUser(app, admin, course.id, instance.id, student.id);

    const banksRes = await http(app).get('/api/v1/question-banks?kind=question').set(bearer(teacher.token));
    expect(banksRes.status).toBe(200);
    const personal = (banksRes.body as BankBody[])
      .find((b) => b.scope === 'personal' && b.bankKind === 'question' && b.ownerId === teacher.id)!;
    expect(personal?.defaultCategoryId).toBeTruthy();
    const bankCtx = ctxList.find((c) => c.instanceId === personal.id)!;
    expect(bankCtx).toBeTruthy();

    const up = await http(app).post('/api/v1/files/question-image').set(bearer(teacher.token))
      .field('contextId', bankCtx.id).field('fileArea', 'questiontext')
      .attach('file', PNG_1PX, 'so-do.png');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const fileId = up.body.id as string;
    const canonicalSrc = up.body.src as string;
    expect(canonicalSrc).toBe(`/api/v1/files/${fileId}/content`);

    return {
      teacher, student, courseId: course.id, sectionId,
      bankCtxId: bankCtx.id, personalCatId: personal.defaultCategoryId!,
      fileId, canonicalSrc,
    };
  }

  it('cổng tải lên: file chữ giả danh ảnh bị 400 file.not_image; học sinh tải vào context bank của GV bị 403', async () => {
    const f = await flow();
    const fake = await http(app).post('/api/v1/files/question-image').set(bearer(f.teacher.token))
      .field('contextId', f.bankCtxId).field('fileArea', 'questiontext')
      .attach('file', Buffer.from('day la chu, khong phai anh'), 'anh.png');
    expect(fake.status).toBe(400);
    expect(fake.body.code).toBe('file.not_image');

    const byStudent = await http(app).post('/api/v1/files/question-image').set(bearer(f.student.token))
      .field('contextId', f.bankCtxId).field('fileArea', 'questiontext')
      .attach('file', PNG_1PX, 'le.png');
    expect(byStudent.status).toBe(403);
  }, 180_000);

  it('đầu-cuối: ảnh trong thân câu tới học sinh qua URL ký ở attempt; đường trực tiếp vẫn khoá với học sinh', async () => {
    const f = await flow();

    // GV tạo câu trong bank cá nhân (API nhận thân câu dạng chuỗi thường).
    const created = await http(app).post('/api/v1/questions').set(bearer(f.teacher.token)).send({
      categoryId: f.personalCatId, qtype: 'multichoice', name: 'Câu có hình 248',
      questionText: 'Nhìn hình rồi chọn đáp án đúng?', defaultMark: 1,
      answers: [{ text: 'Đáp án đúng', fraction: 1 }, { text: 'Đáp án sai', fraction: 0 }],
      options: { single: true },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const questionId = created.body.question.id as string;

    // Chèn node ảnh (định danh bền) vào thân câu của version hiện hành —
    // mô phỏng đúng tài liệu editor QE-1 sẽ lưu khi contracts có node image.
    const view0 = await http(app).get(`/api/v1/questions/${questionId}`).set(bearer(f.teacher.token));
    expect(view0.status).toBe(200);
    const versionId = view0.body.latestVersion.id as string;
    const docWithImage = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Nhìn hình rồi chọn đáp án đúng?' },
          { type: 'image', attrs: { src: f.canonicalSrc, alt: 'so-do' } },
        ],
      }],
    };
    await pg.query('UPDATE question_versions SET question_text = $1::jsonb WHERE id = $2', [JSON.stringify(docWithImage), versionId]);

    // GV đọc lại câu: bề mặt đọc đã phát URL ký thay định danh bền.
    const viewTeacher = await http(app).get(`/api/v1/questions/${questionId}`).set(bearer(f.teacher.token));
    expect(viewTeacher.status).toBe(200);
    expect(imageSrcOf(viewTeacher.body.latestVersion.questionText)).toContain('/download?sig=');

    // Ghim câu vào khoá, học sinh bắt đầu làm bài.
    const draft = await createExamDraft(app, f.teacher.token, 'Đề có câu hình 248', 10);
    await addExamSlot(app, f.teacher.token, draft, { questionId });
    const pin = await pinExam(app, f.teacher.token, f.courseId, draft, { sectionId: f.sectionId });
    const start = await http(app).post(`/api/v1/exam-pins/${pin.id}/attempts`).set(bearer(f.student.token)).send({});
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const q = (start.body.questions as { questionId: string; questionText: unknown }[])
      .find((x) => x.questionId === questionId)!;
    expect(q).toBeTruthy();
    const servedSrc = imageSrcOf(q.questionText);
    expect(servedSrc).toBeTruthy();
    expect(servedSrc).toContain('/download?sig=');
    expect(servedSrc).not.toBe(f.canonicalSrc);

    // URL ký tải được byte ảnh KHÔNG cần đăng nhập (đúng bản chất URL ký).
    const dl = await http(app).get(servedSrc as string).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(PNG_1PX)).toBe(true);

    // Nhưng học sinh không tự lấy được URL ký cũng không đọc thẳng được
    // file: em không có files:view tại context bank cá nhân của GV.
    const mint = await http(app).post(`/api/v1/files/${f.fileId}/signed-url`).set(bearer(f.student.token)).send({});
    expect(mint.status).toBe(403);
    const direct = await http(app).get(`/api/v1/files/${f.fileId}/content`).set(bearer(f.student.token));
    expect(direct.status).toBe(403);
  }, 180_000);
});
