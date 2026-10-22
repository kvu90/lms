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
  async getBadge(id: number): Promise<BadgeRow | undefined> {
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
  async updateBadge(id: number, patch: Partial<BadgeRow>): Promise<void> {
    await this.db.update(badge).set({ ...patch, timemodified: new Date() }).where(eq(badge.id, id));
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
  async listCriteria(badgeid: number): Promise<CriteriaRow[]> {
    return this.db.select().from(badgeCriteria).where(eq(badgeCriteria.badgeid, badgeid)).orderBy(asc(badgeCriteria.id));
  }
  /**
   * Xoá tiêu chí của badge.
   */
  async deleteCriteria(badgeid: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(badgeCriteria).where(eq(badgeCriteria.badgeid, badgeid));
  }

  /**
   * Ghi bản ghi cấp phát huy hiệu cho user.
   */
  async insertIssued(v: typeof badgeIssued.$inferInsert, tx?: DbTx): Promise<IssuedRow> {
    const [row] = await (tx ?? this.db).insert(badgeIssued).values(v)
      .onConflictDoNothing({ target: [badgeIssued.badgeid, badgeIssued.userid] }).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(badgeIssued)
      .where(and(eq(badgeIssued.badgeid, v.badgeid), eq(badgeIssued.userid, v.userid)));
    return existing!;
  }
  /**
   * Lấy bản ghi cấp phát theo id.
   */
  async getIssued(id: number): Promise<IssuedRow | undefined> {
    const [row] = await this.db.select().from(badgeIssued).where(eq(badgeIssued.id, id)); return row;
  }
  /**
   * Tìm bản ghi cấp phát của user cho một badge.
   */
  async findIssued(badgeid: number, userid: number): Promise<IssuedRow | undefined> {
    const [row] = await this.db.select().from(badgeIssued)
      .where(and(eq(badgeIssued.badgeid, badgeid), eq(badgeIssued.userid, userid)));
    return row;
  }
  /**
   * Bản ghi cấp phát của một badge.
   */
  async listIssuedForBadge(badgeid: number): Promise<IssuedRow[]> {
    return this.db.select().from(badgeIssued).where(eq(badgeIssued.badgeid, badgeid)).orderBy(asc(badgeIssued.id));
  }
  /**
   * Huy hiệu đã cấp cho user.
   */
  async listIssuedForUser(userid: number): Promise<IssuedRow[]> {
    return this.db.select().from(badgeIssued).where(eq(badgeIssued.userid, userid)).orderBy(asc(badgeIssued.id));
  }
  /**
   * Số lần badge đã được cấp.
   */
  async countIssued(badgeid: number): Promise<number> {
    const rows = await this.db.select().from(badgeIssued).where(eq(badgeIssued.badgeid, badgeid));
    return rows.length;
  }
  /**
   * Cập nhật bản ghi cấp phát (thu hồi).
   */
  async updateIssued(id: number, patch: Partial<IssuedRow>): Promise<void> {
    await this.db.update(badgeIssued).set(patch).where(eq(badgeIssued.id, id));
  }

  /**
   * Ghi một lần cấp thủ công.
   */
  async insertManualAward(v: typeof badgeManualAward.$inferInsert, tx?: DbTx): Promise<ManualAwardRow> {
    const [row] = await (tx ?? this.db).insert(badgeManualAward).values(v)
      .onConflictDoNothing({ target: [badgeManualAward.badgeid, badgeManualAward.recipientid, badgeManualAward.issuerid] }).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(badgeManualAward)
      .where(and(eq(badgeManualAward.badgeid, v.badgeid), eq(badgeManualAward.recipientid, v.recipientid)));
    return existing!;
  }
  /**
   * Tìm bản ghi cấp thủ công.
   */
  async findManualAward(badgeid: number, recipientid: number): Promise<ManualAwardRow | undefined> {
    const [row] = await this.db.select().from(badgeManualAward)
      .where(and(eq(badgeManualAward.badgeid, badgeid), eq(badgeManualAward.recipientid, recipientid)));
    return row;
  }
}
