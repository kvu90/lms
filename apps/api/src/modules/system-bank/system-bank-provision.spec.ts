/**
 * Unit test cho helper cấp phát kho ngân hàng hệ thống (issue #585):
 * kiểm chứng phần suy luận thuần (đọc đích từ URL, dựng câu SQL)
 * không cần database thật.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEnsureDatabaseStatements,
  buildEnsureRoleStatements,
  buildRestrictConnectStatements,
  parseSystemBankTarget,
  quoteIdentifier,
  quoteLiteral,
} from './system-bank-provision';

describe('Cấp phát kho ngân hàng hệ thống — đọc đích từ URL', () => {
  it('đọc đúng tên database, role và mật khẩu từ URL, giải mã ký tự đặc biệt trong mật khẩu', () => {
    const target = parseSystemBankTarget('postgres://lms_system_bank:Pass%40123@db.internal:5432/lms_system_bank');
    expect(target.database).toBe('lms_system_bank');
    expect(target.role).toBe('lms_system_bank');
    expect(target.rolePassword).toBe('Pass@123');
  });

  it('ném lỗi khi URL thiếu tên database hoặc thiếu username', () => {
    expect(() => parseSystemBankTarget('postgres://lms_system_bank@localhost:5432/')).toThrow(
      'SYSTEM_BANK_DATABASE_URL must name a database in its path',
    );
    expect(() => parseSystemBankTarget('postgres://localhost:5432/lms_system_bank')).toThrow(
      'SYSTEM_BANK_DATABASE_URL must carry the connection role as username',
    );
  });

  it('thoát định danh và literal SQL đúng quy tắc Postgres', () => {
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("o'clock")).toBe("'o''clock'");
  });
});

describe('Cấp phát kho ngân hàng hệ thống — dựng câu lệnh SQL', () => {
  const target = parseSystemBankTarget('postgres://lms_system_bank:secret@localhost:5432/lms_system_bank');

  it('tạo role mới ở dạng LOGIN thuần, không kèm quyền tạo database hay superuser', () => {
    const statements = buildEnsureRoleStatements(target, false);
    expect(statements).toEqual(['CREATE ROLE "lms_system_bank" LOGIN PASSWORD \'secret\'']);
    expect(statements[0]).not.toMatch(/CREATEDB|CREATEROLE|SUPERUSER/);
  });

  it('đồng bộ mật khẩu cho role đã tồn tại thay vì tạo lại', () => {
    expect(buildEnsureRoleStatements(target, true)).toEqual([
      'ALTER ROLE "lms_system_bank" WITH LOGIN PASSWORD \'secret\'',
    ]);
  });

  it('chỉ tạo database khi chưa có, và gán chủ sở hữu là role kho ngân hàng', () => {
    expect(buildEnsureDatabaseStatements(target, true)).toEqual([]);
    expect(buildEnsureDatabaseStatements(target, false)).toEqual([
      'CREATE DATABASE "lms_system_bank" OWNER "lms_system_bank"',
    ]);
  });

  it('khoá kết nối: thu hồi PUBLIC rồi chỉ cấp cho role kho ngân hàng', () => {
    expect(buildRestrictConnectStatements(target)).toEqual([
      'REVOKE CONNECT ON DATABASE "lms_system_bank" FROM PUBLIC',
      'GRANT CONNECT ON DATABASE "lms_system_bank" TO "lms_system_bank"',
    ]);
  });
});
