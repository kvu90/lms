import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { course, courseCategories, gradeItems, notifications, outboxEvents, tenants, users } from '@lms/db';
import { spaceRegistry } from '@lms/db/control-plane';
import { relations } from '../../../src/db/relations';
import { tenantAls } from '../../../src/db/tenant-als';
import { SpaceDatabaseService, type SpaceDatabase } from '../../../src/db/routing/space-database.service';
import { SpaceJobRunner } from '../../../src/db/routing/space-job-runner';
import { TenantAwarePool } from '../../../src/db/tenant-pool';
import { NotificationDeliveryService } from '../../../src/notification-delivery.service';
import { NotificationEventsHandlerService } from '../../../src/notification-events-handler.service';
import { NotificationEventsMarker } from '../../../src/notification-events-marker.service';
import { OUTBOX_EVENT_QUEUE_ROUTES, type OutboxEventJobData } from '../../../src/outbox-event-routes';
import { OutboxRelayScheduler } from '../../../src/outbox-relay.scheduler';
import { NotificationEventsProcessor } from '../../../src/processors/notification-events.processor';

/**
 * Ca tích hợp của ĐỊNH TUYẾN JOB THEO TRUNG TÂM phía worker
 * (issue #582): relay outbox thật và consumer thông báo thật chạy
 * trên hai kho kiểm chứng dựng riêng cho đợt này — kho chung là
 * chính database test của worker, kho riêng là một database mới
 * (`lms_test_centre_a_582w`) có role ứng dụng riêng, CONNECT của
 * PUBLIC bị thu hồi, baseline nghiệp vụ áp bằng role chủ kho, và
 * một database control plane riêng (`lms_test_cp_582w`) giữ dòng
 * đăng ký của trung tâm. Chuỗi bí mật của kho riêng cố ý trỏ về
 * database mặc định `postgres` — đích cuối do sổ chốt như ca của
 * khung ở issue #581.
 *
 * Các ca khoá hai tiêu chí nghiệm thu của issue ở phía worker:
 * (1) relay đọc dòng outbox nằm TRONG kho riêng của trung tâm
 *     (lượt quét theo trung tâm), phát job mang slug của trung
 *     tâm, và đóng dấu `publishedAt` ở chính kho đó — kiểm chứng
 *     trực tiếp trong từng kho; sự kiện ở kho chung giữ đúng
 *     đường hiện tại (job mang slug của tenant ở kho chung).
 * (2) consumer thật (`NotificationEventsProcessor` + handler +
 *     đường phát thông báo thật) xử lý job của trung tâm thì
 *     thông báo được ghi vào kho riêng của trung tâm — kiểm
 *     chứng trực tiếp tại database của kho riêng, và kho chung
 *     không có thông báo đó.
 *
 * Shim `uuidv7()` chỉ áp khi server PostgreSQL dưới 18 như ca
 * tích hợp của khung (PG18 có sẵn hàm này).
 */
const CP_DATABASE = 'lms_test_cp_582w';
const CP_ROLE = 'lms_cp_test_582w';
const CP_PASSWORD = 'cp-test-582w';
const CENTRE_DATABASE = 'lms_test_centre_a_582w';
const CENTRE_ROLE = 'lms_centre_a_582w_app';
const CENTRE_PASSWORD = 'centre-a-582w';
const CENTRE_SLUG = 'trung-tam-a-582w';
const CENTRE_TENANT_ID = '01958200-0000-7000-8000-0000000000a1';
const SHARED_TENANT_ID = '01958200-0000-7000-8000-0000000000b1';
const SHARED_TENANT_SLUG = 'tt-chung-582w';
const STUDENT_ID = '01958200-0000-7000-8000-0000000000c1';
const COURSE_ID = '01958200-0000-7000-8000-0000000000d1';
const CATEGORY_ID = '01958200-0000-7000-8000-0000000000d2';
const GRADE_ITEM_ID = '01958200-0000-7000-8000-0000000000e1';
const CENTRE_OUTBOX_ID = '01958200-0000-7000-8000-0000000000f1';
const SHARED_OUTBOX_ID = '01958200-0000-7000-8000-0000000000f2';

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/** Dựng URL kết nối tới một database trên cùng cụm với database test của worker. */
function clusterUrl(database: string, username?: string, secret?: string): string {
  const base = new URL(process.env.DATABASE_URL!);
  base.pathname = `/${database}`;
  if (username) base.username = username;
  if (secret) base.password = secret;
  return base.toString();
}

