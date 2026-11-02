import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  OutboxWriterService,
  PaymentsRepository,
  PlanEntitlementsService,
  SepayMatchingService,
} from '@lms/payments';
import { createCentreKysely } from '@lms/db';
import { spaceRegistry } from '@lms/db/control-plane';
import { relations } from '../../../src/db/relations';
import { SpaceDatabaseService } from '../../../src/db/routing/space-database.service';
import { tenantAls } from '../../../src/db/tenant-als';
import { TenantAwarePool } from '../../../src/db/tenant-pool';
import { WorkerEnrolOutboxService } from '../../../src/worker-enrol-outbox.service';
import { WorkerPaidClassEnrolActivationService } from '../../../src/worker-paid-class-enrol-activation.service';
import { WorkerPaidEnrolActivationService } from '../../../src/worker-paid-enrol-activation.service';
import { WorkerPaymentSettlementService } from '../../../src/worker-payment-settlement.service';
import { WorkerPaymentSpaceScope } from '../../../src/worker-payment-space-scope.service';

/**
 * Đặc tả tiền điều kiện Phần B của issue #587 — hạng mục 2: nhịp
 * quét matching SePay của worker phải kích hoạt ghi danh trả phí
 * tại ĐÚNG KHO của trung tâm sở hữu payment.
 *
 * Cách dựng: đồ thị service dựng tay đúng ngăn xếp production của
 * nhịp quét (repository + writer + service của `@lms/payments`, ba
 * cổng hiệu ứng của worker; scheduler không tham gia — spec gọi
 * thẳng `SepayMatchingService.sweep` trong bọc platform của nhịp
 * như `SepayMatchingScheduler.sweepTick` làm), khung định tuyến là
 * `SpaceDatabaseService` thật đọc sổ đăng ký ở một database
 * control plane tự cấp phát của ca. Ba trung tâm trên cùng một
 * nhịp:
 *
 * - Trung tâm KHO RIÊNG: sổ đăng ký trỏ về một database riêng tự
 *   cấp phát (baseline nghiệp vụ đầy đủ); instance thu phí / lớp
 *   thu phí CHỈ tồn tại ở kho riêng. Dòng thư mục của tenant (bảng
 *   `tenants`) nằm ở KHO CHUNG như nghĩa vụ thư mục của đợt di trú
 *   — điểm phân giải tra slug từ đó.
 * - Trung tâm KHO CHUNG: sổ đăng ký ghi chế độ kho chung; dữ kiện
 *   ở database test của worker như hiện tại.
 * - Trung tâm LỖI: sổ đăng ký ghi kho riêng nhưng bí mật kết nối
 *   không tồn tại — phân giải phải hỏng tường minh (fail-closed).
 *
 * Các ca ghim:
 *
 * 1. `enrol_fee` của trung tâm kho riêng: payment `succeeded`,
 *    ghi danh ACTIVE và outbox `user_enrolled` nằm Ở KHO RIÊNG,
 *    kho chung không có ghi danh nào cho instance đó; quét lại
 *    không nhân đôi. (Trước hạng mục này: đối chiếu đích đọc ở kho
 *    chung không thấy instance nên payment rơi `needs_review`,
 *    hoặc kích hoạt ném `instance_not_found` — tiền đã khớp mà
 *    quyền học không mở.)
 * 2. `enrol_fee` của trung tâm kho chung: hành vi hiện tại không
 *    đổi — `succeeded`, ghi danh ở kho chung.
 * 3. `class_fee` của trung tâm kho riêng: thành viên cohort +
 *    membership + cả hai outbox nằm ở kho riêng, kho chung sạch.
 * 4. MỘT nhịp gồm payment của cả hai trung tâm: mỗi payment kích
 *    hoạt ở đúng kho của trung tâm mình — phân giải theo TỪNG
 *    payment, không theo nhịp.
 * 5. Trung tâm lỗi: payment ở lại `pending`, sự kiện không
 *    `matched`, không ghi danh ở bất kỳ kho nào — dù instance thu
 *    phí của payment đó CÓ nằm ở kho chung (không rơi về kho chung
 *    để kích hoạt bừa).
 *
 * Shim `uuidv7()` chỉ áp khi server PostgreSQL dưới 18 (môi
 * trường chạy local bằng PG16): PG18 — bản ở CI và production —
 * có sẵn hàm này, shim sẽ che mất hàm gốc nên tuyệt đối không áp
 * ở đó. Khuôn cấp phát + áp migration chép theo spec khung định
 * tuyến (`test/integration/db/space-routing.int-spec.ts`).
 */
