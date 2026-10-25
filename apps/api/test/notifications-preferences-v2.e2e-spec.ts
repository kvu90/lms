import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD, systemContextId } from './identity-access-helpers';

/**
 * NB-2 (issue #174): mô hình tuỳ chọn thông báo v2.
 *
 * Tiêu chí theo hồ sơ rà soát + chính sách đã chốt trên #174:
 *  - GET /messages/preferences trả MỘT dòng cho mỗi provider, mang
 *    nhãn + mô tả vi/en từ registry ở API (không khoá thô), phân loại
 *    3 nhóm, nhãn theo vai cho loại chỉ GV nhận, cờ bắt buộc của P2 —
 *    và KHÔNG có bề mặt push hay trục loggedin/loggedoff nào.
 *  - Đổi tuỳ chọn có hiệu lực ngay ở lần phát kế tiếp (kiểm qua
 *    POST /notifications/send — điểm phát chuẩn của admin — và đọc
 *    trường channels của NotifyResult + số thông báo đã lưu).
 *  - Tắt email của grade_updated vẫn giữ popup hoạt động độc lập.
 *  - Loại bắt buộc (P2): enrol_expiry_warning + admin_announcement
 *    không tắt được popup (400) nhưng email vẫn tắt được tuyệt đối,
 *    và lần phát vẫn giao popup.
 *  - Dữ liệu tuỳ chọn CŨ (khoá provider × kênh × trạng thái) được suy
 *    về giá trị tương đương ở hậu trường: hàng cũ giữ nguyên không
 *    bị ghi đè, khoá v2 khi đã đặt thì thắng hàng cũ.
 */
