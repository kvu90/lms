/**
 * Ca tích hợp của các wrapper Kysely TỐI THIỂU trong
 * `TenantDbService` (issue #639, mức pilot cần): `withTenantKysely`
 * / `withPlatformKysely` / `withCurrentKysely` phải giữ cùng ngữ
 * nghĩa transaction + GUC như bản Drizzle, nhưng chạy trên handle
 * Kysely định tuyến — và GIỮ `spaceSlug` của ngữ cảnh cha (điểm
 * khác biệt có chủ đích so với bản Drizzle, vốn thay toàn bộ store
 * ALS nên làm rơi slug định tuyến kho).
 *
 * Ca dựng `TenantDbService` trực tiếp với một `SpaceDatabaseService`
 * giả chỉ mang `routedKysely` thật (các wrapper Kysely chỉ dùng
 * đúng thuộc tính này của khung định tuyến) trên pool kho trung tâm
 * gắn ngữ cảnh tenant — đủ để chứng minh GUC/transaction mà không
 * cần dựng cả khung định tuyến.
 *
 * Môi trường: một database trung tâm dựng từ rỗng bằng harness của
 * `@lms/db`.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, sql as kyselySql, type CentreDb } from '@lms/db';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '@lms/db/test-support';
import type { Database } from '../../../src/db/database';
import { relations } from '../../../src/db/relations';
import { TenantAwarePool } from '../../../src/db/tenant-pool';
import type { SpaceDatabaseService } from '../../../src/db/routing/space-database.service';
import { tenantAls } from '../../../src/modules/tenants/tenant-als';
import { TenantContextService } from '../../../src/modules/tenants/tenant-context.service';
import { TenantDbService } from '../../../src/modules/tenants/tenant-db.service';

const TEST_DATABASE = 'lms_test_tenant_db_kysely_639';
const TENANT_ID = '01963900-0000-7000-8000-0000000000a1';
const ROW_COMMIT_ID = '01963900-0000-7000-8000-0000000000d4';
const ROW_ROLLBACK_ID = '01963900-0000-7000-8000-0000000000e5';

const baseUrl = process.env.LMS_TEST_DATABASE_URL ?? process.env.DATABASE_URL!;
const adminUrl = withDatabase(baseUrl, 'postgres');

async function currentSetting(db: CentreDb, key: string): Promise<string> {
  const rows = await kyselySql`select current_setting(${key}, true) as v`.execute(db);
  return (rows.rows[0] as { v: string } | undefined)?.v ?? '';
}

describe('Wrapper Kysely tối thiểu của TenantDbService (integration)', () => {
  let pool: TenantAwarePool;
  let kysely: CentreDb;
  let service: TenantDbService;
  let dbUrl = '';

  beforeAll(async () => {
    dbUrl = await buildTestDatabase({ adminUrl, database: TEST_DATABASE, store: 'centre' });
    pool = new TenantAwarePool({ connectionString: dbUrl });
    kysely = createCentreKysely(pool);
    const drizzleDb = drizzle({ client: pool, relations }) as Database;
    // Các wrapper Kysely chỉ đọc `spaceDb.routedKysely` — giả này
    // đủ, không cần khung định tuyến thật.
    const spaceDb = { routedKysely: kysely } as unknown as SpaceDatabaseService;
    service = new TenantDbService(drizzleDb, new TenantContextService(), spaceDb);
  }, 180_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await dropTestDatabase(adminUrl, TEST_DATABASE).catch(() => undefined);
  });

  it('withTenantKysely gắn GUC tenant và commit dữ kiện trong transaction', async () => {
    await service.withTenantKysely(TENANT_ID, async (trx) => {
      expect(await currentSetting(trx, 'app.tenant_id')).toBe(TENANT_ID);
      expect(await currentSetting(trx, 'app.platform')).toBe('off');
      await trx
        .insertInto('tenants')
        .values({ id: ROW_COMMIT_ID, slug: 'tenant-kysely-639', name: 'Tenant Kysely 639', kind: 'center' })
        .execute();
    });
    const rows = await kysely.selectFrom('tenants').selectAll().where('id', '=', ROW_COMMIT_ID).execute();
    expect(rows).toHaveLength(1);
  });

  it('withTenantKysely rollback khi callback ném lỗi', async () => {
    await expect(
      service.withTenantKysely(TENANT_ID, async (trx) => {
        await trx
          .insertInto('tenants')
          .values({ id: ROW_ROLLBACK_ID, slug: 'tenant-kysely-rb-639', name: 'Tenant Kysely RB 639', kind: 'center' })
          .execute();
        throw new Error('rollback co y');
      }),
    ).rejects.toThrow('rollback co y');
    const rows = await kysely.selectFrom('tenants').selectAll().where('id', '=', ROW_ROLLBACK_ID).execute();
    expect(rows).toHaveLength(0);
  });

  it('withPlatformKysely gắn cờ platform và withCurrentKysely điều phối theo ngữ cảnh', async () => {
    await service.withPlatformKysely(async (trx) => {
      expect(await currentSetting(trx, 'app.platform')).toBe('on');
    });
    await tenantAls.run({ tenantId: TENANT_ID }, async () => {
      await service.withCurrentKysely(async (trx) => {
        expect(await currentSetting(trx, 'app.tenant_id')).toBe(TENANT_ID);
      });
    });
    await tenantAls.run({ platform: true }, async () => {
      await service.withCurrentKysely(async (trx) => {
        expect(await currentSetting(trx, 'app.platform')).toBe('on');
      });
    });
  });

  it('wrapper Kysely giữ spaceSlug của ngữ cảnh cha (khác bản Drizzle)', async () => {
    await tenantAls.run({ spaceSlug: 'slug-cha-639', tenantId: TENANT_ID }, async () => {
      await service.withTenantKysely(TENANT_ID, async () => {
        expect(tenantAls.getStore()?.spaceSlug).toBe('slug-cha-639');
      });
      await service.withPlatformKysely(async () => {
        expect(tenantAls.getStore()?.spaceSlug).toBe('slug-cha-639');
      });
    });
  });
});
