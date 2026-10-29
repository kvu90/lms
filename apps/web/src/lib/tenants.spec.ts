/**
 * Kiểm chứng luồng nghiệp vụ của tầng gọi API tenant (lib/tenants.ts)
 * ở biên mạng — nơi lỗi thiếu tiền tố `/api/v1` từng làm tính năng
 * chuyển tenant chết lặng:
 *
 *   - `fetchMyTenants` phải gọi đúng `GET /api/v1/auth/tenants`
 *     (path đầy đủ theo quy ước chung của mọi call site trong
 *     apps/web; thiếu tiền tố là request không qua được proxy và
 *     không bao giờ tới API) và trả nguyên danh sách API trả về.
 *   - `switchTenant` phải gọi đúng `POST
 *     /api/v1/auth/switch-tenant/:tenantId` rồi mới nạp lại trang để
 *     áp dụng ngữ cảnh tenant mới.
 *
 * Cách kiểm: stub `fetch` ở biên mạng và khẳng định trên URL +
 * phương thức của request thật sự phát ra — không soi chi tiết
 * triển khai trong của hai hàm.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMyTenants, switchTenant } from '#lib/tenants';

/**
 * Stub fetch trả đáp ứng JSON thành công cho mọi request và trả spy
 * để khẳng định URL/phương thức của request đã phát.
 *
 * @param body - Thân JSON mà stub trả về cho mọi request.
 * @returns Spy của fetch đã stub.
 */
function stubFetchOk(body: unknown) {
  const spy = vi.fn(async (_input: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('lib/tenants — đường gọi API ở biên mạng', () => {
  it('fetchMyTenants gọi GET /api/v1/auth/tenants và trả danh sách tenant', async () => {
    const tenants = [
      { id: 'tenant-1', name: 'Trung tâm A', active: true },
      { id: 'tenant-2', name: 'Trung tâm B', active: false },
    ];
    const spy = stubFetchOk(tenants);

    const result = await fetchMyTenants();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe('/api/v1/auth/tenants');
    expect(result).toEqual(tenants);
  });

  it('switchTenant gọi POST /api/v1/auth/switch-tenant/:tenantId', async () => {
    const spy = stubFetchOk({});

    // Bước nạp lại trang sau lời gọi dùng `window.location.reload`
    // — jsdom khoá cứng thuộc tính này (không mock được) và chỉ ghi
    // nhận "not implemented" thay vì điều hướng thật, nên ca này
    // khẳng định ở biên mạng: đúng URL + đúng phương thức POST.
    await switchTenant('tenant-2');

    expect(spy).toHaveBeenCalledTimes(1);
    const [path, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/v1/auth/switch-tenant/tenant-2');
    expect(init.method).toBe('POST');
  });
});
