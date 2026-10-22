import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { userPreferences, users } from '../../db/schema';

export type UserRow = typeof users.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu người dùng và tuỳ chọn cá nhân (user_preferences).
 */
export class UsersRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  /**
   * Chèn user mới (mật khẩu đã hash ở tầng service).
   */
  async insertUser(v: typeof users.$inferInsert, tx?: DbTx): Promise<UserRow> {
    const [row] = await (tx ?? this.db).insert(users).values(v).returning(); return row!;
  }
  /**
   * Cập nhật các trường hồ sơ của user.
   */
  async updateUser(id: string, v: Partial<typeof users.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(users).set({ ...v, timemodified: new Date() }).where(eq(users.id, id));
  }
  /**
   * Lấy user theo id.
   */
  async getById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)); return row;
  }
  /**
   * Lấy user theo username duy nhất.
   */
  async getByUsername(username: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.username, username)); return row;
  }
  /**
   * Lấy user theo email.
   */
  async getByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)); return row;
  }
  /**
   * Tìm user theo từ khoá (username/email/họ tên) có phân trang — phục vụ trang quản trị.
   */
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
  /**
   * Ghi tuỳ chọn cá nhân của user (upsert theo tên).
   */
  async setPreference(userid: string, name: string, value: string | null): Promise<void> {
    await this.db.insert(userPreferences).values({ userid, name, value })
      .onConflictDoUpdate({ target: [userPreferences.userid, userPreferences.name], set: { value } });
  }
  /**
   * Đọc một tuỳ chọn cá nhân; undefined nếu chưa đặt.
   */
  async getPreference(userid: string, name: string): Promise<string | null | undefined> {
    const [row] = await this.db.select().from(userPreferences)
      .where(and(eq(userPreferences.userid, userid), eq(userPreferences.name, name)));
    return row?.value;
  }
}
