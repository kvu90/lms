import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, systemContextId, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { courseContextId } from './engagement-helpers';
import { createGradeItem, setGrade } from './assessment-helpers';

/**
 * Khoá lỗ hổng đợt rà soát gác quyền #134 — H3 (payments read), H4 (analytics
 * insights toàn cục), H6 (analytics run không uỷ quyền).
 * - H3: GET /payments/:id + /:id/refunds chỉ chủ sở hữu hoặc holder
 *   payment:manageaccounts tại system đọc được; người ngoài nhận 404
 *   payment.not_found (không lộ tồn tại). GET /payments/accounts đòi
 *   payment:manageaccounts (403 khi thiếu) như các route quản trị của module.
 * - H4: GET /analytics/insights lọc theo analytics:viewinsights tại context
 *   của từng dòng — đúng vị từ của /insights/me.
 * - H6: POST /analytics/models/:name/run đòi analytics:manage tại context
 *   khoá cho người gọi (403 khi thiếu; holder tại system qua nhờ cây context).
 */
describe('Guard H3+H4+H6: payments read + analytics insights/run', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  async function managerUser() {
    const user = await createUserViaApi(app, admin);
    const sysCtx = await systemContextId(app, admin);
    await assignRole(app, admin, user.id, await roleIdByShortname(app, admin, 'manager'), sysCtx);
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { user, token };
  }

  it('H3: only the owner or a payment:manageaccounts holder can read a payment and its refunds; accounts list is manager-only', async () => {
    const account = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Acct ${Date.now()}`, gateway: 'manual' });
    expect(account.status).toBeLessThan(300);

    const owner = await createUserViaApi(app, admin);
    const ownerToken = (await login(app, owner.username, STRONG_PASSWORD)).accessToken;
    const payment = await http(app).post('/api/v1/payments').set('Authorization', `Bearer ${ownerToken}`)
      .send({ accountId: account.body.id, amount: 120000, currency: 'VND' });
    expect(payment.status).toBeLessThan(300);
    expect(payment.body.userId).toBe(owner.id);

    // Chủ sở hữu đọc được payment + refunds của mình.
    const ownRead = await http(app).get(`/api/v1/payments/${payment.body.id}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(ownRead.status).toBe(200);
    expect(ownRead.body.id).toBe(payment.body.id);
    const ownRefunds = await http(app).get(`/api/v1/payments/${payment.body.id}/refunds`).set('Authorization', `Bearer ${ownerToken}`);
    expect(ownRefunds.status).toBe(200);
    expect(ownRefunds.body).toEqual([]);

    // User khác: 404 payment.not_found ở cả hai đường — như payment không tồn tại.
    const stranger = await createUserViaApi(app, admin);
    const strangerToken = (await login(app, stranger.username, STRONG_PASSWORD)).accessToken;
    const blockedRead = await http(app).get(`/api/v1/payments/${payment.body.id}`).set('Authorization', `Bearer ${strangerToken}`);
    expect(blockedRead.status).toBe(404);
    expect(blockedRead.body.code).toBe('payment.not_found');
    const blockedRefunds = await http(app).get(`/api/v1/payments/${payment.body.id}/refunds`).set('Authorization', `Bearer ${strangerToken}`);
    expect(blockedRefunds.status).toBe(404);
    expect(blockedRefunds.body.code).toBe('payment.not_found');

    // Holder payment:manageaccounts tại system (role manager) đọc được.
    const { token: managerToken } = await managerUser();
    const mgrRead = await http(app).get(`/api/v1/payments/${payment.body.id}`).set('Authorization', `Bearer ${managerToken}`);
    expect(mgrRead.status).toBe(200);
    expect(mgrRead.body.id).toBe(payment.body.id);
    const mgrRefunds = await http(app).get(`/api/v1/payments/${payment.body.id}/refunds`).set('Authorization', `Bearer ${managerToken}`);
    expect(mgrRefunds.status).toBe(200);

    // Danh sách tài khoản: user thường 403, manager 200.
    const accountsDenied = await http(app).get('/api/v1/payments/accounts').set('Authorization', `Bearer ${strangerToken}`);
    expect(accountsDenied.status).toBe(403);
    const accountsOk = await http(app).get('/api/v1/payments/accounts').set('Authorization', `Bearer ${managerToken}`);
    expect(accountsOk.status).toBe(200);
    expect((accountsOk.body as { id: string }[]).some((a) => a.id === account.body.id)).toBe(true);

    // Hồi quy: /payments/me của chủ sở hữu vẫn chạy.
    const mine = await http(app).get('/api/v1/payments/me').set('Authorization', `Bearer ${ownerToken}`);
    expect(mine.status).toBe(200);
    expect((mine.body as { id: string }[]).some((p) => p.id === payment.body.id)).toBe(true);
  });

  it('H6+H4: running a model requires analytics:manage; the global insights list is filtered by viewinsights at each row context', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const ctxId = await courseContextId(app, admin, course.id);

    const teacher = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'editingteacher'), ctxId);
    const teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;

    // Học viên nguy cơ: chưa từng đăng nhập (no_recent_access=1) + điểm 0 (low_grade=1).
    const riskStudent = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, riskStudent.id);
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Risk item' });
    await setGrade(app, admin, item.id, riskStudent.id, 0);

    // H6: user thường chạy model ⇒ 403.
    const outsider = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    const runByOutsider = await http(app).post('/api/v1/analytics/models/students_at_risk/run')
      .set('Authorization', `Bearer ${outsiderToken}`).send({ courseId: course.id });
    expect(runByOutsider.status).toBe(403);
    // H6: teacher của khoá có viewinsights nhưng KHÔNG có analytics:manage ⇒ vẫn 403.
    const runByTeacher = await http(app).post('/api/v1/analytics/models/students_at_risk/run')
      .set('Authorization', `Bearer ${teacherToken}`).send({ courseId: course.id });
    expect(runByTeacher.status).toBe(403);
    // Admin chạy được; manager (analytics:manage tại system) cũng chạy được qua cây context.
    const run = await http(app).post('/api/v1/analytics/models/students_at_risk/run')
      .set('Authorization', `Bearer ${admin}`).send({ courseId: course.id });
    expect(run.status).toBeLessThan(300);
    expect(run.body.predictions).toBeGreaterThanOrEqual(1);
    expect(run.body.insights).toBeGreaterThanOrEqual(1);
    const { token: managerToken } = await managerUser();
    const runByManager = await http(app).post('/api/v1/analytics/models/students_at_risk/run')
      .set('Authorization', `Bearer ${managerToken}`).send({ courseId: course.id });
    expect(runByManager.status).toBeLessThan(300);

    // H4: học viên là CHỦ THỂ của insight cũng không thấy nó qua danh sách toàn cục.
    const riskToken = (await login(app, riskStudent.username, STRONG_PASSWORD)).accessToken;
    const listAsRisk = await http(app).get('/api/v1/analytics/insights').set('Authorization', `Bearer ${riskToken}`);
    expect(listAsRisk.status).toBe(200);
    expect((listAsRisk.body as { userId: string }[]).some((i) => i.userId === riskStudent.id)).toBe(false);
    expect((listAsRisk.body as unknown[]).length).toBe(0);
    // H4: user ngoài khoá cũng không nhận dòng nào của khoá này.
    const listAsOutsider = await http(app).get('/api/v1/analytics/insights').set('Authorization', `Bearer ${outsiderToken}`);
    expect((listAsOutsider.body as { userId: string }[]).some((i) => i.userId === riskStudent.id)).toBe(false);
    // H4: teacher có viewinsights tại context khoá ⇒ thấy insight của khoá mình.
    const listAsTeacher = await http(app).get('/api/v1/analytics/insights').set('Authorization', `Bearer ${teacherToken}`);
    expect(listAsTeacher.status).toBe(200);
    expect((listAsTeacher.body as { userId: string }[]).some((i) => i.userId === riskStudent.id)).toBe(true);
    // H4: admin thấy toàn bộ.
    const listAsAdmin = await http(app).get('/api/v1/analytics/insights').set('Authorization', `Bearer ${admin}`);
    expect((listAsAdmin.body as { userId: string }[]).some((i) => i.userId === riskStudent.id)).toBe(true);
    // Hồi quy: /insights/me của teacher vẫn trả insight như trước.
    const meTeacher = await http(app).get('/api/v1/analytics/insights/me').set('Authorization', `Bearer ${teacherToken}`);
    expect((meTeacher.body as { userId: string }[]).some((i) => i.userId === riskStudent.id)).toBe(true);
  });
});
