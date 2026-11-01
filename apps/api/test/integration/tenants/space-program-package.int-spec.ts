import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spaceRegistry } from '@lms/db/control-plane';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createTestApp } from '../../support/identity-access-helpers';
import { SpaceProgramPackageService } from '../../../src/modules/tenants/space-program-package.service';
import { CENTRE_PROGRAM_PACKAGE_KEY } from '../../../src/modules/tenants/centre-provision';
import { PROGRAM_DUMP_VERSION } from '../../../src/modules/curriculum/program-dump';

/**
 * Ca tích hợp của BƯỚC CÀI GÓI YCCĐ VÀO KHO ĐÍCH (Phần A, issue
 * #587 — A5): gọi trực tiếp `SpaceProgramPackageService` (không qua
 * HTTP) với một trung tâm kiểm chứng ở kho riêng dựng riêng cho đợt
 * này — database mới trên cùng cụm test, baseline nghiệp vụ, sổ
 * đăng ký ở database control plane riêng. Sổ ghi nhận cài đặt nguồn
 * nằm ở kho chung (database nghiệp vụ test dùng chung của tầng
 * này); kho đích bắt đầu chưa có dữ kiện chương trình.
 *
 * Các ca khoá đúng yêu cầu A5:
 * (1) lượt đầu cài gói trung tâm bằng đúng cơ chế cài gói đã có
 *     (restore artifact dump khi kho đích chưa có dữ kiện chương
 *     trình), ghi dòng bản cài vào kho đích và chuyển sổ nguồn sang
 *     kho đích — trừ khoá gói trung tâm (dòng đích là căn cứ, không
 *     bị dòng nguồn ghi đè);
 * (2) chạy lại an toàn: lượt thứ hai không restore, không ghi lại
 *     dòng bản cài, không chuyển lại khoá đã có, bản cài sau lượt
 *     vẫn khớp phiên bản artifact hiện hành;
 * (3) trung tâm còn ở kho chung thì bước này từ chối fail-closed
 *     thay vì cài chồng lên kho chung.
 */
const CP_DATABASE = 'lms_test_cp_587b';
const CP_ROLE = 'lms_cp_test_587b';
const CP_PASSWORD = 'cp-test-587b';
const CENTRE_A_DATABASE = 'lms_test_centre_a_587b';
const CENTRE_A_ROLE = 'lms_centre_a_587b_app';
const CENTRE_A_PASSWORD = 'centre-a-test-587b';
const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const CENTRE_A_SLUG = `trung-tam-a-587b-${RUN_SUFFIX}`;
const SHARED_SLUG = `trung-tam-chung-587b-${RUN_SUFFIX}`;
const EXTRA_PACKAGE_KEY = `goi-phu-587b-${RUN_SUFFIX}`;
const TENANT_ID = randomUUID();

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

function clusterUrl(database: string, username?: string, secret?: string): string {
  const base = new URL(process.env.DATABASE_URL!);
  base.pathname = `/${database}`;
  if (username) base.username = username;
  if (secret) base.password = secret;
  return base.toString();
}

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

async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
  const outDir = join(__dirname, '..', '..', '..', 'drizzle-control-plane');
  const folders = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'), true);
  }
}

async function applyBusinessBaseline(connectionString: string): Promise<void> {
  const baseline = join(__dirname, '..', '..', '..', 'drizzle', '20261025163710_baseline', 'migration.sql');
  await applySqlFile(connectionString, baseline, true);
}

async function countSubjects(connectionString: string): Promise<number> {
  return withClient(connectionString, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query<{ count: string }>('SELECT count(*) FROM subjects');
    return Number(result.rows[0]!.count);
  });
}

async function listInstalls(connectionString: string): Promise<Array<{ packageKey: string; version: string; checksum: string }>> {
  return withClient(connectionString, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query<{ package_key: string; version: string; checksum: string }>(
      'SELECT package_key, version, checksum FROM program_package_installs WHERE tenant_id = $1 ORDER BY package_key',
      [TENANT_ID],
    );
    return result.rows.map((row) => ({ packageKey: row.package_key, version: row.version, checksum: row.checksum }));
  });
}

