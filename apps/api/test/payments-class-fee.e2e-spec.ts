import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse } from './course-enrolment-helpers';
import { createGradeItem, setGrade } from './assessment-helpers';

/**
 * CLASS-3 — HỌC PHÍ THEO LỚP (issue #184, lát cuối của feat lớp học
 * hạng nhất). Bộ ca bám LUẬT NGHIỆP VỤ trên đúng pipeline VietQR/SePay
 * sẵn có (component `class_fee`, item_id = classes.id):
 *  1. Cấu hình học phí qua PATCH lớp (capability `class:update` tại
 *     context lớp) + gói công khai cho người chưa ghi danh.
 *  2. IPN SePay khớp đủ 3 điều kiện → payment succeeded → người mua
 *     vào roster và ACTIVE ở MỌI khoá của lớp; kích hoạt lặp không
 *     trùng ghi danh.
 *  3. Khớp thiếu số tiền / sai tài khoản nhận → needs_review, KHÔNG
 *     vào lớp.
 *  4. Tài khoản chỉ định trên lớp thuộc tenant khác → chặn tạo payment.
 *  5. Webhook manual succeeded → vào lớp; hoàn một phần giữ quyền lợi;
 *     hoàn đủ → đình chỉ mọi khoá, GIỮ điểm, vào lại là nối tiếp dữ
 *     liệu cũ.
 * Đổi luật (kích hoạt khi chưa khớp, xoá điểm khi đình chỉ…) thì ca
 * tương ứng phải đỏ.
 */
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
const SEPAY_KEY = 'sk-test-classfee-7a11c2';
const SEPAY_XID = 'xid-classfee-org-001';
const BANK_ACCOUNT = '113366669999';
const FEE = 150000;

interface Person { id: string; username: string; token: string }

