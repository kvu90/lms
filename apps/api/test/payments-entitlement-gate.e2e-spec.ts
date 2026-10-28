import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, grantActiveTeacherPlan } from './course-enrolment-helpers';

/**
 * Chốt chặn component cấp quyền ở pipeline thanh toán (issue #419) —
 * bộ ca bám LUẬT NGHIỆP VỤ:
 *
 *  1. Giá và bên hưởng của một giao dịch cấp quyền lợi chỉ lấy từ
 *     đối tượng phía server (instance có phí / cấu hình học phí trên
 *     lớp / cấu hình giá gói). Đường tạo payment chung
 *     `POST /payments` — nơi client tự đặt `amount`, `component`,
 *     `itemId` — KHÔNG được sinh payment mang component cấp quyền
 *     (`enrol_fee`, `class_fee`, `tenant_plan`, `teacher_plan`);
 *     bốn component này chỉ sinh từ ba đường tạo chuyên trách đã
 *     chốt giá phía server.
 *  2. Payment lưu sẵn có số tiền hoặc tenant lệch giá/tenant phía
 *     server của đối tượng đích thì KHÔNG điểm kích hoạt nào (khớp
 *     IPN SePay, webhook gateway, xử lý tay `needs_review`) được
 *     cấp quyền lợi: matching và webhook chuyển payment sang
 *     `needs_review`, quyết định khớp tay bị từ chối.
 *  3. Ba đường chính thức giữ nguyên hành vi: mua qua
 *     `/payments/fee/:id`, `/payments/class-fee/:id`,
 *     `/payments/plans` rồi tiền về đúng → kích hoạt quyền lợi như
 *     trước.
 *
 * Đổi luật (bỏ chốt ở điểm tạo, bỏ đối chiếu ở điểm kích hoạt) thì
 * ca tương ứng phải đỏ — các ca (b) dùng payment do đường chính
 * thức tạo rồi phẫu thuật số tiền/tenant trong DB để mô phỏng
 * payment đã bị can thiệp trước khi tới điểm kích hoạt.
 */
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
const SEPAY_KEY = '<redacted>';
const SEPAY_XID = 'xid-entitlement-gate-001';
const BANK_ACCOUNT = '113366660001';
const FEE_COST = 100000;
const CLASS_FEE = 150000;

interface Person { id: string; username: string; token: string }
interface PaymentBody { id: string; paymentCode: string | null; amount: number; tenantId: string; status: string }

