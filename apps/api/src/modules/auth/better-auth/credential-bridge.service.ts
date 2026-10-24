import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { BetterAuthOptions } from 'better-auth';
import { makeSignature } from 'better-auth/crypto';
import { createInternalAdapter } from 'better-auth/db';
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
 * - `createUserWithCredential`: tạo CẶP user + account credential
 *   trong MỘT transaction của adapter. Phát hiện ở Giai đoạn 0:
 *   `internalAdapter.createUser` của 1.7.12 chỉ ghi bản ghi user,
 *   KHÔNG tự tạo account từ trường password — thiếu nửa sau là user có
 *   thật nhưng không bao giờ đăng nhập được; transaction bọc cả hai
 *   lần ghi để `createAccount` lỗi cũng không để lại user mồ côi.
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
    // Cặp ghi user + account phải NGUYÊN TỬ (điểm giữ lại từ review
    // Giai đoạn 1): hai lần ghi rời nhau thì `createAccount` lỗi giữa
    // chừng để lại user có thật nhưng không credential — không bao giờ
    // đăng nhập được. Adapter Drizzle của instance đã khai
    // `transaction: true` ở factory nên `ctx.adapter.transaction` là
    // transaction PostgreSQL thật; internalAdapter gắn với adapter
    // giao dịch được dựng bằng chính `createInternalAdapter` của Better
    // Auth với cùng options/logger/hooks/generateId của context — đúng
    // cách lõi của nó dựng internalAdapter thường, chỉ khác adapter
    // nền. Thiếu transaction thật thì ném lỗi ngay thay vì âm thầm quay
    // về hai lần ghi rời nhau.
    const adapterTransaction = ctx.adapter.transaction;
    if (!adapterTransaction) {
      throw new Error(
        'Better Auth adapter không có transaction thật (factory phải giữ transaction: true) — createUserWithCredential từ chối chạy không nguyên tử',
      );
    }
    const user = await adapterTransaction(async (trx) => {
      // Ép kiểu ở hai điểm, cả hai đều an toàn tại runtime: `trx` là
      // adapter đầy đủ do factory dựng trên transaction handle (chỉ
      // bị tắt khả năng mở transaction lồng — thứ createInternalAdapter
      // không hề dùng), và `ctx.options` là options đã phân giải của
      // instance (đúng kiểu BetterAuthOptions mà lõi truyền cho
      // internalAdapter của nó, chỉ hẹp hơn ở tầng type do factory của
      // dự án suy luận kiểu trực tiếp từ object literal).
      const txInternalAdapter = createInternalAdapter(
        trx as unknown as Parameters<typeof createInternalAdapter>[0],
        {
          options: ctx.options as BetterAuthOptions,
          logger: ctx.logger,
          hooks: (ctx.options as BetterAuthOptions).databaseHooks
            ? [
                {
                  source: 'user',
                  hooks: (ctx.options as BetterAuthOptions).databaseHooks!,
                },
              ]
            : [],
          generateId: ctx.generateId,
        },
      );
      // Tham số nguồn tạo user là bắt buộc trong type của 1.7.12: cầu
      // nối này phục vụ các luồng do hệ thống/quản trị khởi tạo nên
      // khai method "admin" (đúng cách plugin admin của chính Better
      // Auth gọi).
      const created = await txInternalAdapter.createUser(
        {
          email: input.email,
          name: input.firstName,
          username: input.username,
          emailVerified: false,
        },
        { method: 'admin' },
      );
      await txInternalAdapter.createAccount({
        userId: created.id,
        providerId: 'credential',
        accountId: created.id,
        password: passwordHash,
      });
      return created;
    });
    // Adapter ánh xạ field `name` của Better Auth lên cột `first_name`;
    // `last_name` là cột nghiệp vụ riêng — ghi thẳng để bản ghi users
    // đầy đủ như mọi user do hệ hiện tại tạo. Bước này nằm NGOÀI
    // transaction ở trên vì model user của adapter cố ý không có field
    // lastName để ghi qua adapter (ánh xạ Giai đoạn 1); nếu nó lỗi thì
    // cặp user + credential đã commit nhất quán và user vẫn đăng nhập
    // được — khác hẳn rủi ro mồ côi mà transaction này bịt.
    if (input.lastName) {
      await this.db.update(users).set({ lastName: input.lastName }).where(eq(users.id, user.id));
    }
    return { id: user.id };
  }

  /**
   * Chép hash hiện hữu sang account; trả false khi user không có hash
   * (ví dụ user chỉ dùng OAuth) hoặc đã có credential. Lần chèn cuối là
   * idempotent trên UNIQUE (user_id, provider_id) của bảng account
   * (điểm 2.1 trong hồ sơ Giai đoạn 2): hai lời gọi ĐỒNG THỜI cùng qua
   * được vòng kiểm tra "đã có chưa" ở trên thì vòng chèn cũng chỉ cho
   * đúng một dòng thắng — lời gọi thua nhận `false` thay vì văng lỗi
   * trùng khoá, và tổng số dòng credential của user luôn là một.
   */
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
    const inserted = await this.db
      .insert(authAccount)
      .values({
        userId,
        providerId: 'credential',
        accountId: userId,
        password: row.passwordHash,
      })
      .onConflictDoNothing({ target: [authAccount.userId, authAccount.providerId] })
      .returning({ id: authAccount.id });
    return inserted.length > 0;
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
