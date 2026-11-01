/**
 * Spec tích hợp của khung Kysely phía `apps/api`: chứng minh trên
 * database trung tâm dựng từ rỗng bằng harness của `@lms/db` rằng
 * handle Kysely đi qua `TenantAwarePool` THẬT của hệ (không phải
 * bản phục vụ test trong package) vẫn giữ đúng hợp đồng GUC/RLS,
 * và wiring NestJS tự dựng (`KyselyModule` + `@InjectKysely`) cấp
 * đúng handle cho service.
 *
 * Ba tính chất được kiểm chứng:
 *   (i)   Trong ngữ cảnh tenant (nạp qua `tenantAls` thật) chỉ
 *         thấy dòng của tenant đó; ngữ cảnh platform thấy mọi
 *         dòng; ngoài ngữ cảnh thì fail-closed.
 *   (ii)  Giao dịch qua handle `CentreTx` truyền vào repository
 *         mẫu: ném lỗi thì rollback sạch, hoàn tất thì ghi thật.
 *   (iii) `KyselyModule.forRoot(...)` inject đúng handle theo
 *         `@InjectKysely()` / `@InjectKysely('control-plane')`,
 *         handle kho trung tâm chạy được trên `TenantAwarePool`
 *         thật, và đóng module thì instance bị huỷ (pool đóng theo).
 *
 * Môi trường: kết nối quản trị lấy từ `LMS_TEST_DATABASE_URL` (ghi
 * đè chuẩn của suite api) hoặc `DATABASE_URL` do cấu hình Vitest
 * của api đặt, thay tên database thành `postgres`. Database và
 * role test dùng tên cố định dưới đây, được xoá/dựng lại mỗi lượt
 * chạy; role là role thường (không superuser) để RLS có hiệu lực.
 */
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb, type CentreTx } from '@lms/db';
import type { ControlPlaneDb } from '@lms/db/control-plane';
import {
  buildTestDatabase,
  dropTestDatabase,
  withDatabase,
} from '@lms/db/test-support';
import { InjectKysely } from '../../../src/db/inject-kysely';
import { KyselyModule } from '../../../src/db/kysely.module';
import { TenantAwarePool } from '../../../src/db/tenant-pool';
import { tenantAls } from '../../../src/modules/tenants/tenant-als';

const TEST_DATABASE = 'lms_api_kysely_foundation';
const TEST_ROLE = 'lms_api_kysely_foundation';
const TEST_ROLE_PASSWORD = 'lms_api_kysely_foundation_pw';

const baseUrl = process.env.LMS_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const adminUrl = baseUrl ? withDatabase(baseUrl, 'postgres') : undefined;

let pool: TenantAwarePool;
let db: CentreDb;
let tenantAId: string;
let tenantBId: string;

/** Repository mẫu: ghi một tenant — nhận handle thường hoặc handle giao dịch. */
async function createTenantRow(handle: CentreDb | CentreTx, slug: string): Promise<string> {
  const row = await handle
    .insertInto('tenants')
    .values({ slug, name: `Trung tâm ${slug}`, kind: 'centre' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Repository mẫu: liệt kê slug của mọi tenant mà handle hiện tại nhìn thấy. */
async function listVisibleTenantSlugs(handle: CentreDb | CentreTx): Promise<string[]> {
  const rows = await handle.selectFrom('tenants').select('slug').orderBy('slug').execute();
  return rows.map((row) => row.slug);
}

/** Service mẫu nhận handle Kysely qua decorator tự dựng của repo. */
@Injectable()
class KyselyHandleConsumer {
  constructor(
    @InjectKysely() readonly centre: CentreDb,
    @InjectKysely('control-plane') readonly controlPlane: ControlPlaneDb,
  ) {}
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error(
      'Thiếu kết nối quản trị cho spec khung Kysely: LMS_TEST_DATABASE_URL/DATABASE_URL chưa được đặt.',
    );
  }
  const adminStoreUrl = await buildTestDatabase({
    adminUrl,
    database: TEST_DATABASE,
    store: 'centre',
  });

  const admin = new Client({ connectionString: adminStoreUrl });
  await admin.connect();
  try {
    await admin.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TEST_ROLE}') THEN
           CREATE ROLE "${TEST_ROLE}" LOGIN NOSUPERUSER PASSWORD '${TEST_ROLE_PASSWORD}';
         END IF;
       END $$;`,
    );
    await admin.query(
      `ALTER ROLE "${TEST_ROLE}" WITH LOGIN NOSUPERUSER PASSWORD '${TEST_ROLE_PASSWORD}'`,
    );
    await admin.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${TEST_ROLE}"`);
    await admin.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${TEST_ROLE}"`);
  } finally {
    await admin.end();
  }

  const roleUrl = new URL(adminStoreUrl);
  roleUrl.username = TEST_ROLE;
  roleUrl.password = TEST_ROLE_PASSWORD;

  pool = new TenantAwarePool({ connectionString: roleUrl.toString() });
  db = createCentreKysely(pool);

  tenantAId = await tenantAls.run({ platform: true }, () => createTenantRow(db, 'n1-alpha'));
  tenantBId = await tenantAls.run({ platform: true }, () => createTenantRow(db, 'n1-beta'));
}, 180_000);

