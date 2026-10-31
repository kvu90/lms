import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitSpaceRegistryChanged } from './space-routing-events';
import {
  SpaceConnectionResolver,
  SpaceRoutingError,
  type SpaceRegistryEntry,
} from './space-connection-resolver';

/**
 * Ca đơn vị của bộ phân giải đích kết nối (issue #581): đường đọc
 * sổ được thay bằng hàm giả đếm lượt đọc, đồng hồ được điều khiển
 * bằng tay — các ca khoá đúng ba luật của bộ phân giải: quyết định
 * đích theo chế độ kho trong sổ, kiểm chứng role/bí mật fail-closed
 * cho kho riêng, và đệm có TTL + vô hiệu hoá theo sự kiện đổi sổ.
 */

const DEDICATED_ENTRY: SpaceRegistryEntry = {
  id: 'id-dang-ky-a',
  slug: 'trung-tam-a',
  status: 'active',
  databaseName: 'lms_centre_a',
  storageMode: 'dedicated',
  connectionRoleRef: 'centre_a_app',
  secretRef: 'env:CENTRE_A_URL',
  schemaVersion: 'v3',
};

const SHARED_ENTRY: SpaceRegistryEntry = {
  id: 'id-dang-ky-trang-chinh',
  slug: 'trang-chinh',
  status: 'active',
  databaseName: 'lms_shared',
  storageMode: 'shared',
  connectionRoleRef: 'lms_app',
  secretRef: 'env:DATABASE_URL',
  schemaVersion: 'v1',
};

/** Dựng bộ phân giải với đường đọc giả trên một sổ cho trước và đồng hồ điều khiển được. */
function makeResolver(entries: Record<string, SpaceRegistryEntry>, cacheTtlMs = 1_000) {
  let reads = 0;
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const resolver = new SpaceConnectionResolver({
    cacheTtlMs,
    readRegistry: async (slug) => {
      reads += 1;
      return entries[slug];
    },
    resolveSecretRef: (ref) => (ref === 'env:CENTRE_A_URL' ? 'postgres://centre_a_app:pw@db.internal:5432/postgres' : undefined),
  });
  return {
    resolver,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CENTRE_A_URL;
});

