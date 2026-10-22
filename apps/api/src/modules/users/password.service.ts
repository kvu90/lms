import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

export interface PasswordPolicy { minLength: number; minDigits: number; minLower: number; minUpper: number; minNonAlnum: number }

/** Password hashing (argon2id) + configurable policy (Moodle auth policy — config, never hard-coded rules). */
@Injectable()
/**
 * Chính sách và băm mật khẩu.
 * Đối chiếu Moodle: lib/moodlelib.php (check_password_policy) + password_hash bcrypt.
 * Chính sách mặc định: tối thiểu 8 ký tự, có chữ thường, chữ hoa, số và ký tự đặc biệt;
 * các thông điệp con được gộp vào message nội bộ của lỗi user.password_policy (chi tiết hiển thị lấy từ catalog i18n).
 */
export class PasswordService {
  constructor(private readonly config: ConfigService) {}
  /**
   * Chính sách mật khẩu hiện hành (độ dài tối thiểu và các lớp ký tự bắt buộc).
   */
  policy(): PasswordPolicy {
    return {
      minLength: this.config.get<number>('PASSWORD_MIN_LENGTH') ?? 8,
      minDigits: this.config.get<number>('PASSWORD_MIN_DIGITS') ?? 1,
      minLower: this.config.get<number>('PASSWORD_MIN_LOWER') ?? 1,
      minUpper: this.config.get<number>('PASSWORD_MIN_UPPER') ?? 1,
      minNonAlnum: this.config.get<number>('PASSWORD_MIN_NONALNUM') ?? 0,
    };
  }
  /** Returns a list of policy violations (empty = acceptable). */
  /**
   * Kiểm tra mật khẩu theo chính sách; trả danh sách lý do không đạt (rỗng = đạt).
   */
  validatePolicy(password: string): string[] {
    const p = this.policy();
    const errors: string[] = [];
    if (password.length < p.minLength) errors.push(`Password must be at least ${p.minLength} characters`);
    if ((password.match(/\d/g) ?? []).length < p.minDigits) errors.push(`Password must contain at least ${p.minDigits} digit(s)`);
    if ((password.match(/[a-z]/g) ?? []).length < p.minLower) errors.push(`Password must contain at least ${p.minLower} lowercase letter(s)`);
    if ((password.match(/[A-Z]/g) ?? []).length < p.minUpper) errors.push(`Password must contain at least ${p.minUpper} uppercase letter(s)`);
    if ((password.match(/[^a-zA-Z0-9]/g) ?? []).length < p.minNonAlnum) errors.push(`Password must contain at least ${p.minNonAlnum} non-alphanumeric character(s)`);
    return errors;
  }
  /**
   * Băm mật khẩu bằng bcrypt trước khi lưu.
   */
  async hash(password: string): Promise<string> { return argon2.hash(password, { type: argon2.argon2id }); }
  /**
   * So khớp mật khẩu thô với hash đã lưu.
   */
  async verify(hash: string, password: string): Promise<boolean> {
    try { return await argon2.verify(hash, password); } catch { return false; }
  }
}
