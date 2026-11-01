import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerModule } from '../../../src/worker.module';

/**
 * Đặc tả phân giải không gian theo từng payment ở nhịp quét matching
 * (tiền điều kiện Phần B của issue #587, hạng mục 2 — PR-TĐ1):
 * boot `WorkerModule` THẬT (không override handle Drizzle, để handle
 * định tuyến của khung theo trung tâm làm việc như production),
 * trung tâm ở kho riêng được cấp phát trên cùng cụm: kho riêng +
 * database control plane mang dòng đăng ký `dedicated` cho slug của
 * trung tâm. Payment + sự kiện provider nằm ở kho chung (bảng
 * payments không theo kho riêng); instance/lớp thu phí CHỈ nằm ở
 * kho riêng — không có ở kho chung.
 *
 * Các ca ghim đúng nghiệm thu §2.3 của đặc tả:
 *
 * 1. Instance ghi danh thu phí chỉ ở kho riêng → nhịp quét kích
 *    hoạt trong kho riêng, payment lật `succeeded`; kho chung
 *    không nhận bất kỳ lượt ghi ghi danh nào.
 * 2. Lớp thu phí chỉ ở kho riêng → kích hoạt lớp + đảm bảo
 *    membership đều ghi trong kho riêng, không ghi kho chung.
 * 3. Một nhịp quét chứa đồng thời payment của trung tâm kho chung
 *    và trung tâm kho riêng → mỗi payment kích hoạt đúng kho của nó.
 * 4. Fail-closed: kho đích chuẩn bị lỗi (bí mật chưa cấu hình) →
 *    kích hoạt lỗi tường minh, payment ở lại `pending`, sự kiện ở
 *    lại `processing` để nhịp sau thử lại; kho chung không nhận
 *    lượt ghi nào.
 *
 * Tính chất kiểm chứng đột biến: instance/lớp chỉ tồn tại ở kho
 * riêng nên nếu gỡ bỏ bước phân giải không gian, kích hoạt đọc kho
 * chung sẽ ném `instance_not_found`/`class.not_found` và payment
 * không bao giờ về `succeeded` — các ca 1–3 đỏ.
 *
 * Cách cấp phát (theo khuôn spec tích hợp khung định tuyến của API,
 * issue #581): database kho riêng + database control plane được tạo
 * mới trên cùng cụm với database test của suite, áp đúng file
 * migration đã sinh trong repo (baseline nghiệp vụ cho kho riêng,
 * bộ migration control plane cho sổ đăng ký). Role kết nối của kho
 * riêng là role quản trị của suite — mục đích của spec là vị trí
 * vật lý của lượt ghi (kho nào), không phải phân quyền role (đã có
 * spec khung định tuyến ghim); vì vậy module chạy bằng superuser
 * như suite mặc định, không dùng harness role thường.
 *
 * Database test của suite (`lms_test_worker`) do bước migrate của
 * CI/local chuẩn bị trước như mọi spec tích hợp worker khác; spec
 * này chỉ tự cấp phát thêm hai database riêng của nó và dọn bằng
 * cách tạo lại ở lần chạy sau (DROP + CREATE trong `beforeAll`).
 */
