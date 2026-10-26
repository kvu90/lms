import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { BetterAuthOptions } from 'better-auth';
import { makeSignature } from 'better-auth/crypto';
import { createInternalAdapter } from 'better-auth/db';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../db/database';
import { users } from '../../../db/schema';
import { authAccount } from '../../../db/schema';
import { BetterAuthService } from './better-auth.service';

export interface CreateUserWithCredentialInput {
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  password: string;
}

/**
 * Luật username của plugin username chính chủ (Better Auth 1.7.12).
 * Factory của dự án chỉ đặt `displayUsername: false` nên cả ba giá trị
 * đều là mặc định của plugin: dài tối thiểu 3, tối đa 30, chỉ gồm chữ
 * cái, chữ số, `_` và `.` (hàm `defaultUsernameValidator` của plugin).
 */
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 30;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.]+$/;

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
    // forwardRef: vòng import/provider khép kín chỉ xuất hiện khi hai
    // lát GĐ2 gặp nhau — cầu nối → BetterAuthService → LoginLockoutService
    // → UsersService → cầu nối (UsersService đồng bộ credential từ
    // chặng 2.6, LoginLockoutService là của điểm 2.4). Mọi cạnh của
    // vòng đều khai forwardRef để metadata không bắt phải tham chiếu
    // chưa nạp tuỳ thứ tự nạp module.
    @Inject(forwardRef(() => BetterAuthService))
    private readonly betterAuth: BetterAuthService,
    @InjectDrizzle() private readonly db: Database,
  ) {}

  /**
   * Tự thực thi phần hiệu lực của database hook `user.create.before`
   * của plugin username — phần bị rơi khi dựng internalAdapter trong
   * transaction (xem ghi chú tại `createUserWithCredential`). Cùng thứ
   * tự kiểm của plugin: quá ngắn → quá dài → sai định dạng → trùng.
   * Kiểm trùng chạy trên username ĐÃ HẠ THƯỜNG (dạng chuẩn hoá mà
   * plugin lưu); UNIQUE trên `users.username` vẫn là vòng gác cuối
   * cho các lời gọi đồng thời lọt qua tiền kiểm này.
   */
  private async assertUsernameAllowed(username: string): Promise<void> {
    if (username.length < USERNAME_MIN_LENGTH) {
      throw new Error(
        `username quá ngắn: tối thiểu ${USERNAME_MIN_LENGTH} ký tự theo luật plugin username của Better Auth`,
      );
    }
    if (username.length > USERNAME_MAX_LENGTH) {
      throw new Error(
        `username quá dài: tối đa ${USERNAME_MAX_LENGTH} ký tự theo luật plugin username của Better Auth`,
      );
    }
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error(
        'username không hợp lệ: chỉ chấp nhận chữ cái, chữ số, dấu "_" và "." theo luật plugin username của Better Auth',
      );
    }
    const [existing] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username.toLowerCase()))
      .limit(1);
    if (existing) {
      throw new Error(`username đã được sử dụng: "${username.toLowerCase()}" đã tồn tại`);
    }
  }

  async createUserWithCredential(input: CreateUserWithCredentialInput): Promise<{ id: string }> {
    // Validate username TRƯỚC mọi lần ghi và trước cả bước băm: đây là
    // phần hook của plugin username mà đường giao dịch dưới đây không
    // mang theo (xem ghi chú dài tại khối transaction).
    await this.assertUsernameAllowed(input.username);
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
    // giao dịch được dựng bằng chính `createInternalAdapter` của
    // Better Auth với options/logger/generateId của context.
    //
    // NHƯNG nó KHÔNG tương đương internalAdapter thường của lõi ở
    // phần hooks — điểm chặn do đội đánh giá chỉ ra ở vòng review của
    // điểm 2.1: lõi gom database hooks từ `init` của mọi plugin (gồm
    // hook `user.create.before` của plugin username) ở bước
    // runPluginInit rồi mới truyền cho internalAdapter thường, còn
    // plugin hooks KHÔNG nằm trong `ctx.options.databaseHooks` (ở
    // 1.7.12 chúng cũng không lộ ra trên ctx qua API công khai nào)
    // nên internalAdapter giao dịch ở đây chạy với hooks = [] cộng
    // hooks tự khai của factory nếu có — dự án không khai hook nào,
    // tức thực tế là 0 hook. Hệ quả: validator username của plugin
    // không chạy trên đường này. Cầu nối tự thực thi phần hook đó
    // TRƯỚC transaction (assertUsernameAllowed ở đầu hàm này: độ dài +
    // định dạng + trùng theo đúng luật plugin). Phần còn lại của hook
    // không cần làm lại: chuẩn hoá hạ thường username là transform ở
    // tầng schema field của plugin, adapter áp cho mọi lần ghi kể cả
    // qua adapter giao dịch. Thiếu transaction thật thì ném lỗi ngay
    // thay vì âm thầm quay về hai lần ghi rời nhau.
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
      //
      // BA-1 — CHỐT SEMANTICS revokeUnprovenAccountAccess (comment
      // 6405565755 trên #7): user do cầu nối tạo được tạo với
      // emailVerified = true. Lý do: đăng ký tự do đã đóng
      // (disableSignUp), nên mọi user trong hệ đều do một bên tin cậy
      // (quản trị/hệ thống) tạo cho một mailbox đã biết — chính việc
      // tạo đó đã là khẳng định quyền sở hữu mailbox, không phải một
      // email tự khai chưa chứng minh. Giữ `false` thì lần đăng nhập
      // OTP đầu tiên của user sẽ chạy revokeUnprovenAccountAccess của
      // Better Auth: XOÁ toàn bộ account (kể cả credential mật khẩu
      // vừa migrate) + mọi phiên rồi mới đánh dấu verified — mất
      // credential đã migrate, trái mục đích của cầu nối. Với `true`,
      // đường revoke thành no-op cho mọi user do hệ tạo (nó early-return
      // khi emailVerified đã true); semantics xoá chỉ còn áp cho hàng
      // tự khai chưa chứng minh — loại hàng mà hệ đã đóng đường tạo.
      const created = await txInternalAdapter.createUser(
        {
          email: input.email,
          name: input.firstName,
          username: input.username,
          emailVerified: true,
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
    if (inserted.length === 0) return false;
    // BA-1 — cùng chốt semantics như createUserWithCredential: việc
    // hệ thống/quản trị chép hash mật khẩu hiện hữu sang credential
    // là khẳng định quyền sở hữu mailbox cho user đó (chỉ bên giữ hash
    // mới làm được), nên lần liên kết thành công cũng đánh dấu
    // email_verified = true — nếu không, lần đăng nhập OTP đầu tiên
    // sẽ chạy revokeUnprovenAccountAccess và xoá chính credential
    // vừa liên kết. Chỉ liên kết thành công mới đổi cờ (đường đã có
    // credential từ trước trả false và không ghi gì thêm).
    await this.db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));
    return true;
  }

  /**
   * Đồng bộ dòng credential trong `account` theo hash HIỆN HÀNH ở
   * `users.password_hash` (chặng 2.6 của issue #7 — điểm nối duy nhất
   * mà module users gọi sau mỗi lần ghi mật khẩu phía hệ cũ: tạo user,
   * admin đặt lại mật khẩu, user tự đổi mật khẩu qua đường cũ; quy
   * trình seed cũng gọi cho các tài khoản mẫu). Khác
   * `linkExistingPasswordHash` ở hai điểm: (1) Better Auth đang TẮT
   * thì đây là no-op trả `false` — hệ cũ là nguồn duy nhất, không
   * phải lỗi; (2) đã có dòng credential thì CẬP NHẬT `password` của
   * nó theo hash mới (link chỉ chèn khi chưa có). Chưa có thì chèn
   * idempotent trên UNIQUE (user_id, provider_id) như link. User
   * không có hash (chỉ OAuth/guest) → `false`, không tạo credential
   * rỗng. Trả `true` khi có một lần ghi thật (chèn hoặc cập nhật).
   */
  async syncCredentialPassword(userId: string): Promise<boolean> {
    if (!this.betterAuth.auth) return false;
    const [row] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.passwordHash) return false;
    const [existing] = await this.db
      .select({ id: authAccount.id, password: authAccount.password })
      .from(authAccount)
      .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')))
      .limit(1);
    if (existing) {
      if (existing.password === row.passwordHash) return false;
      await this.db
        .update(authAccount)
        .set({ password: row.passwordHash, updatedAt: new Date() })
        .where(eq(authAccount.id, existing.id));
      return true;
    }
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
