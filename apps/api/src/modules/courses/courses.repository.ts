import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, isNull, like, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { course, courseCategories, courseFormatOptions, courseModules, courseSections } from '../../db/schema';

export type CategoryRow = typeof courseCategories.$inferSelect;
export type CourseRow = typeof course.$inferSelect;
export type SectionRow = typeof courseSections.$inferSelect;
export type CmRow = typeof courseModules.$inferSelect;
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
    return this.db.select().from(courseCategories).orderBy(asc(courseCategories.sortorder), asc(courseCategories.id));
  }
  /**
   * Các category con trực tiếp của một category.
   */
  async childrenOf(parent: string): Promise<CategoryRow[]> {
    return this.db.select().from(courseCategories).where(eq(courseCategories.parent, parent)).orderBy(asc(courseCategories.sortorder));
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
    await (tx ?? this.db).update(courseCategories).set({ ...v, timemodified: new Date() }).where(eq(courseCategories.id, id));
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
   * Số category anh em (phục vụ sortorder).
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
   * Lấy khoá học theo shortname duy nhất.
   */
  async getCourseByShortname(shortname: string): Promise<CourseRow | undefined> {
    const [row] = await this.db.select().from(course).where(eq(course.shortname, shortname)); return row;
  }
  /**
   * Liệt kê khoá học.
   */
  async listCourses(categoryId?: string): Promise<CourseRow[]> {
    return this.db.select().from(course)
      .where(categoryId !== undefined ? eq(course.category, categoryId) : undefined)
      .orderBy(asc(course.sortorder), asc(course.id));
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
    await (tx ?? this.db).update(course).set({ ...v, timemodified: new Date() }).where(eq(course.id, id));
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
  async insertSection(v: typeof courseSections.$inferInsert): Promise<SectionRow> {
    const [row] = await this.db.insert(courseSections).values(v).returning(); return row!;
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
    await this.db.update(courseSections).set({ ...v, timemodified: new Date() }).where(eq(courseSections.id, id));
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
    return this.db.select().from(courseModules).where(and(eq(courseModules.course, courseId), eq(courseModules.deletioninprogress, false))).orderBy(asc(courseModules.id));
  }
  /**
   * Cm trong một section.
   */
  async listCmsInSection(sectionId: string): Promise<CmRow[]> {
    return this.db.select().from(courseModules).where(and(eq(courseModules.section, sectionId), eq(courseModules.deletioninprogress, false))).orderBy(asc(courseModules.id));
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
  async setFormatOption(courseid: string, format: string, name: string, value: string | null, sectionid: string | null = null): Promise<void> {
    if (sectionid === null) {
      // sectionid NULL không tham gia unique conflict (NULL luôn khác nhau trong PostgreSQL) nên upsert thủ công cho tuỳ chọn cấp khoá học.
      const [existing] = await this.db.select().from(courseFormatOptions).where(and(
        eq(courseFormatOptions.courseid, courseid), eq(courseFormatOptions.format, format),
        isNull(courseFormatOptions.sectionid), eq(courseFormatOptions.name, name),
      ));
      if (existing) {
        await this.db.update(courseFormatOptions).set({ value }).where(eq(courseFormatOptions.id, existing.id));
        return;
      }
      await this.db.insert(courseFormatOptions).values({ courseid, format, name, value, sectionid });
      return;
    }
    await this.db.insert(courseFormatOptions).values({ courseid, format, name, value, sectionid })
      .onConflictDoUpdate({ target: [courseFormatOptions.courseid, courseFormatOptions.format, courseFormatOptions.sectionid, courseFormatOptions.name], set: { value } });
  }
  /**
   * Đọc các tuỳ chọn định dạng của khoá học.
   */
  async listFormatOptions(courseid: string): Promise<(typeof courseFormatOptions.$inferSelect)[]> {
    return this.db.select().from(courseFormatOptions).where(eq(courseFormatOptions.courseid, courseid));
  }
}
