/**
 * Ca tích hợp của FACADE KYSELY ĐỊNH TUYẾN phía API (issue #639):
 * chứng minh `routedKysely` của `SpaceDatabaseService` giữ đúng
 * hợp đồng của `routedDatabase` — và giữ đúng ngữ nghĩa Kysely —
 * qua Proxy uỷ thác theo ngữ cảnh ALS:
 *
 *   - `getKyselyForSpace` trả handle kho chung cho slug kho chung,
 *     handle kho riêng khác instance cho slug kho riêng, và cùng
 *     instance khi gọi lại (chuẩn bị có nhớ);
 *   - `routedKysely` đọc/ghi đúng kho theo `spaceSlug` trong ALS,
 *     ngoài ALS thì về kho chung, slug chưa chuẩn bị thì về kho
 *     chung (không ném);
 *   - `transaction()` qua facade commit và rollback đúng;
 *   - getter `schema` qua facade tạo/xoá bảng thăm dò được thật
 *     trên kho hiệu lực (không bị đóng băng vào handle lúc tạo
 *     facade);
 *   - builder lười qua facade chỉ thực thi khi `execute()`/await,
 *     nên dòng insert sau khi tạo builder vẫn được builder thấy;
 *   - slug đã chuẩn bị ở kho riêng mà pool bị thu hồi vì nhàn rỗi
 *     thì truy vấn qua facade trong ngữ cảnh cũ ném
 *     `space_routing.prepared_revoked` (fail-closed, không rơi im
 *     lặng về kho chung).
 *
 * Nếu bất kỳ điểm nào gãy, facade CHƯA được chứng minh và pilot
 * không được xây trên nó (issue #639 yêu cầu dừng và trình phương
 * án provider `current()` thay vì tự tuyên bố ngoại lệ).
 *
 * Môi trường: tự cấp phát control plane + hai kho riêng + một kho
 * đóng vai kho chung bằng harness của `@lms/db` (database dựng từ
 * rỗng bằng Migrator của package, không phụ thuộc database test
 * của CI). Chuỗi bí mật cố ý trỏ về database `postgres` để bộ
 * phân giải phải chốt đích theo `databaseName` trong sổ.
 */
