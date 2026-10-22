import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createP1TestApp, createUserViaApi, http, roleIdByShortname, systemContextId, uniqueName,
} from './p1-helpers';
import { createCategory, createCourse } from './p2-helpers';

/**
 * Luồng i18n của các dịch vụ nền tảng: API trả text hiển thị tiếng Việt khi
 * request không có Accept-Language (mặc định 'vi') và tiếng Anh khi
 * `Accept-Language: en` — kiểm trên hai luồng vàng:
 * (1) lỗi 403 của external function (token của student gọi function cần
 * capability giáo viên) — detail tra theo error code trong catalog;
 * (2) lỗi validation của payments — thông điệp Zod được dịch qua ánh xạ
 * issue code → khoá catalog `validation.*` bởi pipe Standard Schema có i18n.
 * Mã lỗi ổn định (`code`) luôn giữ tiếng Anh ở cả hai ngôn ngữ.
 */
describe('Platform i18n flow (e2e)', () => {
  let app: INestApplication;
  let admin: string;
  let externalToken: string;
  let courseId: number;

  beforeAll(async () => {
    app = await createP1TestApp();
    admin = await adminToken(app);
    const auth = { Authorization: `Bearer ${admin}` };
    const student = await createUserViaApi(app, admin, { username: uniqueName('i18nstudent') });
    const sysCtx = await systemContextId(app, admin);
    await assignRole(app, admin, student.id, await roleIdByShortname(app, admin, 'student'), sysCtx);
    const svc = await http(app).post('/api/v1/webservice/services').set(auth)
      .send({ name: uniqueName('I18n Svc'), shortname: uniqueName('i18nsvc'), enabled: true, functions: ['core_course_get_courses', 'core_grades_update_grades'] }).expect(201);
    const tok = await http(app).post('/api/v1/webservice/tokens').set(auth)
      .send({ userid: student.id, serviceid: svc.body.id }).expect(201);
    externalToken = tok.body.token as string;
    const category = await createCategory(app, admin, {});
    courseId = (await createCourse(app, admin, category.id, {})).id;
  });
  afterAll(async () => { await app.close(); });

  it('returns the Vietnamese detail by default and the English detail with Accept-Language: en for the token capability 403', async () => {
    const call = (headers: Record<string, string>) =>
      http(app).post('/api/v1/webservice/call').set(headers)
        .send({ token: externalToken, functionName: 'core_grades_update_grades', args: { courseId } });

    const vi = await call({}).expect(403);
    expect(vi.body.code).toBe('webservice.capability_denied');
    expect(vi.body.detail).toBe('Chủ sở hữu token không có quyền thực hiện chức năng này');

    const en = await call({ 'Accept-Language': 'en' }).expect(403);
    expect(en.body.code).toBe('webservice.capability_denied');
    expect(en.body.detail).toBe('The token owner lacks the capability to perform this function');
  });

  it('returns localized Zod validation messages for payments in Vietnamese by default and English on request', async () => {
    const auth = { Authorization: `Bearer ${admin}` };
    const bad = (headers: Record<string, string>) =>
      http(app).post('/api/v1/payments/accounts').set(auth).set(headers).send({});

    const vi = await bad({}).expect(400);
    expect(vi.body.code).toBe('http.validation_failed');
    const viMessages = (vi.body.errors as { message: string }[]).map((e) => e.message).join(' ');
    expect(viMessages).toContain('là trường bắt buộc');

    const en = await bad({ 'Accept-Language': 'en' }).expect(400);
    const enMessages = (en.body.errors as { message: string }[]).map((e) => e.message).join(' ');
    expect(enMessages).toContain('is required');
  });
});
