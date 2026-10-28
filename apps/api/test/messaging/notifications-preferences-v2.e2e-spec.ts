import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD, systemContextId } from '../support/identity-access-helpers';

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
 *  - Phân chia theo vai + context (việc nối tiếp của issue #288):
 *    GET chỉ trả provider thuộc AUDIENCE của user — registry ở API
 *    là nguồn sự thật, audience chốt bằng truy vết điểm phát notify()
 *    thật. Giáo viên thuần không thấy loại chỉ học sinh nhận (báo
 *    điểm là ca bị bắt tại trận) hay loại của phụ huynh; người hai
 *    vai dạy + học thấy cả phía học sinh; nhân sự có liên kết giám
 *    hộ hiệu lực thấy thêm loại phụ huynh; site admin đủ 20. PUT
 *    ngoài audience bị server từ chối 403 — không chỉ giấu giao diện.
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

  /**
   * Người dùng HAI VAI dạy + học: teacher và student cùng gán ở
   * context hệ thống → có cả context nhân sự lẫn context học sinh
   * (nhánh gán-vai của phép xác định context học sinh). Các ca cơ
   * chế tuỳ chọn đụng loại phía học sinh (grade_updated…) dùng
   * fixture này; ca nguyên mẫu giáo viên thuần dùng freshUser().
   */
  async function freshDualUser(): Promise<{ id: string; token: string }> {
    const user = await createUserViaApi(app, admin);
    const sys = await systemContextId(app, admin);
    await assignRole(app, admin, user.id, await roleIdByShortname(app, admin, 'teacher'), sys);
    await assignRole(app, admin, user.id, await roleIdByShortname(app, admin, 'student'), sys);
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { id: user.id, token };
  }

  /**
   * Nhân sự kiêm PHỤ HUYNH: vai teacher như freshUser() cộng một
   * liên kết giám hộ đang hiệu lực (chèn thẳng hàng guardian_links
   * với tenant nền tảng đã seed — cùng kỷ luật chèn dữ liệu fixture
   * qua pg của suite này).
   */
  async function freshGuardianStaffUser(): Promise<{ id: string; token: string }> {
    const { id, token } = await freshUser();
    const child = await createUserViaApi(app, admin);
    const tenant = await pg.query(`select id from tenants order by created_at asc limit 1`);
    await pg.query(
      `insert into guardian_links (tenant_id, guardian_user_id, student_user_id, relationship, created_by) values ($1, $2, $3, 'Cha', $2)`,
      [tenant.rows[0].id, id, child.id],
    );
    return { id, token };
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

  it('GET returns one labelled v2 row per provider in the pure-teacher audience — no raw keys, no push, no login-state axis', async () => {
    const { token } = await freshUser();
    const rows = await preferencesOf(token);
    // Audience theo vai (issue #288): giáo viên THUẦN chỉ thấy phía
    // nhân sự + mọi-vai = 10 trong 20 loại. Tám loại chỉ học sinh
    // nhận (grade_updated là ca bị bắt tại trận) và hai loại của phụ
    // huynh nằm ngoài bề mặt của họ; bề mặt đầy đủ nằm ở ca nguyên
    // mẫu audience bên dưới.
    expect(rows.map((r) => r.provider).sort()).toEqual([
      'admin_announcement', 'assignment_submitted', 'badge_awarded', 'calendar_reminder',
      'competency_review_requested', 'contact_request', 'conversation_reported',
      'message_new', 'quiz_attempt_finished', 'report_scheduled',
    ]);
    for (const row of rows) {
      expect(row.label.vi.length).toBeGreaterThan(0);
      expect(row.label.en.length).toBeGreaterThan(0);
      expect(row.description.vi.length).toBeGreaterThan(0);
      expect(row.description.en.length).toBeGreaterThan(0);
      // Không còn bề mặt của mô hình cũ / kênh chưa có hạ tầng.
      expect(row).not.toHaveProperty('state');
      expect(row).not.toHaveProperty('channel');
      expect(row).not.toHaveProperty('channels');
      // Trung thực kênh: từ NB-5 (issue #174) email gửi thật qua
      // Resend nên cờ khả dụng trong registry đã bật — trước NB-5 ca
      // này kỳ vọng false (kênh còn là cổng ghi log), PR NB-5 cập
      // nhật kỳ vọng theo luật mới cùng lượt với việc bật cờ.
      expect(row.emailAvailable).toBe(true);
    }
    const byName = new Map(rows.map((r) => [r.provider, r]));
    // Mặc định tần suất theo P1: nhóm Lớp & mọi người = ngay.
    expect(byName.get('message_new')).toMatchObject({ group: 'people', emailFrequency: 'immediate' });
    // Nhãn theo vai (suy ra từ audience): hai loại chỉ phía nhân
    // sự/quản trị nhận mang nhãn "chỉ giáo viên"; loại hai phía thì không.
    expect(byName.get('quiz_attempt_finished')?.teacherOnly).toBe(true);
    expect(byName.get('conversation_reported')?.teacherOnly).toBe(true);
    expect(byName.get('assignment_submitted')?.teacherOnly).toBe(false);
    // P2 trong bề mặt giáo viên thuần: chỉ admin_announcement thuộc
    // audience của họ — loại bắt buộc phía học sinh
    // (enrol_expiry_warning) không hiện ở đây (đủ cả hai ở ca admin).
    expect(rows.filter((r) => r.mandatoryInApp).map((r) => r.provider)).toEqual(['admin_announcement']);
    expect(byName.get('admin_announcement')).toMatchObject({ group: 'system', popupEnabled: true, emailFrequency: 'immediate' });
  });

  it('audience prototypes (issue #288): dual role sees the student side, guardian staff sees guardian types, admin sees all 20', async () => {
    // Hai vai dạy + học: thấy cả phía học sinh (18 loại), chưa có
    // phía phụ huynh.
    const dual = await freshDualUser();
    const dualRows = await preferencesOf(dual.token);
    const dualNames = dualRows.map((r) => r.provider);
    expect(dualNames).toHaveLength(18);
    expect(dualNames).toContain('grade_updated');
    expect(dualNames).toContain('enrol_expiry_warning');
    expect(dualNames).not.toContain('guardian_digest');
    expect(dualNames).not.toContain('guardian_overdue_alert');
    const dualByName = new Map(dualRows.map((r) => [r.provider, r]));
    // Mặc định tần suất P1 phía học tập = tổng hợp ngày; provider
    // không có kênh email → emailFrequency null.
    expect(dualByName.get('grade_updated')).toMatchObject({ group: 'learning', teacherOnly: false, mandatoryInApp: false, popupEnabled: true, emailFrequency: 'daily' });
    expect(dualByName.get('course_completed')?.emailFrequency).toBeNull();

    // Nhân sự + liên kết giám hộ hiệu lực: thêm đúng hai loại phụ huynh.
    const guardianStaff = await freshGuardianStaffUser();
    const guardianNames = (await preferencesOf(guardianStaff.token)).map((r) => r.provider);
    expect(guardianNames).toHaveLength(12);
    expect(guardianNames).toContain('guardian_digest');
    expect(guardianNames).toContain('guardian_overdue_alert');
    const guardianPut = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${guardianStaff.token}`)
      .send({ provider: 'guardian_digest', popupEnabled: false });
    expect(guardianPut.status).toBe(200);
    expect((guardianPut.body as PrefRow).popupEnabled).toBe(false);

    // Site admin: context admin phủ mọi phía — đủ 20 loại.
    expect(await preferencesOf(admin)).toHaveLength(20);
  });

  it('audience gate on PUT (issue #288): a pure teacher is refused 403 for student-only and guardian types', async () => {
    const { token } = await freshUser();
    for (const provider of ['grade_updated', 'guardian_digest']) {
      const refused = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`)
        .send({ provider, popupEnabled: false });
      expect(refused.status).toBe(403);
      expect((refused.body as { code?: string }).code).toBe('messaging.preference_audience');
    }
  });

  it('changes take effect on the very next dispatch; email off keeps popup independent', async () => {
    // Hai vai: grade_updated là loại phía học sinh (#288).
    const { id, token } = await freshDualUser();
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
    // Hai vai: enrol_expiry_warning là loại phía học sinh (#288).
    const { id, token } = await freshDualUser();
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
    // Hai vai: grade_updated là loại phía học sinh (#288).
    const { id, token } = await freshDualUser();
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
    // Hai vai để các ca kiểm chứng payload tới được đúng tầng
    // validation (provider phía học sinh ngoài audience của giáo
    // viên thuần sẽ dừng ở 403 audience trước — ca đó ở ca PUT gate).
    const { token } = await freshDualUser();
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
