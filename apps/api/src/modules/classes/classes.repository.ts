import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, count, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { classes, cohort, course, enrol } from '../../db/schema';

export type ClassRow = typeof classes.$inferSelect;
export type CohortRow = typeof cohort.$inferSelect;

/** Nhóm "cả lớp" tự sinh trong mọi khoá thuộc lớp — đích giao mặc định cho hoạt động nhắm cả lớp (issue #184, mục 4.2 của hồ sơ). */
export const CLASS_WHOLE_GROUP_NAME = 'Cả lớp';

/** Component đánh dấu backing cohort do module classes quản (không hiện ở bề mặt quản cohort thủ công). */
export const CLASS_COHORT_COMPONENT = 'class';

@Injectable()
/**
 * Kho dữ liệu lớp học: bảng `classes` + backing cohort + các truy vấn
 * vật chất hoá phía lớp (instance cohort của các khoá trong lớp). Thuần
 * dữ liệu — quyết định quyền nằm ở ClassesService / PermissionEvaluator.
 */
export class ClassesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  get dbHandle(): Database { return this.db; }

  async insertClass(v: typeof classes.$inferInsert): Promise<ClassRow> {
    const [row] = await this.db.insert(classes).values(v).returning();
    return row!;
  }

  async getClass(id: string): Promise<ClassRow | undefined> {
    const [row] = await this.db.select().from(classes).where(eq(classes.id, id));
    return row;
  }

  async getClassByCode(tenantId: string, code: string): Promise<ClassRow | undefined> {
    const [row] = await this.db.select().from(classes)
      .where(and(eq(classes.tenantId, tenantId), eq(classes.code, code)));
    return row;
  }

  async getClassByCohortId(cohortId: string): Promise<ClassRow | undefined> {
    const [row] = await this.db.select().from(classes).where(eq(classes.cohortId, cohortId));
    return row;
  }

  async listClassesByTenant(tenantId: string): Promise<ClassRow[]> {
    return this.db.select().from(classes).where(eq(classes.tenantId, tenantId)).orderBy(classes.createdAt);
  }

  async updateClass(id: string, patch: Partial<ClassRow>): Promise<void> {
    await this.db.update(classes).set({ ...patch, updatedAt: new Date() }).where(eq(classes.id, id));
  }

  async deleteClass(id: string): Promise<void> {
    await this.db.delete(classes).where(eq(classes.id, id));
  }

  /** Backing cohort của lớp: tạo qua kho groups (bảng `cohort` do module groups sở hữu, dùng lại đúng một nguồn sự thật cho roster). */
  async insertBackingCohort(v: typeof cohort.$inferInsert): Promise<CohortRow> {
    const [row] = await this.db.insert(cohort).values(v).returning();
    return row!;
  }

  async updateCohortContext(cohortId: string, contextId: string): Promise<void> {
    await this.db.update(cohort).set({ contextId, updatedAt: new Date() }).where(eq(cohort.id, cohortId));
  }

  async deleteCohort(cohortId: string): Promise<void> {
    await this.db.delete(cohort).where(eq(cohort.id, cohortId));
  }

  /** Số khoá đang thuộc lớp — chốt chặn xoá lớp (FK RESTRICT ở DB là lưới cuối). */
  async countCoursesInClass(classId: string): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(course).where(eq(course.classId, classId));
    return row?.value ?? 0;
  }

  /** Mọi khoá thuộc lớp (gồm cả khoá ẩn — bề mặt lớp là bề mặt quản trị của staff lớp). */
  async listCoursesInClass(classId: string) {
    return this.db.select().from(course).where(eq(course.classId, classId)).orderBy(course.sortOrder);
  }

  /**
   * Đẩy chế độ rời lớp mới xuống `custom_text1` của mọi instance cohort
   * của lớp (các khoá đã tạo trước khi lớp đổi `on_leave` phải theo chế
   * độ hiện hành của lớp, không giữ ảnh chụp lúc tạo khoá).
   */
  async syncOnLeaveToInstances(cohortId: string, onLeave: string): Promise<void> {
    await this.db.update(enrol).set({ customText1: onLeave, updatedAt: new Date() })
      .where(and(eq(enrol.enrol, 'cohort'), eq(enrol.customInt1, cohortId)));
  }
}
