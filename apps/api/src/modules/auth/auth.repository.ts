import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, gte, or } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { loginAttempts, refreshTokenFamily } from '../../db/schema';

export type RefreshFamilyRow = typeof refreshTokenFamily.$inferSelect;

@Injectable()
export class AuthRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  async createFamily(v: typeof refreshTokenFamily.$inferInsert): Promise<RefreshFamilyRow> {
    const [row] = await this.db.insert(refreshTokenFamily).values(v).returning(); return row!;
  }
  async getFamilyByHash(tokenHash: string): Promise<RefreshFamilyRow | undefined> {
    const rows = await this.db.select().from(refreshTokenFamily)
      .where(or(eq(refreshTokenFamily.currentTokenHash, tokenHash), eq(refreshTokenFamily.previousTokenHash, tokenHash)));
    return rows[0];
  }
  async rotateFamily(id: number, currentTokenHash: string, previousTokenHash: string): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ currentTokenHash, previousTokenHash, rotatedAt: new Date() }).where(eq(refreshTokenFamily.id, id));
  }
  async revokeFamily(id: number): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ revoked: true }).where(eq(refreshTokenFamily.id, id));
  }
  async revokeAllForUser(userid: number): Promise<void> {
    await this.db.update(refreshTokenFamily).set({ revoked: true }).where(eq(refreshTokenFamily.userid, userid));
  }
  async recordAttempt(v: typeof loginAttempts.$inferInsert): Promise<void> { await this.db.insert(loginAttempts).values(v); }
  /** Failed attempts for a user inside the lockout window, newest first. */
  async recentFailedAttempts(userid: number, since: Date): Promise<(typeof loginAttempts.$inferSelect)[]> {
    return this.db.select().from(loginAttempts).where(and(
      eq(loginAttempts.userid, userid), eq(loginAttempts.success, false), gte(loginAttempts.attemptedAt, since),
    )).orderBy(desc(loginAttempts.attemptedAt));
  }
  async lastSuccessfulAttemptAt(userid: number): Promise<Date | undefined> {
    const [row] = await this.db.select().from(loginAttempts).where(and(
      eq(loginAttempts.userid, userid), eq(loginAttempts.success, true),
    )).orderBy(desc(loginAttempts.attemptedAt)).limit(1);
    return row?.attemptedAt;
  }
}