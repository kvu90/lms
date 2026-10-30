import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitSpaceRegistryChanged } from './space-routing-events';
import {
  SpaceConnectionResolver,
  type SpaceRegistryEntry,
} from './space-connection-resolver';

/**
 * Ca đơn vị của bản sao phía worker của bộ phân giải đích kết nối
 * (issue #581). Bản worker là bản sao của cùng component phía API
 * (xem khối "BẢN SAO" ở đầu `space-connection-resolver.ts`): hai
 * bản phải phân giải theo đúng một luật từ cùng một sổ đăng ký,
 * nên spec này khoá cùng các luật vô hiệu hoá đệm như spec phía
 * API — vô hiệu hoá theo sự kiện đổi sổ ở thứ tự tuần tự, và ca
 * đua khi sự kiện tới trong lúc lần đọc sổ còn đang chờ (kết quả
 * cũ không được đệm lại). Đường đọc sổ được thay bằng hàm giả đếm
 * lượt đọc; riêng ca đua giữ lần đọc đầu treo bằng một promise
 * điều khiển bằng tay để thứ tự xen kẽ là xác định.
 */

const DEDICATED_ENTRY: SpaceRegistryEntry = {
  slug: 'trung-tam-a',
  status: 'active',
  databaseName: 'lms_centre_a',
  storageMode: 'dedicated',
  connectionRoleRef: 'centre_a_app',
  secretRef: 'env:CENTRE_A_URL',
  schemaVersion: 'v3',
};

const SHARED_ENTRY: SpaceRegistryEntry = {
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
  const now = 1_000_000;
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
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CENTRE_A_URL;
});

describe('Bộ phân giải đích kết nối theo trung tâm — bản sao phía worker', () => {
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
});
