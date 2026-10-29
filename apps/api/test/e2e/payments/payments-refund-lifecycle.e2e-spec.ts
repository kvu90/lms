import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  ADMIN, assignRole, createRoleViaApi, createTestApp, createUserViaApi,
  http, login, roleIdByShortname, setOverride, STRONG_PASSWORD, systemContextId, uniqueName,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance } from '../../support/course-enrolment-helpers';
import { TenantConfigService } from '../../../src/modules/tenants/tenant-config.service';

/**
 * Lát 3 (cuối) của issue #189 — vòng đời duyệt hoàn + hàng đợi
 * `needs_review` theo chủ tiền. Bộ ca bám hai quyết định vận hành đã
 * ghi trong issue và ba yêu cầu kỹ thuật đi kèm:
 *  1. Tạo yêu cầu hoàn: lý do BẮT BUỘC; một cấp (tự duyệt ngay) khi
 *     hoàn một phần dưới ngưỡng; HAI CẤP khi lần hoàn từ ngưỡng trở
 *     lên hoặc làm cộng dồn đạt 100% — ngưỡng là khoá cấu hình
 *     `refunddualapprovalthreshold` (mặc định 1.000.000, ghi đè được).
 *  2. Duyệt cấp 2 phải KHÁC người tạo (chặn ở service, mã
 *     `payment.refund_approver_must_differ`); từ chối bắt buộc lý do
 *     và giải phóng ngân sách cộng dồn.
 *  3. Cổng cộng dồn NGUYÊN TỬ: hai yêu cầu song song vượt tổng thì
 *     đúng một yêu cầu qua, một yêu cầu nhận
 *     `payment.refund_exceeds_total`.
 *  4. Đảo quyền lợi CHỈ tại mốc `settled` khi cộng dồn đã chi đạt
 *     100%, theo thứ tự đình chỉ-trước-ghi-sau: khâu đình chỉ lỗi ⇒
 *     chưa ghi gì, khoản thu còn `succeeded`, gọi lại được. Quyết
 *     định đình chỉ phải dựa trên tổng đã khoá dòng khoản thu: hai
 *     dòng hoàn bù nhau cùng xác nhận chi ĐỒNG THỜI thì lượt làm
 *     cộng dồn đạt 100% phải đình chỉ thật — không được lật
 *     `refunded` trong khi quyền lợi chưa hề bị đình chỉ (ca 10).
 *  5. Sự kiện `debit` SePay khớp dòng hoàn đang chờ theo (mã lệnh
 *     chi, tài khoản, số tiền) → tự xác nhận chi; debit không khớp →
 *     `needs_review` của chủ tài khoản, hiện trong hàng đợi.
 *  6. Hàng đợi chia theo chủ tiền: trung tâm chỉ thấy/xử lý khoản chờ
 *     của mình (gồm tự hoàn học phí bằng cổng neo tại context tenant),
 *     platform không thấy khoản của trung tâm; vết xử lý bắt buộc;
 *     quá hạn theo `payments/reviewtargethours` chỉ là cảnh báo.
 *  7. Ba chốt kỹ thuật của lượt dọn antipattern backend (ca 11–13):
 *     duyệt/từ chối hoàn chuyển trạng thái bằng cập nhật CÓ ĐIỀU KIỆN
 *     nên hai lượt đua trên cùng một dòng chỉ một lượt thắng, lượt
 *     thua nhận mã lỗi trạng thái của chính đường gọi đó; đối soát
 *     `reconcile` đếm ở SQL và khớp phép đếm độc lập; hàng đợi duyệt
 *     tra cấu hình ngưỡng quá hạn tối đa một lần cho mỗi tenant
 *     trong một lần dựng.
 * Đổi luật (bỏ bắt buộc lý do, cho tự duyệt hai cấp, đảo quyền lợi
 * sớm hơn mốc settled, rò khoản chờ chéo tenant…) thì ca tương ứng
 * phải đỏ.
 */
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
// Định danh SePay RIÊNG của spec này — tuyệt đối không trùng xid/số
// tài khoản với các spec payments khác (DB test dùng chung cho cả
// suite; hai tài khoản cùng xid sẽ làm định tuyến IPN lệch tài khoản
// và khoản thu của spec khác rơi vào needs_review oan).
const SEPAY_KEY = 'sk-test-sepay-slice3-3e7a';
const SEPAY_XID = 'xid-test-slice3-001';
const BANK_ACCOUNT = '113366667777';
const CENTER_KEY = 'sk-test-sepay-center-5678';
const CENTER_XID = `xid-ctr-${Date.now()}`;
const CENTER_BANK = '113366660001';

