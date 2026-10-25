import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD, systemContextId } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';

/**
 * NB-7 (issue #174): chính sách thông báo cấp admin + bề mặt tuỳ chọn
 * tối thiểu cho học sinh.
 *
 * Tiêu chí kiểm chứng:
 *  - Registry chính sách: GET /site-config có đúng 20 khoá
 *    `notifications/provider_<loại>_enabled`, boolean, mặc định bật.
 *  - Admin tắt một loại → notify() không phát cho BẤT KỲ ai (kể cả
 *    người có tuỳ chọn cá nhân đang bật), kết quả skipped =
 *    'admin-disabled' + dispatch log `skipped-admin-disabled`; admin
 *    bật lại → phát bình thường. Loại khác không bị ảnh hưởng.
 *  - Hai loại bắt buộc P2 (enrol_expiry_warning, admin_announcement):
 *    admin đặt tắt → API từ chối 400; thông báo vẫn phát.
 *  - Học sinh thuần (chỉ ghi danh, không vai nhân sự): PUT tuỳ chọn
 *    theo loại → 403 kèm code rõ ràng; GET tuỳ chọn theo loại → [];
 *    ngoại lệ tắt tiếng theo khoá (NB-4) vẫn dùng được.
 *  - Giáo viên (vai nhân sự) giữ nguyên bề mặt v2 đầy đủ.
 */
