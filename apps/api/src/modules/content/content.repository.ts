import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { courseLastAccess, courseModuleProgress, learningRecords, pages, resources } from '../../db/schema';

export type PageRow = typeof pages.$inferSelect;
export type ResourceRow = typeof resources.$inferSelect;
export type LastAccessRow = typeof courseLastAccess.$inferSelect;
export type ModuleProgressRow = typeof courseModuleProgress.$inferSelect;
export type LearningRecordRow = typeof learningRecords.$inferSelect;

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

  /**
   * Ghi tiến độ xem một mục: percent chỉ TĂNG (giữ giá trị cao nhất đã
   * đạt — ôn lại không bị phạt), vị trí dở dang lấy theo lần báo mới
   * nhất.
   */
  async upsertModuleProgress(userId: string, courseId: string, cmId: string, patch: {
    percent?: number; positionSeconds?: number; page?: number;
  }): Promise<ModuleProgressRow> {
    const existing = await this.getModuleProgress(userId, cmId);
    const percent = Math.max(existing?.percent ?? 0, patch.percent ?? 0);
    const [row] = await this.db.insert(courseModuleProgress)
      .values({
        userId, courseId, cmId, percent,
        positionSeconds: patch.positionSeconds ?? existing?.positionSeconds ?? null,
        page: patch.page ?? existing?.page ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [courseModuleProgress.userId, courseModuleProgress.cmId],
        set: {
          percent,
          positionSeconds: patch.positionSeconds ?? existing?.positionSeconds ?? null,
          page: patch.page ?? existing?.page ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }
  /** Đọc tiến độ xem một mục của một học sinh. */
  async getModuleProgress(userId: string, cmId: string): Promise<ModuleProgressRow | undefined> {
    const [row] = await this.db.select().from(courseModuleProgress)
      .where(eq(courseModuleProgress.cmId, cmId));
    return row && row.userId === userId ? row : undefined;
  }

  /**
   * Ghi bản ghi hồ sơ hoàn thành (chụp tên mục tại thời điểm hoàn
   * thành). Idempotent: lần hoàn thành đầu tiên của mỗi (HS, mục) là
   * bản ghi duy nhất — các lần hoàn thành sau không ghi đè.
   */
  async insertLearningRecord(v: typeof learningRecords.$inferInsert): Promise<void> {
    await this.db.insert(learningRecords).values(v).onConflictDoNothing({
      target: [learningRecords.userId, learningRecords.cmId],
    });
  }
  /** Liệt kê bản ghi hồ sơ hoàn thành của một khoá (cho báo cáo giáo viên). */
  async listLearningRecords(courseId: string): Promise<LearningRecordRow[]> {
    return this.db.select().from(learningRecords).where(eq(learningRecords.courseId, courseId));
  }
}