afterAll(async () => {
  await pool.end();
  if (adminUrl) {
    await dropTestDatabase(adminUrl, TEST_DATABASE);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS "${TEST_ROLE}"`);
    } finally {
      await admin.end();
    }
  }
}, 60_000);

describe('khung Kysely phía apps/api', () => {
  it('giữ đúng GUC/RLS qua TenantAwarePool thật: mỗi tenant chỉ thấy dòng của mình', async () => {
    await expect(
      tenantAls.run({ tenantId: tenantAId }, () => listVisibleTenantSlugs(db)),
    ).resolves.toEqual(['n1-alpha']);
    await expect(
      tenantAls.run({ tenantId: tenantBId }, () => listVisibleTenantSlugs(db)),
    ).resolves.toEqual(['n1-beta']);
  });

  it('thấy mọi dòng ở ngữ cảnh platform và fail-closed ngoài mọi ngữ cảnh, qua TenantAwarePool thật', async () => {
    await expect(
      tenantAls.run({ platform: true }, () => listVisibleTenantSlugs(db)),
    ).resolves.toEqual(['n1-alpha', 'n1-beta']);
    await expect(listVisibleTenantSlugs(db)).resolves.toEqual([]);
  });

  it('rollback sạch khi giao dịch qua handle CentreTx trên TenantAwarePool thật ném lỗi', async () => {
    await expect(
      tenantAls.run({ platform: true }, () =>
        db.transaction().execute(async (trx) => {
          await createTenantRow(trx, 'n1-rollback');
          throw new Error('rollback-marker');
        }),
      ),
    ).rejects.toThrow('rollback-marker');
    await expect(
      tenantAls.run({ platform: true }, () => listVisibleTenantSlugs(db)),
    ).resolves.toEqual(['n1-alpha', 'n1-beta']);
  });

  it('KyselyModule cấp đúng handle qua @InjectKysely và huỷ instance khi module đóng', async () => {
    // Mỗi kho một pool riêng, đúng hình dạng production (module sở
    // hữu và đóng pool của từng kho khi ứng dụng đóng).
    const modulePool = new TenantAwarePool({
      connectionString: pool.options.connectionString,
    });
    const moduleControlPlanePool = new TenantAwarePool({
      connectionString: pool.options.connectionString,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        KyselyModule.forRoot({ centre: modulePool, controlPlane: moduleControlPlanePool }),
      ],
      providers: [KyselyHandleConsumer],
    }).compile();

    const consumer = moduleRef.get(KyselyHandleConsumer);
    expect(consumer.centre).toBeDefined();
    expect(consumer.controlPlane).toBeDefined();
    expect(consumer.controlPlane).not.toBe(consumer.centre);
    // Handle kho trung tâm được inject chạy thật trên TenantAwarePool
    // và tôn trọng ngữ cảnh platform qua tenantAls.
    await expect(
      tenantAls.run({ platform: true }, () => listVisibleTenantSlugs(consumer.centre)),
    ).resolves.toEqual(['n1-alpha', 'n1-beta']);

    await moduleRef.close();
    // Đóng module huỷ instance Kysely, kéo theo pool của module đóng:
    // mọi truy vấn mới trên pool đó bị từ chối.
    await expect(modulePool.query('select 1')).rejects.toThrow();
  });
});
