import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentsService } from '../../../src/modules/payments/payments.service';
import {
  ADMIN, STRONG_PASSWORD, createTestApp, createUserViaApi, http, login,
} from '../../support/identity-access-helpers';
import {
  createCategory, createCourse, createEnrolInstance,
} from '../../support/course-enrolment-helpers';

const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? '';

/**
 * Đối soát `reconcile` của Payments — ca tách nguyên văn từ
 * `test/e2e/payments/payments-refund-lifecycle.e2e-spec.ts`
 * (issue #483).
 *
 * Vì sao ca này thuộc tầng integration: act của ca gọi thẳng
 * `PaymentsService.reconcile()` và assert đối chiếu kết quả với một
 * phép đếm SQL độc lập chạy trên cùng dữ kiện — cả hai phía đều là
 * bề mặt nội bộ, không có route HTTP nào phơi bày số liệu đối soát
 * này. Các ca còn lại của file gốc (vòng đời hoàn tiền, hàng đợi
 * needs_review) vẫn ở tầng e2e; riêng khẳng định hàng đợi trong file
 * gốc đã được chuyển sang gọi HTTP `GET /payments/review-queue`.
 *
 * Fixture khoản thu succeeded dựng bằng đúng chuỗi helper của file
 * gốc (tài khoản manual → khoá có phí → khoản thu → webhook
 * succeeded) chạy qua HTTP như bước chuẩn bị; ca giữ nguyên số thứ
 * tự "12." trong tiêu đề để đối chiếu 1-1 với file gốc.
 */
describe('Payments: đối soát reconcile giữa service và SQL (integration)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

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

  async function enrolmentActive(courseId: string, token: string): Promise<boolean> {
    const res = await http(app).get(`/api/v1/courses/${courseId}/enrolments/me`).set('Authorization', `Bearer ${token}`);
    return res.body.active === true;
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

  beforeAll(async () => {
    app = await createTestApp();
    const adminLogin = await login(app, ADMIN.username, ADMIN.password);
    admin = adminLogin.accessToken;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('12. đối soát reconcile: ba con số đếm ở SQL khớp phép đếm độc lập trên cùng dữ kiện và dịch đúng khi có khoản thu mới', async () => {
    const payments = app.get(PaymentsService);
    const countViaSql = async () => {
      const res = await pg.query(
        `select count(*)::int as total,
                count(*) filter (where status = 'succeeded')::int as succeeded,
                count(*) filter (where status = 'pending' and (external_transaction_id is null or external_transaction_id = ''))::int as pending_without
           from payments`,
      );
      const row = res.rows[0] as { total: number; succeeded: number; pending_without: number };
      return { total: row.total, succeeded: row.succeeded, pendingWithoutExternalTx: row.pending_without };
    };

    expect(await payments.reconcile()).toEqual(await countViaSql());

    // Thêm một khoản thu succeeded mới bằng fixture chuẩn của spec:
    // cả hai nguồn đếm phải dịch đúng — tổng +1, succeeded +1, khoản
    // pending chưa có mã ngoài không đổi.
    const before = await countViaSql();
    await manualSucceededPayment();
    const after = await payments.reconcile();
    expect(after).toEqual(await countViaSql());
    expect(after.total).toBe(before.total + 1);
    expect(after.succeeded).toBe(before.succeeded + 1);
    expect(after.pendingWithoutExternalTx).toBe(before.pendingWithoutExternalTx);
  });
});
