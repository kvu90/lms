import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Đặc tả đường quét matching IPN SePay ở worker QUA NHỊP THẬT của
 * module (issue con #539 của #522): boot `WorkerModule` bằng
 * harness role thường (đúng hình dạng kết nối production — scheduler
 * chạy bằng role không BYPASSRLS, ngữ cảnh platform tường minh),
 * gieo payment + sự kiện provider bằng SQL, rồi chờ nhịp 1 giây của
 * `SepayMatchingScheduler` quét và khớp. Không gọi tay tick, không
 * dựng service bằng tay: nhịp, bề mặt matching dùng chung và ba
 * adapter cổng đều là code production thật.
 *
 * Các ca ghim đúng hợp đồng nhịp quét + adapter mới:
 *
 * 1. Khớp đủ 3 điều kiện + đối chiếu đích → succeeded, ghi danh
 *    ACTIVE đúng một lần, outbox `payment_succeeded` đúng một dòng;
 *    các nhịp sau không nhân đôi (phát lại ở tầng nhịp).
 * 2. Sai số tiền → payment + sự kiện vào `needs_review`, không kích
 *    hoạt, không ghi danh.
 * 3. Sự kiện `processing` treo quá 60 giây được nhịp sau nhận lại
 *    và khớp (cửa sổ stale của claim).
 * 4. Sự kiện `debit` khớp dòng hoàn `approved` đủ 100% → refund
 *    settled, payment refunded, ghi danh SUSPENDED; phát lại cùng
 *    sự kiện debit (đưa dòng sự kiện về `received` như một lần
 *    redelivery của provider) không settle hai lần — nhận diện qua
 *    `settled_event_id` đã ghi. Ghi chú phân kỳ: người tạo yêu cầu
 *    hoàn trong ca này là người mua, không giữ capability
 *    `enrol:manage` — đường API sẽ chặn ở cổng capability của
 *    `setSuspended` và đẩy sự kiện về `needs_review`, còn adapter
 *    worker (tiến trình hệ thống tin cậy thực thi quyết định đã
 *    chốt) settle thẳng như đã ghi trong TSDoc của service và thân
 *    PR; ca này ghim hành vi worker đó, không ghim hành vi API.
 */
describe('Điểm quét matching IPN SePay ở worker — nhịp thật của module', () => {
  let harness: OrdinaryWorkerModuleHarness;
  let pg: Client;
  let tenantId = '';
  let tenantCtxId = '';
  let systemCtxId = '';
  let categoryId = '';
  let studentRoleId = '';
  let accountId = '';
  const tag = randomUUID().slice(0, 8);

  const uid = () => randomUUID();

  async function insertUser(): Promise<string> {
    const id = uid();
    const short = id.replaceAll('-', '').slice(0, 12);
    await pg.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [id, `w539_${short}`, `w539_${short}@example.test`]);
    return id;
  }

  /** Đồ thị khoá + instance thu phí cho một ca: khoá mới, context khoá mới, instance `fee` giá 100.000. */
  async function makeFeeCourse(): Promise<{ courseId: string; courseCtxId: string; instanceId: string }> {
    const courseId = uid();
    const courseCtxId = uid();
    const instanceId = uid();
    await pg.query(
      'INSERT INTO course (id, tenant_id, category, full_name, short_name, is_template) VALUES ($1, $2, $3, $4, $5, true)',
      [courseId, tenantId, categoryId, 'Khoá đặc tả hoá worker 539', `W539-${courseId.slice(0, 8)}`],
    );
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 50, $2, $3, 3)', [
      courseCtxId, courseId, `/${systemCtxId}/${tenantCtxId}/${courseCtxId}`,
    ]);
    await pg.query(
      `INSERT INTO enrol (id, course_id, enrol, status, role_id, cost, currency)
       VALUES ($1, $2, 'fee', 0, $3, 100000, 'VND')`,
      [instanceId, courseId, studentRoleId],
    );
    return { courseId, courseCtxId, instanceId };
  }

  async function makePayment(buyerId: string, instanceId: string, code: string): Promise<string> {
    const paymentId = uid();
    await pg.query(
      `INSERT INTO payments (id, account_id, tenant_id, user_id, amount, currency, status, gateway, component, item_id, payment_code)
       VALUES ($1, $2, $3, $4, 100000, 'VND', 'pending', 'sepay', 'enrol_fee', $5, $6)`,
      [paymentId, accountId, tenantId, buyerId, instanceId, code],
    );
    return paymentId;
  }

  async function makeEvent(overrides: {
    direction: 'credit' | 'debit'; amount: number; code: string | null; txId: string; referenceCode: string;
    status?: string; receivedAt?: Date;
  }): Promise<string> {
    const eventId = uid();
    await pg.query(
      `INSERT INTO payment_provider_events
         (id, provider, tenant_id, account_id, external_transaction_id, direction, amount, content, extracted_code, match_status, raw, received_at)
       VALUES ($1, 'sepay', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        eventId, tenantId, accountId, overrides.txId, overrides.direction, overrides.amount,
        'hoc phi khoa hoc', overrides.code, overrides.status ?? 'received',
        JSON.stringify({ reference_code: overrides.referenceCode }),
        overrides.receivedAt ?? new Date(),
      ],
    );
    return eventId;
  }

  async function paymentRow(paymentId: string): Promise<Record<string, unknown> | undefined> {
    const res = await pg.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  async function eventRow(eventId: string): Promise<Record<string, unknown> | undefined> {
    const res = await pg.query('SELECT * FROM payment_provider_events WHERE id = $1', [eventId]);
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  async function ueRow(instanceId: string, userId: string): Promise<Record<string, unknown> | undefined> {
    const res = await pg.query('SELECT * FROM user_enrolments WHERE enrol_id = $1 AND user_id = $2', [instanceId, userId]);
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  async function outboxCount(type: string, paymentId: string): Promise<number> {
    const res = await pg.query(
      "SELECT count(*)::int AS c FROM outbox_events WHERE type = $1 AND payload ->> 'paymentId' = $2",
      [type, paymentId],
    );
    return (res.rows[0] as { c: number }).c;
  }

  async function enrolOutboxCount(type: string, userId: string): Promise<number> {
    const res = await pg.query(
      "SELECT count(*)::int AS c FROM outbox_events WHERE type = $1 AND payload ->> 'userId' = $2",
      [type, userId],
    );
    return (res.rows[0] as { c: number }).c;
  }

  /** Chờ một điều kiện đúng, thăm dò mỗi 250 ms như các spec e2e payments. */
  async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 12000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`chờ quá hạn: ${label}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    harness = await bootWorkerModuleAsOrdinaryRole();
    tenantId = uid();
    tenantCtxId = uid();
    systemCtxId = uid();
    categoryId = uid();
    studentRoleId = uid();
    accountId = uid();
    await pg.query('INSERT INTO tenants (id, slug, name, kind) VALUES ($1, $2, $3, $4)', [
      tenantId, `trung-tam-w539-${tag}`, 'Trung tâm đặc tả hoá worker 539', 'school',
    ]);
    await pg.query('INSERT INTO course_categories (id, tenant_id, name) VALUES ($1, $2, $3)', [
      categoryId, tenantId, 'Danh mục worker 539',
    ]);
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 10, NULL, $2, 1)', [
      systemCtxId, `/${systemCtxId}`,
    ]);
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 20, $2, $3, 2)', [
      tenantCtxId, tenantId, `/${systemCtxId}/${tenantCtxId}`,
    ]);
    await pg.query("INSERT INTO role (id, name, short_name, archetype) VALUES ($1, 'Student', 'student539', 'student')", [studentRoleId]);
    await pg.query('INSERT INTO payment_accounts (id, tenant_id, name, gateway, enabled) VALUES ($1, $2, $3, $4, true)', [
      accountId, tenantId, 'SePay worker 539', 'sepay',
    ]);
  });

  afterAll(async () => {
    await harness.close();
    await pg.end();
  });

  it('IPN khớp đủ 3 điều kiện → succeeded + ghi danh ACTIVE đúng một lần; nhịp sau không nhân đôi', async () => {
    const buyer = await insertUser();
    const { instanceId } = await makeFeeCourse();
    const code = `LMS539${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const paymentId = await makePayment(buyer, instanceId, code);
    const txId = `sepay-tx-${randomUUID()}`;
    const eventId = await makeEvent({
      direction: 'credit', amount: 100000, code, txId, referenceCode: `FT${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    });

    await waitFor(async () => (await paymentRow(paymentId))?.status === 'succeeded', 'payment về succeeded');

    const ue = await ueRow(instanceId, buyer);
    expect(ue).toBeDefined();
    expect(ue?.status).toBe(0);
    expect(await outboxCount('payment_succeeded', paymentId)).toBe(1);
    expect(await enrolOutboxCount('user_enrolled', buyer)).toBe(1);
    const event = await eventRow(eventId);
    expect(event?.match_status).toBe('matched');
    expect(event?.matched_payment_id).toBe(paymentId);

    // Phát lại ở tầng nhịp: để thêm vài nhịp chạy qua rồi đếm lại — không nhân đôi.
    await new Promise((r) => setTimeout(r, 2500));
    expect(await outboxCount('payment_succeeded', paymentId)).toBe(1);
    expect(await enrolOutboxCount('user_enrolled', buyer)).toBe(1);
    expect((await ueRow(instanceId, buyer))?.status).toBe(0);
  });

  it('sai số tiền → payment và sự kiện vào needs_review, không kích hoạt, không ghi danh', async () => {
    const buyer = await insertUser();
    const { instanceId } = await makeFeeCourse();
    const code = `LMS539${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const paymentId = await makePayment(buyer, instanceId, code);
    const eventId = await makeEvent({
      direction: 'credit', amount: 99999, code, txId: `sepay-tx-${randomUUID()}`,
      referenceCode: `FT${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    });

    await waitFor(async () => (await eventRow(eventId))?.match_status === 'needs_review', 'sự kiện về needs_review');

    expect((await paymentRow(paymentId))?.status).toBe('needs_review');
    expect(await ueRow(instanceId, buyer)).toBeUndefined();
    expect(await outboxCount('payment_succeeded', paymentId)).toBe(0);
  });

  it('sự kiện processing treo quá 60 giây được nhịp sau nhận lại và khớp', async () => {
    const buyer = await insertUser();
    const { instanceId } = await makeFeeCourse();
    const code = `LMS539${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const paymentId = await makePayment(buyer, instanceId, code);
    const eventId = await makeEvent({
      direction: 'credit', amount: 100000, code, txId: `sepay-tx-${randomUUID()}`,
      referenceCode: `FT${randomUUID().replaceAll('-', '').slice(0, 10)}`,
      status: 'processing', receivedAt: new Date(Date.now() - 120_000),
    });

    await waitFor(async () => (await paymentRow(paymentId))?.status === 'succeeded', 'payment treo được khớp lại');

    expect((await eventRow(eventId))?.match_status).toBe('matched');
    expect((await ueRow(instanceId, buyer))?.status).toBe(0);
  });

  it('debit khớp dòng hoàn approved đủ 100% → settled + refunded + ghi danh SUSPENDED; phát lại debit không settle hai lần', async () => {
    const buyer = await insertUser();
    const { instanceId } = await makeFeeCourse();
    const code = `LMS539${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const paymentId = await makePayment(buyer, instanceId, code);
    // Payment đã succeeded và ghi danh đang ACTIVE — trạng thái trước khi hoàn tiền.
    await pg.query("UPDATE payments SET status = 'succeeded' WHERE id = $1", [paymentId]);
    await pg.query(
      "INSERT INTO user_enrolments (id, enrol_id, user_id, status, time_start) VALUES ($1, $2, $3, 0, now())",
      [uid(), instanceId, buyer],
    );
    const refundId = uid();
    const payoutCode = `PAYOUT-${randomUUID()}`;
    await pg.query(
      `INSERT INTO payment_refunds (id, payment_id, amount, currency, status, external_transaction_id, created_by)
       VALUES ($1, $2, 100000, 'VND', 'approved', $3, $4)`,
      [refundId, paymentId, payoutCode, buyer],
    );
    const eventId = await makeEvent({
      direction: 'debit', amount: 100000, code: null, txId: payoutCode, referenceCode: payoutCode,
    });

    await waitFor(async () => {
      const refund = await pg.query('SELECT status FROM payment_refunds WHERE id = $1', [refundId]);
      return (refund.rows[0] as { status: string } | undefined)?.status === 'settled';
    }, 'dòng hoàn về settled');

    expect((await paymentRow(paymentId))?.status).toBe('refunded');
    expect((await ueRow(instanceId, buyer))?.status).toBe(1);
    expect((await eventRow(eventId))?.match_status).toBe('matched');
    expect(await enrolOutboxCount('user_enrolment_suspended', buyer)).toBe(1);
    const settledAtMs = new Date(
      (await pg.query('SELECT settled_at FROM payment_refunds WHERE id = $1', [refundId])).rows[0].settled_at as string,
    ).getTime();

    // Phát lại cùng sự kiện debit: đưa dòng sự kiện về received như một
    // lần redelivery của provider — nhịp sau nhận diện qua settled_event_id
    // và chỉ đánh dấu matched lại, không settle lần hai.
    await pg.query("UPDATE payment_provider_events SET match_status = 'received', matched_payment_id = NULL WHERE id = $1", [eventId]);
    await waitFor(async () => (await eventRow(eventId))?.match_status === 'matched', 'sự kiện phát lại về matched');
    const refundAfter = await pg.query('SELECT status, settled_at FROM payment_refunds WHERE id = $1', [refundId]);
    expect(refundAfter.rows[0].status).toBe('settled');
    expect(new Date(refundAfter.rows[0].settled_at as string).getTime()).toBe(settledAtMs);
    expect((await paymentRow(paymentId))?.status).toBe('refunded');
    expect(await enrolOutboxCount('user_enrolment_suspended', buyer)).toBe(1);
  });
});
