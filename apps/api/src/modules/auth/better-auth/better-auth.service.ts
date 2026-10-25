import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../../../db/database';
import { PasswordService } from '../../users/password.service';
import { AuthMailService } from '../../mail/auth-mail.service';
import {
  createBetterAuth,
  type BetterAuthInstance,
  type BetterAuthMcpAsConfig,
} from './better-auth.instance';

/**
 * Chủ sở hữu duy nhất của Better Auth instance trong tiến trình API.
 *
 * Instance tồn tại khi MỘT trong hai cờ bật:
 * - `BETTER_AUTH_ENABLED` (Giai đoạn 1 của issue #7): phiên BA song
 *   song với hệ auth tự viết — `enabled` giữ nguyên nghĩa này, guard
 *   nhận diện cookie và bridge chỉ chạy theo nó.
 * - `MCP_AS_ENABLED` (lát MCP-1, issue #163): instance kiêm máy chủ
 *   OAuth cho MCP — factory compose thêm jwt()/mcp()/cimd() (xem
 *   better-auth.instance.ts). Cờ này KHÔNG chờ cutover GĐ2: AS chỉ cần
 *   phiên BA + bảng users chung mà GĐ1 đã có.
 *
 * Cả hai cờ đều tắt thì service không dựng instance, handler không
 * được mount (main.ts dựa vào `auth !== null`), hành vi của hệ auth
 * hiện tại không đổi. Cờ bật mà thiếu `BETTER_AUTH_SECRET` thì
 * constructor ném lỗi: app từ chối boot thay vì âm thầm chạy một hệ
 * auth thiếu secret.
 */
@Injectable()
export class BetterAuthService {
  readonly enabled: boolean;
  /** Cờ riêng của lát MCP-1: instance có compose máy chủ OAuth hay không. */
  readonly mcpAsEnabled: boolean;
  readonly auth: BetterAuthInstance | null;
  /** Cấu hình AS đã dùng dựng instance (null khi không bật) — RS ở tầng MCP lấy issuer/resource qua đây. */
  readonly mcpAs: BetterAuthMcpAsConfig | null;

  constructor(
    config: ConfigService,
    @InjectDrizzle() db: Database,
    passwordService: PasswordService,
    // Cổng mail auth (chặng 2.5): Nest chích từ MailModule; tham số
    // để tuỳ chọn ở chữ ký để các nơi dựng service tay (unit spec,
    // script) không truyền thì instance chạy không có đường mail —
    // đúng nghĩa "chưa nối mail" của factory, không phải lỗi.
    authMail?: AuthMailService | null,
  ) {
    this.enabled = config.get<boolean>('BETTER_AUTH_ENABLED') ?? false;
    this.mcpAsEnabled = config.get<boolean>('MCP_AS_ENABLED') ?? false;
    if (!this.enabled && !this.mcpAsEnabled) {
      this.auth = null;
      this.mcpAs = null;
      return;
    }
    const secret = config.get<string>('BETTER_AUTH_SECRET');
    if (!secret) {
      throw new Error(
        'BETTER_AUTH_SECRET is required when BETTER_AUTH_ENABLED or MCP_AS_ENABLED is true',
      );
    }
    const baseURL =
      config.get<string>('BETTER_AUTH_URL') ?? `http://localhost:${config.get<number>('PORT') ?? 3000}`;
    const extraOrigins = (config.get<string>('BETTER_AUTH_TRUSTED_ORIGINS') ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    // Resource của MCP phải là URI công khai mà client nhìn thấy (nó
    // trở thành `aud` của access token và đích của PRM): ưu tiên
    // MCP_PUBLIC_BASE_URL — cùng một origin mà mount MCP quảng bá —
    // rồi rơi về origin của BA, cuối cùng là baseURL.
    const mcpPublicBase = (
      config.get<string>('MCP_PUBLIC_BASE_URL') ??
      config.get<string>('BETTER_AUTH_URL') ??
      baseURL
    ).replace(/\/+$/, '');
    this.mcpAs = this.mcpAsEnabled
      ? {
          resource: `${mcpPublicBase}/mcp`,
          loginPage: '/mcp-login',
          consentPage: '/mcp-consent',
        }
      : null;

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
      authMail: authMail ?? null,
      mcpAs: this.mcpAs,
    });
  }

  /** Instance khi có cờ bật; ném lỗi rõ ràng nếu gọi lúc cả hai cờ tắt (lỗi lập trình, không phải lỗi người dùng). */
  requireAuth(): BetterAuthInstance {
    if (!this.auth) {
      throw new Error(
        'Better Auth is not enabled (BETTER_AUTH_ENABLED and MCP_AS_ENABLED are both off)',
      );
    }
    return this.auth;
  }
}
