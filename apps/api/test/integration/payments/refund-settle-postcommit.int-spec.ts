import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ADMIN, adminToken, createTestApp, createUserViaApi, login, uniqueName,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance } from '../../support/course-enrolment-helpers';
import { ClassesService } from '../../../src/modules/classes/classes.service';
import { ENROL_ACTIVE, ENROL_SUSPENDED, EnrolService } from '../../../src/modules/enrol/enrol.service';
import { PaymentsRepository } from '@lms/payments';
import { PaymentsService } from '../../../src/modules/payments/payments.service';

const TEST_DB_URL = process.env.LMS_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/lms_test_api';

/**
 * Hồi quy kết quả đáp ứng của khâu SETTLE HOÀN TIỀN khi bước phát
 * sự kiện SAU commit lỗi (issue #490 — điều kiện đối chiếu của vòng
 * sửa hẹp PR #535).
 *
 * Bất biến nghiệp vụ: một xác nhận chi đã ghi sổ xong (dòng hoàn
 * `settled`, khoản thu `refunded`, roster đã gỡ trong cùng
 * transaction) KHÔNG BAO GIỜ được báo ngược thành lỗi chỉ vì bước
 * phát sự kiện trong-tiến-trình `cohort_member_removed` sau commit
 * ném lỗi. Đặc tả #490 yêu cầu ba luồng giữ nguyên hành vi đáp ứng:
 * trả lỗi sau một commit thành công là khác biệt quan sát được —
 * đường tay khiến người vận hành hiểu nhầm xác nhận chi chưa thành
 * công (và gọi lại bị chặn ở cổng `payment.refund_not_approved`),
 * đường tự động đánh dấu sự kiện `needs_review` dù giao dịch đã xác
 * nhận. Hàng outbox `cohort_member_removed` đã ghi bền trong chính
 * transaction settle là đường đồng bộ bù: consumer outbox sẵn có
 * quét hàng đó và gọi handler đình chỉ ghi danh, nên bước phát
 * nhanh chỉ là đường tắt, không phải điều kiện của kết quả settle.
 *
 * Cách ép lỗi: spy `ClassesService.notifyPaidClassMemberRemoved`
 * ném lỗi. Trên cơ chế cũ (chưa bọc bắt lỗi ở bước phát sau commit)
 * cả hai ca đều ĐỎ: ca đường tay bị `settleRefund` ném ngược lỗi
 * ép; ca đường tự động rơi vào khối catch của
 * `settleRefundFromDebitEvent` và sự kiện bị đánh dấu
 * `needs_review`. Sau khi bọc, cả hai ca XANH và trạng thái đã
 * commit giữ nguyên.
 */
