import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';
import { WorkerPaidClassEnrolActivationService } from '../../../src/worker-paid-class-enrol-activation.service';
import { WorkerEnrolOutboxService } from '../../../src/worker-enrol-outbox.service';

/**
 * Đặc tả tính nguyên tử của adapter kích hoạt ghi danh cấp lớp ở
 * worker (điểm chặn của phân xử 6509434733 trên PR #552): chèn
 * thành viên cohort + cả hai dòng outbox (`cohort_member_added`,
 * `class_member_joined`) phải nằm trong CÙNG một transaction. Lỗi ở
 * bất kỳ bước nào cũng rollback toàn bộ, nên lần chạy lại sau đó
 * thấy chưa thuộc roster và chạy đủ cả ba bước ghi — không còn cửa
 * sổ payment chốt `succeeded` mà `cohort_member_added` đã mất.
 *
 * Cách tiêm lỗi: bọc cả hai cổng ghi outbox của adapter
 * (`enqueue` của code mới và `enqueueStandalone` của code cũ) bằng
 * cùng một bộ đếm — ném lỗi ở lần gọi thứ N. Nhờ đó cùng một ca
 * kiểm chứng được cả hai phía: trên code cũ, lỗi ở lần ghi thứ hai
 * để lại thành viên + dòng outbox đầu đã commit, và lần chạy lại
 * gặp roster đã có nên return sớm, vĩnh viễn thiếu
 * `class_member_joined` (ca ĐỎ); trên code mới, mọi bước rollback
 * và lần chạy lại cho đủ cả ba bước ghi đúng một lần (ca XANH).
 *
 * Spec gọi trực tiếp adapter (không qua nhịp quét) để tiêm lỗi đúng
 * điểm giữa các bước ghi — nhịp quét không có điểm tiêm nào ở đó.
 * Module boot bằng harness role thường như spec nhịp quét.
 */
