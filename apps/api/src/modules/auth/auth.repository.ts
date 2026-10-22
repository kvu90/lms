import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, gte, or } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { loginAttempts, refreshTokenFamily } from '../../db/schema';

export type RefreshFamilyRow = typeof refreshTokenFamily.$inferSelect;

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
  async rotateFamily(id: number, currentTokenHash: string, previousTokenHash: string): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ currentTokenHash, previousTokenHash, rotatedAt: new Date() }).where(eq(refreshTokenFamily.id, id));
  }
  /**
   * Thu hồi toàn bộ family (đăng xuất hoặc phát hiện tái sử dụng).
   */
  async revokeFamily(id: number): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ revoked: true }).where(eq(refreshTokenFamily.id, id));
  }
  /**
   * Thu hồi mọi family của user (đổi mật khẩu, đình chỉ).
   */
  async revokeAllForUser(userid: number): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ revoked: true }).where(eq(refreshTokenFamily.userid, userid));
  }
  /**
   * Ghi một lần thử đăng nhập (thành công/thất bại, IP) phục vụ khoá tạm thời.
   */
  async recordAttempt(v: typeof loginAttempts.$inferInsert): Promise<void> { await this.db.insert(loginAttempts).values(v); }
  /** Failed attempts for a user inside the lockout window, newest first. */
  /**
   * Số lần đăng nhập thất bại gần đây của username — đầu vào của chính sách lockout.
   */
  async recentFailedAttempts(userid: number, since: Date): Promise<(typeof loginAttempts.$inferSelect)[]> {
    return this.db.select().from(loginAttempts).where(and(
      eq(loginAttempts.userid, userid), eq(loginAttempts.success, false), gte(loginAttempts.attemptedAt, since),
    )).orderBy(desc(loginAttempts.attemptedAt));
  }
  /**
   * Thời điểm đăng nhập thành công gần nhất.
   */
  async lastSuccessfulAttemptAt(userid: number): Promise<Date | undefined> {
    const [row] = await this.db.select().from(loginAttempts).where(and(
      eq(loginAttempts.userid, userid), eq(loginAttempts.success, true),
    )).orderBy(desc(loginAttempts.attemptedAt)).limit(1);
    return row?.attemptedAt;
  }
}
