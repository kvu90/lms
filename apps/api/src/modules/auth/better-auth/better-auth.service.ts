import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../../../db/database';
import { PasswordService } from '../../users/password.service';
import { createBetterAuth, type BetterAuthInstance } from './better-auth.instance';

/**
 * Chủ sở hữu duy nhất của Better Auth instance trong tiến trình API.
 *
 * Toàn bộ nền Better Auth nằm sau cờ `BETTER_AUTH_ENABLED` (mặc định
 * tắt): cờ tắt thì service không dựng instance, handler không được mount
 * (xem main.ts), guard nhận diện cookie bỏ qua ngay từ dòng đầu — hành
 * vi của hệ auth hiện tại không đổi. Cờ bật mà thiếu `BETTER_AUTH_SECRET`
 * thì constructor ném lỗi: app từ chối boot thay vì âm thầm chạy một hệ
 * auth thiếu secret.
 */
@Injectable()
export class BetterAuthService {
  readonly enabled: boolean;
  readonly auth: BetterAuthInstance | null;

  constructor(
    config: ConfigService,
    @InjectDrizzle() db: Database,
    passwordService: PasswordService,
  ) {
    this.enabled = config.get<boolean>('BETTER_AUTH_ENABLED') ?? false;
    if (!this.enabled) {
      this.auth = null;
      return;
    }
    const secret = config.get<string>('BETTER_AUTH_SECRET');
    if (!secret) {
      throw new Error('BETTER_AUTH_SECRET is required when BETTER_AUTH_ENABLED=true');
    }
    const baseURL =
      config.get<string>('BETTER_AUTH_URL') ?? `http://localhost:${config.get<number>('PORT') ?? 3000}`;
    const extraOrigins = (config.get<string>('BETTER_AUTH_TRUSTED_ORIGINS') ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    this.auth = createBetterAuth({
      // Adapter của Better Auth chỉ dùng core query builder trên instance
      // Drizzle (đã kiểm chứng ở Giai đoạn 0) — ép kiểu ở biên DI này là
      // an toàn: instance thật là của app với relations đầy đủ, adapter
      // không chạm tới phần relations.
      db: db as unknown as Parameters<typeof createBetterAuth>[0]['db'],
      secret,
      baseURL,
      trustedOrigins: [...new Set([baseURL, ...extraOrigins])],
      passwordService,
    });
  }

  /** Instance khi cờ bật; ném lỗi rõ ràng nếu gọi lúc cờ tắt (lỗi lập trình, không phải lỗi người dùng). */
  requireAuth(): BetterAuthInstance {
    if (!this.auth) {
      throw new Error('Better Auth is not enabled (BETTER_AUTH_ENABLED is not true)');
    }
    return this.auth;
  }
}