describe('Lát 3 #189: vòng đời hoàn tiền + hàng đợi needs_review theo chủ tiền', () => {
  let app: INestApplication;
  let admin: string;
  let adminId: string;
  let pg: Client;
  let sepayAccountId: string;

  async function createSepayAccount(token: string, xid = SEPAY_XID, key = SEPAY_KEY, bank = BANK_ACCOUNT): Promise<string> {
    const res = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${token}`)
      .send({
        name: `SePay ${xid}`, gateway: 'sepay',
        config: { bankCode: 'MBBANK', bankAccountNumber: bank, sepayApiKey: key, sepayBankAccountXid: xid },
      });
    expect(res.status).toBeLessThan(300);
    return res.body.id as string;
  }

  async function createFeeCourse(token: string, accountId: string, cost = 100000) {
    const cat = await createCategory(app, token);
    const course = await createCourse(app, token, cat.id);
    const instance = await createEnrolInstance(app, token, course.id, {
      method: 'fee', cost, currency: 'VND', paymentAccountId: accountId,
    });
    return { course, instance };
  }

  async function createFeePayment(buyerToken: string, instanceId: string) {
    const res = await http(app).post(`/api/v1/payments/fee/${instanceId}`).set('Authorization', `Bearer ${buyerToken}`).send({});
    expect(res.status).toBeLessThan(300);
    return res.body;
  }

  /** Khoản thu enrol_fee 100.000 trên gateway manual đã succeeded qua webhook — fixture gốc của các ca hoàn tay. */
  async function manualSucceededPayment() {
    const manual = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Manual ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, gateway: 'manual' });
    expect(manual.status).toBeLessThan(300);
    const { course, instance } = await createFeeCourse(admin, manual.body.id as string);
    const buyer = await createUserViaApi(app, admin);
    const buyerToken = (await login(app, buyer.username, STRONG_PASSWORD)).accessToken;
    const payment = await createFeePayment(buyerToken, instance.id);
    const hook = await http(app).post('/api/v1/payments/webhook').set('x-payment-webhook-secret', WEBHOOK_SECRET)
      .send({ gateway: 'manual', externalTransactionId: `tx-s3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, paymentId: payment.id, status: 'succeeded' });
    expect(hook.body.status).toBe('succeeded');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(true);
    return { course, instance, buyer, buyerToken, payment };
  }

  function ipnBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      gateway: 'MBBANK',
      transaction_date: '2026-10-27 17:00:00',
      account_number: BANK_ACCOUNT,
      bank_account_xid: SEPAY_XID,
      content: 'hoc phi khoa hoc',
      transfer_type: 'credit',
      amount: 100000,
      reference_code: `FT${Date.now()}${Math.floor(Math.random() * 1000)}`,
      transaction_id: `sepay-tx-s3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...overrides,
    };
  }

  async function postIpn(body: Record<string, unknown>, key = SEPAY_KEY) {
    const res = await http(app).post('/api/v1/payments/ipn/sepay')
      .set('Authorization', `Apikey ${key}`)
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

  async function waitEventStatus(txId: string, want: string, timeoutMs = 12000): Promise<Record<string, unknown>> {
    const start = Date.now();
    let last: Record<string, unknown> = {};
    while (Date.now() - start < timeoutMs) {
      const ev = await pg.query('select id, match_status from payment_provider_events where external_transaction_id = $1', [txId]);
      last = (ev.rows[0] ?? {}) as Record<string, unknown>;
      if (last.match_status === want) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`event ${txId} did not reach match_status ${want} (last: ${String(last.match_status)})`);
  }

  async function enrolmentActive(courseId: string, token: string): Promise<boolean> {
    const res = await http(app).get(`/api/v1/courses/${courseId}/enrolments/me`).set('Authorization', `Bearer ${token}`);
    return res.body.active === true;
  }

  /** Manager thứ hai tại context hệ thống — người duyệt cấp 2 khác người tạo. */
  async function secondManager(): Promise<{ id: string; token: string }> {
    const user = await createUserViaApi(app, admin);
    await assignRole(app, admin, user.id, await roleIdByShortname(app, admin, 'manager'), await systemContextId(app, admin));
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { id: user.id, token };
  }

  async function createRefund(token: string, paymentId: string, body: Record<string, unknown>) {
    return http(app).post(`/api/v1/payments/${paymentId}/refunds`).set('Authorization', `Bearer ${token}`).send(body);
  }
  async function approveRefund(token: string, paymentId: string, refundId: string) {
    return http(app).post(`/api/v1/payments/${paymentId}/refunds/${refundId}/approve`).set('Authorization', `Bearer ${token}`).send({});
  }
  async function settleRefund(token: string, paymentId: string, refundId: string, body: Record<string, unknown> = {}) {
    return http(app).post(`/api/v1/payments/${paymentId}/refunds/${refundId}/settle`).set('Authorization', `Bearer ${token}`).send(body);
  }
  async function listRefunds(paymentId: string) {
    const res = await http(app).get(`/api/v1/payments/${paymentId}/refunds`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>[];
  }

  beforeAll(async () => {
    app = await createTestApp();
    const adminLogin = await login(app, ADMIN.username, ADMIN.password);
    admin = adminLogin.accessToken;
    adminId = adminLogin.userId;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    sepayAccountId = await createSepayAccount(admin);
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('1. tạo yêu cầu hoàn: lý do là bắt buộc và payment chưa succeeded không hoàn được', async () => {
    const { payment } = await manualSucceededPayment();
    const noReason = await createRefund(admin, payment.id, { amount: 1000 });
    expect(noReason.status).toBe(400);
    const blankReason = await createRefund(admin, payment.id, { amount: 1000, reason: '   ' });
    expect(blankReason.status).toBe(400);
    const badAmount = await createRefund(admin, payment.id, { amount: 0, reason: 'sai số tiền' });
    expect(badAmount.status).toBe(400);

    // Payment còn pending (chưa có webhook succeeded) → payment.not_succeeded.
    const manual = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Manual pending ${Date.now()}`, gateway: 'manual' });
    const { instance } = await createFeeCourse(admin, manual.body.id as string);
    const buyer = await createUserViaApi(app, admin);
    const buyerToken = (await login(app, buyer.username, STRONG_PASSWORD)).accessToken;
    const pending = await createFeePayment(buyerToken, instance.id);
    const res = await createRefund(admin, pending.id, { amount: 1000, reason: 'chưa thu tiền' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('payment.not_succeeded');
  });

  it('2. một cấp: hoàn một phần dưới ngưỡng tự duyệt ngay; xác nhận chi → settled với đủ vết kiểm toán, quyền lợi giữ nguyên', async () => {
    const { course, buyerToken, payment } = await manualSucceededPayment();
    const ftCode = `FT-S3-ONE-${Date.now()}`;
    const created = await createRefund(admin, payment.id, { amount: 30000, reason: 'Học viên xin hoàn một phần', externalTransactionId: ftCode });
    expect(created.status).toBeLessThan(300);
    expect(created.body.status).toBe('approved');
    expect(created.body.approvalLevel).toBe(1);
    expect(created.body.approvalThreshold).toBe(1000000);
    expect(created.body.createdBy).toBe(adminId);
    expect(created.body.approvedBy).toBe(adminId);
    expect(created.body.approvedAt).toBeTruthy();
    expect(created.body.settledAt).toBeNull();
    expect(created.body.entitlementReversed).toBeNull();
    // Chưa xác nhận chi: khoản thu chưa đổi trạng thái, quyền lợi còn nguyên.
    expect((await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`)).body.status).toBe('succeeded');

    const settled = await settleRefund(admin, payment.id, created.body.id);
    expect(settled.status).toBeLessThan(300);
    expect(settled.body.status).toBe('settled');
    expect(settled.body.settledBy).toBe(adminId);
    expect(settled.body.settledEventId).toBeNull();
    expect(settled.body.settledAt).toBeTruthy();
    expect(settled.body.externalTransactionId).toBe(ftCode);
    expect(settled.body.entitlementReversed).toBe(false);
    expect((await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`)).body.status).toBe('succeeded');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(true);
    const refunds = await listRefunds(payment.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe('settled');
  });

  it('3. hai cấp theo ngưỡng cấu hình: tạo ở requested, người tạo không tự duyệt được, người thứ hai duyệt rồi xác nhận chi', async () => {
    const { payment } = await manualSucceededPayment();
    const mgr2 = await secondManager();
    const set = await http(app).put('/api/v1/site-config/payments/refunddualapprovalthreshold')
      .set('Authorization', `Bearer ${admin}`).send({ value: 30000 });
    expect(set.status).toBeLessThan(300);
    try {
      const created = await createRefund(admin, payment.id, { amount: 40000, reason: 'Hoàn trên ngưỡng hai cấp' });
      expect(created.status).toBeLessThan(300);
      expect(created.body.status).toBe('requested');
      expect(created.body.approvalLevel).toBe(2);
      expect(created.body.approvalThreshold).toBe(30000);
      expect(created.body.approvedBy).toBeNull();

      const selfApprove = await approveRefund(admin, payment.id, created.body.id);
      expect(selfApprove.status).toBe(400);
      expect(JSON.stringify(selfApprove.body)).toContain('payment.refund_approver_must_differ');

      const approved = await approveRefund(mgr2.token, payment.id, created.body.id);
      expect(approved.status).toBeLessThan(300);
      expect(approved.body.status).toBe('approved');
      expect(approved.body.approvedBy).toBe(mgr2.id);

      const settled = await settleRefund(admin, payment.id, created.body.id, { externalTransactionId: `FT-S3-TWO-${Date.now()}` });
      expect(settled.status).toBeLessThan(300);
      expect(settled.body.status).toBe('settled');
    } finally {
      const clear = await http(app).delete('/api/v1/site-config/payments/refunddualapprovalthreshold')
        .set('Authorization', `Bearer ${admin}`);
      expect(clear.status).toBeLessThan(300);
    }
  });

  it('4. từ chối: lý do bắt buộc, vết từ chối đầy đủ, và dòng rejected giải phóng ngân sách cộng dồn', async () => {
    const { payment } = await manualSucceededPayment();
    const created = await createRefund(admin, payment.id, { amount: 60000, reason: 'Xin hoàn 60%' });
    expect(created.status).toBeLessThan(300);
    expect(created.body.status).toBe('approved');

    const noReason = await http(app).post(`/api/v1/payments/${payment.id}/refunds/${created.body.id}/reject`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(noReason.status).toBe(400);

    const rejected = await http(app).post(`/api/v1/payments/${payment.id}/refunds/${created.body.id}/reject`)
      .set('Authorization', `Bearer ${admin}`).send({ reason: 'Chưa đủ chứng từ hoàn' });
    expect(rejected.status).toBeLessThan(300);
    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.rejectedBy).toBe(adminId);
    expect(rejected.body.rejectionReason).toBe('Chưa đủ chứng từ hoàn');
    expect(rejected.body.rejectedAt).toBeTruthy();

    // Ngân sách đã giải phóng: tạo yêu cầu hoàn đủ 100% được (nếu dòng
    // rejected còn giữ chỗ, 60.000 + 100.000 > 100.000 sẽ bị chặn).
    const full = await createRefund(admin, payment.id, { amount: 100000, reason: 'Hoàn toàn bộ sau khi bổ sung chứng từ' });
    expect(full.status).toBeLessThan(300);
    expect(full.body.status).toBe('requested');
    expect(full.body.approvalLevel).toBe(2);
  });

  it('5. cổng cộng dồn nguyên tử: hai yêu cầu song song vượt tổng → đúng một qua, một nhận payment.refund_exceeds_total', async () => {
    const { payment } = await manualSucceededPayment();
    const mk = () => createRefund(admin, payment.id, { amount: 60000, reason: 'Yêu cầu song song' });
    const [r1, r2] = await Promise.all([mk(), mk()]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(400);
    const loser = r1.status === 400 ? r1 : r2;
    expect(JSON.stringify(loser.body)).toContain('payment.refund_exceeds_total');
    const refunds = await listRefunds(payment.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amount).toBe(60000);
  });

  it('6. thứ tự đình chỉ-trước-ghi-sau: khâu đình chỉ lỗi → chưa ghi gì (refund còn approved, payment còn succeeded), gọi lại được', async () => {
    const { course, buyerToken, payment } = await manualSucceededPayment();
    // Người xác nhận chi CHỈ có payment:manageaccounts (vai tuỳ biến),
    // không có enrol:manage — khâu đình chỉ ghi danh sẽ ném lỗi quyền.
    const roleId = await createRoleViaApi(app, admin);
    const sysCtx = await systemContextId(app, admin);
    await setOverride(app, admin, roleId, 'payment:manageaccounts', sysCtx, 1);
    const cashier = await createUserViaApi(app, admin);
    await assignRole(app, admin, cashier.id, roleId, sysCtx);
    const cashierToken = (await login(app, cashier.username, STRONG_PASSWORD)).accessToken;

    const created = await createRefund(cashierToken, payment.id, { amount: 100000, reason: 'Hoàn toàn bộ do thu ngân tạo' });
    expect(created.status).toBeLessThan(300);
    expect(created.body.status).toBe('requested');
    const approved = await approveRefund(admin, payment.id, created.body.id);
    expect(approved.status).toBeLessThan(300);
    expect(approved.body.status).toBe('approved');

    const failed = await settleRefund(cashierToken, payment.id, created.body.id, { externalTransactionId: `FT-S3-ORD-${Date.now()}` });
    expect(failed.status).toBe(403);
    // Chưa ghi gì: dòng hoàn còn approved/chưa settled, khoản thu còn
    // succeeded, ghi danh còn active — trạng thái nhất quán để gọi lại.
    const refunds = await listRefunds(payment.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe('approved');
    expect(refunds[0]!.settledAt).toBeNull();
    expect((await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`)).body.status).toBe('succeeded');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(true);

    // Gọi lại bởi người có đủ quyền: trọn vẹn đình chỉ + refunded.
    const settled = await settleRefund(admin, payment.id, created.body.id, { externalTransactionId: `FT-S3-ORD-${Date.now()}` });
    expect(settled.status).toBeLessThan(300);
    expect(settled.body.status).toBe('settled');
    expect(settled.body.entitlementReversed).toBe(true);
    expect((await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`)).body.status).toBe('refunded');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(false);
  });

  it('7. đối khớp debit SePay: debit khớp dòng hoàn chờ → tự settled qua sự kiện; debit lạ → needs_review và hiện trong hàng đợi platform', async () => {
    const { course, instance } = await createFeeCourse(admin, sepayAccountId);
    const buyer = await createUserViaApi(app, admin);
    const buyerToken = (await login(app, buyer.username, STRONG_PASSWORD)).accessToken;
    const payment = await createFeePayment(buyerToken, instance.id);
    const credit = ipnBody({ content: `FT hoc phi ${payment.paymentCode}` });
    await postIpn(credit);
    await waitPaymentStatus(payment.id, 'succeeded');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(true);

    const ftCode = `FT-OUT-DEBIT-${Date.now()}`;
    const created = await createRefund(admin, payment.id, { amount: 40000, reason: 'Hoàn qua chuyển khoản ngân hàng', externalTransactionId: ftCode });
    expect(created.status).toBeLessThan(300);
    expect(created.body.status).toBe('approved');

    const debitTx = `sepay-debit-${Date.now()}-a`;
    await postIpn(ipnBody({
      transaction_id: debitTx, transfer_type: 'debit', amount: 40000,
      reference_code: ftCode, content: `hoan tien ${ftCode}`,
    }));
    const start = Date.now();
    let settled: Record<string, unknown> | undefined;
    while (Date.now() - start < 12000) {
      const refunds = await listRefunds(payment.id);
      settled = refunds[0];
      if (settled?.status === 'settled') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(settled?.status).toBe('settled');
    expect(settled?.settledBy).toBeNull();
    expect(settled?.settledEventId).toBeTruthy();
    expect(settled?.entitlementReversed).toBe(false);
    const debitEvent = await waitEventStatus(debitTx, 'matched');
    expect(debitEvent.id).toBe(settled?.settledEventId);
    // Hoàn một phần: khoản thu vẫn succeeded, ghi danh còn active.
    expect((await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`)).body.status).toBe('succeeded');
    expect(await enrolmentActive(course.id, buyerToken)).toBe(true);

    // Debit không khớp dòng hoàn nào → needs_review của chủ tài khoản
    // (platform) và hiện thành mục sự kiện mồ côi trong hàng đợi.
    const orphanTx = `sepay-debit-${Date.now()}-b`;
    await postIpn(ipnBody({
      transaction_id: orphanTx, transfer_type: 'debit', amount: 7777,
      reference_code: `FT-KHONG-KHOP-${Date.now()}`, content: 'chi khong ro nguon',
    }));
    const orphan = await waitEventStatus(orphanTx, 'needs_review');
    const queue = await http(app).get('/api/v1/payments/review-queue').set('Authorization', `Bearer ${admin}`);
    expect(queue.status).toBe(200);
    const item = (queue.body as Record<string, unknown>[]).find(
      (i) => i.kind === 'event' && (i.event as Record<string, unknown>)?.id === orphan.id,
    );
    expect(item).toBeTruthy();
    expect(item!.mismatches).toContain('unmatched_debit');
    expect(item!.overdue).toBe(false);
  });

  it('8. hàng đợi theo chủ tiền: trung tâm chỉ thấy khoản chờ của mình, tự xử lý và tự hoàn học phí; hai phía không chạm tiền của nhau', async () => {
    // --- Dựng trung tâm + người vận hành của trung tâm ----------------
    const slug = `ctr-${uniqueName('c').toLowerCase()}`;
    const tenantRes = await http(app).post('/api/v1/tenants').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Trung tâm (spec lát 3)', slug, kind: 'school' });
    expect(tenantRes.status).toBeLessThan(300);
    const tenantId = (tenantRes.body as { id: string }).id;

    const centerMgr = await createUserViaApi(app, admin);
    const buyerUser = await createUserViaApi(app, admin);
    const addMember = async (userId: string) => {
      const res = await http(app).post(`/api/v1/tenants/${tenantId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId });
      expect(res.status).toBeLessThan(300);
    };
    await addMember(adminId);
    await addMember(centerMgr.id);
    await addMember(buyerUser.id);

    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const tenantCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 20 && c.instanceId === tenantId);
    expect(tenantCtx).toBeTruthy();
    const managerRole = await roleIdByShortname(app, admin, 'manager');
    await assignRole(app, admin, adminId, managerRole, tenantCtx!.id);
    await assignRole(app, admin, centerMgr.id, managerRole, tenantCtx!.id);

    const switchTo = async (token: string) => {
      const res = await http(app).post(`/api/v1/auth/switch-tenant/${tenantId}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBeLessThan(300);
      return (res.body as { accessToken: string }).accessToken;
    };
    const adminC = await switchTo(admin);
    // Token platform của admin đã bị thu hồi sau lần chuyển phiên —
    // đăng nhập lại cho các thao tác phía platform.
    admin = (await login(app, ADMIN.username, ADMIN.password)).accessToken;
    const mgrLogin = await login(app, centerMgr.username, STRONG_PASSWORD);
    const mgrC = await switchTo(mgrLogin.accessToken);
    const buyerLogin = await login(app, buyerUser.username, STRONG_PASSWORD);
    const buyerC = await switchTo(buyerLogin.accessToken);

    // --- Nội dung + tài khoản nhận tiền CỦA trung tâm ------------------
    const centerAccountId = await createSepayAccount(adminC, CENTER_XID, CENTER_KEY, CENTER_BANK);
    const { course, instance } = await createFeeCourse(adminC, centerAccountId);

    const centerIpn = (paymentCode: string, amount: number) => postIpn(ipnBody({
      bank_account_xid: CENTER_XID, account_number: CENTER_BANK,
      content: `TT ${paymentCode}`, amount,
    }), CENTER_KEY);

    // Khoản chờ 1: tiền về sai số tiền → needs_review của trung tâm.
    const p1 = await createFeePayment(buyerC, instance.id);
    expect(p1.tenantId).toBe(tenantId);
    await centerIpn(p1.paymentCode, 99000);
    await waitPaymentStatus(p1.id, 'needs_review');
    expect(await enrolmentActive(course.id, buyerC)).toBe(false);

    // Tách bạch hiển thị: manager platform (không thuộc trung tâm)
    // không thấy khoản chờ của trung tâm; quản lý trung tâm thấy đúng
    // khoản đó kèm điều kiện lệch số tiền.
    const platformMgr = await secondManager();
    const platformQueue = await http(app).get('/api/v1/payments/review-queue').set('Authorization', `Bearer ${platformMgr.token}`);
    expect(platformQueue.status).toBe(200);
    expect((platformQueue.body as Record<string, unknown>[]).some((i) => (i.payment as Record<string, unknown> | null)?.id === p1.id)).toBe(false);
    const centerQueue = await http(app).get('/api/v1/payments/review-queue').set('Authorization', `Bearer ${mgrC}`);
    expect(centerQueue.status).toBe(200);
    const item1 = (centerQueue.body as Record<string, unknown>[]).find((i) => (i.payment as Record<string, unknown> | null)?.id === p1.id);
    expect(item1).toBeTruthy();
    expect(item1!.tenantId).toBe(tenantId);
    expect(item1!.mismatches).toContain('amount_mismatch');

    // Trung tâm tự khớp tay về succeeded: quyền lợi kích hoạt, vết xử
    // lý ghi người xử lý của trung tâm + quyết định + lý do.
    const resolved = await http(app).post(`/api/v1/payments/${p1.id}/review`).set('Authorization', `Bearer ${mgrC}`)
      .send({ decision: 'matched', reason: 'Đã đối chiếu sao kê ngân hàng của trung tâm' });
    expect(resolved.status).toBeLessThan(300);
    expect(resolved.body.status).toBe('succeeded');
    expect(resolved.body.reviewDecision).toBe('matched');
    expect(resolved.body.reviewHandledBy).toBe(centerMgr.id);
    expect(resolved.body.reviewReason).toBe('Đã đối chiếu sao kê ngân hàng của trung tâm');
    expect(await enrolmentActive(course.id, buyerC)).toBe(true);

    // Khoản chờ 2: trung tâm bác bỏ → failed, kèm vết.
    const p2 = await createFeePayment(buyerC, instance.id);
    await centerIpn(p2.paymentCode, 99000);
    await waitPaymentStatus(p2.id, 'needs_review');
    const rejectedRes = await http(app).post(`/api/v1/payments/${p2.id}/review`).set('Authorization', `Bearer ${mgrC}`)
      .send({ decision: 'rejected', reason: 'Sao kê không có khoản tiền này' });
    expect(rejectedRes.status).toBeLessThan(300);
    expect(rejectedRes.body.status).toBe('failed');
    expect(rejectedRes.body.reviewDecision).toBe('rejected');
    expect(rejectedRes.body.reviewHandledBy).toBe(centerMgr.id);

    // Trung tâm TỰ hoàn học phí bằng cổng neo tại tenant của mình
    // (sửa nền của lát này): tạo + xác nhận chi trọn vòng một cấp.
    const p3 = await createFeePayment(buyerC, instance.id);
    await centerIpn(p3.paymentCode, 100000);
    await waitPaymentStatus(p3.id, 'succeeded');
    const ownRefund = await createRefund(mgrC, p3.id, { amount: 30000, reason: 'Trung tâm hoàn học phí', externalTransactionId: `FT-CTR-${Date.now()}` });
    expect(ownRefund.status).toBeLessThan(300);
    expect(ownRefund.body.status).toBe('approved');
    const ownSettled = await settleRefund(mgrC, p3.id, ownRefund.body.id);
    expect(ownSettled.status).toBeLessThan(300);
    expect(ownSettled.body.status).toBe('settled');

    // Không chạm chéo: manager platform hoàn học phí của trung tâm →
    // 403; quản lý trung tâm hoàn khoản thu platform → 403.
    const cross1 = await createRefund(platformMgr.token, p3.id, { amount: 1000, reason: 'platform chạm học phí' });
    expect(cross1.status).toBe(403);
    const platformPayment = await manualSucceededPayment();
    const cross2 = await createRefund(mgrC, platformPayment.payment.id, { amount: 1000, reason: 'trung tâm chạm tiền platform' });
    expect(cross2.status).toBe(403);
  });

  it('9. quá hạn hàng đợi: reviewtargethours = 0 → khoản chờ bị đánh dấu overdue, chỉ cảnh báo chứ không tự xử lý', async () => {
    const { instance } = await createFeeCourse(admin, sepayAccountId);
    const buyer = await createUserViaApi(app, admin);
    const buyerToken = (await login(app, buyer.username, STRONG_PASSWORD)).accessToken;
    const payment = await createFeePayment(buyerToken, instance.id);
    await postIpn(ipnBody({ amount: 99000, content: `TT ${payment.paymentCode}` }));
    await waitPaymentStatus(payment.id, 'needs_review');

    const queueBefore = await http(app).get('/api/v1/payments/review-queue').set('Authorization', `Bearer ${admin}`);
    const before = (queueBefore.body as Record<string, unknown>[]).find((i) => (i.payment as Record<string, unknown> | null)?.id === payment.id);
    expect(before).toBeTruthy();
    expect(before!.overdue).toBe(false);

    const set = await http(app).put('/api/v1/site-config/payments/reviewtargethours')
      .set('Authorization', `Bearer ${admin}`).send({ value: 0 });
    expect(set.status).toBeLessThan(300);
    try {
      const queue = await http(app).get('/api/v1/payments/review-queue').set('Authorization', `Bearer ${admin}`);
      const item = (queue.body as Record<string, unknown>[]).find((i) => (i.payment as Record<string, unknown> | null)?.id === payment.id);
      expect(item).toBeTruthy();
      expect(item!.overdue).toBe(true);
      // Chỉ cảnh báo: khoản thu vẫn nguyên trạng needs_review.
      expect((await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`)).body.status).toBe('needs_review');
    } finally {
      const clear = await http(app).delete('/api/v1/site-config/payments/reviewtargethours')
        .set('Authorization', `Bearer ${admin}`);
      expect(clear.status).toBeLessThan(300);
    }
  });

  it('10. hồi quy: hai dòng hoàn bù nhau (60.000 + 40.000) xác nhận chi ĐỒNG THỜI → lượt làm đủ 100% đình chỉ thật, kết cục nhất quán', async () => {
    // Hai vòng độc lập (mỗi vòng một khoản thu mới) để cửa sổ đua
    // phải lộ diện rõ: trên code quyết định đình chỉ bằng lượt đọc
    // NGOÀI khoá, cả hai lượt đều thấy tổng settled = 0 nên không
    // lượt nào đình chỉ, nhưng transaction vào sau vẫn lật refunded.
    for (let round = 1; round <= 2; round++) {
      const { course, buyerToken, payment } = await manualSucceededPayment();
      const mgr2 = await secondManager();

      // Đợt 1: 60.000 — một phần dưới ngưỡng → một cấp, approved ngay.
      const r60 = await createRefund(admin, payment.id, {
        amount: 60000, reason: `Hoàn đợt 1 (vòng ${round})`,
        externalTransactionId: `FT-S3-RACE-${round}-A-${Date.now()}`,
      });
      expect(r60.status).toBeLessThan(300);
      expect(r60.body.status).toBe('approved');
      expect(r60.body.approvalLevel).toBe(1);

      // Đợt 2: 40.000 bù đủ 100% → hai cấp (requested), duyệt bởi
      // người khác người tạo → approved. Cả hai dòng cùng chờ ở
      // approved, chưa dòng nào settled, ghi danh còn active.
      const r40 = await createRefund(admin, payment.id, { amount: 40000, reason: `Hoàn đợt 2 bù đủ 100% (vòng ${round})` });
      expect(r40.status).toBeLessThan(300);
      expect(r40.body.status).toBe('requested');
      expect(r40.body.approvalLevel).toBe(2);
      const approved40 = await approveRefund(mgr2.token, payment.id, r40.body.id);
      expect(approved40.status).toBeLessThan(300);
      expect(approved40.body.status).toBe('approved');
      expect(await enrolmentActive(course.id, buyerToken)).toBe(true);

      // Xác nhận chi ĐỒNG THỜI cả hai dòng (Promise.all): bất kể
      // thứ tự xen kẽ, kết cục cuối phải là MỘT trạng thái nhất
      // quán — cả hai settled; đúng dòng làm cộng dồn đạt 100% ghi
      // nhận đảo quyền lợi; khoản thu refunded VÀ ghi danh THẬT SỰ
      // bị đình chỉ (không được refunded trong khi ghi danh còn
      // active — đó là trạng thái tiền đã ghi hoàn mà quyền lợi
      // vẫn chạy).
      const [s60, s40] = await Promise.all([
        settleRefund(admin, payment.id, r60.body.id),
        settleRefund(admin, payment.id, r40.body.id, { externalTransactionId: `FT-S3-RACE-${round}-B-${Date.now()}` }),
      ]);
      expect(s60.status).toBeLessThan(300);
      expect(s60.body.status).toBe('settled');
      expect(s40.status).toBeLessThan(300);
      expect(s40.body.status).toBe('settled');

      const refunds = await listRefunds(payment.id);
      expect(refunds).toHaveLength(2);
      expect(refunds.every((r) => r.status === 'settled')).toBe(true);
      expect(refunds.filter((r) => r.entitlementReversed === true)).toHaveLength(1);
      expect(refunds.filter((r) => r.entitlementReversed === false)).toHaveLength(1);
      expect((await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`)).body.status).toBe('refunded');
      expect(await enrolmentActive(course.id, buyerToken)).toBe(false);
    }
  });

  it('11. đua duyệt trên cùng một dòng hoàn: đúng một lượt thắng, lượt thua nhận payment.refund_not_pending_approval và không ghi đè người thắng', async () => {
    const { payment } = await manualSucceededPayment();
    const mgrA = await secondManager();
    const mgrB = await secondManager();
    // Hoàn 100% → cộng dồn đạt 100% → hai cấp, dòng chờ ở requested;
    // người tạo là admin nên cả hai quản lý đều đủ tư cách duyệt.
    const created = await createRefund(admin, payment.id, { amount: 100000, reason: 'Hoàn toàn bộ — đua duyệt' });
    expect(created.status).toBeLessThan(300);
    expect(created.body.status).toBe('requested');

    const [a, b] = await Promise.all([
      approveRefund(mgrA.token, payment.id, created.body.id),
      approveRefund(mgrB.token, payment.id, created.body.id),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.status < 300)).toHaveLength(1);
    const loser = results.find((r) => r.status === 400)!;
    expect(JSON.stringify(loser.body)).toContain('payment.refund_not_pending_approval');

    const refunds = await listRefunds(payment.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe('approved');
    // Người duyệt ghi trên dòng là đúng người thắng — lượt thua không
    // ghi đè lặng lẽ như dạng đua đọc-rồi-cập-nhật vô điều kiện.
    expect(refunds[0]!.approvedBy).toBe(a.status < 300 ? mgrA.id : mgrB.id);
  });

  // Ca 12 (đối soát reconcile: gọi thẳng PaymentsService.reconcile và
  // đối chiếu với phép đếm SQL độc lập — bề mặt nội bộ, không có route
  // HTTP) nằm ở tầng integration:
  // test/integration/payments/payments-reconcile.int-spec.ts (issue #483).

  it('13. hàng đợi needs_review: nhiều dòng cùng một tenant chỉ tra cấu hình ngưỡng quá hạn một lần trong một lần dựng hàng đợi', async () => {
    const tenantConfig = app.get(TenantConfigService);
    // Hai debit lạ mới → hai dòng needs_review nữa của tenant chủ tài
    // khoản SePay (tenant nền tảng) trong cùng hàng đợi.
    await postIpn(ipnBody());
    await postIpn(ipnBody());

    const config = tenantConfig as unknown as {
      getEffectiveValue: (tenantId: string, component: string, name: string) => Promise<unknown>;
    };
    const original = config.getEffectiveValue.bind(tenantConfig);
    const seenTenants: string[] = [];
    config.getEffectiveValue = async (tenantId: string, component: string, name: string) => {
      if (component === 'payments' && name === 'reviewtargethours') seenTenants.push(tenantId);
      return original(tenantId, component, name);
    };
    try {
      // Hàng đợi đọc qua HTTP GET /payments/review-queue (endpoint trả
      // đúng mảng mà listReviewQueue dựng cho người gọi); việc đếm
      // lượt tra cấu hình ở trên vẫn quan sát được vì request chạy
      // trong cùng một instance ứng dụng.
      const queueRes = await http(app).get('/api/v1/payments/review-queue').set('Authorization', `Bearer ${admin}`);
      expect(queueRes.status).toBe(200);
      expect((queueRes.body as unknown[]).length).toBeGreaterThanOrEqual(2);
    } finally {
      config.getEffectiveValue = original;
    }
    // Có tra cấu hình cho ít nhất một tenant, và không tenant nào bị
    // tra hai lần trong cùng một lần dựng hàng đợi.
    expect(seenTenants.length).toBeGreaterThanOrEqual(1);
    expect(new Set(seenTenants).size).toBe(seenTenants.length);
  });
});
