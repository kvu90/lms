import { InjectDrizzle } from '@nestjs/drizzle';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { centreIdentity, centreInvites, config } from '../../db/schema';

/**
 * Kho đọc/ghi nhận diện và lời mời của trung tâm (issue #583).
 *
 * Repository này chạy qua handle được định tuyến (routedDatabase):
 * khi service bọc lời gọi trong ngữ cảnh ALS mang `spaceSlug` của
 * trung tâm đã chuẩn bị, mọi truy vấn ở đây đều chạm kho của chính
 * trung tâm đó — kể cả khi trung tâm đang ở kho riêng. Vì vậy
 * repository KHÔNG tự phân giải slug hay tự chuẩn bị kho: việc đó
 * là trách nhiệm của service trước khi gọi vào đây.
 */
@Injectable()
export class CentreIdentityRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Nhận diện hiện tại của tenant trong kho đang được định tuyến. */
  async getIdentity(tenantId: string) {
    const rows = await this.db.select().from(centreIdentity).where(eq(centreIdentity.tenantId, tenantId)).limit(1);
    return rows[0];
  }

  /** Tạo hoặc cập nhật nhận diện của tenant (một dòng duy nhất cho mỗi tenant). */
  async upsertIdentity(tenantId: string, patch: { displayName?: string; logoPath?: string | null; brandColor?: string | null }) {
    const existing = await this.getIdentity(tenantId);
    if (!existing) {
      const [row] = await this.db
        .insert(centreIdentity)
        .values({ tenantId, displayName: patch.displayName ?? '', logoPath: patch.logoPath ?? null, brandColor: patch.brandColor ?? null })
        .returning();
      return row;
    }
    const [row] = await this.db
      .update(centreIdentity)
      .set({
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.logoPath !== undefined ? { logoPath: patch.logoPath } : {}),
        ...(patch.brandColor !== undefined ? { brandColor: patch.brandColor } : {}),
        updatedAt: new Date(),
      })
      .where(eq(centreIdentity.id, existing.id))
      .returning();
    return row;
  }

  /** Lời mời theo hàm băm token (token gốc không bao giờ lưu). */
  async findInviteByTokenHash(tokenHash: string) {
    const rows = await this.db.select().from(centreInvites).where(eq(centreInvites.tokenHash, tokenHash)).limit(1);
    return rows[0];
  }

  /**
   * Đánh dấu lời mời đã dùng — nguyên tử: chỉ thành công khi lời mời
   * vẫn chưa dùng và chưa thu hồi tại thời điểm ghi. Trả về dòng đã
   * đánh dấu, hoặc undefined khi có lượt khác đốt trước (đua).
   */
  async markInviteUsed(id: string) {
    const [row] = await this.db
      .update(centreInvites)
      .set({ usedAt: new Date() })
      .where(and(eq(centreInvites.id, id), isNull(centreInvites.usedAt), isNull(centreInvites.revokedAt)))
      .returning();
    return row;
  }

  /** Thu hồi mọi lời mời đang chờ của một tài khoản (phát hành lại). */
  async revokePendingInvites(userId: string) {
    await this.db
      .update(centreInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(centreInvites.userId, userId), isNull(centreInvites.usedAt), isNull(centreInvites.revokedAt)));
  }

  /**
   * Danh sách quản trị của kho đang được định tuyến, đọc thẳng từ
   * bảng `config` của kho đó. KHÔNG dùng `PermissionEvaluator` ở
   * đây: bộ đánh giá của app được xây với khoá cache gắn theo tên
   * database lúc khởi động (kho chung), nên đọc qua nó cho một kho
   * trung tâm sẽ trả nhầm danh sách cache của kho chung. Đường
   * PATCH nhận diện chỉ quản trị trung tâm mới được gọi, tần suất
   * thấp — đọc thẳng nguồn sự thật là đúng.
   */
  async listSiteAdmins(): Promise<string[]> {
    const rows = await this.db.select().from(config).where(eq(config.key, 'siteadmins')).limit(1);
    const value = rows[0]?.value;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
}
