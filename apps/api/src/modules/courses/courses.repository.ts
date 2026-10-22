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
export class CoursesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  // categories
  async insertCategory(v: typeof courseCategories.$inferInsert, tx?: DbTx): Promise<CategoryRow> {
    const [row] = await (tx ?? this.db).insert(courseCategories).values(v).returning(); return row!;
  }
  async getCategory(id: number): Promise<CategoryRow | undefined> {
    const [row] = await this.db.select().from(courseCategories).where(eq(courseCategories.id, id)); return row;
  }
  async listCategories(): Promise<CategoryRow[]> {
    return this.db.select().from(courseCategories).orderBy(asc(courseCategories.sortorder), asc(courseCategories.id));
  }
  async childrenOf(parent: number): Promise<CategoryRow[]> {
    return this.db.select().from(courseCategories).where(eq(courseCategories.parent, parent)).orderBy(asc(courseCategories.sortorder));
  }
  /** Category and all descendants via path prefix (path is like /1/4/9). */
  async subtreeOf(cat: CategoryRow): Promise<CategoryRow[]> {
    return this.db.select().from(courseCategories)
      .where(or(eq(courseCategories.id, cat.id), like(courseCategories.path, `${cat.path}/%`)));
  }
  async updateCategory(id: number, v: Partial<typeof courseCategories.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(courseCategories).set({ ...v, timemodified: new Date() }).where(eq(courseCategories.id, id));
  }
  async updateCategoryPath(id: number, path: string, depth: number): Promise<void> {
    await this.db.update(courseCategories).set({ path, depth }).where(eq(courseCategories.id, id));
  }
  async deleteCategory(id: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(courseCategories).where(eq(courseCategories.id, id));
  }
  async countSiblingCategories(parent: number): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(courseCategories).where(eq(courseCategories.parent, parent));
    return row?.n ?? 0;
  }

  // courses
  async insertCourse(v: typeof course.$inferInsert, tx?: DbTx): Promise<CourseRow> {
    const [row] = await (tx ?? this.db).insert(course).values(v).returning(); return row!;
  }
  async getCourse(id: number): Promise<CourseRow | undefined> {
    const [row] = await this.db.select().from(course).where(eq(course.id, id)); return row;
  }
  async getCourseByShortname(shortname: string): Promise<CourseRow | undefined> {
    const [row] = await this.db.select().from(course).where(eq(course.shortname, shortname)); return row;
  }
  async listCourses(categoryId?: number): Promise<CourseRow[]> {
    return this.db.select().from(course)
      .where(categoryId !== undefined ? eq(course.category, categoryId) : undefined)
      .orderBy(asc(course.sortorder), asc(course.id));
  }
  async listCoursesInCategories(categoryIds: number[]): Promise<CourseRow[]> {
    if (!categoryIds.length) return [];
    const rows: CourseRow[] = [];
    for (const id of categoryIds) rows.push(...(await this.listCourses(id)));
    return rows;
  }
  async updateCourse(id: number, v: Partial<typeof course.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(course).set({ ...v, timemodified: new Date() }).where(eq(course.id, id));
  }
  async deleteCourse(id: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(course).where(eq(course.id, id));
  }

  // sections
  async insertSection(v: typeof courseSections.$inferInsert): Promise<SectionRow> {
    const [row] = await this.db.insert(courseSections).values(v).returning(); return row!;
  }
  async getSection(id: number): Promise<SectionRow | undefined> {
    const [row] = await this.db.select().from(courseSections).where(eq(courseSections.id, id)); return row;
  }
  async listSections(courseId: number): Promise<SectionRow[]> {
    return this.db.select().from(courseSections).where(eq(courseSections.course, courseId)).orderBy(asc(courseSections.section));
  }
  async updateSection(id: number, v: Partial<typeof courseSections.$inferInsert>): Promise<void> {
    await this.db.update(courseSections).set({ ...v, timemodified: new Date() }).where(eq(courseSections.id, id));
  }
  async deleteSection(id: number): Promise<void> { await this.db.delete(courseSections).where(eq(courseSections.id, id)); }

  // course modules
  async insertCm(v: typeof courseModules.$inferInsert): Promise<CmRow> {
    const [row] = await this.db.insert(courseModules).values(v).returning(); return row!;
  }
  async getCm(id: number): Promise<CmRow | undefined> {
    const [row] = await this.db.select().from(courseModules).where(eq(courseModules.id, id)); return row;
  }
  async listCms(courseId: number): Promise<CmRow[]> {
    return this.db.select().from(courseModules).where(and(eq(courseModules.course, courseId), eq(courseModules.deletioninprogress, false))).orderBy(asc(courseModules.id));
  }
  async listCmsInSection(sectionId: number): Promise<CmRow[]> {
    return this.db.select().from(courseModules).where(and(eq(courseModules.section, sectionId), eq(courseModules.deletioninprogress, false))).orderBy(asc(courseModules.id));
  }
  async updateCm(id: number, v: Partial<typeof courseModules.$inferInsert>): Promise<void> {
    await this.db.update(courseModules).set(v).where(eq(courseModules.id, id));
  }
  async deleteCm(id: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(courseModules).where(eq(courseModules.id, id));
  }

  // format options
  async setFormatOption(courseid: number, format: string, name: string, value: string | null, sectionid = 0): Promise<void> {
    await this.db.insert(courseFormatOptions).values({ courseid, format, name, value, sectionid })
      .onConflictDoUpdate({ target: [courseFormatOptions.courseid, courseFormatOptions.format, courseFormatOptions.sectionid, courseFormatOptions.name], set: { value } });
  }
  async listFormatOptions(courseid: number): Promise<(typeof courseFormatOptions.$inferSelect)[]> {
    return this.db.select().from(courseFormatOptions).where(eq(courseFormatOptions.courseid, courseid));
  }
}
