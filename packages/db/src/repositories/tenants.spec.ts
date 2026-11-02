import { describe, expect, it, vi } from 'vitest';
import { TenantsRepository, type TenantRow } from './tenants';

/**
 * Tenant-zero trong TenantGuard: danh tính của tenant nền tảng cố
 * định từ lúc bootstrap nên repository giữ lại trong singleton —
 * các request sau lần tra đầu tiên không còn truy vấn cơ sở dữ
 * liệu. Chỉ cache khi ĐÃ tra thấy: trước bootstrap seed (tenant-
 * zero chưa tồn tại) mọi lần gọi vẫn xuống cơ sở dữ liệu để
 * request đầu tiên sau khi gieo thấy ngay, không bị cache rỗng
 * che mất.
 *
 * Cache cả kết quả "chưa thấy" thì ca thứ hai phải đỏ.
 *
 * Bản Kysely của spec này (chuyển từ spec Drizzle cạnh module
 * tenants ở issue #641): handle giả mô phỏng đúng chuỗi builder
 * mà repository dùng — `selectFrom → select → where →
 * executeTakeFirst` — và đếm số lần repository mở truy vấn chọn.
 */
describe('TenantsRepository.getPlatformTenant — cache singleton chỉ khi đã tra thấy', () => {
  function buildDb(row: TenantRow | undefined) {
    const state = { selectCalls: 0 };
    const db = {
      selectFrom: vi.fn(() => {
        state.selectCalls += 1;
        return {
          select: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve(row),
            }),
          }),
        };
      }),
    };
    return { db, state };
  }

  it('đã tra thấy: các lần gọi sau dùng bản cache, cơ sở dữ liệu chỉ bị tra đúng một lần', async () => {
    const zero = { id: 'tenant-zero-id', slug: 'trang-chinh' } as TenantRow;
    const { db, state } = buildDb(zero);
    const repo = new TenantsRepository(db as never);

    await expect(repo.getPlatformTenant()).resolves.toBe(zero);
    await expect(repo.getPlatformTenant()).resolves.toBe(zero);
    await expect(repo.getPlatformTenant()).resolves.toBe(zero);

    expect(state.selectCalls).toBe(1);
  });

  it('chưa tra thấy (trước bootstrap seed): không cache — mỗi lần gọi vẫn tra cơ sở dữ liệu', async () => {
    const { db, state } = buildDb(undefined);
    const repo = new TenantsRepository(db as never);

    await expect(repo.getPlatformTenant()).resolves.toBeUndefined();
    await expect(repo.getPlatformTenant()).resolves.toBeUndefined();

    expect(state.selectCalls).toBe(2);
  });
});
