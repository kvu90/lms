import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, like, or, sql } from 'drizzle-orm';
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
  async getCategory(id: number): Promise<CategoryRow | undefined> {
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
  async childrenOf(parent: number): Promise<CategoryRow[]> {
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
  async updateCategory(id: number, v: Partial<typeof courseCategories.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(courseCategories).set({ ...v, timemodified: new Date() }).where(eq(courseCategories.id, id));
  }
  /**
   * Viết lại path/depth khi di chuyển category.
   */
  async updateCategoryPath(id: number, path: string, depth: number): Promise<void> {
    await this.db.update(courseCategories).set({ path, depth }).where(eq(courseCategories.id, id));
  }
  /**
   * Xoá category.
   */
  async deleteCategory(id: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(courseCategories).where(eq(courseCategories.id, id));
  }
  /**
   * Số category anh em (phục vụ sortorder).
   */
  async countSiblingCategories(parent: number): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(courseCategories).where(eq(courseCategories.parent, parent));
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
  async getCourse(id: number): Promise<CourseRow | undefined> {
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
  async listCourses(categoryId?: number): Promise<CourseRow[]> {
    return this.db.select().from(course)
      .where(categoryId !== undefined ? eq(course.category, categoryId) : undefined)
      .orderBy(asc(course.sortorder), asc(course.id));
  }
  /**
   * Khoá học thuộc các category cho trước.
   */
  async listCoursesInCategories(categoryIds: number[]): Promise<CourseRow[]> {
    if (!categoryIds.length) return [];
    const rows: CourseRow[] = [];
    for (const id of categoryIds) rows.push(...(await this.listCourses(id)));
    return rows;
  }
  /**
   * Cập nhật khoá học.
   */
  async updateCourse(id: number, v: Partial<typeof course.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(course).set({ ...v, timemodified: new Date() }).where(eq(course.id, id));
  }
  /**
   * Xoá khoá học.
   */
  async deleteCourse(id: number, tx?: DbTx): Promise<void> {
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
  async getSection(id: number): Promise<SectionRow | undefined> {
    const [row] = await this.db.select().from(courseSections).where(eq(courseSections.id, id)); return row;
  }
  /**
   * Liệt kê section của khoá học theo thứ tự.
   */
  async listSections(courseId: number): Promise<SectionRow[]> {
    return this.db.select().from(courseSections).where(eq(courseSections.course, courseId)).orderBy(asc(courseSections.section));
  }
  /**
   * Cập nhật section (tên, summary, availability JSON).
   */
  async updateSection(id: number, v: Partial<typeof courseSections.$inferInsert>): Promise<void> {
    await this.db.update(courseSections).set({ ...v, timemodified: new Date() }).where(eq(courseSections.id, id));
  }
  /**
   * Xoá section.
   */
  async deleteSection(id: number): Promise<void> { await this.db.delete(courseSections).where(eq(courseSections.id, id)); }

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
  async getCm(id: number): Promise<CmRow | undefined> {
    const [row] = await this.db.select().from(courseModules).where(eq(courseModules.id, id)); return row;
  }
  /**
   * Liệt kê mọi cm của khoá học.
   */
  async listCms(courseId: number): Promise<CmRow[]> {
    return this.db.select().from(courseModules).where(and(eq(courseModules.course, courseId), eq(courseModules.deletioninprogress, false))).orderBy(asc(courseModules.id));
  }
  /**
   * Cm trong một section.
   */
  async listCmsInSection(sectionId: number): Promise<CmRow[]> {
    return this.db.select().from(courseModules).where(and(eq(courseModules.section, sectionId), eq(courseModules.deletioninprogress, false))).orderBy(asc(courseModules.id));
  }
  /**
   * Cập nhật cm.
   */
  async updateCm(id: number, v: Partial<typeof courseModules.$inferInsert>): Promise<void> {
    await this.db.update(courseModules).set(v).where(eq(courseModules.id, id));
  }
  /**
   * Xoá cm.
   */
  async deleteCm(id: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(courseModules).where(eq(courseModules.id, id));
  }

  // format options
  /**
   * Ghi một tuỳ chọn định dạng khoá học (format option).
   */
  async setFormatOption(courseid: number, format: string, name: string, value: string | null, sectionid = 0): Promise<void> {
    await this.db.insert(courseFormatOptions).values({ courseid, format, name, value, sectionid })
      .onConflictDoUpdate({ target: [courseFormatOptions.courseid, courseFormatOptions.format, courseFormatOptions.sectionid, courseFormatOptions.name], set: { value } });
  }
  /**
   * Đọc các tuỳ chọn định dạng của khoá học.
   */
  async listFormatOptions(courseid: number): Promise<(typeof courseFormatOptions.$inferSelect)[]> {
    return this.db.select().from(courseFormatOptions).where(eq(courseFormatOptions.courseid, courseid));
  }
}
