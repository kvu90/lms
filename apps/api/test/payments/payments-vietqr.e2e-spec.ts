import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { decodeQr } from 'vn-qr-pay';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId,
} from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance } from '../support/course-enrolment-helpers';
import { buildVietQrPayload } from '../../src/modules/payments/vietqr';

/**
 * Lát 1 VietQR (issue #189, hồ sơ payment-vietqr §6.4) — bộ nghiệm thu
 * 6.4.1–6.4.7: IPN SePay (verify hai lớp, idempotency, matching 3 điều
 * kiện), QR động + vector vàng của hệ thống, che config 6.4.5, cách ly
 * tenant 6.4.6, cổng cộng dồn hoàn + đảo quyền lợi 6.4.7.
 */
/** Secret webhook gateway 'manual' (cổng verify fail-closed của H1, PR #191): vitest config cấp qua env, spec đọc cùng giá trị để gắn header. */
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
const SEPAY_KEY = 'sk-test-sepay-9f27c1d4aa';
const SEPAY_XID = 'xid-test-org-001';
const BANK_ACCOUNT = '113366668888';

describe('VietQR slice 1: SePay IPN pipeline for enrol_fee (issue #189, §6.4)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;
  let sepayAccountId: string;

  async function createSepayAccount(xid = SEPAY_XID, key = SEPAY_KEY): Promise<string> {
    const res = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({
        name: `SePay ${xid}`, gateway: 'sepay',
        config: { bankCode: 'MBBANK', bankAccountNumber: BANK_ACCOUNT, sepayApiKey: key, sepayBankAccountXid: xid },
      });
    expect(res.status).toBeLessThan(300);
    return res.body.id as string;
  }

  async function createFeeCourse(accountId: string, cost = 100000) {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id, {
      method: 'fee', cost, currency: 'VND', paymentAccountId: accountId,
    });
    const buyer = await createUserViaApi(app, admin);
    const buyerToken = (await login(app, buyer.username, STRONG_PASSWORD)).accessToken;
    return { course, instance, buyer, buyerToken };
  }

  async function createFeePayment(buyerToken: string, instanceId: string) {
    const res = await http(app).post(`/api/v1/payments/fee/${instanceId}`).set('Authorization', `Bearer ${buyerToken}`).send({});
    expect(res.status).toBeLessThan(300);
    return res.body;
  }

  function ipnBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      gateway: 'MBBANK',
      transaction_date: '2026-10-25 17:00:00',
      account_number: BANK_ACCOUNT,
      bank_account_xid: SEPAY_XID,
      content: 'hoc phi khoa hoc',
      transfer_type: 'credit',
      amount: 100000,
      reference_code: `FT${Date.now()}`,
      transaction_id: `sepay-tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...overrides,
    };
  }

  async function postIpn(body: Record<string, unknown>, key = SEPAY_KEY) {
    return http(app).post('/api/v1/payments/ipn/sepay')
      .set('Authorization', `Apikey ${key}`)
      .send(body);
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

  /**
   * Chờ chuỗi đối soát của một payment chốt xong: sự kiện nhà cung
   * cấp đã sang trạng thái 'matched' — matching chỉ chốt 'matched' ở
   * cuối nhịp xử lý của nó, sau khi đã kích hoạt quyền lợi, lật trạng
   * thái payment và ghi sự kiện outbox `payment_succeeded` — đồng
   * thời sự kiện outbox đó đã tồn tại. Sau mốc này không còn khâu bất
   * đồng bộ nào trong chuỗi payment có thể đổi các số đếm được khẳng
   * định, nên việc đếm sau replay IPN chờ tín hiệu này thay cho sleep
   * cố định (cùng khuôn với spec payments-class-fee).
   */
  async function waitForPaymentReconciled(paymentId: string, timeoutMs = 12000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const matched = await pg.query(
        `select count(*)::int as c from payment_provider_events where matched_payment_id = $1 and match_status = 'matched'`,
        [paymentId],
      );
      const outbox = await pg.query(
        `select count(*)::int as c from outbox_events where type = 'payment_succeeded' and payload->>'paymentId' = $1`,
        [paymentId],
      );
      if (matched.rows[0].c >= 1 && outbox.rows[0].c >= 1) return;
      if (Date.now() > deadline) throw new Error(`payment ${paymentId} reconciliation did not settle within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async function enrolmentActive(courseId: string, token: string): Promise<boolean> {
    const res = await http(app).get(`/api/v1/courses/${courseId}/enrolments/me`).set('Authorization', `Bearer ${token}`);
    return res.body.active === true;
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    sepayAccountId = await createSepayAccount();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('6.4.4: QR động khớp vector vàng của hệ thống từng byte và giải mã ngược đúng 54 + 62/08', async () => {
    const payload = buildVietQrPayload(
      { gateway: 'sepay', config: { bankCode: 'MBBANK', bankAccountNumber: BANK_ACCOUNT, sepayBankAccountXid: SEPAY_XID } },
      100000, 'LMS7K3QX9P2M',
    );
    // Vector vàng khoá cứng (sinh qua vn-qr-pay 0.0.5, CRC16-CCITT hợp lệ):
    // trường 01=12 (động), 38/02=QRIBFTTA, 54=100000, 62/08=LMS7K3QX9P2M.
    expect(payload).toBe('00020101021238560010A0000007270126000697042201121133666688880208QRIBFTTA530370454061000005802VN62160812LMS7K3QX9P2M6304630E');
    const decoded = decodeQr(payload!);
    expect(decoded.isValid).toBe(true);
    expect(decoded.amount).toBe('100000');
    expect(decoded.consumer.bankNumber).toBe(BANK_ACCOUNT);
    expect((decoded.additionalData as { purpose?: string }).purpose).toBe('LMS7K3QX9P2M');
  });

  it('6.4.4 + 6.4.5: payment trên account SePay có mã + QR + hạn 24h; config bị che ở list và get', async () => {
    const { instance, buyerToken } = await createFeeCourse(sepayAccountId);
    const payment = await createFeePayment(buyerToken, instance.id);
    expect(payment.paymentCode).toMatch(/^LMS[0-9A-HJKMNP-TV-Z]{9}$/);
    expect(payment.tenantId).toBeTruthy();
    const expires = new Date(payment.expiresAt as string).getTime();
    expect(expires - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
    expect(expires - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000 + 60000);
    expect(typeof payment.vietqrPayload).toBe('string');
    const decoded = decodeQr(payment.vietqrPayload as string);
    expect(decoded.isValid).toBe(true);
    expect(decoded.amount).toBe('100000');
    expect((decoded.additionalData as { purpose?: string }).purpose).toBe(payment.paymentCode);

    // 6.4.5: cả hai endpoint đọc account đều không lộ khoá SePay nguyên văn.
    const list = await http(app).get('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`);
    const listed = (list.body as { id: string; config: Record<string, unknown> }[]).find((a) => a.id === sepayAccountId);
    expect(listed).toBeTruthy();
    expect(JSON.stringify(listed)).not.toContain(SEPAY_KEY);
    expect(listed!.config.sepayApiKey).toBe(`••••••${SEPAY_KEY.slice(-4)}`);
    const single = await http(app).get(`/api/v1/payments/accounts/${sepayAccountId}`).set('Authorization', `Bearer ${admin}`);
    expect(single.status).toBeLessThan(300);
    expect(JSON.stringify(single.body)).not.toContain(SEPAY_KEY);
  });

  it('6.4.4: mã thanh toán sinh một lần và không tái sử dụng — hai payment khác nhau nhận hai mã khác nhau, đọc lại không đổi mã', async () => {
    const { instance, buyerToken } = await createFeeCourse(sepayAccountId);
    const first = await createFeePayment(buyerToken, instance.id);
    const second = await createFeePayment(buyerToken, instance.id);
    expect(first.paymentCode).toMatch(/^LMS[0-9A-HJKMNP-TV-Z]{9}$/);
    expect(second.paymentCode).toMatch(/^LMS[0-9A-HJKMNP-TV-Z]{9}$/);
    expect(second.paymentCode).not.toBe(first.paymentCode);
    expect(second.id).not.toBe(first.id);
    // Mã đã sinh là bất biến: đọc lại payment không sinh mã mới.
    const reread = await http(app).get(`/api/v1/payments/${first.id}`).set('Authorization', `Bearer ${admin}`);
    expect(reread.body.paymentCode).toBe(first.paymentCode);
  });

  it('6.4.1: IPN sai Apikey / IP ngoài allowlist / account lạ → 401, không ghi sự kiện, payment giữ pending', async () => {
    const { instance, buyerToken } = await createFeeCourse(sepayAccountId);
    const payment = await createFeePayment(buyerToken, instance.id);

    const wrongKeyTx = `sepay-tx-wrongkey-${Date.now()}`;
    const wrongKey = await postIpn(ipnBody({ transaction_id: wrongKeyTx, content: `TT ${payment.paymentCode}` }), 'sk-WRONG-key');
    expect(wrongKey.status).toBe(401);

    const unknownTx = `sepay-tx-unknownacct-${Date.now()}`;
    const unknown = await postIpn(ipnBody({ transaction_id: unknownTx, bank_account_xid: 'xid-khong-ton-tai', account_number: '999999999999', content: `TT ${payment.paymentCode}` }));
    expect(unknown.status).toBe(401);

    const allowTx = `sepay-tx-allowlist-${Date.now()}`;
    process.env.SEPAY_IPN_IP_ALLOWLIST = '203.0.113.99';
    try {
      const blocked = await postIpn(ipnBody({ transaction_id: allowTx, content: `TT ${payment.paymentCode}` }));
      expect(blocked.status).toBe(401);
    } finally {
      delete process.env.SEPAY_IPN_IP_ALLOWLIST;
    }

    const events = await pg.query(
      'select count(*)::int as c from payment_provider_events where external_transaction_id = any($1)',
      [[wrongKeyTx, unknownTx, allowTx]],
    );
    expect(events.rows[0].c).toBe(0);
    const after = await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`);
    expect(after.body.status).toBe('pending');
  });

  it('6.4.2 + 6.4.3: IPN khớp đủ 3 điều kiện → succeeded + kích hoạt ghi danh đúng một lần; replay không nhân đôi', async () => {
    const { course, instance, buyerToken } = await createFeeCourse(sepayAccountId);
    const payment = await createFeePayment(buyerToken, instance.id);
    expect(await enrolmentActive(course.id, buyerToken)).toBe(false);

    const body = ipnBody({ content: `FT251025 hoc phi ${payment.paymentCode} cam on` });
    const first = await postIpn(body);
    expect(first.status).toBeLessThan(300);
    expect(first.body.success).toBe(true);

    const succeeded = await waitPaymentStatus(payment.id, 'succeeded');
    expect(succeeded.externalTransactionId).toBe(body.reference_code);
    expect(await enrolmentActive(course.id, buyerToken)).toBe(true);

    const replay = await postIpn(body);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.duplicate).toBe(true);
    // Replay bị từ chối ĐỒNG BỘ ngay trong response (duplicate) nên
    // không phát sinh xử lý nền nào từ phía nó; phía chuỗi đầu thì chờ
    // tín hiệu chốt đối soát tường minh rồi mới đếm — thay sleep cố
    // định 1.500ms không gắn với tín hiệu hoàn tất nào.
    await waitForPaymentReconciled(payment.id);

    const events = await pg.query(
      'select count(*)::int as c from payment_provider_events where external_transaction_id = $1',
      [body.transaction_id],
    );
    expect(events.rows[0].c).toBe(1);
    const outbox = await pg.query(
      `select count(*)::int as c from outbox_events where type = 'payment_succeeded' and payload->>'paymentId' = $1`,
      [payment.id],
    );
    expect(outbox.rows[0].c).toBe(1);
    const enrolments = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolments.body as { userId: string }[]).filter((e) => e.userId === payment.userId)).toHaveLength(1);
  });

  it('6.4.3: sai số tiền → needs_review, không kích hoạt', async () => {
    const { course, instance, buyerToken } = await createFeeCourse(sepayAccountId);
    const payment = await createFeePayment(buyerToken, instance.id);
    const res = await postIpn(ipnBody({ amount: 99000, content: `TT ${payment.paymentCode}` }));
    expect(res.body.success).toBe(true);
    await waitPaymentStatus(payment.id, 'needs_review');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(false);
  });

  it('6.4.3: mã lạ trong nội dung → sự kiện needs_review, payment khác giữ nguyên pending', async () => {
    const { instance, buyerToken } = await createFeeCourse(sepayAccountId);
    const control = await createFeePayment(buyerToken, instance.id);
    const body = ipnBody({ content: 'TT LMSZZZZZZZZ khong thuoc he thong' });
    const res = await postIpn(body);
    expect(res.body.success).toBe(true);
    const start = Date.now();
    let status = '';
    while (Date.now() - start < 12000) {
      const ev = await pg.query('select match_status from payment_provider_events where external_transaction_id = $1', [body.transaction_id]);
      status = ev.rows[0]?.match_status ?? '';
      if (status === 'needs_review') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(status).toBe('needs_review');
    const after = await http(app).get(`/api/v1/payments/${control.id}`).set('Authorization', `Bearer ${admin}`);
    expect(after.body.status).toBe('pending');
  });

  it('6.4.3: tiền về sau hạn QR → needs_review, không kích hoạt', async () => {
    const { course, instance, buyerToken } = await createFeeCourse(sepayAccountId);
    const payment = await createFeePayment(buyerToken, instance.id);
    await pg.query(`update payments set expires_at = now() - interval '1 hour' where id = $1`, [payment.id]);
    const res = await postIpn(ipnBody({ content: `TT ${payment.paymentCode}` }));
    expect(res.body.success).toBe(true);
    await waitPaymentStatus(payment.id, 'needs_review');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(false);
  });

  it('6.4.3 + 6.4.6: IPN vào account khác (tenant khác) mang mã của payment này → không khớp chéo, needs_review', async () => {
    const otherXid = `xid-test-org-002-${Date.now()}`;
    const otherKey = 'sk-test-sepay-other-1234';
    const otherAccountId = await createSepayAccount(otherXid, otherKey);
    const { course, instance, buyerToken } = await createFeeCourse(sepayAccountId);
    const payment = await createFeePayment(buyerToken, instance.id);
    const body = ipnBody({ bank_account_xid: otherXid, content: `TT ${payment.paymentCode}` });
    const res = await http(app).post('/api/v1/payments/ipn/sepay').set('Authorization', `Apikey ${otherKey}`).send(body);
    expect(res.body.success).toBe(true);
    void otherAccountId;
    await waitPaymentStatus(payment.id, 'needs_review');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(false);
  });

  it('6.4.6: tạo payment cho khoá gắn account của tenant khác bị chặn ở service', async () => {
    const { instance, buyerToken } = await createFeeCourse(sepayAccountId);
    // Phẫu thuật fixture: chuyển khoá sang tenant khác trong DB — account giữ nguyên tenant cũ.
    const tenants = await pg.query(`select id from tenants`);
    const courseRow = await pg.query('select tenant_id from course where id = (select course_id from enrol where id = $1)', [instance.id]);
    const otherTenant = (tenants.rows as { id: string }[]).find((t) => t.id !== courseRow.rows[0].tenant_id);
    expect(otherTenant).toBeTruthy();
    await pg.query('update course set tenant_id = $1 where id = (select course_id from enrol where id = $2)', [otherTenant!.id, instance.id]);
    const res = await http(app).post(`/api/v1/payments/fee/${instance.id}`).set('Authorization', `Bearer ${buyerToken}`).send({});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('payment.account_tenant_mismatch');
  });

  it('6.4.7 (lát 3): vòng đời hoàn — một phần tự duyệt một cấp + xác nhận chi giữ quyền lợi; cộng dồn vượt tổng bị chặn; lần hoàn chạm 100% phải hai cấp rồi mới đình chỉ ghi danh tại mốc settled', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const manual = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Manual ${Date.now()}`, gateway: 'manual' });
    const instance = await createEnrolInstance(app, admin, course.id, {
      method: 'fee', cost: 100000, currency: 'VND', paymentAccountId: manual.body.id,
    });
    const buyer = await createUserViaApi(app, admin);
    const buyerToken = (await login(app, buyer.username, STRONG_PASSWORD)).accessToken;
    const payment = await createFeePayment(buyerToken, instance.id);
    expect(payment.paymentCode).toBeNull();
    const hook = await http(app).post('/api/v1/payments/webhook').set('x-payment-webhook-secret', WEBHOOK_SECRET)
      .send({ gateway: 'manual', externalTransactionId: `tx-refund-${Date.now()}`, paymentId: payment.id, status: 'succeeded' });
    expect(hook.body.status).toBe('succeeded');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(true);

    // Lát 3 (issue #189): hoàn tiền là vòng đời duyệt — tạo yêu cầu
    // (`POST :id/refunds`) → duyệt (một cấp tự duyệt / hai cấp khác
    // người tạo) → xác nhận chi (`settle`) mới tính tiền đã ra. Hoàn
    // một phần dưới ngưỡng: MỘT cấp — `approved` ngay khi tạo.
    const partial1 = await http(app).post(`/api/v1/payments/${payment.id}/refunds`).set('Authorization', `Bearer ${admin}`)
      .send({ amount: 40000, reason: 'partial', externalTransactionId: `ft-out-${Date.now()}-1` });
    expect(partial1.status).toBeLessThan(300);
    expect(partial1.body.status).toBe('approved');
    expect(partial1.body.approvalLevel).toBe(1);
    expect(partial1.body.entitlementReversed).toBeNull();
    const settled1 = await http(app).post(`/api/v1/payments/${payment.id}/refunds/${partial1.body.id}/settle`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(settled1.status).toBeLessThan(300);
    expect(settled1.body.status).toBe('settled');
    expect(settled1.body.entitlementReversed).toBe(false);
    expect(await enrolmentActive(course.id, buyerToken)).toBe(true);

    const partial2 = await http(app).post(`/api/v1/payments/${payment.id}/refunds`).set('Authorization', `Bearer ${admin}`)
      .send({ amount: 40000, reason: 'partial 2', externalTransactionId: `ft-out-${Date.now()}-2` });
    expect(partial2.status).toBeLessThan(300);
    const settled2 = await http(app).post(`/api/v1/payments/${payment.id}/refunds/${partial2.body.id}/settle`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(settled2.body.status).toBe('settled');
    // Đã chi 80.000/100.000: khoản thu vẫn succeeded, quyền lợi còn nguyên.
    const midState = await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`);
    expect(midState.body.status).toBe('succeeded');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(true);

    const exceeding = await http(app).post(`/api/v1/payments/${payment.id}/refunds`).set('Authorization', `Bearer ${admin}`)
      .send({ amount: 40000, reason: 'too much', externalTransactionId: `ft-out-${Date.now()}-3` });
    expect(exceeding.status).toBe(400);
    expect(JSON.stringify(exceeding.body)).toContain('payment.refund_exceeds_total');

    // Phần còn lại 20.000 làm cộng dồn đạt 100% → HAI CẤP: tạo bởi
    // manager thứ hai (ở `requested`), admin duyệt, admin xác nhận chi.
    const mgr2 = await createUserViaApi(app, admin);
    await assignRole(app, admin, mgr2.id, await roleIdByShortname(app, admin, 'manager'), await systemContextId(app, admin));
    const mgr2Token = (await login(app, mgr2.username, STRONG_PASSWORD)).accessToken;
    const final = await http(app).post(`/api/v1/payments/${payment.id}/refunds`).set('Authorization', `Bearer ${mgr2Token}`)
      .send({ amount: 20000, reason: 'rest', externalTransactionId: `ft-out-${Date.now()}-4` });
    expect(final.status).toBeLessThan(300);
    expect(final.body.status).toBe('requested');
    expect(final.body.approvalLevel).toBe(2);
    // Chưa xác nhận chi thì khoản thu chưa `refunded`, quyền lợi chưa đảo.
    const beforeSettle = await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`);
    expect(beforeSettle.body.status).toBe('succeeded');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(true);
    const approved = await http(app).post(`/api/v1/payments/${payment.id}/refunds/${final.body.id}/approve`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(approved.status).toBeLessThan(300);
    expect(approved.body.status).toBe('approved');
    const settledFinal = await http(app).post(`/api/v1/payments/${payment.id}/refunds/${final.body.id}/settle`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(settledFinal.status).toBeLessThan(300);
    expect(settledFinal.body.status).toBe('settled');
    expect(settledFinal.body.entitlementReversed).toBe(true);
    const after = await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`);
    expect(after.body.status).toBe('refunded');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(false);
  });
});
