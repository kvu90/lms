import { describe, expect, it } from 'vitest';
import {
  backupFileName,
  buildPgToolArgs,
  decryptBackup,
  encryptBackup,
  isBackupOverdue,
  isEncryptedBackup,
  orderSpacesIntoWaves,
  parseBackupFileName,
  parsePositiveInt,
  pickRestoreCandidate,
  resolveDumpConnectionUrl,
  resolveSpaceConnectionUrl,
  retargetUrl,
  sha256Hex,
  type FleetSpace,
} from './fleet-common';

/** Dựng một kho mẫu cho các bài kiểm thử thuần của đội kho. */
function space(partial: Partial<FleetSpace>): FleetSpace {
  return {
    id: 'space-id',
    slug: 'kho',
    kind: 'center',
    status: 'active',
    databaseName: 'db_kho',
    secretRef: 'env:SPACE_URL',
    registryVersion: null,
    lastBackupAt: null,
    lastRestoreAt: null,
    ...partial,
  };
}

/**
 * Khoá hành vi THUẦN của công cụ vận hành đội kho (issue #586):
 * thứ tự đợt an toàn (nền tảng → canary → các đợt sau), vòng xoay
 * kiểm thử khôi phục công bằng, cổng quá hạn sao lưu, khuôn tên tệp
 * và gói mã hoá sao lưu tự kiểm chứng được, và luật suy ra URL vận
 * hành (luôn bằng thông tin đăng nhập của role migration khi đã cấu
 * hình). Đổi các bất biến này thì test phải đỏ.
 */
