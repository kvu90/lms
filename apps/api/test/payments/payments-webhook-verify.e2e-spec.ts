import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance } from '../support/course-enrolment-helpers';

/**
 * Hồi quy H1 (issue #134): POST /payments/webhook là route @Public — trước
 * bản vá, handleWebhook KHÔNG gọi gateway.verify nên bất kỳ ai cũng giả
 * được `status: 'succeeded'` để kích hoạt ghi danh có phí mà không trả
 * tiền. Spec này khoá hành vi đã vá: verify chạy TRƯỚC mọi xử lý —
 * webhook giả/không chữ ký bị từ chối và payment giữ nguyên trạng thái,
 * không phát enrol; webhook có secret đúng mới xử lý thành công.
 * Secret test lấy từ env của vitest (PAYMENT_WEBHOOK_SECRET).
 */
const SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
const SECRET_HEADER = 'x-payment-webhook-secret';

describe('Payments webhook verification (H1): forged webhooks cannot move payment state or activate fee enrolment', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  async function feePayment() {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const account = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`).send({ name: `Acct ${Date.now()}-${Math.random()}`, gateway: 'manual' });
    expect(account.status).toBeLessThan(300);
    const feeInstance = await createEnrolInstance(app, admin, course.id, {
      method: 'fee', cost: 50000, currency: 'VND', paymentAccountId: account.body.id,
    });
    const buyer = await createUserViaApi(app, admin);
    const buyerToken = (await login(app, buyer.username, STRONG_PASSWORD)).accessToken;
    const payment = await http(app).post(`/api/v1/payments/fee/${feeInstance.id}`).set('Authorization', `Bearer ${buyerToken}`).send({});
    expect(payment.status).toBeLessThan(300);
    expect(payment.body.status).toBe('pending');
    return { course, buyer, buyerToken, paymentId: (payment.body as { id: string }).id };
  }

  async function paymentStatus(paymentId: string): Promise<string> {
    const res = await http(app).get(`/api/v1/payments/${paymentId}`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBeLessThan(300);
    return (res.body as { status: string }).status;
  }

  async function enrolActive(courseId: string, token: string): Promise<boolean> {
    const res = await http(app).get(`/api/v1/courses/${courseId}/enrolments/me`).set('Authorization', `Bearer ${token}`);
    return (res.body as { active?: boolean }).active === true;
  }

  function webhook(body: { gateway: string; externalTransactionId: string; paymentId: string; status: string }, secret?: string) {
    const req = http(app).post('/api/v1/payments/webhook');
    if (secret !== undefined) req.set(SECRET_HEADER, secret);
    return req.send(body);
  }

  it('rejects a forged succeeded webhook WITHOUT the secret header: 401, payment stays pending, enrolment not activated', async () => {
    const { course, buyerToken, paymentId } = await feePayment();
    const res = await webhook({ gateway: 'manual', externalTransactionId: `forge-${Date.now()}`, paymentId, status: 'succeeded' });
    expect(res.status).toBe(401);
    expect(await paymentStatus(paymentId)).toBe('pending');
    expect(await enrolActive(course.id, buyerToken)).toBe(false);
  });

  it('rejects a webhook with a WRONG secret: 401, payment stays pending, enrolment not activated', async () => {
    const { course, buyerToken, paymentId } = await feePayment();
    const res = await webhook({ gateway: 'manual', externalTransactionId: `wrong-${Date.now()}`, paymentId, status: 'succeeded' }, 'wrong-secret-wrong-secret-wrong-secret');
    expect(res.status).toBe(401);
    expect(await paymentStatus(paymentId)).toBe('pending');
    expect(await enrolActive(course.id, buyerToken)).toBe(false);
  });

  it('rejects an UNKNOWN gateway even with the correct secret header: 400, payment unchanged', async () => {
    const { course, buyerToken, paymentId } = await feePayment();
    const res = await webhook({ gateway: 'stripe', externalTransactionId: `unk-${Date.now()}`, paymentId, status: 'succeeded' }, SECRET);
    expect(res.status).toBe(400);
    expect(await paymentStatus(paymentId)).toBe('pending');
    expect(await enrolActive(course.id, buyerToken)).toBe(false);
  });

  it('rejects a forged FAILED webhook without secret: 401 and the payment stays pending (verify precedes ALL status handling)', async () => {
    const { paymentId } = await feePayment();
    const res = await webhook({ gateway: 'manual', externalTransactionId: `failforge-${Date.now()}`, paymentId, status: 'failed' });
    expect(res.status).toBe(401);
    expect(await paymentStatus(paymentId)).toBe('pending');
  });

  it('accepts a correctly signed webhook: payment succeeds, enrolment activates, signed replay stays idempotent', async () => {
    const { course, buyerToken, paymentId } = await feePayment();
    const txId = `ok-${Date.now()}`;
    const res = await webhook({ gateway: 'manual', externalTransactionId: txId, paymentId, status: 'succeeded' }, SECRET);
    expect(res.status).toBeLessThan(300);
    expect(res.body.status).toBe('succeeded');
    expect(await paymentStatus(paymentId)).toBe('succeeded');
    expect(await enrolActive(course.id, buyerToken)).toBe(true);
    const replay = await webhook({ gateway: 'manual', externalTransactionId: txId, paymentId, status: 'succeeded' }, SECRET);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.duplicate).toBe(true);
  });

  it('a correctly signed FAILED webhook still marks the payment failed (legitimate gateway path unchanged)', async () => {
    const { paymentId } = await feePayment();
    const res = await webhook({ gateway: 'manual', externalTransactionId: `fail-ok-${Date.now()}`, paymentId, status: 'failed' }, SECRET);
    expect(res.status).toBeLessThan(300);
    expect(res.body.status).toBe('failed');
    expect(await paymentStatus(paymentId)).toBe('failed');
  });
});
