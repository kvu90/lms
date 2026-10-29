import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ADMIN, adminToken, createTestApp, createUserViaApi, http, login, uniqueName,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance } from '../../support/course-enrolment-helpers';
import { ClassesService } from '../../../src/modules/classes/classes.service';
import { ENROL_ACTIVE, ENROL_SUSPENDED, EnrolService } from '../../../src/modules/enrol/enrol.service';
import { PaymentsRepository } from '../../../src/modules/payments/payments.repository';
import { PaymentsService } from '../../../src/modules/payments/payments.service';

const TEST_DB_URL = process.env.LMS_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/lms_test_api';

/**
 * Hồi quy nguyên tử cho khâu SETTLE HOÀN TIỀN (issue #490, DL-10).
 *
 * Bất biến nghiệp vụ: khi cộng dồn hoàn đạt 100%, việc ĐÌNH CHỈ
 * quyền lợi (ghi danh học phí khoá / tư cách roster của lớp / quyền
 * lợi gói) và việc GHI SỔ hoàn (`settled` + khoản thu `refunded`)
 * nằm trên CÙNG một biên nguyên tử. Trước bản sửa, khâu đình chỉ tự
 * commit bằng transaction riêng ngay giữa transaction settle: settle
 * rollback vì lỗi ghi sổ thì đình chỉ đã ghi không quay lại được —
 * học viên mất quyền lợi dù khoản hoàn chưa hề được ghi nhận.
 *
 * Cách gây lỗi: spy `PaymentsRepository.updateRefund` ném lỗi — đây
 * là bước ghi sổ NGAY SAU điểm đình chỉ trong khâu settle, nên nó
 * phân biệt rõ hai thế giới cho cả ba component có quyền lợi
 * (enrol_fee, class_fee, tenant_plan): đình chỉ tự commit thì trạng
 * thái đình chỉ còn nguyên sau rollback (spec ĐỎ); đình chỉ cùng
 * transaction thì quyền lợi nguyên vẹn (spec XANH). Nửa sau mỗi ca
 * settle lại không spy để khẳng định trạng thái cuối khi thành công
 * không đổi: quyền lợi bị đình chỉ, dòng hoàn `settled`, khoản thu
 * `refunded`.
 */
