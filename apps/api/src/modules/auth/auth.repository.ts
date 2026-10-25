import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, gte, or } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { loginAttempts, refreshTokenFamily, userOauthLinks, userTotp } from '../../db/schema';

export type RefreshFamilyRow = typeof refreshTokenFamily.$inferSelect;
export type UserTotpRow = typeof userTotp.$inferSelect;
export type UserOauthLinkRow = typeof userOauthLinks.$inferSelect;

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
  /** Tìm family theo `familyId` (claim `sid` của access token). */
  async getFamilyById(familyId: string): Promise<RefreshFamilyRow | undefined> {
    const [row] = await this.db.select().from(refreshTokenFamily).where(eq(refreshTokenFamily.familyId, familyId));
    return row;
  }

  /** Cập nhật tenant hiệu lực của family (khi refresh phân giải lại tenant). */
  async setFamilyTenant(id: string, tenantId: string): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ tenantId }).where(eq(refreshTokenFamily.id, id));
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
  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ revoked: true }).where(eq(refreshTokenFamily.userId, userId));
  }
  /**
   * Các family đang hiệu lực của user (chưa thu hồi, chưa hết hạn) — nguồn
   * cho danh sách "phiên API" ở trang quản lý phiên của chính user.
   */
  async listActiveFamiliesByUser(userId: string): Promise<RefreshFamilyRow[]> {
    return this.db.select().from(refreshTokenFamily).where(and(
      eq(refreshTokenFamily.userId, userId),
      eq(refreshTokenFamily.revoked, false),
      gte(refreshTokenFamily.expiresAt, new Date()),
    )).orderBy(desc(refreshTokenFamily.createdAt));
  }
  /**
   * Tìm family theo định danh family công khai (`family_id` — cũng là `sid` trong access token).
   */
  async getFamilyByFamilyId(familyId: string): Promise<RefreshFamilyRow | undefined> {
    const [row] = await this.db.select().from(refreshTokenFamily).where(eq(refreshTokenFamily.familyId, familyId));
    return row;
  }
  /**
   * Thu hồi mọi family đang hiệu lực của user ngoại trừ một family giữ lại
   * (phiên hiện tại); trả số family đã thu hồi.
   */
  async revokeOthersForUser(userId: string, keepFamilyId?: string): Promise<number> {
    const active = await this.listActiveFamiliesByUser(userId);
    const targets = active.filter((f) => f.familyId !== keepFamilyId);
    for (const family of targets) await this.revokeFamily(family.id);
    return targets.length;
  }
  // --- OAuth linked logins (auth_oauth2) ------------------------------------
  /**
   * Tạo liên kết đăng nhập ngoài cho user; ràng buộc duy nhất ở DB chặn
   * một tài khoản provider nối hai user hoặc một user hai liên kết/issuer.
   */
  async createOauthLink(v: typeof userOauthLinks.$inferInsert): Promise<UserOauthLinkRow> {
    const [row] = await this.db.insert(userOauthLinks).values(v).returning(); return row!;
  }
  /**
   * Tìm liên kết theo tài khoản provider (issuer + định danh chủ thể) — bước khớp đầu tiên ở callback OAuth.
   */
  async getOauthLinkBySubject(issuer: string, issuerUserId: string): Promise<UserOauthLinkRow | undefined> {
    const [row] = await this.db.select().from(userOauthLinks).where(and(
      eq(userOauthLinks.issuer, issuer), eq(userOauthLinks.issuerUserId, issuerUserId),
    ));
    return row;
  }
  /**
   * Mọi liên kết đăng nhập ngoài của user, cũ nhất trước (trang Linked logins).
   */
  async listOauthLinksByUser(userId: string): Promise<UserOauthLinkRow[]> {
    return this.db.select().from(userOauthLinks)
      .where(eq(userOauthLinks.userId, userId)).orderBy(userOauthLinks.createdAt);
  }
  /**
   * Tìm liên kết theo id (kèm userId ở phía gọi để kiểm tra sở hữu trước khi gỡ).
   */
  async getOauthLinkById(id: string): Promise<UserOauthLinkRow | undefined> {
    const [row] = await this.db.select().from(userOauthLinks).where(eq(userOauthLinks.id, id));
    return row;
  }
  /**
   * Xoá một liên kết đăng nhập ngoài (gỡ liên kết ở trang Linked logins).
   */
  async deleteOauthLink(id: string): Promise<void> {
    await this.db.delete(userOauthLinks).where(eq(userOauthLinks.id, id));
  }
  // --- MFA TOTP ---------------------------------------------------------------
  /**
   * Bản ghi TOTP của user (secret đã mã hoá), hoặc undefined nếu chưa setup.
   */
  async getTotpByUserId(userId: string): Promise<UserTotpRow | undefined> {
    const [row] = await this.db.select().from(userTotp).where(eq(userTotp.userId, userId));
    return row;
  }
  /**
   * Ghi secret TOTP đang chờ xác nhận; setup lại thì thay secret cũ và đưa
   * trạng thái về chưa xác nhận (authenticator cũ ngừng hiệu lực ngay).
   */
  async upsertPendingTotp(userId: string, secretEncrypted: string): Promise<UserTotpRow> {
    const [row] = await this.db.insert(userTotp)
      .values({ userId, secretEncrypted, confirmed: false, confirmedAt: null })
      .onConflictDoUpdate({
        target: userTotp.userId,
        set: { secretEncrypted, confirmed: false, confirmedAt: null, createdAt: new Date() },
      })
      .returning();
    return row!;
  }
  /**
   * Đánh dấu TOTP đã xác nhận (MFA bắt đầu chặn đăng nhập từ đây).
   */
  async confirmTotp(userId: string): Promise<void> {
    await this.db.update(userTotp).set({ confirmed: true, confirmedAt: new Date() }).where(eq(userTotp.userId, userId));
  }
  /**
   * Xoá hẳn bản ghi TOTP của user (user tự tắt bằng mã đúng, hoặc quản trị reset).
   */
  async deleteTotp(userId: string): Promise<void> {
    await this.db.delete(userTotp).where(eq(userTotp.userId, userId));
  }

  /**
   * Ghi một lần thử đăng nhập (thành công/thất bại, IP) phục vụ khoá tạm thời.
   */
  async recordAttempt(v: typeof loginAttempts.$inferInsert): Promise<void> { await this.db.insert(loginAttempts).values(v); }
  /** Failed attempts for a user inside the lockout window, newest first. */
  /**
   * Số lần đăng nhập thất bại gần đây của username — đầu vào của chính sách lockout.
   */
  async recentFailedAttempts(userId: string, since: Date): Promise<(typeof loginAttempts.$inferSelect)[]> {
    return this.db.select().from(loginAttempts).where(and(
      eq(loginAttempts.userId, userId), eq(loginAttempts.success, false), gte(loginAttempts.attemptedAt, since),
    )).orderBy(desc(loginAttempts.attemptedAt));
  }
  /**
   * Thời điểm đăng nhập thành công gần nhất.
   */
  async lastSuccessfulAttemptAt(userId: string): Promise<Date | undefined> {
    const [row] = await this.db.select().from(loginAttempts).where(and(
      eq(loginAttempts.userId, userId), eq(loginAttempts.success, true),
    )).orderBy(desc(loginAttempts.attemptedAt)).limit(1);
    return row?.attemptedAt;
  }
}
