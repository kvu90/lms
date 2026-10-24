import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { courseLastAccess, pages, resources } from '../../db/schema';

export type PageRow = typeof pages.$inferSelect;
export type ResourceRow = typeof resources.$inferSelect;
export type LastAccessRow = typeof courseLastAccess.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu học liệu: trang đọc (mod_page), tài nguyên (mod_resource)
 * và dấu vết mở học gần nhất (last-access) của học sinh trong khoá.
 */
export class ContentRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /** Chèn trang đọc. */
  async insertPage(v: typeof pages.$inferInsert): Promise<PageRow> {
    const [row] = await this.db.insert(pages).values(v).returning(); return row!;
  }
  /** Lấy trang đọc theo id. */
  async getPage(id: string): Promise<PageRow | undefined> {
    const [row] = await this.db.select().from(pages).where(eq(pages.id, id)); return row;
  }
  /** Liệt kê trang đọc của khoá học. */
  async listPages(courseId: string): Promise<PageRow[]> {
    return this.db.select().from(pages).where(eq(pages.course, courseId)).orderBy(pages.id);
  }
  /** Cập nhật trang đọc. */
  async updatePage(id: string, v: Partial<typeof pages.$inferInsert>): Promise<void> {
    await this.db.update(pages).set({ ...v, updatedAt: new Date() }).where(eq(pages.id, id));
  }
  /** Xoá trang đọc. */
  async deletePage(id: string): Promise<void> {
    await this.db.delete(pages).where(eq(pages.id, id));
  }
  /** Xoá trang đọc theo cm (dọn dẹp khi course module bị xoá). */
  async deletePageByCm(cmId: string): Promise<void> {
    await this.db.delete(pages).where(eq(pages.cmId, cmId));
  }

  /** Chèn tài nguyên. */
  async insertResource(v: typeof resources.$inferInsert): Promise<ResourceRow> {
    const [row] = await this.db.insert(resources).values(v).returning(); return row!;
  }
  /** Lấy tài nguyên theo id. */
  async getResource(id: string): Promise<ResourceRow | undefined> {
    const [row] = await this.db.select().from(resources).where(eq(resources.id, id)); return row;
  }
  /** Liệt kê tài nguyên của khoá học. */
  async listResources(courseId: string): Promise<ResourceRow[]> {
    return this.db.select().from(resources).where(eq(resources.course, courseId)).orderBy(resources.id);
  }
  /** Cập nhật tài nguyên. */
  async updateResource(id: string, v: Partial<typeof resources.$inferInsert>): Promise<void> {
    await this.db.update(resources).set({ ...v, updatedAt: new Date() }).where(eq(resources.id, id));
  }
  /** Xoá tài nguyên. */
  async deleteResource(id: string): Promise<void> {
    await this.db.delete(resources).where(eq(resources.id, id));
  }
  /** Xoá tài nguyên theo cm (dọn dẹp khi course module bị xoá). */
  async deleteResourceByCm(cmId: string): Promise<void> {
    await this.db.delete(resources).where(eq(resources.cmId, cmId));
  }

  /** Ghi/ghi đè dấu vết mở học gần nhất của một học sinh trong một khoá. */
  async upsertLastAccess(userId: string, courseId: string, cmId: string): Promise<LastAccessRow> {
    const [row] = await this.db.insert(courseLastAccess)
      .values({ userId, courseId, cmId, accessedAt: new Date() })
      .onConflictDoUpdate({
        target: [courseLastAccess.userId, courseLastAccess.courseId],
        set: { cmId, accessedAt: new Date() },
      })
      .returning();
    return row!;
  }
  /** Đọc dấu vết mở học gần nhất của một học sinh trong một khoá. */
  async getLastAccess(userId: string, courseId: string): Promise<LastAccessRow | undefined> {
    const rows = await this.db.select().from(courseLastAccess)
      .where(eq(courseLastAccess.userId, userId));
    return rows.find((r) => r.courseId === courseId);
  }
}
