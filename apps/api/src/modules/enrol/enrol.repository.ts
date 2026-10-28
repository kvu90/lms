import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database, DbTx } from '../../db/database';
import { enrol, userEnrolments } from '../../db/schema';

export type EnrolRow = typeof enrol.$inferSelect;
export type UserEnrolmentRow = typeof userEnrolments.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu ghi danh: enrol instance (phương thức ghi danh của khoá học) và user enrolment (ghi danh của từng user).
 */
export class EnrolRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /**
   * Chèn enrol instance.
   */
  async insertInstance(v: typeof enrol.$inferInsert, tx?: DbTx): Promise<EnrolRow> {
    const [row] = await (tx ?? this.db).insert(enrol).values(v).returning(); return row!;
  }
  /**
   * Lấy instance theo id.
   */
  async getInstance(id: string): Promise<EnrolRow | undefined> {
    const [row] = await this.db.select().from(enrol).where(eq(enrol.id, id)); return row;
  }
  /**
   * Instance của một khoá học.
   */
  async listInstances(courseId: string): Promise<EnrolRow[]> {
    return this.db.select().from(enrol).where(eq(enrol.courseId, courseId)).orderBy(enrol.id);
  }
  /**
   * Instance theo phương thức (manual, self, cohort, paypal…).
   */
  async listInstancesByMethod(method: string): Promise<EnrolRow[]> {
    return this.db.select().from(enrol).where(eq(enrol.enrol, method)).orderBy(enrol.id);
  }
  /**
   * Các instance đồng bộ cohort đang trỏ tới một cohort.
   */
  async listCohortInstances(cohortId: string): Promise<EnrolRow[]> {
    const rows = await this.db.select().from(enrol).where(eq(enrol.enrol, 'cohort'));
    return rows.filter((r) => r.customInt1 === cohortId);
  }
  /**
   * Cập nhật instance.
   */
  async updateInstance(id: string, v: Partial<typeof enrol.$inferInsert>): Promise<void> {
    await this.db.update(enrol).set({ ...v, updatedAt: new Date() }).where(eq(enrol.id, id));
  }
  /**
   * Xoá instance.
   */
  async deleteInstance(id: string): Promise<void> { await this.db.delete(enrol).where(eq(enrol.id, id)); }

  /**
   * Chèn ghi danh của user.
   */
  async insertUserEnrolment(v: typeof userEnrolments.$inferInsert, tx?: DbTx): Promise<UserEnrolmentRow> {
    const [row] = await (tx ?? this.db).insert(userEnrolments).values(v).returning(); return row!;
  }
  /**
   * Lấy ghi danh theo id.
   */
  async getUserEnrolment(enrolId: string, userId: string): Promise<UserEnrolmentRow | undefined> {
    const [row] = await this.db.select().from(userEnrolments)
      .where(and(eq(userEnrolments.enrolId, enrolId), eq(userEnrolments.userId, userId)));
    return row;
  }
  /**
   * Cập nhật ghi danh (trạng thái, thời hạn).
   */
  async updateUserEnrolment(id: string, v: Partial<typeof userEnrolments.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(userEnrolments).set({ ...v, updatedAt: new Date() }).where(eq(userEnrolments.id, id));
  }
  /**
   * Xoá ghi danh.
   */
  async deleteUserEnrolment(id: string): Promise<void> {
    await this.db.delete(userEnrolments).where(eq(userEnrolments.id, id));
  }
  /**
   * Mọi ghi danh trong khoá học.
   */
  async listUserEnrolmentsForCourse(courseId: string): Promise<(UserEnrolmentRow & { enrolMethod: string })[]> {
    const instances = await this.listInstances(courseId);
    if (!instances.length) return [];
    const rows = await this.db.select().from(userEnrolments).where(inArray(userEnrolments.enrolId, instances.map((i) => i.id)));
    const methodById = new Map(instances.map((i) => [i.id, i.enrol]));
    return rows.map((r) => ({ ...r, enrolMethod: methodById.get(r.enrolId) ?? '' }));
  }
  /**
   * Mọi ghi danh của một user.
   */
  async listUserEnrolmentsForUser(userId: string): Promise<UserEnrolmentRow[]> {
    return this.db.select().from(userEnrolments).where(eq(userEnrolments.userId, userId));
  }
  /**
   * Mọi ghi danh qua một instance — đầu vào của việc gán lại role khi instance đổi role.
   */
  async listUserEnrolmentsForInstance(enrolId: string): Promise<UserEnrolmentRow[]> {
    return this.db.select().from(userEnrolments).where(eq(userEnrolments.enrolId, enrolId));
  }
  /**
   * Các ghi danh đang hiệu lực nhưng đã quá hạn — đầu vào của tiến trình hết hạn.
   */
  async listExpiredActive(now: Date): Promise<UserEnrolmentRow[]> {
    const rows = await this.db.select().from(userEnrolments).where(eq(userEnrolments.status, 0));
    return rows.filter((r) => r.timeEnd !== null && r.timeEnd < now);
  }
}
