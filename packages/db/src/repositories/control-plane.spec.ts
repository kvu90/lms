import { describe, expect, it } from 'vitest';
import {
  ControlPlaneNotConfiguredError,
  ControlPlaneRepository,
  DEDICATED_DATABASE_NAME_UNIQUE_INDEX,
  isDedicatedDatabaseNameConflict,
} from './control-plane';

/**
 * Ca đơn vị của repository control plane trên Kysely (issue #640):
 * khuôn nhận diện lỗi `pg` (thử nghiệm T-10) ở dạng thuần — không
 * cần database. Hình dạng lỗi đưa vào đây là hình dạng ĐÃ ĐO trên
 * database thật ở spec tích hợp đi kèm: qua Kysely lỗi `pg` ném
 * trực tiếp (có `code`/`constraint`, không có `cause`); qua Drizzle
 * lỗi bị bọc thành lớp lỗi truy vấn mang `cause` là lỗi `pg` gốc.
 */
describe('isDedicatedDatabaseNameConflict — khuôn đọc lỗi pg (T-10)', () => {
  it('nhận diện lỗi pg trực tiếp qua Kysely: code 23505 và constraint là chỉ số dedicated', () => {
    const err = { code: '23505', constraint: DEDICATED_DATABASE_NAME_UNIQUE_INDEX, message: 'duplicate key' };
    expect(isDedicatedDatabaseNameConflict(err)).toBe(true);
  });

  it('nhận diện qua chuỗi cause của lỗi Drizzle bọc lỗi pg gốc', () => {
    const err = {
      name: 'DrizzleQueryError',
      message: 'Failed query: insert into "space_registry" ...',
      cause: { code: '23505', constraint: DEDICATED_DATABASE_NAME_UNIQUE_INDEX },
    };
    expect(isDedicatedDatabaseNameConflict(err)).toBe(true);
  });

  it('ca dự phòng: lỗi không mang constraint nhưng message chứa tên chỉ số dedicated thì vẫn nhận diện', () => {
    const err = {
      code: '23505',
      message: `duplicate key value violates unique constraint "${DEDICATED_DATABASE_NAME_UNIQUE_INDEX}"`,
    };
    expect(isDedicatedDatabaseNameConflict(err)).toBe(true);
  });

  it('không nuốt vi phạm unique của slug: code 23505 nhưng constraint khác thì trả false', () => {
    const err = { code: '23505', constraint: 'space_registry_slug_key', message: 'duplicate key value violates unique constraint "space_registry_slug_key"' };
    expect(isDedicatedDatabaseNameConflict(err)).toBe(false);
  });

  it('không nhận diện khi mã lỗi không phải 23505 dù constraint khớp', () => {
    const err = { code: '23503', constraint: DEDICATED_DATABASE_NAME_UNIQUE_INDEX };
    expect(isDedicatedDatabaseNameConflict(err)).toBe(false);
  });

  it('trả false cho giá trị không phải lỗi pg: null, chuỗi, Error thường', () => {
    expect(isDedicatedDatabaseNameConflict(null)).toBe(false);
    expect(isDedicatedDatabaseNameConflict('23505')).toBe(false);
    expect(isDedicatedDatabaseNameConflict(new Error('boom'))).toBe(false);
  });
});

describe('ControlPlaneRepository khi chưa cấu hình', () => {
  it('isConfigured trả false và thao tác đọc ném lỗi mang mã control_plane.not_configured', async () => {
    const repo = new ControlPlaneRepository(null);
    expect(repo.isConfigured()).toBe(false);
    await expect(repo.findSpaceBySlug('bat-ky')).rejects.toBeInstanceOf(ControlPlaneNotConfiguredError);
    await expect(repo.findSpaceBySlug('bat-ky')).rejects.toMatchObject({ code: 'control_plane.not_configured' });
  });

  it('hàm dựng lỗi do tầng ứng dụng cấp được dùng thay lỗi mặc định của package', async () => {
    const appError = new Error('app-specific not configured');
    const repo = new ControlPlaneRepository(null, () => appError);
    await expect(repo.listSpaces()).rejects.toBe(appError);
  });
});