const CP_DATABASE = 'lms_test_cp_td1';
const CENTRE_DATABASE = 'lms_test_centre_td1';
const tag = randomUUID().slice(0, 8);
const CENTRE_SLUG = `trung-tam-rieng-td1-${tag}`;
const SHARED_SLUG = `trung-tam-chung-td1-${tag}`;
const BROKEN_SLUG = `trung-tam-loi-td1-${tag}`;
const FEE_AMOUNT = 100000;

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

const uid = () => randomUUID();

interface TenantFrame {
  systemCtxId: string;
  tenantCtxId: string;
}

/** Dựng URL kết nối tới một database trên cùng cụm với database test của worker. */
function clusterUrl(database: string): string {
  const base = new URL(process.env.DATABASE_URL!);
  base.pathname = `/${database}`;
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
async function applySqlFile(connectionString: string, filePath: string): Promise<void> {
  await withClient(connectionString, async (client) => {
    const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(version.rows[0]!.server_version_num) < 180000) {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query(UUIDV7_SHIM);
    }
    const sqlText = readFileSync(filePath, 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  });
}

describe('Kích hoạt ghi danh trả phí theo không gian của payment (integration)', () => {
  let spaceDb: SpaceDatabaseService;
  let sharedPool: TenantAwarePool;
  let matching: SepayMatchingService;
  let sharedPg: Client;
  let centrePg: Client;

  let centreTenantId = '';
  let sharedTenantId = '';
  let brokenTenantId = '';
  let centreAccountId = '';
  let sharedAccountId = '';
  let brokenAccountId = '';
  let centreFrame: TenantFrame;
  let sharedFrame: TenantFrame;
  let brokenFrame: TenantFrame;

  /** Một nhịp quét đúng hình production: bọc platform của scheduler, gọi thẳng service matching dùng chung. */
  async function sweepOnce(): Promise<void> {
    await tenantAls.run({ platform: true }, () => matching.sweep(20));
  }

  async function insertUser(pg: Client): Promise<string> {
    const id = uid();
    const short = id.replaceAll('-', '').slice(0, 12);
    await pg.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [
      id, `td1_${short}`, `td1_${short}@example.test`,
    ]);
    return id;
  }

  /** Dòng thư mục của tenant ở KHO CHUNG — nguồn tra slug của điểm phân giải (chỉ dòng `tenants`, không kèm dữ kiện nghiệp vụ). */
  async function seedDirectoryRow(tenantId: string, slug: string): Promise<void> {
    await sharedPg.query('INSERT INTO tenants (id, slug, name, kind) VALUES ($1, $2, $3, $4)', [
      tenantId, slug, `Trung tâm ${slug}`, 'school',
    ]);
  }

  /** Khung tenant nghiệp vụ trong kho của chính trung tâm: dòng tenant + context hệ thống + context tenant. */
  async function seedLocalFrame(pg: Client, tenantId: string, slug: string): Promise<TenantFrame> {
    const systemCtxId = uid();
    const tenantCtxId = uid();
    await pg.query('INSERT INTO tenants (id, slug, name, kind) VALUES ($1, $2, $3, $4)', [
      tenantId, slug, `Trung tâm ${slug}`, 'school',
    ]);
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 10, NULL, $2, 1)', [
      systemCtxId, `/${systemCtxId}`,
    ]);
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 20, $2, $3, 2)', [
      tenantCtxId, tenantId, `/${systemCtxId}/${tenantCtxId}`,
    ]);
    return { systemCtxId, tenantCtxId };
  }

  /** Khoá + instance thu phí `fee` giá 100.000 trong một kho cho một tenant. */
  async function makeFeeCourse(
    pg: Client,
    frame: TenantFrame,
    tenantId: string,
  ): Promise<{ courseId: string; instanceId: string }> {
    const categoryId = uid();
    const roleId = uid();
    const courseId = uid();
    const courseCtxId = uid();
    const instanceId = uid();
    await pg.query('INSERT INTO course_categories (id, tenant_id, name) VALUES ($1, $2, $3)', [
      categoryId, tenantId, 'Danh mục td1',
    ]);
    await pg.query("INSERT INTO role (id, name, short_name, archetype) VALUES ($1, 'Student', $2, 'student')", [
      roleId, `student-${tag}-${uid().slice(0, 8)}`,
    ]);
    await pg.query(
      'INSERT INTO course (id, tenant_id, category, full_name, short_name, is_template) VALUES ($1, $2, $3, $4, $5, true)',
      [courseId, tenantId, categoryId, 'Khoá thu phí td1', `TD1-${courseId.slice(0, 8)}`],
    );
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 50, $2, $3, 3)', [
      courseCtxId, courseId, `/${frame.systemCtxId}/${frame.tenantCtxId}/${courseCtxId}`,
    ]);
    await pg.query(
      `INSERT INTO enrol (id, course_id, enrol, status, role_id, cost, currency)
       VALUES ($1, $2, 'fee', 0, $3, ${FEE_AMOUNT}, 'VND')`,
      [instanceId, courseId, roleId],
    );
    return { courseId, instanceId };
  }

  /** Lớp thu phí kèm backing cohort trong một kho cho một tenant (khuôn của spec kích hoạt cấp lớp). */
  async function makeFeeClass(
    pg: Client,
    frame: TenantFrame,
    tenantId: string,
    ownerId: string,
  ): Promise<{ classId: string; cohortId: string }> {
    const classId = uid();
    const cohortId = uid();
    const classCtxId = uid();
    await pg.query(
      'INSERT INTO cohort (id, tenant_id, name, id_number, description, context_id, component, visible) VALUES ($1, $2, $3, $4, $5, $6, $7, true)',
      [cohortId, tenantId, 'Cohort td1', '', '', classCtxId, ''],
    );
    await pg.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 45, $2, $3, 4)', [
      classCtxId, classId, `/${frame.systemCtxId}/${frame.tenantCtxId}/${classCtxId}`,
    ]);
    await pg.query(
      `INSERT INTO classes (id, tenant_id, name, owner_id, cohort_id, status, fee_cost)
       VALUES ($1, $2, $3, $4, $5, 'active', ${FEE_AMOUNT})`,
      [classId, tenantId, 'Lớp thu phí td1', ownerId, cohortId],
    );
    return { classId, cohortId };
  }

  /** Payment `pending` ở kho chung (bảng payments là dữ kiện kho chung). */
  async function makePayment(input: {
    tenantId: string;
    accountId: string;
    userId: string;
    component: 'enrol_fee' | 'class_fee';
    itemId: string;
  }): Promise<{ paymentId: string; code: string }> {
    const paymentId = uid();
    const code = `LMSTD1${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    await sharedPg.query(
      `INSERT INTO payments (id, account_id, tenant_id, user_id, amount, currency, status, gateway, component, item_id, payment_code)
       VALUES ($1, $2, $3, $4, ${FEE_AMOUNT}, 'VND', 'pending', 'sepay', $5, $6, $7)`,
      [paymentId, input.accountId, input.tenantId, input.userId, input.component, input.itemId, code],
    );
    return { paymentId, code };
  }

  /** Sự kiện tiền về SePay khớp đủ 3 điều kiện với payment (mã, số tiền, tài khoản). */
  async function makeCreditEvent(input: {
    tenantId: string;
    accountId: string;
    code: string;
  }): Promise<string> {
    const eventId = uid();
    await sharedPg.query(
      `INSERT INTO payment_provider_events
         (id, provider, tenant_id, account_id, external_transaction_id, direction, amount, content, extracted_code, match_status, raw, received_at)
       VALUES ($1, 'sepay', $2, $3, $4, 'credit', ${FEE_AMOUNT}, $5, $6, 'received', $7, $8)`,
      [
        eventId, input.tenantId, input.accountId, `sepay-tx-${uid()}`, 'hoc phi td1', input.code,
        JSON.stringify({ reference_code: `FT${uid().replaceAll('-', '').slice(0, 10)}` }), new Date(),
      ],
    );
    return eventId;
  }

  async function paymentStatus(paymentId: string): Promise<string | undefined> {
    const res = await sharedPg.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [paymentId]);
    return res.rows[0]?.status;
  }

  async function eventStatus(eventId: string): Promise<string | undefined> {
    const res = await sharedPg.query<{ match_status: string }>(
      'SELECT match_status FROM payment_provider_events WHERE id = $1',
      [eventId],
    );
    return res.rows[0]?.match_status;
  }

  async function enrolmentStatus(pg: Client, instanceId: string, userId: string): Promise<number | undefined> {
    const res = await pg.query<{ status: number }>(
      'SELECT status FROM user_enrolments WHERE enrol_id = $1 AND user_id = $2',
      [instanceId, userId],
    );
    return res.rows[0]?.status;
  }

  async function outboxCount(pg: Client, type: string, userId: string): Promise<number> {
    const res = await pg.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM outbox_events WHERE type = $1 AND payload ->> 'userId' = $2",
      [type, userId],
    );
    return res.rows[0]!.c;
  }

  async function countRows(pg: Client, sqlText: string, params: unknown[]): Promise<number> {
    const res = await pg.query<{ c: number }>(sqlText, params);
    return res.rows[0]!.c;
  }

  beforeAll(async () => {
    centreTenantId = uid();
    sharedTenantId = uid();
    brokenTenantId = uid();
    centreAccountId = uid();
    sharedAccountId = uid();
    brokenAccountId = uid();

    const businessUrl = new URL(process.env.DATABASE_URL!);
    const businessDatabase = decodeURIComponent(businessUrl.pathname.replace(/^\//, ''));
    const businessRole = decodeURIComponent(businessUrl.username);

    // Cấp phát control plane + kho riêng của trung tâm trên cùng
    // cụm test bằng tên mới của riêng ca này (khuôn spec khung
    // định tuyến; ở ca này mọi kho dùng chung role của database
    // test vì ca chỉ ghim đích ghi của kích hoạt, không ghim cách
    // ly CONNECT theo role).
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${quoted(database)}`);
      }
    });
    const cpDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'control-plane');
    const folders = readdirSync(cpDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const folder of folders) {
      await applySqlFile(clusterUrl(CP_DATABASE), join(cpDir, folder, 'migration.sql'));
    }
    await applySqlFile(
      clusterUrl(CENTRE_DATABASE),
      join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'centre', '20261025163710_baseline', 'migration.sql'),
    );

    // Gieo sổ đăng ký: trung tâm kho riêng trỏ database riêng
    // (chuỗi bí mật mang tên database mặc định của role — resolver
    // chốt đích về `databaseName` trong sổ và kiểm chứng role
    // khớp `connectionRoleRef`), trung tâm kho chung, trung tâm
    // lỗi trỏ một bí mật không tồn tại.
    process.env.SPACE_TEST_TD1_URL = clusterUrl('postgres');
    await withClient(clusterUrl(CP_DATABASE), async (client) => {
      const cpDb = drizzle({ client });
      await cpDb.insert(spaceRegistry).values([
        {
          slug: CENTRE_SLUG, name: 'Trung tâm kho riêng td1', kind: 'center', status: 'active',
          databaseName: CENTRE_DATABASE, storageMode: 'dedicated', connectionRoleRef: businessRole,
          secretRef: 'env:SPACE_TEST_TD1_URL', schemaVersion: 'v1',
        },
        {
          slug: SHARED_SLUG, name: 'Trung tâm kho chung td1', kind: 'center', status: 'active',
          databaseName: businessDatabase, storageMode: 'shared', connectionRoleRef: businessRole,
          secretRef: 'env:DATABASE_URL', schemaVersion: 'v1',
        },
        {
          slug: BROKEN_SLUG, name: 'Trung tâm lỗi td1', kind: 'center', status: 'active',
          databaseName: 'lms_test_centre_td1_broken', storageMode: 'dedicated', connectionRoleRef: businessRole,
          secretRef: 'env:SPACE_TEST_TD1_MISSING_URL', schemaVersion: 'v1',
        },
      ]);
    });

    // Đồ thị service của nhịp quét — đúng ngăn xếp production,
    // handle inject là handle ĐỊNH TUYẾN của khung như module
    // worker gắn; handle kho chung THÔ gắn vào khung như factory
    // của module làm lúc khởi động.
    spaceDb = new SpaceDatabaseService({
      get: (key: string) =>
        ({
          CONTROL_PLANE_DATABASE_URL: clusterUrl(CP_DATABASE),
          SPACE_DB_POOL_MAX: 2,
          SPACE_DB_POOL_IDLE_TIMEOUT_MS: 60_000,
          SPACE_ROUTING_CACHE_TTL_MS: 60_000,
          DATABASE_SSL: false,
        })[key],
    } as unknown as ConfigService);
    sharedPool = new TenantAwarePool({ connectionString: process.env.DATABASE_URL! });
    const rawShared = drizzle({ client: sharedPool, relations });
    spaceDb.bindSharedDatabase(rawShared);
    spaceDb.bindSharedKysely(createCentreKysely(sharedPool));
    const routed = spaceDb.routedDatabase;

    const repo = new PaymentsRepository(routed as never);
    const writer = new OutboxWriterService(routed as never);
    const plans = new PlanEntitlementsService(repo);
    const enrolOutbox = new WorkerEnrolOutboxService(writer, spaceDb);
    const scope = new WorkerPaymentSpaceScope(routed, spaceDb);
    matching = new SepayMatchingService(
      repo,
      writer,
      new WorkerPaidEnrolActivationService(routed, enrolOutbox, scope),
      new WorkerPaidClassEnrolActivationService(routed, enrolOutbox, scope),
      plans,
      new WorkerPaymentSettlementService(routed, repo, plans, enrolOutbox, scope),
    );

    sharedPg = new Client({ connectionString: process.env.DATABASE_URL });
    await sharedPg.connect();
    centrePg = new Client({ connectionString: clusterUrl(CENTRE_DATABASE) });
    await centrePg.connect();

    // Khung dữ kiện của ba trung tâm: dòng thư mục của cả ba nằm
    // ở kho chung; khung nghiệp vụ nằm ở kho của từng trung tâm
    // (trung tâm kho chung và trung tâm lỗi: chính kho chung;
    // trung tâm kho riêng: kho riêng của nó).
    await seedDirectoryRow(centreTenantId, CENTRE_SLUG);
    centreFrame = await seedLocalFrame(centrePg, centreTenantId, CENTRE_SLUG);
    sharedFrame = await seedLocalFrame(sharedPg, sharedTenantId, SHARED_SLUG);
    brokenFrame = await seedLocalFrame(sharedPg, brokenTenantId, BROKEN_SLUG);

    // Tài khoản nhận tiền của ba tenant đều là dữ kiện kho chung.
    for (const [accountId, tenantId] of [
      [centreAccountId, centreTenantId],
      [sharedAccountId, sharedTenantId],
      [brokenAccountId, brokenTenantId],
    ] as const) {
      await sharedPg.query(
        'INSERT INTO payment_accounts (id, tenant_id, name, gateway, enabled) VALUES ($1, $2, $3, $4, true)',
        [accountId, tenantId, 'SePay td1', 'sepay'],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await sharedPg.end();
    await centrePg.end();
    await spaceDb.onModuleDestroy();
    await sharedPool.end().catch(() => undefined);
    delete process.env.SPACE_TEST_TD1_URL;
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
    });
  });

  it('enrol_fee của trung tâm kho riêng: ghi danh ACTIVE và outbox user_enrolled ở kho riêng, kho chung sạch, quét lại không nhân đôi', async () => {
    const buyer = await insertUser(centrePg);
    const { instanceId } = await makeFeeCourse(centrePg, centreFrame, centreTenantId);
    const { paymentId, code } = await makePayment({
      tenantId: centreTenantId, accountId: centreAccountId, userId: buyer,
      component: 'enrol_fee', itemId: instanceId,
    });
    const eventId = await makeCreditEvent({ tenantId: centreTenantId, accountId: centreAccountId, code });

    await sweepOnce();

    expect(await paymentStatus(paymentId)).toBe('succeeded');
    expect(await eventStatus(eventId)).toBe('matched');
    expect(await enrolmentStatus(centrePg, instanceId, buyer)).toBe(0);
    expect(await outboxCount(centrePg, 'user_enrolled', buyer)).toBe(1);
    // Kho chung không có ghi danh nào cho instance của kho riêng,
    // và outbox payment_succeeded vẫn phát ở kho chung (payment là
    // dữ kiện kho chung).
    expect(
      await countRows(sharedPg, 'SELECT count(*)::int AS c FROM user_enrolments WHERE enrol_id = $1 AND user_id = $2', [instanceId, buyer]),
    ).toBe(0);
    expect(
      await countRows(
        sharedPg,
        "SELECT count(*)::int AS c FROM outbox_events WHERE type = 'payment_succeeded' AND payload ->> 'paymentId' = $1",
        [paymentId],
      ),
    ).toBe(1);

    // Quét lại: sự kiện đã matched không được xử lý lần hai.
    await sweepOnce();
    expect(await enrolmentStatus(centrePg, instanceId, buyer)).toBe(0);
    expect(await outboxCount(centrePg, 'user_enrolled', buyer)).toBe(1);
  });

  it('enrol_fee của trung tâm kho chung: hành vi hiện tại giữ nguyên — succeeded và ghi danh ở kho chung', async () => {
    const buyer = await insertUser(sharedPg);
    const { instanceId } = await makeFeeCourse(sharedPg, sharedFrame, sharedTenantId);
    const { paymentId, code } = await makePayment({
      tenantId: sharedTenantId, accountId: sharedAccountId, userId: buyer,
      component: 'enrol_fee', itemId: instanceId,
    });
    const eventId = await makeCreditEvent({ tenantId: sharedTenantId, accountId: sharedAccountId, code });

    await sweepOnce();

    expect(await paymentStatus(paymentId)).toBe('succeeded');
    expect(await eventStatus(eventId)).toBe('matched');
    expect(await enrolmentStatus(sharedPg, instanceId, buyer)).toBe(0);
    expect(await outboxCount(sharedPg, 'user_enrolled', buyer)).toBe(1);
  });

  it('class_fee của trung tâm kho riêng: thành viên cohort, membership và cả hai outbox ở kho riêng, kho chung sạch', async () => {
    const buyer = await insertUser(centrePg);
    const { classId, cohortId } = await makeFeeClass(centrePg, centreFrame, centreTenantId, buyer);
    const { paymentId, code } = await makePayment({
      tenantId: centreTenantId, accountId: centreAccountId, userId: buyer,
      component: 'class_fee', itemId: classId,
    });
    const eventId = await makeCreditEvent({ tenantId: centreTenantId, accountId: centreAccountId, code });

    await sweepOnce();

    expect(await paymentStatus(paymentId)).toBe('succeeded');
    expect(await eventStatus(eventId)).toBe('matched');
    expect(
      await countRows(centrePg, 'SELECT count(*)::int AS c FROM cohort_members WHERE cohort_id = $1 AND user_id = $2', [cohortId, buyer]),
    ).toBe(1);
    expect(
      await countRows(centrePg, 'SELECT count(*)::int AS c FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [centreTenantId, buyer]),
    ).toBe(1);
    expect(await outboxCount(centrePg, 'cohort_member_added', buyer)).toBe(1);
    expect(await outboxCount(centrePg, 'class_member_joined', buyer)).toBe(1);
    expect(
      await countRows(sharedPg, 'SELECT count(*)::int AS c FROM cohort_members WHERE cohort_id = $1 AND user_id = $2', [cohortId, buyer]),
    ).toBe(0);
    expect(
      await countRows(sharedPg, 'SELECT count(*)::int AS c FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [centreTenantId, buyer]),
    ).toBe(0);
  });

  it('một nhịp gồm payment của cả hai trung tâm: mỗi payment kích hoạt ở đúng kho của trung tâm mình', async () => {
    const centreBuyer = await insertUser(centrePg);
    const centreCourse = await makeFeeCourse(centrePg, centreFrame, centreTenantId);
    const centrePayment = await makePayment({
      tenantId: centreTenantId, accountId: centreAccountId, userId: centreBuyer,
      component: 'enrol_fee', itemId: centreCourse.instanceId,
    });
    await makeCreditEvent({ tenantId: centreTenantId, accountId: centreAccountId, code: centrePayment.code });

    const sharedBuyer = await insertUser(sharedPg);
    const sharedCourse = await makeFeeCourse(sharedPg, sharedFrame, sharedTenantId);
    const sharedPayment = await makePayment({
      tenantId: sharedTenantId, accountId: sharedAccountId, userId: sharedBuyer,
      component: 'enrol_fee', itemId: sharedCourse.instanceId,
    });
    await makeCreditEvent({ tenantId: sharedTenantId, accountId: sharedAccountId, code: sharedPayment.code });

    await sweepOnce();

    expect(await paymentStatus(centrePayment.paymentId)).toBe('succeeded');
    expect(await paymentStatus(sharedPayment.paymentId)).toBe('succeeded');
    expect(await enrolmentStatus(centrePg, centreCourse.instanceId, centreBuyer)).toBe(0);
    expect(await enrolmentStatus(sharedPg, sharedCourse.instanceId, sharedBuyer)).toBe(0);
    expect(
      await countRows(sharedPg, 'SELECT count(*)::int AS c FROM user_enrolments WHERE enrol_id = $1 AND user_id = $2', [centreCourse.instanceId, centreBuyer]),
    ).toBe(0);
    expect(
      await countRows(centrePg, 'SELECT count(*)::int AS c FROM user_enrolments WHERE enrol_id = $1 AND user_id = $2', [sharedCourse.instanceId, sharedBuyer]),
    ).toBe(0);
  });

  it('trung tâm kho riêng mà bí mật kết nối không tồn tại: payment ở lại pending, không matched, không ghi danh ở bất kỳ kho nào', async () => {
    // Instance thu phí của payment nằm ở KHO CHUNG (kho của chính
    // trung tâm lỗi theo thư mục): nếu phân giải rơi về kho chung,
    // đối chiếu sẽ khớp và kích hoạt sẽ ghi bừa vào kho chung.
    const buyer = await insertUser(sharedPg);
    const { instanceId } = await makeFeeCourse(sharedPg, brokenFrame, brokenTenantId);
    const { paymentId, code } = await makePayment({
      tenantId: brokenTenantId, accountId: brokenAccountId, userId: buyer,
      component: 'enrol_fee', itemId: instanceId,
    });
    const eventId = await makeCreditEvent({ tenantId: brokenTenantId, accountId: brokenAccountId, code });

    await sweepOnce();

    expect(await paymentStatus(paymentId)).toBe('pending');
    expect(await eventStatus(eventId)).not.toBe('matched');
    expect(await enrolmentStatus(sharedPg, instanceId, buyer)).toBeUndefined();
    expect(await outboxCount(sharedPg, 'user_enrolled', buyer)).toBe(0);
  });
});
