import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId,
} from '../support/identity-access-helpers';

/**
 * Lát 2 của issue #189 — mô hình gói `tenant_plan`/`teacher_plan` với
 * GIÁ TỪ CẤU HÌNH HỆ THỐNG: mua gói chạy trọn pipeline VietQR → IPN
 * SePay → khớp 3 điều kiện → kích hoạt quyền lợi đúng bên hưởng + đúng
 * cửa sổ chu kỳ; đổi giá trong Cài đặt hệ thống thì khoản thu tạo sau
 * dùng giá mới (không cần triển khai lại); lệch đối soát →
 * `needs_review` và không sinh quyền lợi; hoàn đủ → đình chỉ quyền
 * lợi của chính payment đó.
 *
 * Giá trị khởi tạo trong registry (component `payments`): gói trung
 * tâm 6.000.000đ / 365 ngày, gói giáo viên 990.000đ / 365 ngày — spec
 * đọc các số này qua hành vi (số tiền của payment tạo ra), không qua
 * hằng số riêng nào khác ngoài chính kỳ vọng nghiệm thu dưới đây.
 */
const SEPAY_KEY = 'sk-test-sepay-plan-001';
const SEPAY_XID = 'xid-test-plan-001';
const BANK_ACCOUNT = '113366669999';
const TENANT_PLAN_DEFAULT_PRICE = 6000000;
const TEACHER_PLAN_DEFAULT_PRICE = 990000;
const DAY_MS = 86_400_000;