describe('Kích hoạt ghi danh cấp lớp ở worker — chèn thành viên và hai dòng outbox cùng một transaction', () => {
  let harness: OrdinaryWorkerModuleHarness;
  let pg: Client;
  let adapter: WorkerPaidClassEnrolActivationService;
  let enrolOutbox: WorkerEnrolOutboxService;
  let tenantId = '';
  let tenantCtxId = '';
  let systemCtxId = '';
  const tag = randomUUID().slice(0, 8);

  const uid = () => randomUUID();

  async function insertUser(): Promise<string> {
    const id = uid();
    const short = id.replaceAll('-', '').slice(0, 12);
    await pg.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [id, `w552_${short}`, `w552_${short}@example.test`]);
    return id;
  }

  /** Lớp mới kèm backing cohort, không có khoá nào trỏ tới (chốt tách vai bỏ qua). */
  async function makeClass(ownerId: string): Promise<{ classId: string; cohortId: string }> {
    const classId = uid();
    const cohortId = uid();
    const classCtxId = uid();
    await pg.query(
      'INSERT INTO cohort (id, tenant_id, name, id_number, description, context_id, component, visible) VALUES ($1, $2, $3, $4, $5, $6, $7, true)',
      [cohortId, tenantId, 'Cohort đặc tả hoá worker 552', '', '', classCtxId, ''],
    );
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 45, $2, $3, 4)', [
      classCtxId, classId, `/${systemCtxId}/${tenantCtxId}/${classCtxId}`,
    ]);
    await pg.query(
      "INSERT INTO classes (id, tenant_id, name, owner_id, cohort_id, status) VALUES ($1, $2, $3, $4, $5, 'active')",
      [classId, tenantId, 'Lớp đặc tả hoá worker 552', ownerId, cohortId],
    );
    return { classId, cohortId };
  }

  async function memberCount(cohortId: string, userId: string): Promise<number> {
    const res = await pg.query('SELECT count(*)::int AS c FROM cohort_members WHERE cohort_id = $1 AND user_id = $2', [cohortId, userId]);
    return (res.rows[0] as { c: number }).c;
  }

  async function outboxCount(type: string, userId: string): Promise<number> {
    const res = await pg.query(
      "SELECT count(*)::int AS c FROM outbox_events WHERE type = $1 AND payload ->> 'userId' = $2",
      [type, userId],
    );
    return (res.rows[0] as { c: number }).c;
  }

  /**
   * Tiêm lỗi vào lần ghi outbox thứ `failOnCall` (đếm chung cho cả
   * `enqueue` và `enqueueStandalone`); trả hàm khôi phục.
   */
  function armFault(failOnCall: number): () => void {
    let calls = 0;
    const origEnqueue = enrolOutbox.enqueue.bind(enrolOutbox);
    const origStandalone = enrolOutbox.enqueueStandalone.bind(enrolOutbox);
    const fail = (): never => {
      throw new Error('lỗi tiêm giữa chừng');
    };
    enrolOutbox.enqueue = (async (...args: Parameters<typeof origEnqueue>) => {
      calls += 1;
      if (calls === failOnCall) fail();
      return origEnqueue(...args);
    }) as typeof origEnqueue;
    enrolOutbox.enqueueStandalone = (async (...args: Parameters<typeof origStandalone>) => {
      calls += 1;
      if (calls === failOnCall) fail();
      return origStandalone(...args);
    }) as typeof origStandalone;
    return () => {
      enrolOutbox.enqueue = origEnqueue;
      enrolOutbox.enqueueStandalone = origStandalone;
    };
  }

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    harness = await bootWorkerModuleAsOrdinaryRole();
    adapter = harness.context.get(WorkerPaidClassEnrolActivationService);
    enrolOutbox = harness.context.get(WorkerEnrolOutboxService);
    tenantId = uid();
    tenantCtxId = uid();
    systemCtxId = uid();
    await pg.query('INSERT INTO tenants (id, slug, name, kind) VALUES ($1, $2, $3, $4)', [
      tenantId, `trung-tam-w552-${tag}`, 'Trung tâm đặc tả hoá worker 552', 'school',
    ]);
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 10, NULL, $2, 1)', [
      systemCtxId, `/${systemCtxId}`,
    ]);
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 20, $2, $3, 2)', [
      tenantCtxId, tenantId, `/${systemCtxId}/${tenantCtxId}`,
    ]);
  });

  afterAll(async () => {
    await harness.close();
    await pg.end();
  });

  it('lỗi ở lần ghi outbox đầu tiên (ngay sau khi chèn thành viên) → rollback toàn bộ; chạy lại cho đủ cả ba bước ghi đúng một lần', async () => {
    const buyer = await insertUser();
    const { classId, cohortId } = await makeClass(buyer);

    const restore = armFault(1);
    await expect(adapter.activatePaidClassEnrol(classId, buyer)).rejects.toThrow('lỗi tiêm giữa chừng');
    restore();

    expect(await memberCount(cohortId, buyer)).toBe(0);
    expect(await outboxCount('cohort_member_added', buyer)).toBe(0);
    expect(await outboxCount('class_member_joined', buyer)).toBe(0);

    await adapter.activatePaidClassEnrol(classId, buyer);

    expect(await memberCount(cohortId, buyer)).toBe(1);
    expect(await outboxCount('cohort_member_added', buyer)).toBe(1);
    expect(await outboxCount('class_member_joined', buyer)).toBe(1);

    // Gọi lại: đã thuộc roster nên dừng sớm, không ghi trùng.
    await adapter.activatePaidClassEnrol(classId, buyer);
    expect(await memberCount(cohortId, buyer)).toBe(1);
    expect(await outboxCount('cohort_member_added', buyer)).toBe(1);
    expect(await outboxCount('class_member_joined', buyer)).toBe(1);
  });

  it('lỗi ở lần ghi outbox thứ hai (giữa hai lần ghi) → rollback toàn bộ; chạy lại cho đủ cả ba bước ghi đúng một lần, không thiếu sự kiện nào', async () => {
    const buyer = await insertUser();
    const { classId, cohortId } = await makeClass(buyer);

    const restore = armFault(2);
    await expect(adapter.activatePaidClassEnrol(classId, buyer)).rejects.toThrow('lỗi tiêm giữa chừng');
    restore();

    expect(await memberCount(cohortId, buyer)).toBe(0);
    expect(await outboxCount('cohort_member_added', buyer)).toBe(0);
    expect(await outboxCount('class_member_joined', buyer)).toBe(0);

    await adapter.activatePaidClassEnrol(classId, buyer);

    expect(await memberCount(cohortId, buyer)).toBe(1);
    expect(await outboxCount('cohort_member_added', buyer)).toBe(1);
    expect(await outboxCount('class_member_joined', buyer)).toBe(1);
  });
});