describe('Bước cài gói YCCĐ vào kho đích (tích hợp)', () => {
  let app: INestApplication;
  let service: SpaceProgramPackageService;
  const centreAUrl = () => clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD);

  beforeAll(async () => {
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_A_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_A_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
      await admin.query(`CREATE ROLE ${CP_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE_A_ROLE} LOGIN PASSWORD '${CENTRE_A_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${CP_DATABASE} OWNER ${CP_ROLE}`);
      await admin.query(`CREATE DATABASE ${CENTRE_A_DATABASE} OWNER ${CENTRE_A_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CP_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CP_DATABASE} TO ${CP_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CENTRE_A_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_A_DATABASE} TO ${CENTRE_A_ROLE}`);
    });
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD));
    await applyBusinessBaseline(centreAUrl());

    process.env.CONTROL_PLANE_DATABASE_URL = clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD);
    process.env.SPACE_TEST_A_587B_URL = clusterUrl('postgres', CENTRE_A_ROLE, CENTRE_A_PASSWORD);

    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      const cpDb = drizzle({ client });
      await cpDb.insert(spaceRegistry).values([
        {
          slug: CENTRE_A_SLUG,
          name: 'Trung tâm A 587b',
          kind: 'center',
          status: 'active',
          databaseName: CENTRE_A_DATABASE,
          storageMode: 'dedicated',
          connectionRoleRef: CENTRE_A_ROLE,
          secretRef: 'env:SPACE_TEST_A_587B_URL',
          schemaVersion: 'v1',
        },
        {
          slug: SHARED_SLUG,
          name: 'Trung tâm chung 587b',
          kind: 'center',
          status: 'active',
          databaseName: 'lms_test_api',
          storageMode: 'shared',
          connectionRoleRef: 'postgres',
          secretRef: 'env:SPACE_TEST_A_587B_URL',
          schemaVersion: 'v1',
        },
      ]);
    });

    // Dòng tenant có ở cả hai kho (trạng thái sau di trú phần
    // tenant); sổ nguồn chỉ có ở kho chung.
    const tenantValues = [TENANT_ID, CENTRE_A_SLUG, 'Trung tâm A (spec 587b)', 'school', 'active'];
    await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query(
        'INSERT INTO tenants (id, slug, name, kind, status) VALUES ($1, $2, $3, $4, $5)',
        tenantValues,
      );
      await client.query(
        'INSERT INTO program_package_installs (tenant_id, package_key, version, checksum) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)',
        [TENANT_ID, EXTRA_PACKAGE_KEY, '1.0', 'checksum-goi-phu', CENTRE_PROGRAM_PACKAGE_KEY, '0.0-cu', 'checksum-cu'],
      );
    });
    await withClient(centreAUrl(), async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query(
        'INSERT INTO tenants (id, slug, name, kind, status) VALUES ($1, $2, $3, $4, $5)',
        tenantValues,
      );
    });

    app = await createTestApp();
    service = app.get(SpaceProgramPackageService);
  }, 300_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    delete process.env.SPACE_TEST_A_587B_URL;
    delete process.env.CONTROL_PLANE_DATABASE_URL;
    await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query('DELETE FROM program_package_installs WHERE tenant_id = $1', [TENANT_ID]);
      await client.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
    }).catch(() => undefined);
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_A_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_A_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
    }).catch(() => undefined);
  });

  it('lượt đầu cài gói trung tâm vào kho đích và chuyển sổ nguồn, trừ khoá gói trung tâm', async () => {
    const subjectsBefore = await countSubjects(centreAUrl());
    const report = await service.installIntoSpace(CENTRE_A_SLUG, TENANT_ID);
    expect(report.slug).toBe(CENTRE_A_SLUG);
    expect(report.tenantId).toBe(TENANT_ID);
    expect(report.targetInstallBefore).toBeNull();
    expect(report.restored).toBe(subjectsBefore === 0);
    expect(report.installRecorded).toBe(true);
    expect(report.transferredKeys).toContain(EXTRA_PACKAGE_KEY);
    expect(report.transferredKeys).not.toContain(CENTRE_PROGRAM_PACKAGE_KEY);
    expect(report.targetInstallAfter.packageKey).toBe(CENTRE_PROGRAM_PACKAGE_KEY);
    expect(report.targetInstallAfter.version).toBe(PROGRAM_DUMP_VERSION);
    expect(report.outcomeCounts.subjects).toBeGreaterThan(0);
    expect(report.sourceInstalls.map((row) => row.packageKey).sort()).toEqual(
      [EXTRA_PACKAGE_KEY, CENTRE_PROGRAM_PACKAGE_KEY].sort(),
    );
    const installs = await listInstalls(centreAUrl());
    expect(installs.find((row) => row.packageKey === EXTRA_PACKAGE_KEY)).toMatchObject({
      version: '1.0',
      checksum: 'checksum-goi-phu',
    });
    // Dòng gói trung tâm ở kho đích là bản vừa cài, không bị dòng
    // nguồn cũ ghi đè.
    expect(installs.find((row) => row.packageKey === CENTRE_PROGRAM_PACKAGE_KEY)).toMatchObject({
      version: PROGRAM_DUMP_VERSION,
    });
  });

  it('chạy lại an toàn: không restore, không ghi lại bản cài, không chuyển lại khoá đã có', async () => {
    const report = await service.installIntoSpace(CENTRE_A_SLUG, TENANT_ID);
    expect(report.restored).toBe(false);
    expect(report.installRecorded).toBe(false);
    expect(report.transferredKeys).toEqual([]);
    expect(report.targetInstallAfter.version).toBe(PROGRAM_DUMP_VERSION);
  });

  it('trung tâm còn ở kho chung thì bước cài từ chối fail-closed', async () => {
    await expect(service.installIntoSpace(SHARED_SLUG, TENANT_ID)).rejects.toThrow(/not dedicated/);
  });
});
