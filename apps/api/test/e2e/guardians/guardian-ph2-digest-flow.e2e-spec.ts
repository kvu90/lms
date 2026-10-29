import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD } from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';

/**
 * PH-2 (issue #159) — phần còn ở phía API của digest phụ huynh:
 * endpoint tuỳ chọn tần suất theo từng con qua cổng liên kết (mặc
 * định weekly, đặt daily/off có hiệu lực, tần suất lạ bị 400, không
 * liên kết thì 404 đồng nhất cho cả đọc lẫn ghi).
 *
 * Nửa TIÊU THỤ của digest (tổng hợp cửa sổ đã công bố + gửi thông
 * báo + đẩy riêng quá hạn ≥7 ngày) không còn chạy ở phía API: từ
 * issue con #518 của #491 các sự kiện `guardian_digest_due` /
 * `guardian_overdue_alert` đi qua relay outbox vào hàng đợi phía
 * worker. Năm ca hành vi của nửa đó (kết quả đã công bố gửi đúng
 * một lần, item chưa công bố không lọt, cửa sổ rỗng, liên kết đã
 * thu hồi, đẩy quá hạn đúng một lần) đã chuyển nguyên sang tầng
 * tích hợp phía worker:
 * `apps/worker/test/integration/guardians/guardian-digest-delivery.int-spec.ts`.
 */
describe('PH-2: digest phụ huynh — tuỳ chọn tần suất phía API (issue #159)', () => {
  let app: INestApplication;
  let admin: string;
  let catId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    catId = (await createCategory(app, admin)).id;
  }, 120000);
  afterAll(async () => { await app.close(); });

  /** Khoá mới + học sinh ghi danh + giáo viên editingteacher tại context khoá. */
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
    return { course, student, teacher };
  }

  async function freshGuardian() {
    const user = await createUserViaApi(app, admin);
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { user, token };
  }

  async function link(teacher: string, guardianId: string, studentId: string): Promise<string> {
    const res = await http(app).post('/api/v1/guardian-links').set('Authorization', `Bearer ${teacher}`)
      .send({ guardianUserId: guardianId, studentUserId: studentId, relationship: 'Cha' });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  it('tuỳ chọn tần suất theo con: mặc định weekly, đặt daily/off có hiệu lực, cổng liên kết 404 đồng nhất', async () => {
    const { student, teacher } = await courseWithPeople();
    const { user: guardian, token: guardianToken } = await freshGuardian();
    await link(teacher, guardian.id, student.id);
    const url = `/api/v1/guardian/students/${student.id}/digest-preference`;

    const initial = await http(app).get(url).set('Authorization', `Bearer ${guardianToken}`);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ studentId: student.id, frequency: 'weekly' });

    const toDaily = await http(app).put(url).set('Authorization', `Bearer ${guardianToken}`).send({ frequency: 'daily' });
    expect(toDaily.status).toBe(200);
    expect(toDaily.body).toMatchObject({ frequency: 'daily' });
    const afterDaily = await http(app).get(url).set('Authorization', `Bearer ${guardianToken}`);
    expect(afterDaily.body).toMatchObject({ frequency: 'daily' });

    const toOff = await http(app).put(url).set('Authorization', `Bearer ${guardianToken}`).send({ frequency: 'off' });
    expect(toOff.status).toBe(200);
    expect(toOff.body).toMatchObject({ frequency: 'off' });

    const invalid = await http(app).put(url).set('Authorization', `Bearer ${guardianToken}`).send({ frequency: 'monthly' });
    expect(invalid.status).toBe(400);

    // Không liên kết → 404 đồng nhất cho cả đọc lẫn ghi; học sinh cũng không tự đặt được cho mình.
    const { token: strangerToken } = await freshGuardian();
    const strangerGet = await http(app).get(url).set('Authorization', `Bearer ${strangerToken}`);
    expect(strangerGet.status).toBe(404);
    const strangerPut = await http(app).put(url).set('Authorization', `Bearer ${strangerToken}`).send({ frequency: 'daily' });
    expect(strangerPut.status).toBe(404);
    const ghost = await http(app).get(`/api/v1/guardian/students/01900000-0000-7000-8000-0000000000ff/digest-preference`)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(ghost.status).toBe(404);
  }, 180000);
});