describe('Nhịp quét matching SePay — phân giải không gian theo từng payment', () => {
  const tag = randomUUID().slice(0, 8);
  const SPACE_DATABASE = 'lms_test_worker_space_td1';
  const CP_DATABASE = 'lms_test_worker_cp_td1';
  const SPACE_SLUG = `trung-tam-td1-${tag}`;
  const BROKEN_SLUG = `trung-tam-td1-hong-${tag}`;
  const SPACE_SECRET_VAR = 'LMS_TD1_SPACE_URL';

  const uid = () => randomUUID();

  let context: INestApplicationContext;
  /** Kết nối quản trị kho chung (nạp fixture + đọc kiểm chứng phía kho chung). */
  let shared: Client;
  /** Kết nối quản trị kho riêng (nạp fixture + đọc kiểm chứng phía kho riêng). */
  let space: Client;
  let savedEnv: Record<string, string | undefined>;

  let dedicatedTenantId = '';
  let sharedTenantId = '';
  let dedicatedTenantCtxId = '';
  let dedicatedSystemCtxId = '';
  let sharedTenantCtxId = '';
  let sharedSystemCtxId = '';
  let categoryId = '';
  let studentRoleId = '';
  let dedicatedAccountId = '';
  let sharedAccountId = '';

  /**
   * Gốc kết nối của cụm: mặc định lấy từ `DATABASE_URL` của suite
   * (CI: cụm localhost:5432); chạy local có thể trỏ sang cụm khác
   * qua `LMS_TD1_CLUSTER_URL` (ví dụ cụm 5435 đang chạy sẵn) — khi
   * đó database test của suite cũng là database riêng của spec
   * (`LMS_TD1_SHARED_DB`, mặc định `lms_test_worker_prtd1`) để
   * không chạm database của đội khác trên cùng cụm.
   */
  let clusterBase = '';
  let sharedDatabase = '';

  /** URL tới một database trên cùng cụm với database test của suite. */
  function clusterUrl(database: string): string {
    const base = new URL(clusterBase);
    base.pathname = `/${database}`;
    return base.toString();
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

  /** Áp một file migration SQL (tách theo dấu phân đoạn của Drizzle) lên một database. */
  async function applySqlFile(connectionString: string, filePath: string): Promise<void> {
    await withClient(connectionString, async (client) => {
      const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
      if (Number(version.rows[0]!.server_version_num) < 180000) {
        // Cụm local chạy PG16: shim uuidv7() như spec khung định tuyến của API.
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query(`CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`);
      }
      const sql = readFileSync(filePath, 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed) await client.query(trimmed);
      }
    });
  }

  /** Áp baseline nghiệp vụ (file migration duy nhất của kho nghiệp vụ) vào kho riêng. */
  async function applyBusinessBaseline(connectionString: string): Promise<void> {
    const outDir = join(__dirname, '..', '..', '..', '..', 'api', 'drizzle');
    const folders = readdirSync(outDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const folder of folders) {
      await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'));
    }
  }

  /** Áp bộ migration control plane từ rỗng vào database sổ đăng ký. */
  async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
    const outDir = join(__dirname, '..', '..', '..', '..', 'api', 'drizzle-control-plane');
    const folders = readdirSync(outDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const folder of folders) {
      await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'));
    }
  }

  async function insertUser(client: Client, prefix: string): Promise<string> {
    const id = uid();
    const short = id.replaceAll('-', '').slice(0, 12);
    await client.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [id, `${prefix}_${short}`, `${prefix}_${short}@example.test`]);
    return id;
  }

  /** Đồ thị khoá + instance thu phí cho trung tâm ở KHO RIÊNG (chỉ ghi vào kho riêng). */
  async function makeDedicatedFeeCourse(): Promise<{ courseId: string; instanceId: string }> {
    const courseId = uid();
    const courseCtxId = uid();
    const instanceId = uid();
    await space.query(
      'INSERT INTO course (id, tenant_id, category, full_name, short_name, is_template) VALUES ($1, $2, $3, $4, $5, true)',
      [courseId, dedicatedTenantId, categoryId, 'Khoá kho riêng TD1', `TD1-${courseId.slice(0, 8)}`],
    );
    await space.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 50, $2, $3, 3)', [
      courseCtxId, courseId, `/${dedicatedSystemCtxId}/${dedicatedTenantCtxId}/${courseCtxId}`,
    ]);
    await space.query(
      `INSERT INTO enrol (id, course_id, enrol, status, role_id, cost, currency)
       VALUES ($1, $2, 'fee', 0, $3, 100000, 'VND')`,
      [instanceId, courseId, studentRoleId],
    );
    return { courseId, instanceId };
  }

  /** Đồ thị khoá + instance thu phí cho trung tâm ở KHO CHUNG (chỉ ghi vào kho chung). */
  async function makeSharedFeeCourse(): Promise<{ instanceId: string }> {
    const courseId = uid();
    const courseCtxId = uid();
    const instanceId = uid();
    await shared.query(
      'INSERT INTO course (id, tenant_id, category, full_name, short_name, is_template) VALUES ($1, $2, $3, $4, $5, true)',
      [courseId, sharedTenantId, categoryId, 'Khoá kho chung TD1', `TD1S-${courseId.slice(0, 8)}`],
    );
    await shared.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 50, $2, $3, 3)', [
      courseCtxId, courseId, `/${sharedSystemCtxId}/${sharedTenantCtxId}/${courseCtxId}`,
    ]);
    await shared.query(
      `INSERT INTO enrol (id, course_id, enrol, status, role_id, cost, currency)
       VALUES ($1, $2, 'fee', 0, $3, 100000, 'VND')`,
      [instanceId, courseId, studentRoleId],
    );
    return { instanceId };
  }

  /** Lớp thu phí kèm backing cohort cho trung tâm ở KHO RIÊNG (không có khoá nào trỏ tới). */
  async function makeDedicatedFeeClass(ownerId: string): Promise<{ classId: string; cohortId: string }> {
    const classId = uid();
    const cohortId = uid();
    const classCtxId = uid();
    await space.query(
      'INSERT INTO cohort (id, tenant_id, name, id_number, description, context_id, component, visible) VALUES ($1, $2, $3, $4, $5, $6, $7, true)',
      [cohortId, dedicatedTenantId, 'Cohort kho riêng TD1', '', '', classCtxId, ''],
    );
    await space.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 45, $2, $3, 4)', [
      classCtxId, classId, `/${dedicatedSystemCtxId}/${dedicatedTenantCtxId}/${classCtxId}`,
    ]);
    await space.query(
      "INSERT INTO classes (id, tenant_id, name, owner_id, cohort_id, status, fee_cost) VALUES ($1, $2, $3, $4, $5, 'active', 100000)",
      [classId, dedicatedTenantId, 'Lớp kho riêng TD1', ownerId, cohortId],
    );
    return { classId, cohortId };
  }

  /** Payment + sự kiện provider ở KHO CHUNG (bảng payments không theo kho riêng). */
  async function makePaymentAndEvent(
    tenantId: string,
    accountId: string,
    buyerId: string,
    component: 'enrol_fee' | 'class_fee',
    itemId: string,
  ): Promise<{ paymentId: string; eventId: string }> {
    const paymentId = uid();
    const code = `LMS${tag.toUpperCase()}${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    await shared.query(
      `INSERT INTO payments (id, account_id, tenant_id, user_id, amount, currency, status, gateway, component, item_id, payment_code)
       VALUES ($1, $2, $3, $4, 100000, 'VND', 'pending', 'sepay', $5, $6, $7)`,
      [paymentId, accountId, tenantId, buyerId, component, itemId, code],
    );
    const eventId = uid();
    await shared.query(
      `INSERT INTO payment_provider_events
         (id, provider, tenant_id, account_id, external_transaction_id, direction, amount, content, extracted_code, match_status, raw, received_at)
       VALUES ($1, 'sepay', $2, $3, $4, 'credit', 100000, 'hoc phi', $5, 'received', $6, $7)`,
      [
        eventId, tenantId, accountId, `sepay-tx-${randomUUID()}`,
        code, JSON.stringify({ reference_code: `FT${randomUUID().replaceAll('-', '').slice(0, 10)}` }),
        new Date(),
      ],
    );
    return { paymentId, eventId };
  }

  async function paymentStatus(paymentId: string): Promise<string | undefined> {
    const res = await shared.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    return (res.rows[0] as { status: string } | undefined)?.status;
  }

  async function eventStatus(eventId: string): Promise<{ match_status: string } | undefined> {
    const res = await shared.query('SELECT match_status FROM payment_provider_events WHERE id = $1', [eventId]);
    return res.rows[0] as { match_status: string } | undefined;
  }

  async function countIn(client: Client, table: string, where: string, params: unknown[]): Promise<number> {
    const res = await client.query(`SELECT count(*)::int AS c FROM ${table} WHERE ${where}`, params);
    return (res.rows[0] as { c: number }).c;
  }

  /** Chờ một điều kiện đúng, thăm dò mỗi 250 ms như các spec payments khác. */
  async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`chờ quá hạn: ${label}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  beforeAll(async () => {
    savedEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      CONTROL_PLANE_DATABASE_URL: process.env.CONTROL_PLANE_DATABASE_URL,
      [SPACE_SECRET_VAR]: process.env[SPACE_SECRET_VAR],
    };

    // Gốc cụm + database kho chung của lần chạy này (xem ghi chú ở `clusterBase`).
    const overrideBase = process.env.LMS_TD1_CLUSTER_URL;
    clusterBase = overrideBase ?? process.env.DATABASE_URL!;
    sharedDatabase = overrideBase
      ? (process.env.LMS_TD1_SHARED_DB ?? 'lms_test_worker_prtd1')
      : decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, ''));
    // Module boot và fixture đều đọc `DATABASE_URL`: trỏ nó về database kho chung của lần chạy.
    process.env.DATABASE_URL = clusterUrl(sharedDatabase);

    // Cấp phát kho riêng + sổ đăng ký trên cùng cụm với database test của suite.
    await withClient(clusterUrl('postgres'), async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${SPACE_DATABASE}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS "${CP_DATABASE}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${SPACE_DATABASE}"`);
      await admin.query(`CREATE DATABASE "${CP_DATABASE}"`);
      if (overrideBase) {
        // Chạy local qua cụm override: database kho chung cũng là của riêng spec → tạo + migrate từ trống.
        await admin.query(`DROP DATABASE IF EXISTS "${sharedDatabase}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${sharedDatabase}"`);
      }
    });
    if (overrideBase) {
      await applyBusinessBaseline(clusterUrl(sharedDatabase));
    }
    await applyBusinessBaseline(clusterUrl(SPACE_DATABASE));
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE));

    const adminUser = decodeURIComponent(new URL(process.env.DATABASE_URL!).username);
    // Bí mật của kho riêng cố ý trỏ về database mặc định `postgres`:
    // đích cuối phải do SỔ chốt (databaseName), không do chuỗi bí mật.
    process.env[SPACE_SECRET_VAR] = clusterUrl('postgres');
    process.env.CONTROL_PLANE_DATABASE_URL = clusterUrl(CP_DATABASE);
    await withClient(clusterUrl(CP_DATABASE), async (cp) => {
      await cp.query(
        `INSERT INTO space_registry (id, slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref, schema_version)
         VALUES ($1, $2, $3, 'center', 'active', $4, 'dedicated', $5, $6, 'v1')`,
        [uid(), SPACE_SLUG, 'Trung tâm kho riêng TD1', SPACE_DATABASE, adminUser, `env:${SPACE_SECRET_VAR}`],
      );
      // Kho đích chuẩn bị lỗi: dòng đăng ký trỏ bí mật tới biến môi trường chưa đặt.
      // Tên database khác dòng trên vì sổ cấm hai dòng kho riêng cùng databaseName;
      // lỗi xảy ra ở bước giải bí mật, trước cả khi chạm tới database này.
      await cp.query(
        `INSERT INTO space_registry (id, slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref, schema_version)
         VALUES ($1, $2, $3, 'center', 'active', $4, 'dedicated', $5, 'env:LMS_TD1_SPACE_URL_CHUA_DAT', 'v1')`,
        [uid(), BROKEN_SLUG, 'Trung tâm kho hỏng TD1', `${SPACE_DATABASE}_hong`, adminUser],
      );
    });

    shared = new Client({ connectionString: process.env.DATABASE_URL });
    await shared.connect();
    space = new Client({ connectionString: clusterUrl(SPACE_DATABASE) });
    await space.connect();

    dedicatedTenantId = uid();
    sharedTenantId = uid();
    dedicatedTenantCtxId = uid();
    dedicatedSystemCtxId = uid();
    sharedTenantCtxId = uid();
    sharedSystemCtxId = uid();
    categoryId = uid();
    studentRoleId = uid();
    dedicatedAccountId = uid();
    sharedAccountId = uid();

    // Dòng thư mục tenant ở KHO CHUNG cho cả hai trung tâm (ánh xạ
    // tenantId → slug mà điểm phân giải đọc; đợt di trú giữ ánh xạ
    // này tra được sau khi lật định tuyến).
    await shared.query('INSERT INTO tenants (id, slug, name, kind) VALUES ($1, $2, $3, $4)', [
      dedicatedTenantId, SPACE_SLUG, 'Trung tâm kho riêng TD1', 'center',
    ]);
    await shared.query('INSERT INTO tenants (id, slug, name, kind) VALUES ($1, $2, $3, $4)', [
      sharedTenantId, `trung-tam-td1-chung-${tag}`, 'Trung tâm kho chung TD1', 'center',
    ]);
    // Dòng tenant gương trong KHO RIÊNG (dữ kiện nghiệp vụ của trung tâm đã chuyển).
    await space.query('INSERT INTO tenants (id, slug, name, kind) VALUES ($1, $2, $3, $4)', [
      dedicatedTenantId, SPACE_SLUG, 'Trung tâm kho riêng TD1', 'center',
    ]);
    // Cây context + danh mục + vai dùng chung cho cả hai kho (mỗi kho giữ bản của nó).
    for (const client of [shared, space]) {
      await client.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 10, NULL, $2, 1)', [
        client === shared ? sharedSystemCtxId : dedicatedSystemCtxId,
        client === shared ? `/${sharedSystemCtxId}` : `/${dedicatedSystemCtxId}`,
      ]);
    }
    await shared.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 20, $2, $3, 2)', [
      sharedTenantCtxId, sharedTenantId, `/${sharedSystemCtxId}/${sharedTenantCtxId}`,
    ]);
    await space.query('INSERT INTO context (id, context_level, instance_id, path, depth) VALUES ($1, 20, $2, $3, 2)', [
      dedicatedTenantCtxId, dedicatedTenantId, `/${dedicatedSystemCtxId}/${dedicatedTenantCtxId}`,
    ]);
    await shared.query('INSERT INTO course_categories (id, tenant_id, name) VALUES ($1, $2, $3)', [
      categoryId, sharedTenantId, 'Danh mục TD1 chung',
    ]);
    await space.query('INSERT INTO course_categories (id, tenant_id, name) VALUES ($1, $2, $3)', [
      categoryId, dedicatedTenantId, 'Danh mục TD1 riêng',
    ]);
    // Tên/short_name vai theo tag của lần chạy: bảng role là toàn cục,
    // database kho chung tồn tại qua nhiều lần chạy nên giá trị cố định sẽ đụng unique.
    await shared.query('INSERT INTO role (id, name, short_name, archetype) VALUES ($1, $2, $3, \'student\')', [studentRoleId, `Student TD1 ${tag}`, `td1${tag}`]);
    await space.query('INSERT INTO role (id, name, short_name, archetype) VALUES ($1, $2, $3, \'student\')', [studentRoleId, `Student TD1 ${tag}`, `td1${tag}`]);
    await shared.query('INSERT INTO payment_accounts (id, tenant_id, name, gateway, enabled) VALUES ($1, $2, $3, $4, true)', [
      sharedAccountId, sharedTenantId, 'SePay TD1 chung', 'sepay',
    ]);
    // Tài khoản của trung tâm kho riêng cũng có dòng ở KHO CHUNG:
    // payment nằm ở kho chung và `payments.account_id` khoá ngoại
    // tới `payment_accounts` của chính kho đó.
    await shared.query('INSERT INTO payment_accounts (id, tenant_id, name, gateway, enabled) VALUES ($1, $2, $3, $4, true)', [
      dedicatedAccountId, dedicatedTenantId, 'SePay TD1 riêng', 'sepay',
    ]);
    await space.query('INSERT INTO payment_accounts (id, tenant_id, name, gateway, enabled) VALUES ($1, $2, $3, $4, true)', [
      dedicatedAccountId, dedicatedTenantId, 'SePay TD1 riêng', 'sepay',
    ]);

    // Boot module THẬT (không override handle Drizzle): handle định
    // tuyến của khung mới là đường mà kích hoạt đi qua ở production.
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    context = moduleRef;
    await context.init();
  }, 180_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await shared?.end().catch(() => undefined);
    await space?.end().catch(() => undefined);
    if (savedEnv.DATABASE_URL !== undefined) process.env.DATABASE_URL = savedEnv.DATABASE_URL;
    if (savedEnv.CONTROL_PLANE_DATABASE_URL === undefined) delete process.env.CONTROL_PLANE_DATABASE_URL;
    else process.env.CONTROL_PLANE_DATABASE_URL = savedEnv.CONTROL_PLANE_DATABASE_URL;
    if (savedEnv[SPACE_SECRET_VAR] === undefined) delete process.env[SPACE_SECRET_VAR];
    else process.env[SPACE_SECRET_VAR] = savedEnv[SPACE_SECRET_VAR];
  });

  it('instance ghi danh thu phí chỉ ở kho riêng → nhịp quét kích hoạt trong kho riêng, payment về succeeded, kho chung không nhận ghi danh', async () => {
    const buyer = await insertUser(shared, 'td1a');
    await space.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [buyer, `td1a_${buyer.replaceAll('-', '').slice(0, 12)}`, `td1a_${buyer.replaceAll('-', '').slice(0, 12)}@example.test`]);
    const { instanceId } = await makeDedicatedFeeCourse();
    const { paymentId } = await makePaymentAndEvent(dedicatedTenantId, dedicatedAccountId, buyer, 'enrol_fee', instanceId);

    await waitFor(async () => (await paymentStatus(paymentId)) === 'succeeded', 'payment kho riêng về succeeded');

    expect(await countIn(space, 'user_enrolments', 'enrol_id = $1 AND user_id = $2', [instanceId, buyer])).toBe(1);
    expect(await countIn(shared, 'user_enrolments', 'enrol_id = $1 AND user_id = $2', [instanceId, buyer])).toBe(0);
    expect(await countIn(shared, 'outbox_events', "type = 'payment_succeeded' AND payload ->> 'paymentId' = $1", [paymentId])).toBe(1);
  });

  it('lớp thu phí chỉ ở kho riêng → kích hoạt lớp + membership đều ghi trong kho riêng, kho chung không nhận gì', async () => {
    const buyer = await insertUser(shared, 'td1b');
    await space.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [buyer, `td1b_${buyer.replaceAll('-', '').slice(0, 12)}`, `td1b_${buyer.replaceAll('-', '').slice(0, 12)}@example.test`]);
    const { classId, cohortId } = await makeDedicatedFeeClass(buyer);
    const { paymentId } = await makePaymentAndEvent(dedicatedTenantId, dedicatedAccountId, buyer, 'class_fee', classId);

    await waitFor(async () => (await paymentStatus(paymentId)) === 'succeeded', 'payment lớp kho riêng về succeeded');

    expect(await countIn(space, 'cohort_members', 'cohort_id = $1 AND user_id = $2', [cohortId, buyer])).toBe(1);
    expect(await countIn(space, 'tenant_memberships', 'tenant_id = $1 AND user_id = $2 AND status = \'active\'', [dedicatedTenantId, buyer])).toBe(1);
    expect(await countIn(shared, 'cohort_members', 'cohort_id = $1 AND user_id = $2', [cohortId, buyer])).toBe(0);
    expect(await countIn(shared, 'tenant_memberships', 'tenant_id = $1 AND user_id = $2', [dedicatedTenantId, buyer])).toBe(0);
    expect(await countIn(space, 'outbox_events', "type = 'cohort_member_added' AND payload ->> 'userId' = $1", [buyer])).toBe(1);
  });

  it('một nhịp quét chứa payment kho chung và kho riêng → mỗi payment kích hoạt đúng kho của nó', async () => {
    const buyerShared = await insertUser(shared, 'td1c');
    const buyerDedicated = await insertUser(shared, 'td1d');
    await space.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [buyerDedicated, `td1d_${buyerDedicated.replaceAll('-', '').slice(0, 12)}`, `td1d_${buyerDedicated.replaceAll('-', '').slice(0, 12)}@example.test`]);
    const { instanceId: sharedInstanceId } = await makeSharedFeeCourse();
    const { instanceId: dedicatedInstanceId } = await makeDedicatedFeeCourse();
    const { paymentId: sharedPaymentId } = await makePaymentAndEvent(sharedTenantId, sharedAccountId, buyerShared, 'enrol_fee', sharedInstanceId);
    const { paymentId: dedicatedPaymentId } = await makePaymentAndEvent(dedicatedTenantId, dedicatedAccountId, buyerDedicated, 'enrol_fee', dedicatedInstanceId);

    await waitFor(async () =>
      (await paymentStatus(sharedPaymentId)) === 'succeeded' &&
      (await paymentStatus(dedicatedPaymentId)) === 'succeeded',
    'cả hai payment về succeeded');

    expect(await countIn(shared, 'user_enrolments', 'enrol_id = $1 AND user_id = $2', [sharedInstanceId, buyerShared])).toBe(1);
    expect(await countIn(space, 'user_enrolments', 'enrol_id = $1 AND user_id = $2', [dedicatedInstanceId, buyerDedicated])).toBe(1);
    expect(await countIn(shared, 'user_enrolments', 'enrol_id = $1 AND user_id = $2', [dedicatedInstanceId, buyerDedicated])).toBe(0);
    expect(await countIn(space, 'user_enrolments', 'enrol_id = $1 AND user_id = $2', [sharedInstanceId, buyerShared])).toBe(0);
  });

  it('kho đích chuẩn bị lỗi (bí mật chưa cấu hình) → kích hoạt lỗi, payment ở lại pending, kho chung không nhận ghi danh', async () => {
    const brokenTenantId = uid();
    await shared.query('INSERT INTO tenants (id, slug, name, kind) VALUES ($1, $2, $3, $4)', [
      brokenTenantId, BROKEN_SLUG, 'Trung tâm kho hỏng TD1', 'center',
    ]);
    const buyer = await insertUser(shared, 'td1e');
    const { paymentId, eventId } = await makePaymentAndEvent(brokenTenantId, sharedAccountId, buyer, 'enrol_fee', uid());

    // Vài nhịp quét chạy qua: payment phải ở yên pending (không
    // needs_review, không succeeded) và kho chung không nhận ghi danh.
    await new Promise((r) => setTimeout(r, 4000));
    expect(await paymentStatus(paymentId)).toBe('pending');
    expect((await eventStatus(eventId))?.match_status).toBe('processing');
    expect(await countIn(shared, 'user_enrolments', 'user_id = $1', [buyer])).toBe(0);
  });
});
