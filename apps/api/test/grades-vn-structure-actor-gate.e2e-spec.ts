import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * Cứng hoá actor cho các GET CẤU TRÚC của VnGradebooksController (việc nối
 * tiếp #104, ghi nhận không chặn của đánh giá độc lập GB-VN-2 — phán quyết
 * 6389458366). Ba route chỉ trả cấu trúc sổ/khai vai trò (không có điểm của
 * bất kỳ học sinh nào) nhưng trước lát này không nhận actor: học sinh và cả
 * người ngoài khoá đã đăng nhập đều đọc được 200. Nay cả ba gác
 * `grade:viewall` tại context khoá qua requireCap — 403
 * `access.capability_denied`, đúng tiền lệ cổng candidates/results của chính
 * controller. Các route GET đã gác từ trước (results, snapshots,
 * vn-year-results, candidates) không thuộc lát này và có spec riêng.
 */
describe('Gác actor GET cấu trúc sổ VN (nối tiếp #104)', () => {
  let app: INestApplication;
  let admin: string;
  let catId: string;

  interface VnItem { id: string; vnRole: string | null; vnOrdinal: number | null }
  interface VnBookView { book: { id: string; courseId: string; term: string; dgtxQuota: number }; items: VnItem[] }
  interface MappingView { id: string; cmId: string; targetRole: string | null }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    catId = (await createCategory(app, admin)).id;
  });
  afterAll(async () => { await app.close(); });

  it('cả 3 GET cấu trúc: học sinh/người ngoài khoá → 403 access.capability_denied, ẩn danh → 401, GV có grade:viewall + admin → 200 payload nguyên vẹn', async () => {
    // Khoá + học sinh đã ghi danh + người ngoài khoá + GV được gán vai tại khoá.
    const course = await createCourse(app, admin, catId);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const outsider = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacherToken = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;

    // Sổ hk1 môn 35 tiết/năm → quota 2 (cột dgtx1, dgtx2, dggk, dgck) + 1 khai vai trò.
    const bookRes = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books`)
      .set('Authorization', `Bearer ${admin}`).send({ term: 'hk1', subjectPeriodsPerYear: 35 });
    expect(bookRes.status).toBe(201);
    const book = bookRes.body as VnBookView;
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const quizRes = await http(app).post(`/api/v1/courses/${course.id}/quizzes`)
      .set('Authorization', `Bearer ${admin}`).send({ sectionId, name: 'KT giữa kì', grade: 40 });
    expect(quizRes.status).toBe(201);
    const quiz = quizRes.body as { id: string; cmId: string };
    const mapRes = await http(app).post(`/api/v1/courses/${course.id}/grades/vn-books/${book.book.id}/activity-mappings`)
      .set('Authorization', `Bearer ${admin}`).send({ cmId: quiz.cmId, role: 'dggk' });
    expect(mapRes.status).toBe(201);

    const listUrl = `/api/v1/courses/${course.id}/grades/vn-books`;
    const bookUrl = `${listUrl}/${book.book.id}`;
    const mappingsUrl = `${bookUrl}/activity-mappings`;
    const urls = [listUrl, bookUrl, mappingsUrl];

    // Ca bị chặn: học sinh đã ghi danh và người ngoài khoá đều 403 đúng mã của requireCapability ở cả 3 bề mặt.
    for (const token of [studentToken, outsiderToken]) {
      for (const url of urls) {
        const res = await http(app).get(url).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('access.capability_denied');
      }
    }
    // Ẩn danh vẫn 401 như trước lát này (guard xác thực chạy trước cổng capability).
    for (const url of urls) {
      const res = await http(app).get(url);
      expect(res.status).toBe(401);
    }

    // Ca hợp lệ: GV (grade:viewall tại khoá) đọc được cả 3, nội dung đúng cấu trúc đã tạo.
    const teacherList = await http(app).get(listUrl).set('Authorization', `Bearer ${teacherToken}`);
    expect(teacherList.status).toBe(200);
    const teacherBooks = teacherList.body as VnBookView[];
    expect(teacherBooks.length).toBe(1);
    expect(teacherBooks[0]!.book.id).toBe(book.book.id);
    expect(teacherBooks[0]!.items.length).toBe(4);

    const teacherBook = await http(app).get(bookUrl).set('Authorization', `Bearer ${teacherToken}`);
    expect(teacherBook.status).toBe(200);
    expect((teacherBook.body as VnBookView).book.id).toBe(book.book.id);
    expect((teacherBook.body as VnBookView).items.map((i) => i.vnRole)).toEqual(['dgtx', 'dgtx', 'dggk', 'dgck']);

    const teacherMappings = await http(app).get(mappingsUrl).set('Authorization', `Bearer ${teacherToken}`);
    expect(teacherMappings.status).toBe(200);
    const mappings = teacherMappings.body as MappingView[];
    expect(mappings.length).toBe(1);
    expect(mappings[0]!.cmId).toBe(quiz.cmId);
    expect(mappings[0]!.targetRole).toBe('dggk');

    // Admin đọc được và payload KHÔNG đổi so với phía GV (hành vi hợp lệ giữ nguyên hệt).
    const adminBook = await http(app).get(bookUrl).set('Authorization', `Bearer ${admin}`);
    expect(adminBook.status).toBe(200);
    expect(adminBook.body).toEqual(teacherBook.body);
    const adminMappings = await http(app).get(mappingsUrl).set('Authorization', `Bearer ${admin}`);
    expect(adminMappings.status).toBe(200);
    expect(adminMappings.body).toEqual(teacherMappings.body);
    const adminList = await http(app).get(listUrl).set('Authorization', `Bearer ${admin}`);
    expect(adminList.status).toBe(200);
    expect(adminList.body).toEqual(teacherList.body);
  });

  it('sổ không tồn tại với GV hợp lệ vẫn 404 đúng mã cũ (thứ tự kiểm tồn tại trước cổng không đổi)', async () => {
    const course = await createCourse(app, admin, catId);
    const missingBookUrl = `/api/v1/courses/${course.id}/grades/vn-books/00000000-0000-7000-8000-000000000000`;
    const res = await http(app).get(missingBookUrl).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('grades.vn_book_not_found');
  });
});
