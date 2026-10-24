import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  course, courseCategories, courseFormatOptions, courseModules, courseSectionAnchorOutcomes, courseSectionAnchors,
  courseSections, subjects,
} from '../../db/schema';

export type CategoryRow = typeof courseCategories.$inferSelect;
export type CourseRow = typeof course.$inferSelect;
export type SectionRow = typeof courseSections.$inferSelect;
export type CmRow = typeof courseModules.$inferSelect;
export type SectionAnchorRow = typeof courseSectionAnchors.$inferSelect;
export type SectionAnchorOutcomeRow = typeof courseSectionAnchorOutcomes.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu khoá học: category (cây có path vật chất hoá), course, section, course module (cm) và format options.
 */
export class CoursesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  // categories
  /**
   * Chèn category.
   */
  async insertCategory(v: typeof courseCategories.$inferInsert, tx?: DbTx): Promise<CategoryRow> {
    const [row] = await (tx ?? this.db).insert(courseCategories).values(v).returning(); return row!;
  }
  /**
   * Lấy category theo id.
   */
  async getCategory(id: string): Promise<CategoryRow | undefined> {
    const [row] = await this.db.select().from(courseCategories).where(eq(courseCategories.id, id)); return row;
  }
  /**
   * Liệt kê mọi category.
   */
  async listCategories(): Promise<CategoryRow[]> {
    return this.db.select().from(courseCategories).orderBy(asc(courseCategories.sortOrder), asc(courseCategories.id));
  }
  /**
   * Các category con trực tiếp của một category.
   */
  async childrenOf(parent: string): Promise<CategoryRow[]> {
    return this.db.select().from(courseCategories).where(eq(courseCategories.parent, parent)).orderBy(asc(courseCategories.sortOrder));
  }
  /** Category and all descendants via path prefix (path is like /1/4/9). */
  /**
   * Toàn bộ cây con của một category (theo path).
   */
  async subtreeOf(cat: CategoryRow): Promise<CategoryRow[]> {
    return this.db.select().from(courseCategories)
      .where(or(eq(courseCategories.id, cat.id), like(courseCategories.path, `${cat.path}/%`)));
  }
  /**
   * Cập nhật category.
   */
  async updateCategory(id: string, v: Partial<typeof courseCategories.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(courseCategories).set({ ...v, updatedAt: new Date() }).where(eq(courseCategories.id, id));
  }
  /**
   * Viết lại path/depth khi di chuyển category.
   */
  async updateCategoryPath(id: string, path: string, depth: number): Promise<void> {
    await this.db.update(courseCategories).set({ path, depth }).where(eq(courseCategories.id, id));
  }
  /**
   * Xoá category.
   */
  async deleteCategory(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(courseCategories).where(eq(courseCategories.id, id));
  }
  /**
   * Số category anh em (phục vụ sortOrder).
   */
  async countSiblingCategories(parent: string | null): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(courseCategories).where(parent === null ? isNull(courseCategories.parent) : eq(courseCategories.parent, parent));
    return row?.n ?? 0;
  }

  // courses
  /**
   * Chèn khoá học.
   */
  async insertCourse(v: typeof course.$inferInsert, tx?: DbTx): Promise<CourseRow> {
    const [row] = await (tx ?? this.db).insert(course).values(v).returning(); return row!;
  }
  /**
   * Lấy khoá học theo id.
   */
  async getCourse(id: string): Promise<CourseRow | undefined> {
    const [row] = await this.db.select().from(course).where(eq(course.id, id)); return row;
  }
  /**
   * Lấy khoá học theo shortName duy nhất.
   */
  async getCourseByShortname(shortName: string): Promise<CourseRow | undefined> {
    const [row] = await this.db.select().from(course).where(eq(course.shortName, shortName)); return row;
  }
  /**
   * Liệt kê khoá học.
   */
  async listCourses(categoryId?: string): Promise<CourseRow[]> {
    return this.db.select().from(course)
      .where(categoryId !== undefined ? eq(course.category, categoryId) : undefined)
      .orderBy(asc(course.sortOrder), asc(course.id));
  }
  /**
   * Khoá học thuộc các category cho trước.
   */
  async listCoursesInCategories(categoryIds: string[]): Promise<CourseRow[]> {
    if (!categoryIds.length) return [];
    const rows: CourseRow[] = [];
    for (const id of categoryIds) rows.push(...(await this.listCourses(id)));
    return rows;
  }
  /**
   * Cập nhật khoá học.
   */
  async updateCourse(id: string, v: Partial<typeof course.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(course).set({ ...v, updatedAt: new Date() }).where(eq(course.id, id));
  }
  /**
   * Xoá khoá học.
   */
  async deleteCourse(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(course).where(eq(course.id, id));
  }

  // sections
  /**
   * Chèn section.
   */
  async insertSection(v: typeof courseSections.$inferInsert, tx?: DbTx): Promise<SectionRow> {
    const [row] = await (tx ?? this.db).insert(courseSections).values(v).returning(); return row!;
  }
  /** Lấy môn học theo id (đối chiếu neo môn × khối của khoá — K0a). */
  async getSubjectById(id: string): Promise<{ id: string } | undefined> {
    const [row] = await this.db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, id)); return row;
  }
  /**
   * Dịch số thứ tự của các section từ `fromSection` trở đi trong một
   * khoá (phục vụ chèn khung tại vị trí): cộng `delta` vào số section —
   * lượt chèn chạy hai pass qua vùng đệm lớn để không vi phạm unique
   * (course, section) giữa chừng.
   */
  async shiftSections(tx: DbTx, courseId: string, fromSection: number, delta: number): Promise<void> {
    await tx.update(courseSections)
      .set({ section: sql`${courseSections.section} + ${delta}`, updatedAt: new Date() })
      .where(and(eq(courseSections.course, courseId), sql`${courseSections.section} >= ${fromSection}`));
  }
  /** Ghi neo khung cho một section vừa tạo từ khung chương trình. */
  async insertSectionAnchor(v: typeof courseSectionAnchors.$inferInsert, tx?: DbTx): Promise<SectionAnchorRow> {
    const [row] = await (tx ?? this.db).insert(courseSectionAnchors).values(v).returning(); return row!;
  }
  /** Ghi các YCCĐ chụp kèm một neo khung (đúng thứ tự position truyền vào). */
  async insertSectionAnchorOutcomes(v: (typeof courseSectionAnchorOutcomes.$inferInsert)[], tx?: DbTx): Promise<void> {
    if (v.length === 0) return;
    await (tx ?? this.db).insert(courseSectionAnchorOutcomes).values(v);
  }
  /** Toàn bộ neo khung của nhiều section (dựng khung hiển thị trong nội dung khoá). */
  async listAnchorsForSections(sectionIds: string[]): Promise<SectionAnchorRow[]> {
    if (sectionIds.length === 0) return [];
    return this.db.select().from(courseSectionAnchors).where(inArray(courseSectionAnchors.sectionId, sectionIds));
  }
  /** Toàn bộ YCCĐ chụp của nhiều neo khung, theo position. */
  async listAnchorOutcomes(anchorIds: string[]): Promise<SectionAnchorOutcomeRow[]> {
    if (anchorIds.length === 0) return [];
    return this.db.select().from(courseSectionAnchorOutcomes)
      .where(inArray(courseSectionAnchorOutcomes.anchorId, anchorIds))
      .orderBy(asc(courseSectionAnchorOutcomes.position), asc(courseSectionAnchorOutcomes.createdAt));
  }
  /**
   * Lấy section theo id.
   */
  async getSection(id: string): Promise<SectionRow | undefined> {
    const [row] = await this.db.select().from(courseSections).where(eq(courseSections.id, id)); return row;
  }
  /**
   * Liệt kê section của khoá học theo thứ tự.
   */
  async listSections(courseId: string): Promise<SectionRow[]> {
    return this.db.select().from(courseSections).where(eq(courseSections.course, courseId)).orderBy(asc(courseSections.section));
  }
  /**
   * Cập nhật section (tên, summary, availability JSON).
   */
  async updateSection(id: string, v: Partial<typeof courseSections.$inferInsert>): Promise<void> {
    await this.db.update(courseSections).set({ ...v, updatedAt: new Date() }).where(eq(courseSections.id, id));
  }
  /**
   * Xoá section.
   */
  async deleteSection(id: string): Promise<void> { await this.db.delete(courseSections).where(eq(courseSections.id, id)); }

  // course modules
  /**
   * Chèn course module.
   */
  async insertCm(v: typeof courseModules.$inferInsert): Promise<CmRow> {
    const [row] = await this.db.insert(courseModules).values(v).returning(); return row!;
  }
  /**
   * Lấy cm theo id.
   */
  async getCm(id: string): Promise<CmRow | undefined> {
    const [row] = await this.db.select().from(courseModules).where(eq(courseModules.id, id)); return row;
  }
  /**
   * Liệt kê mọi cm của khoá học.
   */
  async listCms(courseId: string): Promise<CmRow[]> {
    return this.db.select().from(courseModules).where(and(eq(courseModules.course, courseId), eq(courseModules.deletionInProgress, false))).orderBy(asc(courseModules.id));
  }
  /**
   * Cm trong một section.
   */
  async listCmsInSection(sectionId: string): Promise<CmRow[]> {
    return this.db.select().from(courseModules).where(and(eq(courseModules.section, sectionId), eq(courseModules.deletionInProgress, false))).orderBy(asc(courseModules.id));
  }
  /**
   * Cập nhật cm.
   */
  async updateCm(id: string, v: Partial<typeof courseModules.$inferInsert>): Promise<void> {
    await this.db.update(courseModules).set(v).where(eq(courseModules.id, id));
  }
  /**
   * Xoá cm.
   */
  async deleteCm(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(courseModules).where(eq(courseModules.id, id));
  }

  // format options
  /**
   * Ghi một tuỳ chọn định dạng khoá học (format option).
   */
  async setFormatOption(courseId: string, format: string, name: string, value: string | null, sectionId: string | null = null): Promise<void> {
    if (sectionId === null) {
      // sectionId NULL không tham gia unique conflict (NULL luôn khác nhau trong PostgreSQL) nên upsert thủ công cho tuỳ chọn cấp khoá học.
      const [existing] = await this.db.select().from(courseFormatOptions).where(and(
        eq(courseFormatOptions.courseId, courseId), eq(courseFormatOptions.format, format),
        isNull(courseFormatOptions.sectionId), eq(courseFormatOptions.name, name),
      ));
      if (existing) {
        await this.db.update(courseFormatOptions).set({ value }).where(eq(courseFormatOptions.id, existing.id));
        return;
      }
      await this.db.insert(courseFormatOptions).values({ courseId, format, name, value, sectionId });
      return;
    }
    await this.db.insert(courseFormatOptions).values({ courseId, format, name, value, sectionId })
      .onConflictDoUpdate({ target: [courseFormatOptions.courseId, courseFormatOptions.format, courseFormatOptions.sectionId, courseFormatOptions.name], set: { value } });
  }
  /**
   * Đọc các tuỳ chọn định dạng của khoá học.
   */
  async listFormatOptions(courseId: string): Promise<(typeof courseFormatOptions.$inferSelect)[]> {
    return this.db.select().from(courseFormatOptions).where(eq(courseFormatOptions.courseId, courseId));
  }
}
