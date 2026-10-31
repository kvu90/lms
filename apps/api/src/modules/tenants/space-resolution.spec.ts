import { describe, expect, it } from 'vitest';
import { SpaceRoutingError, type ResolvedSpaceConnection } from '../../db/routing/space-connection-resolver';
import { extractSpaceSlugFromHost, resolveDedicatedSpace } from './space-resolution';

/**
 * Ca đơn vị của hàm trích slug trung tâm từ địa chỉ request (issue
 * #582): khoá quy ước địa chỉ — nhãn đầu tiên của tên miền con là
 * slug ứng viên; địa chỉ gốc, localhost, IP và nhãn sai hình dạng
 * đều không mang trung tâm.
 */
describe('Trích slug trung tâm từ địa chỉ request', () => {
  it('tên miền con ba nhãn trả nhãn đầu tiên làm slug ứng viên', () => {
    expect(extractSpaceSlugFromHost('trung-tam-a.he-thong.example')).toBe('trung-tam-a');
  });

  it('host kèm cổng vẫn trích đúng slug, cổng bị bỏ qua', () => {
    expect(extractSpaceSlugFromHost('trung-tam-a.he-thong.example:8443')).toBe('trung-tam-a');
  });

  it('chữ hoa trong host được hạ về chữ thường trước khi đối chiếu hình dạng slug', () => {
    expect(extractSpaceSlugFromHost('Trung-Tam-A.He-Thong.Example')).toBe('trung-tam-a');
  });

  it('tên miền con sâu hơn ba nhãn vẫn lấy đúng nhãn đầu tiên', () => {
    expect(extractSpaceSlugFromHost('trung-tam-a.chi-nhanh.he-thong.example')).toBe('trung-tam-a');
  });

  it('địa chỉ gốc hai nhãn không mang trung tâm', () => {
    expect(extractSpaceSlugFromHost('he-thong.example')).toBeNull();
  });

  it('localhost không mang trung tâm, kể cả khi kèm cổng', () => {
    expect(extractSpaceSlugFromHost('localhost')).toBeNull();
    expect(extractSpaceSlugFromHost('localhost:3000')).toBeNull();
  });

  it('địa chỉ IP không mang trung tâm', () => {
    expect(extractSpaceSlugFromHost('127.0.0.1')).toBeNull();
    expect(extractSpaceSlugFromHost('127.0.0.1:8080')).toBeNull();
    expect(extractSpaceSlugFromHost('192.168.1.10')).toBeNull();
  });

  it('nhãn đầu tiên sai hình dạng slug thì không coi là ứng viên', () => {
    expect(extractSpaceSlugFromHost('-trung-tam-.he-thong.example')).toBeNull();
    expect(extractSpaceSlugFromHost('trung_tam_a.he-thong.example')).toBeNull();
    expect(extractSpaceSlugFromHost('.he-thong.example')).toBeNull();
  });

  it('host trống hoặc thiếu thì không mang trung tâm', () => {
    expect(extractSpaceSlugFromHost(undefined)).toBeNull();
    expect(extractSpaceSlugFromHost(null)).toBeNull();
    expect(extractSpaceSlugFromHost('')).toBeNull();
    expect(extractSpaceSlugFromHost('   ')).toBeNull();
  });
});

/**
 * Ca đơn vị của `resolveDedicatedSpace` (issue #584): từ địa chỉ
 * request suy ra không gian kho riêng, hoặc `null` khi request
 * không thuộc trung tâm kho riêng nào — các trường hợp `null`
 * giữ nguyên hành vi đường kho chung, còn lỗi cấu hình vận hành
 * thì ném ra fail-closed thay vì im lặng coi là kho chung.
 */
describe('resolveDedicatedSpace phân giải địa chỉ thành không gian kho riêng', () => {
  /** Bộ phân giải giả: đọc sổ từ một bảng cho trước thay vì control plane thật. */
  function fakeSpaceDb(entries: Record<string, ResolvedSpaceConnection | Error>) {
    return {
      resolveTarget: async (slug: string): Promise<ResolvedSpaceConnection> => {
        const entry = entries[slug];
        if (entry instanceof Error) throw entry;
        if (!entry) throw new SpaceRoutingError('space_routing.space_not_found', `Space ${slug} is not registered`);
        return entry;
      },
    };
  }

  function dedicatedTarget(slug: string): ResolvedSpaceConnection {
    return {
      slug, spaceId: `space-${slug}`, status: 'active', schemaVersion: 'v1',
      databaseName: `db-${slug}`, mode: 'dedicated', connectionRole: `role-${slug}`,
      connectionString: 'postgres://role:secret@host/db',
    };
  }

  function sharedTarget(slug: string): ResolvedSpaceConnection {
    return {
      slug, spaceId: `space-${slug}`, status: 'active', schemaVersion: null,
      databaseName: 'shared', mode: 'shared', connectionRole: 'shared-role',
    };
  }

  it('địa chỉ không mang trung tâm (địa chỉ gốc, thiếu nhãn) thì trả null để đi đường kho chung', async () => {
    const db = fakeSpaceDb({});
    expect(await resolveDedicatedSpace(db, 'he-thong.example')).toBeNull();
    expect(await resolveDedicatedSpace(db, 'localhost')).toBeNull();
    expect(await resolveDedicatedSpace(db, undefined)).toBeNull();
  });

  it('slug chưa đăng ký trong sổ thì trả null chứ không ném lỗi', async () => {
    const db = fakeSpaceDb({});
    expect(await resolveDedicatedSpace(db, 'trung-tam-la.test.local')).toBeNull();
  });

  it('tầng định tuyến chưa cấu hình thì trả null để giữ hành vi kho chung cũ', async () => {
    const db = fakeSpaceDb({
      'trung-tam-x': new SpaceRoutingError('space_routing.not_configured', 'Control plane is not configured'),
    });
    expect(await resolveDedicatedSpace(db, 'trung-tam-x.test.local')).toBeNull();
  });

  it('trung tâm ở chế độ kho chung thì trả null để đi đường kho chung', async () => {
    const db = fakeSpaceDb({ 'truong-mac-dinh': sharedTarget('truong-mac-dinh') });
    expect(await resolveDedicatedSpace(db, 'truong-mac-dinh.test.local')).toBeNull();
  });

  it('trung tâm ở kho riêng thì trả slug và định danh đăng ký của nó', async () => {
    const db = fakeSpaceDb({ 'trung-tam-a': dedicatedTarget('trung-tam-a') });
    expect(await resolveDedicatedSpace(db, 'trung-tam-a.test.local:8080')).toEqual({
      slug: 'trung-tam-a',
      spaceId: 'space-trung-tam-a',
    });
  });

  it('lỗi phân giải còn lại (bí mật/role lệch sổ) thì ném ra nguyên trạng, fail-closed', async () => {
    const cause = new SpaceRoutingError('space_routing.secret_mismatch', 'Secret does not match the registry');
    const db = fakeSpaceDb({ 'trung-tam-a': cause });
    await expect(resolveDedicatedSpace(db, 'trung-tam-a.test.local')).rejects.toBe(cause);
  });
});
