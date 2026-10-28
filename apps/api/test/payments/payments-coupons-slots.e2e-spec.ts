import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  adminToken, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD, uniqueName,
} from '../support/identity-access-helpers';
import { createCategory, createEnrolInstance, enrolUser } from '../support/course-enrolment-helpers';

/**
 * Phần còn lại của lát 2, issue #189 — COUPON giảm giá mua gói và
 * THỰC THI GIỚI HẠN SLOT theo đặc tả slot đã duyệt (comment
 * 6434192125 của issue; ánh xạ vận hành ghi ở comment bổ sung đặc tả
 * đăng cùng đợt thi công):
 *
 * - Coupon: quản trị platform tạo/sửa coupon (mọi mức giảm là dữ
 *   liệu, không ghim trong code); mua gói kèm mã thì `amount` của
 *   payment là giá cấu hình sau giảm và ảnh chụp `data.plan` ghi mã
 *   + mức giảm; từng trường hợp coupon không áp được có mã lỗi riêng.
 * - Slot gói trung tâm: mức nền 3 tài khoản giảng dạy cho tenant
 *   không gói (học viên không tính); chạm mức nền thì hành động tăng
 *   slot (gán vai trò giảng dạy, kích hoạt lại membership, bỏ đình
 *   chỉ tài khoản) bị chặn và thực thể đang có nguyên vẹn; nâng mức
 *   nền qua Cài đặt hệ thống thì tạo thêm được; gói đang hoạt động
 *   hoặc còn trong ân hạn 7 ngày thì áp hạn mức gói (30), hết ân hạn
 *   rơi về mức nền. Ân hạn chỉ tính từ quyền lợi đã thật sự hết hạn;
 *   quyền lợi tương lai chưa bắt đầu không tự mở hạn mức gói khi
 *   quyền lợi hiện hành đã bị đình chỉ.
 * - Slot gói giáo viên: mức nền 1 khoá học làm chủ tại tenant
 *   platform; tạo khoá thứ hai bị chặn; mua gói giáo viên thành công
 *   thì tạo tiếp được; vai trò giảng dạy nhận qua ghi danh (dạy
 *   chung) không tính slot.
 */
const SEPAY_KEY = 'sk-test-coupon-slot-001';
const SEPAY_XID = 'xid-test-coupon-slot-001';
const BANK_ACCOUNT = '113366660001';
const TENANT_PLAN_DEFAULT_PRICE = 6000000;
const TEACHER_PLAN_DEFAULT_PRICE = 990000;
const DAY_MS = 86_400_000;