describe('CLASS-3: học phí theo lớp qua pipeline class_fee (issue #184)', () => {
  let app: INestApplication;
  let pg: Client;
  let admin: string;
  let teacher: Person;
  let sepayAccountId: string;
  let manualAccountId: string;
  let classA: string;
  let courseA1: string;
  let courseA2: string;
  let classB: string;
  let courseB1: string;
  let classNoFee: string;

  async function person(): Promise<Person> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  async function createClass(name: string): Promise<string> {
    const res = await http(app).post('/api/v1/classes')
      .set('Authorization', `Bearer ${admin}`).send({ name, ownerId: teacher.id });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  async function setFee(classId: string, patch: Record<string, unknown>, token = teacher.token) {
    return http(app).patch(`/api/v1/classes/${classId}`)
      .set('Authorization', `Bearer ${token}`).send(patch);
  }

  async function publicView(classId: string, token: string) {
    const res = await http(app).get(`/api/v1/classes/${classId}/public`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as {
      feeEnabled: boolean; canPurchase: boolean; isMember: boolean; feeCost: number | null;
      cohortId?: unknown; joinCode?: unknown; feePaymentAccountId?: unknown;
    };
  }

  async function createClassFeePayment(token: string, classId: string) {
    return http(app).post(`/api/v1/payments/class-fee/${classId}`).set('Authorization', `Bearer ${token}`).send({});
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
    const res = await http(app).get(`/api/v1/classes/${classId}/roster`).set('Authorization', `Bearer ${teacher.token}`);
    expect(res.status).toBe(200);
    return (res.body as { userId: string }[]).map((m) => m.userId);
  }

  /**
   * Chờ hệ quả ghi danh của một payment gói lớp được vật chất hoá tới
   * trạng thái khẳng định được (issue #219). Trạng thái payment lật
   * 'succeeded' chỉ chốt ở tầng payment: khâu kích hoạt cộng người
   * mua vào backing cohort chạy trước khi lật trạng thái, nhưng việc
   * vật chất hoá ghi danh ACTIVE xuống từng khoá của lớp là hệ quả của
   * cohort sync bất đồng bộ phía sau. Khẳng định roster + ACTIVE mọi
   * khoá phải chờ theo điều kiện trên chính hệ quả đó (người mua có
   * trong roster VÀ ghi danh ACTIVE ở mọi khoá), theo cùng mẫu chờ
   * của waitPaymentStatus — khẳng định ngay sau tín hiệu trạng thái
   * từng đỏ ngẫu nhiên ở khoá thứ hai.
   */
  async function waitForClassEnrolmentActive(classId: string, userId: string, token: string, courseIds: string[], timeoutMs = 12000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let settled = (await rosterIds(classId)).includes(userId);
      for (const courseId of courseIds) {
        if (!settled) break;
        settled = await enrolmentActive(courseId, token);
      }
      if (settled) return;
      if (Date.now() > deadline) throw new Error(`class enrolment for user ${userId} in class ${classId} was not fully active within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Chờ chuỗi đối soát của một payment SePay chốt xong (issue #219):
   * sự kiện nhà cung cấp của payment đã sang trạng thái 'matched' —
   * matching chỉ chốt 'matched' ở cuối nhịp xử lý của nó, sau khi đã
   * kích hoạt quyền lợi, lật trạng thái payment và ghi sự kiện outbox
   * `payment_succeeded` — đồng thời sự kiện outbox đó đã tồn tại. Sau
   * mốc này không còn khâu bất đồng bộ nào trong chuỗi payment có thể
   * đổi các đếm thành viên cohort / sự kiện outbox được khẳng định,
   * nên việc đếm sau replay IPN chờ tín hiệu này thay cho sleep cố
   * định.
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

  function ipnBody(paymentCode: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      gateway: 'MBBANK',
      transaction_date: '2026-10-26 17:00:00',
      account_number: BANK_ACCOUNT,
      bank_account_xid: SEPAY_XID,
      content: `TT hoc phi lop ${paymentCode}`,
      transfer_type: 'credit',
      amount: FEE,
      reference_code: `FT${Date.now()}${Math.floor(Math.random() * 1000)}`,
      transaction_id: `sepay-cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...overrides,
    };
  }

  async function postIpn(body: Record<string, unknown>, key = SEPAY_KEY) {
    return http(app).post('/api/v1/payments/ipn/sepay').set('Authorization', `Apikey ${key}`).send(body);
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    teacher = await person();
    const current = await http(app).get('/api/v1/tenants/current').set('Authorization', `Bearer ${admin}`);
    const tenantId = (current.body as { id: string }).id;
    await http(app).post(`/api/v1/tenants/${tenantId}/members`)
      .set('Authorization', `Bearer ${admin}`).send({ userId: teacher.id });

    const sepay = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({
        name: 'SePay CLASS-3', gateway: 'sepay',
        config: { bankCode: 'MBBANK', bankAccountNumber: BANK_ACCOUNT, sepayApiKey: SEPAY_KEY, sepayBankAccountXid: SEPAY_XID },
      });
    expect(sepay.status).toBeLessThan(300);
    sepayAccountId = sepay.body.id as string;

    const manual = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Manual CLASS-3', gateway: 'manual' });
    expect(manual.status).toBeLessThan(300);
    manualAccountId = manual.body.id as string;

    const cat = await createCategory(app, admin);
    classA = await createClass('Lớp học phí A');
    const cA1 = await createCourse(app, admin, cat.id, { classId: classA });
    const cA2 = await createCourse(app, admin, cat.id, { classId: classA });
    courseA1 = cA1.id;
    courseA2 = cA2.id;

    classB = await createClass('Lớp học phí B');
    const cB1 = await createCourse(app, admin, cat.id, { classId: classB });
    courseB1 = cB1.id;

    classNoFee = await createClass('Lớp không thu phí');
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('1. đặt học phí qua PATCH lớp (chủ lớp được, học sinh không có capability tại lớp thì 403); gói công khai không lộ dữ kiện nội bộ', async () => {
    const buyer = await person();
    const byStudent = await setFee(classA, { feeCost: FEE }, buyer.token);
    expect(byStudent.status).toBe(403);

    const byTeacher = await setFee(classA, { feeCost: FEE, feeCurrency: 'VND' });
    expect(byTeacher.status).toBe(200);
    expect((byTeacher.body as { feeCost: number }).feeCost).toBe(FEE);

    // Ghim tài khoản nhận SePay cho lớp A (cùng khuôn instance fee ghim
    // paymentAccountId): các ca IPN phía dưới cần payment sinh mã + QR
    // trên ĐÚNG tài khoản này — đường tài khoản mặc định của tenant
    // không có thứ tự xác định trong DB dùng chung của suite.
    const pinned = await setFee(classA, { feePaymentAccountId: sepayAccountId });
    expect(pinned.status).toBe(200);
    expect((pinned.body as { feePaymentAccountId: string }).feePaymentAccountId).toBe(sepayAccountId);

    const pub = await publicView(classA, buyer.token);
    expect(pub.feeEnabled).toBe(true);
    expect(pub.feeCost).toBe(FEE);
    expect(pub.isMember).toBe(false);
    expect(pub.canPurchase).toBe(true);
    // Gói công khai không mang dữ kiện nội bộ của lớp.
    expect(pub.cohortId).toBeUndefined();
    expect(pub.joinCode).toBeUndefined();
    expect(pub.feePaymentAccountId).toBeUndefined();

    // Lớp chưa đặt học phí: không bán gói.
    const pubNoFee = await publicView(classNoFee, buyer.token);
    expect(pubNoFee.feeEnabled).toBe(false);
    expect(pubNoFee.canPurchase).toBe(false);
    const noFee = await createClassFeePayment(buyer.token, classNoFee);
    expect(noFee.status).toBe(400);
    expect(JSON.stringify(noFee.body)).toContain('payment.no_fee');
  });

  it('2. IPN khớp đủ 3 điều kiện → succeeded → vào roster + ACTIVE mọi khoá của lớp; replay không trùng ghi danh', async () => {
    const buyer = await person();
    const created = await createClassFeePayment(buyer.token, classA);
    expect(created.status).toBeLessThan(300);
    const payment = created.body as { id: string; paymentCode: string; component: string; itemId: string; amount: number; vietqrPayload: string | null };
    expect(payment.component).toBe('class_fee');
    expect(payment.itemId).toBe(classA);
    expect(payment.amount).toBe(FEE);
    expect(payment.paymentCode).toMatch(/^LMS[0-9A-HJKMNP-TV-Z]{9}$/);
    expect(typeof payment.vietqrPayload).toBe('string');
    expect(await enrolmentActive(courseA1, buyer.token)).toBe(false);

    const body = ipnBody(payment.paymentCode);
    const first = await postIpn(body);
    expect((first.body as { success: boolean }).success).toBe(true);
    await waitPaymentStatus(payment.id, 'succeeded');
    // Chờ hệ quả ghi danh vật chất hoá xong rồi mới khẳng định
    // (issue #219): trạng thái succeeded chưa đảm bảo ghi danh ở
    // từng khoá của lớp đã ACTIVE — xem waitForClassEnrolmentActive.
    await waitForClassEnrolmentActive(classA, buyer.id, buyer.token, [courseA1, courseA2]);

    expect(await rosterIds(classA)).toContain(buyer.id);
    expect(await enrolmentActive(courseA1, buyer.token)).toBe(true);
    expect(await enrolmentActive(courseA2, buyer.token)).toBe(true);
    const pub = await publicView(classA, buyer.token);
    expect(pub.isMember).toBe(true);
    expect(pub.canPurchase).toBe(false);

    // Đã là thành viên ACTIVE thì không mua lại được gói.
    const again = await createClassFeePayment(buyer.token, classA);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain('class.already_member');

    // Replay IPN (SePay retry): duplicate, roster vẫn đúng một dòng cho người mua.
    const replay = await postIpn(body);
    expect((replay.body as { duplicate?: boolean }).duplicate).toBe(true);
    // Chờ chuỗi đối soát của payment chốt xong rồi mới đếm (issue
    // #219; thay sleep cố định 1.200ms trước đây): replay bị từ chối
    // đồng bộ ở tầng IPN, nhưng các đếm dưới đây chỉ có nghĩa khi
    // nhịp matching của lượt IPN đầu đã chốt hẳn — xem
    // waitForPaymentReconciled.
    await waitForPaymentReconciled(payment.id);
    const cohort = await pg.query('select cohort_id from classes where id = $1', [classA]);
    const members = await pg.query(
      'select count(*)::int as c from cohort_members where cohort_id = $1 and user_id = $2',
      [cohort.rows[0].cohort_id, buyer.id],
    );
    expect(members.rows[0].c).toBe(1);
    const outbox = await pg.query(
      `select count(*)::int as c from outbox_events where type = 'payment_succeeded' and payload->>'paymentId' = $1`,
      [payment.id],
    );
    expect(outbox.rows[0].c).toBe(1);
  });

  it('3. IPN sai số tiền → needs_review, không vào lớp', async () => {
    const buyer = await person();
    const created = await createClassFeePayment(buyer.token, classA);
    const payment = created.body as { id: string; paymentCode: string };
    const res = await postIpn(ipnBody(payment.paymentCode, { amount: FEE - 1000 }));
    expect((res.body as { success: boolean }).success).toBe(true);
    await waitPaymentStatus(payment.id, 'needs_review');
    expect(await rosterIds(classA)).not.toContain(buyer.id);
    expect(await enrolmentActive(courseA1, buyer.token)).toBe(false);
  });

  it('4. IPN vào tài khoản nhận KHÁC mang mã của payment này → needs_review, không vào lớp (điều kiện tài khoản nhận)', async () => {
    const otherXid = `xid-classfee-other-${Date.now()}`;
    const otherKey = 'sk-test-classfee-other-55';
    const other = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({
        name: 'SePay khác', gateway: 'sepay',
        config: { bankCode: 'MBBANK', bankAccountNumber: '113366660000', sepayApiKey: otherKey, sepayBankAccountXid: otherXid },
      });
    expect(other.status).toBeLessThan(300);

    const buyer = await person();
    const created = await createClassFeePayment(buyer.token, classA);
    const payment = created.body as { id: string; paymentCode: string };
    const body = ipnBody(payment.paymentCode, { bank_account_xid: otherXid, account_number: '113366660000' });
    const res = await http(app).post('/api/v1/payments/ipn/sepay').set('Authorization', `Apikey ${otherKey}`).send(body);
    expect((res.body as { success: boolean }).success).toBe(true);
    await waitPaymentStatus(payment.id, 'needs_review');
    expect(await rosterIds(classA)).not.toContain(buyer.id);
    void sepayAccountId;
  });

  it('5. tài khoản chỉ định trên lớp thuộc tenant khác → chặn tạo payment (payment.account_tenant_mismatch)', async () => {
    const foreign = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Tài khoản sắp chuyển tenant', gateway: 'manual' });
    const foreignId = foreign.body.id as string;
    const tenants = await pg.query('select id from tenants');
    const classRow = await pg.query('select tenant_id from classes where id = $1', [classA]);
    const otherTenant = (tenants.rows as { id: string }[]).find((t) => t.id !== classRow.rows[0].tenant_id);
    expect(otherTenant).toBeTruthy();
    await pg.query('update payment_accounts set tenant_id = $1 where id = $2', [otherTenant!.id, foreignId]);

    const classC = await createClass('Lớp học phí C');
    const set = await setFee(classC, { feeCost: FEE, feePaymentAccountId: foreignId });
    expect(set.status).toBe(200);
    const buyer = await person();
    const res = await createClassFeePayment(buyer.token, classC);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('payment.account_tenant_mismatch');
  });

  it('6. webhook manual succeeded → vào lớp; hoàn một phần giữ quyền; hoàn đủ → đình chỉ mọi khoá, GIỮ điểm, vào lại nối tiếp dữ liệu', async () => {
    const set = await setFee(classB, { feeCost: 200000, feePaymentAccountId: manualAccountId });
    expect(set.status).toBe(200);
    const buyer = await person();
    const created = await createClassFeePayment(buyer.token, classB);
    expect(created.status).toBeLessThan(300);
    const payment = created.body as { id: string; paymentCode: string | null; amount: number };
    expect(payment.paymentCode).toBeNull();
    expect(payment.amount).toBe(200000);

    const hook = await http(app).post('/api/v1/payments/webhook').set('x-payment-webhook-secret', WEBHOOK_SECRET)
      .send({ gateway: 'manual', externalTransactionId: `tx-cf-b-${Date.now()}`, paymentId: payment.id, status: 'succeeded' });
    expect((hook.body as { status: string }).status).toBe('succeeded');
    expect(await rosterIds(classB)).toContain(buyer.id);
    expect(await enrolmentActive(courseB1, buyer.token)).toBe(true);

    // Điểm theo bài của người mua trong khoá của lớp (bằng chứng giữ dữ liệu).
    const item = await createGradeItem(app, teacher.token, courseB1, { itemName: 'Bài kiểm tra 1' });
    await setGrade(app, teacher.token, item.id, buyer.id, 8);
    const ueBefore = await pg.query(
      `select ue.id, ue.status from user_enrolments ue join enrol e on e.id = ue.enrol_id
        where e.enrol = 'cohort' and ue.user_id = $1 and e.course_id = $2`,
      [buyer.id, courseB1],
    );
    expect(ueBefore.rows).toHaveLength(1);
    expect(ueBefore.rows[0].status).toBe(0);

    // Hoàn một phần: giữ nguyên quyền lợi.
    const partial = await http(app).post(`/api/v1/payments/${payment.id}/refund`).set('Authorization', `Bearer ${admin}`)
      .send({ amount: 50000, reason: 'partial', externalTransactionId: `ft-cf-out-${Date.now()}-1` });
    expect(partial.status).toBeLessThan(300);
    expect(await rosterIds(classB)).toContain(buyer.id);
    expect(await enrolmentActive(courseB1, buyer.token)).toBe(true);

    // Hoàn đủ phần còn lại + lệnh chi đã xác nhận → đình chỉ khỏi lớp.
    const rest = await http(app).post(`/api/v1/payments/${payment.id}/refund`).set('Authorization', `Bearer ${admin}`)
      .send({ amount: 150000, reason: 'rest', externalTransactionId: `ft-cf-out-${Date.now()}-2` });
    expect(rest.status).toBeLessThan(300);
    const after = await http(app).get(`/api/v1/payments/${payment.id}`).set('Authorization', `Bearer ${admin}`);
    expect((after.body as { status: string }).status).toBe('refunded');

    expect(await rosterIds(classB)).not.toContain(buyer.id);
    expect(await enrolmentActive(courseB1, buyer.token)).toBe(false);
    // Ghi danh chuyển SUSPENDED (status 1) trên ĐÚNG dòng cũ — không xoá, không withdrawn.
    const ueAfter = await pg.query(
      `select ue.id, ue.status from user_enrolments ue join enrol e on e.id = ue.enrol_id
        where e.enrol = 'cohort' and ue.user_id = $1 and e.course_id = $2`,
      [buyer.id, courseB1],
    );
    expect(ueAfter.rows).toHaveLength(1);
    expect(ueAfter.rows[0].id).toBe(ueBefore.rows[0].id);
    expect(ueAfter.rows[0].status).toBe(1);
    // Điểm vẫn nguyên.
    const grade = await pg.query('select final_grade from grade_grades where item_id = $1 and user_id = $2', [item.id, buyer.id]);
    expect(grade.rows).toHaveLength(1);
    expect(Number(grade.rows[0].final_grade)).toBe(8);
    // Học sinh nằm trong danh sách đã đình chỉ của lớp.
    const suspended = await http(app).get(`/api/v1/classes/${classB}/roster/suspended`).set('Authorization', `Bearer ${teacher.token}`);
    expect((suspended.body as { userId: string }[]).map((m) => m.userId)).toContain(buyer.id);

    // Vào lại roster → ACTIVE lại trên đúng dòng ghi danh cũ.
    const readd = await http(app).post(`/api/v1/classes/${classB}/roster`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ userId: buyer.id });
    expect(readd.status).toBe(201);
    expect(await enrolmentActive(courseB1, buyer.token)).toBe(true);
    const ueBack = await pg.query(
      `select ue.id, ue.status from user_enrolments ue join enrol e on e.id = ue.enrol_id
        where e.enrol = 'cohort' and ue.user_id = $1 and e.course_id = $2`,
      [buyer.id, courseB1],
    );
    expect(ueBack.rows[0].id).toBe(ueBefore.rows[0].id);
    expect(ueBack.rows[0].status).toBe(0);
  });
});