import type { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '@lms/db';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '@lms/db/test-support';
import type { Database } from '../../../src/db/database';
import { relations } from '../../../src/db/relations';
import { SpaceRoutingError } from '../../../src/db/routing/space-connection-resolver';
import { SpaceDatabaseService } from '../../../src/db/routing/space-database.service';
import { TenantAwarePool } from '../../../src/db/tenant-pool';
import { ControlPlaneConnection } from '../../../src/modules/control-plane/control-plane.connection';
import { tenantAls } from '../../../src/modules/tenants/tenant-als';

const CP_DATABASE = 'lms_test_cp_639';
const SHARED_DATABASE = 'lms_test_shared_639';
const CENTRE_A_DATABASE = 'lms_test_centre_a_639';
const CENTRE_B_DATABASE = 'lms_test_centre_b_639';
const CENTRE_A_SLUG = 'trung-tam-a-639';
const CENTRE_B_SLUG = 'trung-tam-b-639';
const SHARED_SLUG = 'trang-chinh-639';
const TENANT_A_ID = '01963900-0000-7000-8000-0000000000a1';
const TENANT_B_ID = '01963900-0000-7000-8000-0000000000b2';
const TENANT_SHARED_ID = '01963900-0000-7000-8000-0000000000c3';
const TENANT_TX_COMMIT_ID = '01963900-0000-7000-8000-0000000000d4';
const TENANT_TX_ROLLBACK_ID = '01963900-0000-7000-8000-0000000000e5';
/**
 * Timeout nhàn rỗi của service chính — dài để sweeper không đóng
 * pool giữa các ca (mỗi ca tự chuẩn bị lại slug của mình trước
 * khi dùng facade, nhưng pool không được đóng giữa chừng). Ca
 * fail-closed dùng service riêng với timeout ngắn (xem cuối file).
 */
const POOL_IDLE_TIMEOUT_MS = 300_000;
/** Timeout nhàn rỗi của service riêng cho ca fail-closed (mẫu của ca #581). */
const SHORT_IDLE_TIMEOUT_MS = 600;

const baseUrl = process.env.LMS_TEST_DATABASE_URL ?? process.env.DATABASE_URL!;
const adminUrl = withDatabase(baseUrl, 'postgres');
const adminUser = decodeURIComponent(new URL(baseUrl).username);

function clusterUrl(database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function fakeConfig(values: Record<string, unknown>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

async function rowsIn(dbUrl: string, id: string): Promise<number> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const result = await client.query('SELECT 1 FROM tenants WHERE id = $1', [id]);
    return result.rows.length;
  } finally {
    await client.end();
  }
}

describe('Facade Kysely định tuyến phía API (integration)', () => {
  let service: SpaceDatabaseService;
  let controlPlane: ControlPlaneConnection;
  let sharedPool: TenantAwarePool;
  let sharedDb: Database;
  let sharedKysely: CentreDb;
  let sharedUrl = '';
  let centreAUrl = '';
  let centreBUrl = '';

  beforeAll(async () => {
    sharedUrl = await buildTestDatabase({ adminUrl, database: SHARED_DATABASE, store: 'centre' });
    centreAUrl = await buildTestDatabase({ adminUrl, database: CENTRE_A_DATABASE, store: 'centre' });
    centreBUrl = await buildTestDatabase({ adminUrl, database: CENTRE_B_DATABASE, store: 'centre' });
    const cpUrl = await buildTestDatabase({ adminUrl, database: CP_DATABASE, store: 'control-plane' });
    process.env.SPACE_TEST_SHARED_639_URL = clusterUrl('postgres');
    process.env.SPACE_TEST_A_639_URL = clusterUrl('postgres');
    process.env.SPACE_TEST_B_639_URL = clusterUrl('postgres');

    controlPlane = new ControlPlaneConnection(
      fakeConfig({ CONTROL_PLANE_DATABASE_URL: cpUrl, DATABASE_SSL: false }),
    );
    if (!controlPlane.kysely) throw new Error('Control plane chưa được cấu hình trong ca kiểm chứng');
    await controlPlane.kysely.insertInto('space_registry').values([
      {
        slug: CENTRE_A_SLUG, name: 'Trung tâm A 639', kind: 'center', status: 'active',
        database_name: CENTRE_A_DATABASE, storage_mode: 'dedicated',
        connection_role_ref: adminUser, secret_ref: 'env:SPACE_TEST_A_639_URL', schema_version: 'v1',
      },
      {
        slug: CENTRE_B_SLUG, name: 'Trung tâm B 639', kind: 'center', status: 'active',
        database_name: CENTRE_B_DATABASE, storage_mode: 'dedicated',
        connection_role_ref: adminUser, secret_ref: 'env:SPACE_TEST_B_639_URL', schema_version: 'v1',
      },
      {
        slug: SHARED_SLUG, name: 'Trang chính 639', kind: 'platform', status: 'active',
        database_name: SHARED_DATABASE, storage_mode: 'shared',
        connection_role_ref: adminUser, secret_ref: 'env:SPACE_TEST_SHARED_639_URL', schema_version: 'v1',
      },
    ]).execute();

    service = new SpaceDatabaseService(
      fakeConfig({
        SPACE_DB_POOL_MAX: 2,
        SPACE_DB_POOL_IDLE_TIMEOUT_MS: POOL_IDLE_TIMEOUT_MS,
        SPACE_ROUTING_CACHE_TTL_MS: 60_000,
        DATABASE_SSL: false,
      }),
      controlPlane,
    );
    sharedPool = new TenantAwarePool({ connectionString: sharedUrl });
    sharedDb = drizzle({ client: sharedPool, relations });
    sharedKysely = createCentreKysely(sharedPool);
    service.bindSharedDatabase(sharedDb);
    service.bindSharedKysely(sharedKysely);
  }, 180_000);

  afterAll(async () => {
    await service.onModuleDestroy();
    await sharedPool.end().catch(() => undefined);
    await controlPlane.onModuleDestroy();
    delete process.env.SPACE_TEST_SHARED_639_URL;
    delete process.env.SPACE_TEST_A_639_URL;
    delete process.env.SPACE_TEST_B_639_URL;
    for (const database of [CP_DATABASE, SHARED_DATABASE, CENTRE_A_DATABASE, CENTRE_B_DATABASE]) {
      await dropTestDatabase(adminUrl, database).catch(() => undefined);
    }
  });

  it('getKyselyForSpace trả đúng instance theo chế độ kho và nhớ lần chuẩn bị', async () => {
    const shared = await service.getKyselyForSpace(SHARED_SLUG);
    expect(shared).toBe(sharedKysely);
    const a = await service.getKyselyForSpace(CENTRE_A_SLUG);
    expect(a).not.toBe(sharedKysely);
    expect(await service.getKyselyForSpace(CENTRE_A_SLUG)).toBe(a);
    const b = await service.getKyselyForSpace(CENTRE_B_SLUG);
    expect(b).not.toBe(a);
    expect(b).not.toBe(sharedKysely);
  });

  it('routedKysely ghi/đọc đúng kho theo spaceSlug trong ALS, ngoài ALS về kho chung', async () => {
    await service.getKyselyForSpace(CENTRE_A_SLUG);
    await tenantAls.run({ spaceSlug: CENTRE_A_SLUG }, async () => {
      await service.routedKysely
        .insertInto('tenants')
        .values({ id: TENANT_A_ID, slug: CENTRE_A_SLUG, name: 'Trung tâm A 639', kind: 'center' })
        .execute();
      const rows = await service.routedKysely
        .selectFrom('tenants')
        .selectAll()
        .where('id', '=', TENANT_A_ID)
        .execute();
      expect(rows).toHaveLength(1);
    });
    expect(await rowsIn(centreAUrl, TENANT_A_ID)).toBe(1);
    expect(await rowsIn(sharedUrl, TENANT_A_ID)).toBe(0);
    expect(await rowsIn(centreBUrl, TENANT_A_ID)).toBe(0);
    // Ngoài ALS: facade về kho chung.
    await service.routedKysely
      .insertInto('tenants')
      .values({ id: TENANT_SHARED_ID, slug: SHARED_SLUG, name: 'Trang chính 639', kind: 'platform' })
      .execute();
    expect(await rowsIn(sharedUrl, TENANT_SHARED_ID)).toBe(1);
    expect(await rowsIn(centreAUrl, TENANT_SHARED_ID)).toBe(0);
  });

  it('slug chưa chuẩn bị thì routedKysely rơi về kho chung chứ không ném', async () => {
    await tenantAls.run({ spaceSlug: 'slug-chua-chuan-bi-639' }, async () => {
      const rows = await service.routedKysely
        .selectFrom('tenants')
        .selectAll()
        .where('id', '=', TENANT_SHARED_ID)
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  it('transaction qua facade commit và rollback đúng trên kho hiệu lực', async () => {
    await service.getKyselyForSpace(CENTRE_B_SLUG);
    await tenantAls.run({ spaceSlug: CENTRE_B_SLUG }, async () => {
      await service.routedKysely.transaction().execute(async (trx) => {
        await trx
          .insertInto('tenants')
          .values({ id: TENANT_TX_COMMIT_ID, slug: CENTRE_B_SLUG, name: 'Trung tâm B 639', kind: 'center' })
          .execute();
      });
      await expect(
        service.routedKysely.transaction().execute(async (trx) => {
          await trx
            .insertInto('tenants')
            .values({ id: TENANT_TX_ROLLBACK_ID, slug: 'trung-tam-b-639-rollback', name: 'Trung tâm B 639', kind: 'center' })
            .execute();
          throw new Error('rollback co y');
        }),
      ).rejects.toThrow('rollback co y');
    });
    expect(await rowsIn(centreBUrl, TENANT_TX_COMMIT_ID)).toBe(1);
    expect(await rowsIn(centreBUrl, TENANT_TX_ROLLBACK_ID)).toBe(0);
    expect(await rowsIn(sharedUrl, TENANT_TX_COMMIT_ID)).toBe(0);
  });

  it('getter schema qua facade tạo bảng thăm dò trên đúng kho hiệu lực', async () => {
    await service.getKyselyForSpace(CENTRE_A_SLUG);
    await tenantAls.run({ spaceSlug: CENTRE_A_SLUG }, async () => {
      await service.routedKysely.schema.createTable('kysely_probe_639').addColumn('id', 'integer').execute();
    });
    const inA = new Client({ connectionString: centreAUrl });
    await inA.connect();
    try {
      const found = await inA.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'kysely_probe_639'",
      );
      expect(found.rows.length).toBe(1);
    } finally {
      await inA.end();
    }
    await tenantAls.run({ spaceSlug: CENTRE_A_SLUG }, async () => {
      await service.routedKysely.schema.dropTable('kysely_probe_639').execute();
    });
  });

  it('builder lười qua facade chỉ thực thi khi execute, thấy dòng insert sau khi tạo builder', async () => {
    await service.getKyselyForSpace(CENTRE_A_SLUG);
    await tenantAls.run({ spaceSlug: CENTRE_A_SLUG }, async () => {
      const pending = service.routedKysely
        .selectFrom('tenants')
        .selectAll()
        .where('id', '=', TENANT_B_ID);
      await service.routedKysely
        .insertInto('tenants')
        .values({ id: TENANT_B_ID, slug: 'trung-tam-a-639-builder', name: 'Trung tâm A 639', kind: 'center' })
        .execute();
      const rows = await pending.execute();
      expect(rows).toHaveLength(1);
    });
  });

  it('slug kho riêng bị thu hồi pool thì truy vấn trong ngữ cảnh cũ fail-closed', async () => {
    // Service riêng với timeout nhàn rỗi ngắn (mẫu của ca #581):
    // chuẩn bị slug, dùng một lần, chờ sweeper đóng pool, rồi truy
    // vấn lại trong ngữ cảnh còn mang slug cũ phải ném lỗi thu hồi
    // thay vì rơi im lặng về kho chung.
    const shortService = new SpaceDatabaseService(
      fakeConfig({
        SPACE_DB_POOL_MAX: 2,
        SPACE_DB_POOL_IDLE_TIMEOUT_MS: SHORT_IDLE_TIMEOUT_MS,
        SPACE_ROUTING_CACHE_TTL_MS: 60_000,
        DATABASE_SSL: false,
      }),
      controlPlane,
    );
    try {
      await shortService.getKyselyForSpace(CENTRE_B_SLUG);
      await tenantAls.run({ spaceSlug: CENTRE_B_SLUG }, async () => {
        await shortService.routedKysely.selectFrom('tenants').selectAll().limit(1).execute();
      });
      await new Promise((resolve) => setTimeout(resolve, SHORT_IDLE_TIMEOUT_MS + 2400));
      await tenantAls.run({ spaceSlug: CENTRE_B_SLUG }, async () => {
        // Mã lỗi nằm ở thuộc tính `code` của SpaceRoutingError (mẫu
        // khẳng định của ca #581), không nằm trong thông điệp.
        let readError: unknown;
        try {
          shortService.routedKysely.selectFrom('tenants');
        } catch (error) {
          readError = error;
        }
        expect((readError as SpaceRoutingError).code).toBe('space_routing.prepared_revoked');
      });
    } finally {
      await shortService.onModuleDestroy();
    }
  });
});
