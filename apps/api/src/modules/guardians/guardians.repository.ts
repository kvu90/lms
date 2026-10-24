import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { guardianLinks } from '../../db/schema';

export type GuardianLinkRow = typeof guardianLinks.$inferSelect;

@Injectable()
/** Kho dữ liệu liên kết giám hộ PH–HS (PH-0, issue #116). */
export class GuardiansRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Chèn một liên kết giám hộ mới. */
  async insertLink(v: typeof guardianLinks.$inferInsert): Promise<GuardianLinkRow> {
    const [row] = await this.db.insert(guardianLinks).values(v).returning(); return row!;
  }
  /** Lấy liên kết theo id. */
  async getLink(id: string): Promise<GuardianLinkRow | undefined> {
    const [row] = await this.db.select().from(guardianLinks).where(eq(guardianLinks.id, id)); return row;
  }
  /** Liên kết đang hiệu lực của đúng một cặp (phụ huynh, học sinh), nếu có. */
  async findActiveLink(guardianUserId: string, studentUserId: string): Promise<GuardianLinkRow | undefined> {
    const [row] = await this.db.select().from(guardianLinks).where(and(
      eq(guardianLinks.guardianUserId, guardianUserId),
      eq(guardianLinks.studentUserId, studentUserId),
      eq(guardianLinks.status, 'active'),
    ));
    return row;
  }
  /** Mọi liên kết (kể cả đã thu hồi) khớp bộ lọc — dùng cho bề mặt quản lý và bề mặt "của tôi". */
  async listLinks(filters: { guardianUserId?: string; studentUserId?: string; status?: string }): Promise<GuardianLinkRow[]> {
    const conds = [];
    if (filters.guardianUserId) conds.push(eq(guardianLinks.guardianUserId, filters.guardianUserId));
    if (filters.studentUserId) conds.push(eq(guardianLinks.studentUserId, filters.studentUserId));
    if (filters.status) conds.push(eq(guardianLinks.status, filters.status));
    return this.db.select().from(guardianLinks)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(guardianLinks.createdAt), asc(guardianLinks.id));
  }
  /** Cập nhật một liên kết (thu hồi). */
  async updateLink(id: string, patch: Partial<GuardianLinkRow>): Promise<void> {
    await this.db.update(guardianLinks).set({ ...patch, updatedAt: new Date() }).where(eq(guardianLinks.id, id));
  }
}