describe('Plan purchases: tenant_plan + teacher_plan over the VietQR pipeline (issue #189, slice 2)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;
  let sepayAccountId: string;
  let disabledAccountIds: string[] = [];

  async function createBuyer() {
    const buyer = await createUserViaApi(app, admin);
    const token = (await login(app, buyer.username, STRONG_PASSWORD)).accessToken;
    return { buyer, token };
  }

  async function buyPlan(token: string, component: 'tenant_plan' | 'teacher_plan') {
    const res = await http(app).post('/api/v1/payments/plans').set('Authorization', `Bearer ${token}`).send({ component });
    expect(res.status).toBeLessThan(300);
    return res.body;
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
      transaction_id: `sepay-tx-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  async function postIpn(body: Record<string, unknown>) {
    const res = await http(app).post('/api/v1/payments/ipn/sepay')
      .set('Authorization', `Apikey ${SEPAY_KEY}`)
      .send(body);
    expect(res.status).toBeLessThan(300);
    expect(res.body.success).toBe(true);
    return res;
  }

  async function waitPaymentStatus(id: string, want: string, timeoutMs = 12000): Promise<Record<string, unknown>> {
    const start = Date.now();
    let last: Record<string, unknown> = {};
    while (Date.now() - start < timeoutMs) {
      const res = await http(app).get(`/api/v1/payments/${id}`).set('Authorization', `Bearer ${admin}`);
      last = res.body;
      if (last.status === want) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`payment ${id} did not reach status ${want} (last: ${String(last.status)})`);
  }

  async function entitlementOf(paymentId: string) {
    const rows = await pg.query(
      'select tenant_id, user_id, component, status, starts_at, expires_at from plan_entitlements where payment_id = $1',
      [paymentId],
    );
    return rows.rows[0] as
      | { tenant_id: string; user_id: string | null; component: string; status: string; starts_at: Date; expires_at: Date }
      | undefined;
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const res = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({
        name: 'SePay platform plans', gateway: 'sepay',
        config: { bankCode: 'MBBANK', bankAccountNumber: BANK_ACCOUNT, sepayApiKey: SEPAY_KEY, sepayBankAccountXid: SEPAY_XID },
      });
    expect(res.status).toBeLessThan(300);
    sepayAccountId = res.body.id as string;
    // Mua gói chọn tài khoản đang bật của tenant platform: vô hiệu hoá
    // tạm các tài khoản khác của tenant đó (fixture của các spec chạy
    // trước để lại) để đường mua gói trong spec này xác định duy nhất;
    // khôi phục nguyên trạng ở afterAll.
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

  it('tenant_plan: giá khởi tạo từ cấu hình + QR động; IPN khớp đủ → quyền lợi của tenant, cửa sổ 365 ngày', async () => {
    const { token } = await createBuyer();
    const payment = await buyPlan(token, 'tenant_plan');
    expect(payment.amount).toBe(TENANT_PLAN_DEFAULT_PRICE);
    expect(payment.component).toBe('tenant_plan');
    expect(payment.accountId).toBe(sepayAccountId);
    expect(payment.paymentCode).toMatch(/^LMS[0-9A-HJKMNP-TV-Z]{9}$/);
    // Ghi vết giá đã áp vào chính bản ghi payment.
    expect(payment.data?.plan?.configuredPrice).toBe(TENANT_PLAN_DEFAULT_PRICE);
    expect(payment.data?.plan?.periodDays).toBe(365);

    await postIpn(ipnBody(payment.paymentCode, TENANT_PLAN_DEFAULT_PRICE));
    await waitPaymentStatus(payment.id, 'succeeded');

    const entitlement = await entitlementOf(payment.id);
    expect(entitlement).toBeTruthy();
    expect(entitlement!.component).toBe('tenant_plan');
    expect(entitlement!.user_id).toBeNull();
    // Bên hưởng của quyền lợi là tenant ghi trong ẢNH CHỤP của payment
    // (data.plan.beneficiaryTenantId — tenant hiệu lực của người mua),
    // KHÔNG phải tenant của tài khoản nhận tiền (payment.tenantId):
    // hai khái niệm này chỉ trùng nhau ở fixture này vì người mua
    // đang ở tenant mặc định, cũng là tenant của tài khoản platform.
    expect(entitlement!.tenant_id).toBe(payment.data.plan.beneficiaryTenantId);
    expect(entitlement!.status).toBe('active');
    const windowMs = new Date(entitlement!.expires_at).getTime() - new Date(entitlement!.starts_at).getTime();
    expect(Math.abs(windowMs - 365 * DAY_MS)).toBeLessThan(60_000);
    expect(new Date(entitlement!.starts_at).getTime()).toBeLessThanOrEqual(Date.now());

    // Bề mặt "gói của tôi" của người mua thấy quyền lợi này.
    const mine = await http(app).get('/api/v1/payments/plans/me').set('Authorization', `Bearer ${token}`);
    expect(mine.status).toBeLessThan(300);
    expect((mine.body as { paymentId: string }[]).some((e) => e.paymentId === payment.id)).toBe(true);
  });

  it('teacher_plan: IPN khớp đủ → quyền lợi gắn đúng giáo viên mua gói', async () => {
    const { token } = await createBuyer();
    const payment = await buyPlan(token, 'teacher_plan');
    expect(payment.amount).toBe(TEACHER_PLAN_DEFAULT_PRICE);
    expect(payment.data?.plan?.beneficiaryUserId).toBe(payment.userId);

    await postIpn(ipnBody(payment.paymentCode, TEACHER_PLAN_DEFAULT_PRICE));
    await waitPaymentStatus(payment.id, 'succeeded');

    const entitlement = await entitlementOf(payment.id);
    expect(entitlement).toBeTruthy();
    expect(entitlement!.component).toBe('teacher_plan');
    expect(entitlement!.user_id).toBe(payment.userId);
    expect(entitlement!.status).toBe('active');
  });

  it('mua tiếp khi gói giáo viên còn hạn: cửa sổ mới nối tiếp từ mốc hết hạn hiện tại', async () => {
    const { token } = await createBuyer();
    const first = await buyPlan(token, 'teacher_plan');
    await postIpn(ipnBody(first.paymentCode, TEACHER_PLAN_DEFAULT_PRICE));
    await waitPaymentStatus(first.id, 'succeeded');
    const firstEntitlement = await entitlementOf(first.id);
    expect(firstEntitlement).toBeTruthy();

    const second = await buyPlan(token, 'teacher_plan');
    await postIpn(ipnBody(second.paymentCode, TEACHER_PLAN_DEFAULT_PRICE));
    await waitPaymentStatus(second.id, 'succeeded');
    const secondEntitlement = await entitlementOf(second.id);
    expect(secondEntitlement).toBeTruthy();
    const gapMs = Math.abs(
      new Date(secondEntitlement!.starts_at).getTime() - new Date(firstEntitlement!.expires_at).getTime(),
    );
    expect(gapMs).toBeLessThan(2000);
  });

  it('đổi giá trong Cài đặt hệ thống: khoản thu tạo sau dùng giá mới, không cần triển khai lại', async () => {
    const { token } = await createBuyer();
    const NEW_PRICE = 12345000;
    const set = await http(app).put('/api/v1/site-config/payments/tenantplanprice')
      .set('Authorization', `Bearer ${admin}`)
      .send({ value: NEW_PRICE });
    expect(set.status).toBeLessThan(300);
    expect(set.body.value).toBe(NEW_PRICE);
    try {
      const payment = await buyPlan(token, 'tenant_plan');
      expect(payment.amount).toBe(NEW_PRICE);
      expect(payment.data?.plan?.configuredPrice).toBe(NEW_PRICE);
    } finally {
      const clear = await http(app).delete('/api/v1/site-config/payments/tenantplanprice')
        .set('Authorization', `Bearer ${admin}`);
      expect(clear.status).toBeLessThan(300);
    }
    // Xoá ghi đè xong, giá hiệu lực trở về giá trị khởi tạo.
    const restored = await buyPlan(token, 'tenant_plan');
    expect(restored.amount).toBe(TENANT_PLAN_DEFAULT_PRICE);
  });

  it('sai số tiền → needs_review và KHÔNG sinh quyền lợi', async () => {
    const { token } = await createBuyer();
    const payment = await buyPlan(token, 'teacher_plan');
    await postIpn(ipnBody(payment.paymentCode, TEACHER_PLAN_DEFAULT_PRICE - 1000));
    await waitPaymentStatus(payment.id, 'needs_review');
    expect(await entitlementOf(payment.id)).toBeUndefined();
  });

  it('hoàn đủ tiền của payment gói (lát 3: hai cấp + xác nhận chi) → quyền lợi của chính payment đó bị đình chỉ tại mốc settled', async () => {
    const { token } = await createBuyer();
    const payment = await buyPlan(token, 'teacher_plan');
    await postIpn(ipnBody(payment.paymentCode, TEACHER_PLAN_DEFAULT_PRICE));
    await waitPaymentStatus(payment.id, 'succeeded');
    expect((await entitlementOf(payment.id))!.status).toBe('active');

    // Hoàn 100% luôn HAI CẤP dù số tiền dưới ngưỡng mặc định: tạo yêu
    // cầu ở `requested`; quyền lợi chưa bị đụng cho tới mốc settled.
    const refund = await http(app).post(`/api/v1/payments/${payment.id}/refunds`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ amount: TEACHER_PLAN_DEFAULT_PRICE, reason: 'full refund', externalTransactionId: `ft-out-plan-${Date.now()}` });
    expect(refund.status).toBeLessThan(300);
    expect(refund.body.status).toBe('requested');
    expect(refund.body.approvalLevel).toBe(2);
    expect((await entitlementOf(payment.id))!.status).toBe('active');

    const mgr2 = await createUserViaApi(app, admin);
    await assignRole(app, admin, mgr2.id, await roleIdByShortname(app, admin, 'manager'), await systemContextId(app, admin));
    const mgr2Token = (await login(app, mgr2.username, STRONG_PASSWORD)).accessToken;
    const approved = await http(app).post(`/api/v1/payments/${payment.id}/refunds/${refund.body.id}/approve`)
      .set('Authorization', `Bearer ${mgr2Token}`).send({});
    expect(approved.status).toBeLessThan(300);
    expect(approved.body.status).toBe('approved');
    expect((await entitlementOf(payment.id))!.status).toBe('active');

    const settled = await http(app).post(`/api/v1/payments/${payment.id}/refunds/${refund.body.id}/settle`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(settled.status).toBeLessThan(300);
    expect(settled.body.status).toBe('settled');
    expect(settled.body.entitlementReversed).toBe(true);
    expect((await entitlementOf(payment.id))!.status).toBe('suspended');
    const after = await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`);
    expect(after.body.status).toBe('refunded');
  });
});