describe('NB-7 admin notification policy + student minimal preferences', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });

  afterAll(async () => {
    // Dọn ghi đè chính sách của suite này để không rò sang suite khác
    // (các suite dùng chung một DB test, chạy tuần tự).
    await pg.query(`delete from plugin_config where plugin = 'notifications' and name like 'provider_%_enabled' and tenant_id is null`);
    await pg.end();
    await app.close();
  });

  /** Nhân sự: vai teacher ở context hệ thống → bề mặt tuỳ chọn đầy đủ. */
  async function staffUser(): Promise<{ id: string; token: string }> {
    const user = await createUserViaApi(app, admin);
    await assignRole(app, admin, user.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { id: user.id, token };
  }

  /** Học sinh thuần: chỉ ghi danh vào một khoá, không vai nhân sự nào. */
  async function studentInCourse(): Promise<{ courseId: string; id: string; token: string }> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { courseId: course.id, id: user.id, token };
  }

  async function setSitePolicy(provider: string, value: boolean) {
    return http(app).put(`/api/v1/site-config/notifications/provider_${provider}_enabled`)
      .set('Authorization', `Bearer ${admin}`).send({ value });
  }

  async function sendTo(userId: string, provider: string, subject: string) {
    return http(app).post('/api/v1/notifications/send').set('Authorization', `Bearer ${admin}`)
      .send({ userId, provider, subject, body: 'Nội dung kiểm chứng NB-7' });
  }

  it('policy registry: exactly 20 notification policy settings, boolean, default enabled', async () => {
    const res = await http(app).get('/api/v1/site-config').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    const rows = (res.body as { component: string; name: string; type: string; defaultValue: unknown; value: unknown }[])
      .filter((r) => r.component === 'notifications');
    expect(rows).toHaveLength(20);
    for (const row of rows) {
      expect(row.name).toMatch(/^provider_.+_enabled$/);
      expect(row.type).toBe('boolean');
      expect(row.defaultValue).toBe(true);
    }
    expect(rows.map((r) => r.name)).toContain('provider_enrol_expiry_warning_enabled');
    expect(rows.map((r) => r.name)).toContain('provider_admin_announcement_enabled');
  });

  it('admin disable blocks delivery for everyone before user preferences, logs skipped-admin-disabled; re-enable restores', async () => {
    const staff = await staffUser();
    const student = await studentInCourse();

    // Tuỳ chọn cá nhân của nhân sự đang BẬT tường minh cho grade_updated.
    const pref = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${staff.token}`)
      .send({ provider: 'grade_updated', popupEnabled: true });
    expect(pref.status).toBe(200);

    const off = await setSitePolicy('grade_updated', false);
    expect(off.status).toBe(200);
    expect(off.body.value).toBe(false);

    // Nhân sự (tuỳ chọn bật) vẫn bị chặn ở cổng admin.
    // (POST /notifications/send trả 201 theo mặc định @Post của Nest.)
    const blocked = await sendTo(staff.id, 'grade_updated', 'Điểm mới NB-7');
    expect(blocked.status).toBe(201);
    expect(blocked.body.skipped).toBe('admin-disabled');
    expect(blocked.body.notificationId).toBeNull();
    expect(blocked.body.channels).toEqual({});
    // Học sinh cũng bị chặn — chính sách là cấp site, không theo người.
    const blockedStudent = await sendTo(student.id, 'grade_updated', 'Điểm mới NB-7 HS');
    expect(blockedStudent.body.skipped).toBe('admin-disabled');

    // Không thông báo nào được lưu cho hai người nhận.
    const staffItems = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${staff.token}`);
    expect((staffItems.body.items as { subject: string }[]).some((n) => n.subject === 'Điểm mới NB-7')).toBe(false);
    // Dispatch log truy vết được trạng thái chặn.
    const log = await pg.query(
      `select count(*)::int as n from notification_dispatch_log where user_id = $1 and provider = 'grade_updated' and status = 'skipped-admin-disabled'`,
      [staff.id],
    );
    expect(log.rows[0].n).toBeGreaterThan(0);

    // Loại khác không bị ảnh hưởng khi grade_updated đang tắt.
    const other = await sendTo(staff.id, 'badge_awarded', 'Huy hiệu NB-7');
    expect(other.body.channels.popup).toBe('delivered');

    // Bật lại → phát bình thường ngay.
    const on = await setSitePolicy('grade_updated', true);
    expect(on.status).toBe(200);
    const restored = await sendTo(staff.id, 'grade_updated', 'Điểm mới NB-7 lần 2');
    expect(restored.body.skipped).toBeUndefined();
    expect(restored.body.channels.popup).toBe('delivered');
  });

  it('mandatory P2 types cannot be disabled by admin and still deliver', async () => {
    for (const provider of ['enrol_expiry_warning', 'admin_announcement']) {
      const res = await setSitePolicy(provider, false);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('site_config.notification_mandatory');
    }
    const staff = await staffUser();
    const sent = await sendTo(staff.id, 'enrol_expiry_warning', 'Sắp hết hạn NB-7');
    expect(sent.body.skipped).toBeUndefined();
    expect(sent.body.channels.popup).toBe('delivered');
  });

  it('student: per-type PUT 403, GET empty, course mute override still works; staff keeps the full surface', async () => {
    const student = await studentInCourse();

    const put = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${student.token}`)
      .send({ provider: 'grade_updated', popupEnabled: false });
    expect(put.status).toBe(403);
    expect(JSON.stringify(put.body)).toContain('messaging.preference_staff_only');

    const get = await http(app).get('/api/v1/messages/preferences').set('Authorization', `Bearer ${student.token}`);
    expect(get.status).toBe(200);
    expect(get.body).toEqual([]);

    // Bề mặt tối thiểu còn lại: ngoại lệ theo khoá (NB-4) dùng bình thường.
    const courses = await http(app).get('/api/v1/messages/preferences/courses').set('Authorization', `Bearer ${student.token}`);
    expect(courses.status).toBe(200);
    expect((courses.body.courses as { courseId: string }[]).map((c) => c.courseId)).toContain(student.courseId);
    const mute = await http(app).put('/api/v1/messages/preferences/courses').set('Authorization', `Bearer ${student.token}`)
      .send({ courseId: student.courseId, mode: 'mute' });
    expect(mute.status).toBe(200);
    expect(mute.body.mode).toBe('mute');
    const prefRow = await pg.query(
      `select value from user_preferences where user_id = $1 and name = $2`,
      [student.id, `notif.course.${student.courseId}`],
    );
    expect(prefRow.rows[0]?.value).toBe('mute');

    // Đối chứng: nhân sự giữ bề mặt v2 đầy đủ (20 dòng + PUT được).
    const staff = await staffUser();
    const staffGet = await http(app).get('/api/v1/messages/preferences').set('Authorization', `Bearer ${staff.token}`);
    expect(staffGet.status).toBe(200);
    expect(staffGet.body).toHaveLength(20);
    const staffPut = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${staff.token}`)
      .send({ provider: 'grade_updated', popupEnabled: false });
    expect(staffPut.status).toBe(200);
    expect(staffPut.body.popupEnabled).toBe(false);
  });
});