/** Bọc một định danh Postgres trong dấu nháy kép cho các câu lệnh quản trị của ca test. */
function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Áp một file migration SQL (tách theo dấu phân đoạn của Drizzle) lên một database qua kết nối cho trước. */
async function applySqlFile(connectionString: string, filePath: string, withUuidShim: boolean): Promise<void> {
  await withClient(connectionString, async (client) => {
    if (withUuidShim) {
      const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
      if (Number(version.rows[0]!.server_version_num) < 180000) {
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query(UUIDV7_SHIM);
      }
    }
    const sqlText = readFileSync(filePath, 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  });
}

/** Áp bộ migration riêng của control plane từ rỗng (đọc chính các file SQL đã sinh trong repo). */
async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
  const outDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'control-plane');
  const folders = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'), true);
  }
}

/** Áp baseline nghiệp vụ vào kho riêng bằng kết nối của chính role chủ kho đó. */
async function applyBusinessBaseline(connectionString: string): Promise<void> {
  const baseline = join(
    __dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'centre', '20261025163710_baseline', 'migration.sql',
  );
  await applySqlFile(connectionString, baseline, true);
}

/** ConfigService giả chỉ mang đúng các khoá mà khung định tuyến, relay và các service trong ca đọc. */
function fakeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing config ${key}`);
      return value;
    },
  } as unknown as ConfigService;
}

/** Hàng đợi giả ghi lại mọi job relay phát (đúng bề mặt `Queue.add` mà relay dùng). */
class CaptureQueue {
  readonly jobs: Array<{ name: string; data: OutboxEventJobData }> = [];

  async add(name: string, data: OutboxEventJobData): Promise<void> {
    this.jobs.push({ name, data });
  }
}

/** Đọc trực tiếp các dòng thông báo của một học viên trong một kho bằng kết nối của role kho đó. */
async function readNotificationIdsDirectly(
  connectionString: string,
  userId: string,
): Promise<string[]> {
  return withClient(connectionString, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query<{ id: string }>(
      'SELECT id FROM notifications WHERE user_id_to = $1 ORDER BY id',
      [userId],
    );
    return result.rows.map((row) => row.id);
  });
}

describe('Định tuyến job theo trung tâm phía worker (integration)', () => {
  let spaceDb: SpaceDatabaseService;
  let sharedPool: TenantAwarePool;
  let sharedDb: SpaceDatabase;
  let marker: NotificationEventsMarker;

  beforeAll(async () => {
    // Cấp phát control plane + kho riêng trên cụm test như ca của
    // khung: role riêng cho từng kho, kho thuộc role của nó,
    // CONNECT của PUBLIC bị thu hồi và chỉ cấp lại cho đúng role đó.
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
      await admin.query(`CREATE ROLE ${CP_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE_ROLE} LOGIN PASSWORD '${CENTRE_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${CP_DATABASE} OWNER ${CP_ROLE}`);
      await admin.query(`CREATE DATABASE ${CENTRE_DATABASE} OWNER ${CENTRE_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CP_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CP_DATABASE} TO ${CP_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CENTRE_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_DATABASE} TO ${CENTRE_ROLE}`);
    });

    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD));
    await applyBusinessBaseline(clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD));

    process.env.SPACE_TEST_A_582W_URL = clusterUrl('postgres', CENTRE_ROLE, CENTRE_PASSWORD);

    const config = fakeConfig({
      CONTROL_PLANE_DATABASE_URL: clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD),
      DATABASE_SSL: false,
      SPACE_ROUTING_CACHE_TTL_MS: 60_000,
      SPACE_DB_POOL_MAX: 5,
      SPACE_DB_POOL_IDLE_TIMEOUT_MS: 60_000,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    });
    spaceDb = new SpaceDatabaseService(config);
    sharedPool = new TenantAwarePool({ connectionString: process.env.DATABASE_URL! });
    sharedDb = drizzle({ client: sharedPool, relations });
    spaceDb.bindSharedDatabase(sharedDb);

    // Dòng đăng ký của trung tâm kiểm chứng trong sổ.
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      const cpDb = drizzle({ client });
      await cpDb.insert(spaceRegistry).values({
        slug: CENTRE_SLUG,
        name: 'Trung tâm A 582w',
        kind: 'center',
        status: 'active',
        databaseName: CENTRE_DATABASE,
        storageMode: 'dedicated',
        connectionRoleRef: CENTRE_ROLE,
        secretRef: 'env:SPACE_TEST_A_582W_URL',
        schemaVersion: 'v1',
      });
    });

    // Dữ kiện nền ở kho chung: một tenant ở kho chung và một dòng
    // outbox của nó đang chờ phát.
    await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      // Xoá dữ kiện của một lượt chạy lỗi trước còn sót (nếu có)
      // để ca tự chạy lại được trên cùng database test.
      await client.query('DELETE FROM outbox_events WHERE id = $1', [SHARED_OUTBOX_ID]);
      await client.query('DELETE FROM tenants WHERE id = $1', [SHARED_TENANT_ID]);
      const businessDb = drizzle({ client, relations });
      await businessDb.insert(tenants).values({
        id: SHARED_TENANT_ID,
        slug: SHARED_TENANT_SLUG,
        name: 'Tenant kho chung 582w',
        kind: 'center',
      });
      await businessDb.insert(outboxEvents).values({
        id: SHARED_OUTBOX_ID,
        aggregate: 'grades',
        type: 'grade_updated',
        tenantId: SHARED_TENANT_ID,
        payload: { userId: STUDENT_ID, itemId: GRADE_ITEM_ID, finalGrade: 9 },
      });
    });

    // Dữ kiện nền ở kho riêng — ghi qua phiên theo trung tâm của
    // khung (đúng đường consumer sẽ chạy): tenant của trung tâm,
    // học viên, khoá, hạng mục điểm, và một dòng outbox chờ phát
    // trỏ vào các dữ kiện đó.
    await spaceDb.withSpaceDatabase(
      CENTRE_SLUG,
      async (db) => {
        await db.insert(tenants).values({
          id: CENTRE_TENANT_ID,
          slug: CENTRE_SLUG,
          name: 'Trung tâm A 582w',
          kind: 'center',
        });
        await db.insert(users).values({
          id: STUDENT_ID,
          username: 'hoc-vien-582w',
          email: 'hoc-vien-582w@example.com',
          firstName: 'Học viên',
          lastName: '582w',
        });
        await db.insert(courseCategories).values({ id: CATEGORY_ID, name: 'Danh mục 582w', tenantId: CENTRE_TENANT_ID });
        await db.insert(course).values({
          id: COURSE_ID,
          tenantId: CENTRE_TENANT_ID,
          category: CATEGORY_ID,
          fullName: 'Khoá học 582w',
          shortName: 'KH582W',
          isTemplate: true,
        });
        await db.insert(gradeItems).values({ id: GRADE_ITEM_ID, courseId: COURSE_ID, itemName: 'Bài kiểm tra 582w' });
        await db.insert(outboxEvents).values({
          id: CENTRE_OUTBOX_ID,
          aggregate: 'grades',
          type: 'grade_updated',
          tenantId: CENTRE_TENANT_ID,
          payload: { userId: STUDENT_ID, itemId: GRADE_ITEM_ID, finalGrade: 9 },
        });
      },
      { tenantId: CENTRE_TENANT_ID },
    );

    marker = new NotificationEventsMarker(
      fakeConfig({ REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379' }),
    );
  }, 180_000);

  afterAll(async () => {
    // Từng bước dọn độc lập: một bước lỗi (hoặc chưa kịp dựng ở
    // beforeAll) không được chặn các bước dọn còn lại.
    await marker?.onModuleDestroy().catch(() => undefined);
    await spaceDb?.onModuleDestroy().catch(() => undefined);
    await sharedPool?.end().catch(() => undefined);
    delete process.env.SPACE_TEST_A_582W_URL;
    // Dọn dữ kiện nền đã gieo vào kho chung để các ca khác dùng
    // chung database test của worker không thấy dữ kiện lạ.
    await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query('DELETE FROM outbox_events WHERE id = $1', [SHARED_OUTBOX_ID]);
      await client.query('DELETE FROM tenants WHERE id = $1', [SHARED_TENANT_ID]);
    }).catch(() => undefined);
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
    });
  });

  function makeRelay(): { relay: OutboxRelayScheduler; queue: CaptureQueue } {
    const queue = new CaptureQueue();
    const queues = new Map<string, Queue>([['notification-events', queue as unknown as Queue]]);
    const relay = new OutboxRelayScheduler(
      spaceDb.routedDatabase,
      { record: async () => undefined } as never,
      { recordRun: async () => undefined } as never,
      OUTBOX_EVENT_QUEUE_ROUTES,
      queues,
      spaceDb,
      fakeConfig({}),
    );
    return { relay, queue };
  }

  it('relay phát sự kiện ở kho chung theo đường hiện tại: job mang slug của tenant ở kho chung và dòng được đóng dấu ở kho chung', async () => {
    const { relay, queue } = makeRelay();

    // Relay chạy trong ngữ cảnh platform tường minh như nhịp
    // `relayTick` trên production (RLS fail-closed ngoài ngữ
    // cảnh). Database test của worker dùng chung với các ca tích
    // hợp khác nên lô có thể gồm dòng chờ của ca khác — khẳng
    // định nhắm đúng dòng của ca này.
    await tenantAls.run({ platform: true }, () => relay.publishPending());

    const sharedJob = queue.jobs.find((job) => job.data.outboxId === SHARED_OUTBOX_ID);
    expect(sharedJob).toBeDefined();
    expect(sharedJob!.data).toMatchObject({
      tenantId: SHARED_TENANT_ID,
      spaceSlug: SHARED_TENANT_SLUG,
    });
    const stamped = await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ published_at: Date | null }>(
        'SELECT published_at FROM outbox_events WHERE id = $1',
        [SHARED_OUTBOX_ID],
      );
      return result.rows[0]?.published_at;
    });
    expect(stamped).not.toBeNull();
  });

  it('relay quét outbox trong kho riêng của trung tâm: job mang slug của trung tâm và dòng được đóng dấu ở chính kho riêng', async () => {
    const { relay, queue } = makeRelay();

    const result = await tenantAls.run({ platform: true }, () => relay.publishPendingForCentres());

    expect(result).toEqual({ published: 1, failedSlugs: [] });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]!.data).toMatchObject({
      outboxId: CENTRE_OUTBOX_ID,
      tenantId: CENTRE_TENANT_ID,
      spaceSlug: CENTRE_SLUG,
    });
    // Kiểm chứng trực tiếp tại kho riêng bằng kết nối của role kho.
    const stamped = await withClient(clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD), async (client) => {
      const result = await client.query<{ published_at: Date | null }>(
        'SELECT published_at FROM outbox_events WHERE id = $1',
        [CENTRE_OUTBOX_ID],
      );
      return result.rows[0]?.published_at;
    });
    expect(stamped).not.toBeNull();
    // Sự kiện của trung tâm không hề xuất hiện ở kho chung.
    const inShared = await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ count: string }>(
        'SELECT count(*) FROM outbox_events WHERE id = $1',
        [CENTRE_OUTBOX_ID],
      );
      return Number(result.rows[0]!.count);
    });
    expect(inShared).toBe(0);
  });

  it('consumer thật xử lý job của trung tâm thì thông báo được ghi vào kho riêng của trung tâm, không vào kho chung', async () => {
    const { relay, queue } = makeRelay();
    // Phát lại từ đầu trên một dòng outbox MỚI trong kho riêng để
    // job đi trọn đường relay → consumer như production (dòng của
    // ca trước đã đóng dấu và đã được kiểm chứng ở ca đó).
    // Id dòng outbox của ca này phải DUY NHẤT theo lượt chạy:
    // dấu chống trùng của consumer nằm trong Redis dùng chung
    // (không bị xoá cùng database khi dọn), nên id cố định sẽ bị
    // coi là "đã xử lý" ở mọi lượt chạy sau lượt đầu tiên.
    const freshOutboxId = randomUUID();
    await spaceDb.withSpaceDatabase(
      CENTRE_SLUG,
      async (db) => {
        await db.insert(outboxEvents).values({
          id: freshOutboxId,
          aggregate: 'grades',
          type: 'grade_updated',
          tenantId: CENTRE_TENANT_ID,
          payload: { userId: STUDENT_ID, itemId: GRADE_ITEM_ID, finalGrade: 10 },
        });
      },
      { tenantId: CENTRE_TENANT_ID },
    );
    await tenantAls.run({ platform: true }, () => relay.publishPendingForCentres());
    const jobData = queue.jobs.find((job) => job.data.outboxId === freshOutboxId)?.data;
    expect(jobData).toBeDefined();
    expect(jobData!.spaceSlug).toBe(CENTRE_SLUG);

    const config = fakeConfig({
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      DATABASE_URL: process.env.DATABASE_URL!,
    });
    const fakeI18n = { t: (key: string) => key } as never;
    const dispatchQueue = { add: async () => ({}) };
    const delivery = new NotificationDeliveryService(
      spaceDb,
      config,
      dispatchQueue as never,
      fakeI18n,
    );
    const handler = new NotificationEventsHandlerService(spaceDb, delivery, fakeI18n);
    const processor = new NotificationEventsProcessor(handler, marker, new SpaceJobRunner(spaceDb));

    const outcome = await processor.process({ data: jobData } as Job<OutboxEventJobData>);

    expect(outcome).toEqual({ handled: true });
    // Kiểm chứng trực tiếp tại từng kho: thông báo của học viên
    // nằm ở kho riêng của trung tâm, kho chung không có dòng nào.
    expect(
      await readNotificationIdsDirectly(clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD), STUDENT_ID),
    ).toHaveLength(1);
    expect(await readNotificationIdsDirectly(process.env.DATABASE_URL!, STUDENT_ID)).toHaveLength(0);
    const centreNotifications = await spaceDb.withSpaceDatabase(
      CENTRE_SLUG,
      async (db) => db.select().from(notifications).where(eq(notifications.userIdTo, STUDENT_ID)),
      { tenantId: CENTRE_TENANT_ID },
    );
    expect(centreNotifications).toHaveLength(1);
  });
});
