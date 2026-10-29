import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEvents } from '@lms/db';
import { CohortSyncCatchupService } from '../../../src/cohort-sync-catchup.service';
import { redisConnectionFromUrl } from '../../../src/config/env';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Cơ chế phát bù một lần khi chuyển đổi consumer đồng bộ cohort
 * (điểm chặn 1 trên PR #550): các dòng outbox cohort đã bị relay
 * đóng dấu `publishedAt` khi còn chưa có trong bảng định tuyến —
 * relay không bao giờ phát lại chúng, consumer polling cũ đọc
 * theo watermark thì đã bị gỡ — phải được phát bù thành job đúng
 * một lần theo watermark cũ trước khi khoá watermark bị xoá.
 *
 * Các ca đi qua đường thật của production: dòng outbox được
 * chèn đúng hình dạng phía phát vẫn ghi (kèm `publishedAt` đã
 * đóng dấu), khoá watermark cũ được đặt trên Redis thật, rồi
 * gọi `drainLegacyBacklog()` của service thật — hoặc để
 * `OnModuleInit` tự chạy khi boot module mới — và khẳng định
 * tác dụng phụ nghiệp vụ ở tầng DB (ghi danh, sự kiện phát
 * tiếp), không khẳng định qua chi tiết triển khai.
 *
 * Mỗi ca dùng đồ thị riêng (id ngẫu nhiên) nên các ca độc lập
 * dữ kiện nghiệp vụ. Các dòng đã đóng dấu không bị relay quét
 * lại giữa chừng (relay chỉ lấy dòng chưa có dấu) nên khẳng
 * định "không có job" là khẳng định thật, không phải do relay
 * chen ngang.
 */
describe('Worker cohort sync catchup (phát bù tồn đọng khi chuyển đổi ở #550)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: OrdinaryWorkerModuleHarness['adminDb'];
  let eventsQueue: Queue;
  let catchup: CohortSyncCatchupService;
  let redis: Redis;
  let legacyWatermarkKey = '';
  let tenantId = '';
  let tenantCtxId = '';
  let systemCtxId = '';
  let categoryId = '';
  let studentRoleId = '';

  interface CourseGraph {
    courseId: string;
    cohortId: string;
    instanceId: string;
    courseCtxId: string;
  }

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    const tag = id.replaceAll('-', '').slice(0, 12);
    await db.execute(
      `INSERT INTO users (id, username, email) VALUES ('${id}', 'w550_${tag}', 'w550_${tag}@example.test')`,
    );
    return id;
  }

  async function makeCourseGraph(onLeave: 'suspend' | 'unenrol'): Promise<CourseGraph> {
    const courseId = randomUUID();
    const cohortId = randomUUID();
    const instanceId = randomUUID();
    const courseCtxId = randomUUID();
    await db.execute(
      `INSERT INTO course (id, tenant_id, category, full_name, short_name, is_template) VALUES ('${courseId}', '${tenantId}', '${categoryId}', 'Khoá catchup worker 550', 'W550-${courseId.slice(0, 8)}', true)`,
    );
    await db.execute(
      `INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ('${courseCtxId}', 50, '${courseId}', '/${systemCtxId}/${tenantCtxId}/${courseCtxId}', 3)`,
    );
    await db.execute(
      `INSERT INTO cohort (id, tenant_id, name, context_id) VALUES ('${cohortId}', '${tenantId}', 'Cohort worker 550', '${tenantCtxId}')`,
    );
    await db.execute(
      `INSERT INTO enrol (id, course_id, enrol, status, role_id, custom_int1, custom_int2, custom_text1) VALUES ('${instanceId}', '${courseId}', 'cohort', 0, '${studentRoleId}', '${cohortId}', NULL, '${onLeave}')`,
    );
    return { courseId, cohortId, instanceId, courseCtxId };
  }

  async function ueRow(instanceId: string, userId: string): Promise<Record<string, unknown> | undefined> {
    const rows = await db.execute(
      `SELECT * FROM user_enrolments WHERE enrol_id = '${instanceId}' AND user_id = '${userId}'`,
    ) as unknown as { rows: Array<Record<string, unknown>> };
    return rows.rows[0];
  }

  async function outboxOf(type: string, userId: string): Promise<Array<{ payload: Record<string, unknown> }>> {
    const rows = await db.execute(
      `SELECT payload FROM outbox_events WHERE type = '${type}' AND payload ->> 'userId' = '${userId}' ORDER BY seq`,
    ) as unknown as { rows: Array<{ payload: Record<string, unknown> }> };
    return rows.rows;
  }

  /**
   * Chèn một dòng sự kiện cohort ĐÃ BỊ ĐÓNG DẤU `publishedAt`
   * (đúng trạng thái dòng tồn đọng tại thời điểm chuyển đổi:
   * relay đã quét qua và đóng dấu khi loại này chưa có trong
   * bảng định tuyến) và trả id + seq để đặt watermark và chờ job.
   */
  async function emitMarkedRow(
    type: 'cohort_member_added' | 'cohort_member_removed',
    payload: Record<string, unknown>,
  ): Promise<{ id: string; seq: number }> {
    const [row] = await db.insert(outboxEvents).values({
      aggregate: 'cohort', type, tenantId, payload, publishedAt: new Date(),
    }).returning({ id: outboxEvents.id, seq: outboxEvents.seq });
    return { id: row!.id as string, seq: Number(row!.seq) };
  }

  /** Chờ job của một dòng outbox trên hàng đợi cohort-sync-events đạt trạng thái completed. */
  async function waitJobCompleted(outboxId: string, timeoutMs = 90000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await eventsQueue.getJob(outboxId);
      if (job && (await job.getState()) === 'completed') return;
      if (Date.now() > deadline) throw new Error(`job sự kiện ${outboxId} chưa completed sau ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /**
   * Thêm thành viên qua đường phát bù trực tiếp (không qua
   * relay): đẩy job vào hàng đợi với jobId mới, chờ completed
   * — dùng để dựng trạng thái "đã ghi danh" trước ca phát bù
   * sự kiện rút thành viên, đúng hình dạng phát lại ngoài cửa
   * sổ lưu giữ của `jobId`.
   */
  async function enrolDirectly(type: string, outboxId: string, payload: Record<string, unknown>): Promise<void> {
    const job = await eventsQueue.add(type, {
      outboxId, seq: 0, aggregate: 'cohort', type, payload, tenantId, occurredAt: new Date().toISOString(),
    }, { jobId: randomUUID() });
    const deadline = Date.now() + 90000;
    for (;;) {
      if ((await job.getState()) === 'completed') return;
      if (Date.now() > deadline) throw new Error(`job trực tiếp ${outboxId} chưa completed sau 90000ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    eventsQueue = context.get<Queue>(getQueueToken('cohort-sync-events'));
    catchup = context.get<CohortSyncCatchupService>(CohortSyncCatchupService);

    // Khoá watermark cũ dựng đúng cách consumer polling cũ
    // dựng: tiền tố + tên database trong DATABASE_URL của suite.
    const databaseName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, '') || 'default';
    legacyWatermarkKey = `lms:cohort-sync:${databaseName}:seq`;
    redis = new Redis({ ...redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379') });
    await redis.del(legacyWatermarkKey);

    tenantId = randomUUID();
    tenantCtxId = randomUUID();
    systemCtxId = randomUUID();
    categoryId = randomUUID();
    studentRoleId = randomUUID();
    await db.execute(
      `INSERT INTO tenants (id, slug, name, kind) VALUES ('${tenantId}', 'trung-tam-w550-${tenantId.slice(0, 8)}', 'Trung tâm catchup worker 550', 'school')`,
    );
    await db.execute(`INSERT INTO course_categories (id, tenant_id, name) VALUES ('${categoryId}', '${tenantId}', 'Danh mục worker 550')`);
    await db.execute(`INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ('${systemCtxId}', 10, NULL, '/${systemCtxId}', 1)`);
    await db.execute(`INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ('${tenantCtxId}', 20, '${tenantId}', '/${systemCtxId}/${tenantCtxId}', 2)`);
    await db.execute(`INSERT INTO role (id, name, short_name, archetype) VALUES ('${studentRoleId}', 'Student', 'student550', 'student')`);
  });

  afterAll(async () => {
    await redis.del(legacyWatermarkKey);
    await redis.quit();
    await harness.close();
  });

  it('dòng đã đóng dấu nhưng trên watermark cũ được phát bù đúng một lần: dòng trên thành ghi danh ACTIVE + user_enrolled, dòng dưới không có job, khoá bị xoá và phát bù lại là no-op', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);
    const payload = { cohortId: graph.cohortId, userId };

    const below = await emitMarkedRow('cohort_member_added', payload);
    const above = await emitMarkedRow('cohort_member_added', payload);
    expect(above.seq).toBeGreaterThan(below.seq);
    await redis.set(legacyWatermarkKey, String(below.seq));

    const enqueued = await catchup.drainLegacyBacklog();
    expect(enqueued).toBe(1);

    await waitJobCompleted(above.id);
    const ue = await ueRow(graph.instanceId, userId);
    expect(ue).toBeDefined();
    expect(ue?.status).toBe(0);
    expect(await outboxOf('user_enrolled', userId)).toHaveLength(1);
    expect(await eventsQueue.getJob(below.id)).toBeFalsy();
    expect(await redis.get(legacyWatermarkKey)).toBeNull();
    // Phát bù lại sau khi khoá đã xoá là no-op, không sinh job mới.
    expect(await catchup.drainLegacyBacklog()).toBe(0);
    expect(await outboxOf('user_enrolled', userId)).toHaveLength(1);
  }, 180000);

  it('dòng rút thành viên đã đóng dấu trên watermark cũ được phát bù: ghi danh biến mất và user_unenrolled được phát', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);
    const payload = { cohortId: graph.cohortId, userId };

    await enrolDirectly('cohort_member_added', randomUUID(), payload);
    expect(await ueRow(graph.instanceId, userId)).toBeDefined();

    await db.execute(`DELETE FROM cohort_members WHERE cohort_id = '${graph.cohortId}' AND user_id = '${userId}'`);
    const removed = await emitMarkedRow('cohort_member_removed', payload);
    await redis.set(legacyWatermarkKey, String(removed.seq - 1));

    const enqueued = await catchup.drainLegacyBacklog();
    expect(enqueued).toBe(1);

    await waitJobCompleted(removed.id);
    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
    expect(await outboxOf('user_unenrolled', userId)).toHaveLength(1);
    expect(await redis.get(legacyWatermarkKey)).toBeNull();
  }, 180000);

  it('hệ mới tinh không có khoá watermark cũ: phát bù là no-op, dòng đã đóng dấu không sinh job', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);
    const marked = await emitMarkedRow('cohort_member_added', { cohortId: graph.cohortId, userId });

    await redis.del(legacyWatermarkKey);
    expect(await catchup.drainLegacyBacklog()).toBe(0);
    expect(await eventsQueue.getJob(marked.id)).toBeFalsy();
    expect(await ueRow(graph.instanceId, userId)).toBeUndefined();
  }, 180000);

  it('khoá watermark có sẵn trước khi worker khởi động thì OnModuleInit tự phát bù không cần gọi tay', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);
    const marked = await emitMarkedRow('cohort_member_added', { cohortId: graph.cohortId, userId });
    await redis.set(legacyWatermarkKey, String(marked.seq - 1));

    // Boot module mới: OnModuleInit của service phát bù chạy
    // trong lúc init, không cần gọi drainLegacyBacklog() tay.
    const second = await bootWorkerModuleAsOrdinaryRole();
    try {
      await waitJobCompleted(marked.id);
      const ue = await ueRow(graph.instanceId, userId);
      expect(ue).toBeDefined();
      expect(ue?.status).toBe(0);
      expect(await redis.get(legacyWatermarkKey)).toBeNull();
    } finally {
      await second.close();
    }
  }, 180000);

  it('lỗi thoáng qua ở lần đẩy job đầu tiên thì lượt phát bù tự thử lại tới khi rút cạn trọn vẹn: phát đúng một lần, khoá chỉ bị xoá sau khi thành công và lần thử thất bại có log error kèm số lần thử', async () => {
    const graph = await makeCourseGraph('unenrol');
    const userId = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graph.cohortId}', '${userId}')`);
    const payload = { cohortId: graph.cohortId, userId };
    const marked = await emitMarkedRow('cohort_member_added', payload);
    await redis.set(legacyWatermarkKey, String(marked.seq - 1));

    // Tiêm lỗi thoáng qua: lần queue.add đầu tiên cho đúng dòng
    // tồn đọng này ném lỗi, mọi lần đẩy khác đi qua bình thường.
    // Tại thời điểm lỗi nổ ra, ghi lại giá trị khoá để khẳng
    // định khoá vẫn còn nguyên — khoá chỉ được xoá sau khi rút
    // cạn thành công.
    const originalAdd = eventsQueue.add.bind(eventsQueue);
    let faultArmed = true;
    let keyValueAtFailure: string | null = null;
    eventsQueue.add = (async (...args: unknown[]) => {
      const data = args[1] as { outboxId?: string } | undefined;
      if (faultArmed && data?.outboxId === marked.id) {
        faultArmed = false;
        keyValueAtFailure = await redis.get(legacyWatermarkKey);
        throw new Error('Lỗi thoáng qua mô phỏng tại queue.add trong ca tiêm lỗi');
      }
      return (originalAdd as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as typeof eventsQueue.add;

    // Bắt log error của chính service phát bù để khẳng định lần
    // thử thất bại được ghi kèm số lần thử, không nuốt lặng.
    const loggerRef = (catchup as unknown as {
      logger: { error: (...args: unknown[]) => void };
    }).logger;
    const originalError = loggerRef.error.bind(loggerRef);
    const errorMessages: string[] = [];
    loggerRef.error = (...args: unknown[]) => {
      errorMessages.push(String(args[0]));
      originalError(...args);
    };

    let enqueued: number | undefined;
    try {
      enqueued = await catchup.drainLegacyBacklog();
    } finally {
      eventsQueue.add = originalAdd as typeof eventsQueue.add;
      loggerRef.error = originalError;
    }

    // Lỗi đã thật sự nổ ở lần thử đầu, khoá còn nguyên tại thời
    // điểm đó, và lượt phát bù tự hồi phục trong cùng tiến trình:
    // rút cạn đủ dòng trên watermark ở lần thử sau.
    expect(faultArmed).toBe(false);
    expect(keyValueAtFailure).toBe(String(marked.seq - 1));
    expect(errorMessages.some((message) => message.includes('lần thử 1'))).toBe(true);
    expect(enqueued).toBe(1);

    await waitJobCompleted(marked.id);
    const ue = await ueRow(graph.instanceId, userId);
    expect(ue).toBeDefined();
    expect(ue?.status).toBe(0);
    expect(await outboxOf('user_enrolled', userId)).toHaveLength(1);
    expect(await redis.get(legacyWatermarkKey)).toBeNull();
  }, 180000);

  /**
   * Ca hồi quy cho nửa "không trùng" của yêu cầu ngắt-rồi-chạy-lại
   * (điểm chặn còn lại trên PR #550 sau phân xử `6507833974`): ca
   * tiêm lỗi trước đây chỉ có một dòng và lỗi ngay lần đẩy đầu
   * tiên nên chưa từng đẩy lại dòng đã đẩy thành công. Ca này
   * dùng hai đồ thị độc lập: dòng đầu đẩy thành công, dòng tiếp
   * theo lỗi — lần thử sau quét lại từ watermark nên đẩy lại
   * dòng đầu, và khẳng định mỗi hệ quả nghiệp vụ chỉ xuất hiện
   * đúng một lần (không trùng) trong khi cả hai dòng đều được xử
   * lý (không sót), khoá chỉ bị xoá sau khi rút cạn trọn vẹn.
   */
  it('phát bù bị ngắt giữa lô rồi chạy lại: dòng đã đẩy không sinh tác dụng phụ lần hai, dòng chưa đẩy vẫn được xử lý, khoá chỉ bị xoá sau khi rút cạn', async () => {
    const graphA = await makeCourseGraph('unenrol');
    const userA = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graphA.cohortId}', '${userA}')`);
    const graphB = await makeCourseGraph('unenrol');
    const userB = await insertUser();
    await db.execute(`INSERT INTO cohort_members (cohort_id, user_id) VALUES ('${graphB.cohortId}', '${userB}')`);

    const rowA = await emitMarkedRow('cohort_member_added', { cohortId: graphA.cohortId, userId: userA });
    const rowB = await emitMarkedRow('cohort_member_added', { cohortId: graphB.cohortId, userId: userB });
    expect(rowB.seq).toBeGreaterThan(rowA.seq);
    await redis.set(legacyWatermarkKey, String(rowA.seq - 1));

    // Tiêm lỗi giữa lô: lần đẩy đầu tiên của dòng B ném lỗi,
    // mọi lần đẩy khác — kể cả đẩy lại dòng A ở lần thử sau —
    // đi qua bình thường. Tại thời điểm lỗi, ghi lại giá trị
    // khoá để khẳng định khoá vẫn còn nguyên.
    const originalAdd = eventsQueue.add.bind(eventsQueue);
    let faultArmed = true;
    let keyValueAtFailure: string | null = null;
    eventsQueue.add = (async (...args: unknown[]) => {
      const data = args[1] as { outboxId?: string } | undefined;
      if (faultArmed && data?.outboxId === rowB.id) {
        faultArmed = false;
        keyValueAtFailure = await redis.get(legacyWatermarkKey);
        throw new Error('Lỗi thoáng qua mô phỏng giữa lô phát bù');
      }
      return (originalAdd as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as typeof eventsQueue.add;

    let enqueued: number | undefined;
    try {
      enqueued = await catchup.drainLegacyBacklog();
    } finally {
      eventsQueue.add = originalAdd as typeof eventsQueue.add;
    }

    // Lỗi đã thật sự nổ giữa lô, khoá còn nguyên tại thời điểm
    // đó, và lần thử sau rút cạn đủ cả hai dòng trên watermark.
    expect(faultArmed).toBe(false);
    expect(keyValueAtFailure).toBe(String(rowA.seq - 1));
    expect(enqueued).toBe(2);

    await waitJobCompleted(rowA.id);
    await waitJobCompleted(rowB.id);
    const ueA = await ueRow(graphA.instanceId, userA);
    expect(ueA).toBeDefined();
    expect(ueA?.status).toBe(0);
    const ueB = await ueRow(graphB.instanceId, userB);
    expect(ueB).toBeDefined();
    expect(ueB?.status).toBe(0);
    // Dòng A bị đẩy lại ở lần thử sau nhưng mỗi hệ quả nghiệp vụ
    // chỉ xuất hiện đúng một lần — không trùng tác dụng phụ.
    expect(await outboxOf('user_enrolled', userA)).toHaveLength(1);
    expect(await outboxOf('user_enrolled', userB)).toHaveLength(1);
    expect(await redis.get(legacyWatermarkKey)).toBeNull();
  }, 180000);
});
