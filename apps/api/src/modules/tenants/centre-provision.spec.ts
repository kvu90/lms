/**
 * Spec khoá các hàm thuần của pipeline cấp phát trung tâm (issue
 * #583): mọi suy ra từ slug phải xác định (chạy lại cho ra cùng
 * kết quả), vừa giới hạn của PostgreSQL, và mật khẩu/token phải
 * giữ đúng tính chất an toàn đã cam kết trong code.
 */
import { describe, expect, it } from 'vitest';
import {
  CENTRE_DATABASE_PREFIX,
  buildCentreDatabaseUrl,
  deriveCentreDatabaseName,
  deriveCentreRoleName,
  deriveCentreSecretEnvVar,
  generateCentreDatabasePassword,
  generateCentreInviteToken,
  hashCentreInviteToken,
  normalizeSpaceSlug,
} from './centre-provision';

describe('chuẩn hoá slug của trung tâm', () => {
  it('hạ slug về chữ thường và xén khoảng trắng hai đầu', () => {
    expect(normalizeSpaceSlug('  Trung-Tam-A ')).toBe('trung-tam-a');
  });

  it('từ chối slug rỗng sau khi xén', () => {
    expect(() => normalizeSpaceSlug('   ')).toThrow();
  });

  it('từ chối slug chứa ký tự ngoài nhãn DNS (gạch dưới, dấu chấm)', () => {
    expect(() => normalizeSpaceSlug('trung_tam.a')).toThrow();
  });

  it('từ chối slug dài quá 63 ký tự của một nhãn DNS', () => {
    expect(() => normalizeSpaceSlug('a'.repeat(64))).toThrow();
  });
});

describe('suy ra tên database và tên role từ slug', () => {
  it('tên database là tiền tố + slug đổi gạch ngang thành gạch dưới', () => {
    expect(deriveCentreDatabaseName('trung-tam-a')).toBe(`${CENTRE_DATABASE_PREFIX}trung_tam_a`);
  });

  it('tên role khác tiền tố database nên không trùng tên database', () => {
    const slug = 'trung-tam-a';
    expect(deriveCentreRoleName(slug)).not.toBe(deriveCentreDatabaseName(slug));
  });

  it('cùng một slug luôn cho ra cùng một tên database và tên role (chạy lại an toàn)', () => {
    const slug = 'trung-tam-dai-'.concat('x'.repeat(50));
    expect(deriveCentreDatabaseName(slug)).toBe(deriveCentreDatabaseName(slug));
    expect(deriveCentreRoleName(slug)).toBe(deriveCentreRoleName(slug));
  });

  it('slug dài nhất (63 ký tự) vẫn cho tên database và role vừa giới hạn 63 ký tự', () => {
    const slug = 'a'.repeat(63);
    expect(deriveCentreDatabaseName(slug).length).toBeLessThanOrEqual(63);
    expect(deriveCentreRoleName(slug).length).toBeLessThanOrEqual(63);
  });

  it('hai slug dài chỉ khác nhau ở đuôi cho ra tên database khác nhau nhờ hậu tố băm', () => {
    const a = deriveCentreDatabaseName('a'.repeat(62) + 'x');
    const b = deriveCentreDatabaseName('a'.repeat(62) + 'y');
    expect(a).not.toBe(b);
  });

  it('tên biến môi trường bí mật viết hoa slug và đổi gạch ngang thành gạch dưới', () => {
    expect(deriveCentreSecretEnvVar('trung-tam-a')).toBe('SPACE_TRUNG_TAM_A_DATABASE_URL');
  });
});

describe('mật khẩu database và token lời mời', () => {
  it('mật khẩu sinh ra dài 24 ký tự và chỉ chứa chữ + số nên an toàn khi chèn vào URL', () => {
    const password = generateCentreDatabasePassword();
    expect(password).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  it('hai lần sinh mật khẩu không trùng nhau', () => {
    expect(generateCentreDatabasePassword()).not.toBe(generateCentreDatabasePassword());
  });

  it('URL kết nối mã hoá phần trăm mật khẩu chứa ký tự đặc biệt', () => {
    const url = buildCentreDatabaseUrl({ host: 'db.internal', port: 5432, role: 'lms_role_x', password: 'p@ss/w?rd#', databaseName: 'lms_space_x' });
    expect(url).toBe('postgres://lms_role_x:p%40ss%2Fw%3Frd%23@db.internal:5432/lms_space_x');
    expect(() => new URL(url)).not.toThrow();
  });

  it('token lời mời là base64url 256 bit và băm SHA-256 của nó ổn định 64 ký tự hex', () => {
    const token = generateCentreInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hashCentreInviteToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCentreInviteToken(token)).toBe(hashCentreInviteToken(token));
  });

  it('hai token khác nhau cho băm khác nhau', () => {
    expect(hashCentreInviteToken(generateCentreInviteToken())).not.toBe(hashCentreInviteToken(generateCentreInviteToken()));
  });
});
