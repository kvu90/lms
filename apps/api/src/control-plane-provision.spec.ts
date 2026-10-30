import { describe, expect, it } from 'vitest';
import {
  buildEnsureDatabaseStatements,
  buildEnsureRoleStatements,
  buildRestrictBusinessConnectStatements,
  buildRestrictConnectStatements,
  parseBusinessTarget,
  parseControlPlaneTarget,
  quoteIdentifier,
  quoteLiteral,
} from './control-plane-provision';

/**
 * Khoá hành vi của helper cấp phát control plane (issue #580): đích
 * cấp phát chỉ suy ra từ URL, câu lệnh idempotent và khoá chặt quyền
 * kết nối — đổi các bất biến này thì test phải đỏ.
 */
describe('Cấp phát database control plane (helper thuần)', () => {
  it('đọc tên database từ path và role từ username của URL', () => {
    const target = parseControlPlaneTarget('postgres://lms_control_plane:pw@db.internal:5432/lms_control_plane');
    expect(target).toEqual({ database: 'lms_control_plane', role: 'lms_control_plane', rolePassword: 'pw' });
  });

  it('URL thiếu tên database hoặc thiếu username bị từ chối ngay', () => {
    expect(() => parseControlPlaneTarget('postgres://role:pw@db.internal:5432/')).toThrow(/database/);
    expect(() => parseControlPlaneTarget('postgres://db.internal:5432/lms_control_plane')).toThrow(/role/);
  });

  it('định danh và literal được thoát đúng cú pháp SQL', () => {
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("p'w")).toBe("'p''w'");
  });

  it('role chưa tồn tại thì tạo mới với LOGIN, đã tồn tại thì chỉ đồng bộ mật khẩu', () => {
    const target = { database: 'cp', role: 'cp_role', rolePassword: 'pw' };
    expect(buildEnsureRoleStatements(target, false)).toEqual([`CREATE ROLE "cp_role" LOGIN PASSWORD 'pw'`]);
    expect(buildEnsureRoleStatements(target, true)).toEqual([`ALTER ROLE "cp_role" WITH LOGIN PASSWORD 'pw'`]);
  });

  it('database chưa tồn tại thì tạo thuộc sở hữu của role control plane, đã có thì không làm gì', () => {
    const target = { database: 'cp', role: 'cp_role', rolePassword: 'pw' };
    expect(buildEnsureDatabaseStatements(target, false)).toEqual(['CREATE DATABASE "cp" OWNER "cp_role"']);
    expect(buildEnsureDatabaseStatements(target, true)).toEqual([]);
  });

  it('quyền kết nối bị thu hồi khỏi PUBLIC và chỉ cấp cho role control plane', () => {
    const target = { database: 'cp', role: 'cp_role', rolePassword: 'pw' };
    expect(buildRestrictConnectStatements(target)).toEqual([
      'REVOKE CONNECT ON DATABASE "cp" FROM PUBLIC',
      'GRANT CONNECT ON DATABASE "cp" TO "cp_role"',
    ]);
  });

  it('đích khoá kho nghiệp vụ đọc từ URL: tên database ở path, role nghiệp vụ ở username', () => {
    expect(parseBusinessTarget('postgres://app_role:pw@db.internal:5432/lms')).toEqual({
      database: 'lms',
      roles: ['app_role'],
    });
    expect(() => parseBusinessTarget('postgres://app_role:pw@db.internal:5432/')).toThrow(/database/);
    expect(() => parseBusinessTarget('postgres://db.internal:5432/lms')).toThrow(/role/);
  });

  it('khoá kho nghiệp vụ thu hồi CONNECT của PUBLIC và chỉ cấp lại cho các role nghiệp vụ hợp lệ', () => {
    expect(buildRestrictBusinessConnectStatements({ database: 'lms', roles: ['app_role'] })).toEqual([
      'REVOKE CONNECT ON DATABASE "lms" FROM PUBLIC',
      'GRANT CONNECT ON DATABASE "lms" TO "app_role"',
    ]);
    expect(buildRestrictBusinessConnectStatements({ database: 'lms', roles: ['app_role', 'report_role'] })).toEqual([
      'REVOKE CONNECT ON DATABASE "lms" FROM PUBLIC',
      'GRANT CONNECT ON DATABASE "lms" TO "app_role"',
      'GRANT CONNECT ON DATABASE "lms" TO "report_role"',
    ]);
  });
});
