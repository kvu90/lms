import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance } from '../../support/course-enrolment-helpers';

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

describe('Xác minh webhook thanh toán (H1): webhook giả không thể đổi trạng thái thanh toán hay kích hoạt ghi danh phí', () => {
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

  it('từ chối webhook succeeded giả KHÔNG có header secret: 401, thanh toán vẫn pending, ghi danh không kích hoạt', async () => {
    const { course, buyerToken, paymentId } = await feePayment();
    const res = await webhook({ gateway: 'manual', externalTransactionId: `forge-${Date.now()}`, paymentId, status: 'succeeded' });
    expect(res.status).toBe(401);
    expect(await paymentStatus(paymentId)).toBe('pending');
    expect(await enrolActive(course.id, buyerToken)).toBe(false);
  });

  it('từ chối webhook có secret SAI: 401, thanh toán vẫn pending, ghi danh không kích hoạt', async () => {
    const { course, buyerToken, paymentId } = await feePayment();
    const res = await webhook({ gateway: 'manual', externalTransactionId: `wrong-${Date.now()}`, paymentId, status: 'succeeded' }, 'wrong-secret-wrong-secret-wrong-secret');
    expect(res.status).toBe(401);
    expect(await paymentStatus(paymentId)).toBe('pending');
    expect(await enrolActive(course.id, buyerToken)).toBe(false);
  });

  it('từ chối gateway LẠ ngay cả với header secret đúng: 400, thanh toán không đổi', async () => {
    const { course, buyerToken, paymentId } = await feePayment();
    const res = await webhook({ gateway: 'stripe', externalTransactionId: `unk-${Date.now()}`, paymentId, status: 'succeeded' }, SECRET);
    expect(res.status).toBe(400);
    expect(await paymentStatus(paymentId)).toBe('pending');
    expect(await enrolActive(course.id, buyerToken)).toBe(false);
  });

  it('từ chối webhook FAILED giả không có secret: 401 và thanh toán vẫn pending (verify đứng trước MỌI xử lý trạng thái)', async () => {
    const { paymentId } = await feePayment();
    const res = await webhook({ gateway: 'manual', externalTransactionId: `failforge-${Date.now()}`, paymentId, status: 'failed' });
    expect(res.status).toBe(401);
    expect(await paymentStatus(paymentId)).toBe('pending');
  });

  it('chấp nhận webhook ký đúng: thanh toán thành công, ghi danh kích hoạt, replay đã ký vẫn luỹ đẳng', async () => {
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

  it('webhook FAILED ký đúng vẫn đánh dấu thanh toán thất bại (đường gateway hợp lệ không đổi)', async () => {
    const { paymentId } = await feePayment();
    const res = await webhook({ gateway: 'manual', externalTransactionId: `fail-ok-${Date.now()}`, paymentId, status: 'failed' }, SECRET);
    expect(res.status).toBeLessThan(300);
    expect(res.body.status).toBe('failed');
    expect(await paymentStatus(paymentId)).toBe('failed');
  });
});