describe('Công cụ vận hành đội kho (helper thuần)', () => {
  it('sắp đợt: nền tảng đi đợt riêng trước, trung tâm slug nhỏ nhất là canary đi một mình, phần còn lại chia theo kích thước đợt', () => {
    const spaces = [
      space({ slug: 'tt-c', databaseName: 'db_c' }),
      space({ slug: 'trang-chinh', kind: 'platform', databaseName: 'db_main' }),
      space({ slug: 'tt-a', databaseName: 'db_a' }),
      space({ slug: 'tt-d', databaseName: 'db_d' }),
      space({ slug: 'tt-b', databaseName: 'db_b' }),
    ];
    const waves = orderSpacesIntoWaves(spaces, 2);
    expect(waves.map((wave) => wave.map((s) => s.slug))).toEqual([
      ['trang-chinh'],
      ['tt-a'],
      ['tt-b', 'tt-c'],
      ['tt-d'],
    ]);
  });

  it('sắp đợt: kho không ở trạng thái đang hoạt động không vào bất kỳ đợt nào', () => {
    const spaces = [
      space({ slug: 'tt-a', status: 'suspended' }),
      space({ slug: 'tt-b', status: 'provisioning' }),
      space({ slug: 'tt-c' }),
    ];
    expect(orderSpacesIntoWaves(spaces, 5).map((wave) => wave.map((s) => s.slug))).toEqual([['tt-c']]);
    expect(orderSpacesIntoWaves([], 2)).toEqual([]);
  });

  it('chọn ứng viên kiểm thử khôi phục: chưa từng kiểm thử đi trước, rồi tới lượt cũ nhất, hoà thì slug nhỏ hơn thắng', () => {
    const spaces = [
      space({ slug: 'tt-b', lastRestoreAt: new Date('2026-10-01T00:00:00.000Z') }),
      space({ slug: 'tt-a', lastRestoreAt: new Date('2026-10-01T00:00:00.000Z') }),
      space({ slug: 'tt-c', lastRestoreAt: new Date('2026-09-01T00:00:00.000Z') }),
      space({ slug: 'tt-d', lastRestoreAt: null }),
      space({ slug: 'tt-e', status: 'suspended', lastRestoreAt: null }),
    ];
    expect(pickRestoreCandidate(spaces)?.slug).toBe('tt-d');
    expect(pickRestoreCandidate(spaces.filter((s) => s.slug !== 'tt-d'))?.slug).toBe('tt-c');
    expect(
      pickRestoreCandidate(spaces.filter((s) => ['tt-a', 'tt-b'].includes(s.slug)))?.slug,
    ).toBe('tt-a');
    expect(pickRestoreCandidate([])).toBeNull();
  });

  it('quá hạn sao lưu: chưa từng sao lưu là quá hạn, trong ngưỡng thì chưa, vượt ngưỡng giờ cấu hình thì quá hạn', () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    expect(isBackupOverdue(null, now, 26)).toBe(true);
    expect(isBackupOverdue(new Date('2026-10-30T00:00:00.000Z'), now, 26)).toBe(false);
    expect(isBackupOverdue(new Date('2026-10-29T09:59:59.000Z'), now, 26)).toBe(true);
  });

  it('tên tệp sao lưu đọc ngược lại được đúng loại, mã lượt và trạng thái mã hoá; tên lạ bị loại', () => {
    const at = new Date('2026-10-30T14:30:05.000Z');
    const name = backupFileName('pre-migration', 'fleet-20261030140000-ab12', at, true);
    expect(name).toBe('pre-migration-fleet-20261030140000-ab12-20261030T143005.dump.enc');
    expect(parseBackupFileName(name)).toEqual({
      kind: 'pre-migration',
      runId: 'fleet-20261030140000-ab12',
      encrypted: true,
    });
    expect(parseBackupFileName(backupFileName('scheduled', 'fleet-x', at, false))).toEqual({
      kind: 'scheduled',
      runId: 'fleet-x',
      encrypted: false,
    });
    expect(parseBackupFileName('random-file.dump')).toBeNull();
    expect(parseBackupFileName('scheduled-fleet-x-20261030T143005.dump.sha256')).toBeNull();
  });

  it('băm SHA-256 khớp vector đã biết của nội dung rỗng', () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('gói sao lưu mã hoá giải mã trở lại đúng nguyên bản, và mọi sửa đổi trên gói đều làm giải mã thất bại', () => {
    const plain = Buffer.from('noi dung sao luu gia lap '.repeat(64));
    const packed = encryptBackup(plain, 'cum-mat-khau');
    expect(isEncryptedBackup(packed)).toBe(true);
    expect(isEncryptedBackup(plain)).toBe(false);
    expect(decryptBackup(packed, 'cum-mat-khau').equals(plain)).toBe(true);
    const tampered = Buffer.from(packed);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() => decryptBackup(tampered, 'cum-mat-khau')).toThrow();
    expect(() => decryptBackup(packed, 'sai-mat-khau')).toThrow();
    expect(() => decryptBackup(plain, 'cum-mat-khau')).toThrow(/not in the encrypted fleet format/);
  });

  it('tham số công cụ pg không bao giờ chứa mật khẩu — mật khẩu chỉ đi riêng để caller đưa vào PGPASSWORD', () => {
    const { args, password } = buildPgToolArgs('postgres://lms_migrator:s3cret@db.internal:5433/lms');
    expect(args).toEqual(['-h', 'db.internal', '-p', '5433', '-U', 'lms_migrator', '-d', 'lms']);
    expect(password).toBe('s3cret');
    expect(args.join(' ')).not.toContain('s3cret');
  });

  it('URL vận hành của một kho: lấy nền từ biến mà sổ trỏ tới, thay thông tin đăng nhập bằng của role migration và đích bằng database của kho', () => {
    const env = {
      SPACE_URL: 'postgres://lms_runtime:runtimepw@db.internal:5432/lms',
      MIGRATION_DATABASE_URL: 'postgres://lms_migrator:migratorpw@db.internal:5432/lms',
    } as NodeJS.ProcessEnv;
    const url = new URL(resolveSpaceConnectionUrl(space({ databaseName: 'tenant_a_db' }), env));
    expect(url.username).toBe('lms_migrator');
    expect(url.password).toBe('migratorpw');
    expect(url.pathname).toBe('/tenant_a_db');
    expect(url.hostname).toBe('db.internal');
  });

  it('URL vận hành khi chưa cấu hình role migration giữ nguyên thông tin đăng nhập của URL nền; sổ trỏ tới biến chưa đặt thì ném lỗi gọi đúng tên biến', () => {
    const env = { SPACE_URL: 'postgres://postgres:pw@db.internal:5432/postgres' } as NodeJS.ProcessEnv;
    const url = new URL(resolveSpaceConnectionUrl(space({ databaseName: 'tenant_a_db' }), env));
    expect(url.username).toBe('postgres');
    expect(url.pathname).toBe('/tenant_a_db');
    expect(() =>
      resolveSpaceConnectionUrl(space({ secretRef: 'env:KHONG_TON_TAI' }), env),
    ).toThrow(/KHONG_TON_TAI/);
  });

  it('URL chụp sao lưu ưu tiên kết nối quản trị của cụm đổi đích sang database của kho; vắng kết nối quản trị thì rơi về URL vận hành', () => {
    const withAdmin = {
      SPACE_URL: 'postgres://lms_runtime:runtimepw@db.internal:5432/lms',
      MIGRATION_DATABASE_URL: 'postgres://lms_migrator:migratorpw@db.internal:5432/lms',
      DATABASE_ADMIN_URL: 'postgres://postgres:adminpw@db.internal:5432/postgres',
    } as NodeJS.ProcessEnv;
    const admin = new URL(resolveDumpConnectionUrl(space({ databaseName: 'tenant_a_db' }), withAdmin));
    expect(admin.username).toBe('postgres');
    expect(admin.password).toBe('adminpw');
    expect(admin.pathname).toBe('/tenant_a_db');
    const withoutAdmin = { ...withAdmin } as NodeJS.ProcessEnv;
    delete withoutAdmin.DATABASE_ADMIN_URL;
    const fallback = new URL(resolveDumpConnectionUrl(space({ databaseName: 'tenant_a_db' }), withoutAdmin));
    expect(fallback.username).toBe('lms_migrator');
    expect(fallback.pathname).toBe('/tenant_a_db');
  });

  it('đổi đích URL giữ nguyên cổng và thông tin đăng nhập, chỉ thay tên database', () => {
    const url = new URL(retargetUrl('postgres://u:p@db.internal:5433/lms', 'lms_backup'));
    expect(url.port).toBe('5433');
    expect(url.username).toBe('u');
    expect(url.pathname).toBe('/lms_backup');
  });

  it('số nguyên cấu hình: giá trị hợp lệ được dùng, rỗng hoặc không hợp lệ rơi về giá trị dự phòng', () => {
    expect(parsePositiveInt('4', 2)).toBe(4);
    expect(parsePositiveInt(undefined, 2)).toBe(2);
    expect(parsePositiveInt('khong-phai-so', 2)).toBe(2);
    expect(parsePositiveInt('0', 2)).toBe(2);
    expect(parsePositiveInt('-3', 2)).toBe(2);
  });
});
