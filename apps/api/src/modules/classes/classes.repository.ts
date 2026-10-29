import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, count, eq } from 'drizzle-orm';
import type { Database, DbTx } from '../../db/database';
import { classes, classJoinRequests, cohort, course, enrol, userEnrolments } from '../../db/schema';

export type ClassRow = typeof classes.$inferSelect;
export type CohortRow = typeof cohort.$inferSelect;
export type ClassJoinRequestRow = typeof classJoinRequests.$inferSelect;

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

  async insertClass(v: typeof classes.$inferInsert, tx?: DbTx): Promise<ClassRow> {
    const db = tx ?? this.db;
    const [row] = await db.insert(classes).values(v).returning();
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
  async insertBackingCohort(v: typeof cohort.$inferInsert, tx?: DbTx): Promise<CohortRow> {
    const db = tx ?? this.db;
    const [row] = await db.insert(cohort).values(v).returning();
    return row!;
  }

  async updateCohortContext(cohortId: string, contextId: string, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db;
    await db.update(cohort).set({ contextId, updatedAt: new Date() }).where(eq(cohort.id, cohortId));
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
   * Các khoá của lớp mà một học sinh đang ghi danh ACTIVE (status = 0 —
   * `ENROL_ACTIVE` của module enrol; xét mọi instance của khoá, đường
   * chính là instance cohort của lớp). Đình chỉ ở một khoá đặt dòng ghi
   * danh thành SUSPENDED (status = 1) nên khoá đó rơi khỏi tập này —
   * dashboard phía học sinh (CLASS-2) chỉ hiện các khoá trong tập này.
   */
  async listActiveEnrolledCourseIds(classId: string, userId: string): Promise<string[]> {
    const rows = await this.db.selectDistinct({ courseId: enrol.courseId })
      .from(userEnrolments)
      .innerJoin(enrol, eq(enrol.id, userEnrolments.enrolId))
      .innerJoin(course, eq(course.id, enrol.courseId))
      .where(and(eq(course.classId, classId), eq(userEnrolments.userId, userId), eq(userEnrolments.status, 0)));
    return rows.map((r) => r.courseId);
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

  // --- tự báo danh (CLASS-1) ---------------------------------------------------

  /** Lớp theo mã tham gia: `join_code` là unique toàn hệ khi có đặt, nên tra cứu không cần tenant. */
  async getClassByJoinCode(joinCode: string): Promise<ClassRow | undefined> {
    const [row] = await this.db.select().from(classes).where(eq(classes.joinCode, joinCode));
    return row;
  }

  async insertJoinRequest(v: typeof classJoinRequests.$inferInsert): Promise<ClassJoinRequestRow> {
    const [row] = await this.db.insert(classJoinRequests).values(v).returning();
    return row!;
  }

  async getJoinRequest(id: string): Promise<ClassJoinRequestRow | undefined> {
    const [row] = await this.db.select().from(classJoinRequests).where(eq(classJoinRequests.id, id));
    return row;
  }

  /** Yêu cầu đang chờ của một học sinh cho một lớp (unique từng phần ở DB là lưới cuối). */
  async findPendingJoinRequest(classId: string, userId: string): Promise<ClassJoinRequestRow | undefined> {
    const [row] = await this.db.select().from(classJoinRequests)
      .where(and(eq(classJoinRequests.classId, classId), eq(classJoinRequests.userId, userId), eq(classJoinRequests.status, 'pending')));
    return row;
  }

  async listJoinRequests(classId: string, status: string): Promise<ClassJoinRequestRow[]> {
    return this.db.select().from(classJoinRequests)
      .where(and(eq(classJoinRequests.classId, classId), eq(classJoinRequests.status, status)))
      .orderBy(classJoinRequests.createdAt);
  }

  async updateJoinRequest(id: string, patch: Partial<ClassJoinRequestRow>): Promise<void> {
    await this.db.update(classJoinRequests).set({ ...patch, updatedAt: new Date() }).where(eq(classJoinRequests.id, id));
  }

  /**
   * Học sinh đã đình chỉ khỏi lớp: còn dòng ghi danh SUSPENDED (status
   * = 1) trên instance cohort của lớp nhưng KHÔNG còn trong backing
   * cohort — suy ra từ chính vật chất hoá ghi danh, không bảng phụ
   * (roster chỉ có hai trạng thái thuộc/không thuộc, xem hồ sơ mục 4.3).
   */
  async listSuspendedMemberIds(cohortId: string): Promise<string[]> {
    const rows = await this.db.selectDistinct({ userId: userEnrolments.userId })
      .from(userEnrolments)
      .innerJoin(enrol, eq(enrol.id, userEnrolments.enrolId))
      .where(and(eq(enrol.enrol, 'cohort'), eq(enrol.customInt1, cohortId), eq(userEnrolments.status, 1)));
    return rows.map((r) => r.userId);
  }
}
