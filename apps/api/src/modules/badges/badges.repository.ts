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
export class BadgesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  async insertBadge(v: typeof badge.$inferInsert): Promise<BadgeRow> {
    const [row] = await this.db.insert(badge).values(v).returning(); return row!;
  }
  async getBadge(id: number): Promise<BadgeRow | undefined> {
    const [row] = await this.db.select().from(badge).where(eq(badge.id, id)); return row;
  }
  async listBadges(): Promise<BadgeRow[]> {
    return this.db.select().from(badge).orderBy(asc(badge.id));
  }
  async updateBadge(id: number, patch: Partial<BadgeRow>): Promise<void> {
    await this.db.update(badge).set({ ...patch, timemodified: new Date() }).where(eq(badge.id, id));
  }

  async insertCriteria(v: typeof badgeCriteria.$inferInsert, tx?: DbTx): Promise<CriteriaRow> {
    const [row] = await (tx ?? this.db).insert(badgeCriteria).values(v).returning(); return row!;
  }
  async listCriteria(badgeid: number): Promise<CriteriaRow[]> {
    return this.db.select().from(badgeCriteria).where(eq(badgeCriteria.badgeid, badgeid)).orderBy(asc(badgeCriteria.id));
  }
  async deleteCriteria(badgeid: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(badgeCriteria).where(eq(badgeCriteria.badgeid, badgeid));
  }

  async insertIssued(v: typeof badgeIssued.$inferInsert, tx?: DbTx): Promise<IssuedRow> {
    const [row] = await (tx ?? this.db).insert(badgeIssued).values(v)
      .onConflictDoNothing({ target: [badgeIssued.badgeid, badgeIssued.userid] }).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(badgeIssued)
      .where(and(eq(badgeIssued.badgeid, v.badgeid), eq(badgeIssued.userid, v.userid)));
    return existing!;
  }
  async getIssued(id: number): Promise<IssuedRow | undefined> {
    const [row] = await this.db.select().from(badgeIssued).where(eq(badgeIssued.id, id)); return row;
  }
  async findIssued(badgeid: number, userid: number): Promise<IssuedRow | undefined> {
    const [row] = await this.db.select().from(badgeIssued)
      .where(and(eq(badgeIssued.badgeid, badgeid), eq(badgeIssued.userid, userid)));
    return row;
  }
  async listIssuedForBadge(badgeid: number): Promise<IssuedRow[]> {
    return this.db.select().from(badgeIssued).where(eq(badgeIssued.badgeid, badgeid)).orderBy(asc(badgeIssued.id));
  }
  async listIssuedForUser(userid: number): Promise<IssuedRow[]> {
    return this.db.select().from(badgeIssued).where(eq(badgeIssued.userid, userid)).orderBy(asc(badgeIssued.id));
  }
  async countIssued(badgeid: number): Promise<number> {
    const rows = await this.db.select().from(badgeIssued).where(eq(badgeIssued.badgeid, badgeid));
    return rows.length;
  }
  async updateIssued(id: number, patch: Partial<IssuedRow>): Promise<void> {
    await this.db.update(badgeIssued).set(patch).where(eq(badgeIssued.id, id));
  }

  async insertManualAward(v: typeof badgeManualAward.$inferInsert, tx?: DbTx): Promise<ManualAwardRow> {
    const [row] = await (tx ?? this.db).insert(badgeManualAward).values(v)
      .onConflictDoNothing({ target: [badgeManualAward.badgeid, badgeManualAward.recipientid, badgeManualAward.issuerid] }).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(badgeManualAward)
      .where(and(eq(badgeManualAward.badgeid, v.badgeid), eq(badgeManualAward.recipientid, v.recipientid)));
    return existing!;
  }
  async findManualAward(badgeid: number, recipientid: number): Promise<ManualAwardRow | undefined> {
    const [row] = await this.db.select().from(badgeManualAward)
      .where(and(eq(badgeManualAward.badgeid, badgeid), eq(badgeManualAward.recipientid, recipientid)));
    return row;
  }
}
