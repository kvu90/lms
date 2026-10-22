import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, gte, or } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { loginAttempts, refreshTokenFamily, userTotp } from '../../db/schema';

export type RefreshFamilyRow = typeof refreshTokenFamily.$inferSelect;
export type UserTotpRow = typeof userTotp.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu phiên xác thực: họ refresh token (token family) và nhật ký lần thử đăng nhập.
 * Mô hình family cho phép phát hiện tái sử dụng refresh token: khi một token đã xoay bị dùng lại, toàn bộ family bị thu hồi.
 */
export class AuthRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  /**
   * Tạo family mới cho một lần đăng nhập, lưu hash của refresh token đầu tiên.
   */
  async createFamily(v: typeof refreshTokenFamily.$inferInsert): Promise<RefreshFamilyRow> {
    const [row] = await this.db.insert(refreshTokenFamily).values(v).returning(); return row!;
  }
  /**
   * Tìm family theo hash refresh token.
   */
  async getFamilyByHash(tokenHash: string): Promise<RefreshFamilyRow | undefined> {
    const rows = await this.db.select().from(refreshTokenFamily)
      .where(or(eq(refreshTokenFamily.currentTokenHash, tokenHash), eq(refreshTokenFamily.previousTokenHash, tokenHash)));
    return rows[0];
  }
  /**
   * Xoay family sang refresh token mới (ghi hash mới, đánh dấu hash cũ đã dùng).
   */
  async rotateFamily(id: string, currentTokenHash: string, previousTokenHash: string): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ currentTokenHash, previousTokenHash, rotatedAt: new Date() }).where(eq(refreshTokenFamily.id, id));
  }
  /**
   * Thu hồi toàn bộ family (đăng xuất hoặc phát hiện tái sử dụng).
   */
  async revokeFamily(id: string): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ revoked: true }).where(eq(refreshTokenFamily.id, id));
  }
  /**
   * Thu hồi mọi family của user (đổi mật khẩu, đình chỉ).
   */
  async revokeAllForUser(userid: string): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ revoked: true }).where(eq(refreshTokenFamily.userid, userid));
  }
  // --- MFA TOTP ---------------------------------------------------------------
  /**
   * Bản ghi TOTP của user (secret đã mã hoá), hoặc undefined nếu chưa setup.
   */
  async getTotpByUserId(userid: string): Promise<UserTotpRow | undefined> {
    const [row] = await this.db.select().from(userTotp).where(eq(userTotp.userid, userid));
    return row;
  }
  /**
   * Ghi secret TOTP đang chờ xác nhận; setup lại thì thay secret cũ và đưa
   * trạng thái về chưa xác nhận (authenticator cũ ngừng hiệu lực ngay).
   */
  async upsertPendingTotp(userid: string, secretEncrypted: string): Promise<UserTotpRow> {
    const [row] = await this.db.insert(userTotp)
      .values({ userid, secretEncrypted, confirmed: false, confirmedAt: null })
      .onConflictDoUpdate({
        target: userTotp.userid,
        set: { secretEncrypted, confirmed: false, confirmedAt: null, createdAt: new Date() },
      })
      .returning();
    return row!;
  }
  /**
   * Đánh dấu TOTP đã xác nhận (MFA bắt đầu chặn đăng nhập từ đây).
   */
  async confirmTotp(userid: string): Promise<void> {
    await this.db.update(userTotp).set({ confirmed: true, confirmedAt: new Date() }).where(eq(userTotp.userid, userid));
  }
  /**
   * Xoá hẳn bản ghi TOTP của user (user tự tắt bằng mã đúng, hoặc quản trị reset).
   */
  async deleteTotp(userid: string): Promise<void> {
    await this.db.delete(userTotp).where(eq(userTotp.userid, userid));
  }

  /**
   * Ghi một lần thử đăng nhập (thành công/thất bại, IP) phục vụ khoá tạm thời.
   */
  async recordAttempt(v: typeof loginAttempts.$inferInsert): Promise<void> { await this.db.insert(loginAttempts).values(v); }
  /** Failed attempts for a user inside the lockout window, newest first. */
  /**
   * Số lần đăng nhập thất bại gần đây của username — đầu vào của chính sách lockout.
   */
  async recentFailedAttempts(userid: string, since: Date): Promise<(typeof loginAttempts.$inferSelect)[]> {
    return this.db.select().from(loginAttempts).where(and(
      eq(loginAttempts.userid, userid), eq(loginAttempts.success, false), gte(loginAttempts.attemptedAt, since),
    )).orderBy(desc(loginAttempts.attemptedAt));
  }
  /**
   * Thời điểm đăng nhập thành công gần nhất.
   */
  async lastSuccessfulAttemptAt(userid: string): Promise<Date | undefined> {
    const [row] = await this.db.select().from(loginAttempts).where(and(
      eq(loginAttempts.userid, userid), eq(loginAttempts.success, true),
    )).orderBy(desc(loginAttempts.attemptedAt)).limit(1);
    return row?.attemptedAt;
  }
}
