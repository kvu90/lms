import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { userPreferences, users } from '../../db/schema';

export type UserRow = typeof users.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class UsersRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async insertUser(v: typeof users.$inferInsert, tx?: DbTx): Promise<UserRow> {
    const [row] = await (tx ?? this.db).insert(users).values(v).returning(); return row!;
  }
  async updateUser(id: number, v: Partial<typeof users.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(users).set({ ...v, timemodified: new Date() }).where(eq(users.id, id));
  }
  async getById(id: number): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)); return row;
  }
  async getByUsername(username: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.username, username)); return row;
  }
  async getByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)); return row;
  }
  async search(search: string | undefined, page: number, pageSize: number, includeDeleted: boolean): Promise<{ rows: UserRow[]; total: number }> {
    const conds = [];
    if (!includeDeleted) conds.push(eq(users.deleted, false));
    if (search) {
      const pattern = `%${search}%`;
      conds.push(or(ilike(users.username, pattern), ilike(users.email, pattern), ilike(users.firstname, pattern), ilike(users.lastname, pattern)));
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = await this.db.select().from(users).where(where).orderBy(users.id).limit(pageSize).offset((page - 1) * pageSize);
    const [count] = await this.db.select({ n: sql<number>`count(*)::int` }).from(users).where(where);
    return { rows, total: count?.n ?? 0 };
  }
  async setPreference(userid: number, name: string, value: string | null): Promise<void> {
    await this.db.insert(userPreferences).values({ userid, name, value })
      .onConflictDoUpdate({ target: [userPreferences.userid, userPreferences.name], set: { value } });
  }
  async getPreference(userid: number, name: string): Promise<string | null | undefined> {
    const [row] = await this.db.select().from(userPreferences)
      .where(and(eq(userPreferences.userid, userid), eq(userPreferences.name, name)));
    return row?.value;
  }
}
