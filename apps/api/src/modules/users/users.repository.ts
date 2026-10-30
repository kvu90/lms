import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { UserListSortBy, UserListStatus } from '@lms/contracts';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Database, DbTx } from '../../db/database';
import { userPreferences, users } from '../../db/schema';

export type UserRow = typeof users.$inferSelect;

/** Bộ lọc danh sách người dùng: nhóm trạng thái và hợp đồng sắp xếp theo hợp đồng truy vấn ở `@lms/contracts`. */
export interface UserListFilter {
  status?: UserListStatus;
  sortBy?: UserListSortBy;
  sortDirection?: 'asc' | 'desc';
}

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
    await (tx ?? this.db).update(users).set({ ...v, updatedAt: new Date() }).where(eq(users.id, id));
  }
  /**
   * Lấy user theo id.
   */
  async getById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)); return row;
  }
  /**
   * Lấy nhiều user theo danh sách id trong một truy vấn (phục vụ báo cáo/export cần thông tin người học hàng loạt).
   */
  async getByIds(ids: string[]): Promise<UserRow[]> {
    if (!ids.length) return [];
    return this.db.select().from(users).where(inArray(users.id, ids));
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
   * Lọc trạng thái suy ra từ hai cờ của tài khoản: không truyền `status` thì chỉ lấy
   * tài khoản chưa xoá (hành vi vốn có); `active` thêm điều kiện không bị đình chỉ;
   * `suspended` lấy tài khoản chưa xoá đang bị đình chỉ; `deleted` lấy tài khoản đã
   * xoá mềm. Sắp xếp theo hợp đồng đóng ở tầng contracts: không có `sortBy` thì giữ
   * thứ tự theo id; có `sortBy` thì sắp theo trường đó (`name` là firstName rồi
   * lastName) với chiều `sortDirection` (mặc định tăng dần) và luôn neo id tăng
   * dần ở cuối để thứ tự ổn định giữa các trang.
   */
  async search(search: string | undefined, page: number, pageSize: number, filter: UserListFilter = {}): Promise<{ rows: UserRow[]; total: number }> {
    const conds = [];
    if (filter.status === 'deleted') conds.push(eq(users.deleted, true));
    else conds.push(eq(users.deleted, false));
    if (filter.status === 'active') conds.push(eq(users.suspended, false));
    if (filter.status === 'suspended') conds.push(eq(users.suspended, true));
    if (search) {
      const pattern = `%${search}%`;
      conds.push(or(ilike(users.username, pattern), ilike(users.email, pattern), ilike(users.firstName, pattern), ilike(users.lastName, pattern)));
    }
    const where = conds.length ? and(...conds) : undefined;
    const direction = filter.sortDirection === 'desc' ? desc : asc;
    const ordering = filter.sortBy === 'name'
      ? [direction(users.firstName), direction(users.lastName), asc(users.id)]
      : filter.sortBy === 'createdAt'
        ? [direction(users.createdAt), asc(users.id)]
        : filter.sortBy === 'lastLogin'
          ? [direction(users.lastLogin), asc(users.id)]
          : [asc(users.id)];
    const rows = await this.db.select().from(users).where(where).orderBy(...ordering).limit(pageSize).offset((page - 1) * pageSize);
    const [count] = await this.db.select({ n: sql<number>`count(*)::int` }).from(users).where(where);
    return { rows, total: count?.n ?? 0 };
  }
  /**
   * Ghi tuỳ chọn cá nhân của user (upsert theo tên).
   */
  async setPreference(userId: string, name: string, value: string | null): Promise<void> {
    await this.db.insert(userPreferences).values({ userId, name, value })
      .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.name], set: { value } });
  }
  /**
   * Đọc một tuỳ chọn cá nhân; undefined nếu chưa đặt.
   */
  async getPreference(userId: string, name: string): Promise<string | null | undefined> {
    const [row] = await this.db.select().from(userPreferences)
      .where(and(eq(userPreferences.userId, userId), eq(userPreferences.name, name)));
    return row?.value;
  }
}
