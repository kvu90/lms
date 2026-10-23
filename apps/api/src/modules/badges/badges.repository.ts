import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { badge, badgeCriteria, badgeIssued, badgeManualAward } from '../../db/schema';

export type BadgeRow = typeof badge.$inferSelect;
export type CriteriaRow = typeof badgeCriteria.$inferSelect;
export type IssuedRow = typeof badgeIssued.$inferSelect;
export type ManualAwardRow = typeof badgeManualAward.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu huy hiệu: badge, tiêu chí (criteria), bản ghi cấp phát (issued) và cấp thủ công.
 */
export class BadgesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /**
   * Chèn badge.
   */
  async insertBadge(v: typeof badge.$inferInsert): Promise<BadgeRow> {
    const [row] = await this.db.insert(badge).values(v).returning(); return row!;
  }
  /**
   * Lấy badge theo id.
   */
  async getBadge(id: string): Promise<BadgeRow | undefined> {
    const [row] = await this.db.select().from(badge).where(eq(badge.id, id)); return row;
  }
  /**
   * Liệt kê badge.
   */
  async listBadges(): Promise<BadgeRow[]> {
    return this.db.select().from(badge).orderBy(asc(badge.id));
  }
  /**
   * Cập nhật badge.
   */
  async updateBadge(id: string, patch: Partial<BadgeRow>): Promise<void> {
    await this.db.update(badge).set({ ...patch, updatedAt: new Date() }).where(eq(badge.id, id));
  }

  /**
   * Thêm một tiêu chí vào bộ tiêu chí của badge.
   */
  async insertCriteria(v: typeof badgeCriteria.$inferInsert, tx?: DbTx): Promise<CriteriaRow> {
    const [row] = await (tx ?? this.db).insert(badgeCriteria).values(v).returning(); return row!;
  }
  /**
   * Tiêu chí của badge.
   */
  async listCriteria(badgeId: string): Promise<CriteriaRow[]> {
    return this.db.select().from(badgeCriteria).where(eq(badgeCriteria.badgeId, badgeId)).orderBy(asc(badgeCriteria.id));
  }
  /**
   * Xoá tiêu chí của badge.
   */
  async deleteCriteria(badgeId: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(badgeCriteria).where(eq(badgeCriteria.badgeId, badgeId));
  }

  /**
   * Ghi bản ghi cấp phát huy hiệu cho user.
   */
  async insertIssued(v: typeof badgeIssued.$inferInsert, tx?: DbTx): Promise<IssuedRow> {
    const [row] = await (tx ?? this.db).insert(badgeIssued).values(v)
      .onConflictDoNothing({ target: [badgeIssued.badgeId, badgeIssued.userId] }).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(badgeIssued)
      .where(and(eq(badgeIssued.badgeId, v.badgeId), eq(badgeIssued.userId, v.userId)));
    return existing!;
  }
  /**
   * Lấy bản ghi cấp phát theo id.
   */
  async getIssued(id: string): Promise<IssuedRow | undefined> {
    const [row] = await this.db.select().from(badgeIssued).where(eq(badgeIssued.id, id)); return row;
  }
  /**
   * Tìm bản ghi cấp phát của user cho một badge.
   */
  async findIssued(badgeId: string, userId: string): Promise<IssuedRow | undefined> {
    const [row] = await this.db.select().from(badgeIssued)
      .where(and(eq(badgeIssued.badgeId, badgeId), eq(badgeIssued.userId, userId)));
    return row;
  }
  /**
   * Bản ghi cấp phát của một badge.
   */
  async listIssuedForBadge(badgeId: string): Promise<IssuedRow[]> {
    return this.db.select().from(badgeIssued).where(eq(badgeIssued.badgeId, badgeId)).orderBy(asc(badgeIssued.id));
  }
  /**
   * Huy hiệu đã cấp cho user.
   */
  async listIssuedForUser(userId: string): Promise<IssuedRow[]> {
    return this.db.select().from(badgeIssued).where(eq(badgeIssued.userId, userId)).orderBy(asc(badgeIssued.id));
  }
  /**
   * Số lần badge đã được cấp.
   */
  async countIssued(badgeId: string): Promise<number> {
    const rows = await this.db.select().from(badgeIssued).where(eq(badgeIssued.badgeId, badgeId));
    return rows.length;
  }
  /**
   * Cập nhật bản ghi cấp phát (thu hồi).
   */
  async updateIssued(id: string, patch: Partial<IssuedRow>): Promise<void> {
    await this.db.update(badgeIssued).set(patch).where(eq(badgeIssued.id, id));
  }

  /**
   * Ghi một lần cấp thủ công.
   */
  async insertManualAward(v: typeof badgeManualAward.$inferInsert, tx?: DbTx): Promise<ManualAwardRow> {
    const [row] = await (tx ?? this.db).insert(badgeManualAward).values(v)
      .onConflictDoNothing({ target: [badgeManualAward.badgeId, badgeManualAward.recipientId, badgeManualAward.issuerId] }).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(badgeManualAward)
      .where(and(eq(badgeManualAward.badgeId, v.badgeId), eq(badgeManualAward.recipientId, v.recipientId)));
    return existing!;
  }
  /**
   * Tìm bản ghi cấp thủ công.
   */
  async findManualAward(badgeId: string, recipientId: string): Promise<ManualAwardRow | undefined> {
    const [row] = await this.db.select().from(badgeManualAward)
      .where(and(eq(badgeManualAward.badgeId, badgeId), eq(badgeManualAward.recipientId, recipientId)));
    return row;
  }
}