describe('Coupons + plan slot limits (issue #189, remaining slice 2)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;
  let sepayAccountId: string;
  let disabledAccountIds: string[] = [];
  let editingteacherRoleId: string;
  let studentRoleId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const must = async (res: { status: number; body: unknown }, what: string) => {
    if (res.status < 200 || res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as never;
  };

  async function createBuyer() {
    const buyer = await createUserViaApi(app, admin);
    const token = (await login(app, buyer.username, STRONG_PASSWORD)).accessToken;
    return { buyer, token };
  }

  async function buyPlan(token: string, component: 'tenant_plan' | 'teacher_plan', couponCode?: string) {
    const res = await http(app).post('/api/v1/payments/plans').set(auth(token))
      .send(couponCode ? { component, couponCode } : { component });
    expect(res.status).toBeLessThan(300);
    return res.body as { id: string; amount: number; paymentCode: string; data: { plan: Record<string, unknown> } };
  }

  function ipnBody(paymentCode: string, amount: number): Record<string, unknown> {
    return {
      gateway: 'MBBANK',
      transaction_date: '2026-10-27 09:00:00',
      account_number: BANK_ACCOUNT,
      bank_account_xid: SEPAY_XID,
      content: `TT ${paymentCode}`,
      transfer_type: 'credit',
      amount,
      reference_code: `FT${Date.now()}${Math.floor(Math.random() * 1000)}`,
      transaction_id: `sepay-tx-cs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  async function postIpn(body: Record<string, unknown>) {
    const res = await http(app).post('/api/v1/payments/ipn/sepay')
      .set('Authorization', `Apikey ${SEPAY_KEY}`)
      .send(body);
    expect(res.status).toBeLessThan(300);
    expect(res.body.success).toBe(true);
  }

  async function waitPaymentStatus(id: string, want: string, timeoutMs = 12000): Promise<void> {
    const start = Date.now();
    let last = '';
    while (Date.now() - start < timeoutMs) {
      const res = await http(app).get(`/api/v1/payments/${id}`).set(auth(admin));
      last = (res.body as { status: string }).status;
      if (last === want) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`payment ${id} did not reach status ${want} (last: ${last})`);
  }

  async function createCoupon(token: string, body: Record<string, unknown>) {
    return http(app).post('/api/v1/payments/coupons').set(auth(token)).send(body);
  }

  async function createSchoolTenant(): Promise<string> {
    const slug = `cs-${uniqueName('t').toLowerCase()}`;
    const created = await must(
      await http(app).post('/api/v1/tenants').set(auth(admin)).send({ name: `Trung tâm ${slug}`, slug, kind: 'school' }),
      'create school tenant',
    ) as { id: string };
    return created.id;
  }

  async function tenantContextId(tenantId: string): Promise<string> {
    const rows = await pg.query('select id from context where context_level = 20 and instance_id = $1', [tenantId]);
    expect(rows.rows.length).toBe(1);
    return (rows.rows[0] as { id: string }).id;
  }

  async function addMember(tenantId: string, userId: string) {
    await must(await http(app).post(`/api/v1/tenants/${tenantId}/members`).set(auth(admin)).send({ userId }), 'add member');
  }

  async function assignRoleRaw(userId: string, roleId: string, contextId: string) {
    return http(app).post('/api/v1/access/assignments').set(auth(admin)).send({ userId, roleId, contextId });
  }

  /** Dựng một tenant trường + các thành viên; trả id tenant và context của tenant. */
  async function schoolWithMembers(memberCount: number) {
    const tenantId = await createSchoolTenant();
    const ctxId = await tenantContextId(tenantId);
    const users: { id: string; username: string }[] = [];
    for (let i = 0; i < memberCount; i++) {
      const u = await createUserViaApi(app, admin);
      users.push(u);
      await addMember(tenantId, u.id);
    }
    return { tenantId, ctxId, users };
  }

  /**
   * Gắn một quyền lợi gói trung tâm chế tác (cửa sổ và trạng thái tuỳ
   * ý) cho tenant — neo vào một payment gói có thật. Trạng thái mặc
   * định là `active`; ca hồi quy ân hạn dùng `suspended` để mô phỏng
   * quyền lợi hiện hành đã bị đình chỉ do hoàn đủ.
   */
  async function craftTenantEntitlement(
    tenantId: string,
    startsAt: Date,
    expiresAt: Date,
    status: 'active' | 'suspended' = 'active',
  ) {
    const { token } = await createBuyer();
    const payment = await buyPlan(token, 'tenant_plan');
    await pg.query(
      `insert into plan_entitlements (tenant_id, user_id, component, payment_id, starts_at, expires_at, status)
       values ($1, null, 'tenant_plan', $2, $3, $4, $5)`,
      [tenantId, payment.id, startsAt.toISOString(), expiresAt.toISOString(), status],
    );
  }

  /**
   * Chuẩn bị một người dùng thành giáo viên TỰ TẠO ĐƯỢC LỚP ở tenant
   * platform: là thành viên của tenant hiện hành (tenant-zero) và giữ
   * vai `editingteacher` tại context của tenant đó (archetype mang
   * capability tạo lớp) — đúng đường giáo viên thật trên seed, theo
   * khuôn của spec classes-teacher-surface. Vai tại context tenant
   * platform không tính vào slot nào: gói trung tâm miễn cho tenant
   * platform, còn đếm khoá của gói giáo viên chỉ tính chủ lớp và dòng
   * gán trực tiếp tại context khoá.
   */
  async function makeClassCreator(userId: string) {
    const current = await must(await http(app).get('/api/v1/tenants/current').set(auth(admin)), 'current tenant') as { id: string };
    await addMember(current.id, userId);
    const ctxId = await tenantContextId(current.id);
    const res = await assignRoleRaw(userId, editingteacherRoleId, ctxId);
    expect(res.status).toBeLessThan(300);
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    editingteacherRoleId = await roleIdByShortname(app, admin, 'editingteacher');
    studentRoleId = await roleIdByShortname(app, admin, 'student');
    const res = await http(app).post('/api/v1/payments/accounts').set(auth(admin))
      .send({
        name: 'SePay platform coupon-slot', gateway: 'sepay',
        config: { bankCode: 'MBBANK', bankAccountNumber: BANK_ACCOUNT, sepayApiKey: SEPAY_KEY, sepayBankAccountXid: SEPAY_XID },
      });
    expect(res.status).toBeLessThan(300);
    sepayAccountId = res.body.id as string;
    // Như spec payments-plans: vô hiệu hoá tạm các tài khoản đang bật
    // khác của tenant platform để đường mua gói xác định duy nhất;
    // khôi phục ở afterAll.
    const others = await pg.query(
      'select id from payment_accounts where tenant_id = (select tenant_id from payment_accounts where id = $1) and id <> $1 and enabled = true',
      [sepayAccountId],
    );
    disabledAccountIds = (others.rows as { id: string }[]).map((r) => r.id);
    if (disabledAccountIds.length > 0) {
      await pg.query('update payment_accounts set enabled = false where id = any($1)', [disabledAccountIds]);
    }
  });

  afterAll(async () => {
    if (disabledAccountIds.length > 0) {
      await pg.query('update payment_accounts set enabled = true where id = any($1)', [disabledAccountIds]);
    }
    await pg.end();
    await app.close();
  });

  // --- Coupon ---------------------------------------------------------------

  it('coupon: chỉ quản trị platform tạo được; mã chuẩn hoá chữ hoa; mã trùng bị từ chối', async () => {
    const code = uniqueName('sale').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toLowerCase();
    const created = await createCoupon(admin, { code, discountType: 'percent', discountValue: 10 });
    expect(created.status).toBeLessThan(300);
    expect(created.body.code).toBe(code.toUpperCase());
    expect(created.body.appliesTo).toBe('all');
    expect(created.body.isActive).toBe(true);

    const duplicate = await createCoupon(admin, { code: code.toUpperCase(), discountType: 'fixed', discountValue: 1000 });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { code: string }).code).toBe('payment.coupon_code_taken');

    const { token } = await createBuyer();
    const forbidden = await createCoupon(token, { code: uniqueName('nope'), discountType: 'fixed', discountValue: 1000 });
    expect(forbidden.status).toBe(403);
  });

  it('coupon phần trăm: số tiền payment là giá sau giảm, ảnh chụp ghi giá gốc + mức giảm; IPN theo số đã giảm vẫn kích hoạt quyền lợi', async () => {
    const code = uniqueName('pct10').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const created = await createCoupon(admin, { code, discountType: 'percent', discountValue: 10 });
    expect(created.status).toBeLessThan(300);
    const couponId = (created.body as { id: string }).id;

    const { token } = await createBuyer();
    // Người mua nhập mã chữ thường — tra cứu chuẩn hoá vẫn khớp.
    const payment = await buyPlan(token, 'teacher_plan', code.toLowerCase());
    const expectedDiscount = Math.floor((TEACHER_PLAN_DEFAULT_PRICE * 10) / 100);
    expect(payment.amount).toBe(TEACHER_PLAN_DEFAULT_PRICE - expectedDiscount);
    expect(payment.data.plan.configuredPrice).toBe(TEACHER_PLAN_DEFAULT_PRICE);
    expect(payment.data.plan.discountAmount).toBe(expectedDiscount);
    expect(payment.data.plan.couponCode).toBe(code.toUpperCase());
    expect(payment.data.plan.couponId).toBe(couponId);

    await postIpn(ipnBody(payment.paymentCode, payment.amount));
    await waitPaymentStatus(payment.id, 'succeeded');
    const ent = await pg.query('select status from plan_entitlements where payment_id = $1', [payment.id]);
    expect(ent.rows.length).toBe(1);
    expect((ent.rows[0] as { status: string }).status).toBe('active');
  });

  it('coupon cố định theo loại gói: áp sai loại bị từ chối, áp đúng loại trừ đúng số tiền', async () => {
    const code = uniqueName('fix500k').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const created = await createCoupon(admin, { code, discountType: 'fixed', discountValue: 500000, appliesTo: 'tenant_plan' });
    expect(created.status).toBeLessThan(300);

    const { token } = await createBuyer();
    const wrongPlan = await http(app).post('/api/v1/payments/plans').set(auth(token))
      .send({ component: 'teacher_plan', couponCode: code });
    expect(wrongPlan.status).toBe(400);
    expect((wrongPlan.body as { code: string }).code).toBe('payment.coupon_not_applicable');

    const payment = await buyPlan(token, 'tenant_plan', code);
    expect(payment.amount).toBe(TENANT_PLAN_DEFAULT_PRICE - 500000);
    expect(payment.data.plan.discountAmount).toBe(500000);
  });

  it('coupon không áp được: mã lạ, coupon đã tắt, ngoài cửa sổ hiệu lực, hết lượt dùng, giảm chạm giá gói', async () => {
    const { token } = await createBuyer();
    const buy = (couponCode: string) => http(app).post('/api/v1/payments/plans').set(auth(token))
      .send({ component: 'teacher_plan', couponCode });

    const unknown = await buy(uniqueName('ghost').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12));
    expect(unknown.status).toBe(400);
    expect((unknown.body as { code: string }).code).toBe('payment.coupon_not_found');

    const offCode = uniqueName('off').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const off = await createCoupon(admin, { code: offCode, discountType: 'fixed', discountValue: 1000 });
    const offId = (off.body as { id: string }).id;
    const patched = await http(app).patch(`/api/v1/payments/coupons/${offId}`).set(auth(admin)).send({ isActive: false });
    expect(patched.status).toBeLessThan(300);
    expect((patched.body as { isActive: boolean }).isActive).toBe(false);
    const inactive = await buy(offCode);
    expect(inactive.status).toBe(400);
    expect((inactive.body as { code: string }).code).toBe('payment.coupon_inactive');

    const futureCode = uniqueName('future').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    await createCoupon(admin, {
      code: futureCode, discountType: 'fixed', discountValue: 1000,
      startsAt: new Date(Date.now() + DAY_MS).toISOString(), endsAt: new Date(Date.now() + 2 * DAY_MS).toISOString(),
    });
    const notYet = await buy(futureCode);
    expect(notYet.status).toBe(400);
    expect((notYet.body as { code: string }).code).toBe('payment.coupon_not_in_window');

    const onceCode = uniqueName('once').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    await createCoupon(admin, { code: onceCode, discountType: 'fixed', discountValue: 1000, maxRedemptions: 1 });
    const first = await buy(onceCode);
    expect(first.status).toBeLessThan(300);
    const second = await buy(onceCode);
    expect(second.status).toBe(400);
    expect((second.body as { code: string }).code).toBe('payment.coupon_exhausted');

    const bigCode = uniqueName('big').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    await createCoupon(admin, { code: bigCode, discountType: 'fixed', discountValue: TEACHER_PLAN_DEFAULT_PRICE, appliesTo: 'teacher_plan' });
    const exceeds = await buy(bigCode);
    expect(exceeds.status).toBe(400);
    expect((exceeds.body as { code: string }).code).toBe('payment.coupon_exceeds_price');
  });

  it('coupon: sửa mức giảm thì khoản thu tạo sau dùng mức mới; sửa phần trăm vượt 99 bị từ chối trên trạng thái gộp', async () => {
    const code = uniqueName('edit').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const created = await createCoupon(admin, { code, discountType: 'percent', discountValue: 10 });
    const id = (created.body as { id: string }).id;

    const invalid = await http(app).patch(`/api/v1/payments/coupons/${id}`).set(auth(admin)).send({ discountValue: 150 });
    expect(invalid.status).toBe(400);
    expect((invalid.body as { code: string }).code).toBe('payment.coupon_invalid');

    const patched = await http(app).patch(`/api/v1/payments/coupons/${id}`).set(auth(admin)).send({ discountValue: 20 });
    expect(patched.status).toBeLessThan(300);
    const { token } = await createBuyer();
    const payment = await buyPlan(token, 'teacher_plan', code);
    expect(payment.amount).toBe(TEACHER_PLAN_DEFAULT_PRICE - Math.floor((TEACHER_PLAN_DEFAULT_PRICE * 20) / 100));
  });

  // --- Slot gói trung tâm -----------------------------------------------------

  it('slot trung tâm — mức nền: học viên không tính; giáo viên thứ 4 bị chặn và không sinh dòng gán; nâng mức nền qua Cài đặt hệ thống thì gán được', async () => {
    const { ctxId, users } = await schoolWithMembers(9);
    const students = users.slice(0, 5);
    const teachers = users.slice(5);

    for (const s of students) {
      const res = await assignRoleRaw(s.id, studentRoleId, ctxId);
      expect(res.status).toBeLessThan(300);
    }
    for (const t of teachers.slice(0, 3)) {
      const res = await assignRoleRaw(t.id, editingteacherRoleId, ctxId);
      expect(res.status).toBeLessThan(300);
    }
    const blocked = await assignRoleRaw(teachers[3]!.id, editingteacherRoleId, ctxId);
    expect(blocked.status).toBe(400);
    expect((blocked.body as { code: string }).code).toBe('plan.tenant_slot_limit_reached');
    // Hành động bị chặn không để lại dòng gán nào cho giáo viên thứ 4,
    // và ba dòng gán đã có nguyên vẹn.
    const rows = await pg.query(
      'select user_id from role_assignments where context_id = $1 and role_id = $2 order by user_id',
      [ctxId, editingteacherRoleId],
    );
    expect(rows.rows.length).toBe(3);
    expect((rows.rows as { user_id: string }[]).map((r) => r.user_id)).not.toContain(teachers[3]!.id);

    // Hạn mức là cấu hình: nâng mức nền lên 4 trong Cài đặt hệ thống
    // thì gán thêm được ngay, không cần triển khai lại.
    const set = await http(app).put('/api/v1/site-config/payments/tenantplanfreeslots').set(auth(admin)).send({ value: 4 });
    expect(set.status).toBeLessThan(300);
    try {
      const allowed = await assignRoleRaw(teachers[3]!.id, editingteacherRoleId, ctxId);
      expect(allowed.status).toBeLessThan(300);
    } finally {
      const clear = await http(app).delete('/api/v1/site-config/payments/tenantplanfreeslots').set(auth(admin));
      expect(clear.status).toBeLessThan(300);
    }
  });

  it('slot trung tâm — gói đang hoạt động: hạn mức gói (30) thay mức nền, giáo viên thứ 4 và thứ 5 gán được', async () => {
    const { tenantId, ctxId, users } = await schoolWithMembers(5);
    const now = Date.now();
    await craftTenantEntitlement(tenantId, new Date(now - DAY_MS), new Date(now + 364 * DAY_MS));
    for (const t of users) {
      const res = await assignRoleRaw(t.id, editingteacherRoleId, ctxId);
      expect(res.status).toBeLessThan(300);
    }
  });

  it('slot trung tâm — ân hạn: gói hết hạn 3 ngày vẫn áp hạn mức gói; hết hạn 10 ngày (qua ân hạn 7) rơi về mức nền', async () => {
    const grace = await schoolWithMembers(4);
    const now = Date.now();
    await craftTenantEntitlement(grace.tenantId, new Date(now - 368 * DAY_MS), new Date(now - 3 * DAY_MS));
    for (const t of grace.users) {
      const res = await assignRoleRaw(t.id, editingteacherRoleId, grace.ctxId);
      expect(res.status).toBeLessThan(300);
    }

    const expired = await schoolWithMembers(4);
    await craftTenantEntitlement(expired.tenantId, new Date(now - 375 * DAY_MS), new Date(now - 10 * DAY_MS));
    for (const t of expired.users.slice(0, 3)) {
      const res = await assignRoleRaw(t.id, editingteacherRoleId, expired.ctxId);
      expect(res.status).toBeLessThan(300);
    }
    const blocked = await assignRoleRaw(expired.users[3]!.id, editingteacherRoleId, expired.ctxId);
    expect(blocked.status).toBe(400);
    expect((blocked.body as { code: string }).code).toBe('plan.tenant_slot_limit_reached');
  });

  it('slot trung tâm — ân hạn không tính quyền lợi tương lai: quyền lợi hiện hành đã đình chỉ và quyền lợi cũ đã qua ân hạn thì áp mức nền', async () => {
    const { tenantId, ctxId, users } = await schoolWithMembers(4);
    const now = Date.now();

    // Quyền lợi hiện hành bị đình chỉ do hoàn đủ: cửa sổ của nó vẫn
    // kéo dài về tương lai nhưng trạng thái đã đình chỉ nên không
    // được tính là gói đang hoạt động và không mở ân hạn.
    await craftTenantEntitlement(tenantId, new Date(now - DAY_MS), new Date(now + 364 * DAY_MS), 'suspended');
    // Quyền lợi đã thật sự hết hạn 10 ngày trước — qua ân hạn 7 ngày.
    await craftTenantEntitlement(tenantId, new Date(now - 375 * DAY_MS), new Date(now - 10 * DAY_MS));
    // Quyền lợi mua nối tiếp có cửa sổ hoàn toàn trong tương lai.
    // Mốc hết hạn xa của nó không được dùng để kết luận hiện tại còn
    // ân hạn; nếu dùng sai, giáo viên thứ 4 sẽ được gán ở hạn mức gói.
    await craftTenantEntitlement(tenantId, new Date(now + DAY_MS), new Date(now + 365 * DAY_MS));

    for (const t of users.slice(0, 3)) {
      const res = await assignRoleRaw(t.id, editingteacherRoleId, ctxId);
      expect(res.status).toBeLessThan(300);
    }
    const blocked = await assignRoleRaw(users[3]!.id, editingteacherRoleId, ctxId);
    expect(blocked.status).toBe(400);
    expect((blocked.body as { code: string }).code).toBe('plan.tenant_slot_limit_reached');
  });

  it('slot trung tâm — kích hoạt lại membership của giáo viên đã có vai trò: bị chặn ở hạn mức, membership giữ nguyên trạng thái cũ', async () => {
    const { tenantId, ctxId, users } = await schoolWithMembers(4);
    for (const t of users.slice(0, 3)) {
      const res = await assignRoleRaw(t.id, editingteacherRoleId, ctxId);
      expect(res.status).toBeLessThan(300);
    }
    const fourth = users[3]!;
    // Đình chỉ membership trước rồi mới gán vai trò: lúc gán, thành
    // viên chưa được đếm nên gán thành công; số slot chỉ tăng khi
    // membership được kích hoạt lại.
    const suspend = await http(app).patch(`/api/v1/tenants/${tenantId}/members/${fourth.id}`).set(auth(admin)).send({ status: 'suspended' });
    expect(suspend.status).toBeLessThan(300);
    const assign = await assignRoleRaw(fourth.id, editingteacherRoleId, ctxId);
    expect(assign.status).toBeLessThan(300);

    const reactivate = await http(app).patch(`/api/v1/tenants/${tenantId}/members/${fourth.id}`).set(auth(admin)).send({ status: 'active' });
    expect(reactivate.status).toBe(400);
    expect((reactivate.body as { code: string }).code).toBe('plan.tenant_slot_limit_reached');
    const membership = await pg.query('select status from tenant_memberships where tenant_id = $1 and user_id = $2', [tenantId, fourth.id]);
    expect((membership.rows[0] as { status: string }).status).toBe('suspended');
  });

  it('slot trung tâm — bỏ đình chỉ tài khoản giáo viên khi tenant đã chạm hạn mức: bị chặn, tài khoản giữ nguyên đình chỉ', async () => {
    const { tenantId, ctxId, users } = await schoolWithMembers(3);
    for (const t of users) {
      const res = await assignRoleRaw(t.id, editingteacherRoleId, ctxId);
      expect(res.status).toBeLessThan(300);
    }
    const fourth = await createUserViaApi(app, admin);
    const suspended = await http(app).post(`/api/v1/users/${fourth.id}/suspend`).set(auth(admin));
    expect(suspended.status).toBeLessThan(300);
    await addMember(tenantId, fourth.id);
    // Tài khoản đang đình chỉ thì chưa được đếm — gán vai trò thành công.
    const assign = await assignRoleRaw(fourth.id, editingteacherRoleId, ctxId);
    expect(assign.status).toBeLessThan(300);

    const reactivate = await http(app).post(`/api/v1/users/${fourth.id}/reactivate`).set(auth(admin));
    expect(reactivate.status).toBe(400);
    expect((reactivate.body as { code: string }).code).toBe('plan.tenant_slot_limit_reached');
    const account = await pg.query('select suspended from users where id = $1', [fourth.id]);
    expect((account.rows[0] as { suspended: boolean }).suspended).toBe(true);
  });

  // --- Slot gói giáo viên -----------------------------------------------------

  it('slot giáo viên — mức nền 1 khoá làm chủ: khoá thứ hai bị chặn, khoá đầu nguyên vẹn; mua gói giáo viên xong thì tạo tiếp được', async () => {
    const category = await createCategory(app, admin);
    const teacher = await createUserViaApi(app, admin);
    await makeClassCreator(teacher.id);
    const teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;

    const class1 = await must(await http(app).post('/api/v1/classes').set(auth(teacherToken)).send({ name: uniqueName('Lớp slot 1') }), 'teacher class 1') as { id: string };
    const course1 = await must(await http(app).post('/api/v1/courses').set(auth(teacherToken)).send({
      fullName: uniqueName('Khoá slot 1'), shortName: uniqueName('KS'), category: category.id, classId: class1.id,
    }), 'teacher course 1') as { id: string };

    const class2 = await must(await http(app).post('/api/v1/classes').set(auth(teacherToken)).send({ name: uniqueName('Lớp slot 2') }), 'teacher class 2') as { id: string };
    const blocked = await http(app).post('/api/v1/courses').set(auth(teacherToken)).send({
      fullName: uniqueName('Khoá slot 2'), shortName: uniqueName('KS'), category: category.id, classId: class2.id,
    });
    expect(blocked.status).toBe(400);
    expect((blocked.body as { code: string }).code).toBe('plan.teacher_course_limit_reached');

    const intact = await http(app).get(`/api/v1/courses/${course1.id}`).set(auth(teacherToken));
    expect(intact.status).toBeLessThan(300);

    // Mua gói giáo viên và hoàn tất pipeline → hạn mức gói (10).
    const payment = await buyPlan(teacherToken, 'teacher_plan');
    await postIpn(ipnBody(payment.paymentCode, TEACHER_PLAN_DEFAULT_PRICE));
    await waitPaymentStatus(payment.id, 'succeeded');
    const course2 = await http(app).post('/api/v1/courses').set(auth(teacherToken)).send({
      fullName: uniqueName('Khoá slot 2'), shortName: uniqueName('KS'), category: category.id, classId: class2.id,
    });
    expect(course2.status).toBeLessThan(300);
  });

  it('slot giáo viên — vai trò giảng dạy qua ghi danh (dạy chung) không tính slot của người được ghi danh', async () => {
    const category = await createCategory(app, admin);
    const owner = await createUserViaApi(app, admin);
    await makeClassCreator(owner.id);
    const ownerToken = (await login(app, owner.username, STRONG_PASSWORD)).accessToken;
    const cls = await must(await http(app).post('/api/v1/classes').set(auth(ownerToken)).send({ name: uniqueName('Lớp dạy chung') }), 'owner class') as { id: string };
    const course = await must(await http(app).post('/api/v1/courses').set(auth(ownerToken)).send({
      fullName: uniqueName('Khoá dạy chung'), shortName: uniqueName('KDC'), category: category.id, classId: cls.id,
    }), 'owner course') as { id: string };

    // Ghi danh một giáo viên khác vào khoá với vai trò editingteacher
    // qua enrol instance — dòng gán mang nguồn `enrol`.
    const coTeacher = await createUserViaApi(app, admin);
    await makeClassCreator(coTeacher.id);
    const instance = await createEnrolInstance(app, ownerToken, course.id, { roleShortname: 'editingteacher' });
    await enrolUser(app, ownerToken, course.id, instance.id, coTeacher.id);
    const grant = await pg.query(
      `select component from role_assignments where user_id = $1 and role_id = $2 and component = 'enrol'`,
      [coTeacher.id, editingteacherRoleId],
    );
    expect(grant.rows.length).toBeGreaterThan(0);

    // Người dạy chung vẫn tạo được khoá của riêng mình ở mức nền 1:
    // khoá dạy chung không tiêu thụ slot nào của họ.
    const coToken = (await login(app, coTeacher.username, STRONG_PASSWORD)).accessToken;
    const ownClass = await must(await http(app).post('/api/v1/classes').set(auth(coToken)).send({ name: uniqueName('Lớp riêng') }), 'co-teacher class') as { id: string };
    const ownCourse = await http(app).post('/api/v1/courses').set(auth(coToken)).send({
      fullName: uniqueName('Khoá riêng'), shortName: uniqueName('KR'), category: category.id, classId: ownClass.id,
    });
    expect(ownCourse.status).toBeLessThan(300);
  });
});