describe('Notification preferences v2 (NB-2, issue #174)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  interface PrefRow {
    provider: string; component: string; group: string;
    label: { vi: string; en: string }; description: { vi: string; en: string };
    teacherOnly: boolean; mandatoryInApp: boolean;
    popupEnabled: boolean; emailFrequency: string | null; emailAvailable: boolean;
    [key: string]: unknown;
  }

  async function freshUser(): Promise<{ id: string; token: string }> {
    const user = await createUserViaApi(app, admin);
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    // NB-7: bề mặt tuỳ chọn theo loại chỉ còn cho nhân sự — fixture của
    // suite này dùng vai teacher (gán ở context hệ thống) để kiểm mô
    // hình v2 như trước; phần chặn học sinh có spec riêng
    // (notifications-admin-policy).
    await assignRole(app, admin, user.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    return { id: user.id, token };
  }

  async function preferencesOf(token: string): Promise<PrefRow[]> {
    const res = await http(app).get('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as PrefRow[];
  }

  async function send(userId: string, provider: string): Promise<{ popup?: string; email?: string }> {
    const res = await http(app).post('/api/v1/notifications/send').set('Authorization', `Bearer ${admin}`)
      .send({ userId, provider, subject: `Thông báo kiểm tra ${provider}`, body: 'Nội dung kiểm tra' });
    expect(res.status).toBeLessThan(300);
    return (res.body as { channels: { popup?: string; email?: string } }).channels;
  }

  it('GET returns one labelled v2 row per provider — no raw keys, no push, no login-state axis', async () => {
    const { token } = await freshUser();
    const rows = await preferencesOf(token);
    expect(rows).toHaveLength(20);
    for (const row of rows) {
      expect(row.label.vi.length).toBeGreaterThan(0);
      expect(row.label.en.length).toBeGreaterThan(0);
      expect(row.description.vi.length).toBeGreaterThan(0);
      expect(row.description.en.length).toBeGreaterThan(0);
      // Không còn bề mặt của mô hình cũ / kênh chưa có hạ tầng.
      expect(row).not.toHaveProperty('state');
      expect(row).not.toHaveProperty('channel');
      expect(row).not.toHaveProperty('channels');
      // Trung thực kênh: email chưa gửi thật cho tới NB-5 (SMTP).
      expect(row.emailAvailable).toBe(false);
    }
    const byName = new Map(rows.map((r) => [r.provider, r]));
    // Mặc định tần suất theo P1: học tập = tổng hợp ngày, tin nhắn = ngay.
    expect(byName.get('grade_updated')).toMatchObject({ group: 'learning', teacherOnly: false, mandatoryInApp: false, popupEnabled: true, emailFrequency: 'daily' });
    expect(byName.get('message_new')).toMatchObject({ group: 'people', emailFrequency: 'immediate' });
    // Provider không có kênh email → emailFrequency null.
    expect(byName.get('course_completed')?.emailFrequency).toBeNull();
    // Nhãn theo vai: hai loại chỉ GV nhận.
    expect(byName.get('quiz_attempt_finished')?.teacherOnly).toBe(true);
    expect(byName.get('conversation_reported')?.teacherOnly).toBe(true);
    expect(byName.get('assignment_submitted')?.teacherOnly).toBe(false);
    // P2: đúng hai loại bắt buộc, đều ở kênh trong-app.
    expect(rows.filter((r) => r.mandatoryInApp).map((r) => r.provider).sort()).toEqual(['admin_announcement', 'enrol_expiry_warning']);
    expect(byName.get('admin_announcement')).toMatchObject({ group: 'system', popupEnabled: true, emailFrequency: 'immediate' });
  });

  it('changes take effect on the very next dispatch; email off keeps popup independent', async () => {
    const { id, token } = await freshUser();
    // Mặc định: popup giao thật, email xếp hàng (tần suất daily vẫn
    // xếp hàng job log-only cho tới NB-5 — chỉ 'off' mới chặn).
    expect(await send(id, 'grade_updated')).toMatchObject({ popup: 'delivered', email: 'queued' });

    const off = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`)
      .send({ provider: 'grade_updated', emailFrequency: 'off' });
    expect(off.status).toBe(200);
    expect((off.body as PrefRow).emailFrequency).toBe('off');
    // Tắt email: popup vẫn giao độc lập, email bị chặn ngay lần phát này.
    expect(await send(id, 'grade_updated')).toMatchObject({ popup: 'delivered', email: 'skipped-preference' });

    const popupOff = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`)
      .send({ provider: 'grade_updated', popupEnabled: false });
    expect(popupOff.status).toBe(200);
    expect(await send(id, 'grade_updated')).toMatchObject({ popup: 'skipped-preference', email: 'skipped-preference' });

    // Bật lại cũng hiệu lực ngay.
    await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`)
      .send({ provider: 'grade_updated', popupEnabled: true });
    expect(await send(id, 'grade_updated')).toMatchObject({ popup: 'delivered', email: 'skipped-preference' });

    // Đúng 3 lần popup giao thật → 3 thông báo đã lưu (2 trước + 1 sau khi bật lại).
    const list = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${token}`);
    expect((list.body as { items: unknown[] }).items).toHaveLength(3);
  });

  it('mandatory providers refuse popup off (400) but allow email off, and popup still delivers', async () => {
    const { id, token } = await freshUser();
    for (const provider of ['enrol_expiry_warning', 'admin_announcement']) {
      const refused = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`)
        .send({ provider, popupEnabled: false });
      expect(refused.status).toBe(400);
      expect((refused.body as { code?: string }).code).toBe('messaging.preference_mandatory');
      // Email của loại bắt buộc vẫn là quyền cá nhân tuyệt đối.
      const emailOff = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`)
        .send({ provider, emailFrequency: 'off' });
      expect(emailOff.status).toBe(200);
      expect(await send(id, provider)).toMatchObject({ popup: 'delivered', email: 'skipped-preference' });
      const row = (await preferencesOf(token)).find((r) => r.provider === provider);
      expect(row?.popupEnabled).toBe(true);
    }
  });

  it('legacy v1 rows are honoured by derivation, never rewritten; a v2 write wins over legacy', async () => {
    const { id, token } = await freshUser();
    // Gieo đúng hình dạng dữ liệu cũ: khoá provider × kênh × trạng thái.
    await pg.query(
      `insert into user_preferences (user_id, name, value) values ($1, 'message_provider_grade_updated_popup_loggedin', '0'), ($1, 'message_provider_grade_updated_email_loggedin', '0')`,
      [id],
    );
    let row = (await preferencesOf(token)).find((r) => r.provider === 'grade_updated');
    expect(row?.popupEnabled).toBe(false);
    expect(row?.emailFrequency).toBe('off');
    // Lần phát kế tiếp tôn trọng giá trị suy từ dữ liệu cũ.
    expect(await send(id, 'grade_updated')).toMatchObject({ popup: 'skipped-preference', email: 'skipped-preference' });

    // Ghi v2: chỉ khoá v2 được tạo, khoá cũ giữ nguyên từng chữ.
    const put = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`)
      .send({ provider: 'grade_updated', popupEnabled: true });
    expect(put.status).toBe(200);
    row = (await preferencesOf(token)).find((r) => r.provider === 'grade_updated');
    expect(row?.popupEnabled).toBe(true); // v2 thắng hàng cũ ở popup
    expect(row?.emailFrequency).toBe('off'); // email chưa ghi v2 → vẫn suy từ hàng cũ
    const stored = await pg.query(`select name, value from user_preferences where user_id = $1 order by name`, [id]);
    expect(stored.rows).toEqual([
      { name: 'message_provider_grade_updated_email_loggedin', value: '0' },
      { name: 'message_provider_grade_updated_popup_loggedin', value: '0' },
      { name: 'message_provider_grade_updated_popup_v2', value: '1' },
    ]);
  });

  it('validation: unknown provider, empty patch, and email frequency on a provider without email are 400', async () => {
    const { token } = await freshUser();
    const unknown = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`)
      .send({ provider: 'khong_ton_tai', popupEnabled: true });
    expect(unknown.status).toBe(400);
    expect((unknown.body as { code?: string }).code).toBe('messaging.unknown_provider');

    const empty = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`)
      .send({ provider: 'grade_updated' });
    expect(empty.status).toBe(400);
    expect((empty.body as { code?: string }).code).toBe('messaging.preference_empty');

    const noEmail = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`)
      .send({ provider: 'course_completed', emailFrequency: 'off' });
    expect(noEmail.status).toBe(400);
    expect((noEmail.body as { code?: string }).code).toBe('messaging.unknown_channel');
  });
});
