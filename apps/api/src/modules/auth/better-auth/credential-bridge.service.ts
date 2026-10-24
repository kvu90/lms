import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { makeSignature } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../db/database';
import { users } from '../../users/schema';
import { authAccount } from '../schema';
import { BetterAuthService } from './better-auth.service';

export interface CreateUserWithCredentialInput {
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  password: string;
}

/**
 * Cầu nối credential giữa kho tài khoản nghiệp vụ (`users`) và Better
 * Auth (issue #7). Ba phép toán nền mà Giai đoạn 2 sẽ dùng ở mọi điểm
 * đồng bộ user (admin tạo user, seed lại tại cutover, login-as):
 *
 * - `createUserWithCredential`: tạo CẶP user + account credential. Phát
 *   hiện ở Giai đoạn 0: `internalAdapter.createUser` của 1.7.12 chỉ ghi
 *   bản ghi user, KHÔNG tự tạo account từ trường password — thiếu nửa
 *   sau là user có thật nhưng không bao giờ đăng nhập được.
 * - `linkExistingPasswordHash`: chép nguyên hash argon2id đang nằm ở
 *   `users.password_hash` sang dòng credential của `account` (verify uỷ
 *   thác argon2 nên hash cũ dùng được nguyên trạng).
 * - `createProgrammaticSession`: tạo phiên theo chương trình qua
 *   internalAdapter + giá trị cookie ĐÃ KÝ — nền của login-as (endpoint
 *   có cổng capability thi công ở Giai đoạn 2). Cookie chứa token trần
 *   bị Better Auth từ chối; chữ ký HMAC theo đúng cơ chế của nó.
 */
@Injectable()
export class CredentialBridgeService {
  constructor(
    private readonly betterAuth: BetterAuthService,
    @InjectDrizzle() private readonly db: Database,
  ) {}

  async createUserWithCredential(input: CreateUserWithCredentialInput): Promise<{ id: string }> {
    const auth = this.betterAuth.requireAuth();
    const ctx = await auth.$context;
    // Băm TRƯỚC khi tạo user: chiều hash chạy validatePolicy của dự án,
    // mật khẩu yếu phải bị từ chối trước khi bất kỳ bản ghi nào được ghi
    // (không để lại user mồ côi không credential). Đây cũng là thứ tự
    // của chính luồng sign-up của Better Auth.
    const passwordHash = await ctx.password.hash(input.password);
    // Tham số nguồn tạo user là bắt buộc trong type của 1.7.12: cầu nối
    // này phục vụ các luồng do hệ thống/quản trị khởi tạo nên khai
    // method "admin" (đúng cách plugin admin của chính Better Auth gọi).
    const user = await ctx.internalAdapter.createUser(
      {
        email: input.email,
        name: input.firstName,
        username: input.username,
        emailVerified: false,
      },
      { method: 'admin' },
    );
    // Adapter ánh xạ field `name` của Better Auth lên cột `first_name`;
    // `last_name` là cột nghiệp vụ riêng — ghi thẳng để bản ghi users
    // đầy đủ như mọi user do hệ hiện tại tạo.
    if (input.lastName) {
      await this.db.update(users).set({ lastName: input.lastName }).where(eq(users.id, user.id));
    }
    await ctx.internalAdapter.createAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: passwordHash,
    });
    return { id: user.id };
  }

  /** Chép hash hiện hữu sang account; trả false khi user không có hash (ví dụ user chỉ dùng OAuth) hoặc đã có credential. */
  async linkExistingPasswordHash(userId: string): Promise<boolean> {
    this.betterAuth.requireAuth();
    const [row] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.passwordHash) return false;
    const [existing] = await this.db
      .select({ id: authAccount.id })
      .from(authAccount)
      .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')))
      .limit(1);
    if (existing) return false;
    await this.db.insert(authAccount).values({
      userId,
      providerId: 'credential',
      accountId: userId,
      password: row.passwordHash,
    });
    return true;
  }

  /**
   * Tạo phiên theo chương trình cho user (không qua HTTP đăng nhập) và
   * trả giá trị cookie phiên đã ký để phía gọi đặt lên response — đúng
   * định dạng `token.signature` mà Better Auth chấp nhận.
   */
  async createProgrammaticSession(userId: string): Promise<{
    sessionId: string;
    token: string;
    signedCookieValue: string;
    expiresAt: Date;
  }> {
    const auth = this.betterAuth.requireAuth();
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(userId, false);
    const signature = await makeSignature(session.token, ctx.secret);
    return {
      sessionId: session.id,
      token: session.token,
      signedCookieValue: `${session.token}.${signature}`,
      expiresAt: session.expiresAt,
    };
  }
}
