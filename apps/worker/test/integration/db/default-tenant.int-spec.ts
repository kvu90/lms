/**
 * Spec tích hợp của helper tenant mặc định phía worker
 * (`resolveDefaultTenantId`, issue #659) sau khi chuyển sang
 * Kysely: khoá luật TENANT-1 trên database trung tâm thật dựng từ
 * rỗng bằng cầu nối migration của `@lms/db`.
 *
 * Bối cảnh gọi thật: các processor nền (cấp huy hiệu, nhắc lịch,
 * báo cáo theo lịch) chạy helper này trong ngữ cảnh platform tường
 * minh để lấy tenant gắn cho notification phát sinh khi đối tượng
 * nguồn không thuộc tenant nào. Spec chạy mọi lượt gọi trong đúng
 * ngữ cảnh platform đó, qua pool gắn GUC như production và một role
 * không-siêu-quyền để RLS áp thật:
 * - membership active duy nhất → tenant của membership đó;
 * - thuộc cả tenant platform lẫn một trung tâm → trung tâm thắng
 *   (tenant platform chỉ là đích rơi cuối);
 * - không có membership → tenant platform;
 * - membership đã đình chỉ và tenant đã đình chỉ đều bị bỏ qua →
 *   rơi về tenant platform.
 *
 * Dữ kiện hạt giống ghi bằng client quản trị (bỏ qua RLS) để spec
 * chỉ đo hành vi ĐỌC của helper, không đo đường ghi.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CentreDb } from '@lms/db';
import {
  buildTestDatabase,
  createTestKysely,
  dropTestDatabase,
  runInTestPlatformContext,
  TestTenantPool,
  withDatabase,
} from '@lms/db/test-support';
import { resolveDefaultTenantId } from '../../../src/db/default-tenant';

const TEST_DATABASE = 'lms_test_w659_default_tenant';
const TEST_ROLE = 'lms_test_w659_role';
const TEST_ROLE_PASSWORD = 'lms_test_w659_password';

const baseUrl = process.env.LMS_TEST_DATABASE_URL ?? process.env.DATABASE_URL!;
const adminUrl = withDatabase(baseUrl, 'postgres');

const PLATFORM_TENANT_ID = randomUUID();
const CENTRE_TENANT_ID = randomUUID();
const SUSPENDED_TENANT_ID = randomUUID();
const USER_SINGLE_ID = randomUUID();
const USER_MULTI_ID = randomUUID();
const USER_NONE_ID = randomUUID();
const USER_FALLBACK_ID = randomUUID();

let tenantPool: TestTenantPool;
let db: CentreDb;

beforeAll(async () => {
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DATABASE, store: 'centre' });

  const admin = new Client({ connectionString: storeUrl });
  await admin.connect();
  try {
    await admin.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TEST_ROLE}') THEN
           CREATE ROLE "${TEST_ROLE}" LOGIN NOSUPERUSER PASSWORD '${TEST_ROLE_PASSWORD}';
         END IF;
       END $$;`,
    );
    await admin.query(`ALTER ROLE "${TEST_ROLE}" WITH LOGIN NOSUPERUSER PASSWORD '${TEST_ROLE_PASSWORD}'`);
    await admin.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${TEST_ROLE}"`);
    await admin.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${TEST_ROLE}"`);

    await admin.query(
      `INSERT INTO tenants (id, slug, name, kind, status) VALUES
         ($1, 'trang-chinh-w659', 'Trang chính W659', 'platform', 'active'),
         ($2, 'trung-tam-w659', 'Trung tâm W659', 'centre', 'active'),
         ($3, 'trung-tam-dinh-chi-w659', 'Trung tâm đình chỉ W659', 'centre', 'suspended')`,
      [PLATFORM_TENANT_ID, CENTRE_TENANT_ID, SUSPENDED_TENANT_ID],
    );
    await admin.query(
      `INSERT INTO users (id, email, username) VALUES
         ($1, 'w659-single@example.test', 'w659-single'),
         ($2, 'w659-multi@example.test', 'w659-multi'),
         ($3, 'w659-none@example.test', 'w659-none'),
         ($4, 'w659-fallback@example.test', 'w659-fallback')`,
      [USER_SINGLE_ID, USER_MULTI_ID, USER_NONE_ID, USER_FALLBACK_ID],
    );
    await admin.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, status) VALUES
         ($1, $2, 'active'),
         ($3, $4, 'active'),
         ($5, $4, 'active'),
         ($5, $6, 'suspended'),
         ($7, $6, 'active')`,
      [
        CENTRE_TENANT_ID, USER_SINGLE_ID,
        PLATFORM_TENANT_ID, USER_MULTI_ID,
        CENTRE_TENANT_ID,
        USER_FALLBACK_ID,
        SUSPENDED_TENANT_ID,
      ],
    );
  } finally {
    await admin.end();
  }

  const roleUrl = new URL(storeUrl);
  roleUrl.username = TEST_ROLE;
  roleUrl.password = TEST_ROLE_PASSWORD;
  tenantPool = new TestTenantPool({ connectionString: roleUrl.toString() });
  db = createTestKysely(tenantPool).centre;
}, 180_000);

afterAll(async () => {
  await tenantPool.end().catch(() => undefined);
  await dropTestDatabase(adminUrl, TEST_DATABASE).catch(() => undefined);
});

describe('resolveDefaultTenantId trên Kysely (integration)', () => {
  it('trả tenant của membership active duy nhất của user', async () => {
    const tenantId = await runInTestPlatformContext(() => resolveDefaultTenantId(db, USER_SINGLE_ID));
    expect(tenantId).toBe(CENTRE_TENANT_ID);
  });

  it('ưu tiên tenant trung tâm khi user thuộc cả tenant platform và một trung tâm', async () => {
    const tenantId = await runInTestPlatformContext(() => resolveDefaultTenantId(db, USER_MULTI_ID));
    expect(tenantId).toBe(CENTRE_TENANT_ID);
  });

  it('trả tenant platform khi user không có membership nào', async () => {
    const tenantId = await runInTestPlatformContext(() => resolveDefaultTenantId(db, USER_NONE_ID));
    expect(tenantId).toBe(PLATFORM_TENANT_ID);
  });

  it('bỏ qua membership đã đình chỉ và tenant đã đình chỉ rồi rơi về tenant platform', async () => {
    const tenantId = await runInTestPlatformContext(() => resolveDefaultTenantId(db, USER_FALLBACK_ID));
    expect(tenantId).toBe(PLATFORM_TENANT_ID);
  });
});