describe('Settle hoàn tiền — rollback settle thì quyền lợi không bị đình chỉ (issue #490)', () => {
  let app: INestApplication;
  let pg: Client;
  let payments: PaymentsService;
  let paymentsRepo: PaymentsRepository;
  let classes: ClassesService;
  let enrol: EnrolService;
  let admin: string;
  let adminId: string;
  let platformTenantId: string;

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pg.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  /** Dòng hoàn `approved` cho trọn số tiền của khoản thu — trạng thái ngay trước khâu settle. */
  async function insertApprovedFullRefund(paymentId: string, amount: number) {
    return paymentsRepo.insertRefund({
      paymentId, amount, currency: 'VND',
      reason: 'Hoàn toàn bộ — ca kiểm rollback của settle',
      status: 'approved', createdBy: adminId,
      approvalLevel: 1, approvalThreshold: 1_000_000,
      approvedBy: adminId, approvedAt: new Date(),
      externalTransactionId: null,
    });
  }

  /** Ép bước ghi sổ hoàn lỗi sau điểm đình chỉ, chạy khâu settle, rồi gỡ ép lỗi. */
  async function settleWithLedgerFailure(paymentId: string, refundId: string, externalTransactionId: string): Promise<void> {
    const spy = vi.spyOn(paymentsRepo, 'updateRefund').mockRejectedValue(new Error('rollback probe'));
    try {
      await expect(payments.settleRefund(adminId, paymentId, refundId, { externalTransactionId }))
        .rejects.toThrow('rollback probe');
    } finally {
      spy.mockRestore();
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: TEST_DB_URL });
    await pg.connect();
    payments = app.get(PaymentsService);
    paymentsRepo = app.get(PaymentsRepository);
    classes = app.get(ClassesService);
    enrol = app.get(EnrolService);
    admin = await adminToken(app);
    adminId = (await login(app, ADMIN.username, ADMIN.password)).userId;
    const { rows } = await pg.query<{ id: string }>("SELECT id FROM tenants WHERE kind = 'platform'");
    platformTenantId = rows[0]!.id;
  });

  afterAll(async () => {
    await pg.end();
    await app.close();
  });

  it('enrol_fee: settle rollback thì ghi danh vẫn đang hoạt động, gọi lại thành công thì ghi danh bị đình chỉ', async () => {
    // Dựng trạng thái SAU thanh toán học phí thành công: khoản thu
    // enrol_fee đã `succeeded` (ghi thẳng như các fixture thanh toán
    // khác của suite) và ghi danh của buyer đã được kích hoạt qua
    // đúng móc hậu-thanh-toán `EnrolService.activatePaidEnrol` mà
    // webhook gọi tới. Khuôn ca hoàn enrol_fee của suite thanh toán:
    // khoá do admin dựng, người mua là người dùng thường — khâu
    // settle TAY đình chỉ ghi danh với danh tính người xác nhận chi
    // (admin) nên cổng `enrol:manage` của EnrolService thoả.
    const account = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`)
      .send({ name: uniqueName('manual'), gateway: 'manual' });
    expect(account.status).toBeLessThan(300);
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id, {
      method: 'fee', cost: 100_000, currency: 'VND', paymentAccountId: account.body.id as string,
    });
    const buyer = await createUserViaApi(app, admin);
    const courseTenant = await pg.query<{ tenant_id: string }>('SELECT tenant_id FROM course WHERE id = $1', [course.id]);
    const pay = await pg.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, account_id, user_id, amount, currency, component, item_id, status)
       VALUES ($1, $2, $3, 100000, 'VND', 'enrol_fee', $4, 'succeeded') RETURNING id`,
      [courseTenant.rows[0]!.tenant_id, account.body.id as string, buyer.id, instance.id],
    );
    const paymentId = pay.rows[0]!.id;
    await enrol.activatePaidEnrol(instance.id, buyer.id);
    const ueStatus = async () => {
      const { rows } = await pg.query<{ status: number }>(
        'SELECT status FROM user_enrolments WHERE enrol_id = $1 AND user_id = $2', [instance.id, buyer.id],
      );
      return rows[0]?.status;
    };
    expect(await ueStatus()).toBe(ENROL_ACTIVE);

    const refund = await insertApprovedFullRefund(paymentId, 100_000);
    await settleWithLedgerFailure(paymentId, refund.id, 'RB-ENROL-001');

    // Settle rollback: ghi danh KHÔNG được ở trạng thái đình chỉ, sổ
    // hoàn và khoản thu giữ nguyên trạng thái trước settle, và không
    // có sự kiện đình chỉ nào lọt ra outbox.
    expect(await ueStatus()).toBe(ENROL_ACTIVE);
    expect(await count("SELECT count(*) AS count FROM payment_refunds WHERE id = $1 AND status = 'approved'", [refund.id])).toBe(1);
    expect(await count("SELECT count(*) AS count FROM payments WHERE id = $1 AND status = 'succeeded'", [paymentId])).toBe(1);
    expect(await count(
      "SELECT count(*) AS count FROM outbox_events WHERE type = 'user_enrolment_suspended' AND payload->>'instanceId' = $1",
      [instance.id],
    )).toBe(0);

    // Gọi lại không còn lỗi: settle trọn vẹn — đình chỉ + ghi sổ cùng về đích.
    await payments.settleRefund(adminId, paymentId, refund.id, { externalTransactionId: 'RB-ENROL-001' });
    expect(await ueStatus()).toBe(ENROL_SUSPENDED);
    expect(await count("SELECT count(*) AS count FROM payment_refunds WHERE id = $1 AND status = 'settled'", [refund.id])).toBe(1);
    expect(await count("SELECT count(*) AS count FROM payments WHERE id = $1 AND status = 'refunded'", [paymentId])).toBe(1);
  });

  it('class_fee: settle rollback thì học viên vẫn thuộc roster lớp, gọi lại thành công thì bị gỡ khỏi roster', async () => {
    const clazz = await classes.createClass(adminId, { name: uniqueName('cls-fee') });
    const student = await createUserViaApi(app, admin);
    await classes.activatePaidClassEnrol(clazz.id, student.id);
    const memberCount = () => count(
      'SELECT count(*) AS count FROM cohort_members WHERE cohort_id = $1 AND user_id = $2',
      [clazz.cohortId, student.id],
    );
    expect(await memberCount()).toBe(1);

    const account = await pg.query<{ id: string }>(
      "INSERT INTO payment_accounts (tenant_id, name, gateway, enabled) VALUES ($1, $2, 'manual', true) RETURNING id",
      [platformTenantId, uniqueName('manual')],
    );
    const pay = await pg.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, account_id, user_id, amount, currency, component, item_id, status)
       VALUES ($1, $2, $3, 50000, 'VND', 'class_fee', $4, 'succeeded') RETURNING id`,
      [platformTenantId, account.rows[0]!.id, student.id, clazz.id],
    );
    const paymentId = pay.rows[0]!.id;
    const refund = await insertApprovedFullRefund(paymentId, 50_000);

    await settleWithLedgerFailure(paymentId, refund.id, 'RB-CLASS-001');

    // Settle rollback: học viên vẫn thuộc roster, không sự kiện gỡ
    // thành viên nào lọt ra outbox, sổ hoàn giữ nguyên.
    expect(await memberCount()).toBe(1);
    expect(await count(
      "SELECT count(*) AS count FROM outbox_events WHERE type = 'cohort_member_removed' AND payload->>'cohortId' = $1 AND payload->>'userId' = $2",
      [clazz.cohortId, student.id],
    )).toBe(0);
    expect(await count("SELECT count(*) AS count FROM payment_refunds WHERE id = $1 AND status = 'approved'", [refund.id])).toBe(1);

    await payments.settleRefund(adminId, paymentId, refund.id, { externalTransactionId: 'RB-CLASS-001' });
    expect(await memberCount()).toBe(0);
    expect(await count("SELECT count(*) AS count FROM payments WHERE id = $1 AND status = 'refunded'", [paymentId])).toBe(1);
  });

  it('tenant_plan: settle rollback thì quyền lợi gói vẫn đang hoạt động, gọi lại thành công thì quyền lợi bị đình chỉ', async () => {
    const beneficiary = await createUserViaApi(app, admin);
    const account = await pg.query<{ id: string }>(
      "INSERT INTO payment_accounts (tenant_id, name, gateway, enabled) VALUES ($1, $2, 'manual', false) RETURNING id",
      [platformTenantId, uniqueName('manual')],
    );
    const pay = await pg.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, account_id, user_id, amount, currency, component, item_id, status)
       VALUES ($1, $2, $3, 990000, 'VND', 'tenant_plan', $4, 'succeeded') RETURNING id`,
      [platformTenantId, account.rows[0]!.id, beneficiary.id, platformTenantId],
    );
    const paymentId = pay.rows[0]!.id;
    const entitlement = await paymentsRepo.insertEntitlement({
      tenantId: platformTenantId, userId: beneficiary.id, component: 'tenant_plan',
      paymentId, startsAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() + 30 * 86_400_000),
      status: 'active',
    });
    const refund = await insertApprovedFullRefund(paymentId, 990_000);
    const entitlementStatus = async () => {
      const { rows } = await pg.query<{ status: string }>('SELECT status FROM plan_entitlements WHERE id = $1', [entitlement.id]);
      return rows[0]?.status;
    };

    await settleWithLedgerFailure(paymentId, refund.id, 'RB-PLAN-001');
    expect(await entitlementStatus()).toBe('active');
    expect(await count("SELECT count(*) AS count FROM payment_refunds WHERE id = $1 AND status = 'approved'", [refund.id])).toBe(1);

    await payments.settleRefund(adminId, paymentId, refund.id, { externalTransactionId: 'RB-PLAN-001' });
    expect(await entitlementStatus()).toBe('suspended');
    expect(await count("SELECT count(*) AS count FROM payments WHERE id = $1 AND status = 'refunded'", [paymentId])).toBe(1);
  });
});
