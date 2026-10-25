import { afterAll, describe, expect, it } from 'vitest';
import { tenantAls } from '../modules/tenants/tenant-als';
import { TenantAwarePool } from './tenant-pool';

/**
 * TENANT-1 (issue #196), bước 2 của kế hoạch 6397026244: chứng minh SỐNG
 * đường đi của truy vấn qua `TenantAwarePool` TRƯỚC khi lật RLS
 * fail-closed. Điều kiện tiên quyết của fail-closed là MỌI truy vấn trên
 * pool dùng chung phải mang GUC của ngữ cảnh ALS hiện tại. Mã ứng dụng
 * (Drizzle) không checkout tường minh cho truy vấn thường — nó gọi
 * `pool.query(...)`, và pg hiện thực `Pool.query` bằng cách gọi nội bộ
 * `this.connect()`. Spec này khoá chặt cả hai đường:
 *
 *  - `pool.query` trong ngữ cảnh tenant/platform/ngoài ngữ cảnh đều
 *    thấy đúng GUC của ngữ cảnh đó (nếu `Pool.query` lách qua
 *    `connect()` đã override, GUC sẽ trống hoặc mang giá trị cũ);
 *  - `connect()` tường minh cũng gắn GUC, và GUC KHÔNG rò giữa các
 *    lượt checkout nối tiếp trên cùng một kết nối vật lý (pool `max: 1`
 *    ép mọi lượt dùng chung một kết nối).
 */
const GUC_SQL =
  "select current_setting('app.tenant_id', true) as tenant_id, current_setting('app.platform', true) as platform";

interface GucRow {
  tenant_id: string;
  platform: string;
}

const TENANT_A = '018e7a00-0000-7000-8000-00000000000a';
const TENANT_B = '018e7a00-0000-7000-8000-00000000000b';

describe('TenantAwarePool — GUC theo ngữ cảnh ALS (TENANT-1 #196, bước 2)', () => {
  const pool = new TenantAwarePool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });

  afterAll(async () => {
    await pool.end();
  });

  const readGucViaPoolQuery = async (): Promise<GucRow> => {
    const res = await pool.query<GucRow>(GUC_SQL);
    return res.rows[0];
  };

  it('pool.query ngoài ngữ cảnh: tenant rỗng, platform off (fail-closed)', async () => {
    await expect(readGucViaPoolQuery()).resolves.toEqual({ tenant_id: '', platform: 'off' });
  });

  it('pool.query trong ngữ cảnh tenant: mang đúng tenant của ALS', async () => {
    const guc = await tenantAls.run({ tenantId: TENANT_A }, readGucViaPoolQuery);
    expect(guc).toEqual({ tenant_id: TENANT_A, platform: 'off' });
  });

  it('pool.query trong ngữ cảnh platform: platform on, tenant rỗng', async () => {
    const guc = await tenantAls.run({ platform: true }, readGucViaPoolQuery);
    expect(guc).toEqual({ tenant_id: '', platform: 'on' });
  });

  it('các lượt checkout nối tiếp trên cùng kết nối không rò GUC', async () => {
    const a = await tenantAls.run({ tenantId: TENANT_A }, readGucViaPoolQuery);
    const b = await tenantAls.run({ tenantId: TENANT_B }, readGucViaPoolQuery);
    const none = await readGucViaPoolQuery();
    const platform = await tenantAls.run({ platform: true }, readGucViaPoolQuery);
    const after = await readGucViaPoolQuery();
    expect(a.tenant_id).toBe(TENANT_A);
    expect(b.tenant_id).toBe(TENANT_B);
    expect(none).toEqual({ tenant_id: '', platform: 'off' });
    expect(platform).toEqual({ tenant_id: '', platform: 'on' });
    expect(after).toEqual({ tenant_id: '', platform: 'off' });
  });

  it('connect() tường minh gắn GUC; client tái sử dụng không mang GUC cũ', async () => {
    const inTenant = await tenantAls.run({ tenantId: TENANT_A }, async () => {
      const client = await pool.connect();
      try {
        const res = await client.query<GucRow>(GUC_SQL);
        return res.rows[0];
      } finally {
        client.release();
      }
    });
    expect(inTenant).toEqual({ tenant_id: TENANT_A, platform: 'off' });
    // Cùng pool (max: 1) — kết nối vật lý vừa trả lại được dùng lại cho
    // pool.query ngoài ngữ cảnh: GUC phải trở về rỗng/off, không rò A.
    await expect(readGucViaPoolQuery()).resolves.toEqual({ tenant_id: '', platform: 'off' });
  });
});