describe('Chốt chặn component cấp quyền: endpoint chung bị cấm + đối chiếu giá phía server tại điểm kích hoạt (issue #419)', () => {
  let app: INestApplication;
  let pg: Client;
  let admin: string;
  let sepayAccountId: string;
  let manualAccountId: string;
  let disabledAccountIds: string[] = [];
  let feeClassId: string;
  let feeClassCourseId: string;
  let classTeacher: Person;

  async function person(): Promise<Person> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  async function waitPaymentStatus(id: string, want: string, timeoutMs = 12000): Promise<Record<string, unknown>> {
    const start = Date.now();
    let last: Record<string, unknown> = {};
    while (Date.now() - start < timeoutMs) {
      const res = await http(app).get(`/api/v1/payments/${id}`).set('Authorization', `Bearer ${admin}`);
      last = res.body as Record<string, unknown>;
      if (last.status === want) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`payment ${id} did not reach status ${want} (last: ${String(last.status)})`);
  }

  async function enrolmentActive(courseId: string, token: string): Promise<boolean> {
    const res = await http(app).get(`/api/v1/courses/${courseId}/enrolments/me`).set('Authorization', `Bearer ${token}`);
    return (res.body as { active?: boolean }).active === true;
  }

  async function rosterIds(classId: string): Promise<string[]> {
    const res = await http(app).get(`/api/v1/classes/${classId}/roster`).set('Authorization', `Bearer ${classTeacher.token}`);
    expect(res.status).toBe(200);
    return (res.body as { userId: string }[]).map((m) => m.userId);
  }

  function ipnBody(paymentCode: string, amount: number): Record<string, unknown> {
    return {
      gateway: 'MBBANK',
      transaction_date: '2026-10-28 09:00:00',
      account_number: BANK_ACCOUNT,
      bank_account_xid: SEPAY_XID,
      content: `TT ${paymentCode}`,
      transfer_type: 'credit',
      amount,
      reference_code: `FT${Date.now()}${Math.floor(Math.random() * 1000)}`,
      transaction_id: `sepay-eg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  async function postIpn(body: Record<string, unknown>) {
    const res = await http(app).post('/api/v1/payments/ipn/sepay')
      .set('Authorization', `Apikey ${SEPAY_KEY}`)
      .send(body);
    expect(res.status).toBeLessThan(300);
    expect((res.body as { success: boolean }).success).toBe(true);
    return res;
  }

  /** Khoá học phí qua đường chính thức, tài khoản nhận SePay ghim trên instance. */
  async function createSepayFeeCourse() {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id, {
      method: 'fee', cost: FEE_COST, currency: 'VND', paymentAccountId: sepayAccountId,
    });
    const buyer = await person();
    const payment = await http(app).post(`/api/v1/payments/fee/${instance.id}`).set('Authorization', `Bearer ${buyer.token}`).send({});
    expect(payment.status).toBeLessThan(300);
    return { course, instance, buyer, payment: payment.body as PaymentBody };
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    const sepay = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({
        name: 'SePay entitlement gate', gateway: 'sepay',
        config: { bankCode: 'MBBANK', bankAccountNumber: BANK_ACCOUNT, sepayApiKey: SEPAY_KEY, sepayBankAccountXid: SEPAY_XID },
      });
    expect(sepay.status).toBeLessThan(300);
    sepayAccountId = (sepay.body as { id: string }).id;

    const manual = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Manual entitlement gate', gateway: 'manual' });
    expect(manual.status).toBeLessThan(300);
    manualAccountId = (manual.body as { id: string }).id;

    // Đường mua gói chọn tài khoản đang bật của tenant platform:
    // tắt tạm các tài khoản khác của tenant đó (fixture các spec
    // khác để lại) để lựa chọn xác định duy nhất là tài khoản của
    // spec này; khôi phục nguyên trạng ở afterAll — cùng khuôn của
    // spec mua gói hiện hữu.
    const platform = await pg.query<{ id: string }>("select id from tenants where kind = 'platform'");
    const platformTenantId = platform.rows[0]!.id;
    const others = await pg.query<{ id: string }>(
      'select id from payment_accounts where tenant_id = $1 and enabled = true and not (id = any($2))',
      [platformTenantId, [sepayAccountId, manualAccountId]],
    );
    disabledAccountIds = others.rows.map((r) => r.id);
    if (disabledAccountIds.length > 0) {
      await pg.query('update payment_accounts set enabled = false where id = any($1)', [disabledAccountIds]);
    }

    // Lớp có học phí: chủ lớp là giáo viên (cần quyền lợi gói giáo
    // viên đang hoạt động để qua luật slot khoá của lớp, cùng tiền
    // đề fixture của spec học phí lớp hiện hữu).
    classTeacher = await person();
    const current = await http(app).get('/api/v1/tenants/current').set('Authorization', `Bearer ${admin}`);
    const tenantId = (current.body as { id: string }).id;
    await http(app).post(`/api/v1/tenants/${tenantId}/members`)
      .set('Authorization', `Bearer ${admin}`).send({ userId: classTeacher.id });
    await grantActiveTeacherPlan(pg, classTeacher.id);
    const cls = await http(app).post('/api/v1/classes')
      .set('Authorization', `Bearer ${admin}`).send({ name: 'Lớp chốt chặn 419', ownerId: classTeacher.id });
    expect(cls.status).toBe(201);
    feeClassId = (cls.body as { id: string }).id;
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, { classId: feeClassId });
    feeClassCourseId = course.id;
    const feeRes = await http(app).patch(`/api/v1/classes/${feeClassId}`)
      .set('Authorization', `Bearer ${classTeacher.token}`).send({ feeCost: CLASS_FEE, feeCurrency: 'VND' });
    expect(feeRes.status).toBe(200);
    const pinRes = await http(app).patch(`/api/v1/classes/${feeClassId}`)
      .set('Authorization', `Bearer ${classTeacher.token}`).send({ feePaymentAccountId: sepayAccountId });
    expect(pinRes.status).toBe(200);
    // Trần thời gian riêng cho hook: chuỗi fixture dài (boot app +
    // dựng tài khoản/lớp/khoá) có thể vượt trần 30 giây mặc định
    // của suite khi máy chạy nhiều suite song song.
  }, 180000);

  afterAll(async () => {
    if (pg && disabledAccountIds.length > 0) {
      await pg.query('update payment_accounts set enabled = true where id = any($1)', [disabledAccountIds]);
    }
    await pg?.end();
    await app?.close();
  }, 60000);

  it('(a) endpoint chung từ chối cả 4 component cấp quyền bằng mã lỗi rõ ràng và không sinh payment; component thường vẫn tạo được', async () => {
    const buyer = await person();
    for (const component of ['enrol_fee', 'class_fee', 'tenant_plan', 'teacher_plan']) {
      const res = await http(app).post('/api/v1/payments').set('Authorization', `Bearer ${buyer.token}`)
        .send({ accountId: sepayAccountId, amount: 1, currency: 'VND', component, itemId: randomUUID() });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('payment.entitlement_component_forbidden');
    }
    const created = await pg.query<{ c: number }>(
      "select count(*)::int as c from payments where user_id = $1 and component in ('enrol_fee', 'class_fee', 'tenant_plan', 'teacher_plan')",
      [buyer.id],
    );
    expect(created.rows[0]!.c).toBe(0);

    // Component thường (không sinh quyền lợi) giữ nguyên hành vi.
    const ordinary = await http(app).post('/api/v1/payments').set('Authorization', `Bearer ${buyer.token}`)
      .send({ accountId: sepayAccountId, amount: 5000, currency: 'VND', component: 'donation' });
    expect(ordinary.status).toBeLessThan(300);
    expect((ordinary.body as PaymentBody).status).toBe('pending');
    const noComponent = await http(app).post('/api/v1/payments').set('Authorization', `Bearer ${buyer.token}`)
      .send({ accountId: sepayAccountId, amount: 5000, currency: 'VND' });
    expect(noComponent.status).toBeLessThan(300);
  });

  it('(b1) matching: payment enrol_fee bị sửa số tiền xuống 1 đồng → needs_review, không ghi danh', async () => {
    const { course, buyer, payment } = await createSepayFeeCourse();
    expect(payment.amount).toBe(FEE_COST);
    await pg.query('update payments set amount = 1 where id = $1', [payment.id]);
    // Tiền về đúng bằng số tiền (đã bị sửa) của payment + đúng mã +
    // đúng tài khoản: khớp đủ 3 điều kiện với chính payment — chỉ
    // phép đối chiếu giá phía server mới chặn được kích hoạt.
    await postIpn(ipnBody(payment.paymentCode!, 1));
    await waitPaymentStatus(payment.id, 'needs_review');
    expect(await enrolmentActive(course.id, buyer.token)).toBe(false);
  });

  it('(b2) matching: payment enrol_fee bị sửa tenant sang tenant khác tenant của khoá → needs_review, không ghi danh', async () => {
    const { course, buyer, payment } = await createSepayFeeCourse();
    const others = await pg.query<{ id: string }>('select id from tenants where id <> $1 limit 1', [payment.tenantId]);
    expect(others.rows[0]).toBeTruthy();
    await pg.query('update payments set tenant_id = $1 where id = $2', [others.rows[0]!.id, payment.id]);
    await postIpn(ipnBody(payment.paymentCode!, FEE_COST));
    await waitPaymentStatus(payment.id, 'needs_review');
    expect(await enrolmentActive(course.id, buyer.token)).toBe(false);
  });

  it('(b3) matching: payment class_fee bị sửa số tiền xuống 1 đồng → needs_review, không vào roster của lớp', async () => {
    const buyer = await person();
    const created = await http(app).post(`/api/v1/payments/class-fee/${feeClassId}`).set('Authorization', `Bearer ${buyer.token}`).send({});
    expect(created.status).toBeLessThan(300);
    const payment = created.body as PaymentBody;
    expect(payment.amount).toBe(CLASS_FEE);
    await pg.query('update payments set amount = 1 where id = $1', [payment.id]);
    await postIpn(ipnBody(payment.paymentCode!, 1));
    await waitPaymentStatus(payment.id, 'needs_review');
    expect(await rosterIds(feeClassId)).not.toContain(buyer.id);
    expect(await enrolmentActive(feeClassCourseId, buyer.token)).toBe(false);
  });

  it('(b4) matching: payment gói teacher_plan bị sửa số tiền → needs_review, không sinh quyền lợi gói', async () => {
    const buyer = await person();
    const created = await http(app).post('/api/v1/payments/plans').set('Authorization', `Bearer ${buyer.token}`).send({ component: 'teacher_plan' });
    expect(created.status).toBeLessThan(300);
    const payment = created.body as PaymentBody;
    const tamperedAmount = payment.amount - 1;
    await pg.query('update payments set amount = $1 where id = $2', [tamperedAmount, payment.id]);
    await postIpn(ipnBody(payment.paymentCode!, tamperedAmount));
    await waitPaymentStatus(payment.id, 'needs_review');
    const entitlements = await pg.query<{ c: number }>(
      'select count(*)::int as c from plan_entitlements where payment_id = $1',
      [payment.id],
    );
    expect(entitlements.rows[0]!.c).toBe(0);
  });

  it('(b5) webhook: payment enrol_fee bị sửa số tiền → webhook báo needs_review, không ghi danh; payment sạch vẫn chốt succeeded', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id, {
      method: 'fee', cost: FEE_COST, currency: 'VND', paymentAccountId: manualAccountId,
    });
    async function manualFeePayment(buyerToken: string): Promise<PaymentBody> {
      const res = await http(app).post(`/api/v1/payments/fee/${instance.id}`).set('Authorization', `Bearer ${buyerToken}`).send({});
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      return res.body as PaymentBody;
    }
    async function webhookSucceeded(paymentId: string) {
      return http(app).post('/api/v1/payments/webhook')
        .set('x-payment-webhook-secret', WEBHOOK_SECRET)
        .send({ gateway: 'manual', externalTransactionId: `wh-eg-${paymentId}`, paymentId, status: 'succeeded' });
    }

    const tamperedBuyer = await person();
    const tampered = await manualFeePayment(tamperedBuyer.token);
    await pg.query('update payments set amount = 1 where id = $1', [tampered.id]);
    const blocked = await webhookSucceeded(tampered.id);
    expect(blocked.status).toBeLessThan(300);
    expect((blocked.body as { status: string }).status).toBe('needs_review');
    expect((await http(app).get(`/api/v1/payments/${tampered.id}`).set('Authorization', `Bearer ${admin}`)).body.status).toBe('needs_review');
    expect(await enrolmentActive(course.id, tamperedBuyer.token)).toBe(false);

    const cleanBuyer = await person();
    const clean = await manualFeePayment(cleanBuyer.token);
    const ok = await webhookSucceeded(clean.id);
    expect((ok.body as { status: string }).status).toBe('succeeded');
    expect(await enrolmentActive(course.id, cleanBuyer.token)).toBe(true);
  });

  it('(b6) xử lý tay needs_review: quyết định matched trên payment bị sửa số tiền → bị từ chối payment.target_mismatch, payment giữ needs_review; payment sạch vẫn khớp tay được', async () => {
    const tamperedFixture = await createSepayFeeCourse();
    await postIpn(ipnBody(tamperedFixture.payment.paymentCode!, FEE_COST - 1000));
    await waitPaymentStatus(tamperedFixture.payment.id, 'needs_review');
    // Payment rơi vào hàng đợi vì tiền về sai số tiền; sau đó bản
    // ghi bị can thiệp tiếp (số tiền hạ xuống 1 đồng) — quyết định
    // khớp tay không được phép kích hoạt một payment như vậy.
    await pg.query('update payments set amount = 1 where id = $1', [tamperedFixture.payment.id]);
    const blocked = await http(app).post(`/api/v1/payments/${tamperedFixture.payment.id}/review`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ decision: 'matched', reason: 'Đối chiếu sao kê thủ công' });
    expect(blocked.status).toBe(400);
    expect(JSON.stringify(blocked.body)).toContain('payment.target_mismatch');
    expect((await http(app).get(`/api/v1/payments/${tamperedFixture.payment.id}`).set('Authorization', `Bearer ${admin}`)).body.status).toBe('needs_review');
    expect(await enrolmentActive(tamperedFixture.course.id, tamperedFixture.buyer.token)).toBe(false);

    const cleanFixture = await createSepayFeeCourse();
    await postIpn(ipnBody(cleanFixture.payment.paymentCode!, FEE_COST - 1000));
    await waitPaymentStatus(cleanFixture.payment.id, 'needs_review');
    const resolved = await http(app).post(`/api/v1/payments/${cleanFixture.payment.id}/review`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ decision: 'matched', reason: 'Đã đối chiếu sao kê ngân hàng' });
    expect(resolved.status).toBeLessThan(300);
    expect((resolved.body as PaymentBody).status).toBe('succeeded');
    expect(await enrolmentActive(cleanFixture.course.id, cleanFixture.buyer.token)).toBe(true);
  });

  it('(c1) hồi quy: học phí khoá qua đường chính thức + IPN đúng → succeeded và ghi danh kích hoạt', async () => {
    const { course, buyer, payment } = await createSepayFeeCourse();
    await postIpn(ipnBody(payment.paymentCode!, FEE_COST));
    await waitPaymentStatus(payment.id, 'succeeded');
    expect(await enrolmentActive(course.id, buyer.token)).toBe(true);
  });

  it('(c2) hồi quy: học phí lớp qua đường chính thức + IPN đúng → succeeded và vào roster của lớp', async () => {
    const buyer = await person();
    const created = await http(app).post(`/api/v1/payments/class-fee/${feeClassId}`).set('Authorization', `Bearer ${buyer.token}`).send({});
    expect(created.status).toBeLessThan(300);
    const payment = created.body as PaymentBody;
    await postIpn(ipnBody(payment.paymentCode!, CLASS_FEE));
    await waitPaymentStatus(payment.id, 'succeeded');
    const deadline = Date.now() + 12000;
    for (;;) {
      if ((await rosterIds(feeClassId)).includes(buyer.id) && await enrolmentActive(feeClassCourseId, buyer.token)) return;
      if (Date.now() > deadline) throw new Error('class enrolment was not materialised in time');
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  it('(c3) hồi quy: mua gói giáo viên qua đường chính thức + IPN đúng → succeeded và sinh quyền lợi gói', async () => {
    const buyer = await person();
    const created = await http(app).post('/api/v1/payments/plans').set('Authorization', `Bearer ${buyer.token}`).send({ component: 'teacher_plan' });
    expect(created.status).toBeLessThan(300);
    const payment = created.body as PaymentBody;
    await postIpn(ipnBody(payment.paymentCode!, payment.amount));
    await waitPaymentStatus(payment.id, 'succeeded');
    const entitlements = await pg.query<{ status: string }>(
      'select status from plan_entitlements where payment_id = $1',
      [payment.id],
    );
    expect(entitlements.rows).toHaveLength(1);
    expect(entitlements.rows[0]!.status).toBe('active');
  });
});
