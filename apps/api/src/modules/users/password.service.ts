import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

export interface PasswordPolicy { minLength: number; minDigits: number; minLower: number; minUpper: number; minNonAlnum: number }

/** Password hashing (argon2id) + configurable policy (Moodle auth policy — config, never hard-coded rules). */
@Injectable()
export class PasswordService {
  constructor(private readonly config: ConfigService) {}
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
  async hash(password: string): Promise<string> { return argon2.hash(password, { type: argon2.argon2id }); }
  async verify(hash: string, password: string): Promise<boolean> {
    try { return await argon2.verify(hash, password); } catch { return false; }
  }
}