describe('Settle hoàn tiền — lỗi ở bước phát sự kiện sau commit không đổi kết quả xác nhận chi (issue #490)', () => {
  let app: INestApplication;
  let pg: Client;
  let payments: PaymentsService;
  let paymentsRepo: PaymentsRepository;
  let classes: ClassesService;
  let enrol: EnrolService;
  let adminId: string;
  let platformTenantId: string;

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pg.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  /**
   * Dựng kịch bản class_fee trọn gói: lớp + khoá có instance cohort
   * neo vào backing cohort của lớp, học viên vào lớp qua đúng móc
   * hậu-thanh-toán để cohort sync vật chất hoá ghi danh đang hoạt
   * động, khoản thu class_fee đã `succeeded` và dòng hoàn
   * `approved` cho trọn số tiền — trạng thái ngay trước khâu settle.
   */
  async function setupClassFeeScenario(refundExternalTransactionId: string | null) {
    const clazz = await classes.createClass(adminId, { name: uniqueName('cls-postcommit') });
    const admin = await adminToken(app);
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId: clazz.cohortId });
    const student = await createUserViaApi(app, admin);
    await classes.activatePaidClassEnrol(clazz.id, student.id);
    const ueStatus = async () => {
      const { rows } = await pg.query<{ status: number }>(
        'SELECT status FROM user_enrolments WHERE enrol_id = $1 AND user_id = $2', [instance.id, student.id],
      );
      return rows[0]?.status;
    };
    expect(await ueStatus()).toBe(ENROL_ACTIVE);

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
    const refund = await paymentsRepo.insertRefund({
      paymentId, amount: 50_000, currency: 'VND',
      reason: 'Hoàn toàn bộ — ca hồi quy lỗi sau commit của settle',
      status: 'approved', createdBy: adminId,
      approvalLevel: 1, approvalThreshold: 1_000_000,
      approvedBy: adminId, approvedAt: new Date(),
      externalTransactionId: refundExternalTransactionId,
    });
    const outboxCount = () => count(
      "SELECT count(*) AS count FROM outbox_events WHERE type = 'cohort_member_removed' AND payload->>'cohortId' = $1 AND payload->>'userId' = $2",
      [clazz.cohortId, student.id],
    );
    return { clazz, student, paymentId, refund, ueStatus, outboxCount, accountId: account.rows[0]!.id };
  }

  /** Ép bước phát bù sau commit ném lỗi trong suốt fn, rồi gỡ ép lỗi. */
  async function withPostCommitFailure<T>(fn: () => Promise<T>): Promise<T> {
    const spy = vi.spyOn(classes, 'notifyPaidClassMemberRemoved')
      .mockRejectedValue(new Error('post-commit emit failure'));
    try {
      return await fn();
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
    adminId = (await login(app, ADMIN.username, ADMIN.password)).userId;
    const { rows } = await pg.query<{ id: string }>("SELECT id FROM tenants WHERE kind = 'platform'");
    platformTenantId = rows[0]!.id;
  });

  afterAll(async () => {
    await pg.end();
    await app.close();
  });

  it('đường tay: bước phát sau commit ném lỗi thì settle vẫn trả kết quả settled nhất quán, outbox còn nguyên và handler của đường bền áp được đình chỉ', async () => {
    const s = await setupClassFeeScenario(null);

    const view = await withPostCommitFailure(() =>
      payments.settleRefund(adminId, s.paymentId, s.refund.id, { externalTransactionId: 'PC-MANUAL-001' }));

    // Kết quả đáp ứng nhất quán với sổ đã ghi: không ném lỗi, dòng
    // hoàn trả về ở trạng thái settled; DB giữ đúng trạng thái đã
    // commit (hoàn settled, khoản thu refunded, roster đã gỡ).
    expect(view.status).toBe('settled');
    expect(await count("SELECT count(*) AS count FROM payment_refunds WHERE id = $1 AND status = 'settled'", [s.refund.id])).toBe(1);
    expect(await count("SELECT count(*) AS count FROM payments WHERE id = $1 AND status = 'refunded'", [s.paymentId])).toBe(1);
    expect(await count(
      'SELECT count(*) AS count FROM cohort_members WHERE cohort_id = $1 AND user_id = $2',
      [s.clazz.cohortId, s.student.id],
    )).toBe(0);

    // Bước phát nhanh chết nên ghi danh chưa bị đình chỉ ngay, nhưng
    // hàng outbox đã ghi trong transaction vẫn còn nguyên: handler
    // mà consumer outbox gọi theo hàng đó áp được đình chỉ.
    expect(await s.outboxCount()).toBeGreaterThanOrEqual(1);
    expect(await s.ueStatus()).toBe(ENROL_ACTIVE);
    await enrol.onCohortMemberRemoved({ cohortId: s.clazz.cohortId, userId: s.student.id });
    expect(await s.ueStatus()).toBe(ENROL_SUSPENDED);
  });

  it('đường tự động qua sự kiện debit: bước phát sau commit ném lỗi thì sự kiện vẫn được đánh dấu matched thay vì needs_review, sổ hoàn settled và outbox còn nguyên', async () => {
    const txId = uniqueName('PC-AUTO-');
    const s = await setupClassFeeScenario(txId);
    const event = await paymentsRepo.insertProviderEvent({
      provider: 'sepay', tenantId: platformTenantId, accountId: s.accountId,
      externalTransactionId: txId, direction: 'debit', amount: 50_000,
    });
    expect(event).toBeDefined();

    await withPostCommitFailure(() => payments.settleRefundFromDebitEvent(event!));

    // Sự kiện khớp trọn: matched và gắn đúng khoản thu — tuyệt đối
    // không rơi vào needs_review chỉ vì lỗi ở bước phát sau commit.
    const { rows } = await pg.query<{ match_status: string; matched_payment_id: string | null }>(
      'SELECT match_status, matched_payment_id FROM payment_provider_events WHERE id = $1', [event!.id],
    );
    expect(rows[0]!.match_status).toBe('matched');
    expect(rows[0]!.matched_payment_id).toBe(s.paymentId);
    expect(await count("SELECT count(*) AS count FROM payment_refunds WHERE id = $1 AND status = 'settled'", [s.refund.id])).toBe(1);
    expect(await count("SELECT count(*) AS count FROM payments WHERE id = $1 AND status = 'refunded'", [s.paymentId])).toBe(1);
    expect(await s.outboxCount()).toBeGreaterThanOrEqual(1);
  });
});