describe('Bộ phân giải đích kết nối theo trung tâm', () => {
  it('slug chưa có dòng đăng ký thì ném lỗi không tìm thấy, không đoán đích', async () => {
    const { resolver } = makeResolver({});
    await expect(resolver.resolve('slug-la')).rejects.toMatchObject({
      name: 'SpaceRoutingError',
      code: 'space_routing.space_not_found',
    });
    resolver.dispose();
  });

  it('trung tâm ở kho chung phân giải về chế độ shared và không cần giải bí mật', async () => {
    const { resolver } = makeResolver({ 'trang-chinh': SHARED_ENTRY });
    const target = await resolver.resolve('trang-chinh');
    expect(target.mode).toBe('shared');
    expect(target.spaceId).toBe('id-dang-ky-trang-chinh');
    expect(target.databaseName).toBe('lms_shared');
    expect(target.connectionRole).toBe('lms_app');
    expect(target.connectionString).toBeUndefined();
    resolver.dispose();
  });

  it('trung tâm ở kho riêng được chốt đích về đúng database trong sổ, kể cả khi chuỗi bí mật trỏ database khác', async () => {
    const { resolver } = makeResolver({ 'trung-tam-a': DEDICATED_ENTRY });
    const target = await resolver.resolve('trung-tam-a');
    expect(target.mode).toBe('dedicated');
    // Chuỗi bí mật gốc trỏ /postgres (database mặc định của role) —
    // đích cuối phải là databaseName của sổ.
    expect(target.connectionString).toBe('postgres://centre_a_app:pw@db.internal:5432/lms_centre_a');
    expect(target.connectionRole).toBe('centre_a_app');
    expect(target.schemaVersion).toBe('v3');
    resolver.dispose();
  });

  it('role trong chuỗi kết nối lệch role sổ đăng ký thì bị từ chối, không cấp chuỗi kết nối', async () => {
    const resolver = new SpaceConnectionResolver({
      cacheTtlMs: 1_000,
      readRegistry: async () => DEDICATED_ENTRY,
      resolveSecretRef: () => 'postgres://role_khac:pw@db.internal:5432/postgres',
    });
    await expect(resolver.resolve('trung-tam-a')).rejects.toMatchObject({ code: 'space_routing.role_mismatch' });
    resolver.dispose();
  });

  it('kho riêng thiếu bí mật (chưa khai tham chiếu hoặc biến chưa cấu hình) thì bị từ chối', async () => {
    const noRef = new SpaceConnectionResolver({
      cacheTtlMs: 1_000,
      readRegistry: async () => ({ ...DEDICATED_ENTRY, secretRef: null }),
    });
    await expect(noRef.resolve('trung-tam-a')).rejects.toMatchObject({ code: 'space_routing.secret_missing' });
    noRef.dispose();

    const notConfigured = new SpaceConnectionResolver({
      cacheTtlMs: 1_000,
      readRegistry: async () => DEDICATED_ENTRY,
      resolveSecretRef: () => undefined,
    });
    await expect(notConfigured.resolve('trung-tam-a')).rejects.toMatchObject({ code: 'space_routing.secret_missing' });
    notConfigured.dispose();
  });

  it('kết quả phân giải được đệm trong TTL: nhiều lần phân giải chỉ đọc sổ một lần', async () => {
    const { resolver, reads, advance } = makeResolver({ 'trung-tam-a': DEDICATED_ENTRY });
    await resolver.resolve('trung-tam-a');
    await resolver.resolve('trung-tam-a');
    expect(reads()).toBe(1);
    // Qua TTL thì lần phân giải kế tiếp đọc lại sổ.
    advance(1_001);
    await resolver.resolve('trung-tam-a');
    expect(reads()).toBe(2);
    resolver.dispose();
  });

  it('sự kiện đổi sổ vô hiệu hoá đệm của đúng slug đó ngay trong TTL', async () => {
    const entries = { 'trung-tam-a': { ...DEDICATED_ENTRY }, 'trang-chinh': { ...SHARED_ENTRY } };
    const { resolver, reads } = makeResolver(entries);
    await resolver.resolve('trung-tam-a');
    await resolver.resolve('trang-chinh');
    expect(reads()).toBe(2);
    // Sổ đổi trạng thái của trung tâm A và phát sự kiện: phân giải
    // lại A đọc sổ ngay (thấy trạng thái mới), trang-chinh vẫn đệm.
    entries['trung-tam-a'] = { ...DEDICATED_ENTRY, status: 'suspended' };
    emitSpaceRegistryChanged('trung-tam-a');
    const resolved = await resolver.resolve('trung-tam-a');
    expect(resolved.status).toBe('suspended');
    expect(reads()).toBe(3);
    await resolver.resolve('trang-chinh');
    expect(reads()).toBe(3);
    resolver.dispose();
  });

  it('sự kiện vô hiệu hoá tới trong lúc lần đọc sổ còn đang chờ thì kết quả cũ không được đệm: lần phân giải kế tiếp đọc lại sổ và trả đích mới', async () => {
    // Hình đua đã phân xử ở vòng chấm lại của PR #594: lần đọc sổ
    // bắt đầu TRƯỚC khi thay đổi được commit nên nó trả ảnh chụp
    // cũ; nếu kết quả đó vẫn bị đệm lại, đích cũ sống tiếp sau sự
    // kiện vô hiệu hoá cho tới hết TTL. Ca này giữ lần đọc đầu
    // treo bằng một promise điều khiển bằng tay, phát sự kiện qua
    // đúng kênh thật trong lúc đọc còn chờ, rồi mới thả lần đọc
    // với dòng trước thay đổi.
    const slug = 'trung-tam-a';
    let currentEntry: SpaceRegistryEntry = { ...DEDICATED_ENTRY };
    let reads = 0;
    let releaseFirstRead: ((entry: SpaceRegistryEntry | undefined) => void) | undefined;
    const resolver = new SpaceConnectionResolver({
      cacheTtlMs: 60_000,
      readRegistry: () => {
        reads += 1;
        if (reads === 1) {
          return new Promise<SpaceRegistryEntry | undefined>((resolveRead) => {
            releaseFirstRead = resolveRead;
          });
        }
        return Promise.resolve(currentEntry);
      },
      resolveSecretRef: (ref) =>
        ref === 'env:CENTRE_A_URL' ? 'postgres://centre_a_app:pw@db.internal:5432/postgres' : undefined,
    });
    const firstResolve = resolver.resolve(slug);
    // Sổ đổi trạng thái và sự kiện vô hiệu hoá tới trong lúc lần
    // đọc đầu còn đang chờ.
    currentEntry = { ...DEDICATED_ENTRY, status: 'suspended' };
    emitSpaceRegistryChanged(slug);
    // Lần đọc treo trả dòng TRƯỚC thay đổi (ảnh chụp cũ).
    releaseFirstRead!({ ...DEDICATED_ENTRY });
    await firstResolve;
    // Lần phân giải kế tiếp phải đọc lại sổ (lượt đọc tăng lên 2)
    // và thấy đích sau thay đổi, không phục vụ kết quả cũ từ đệm.
    const second = await resolver.resolve(slug);
    expect(second.status).toBe('suspended');
    expect(reads).toBe(2);
    resolver.dispose();
  });

  it('sau khi dispose, bộ phân giải không còn nhận sự kiện vô hiệu hoá', async () => {
    const { resolver, reads } = makeResolver({ 'trung-tam-a': DEDICATED_ENTRY });
    await resolver.resolve('trung-tam-a');
    resolver.dispose();
    emitSpaceRegistryChanged('trung-tam-a');
    await resolver.resolve('trung-tam-a');
    expect(reads()).toBe(1);
  });

  it('trung tâm đã tạm ngưng hoặc đã đóng vẫn phân giải được đích, trạng thái đi kèm kết quả', async () => {
    const { resolver } = makeResolver({
      'trung-tam-a': { ...DEDICATED_ENTRY, status: 'closed' },
    });
    const target = await resolver.resolve('trung-tam-a');
    expect(target.status).toBe('closed');
    expect(target.mode).toBe('dedicated');
    resolver.dispose();
  });

  it('lỗi phân giải là SpaceRoutingError mang mã lỗi ổn định', async () => {
    const { resolver } = makeResolver({});
    const error = await resolver.resolve('khong-co').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SpaceRoutingError);
    resolver.dispose();
  });
});
