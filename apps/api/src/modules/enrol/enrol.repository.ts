import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { enrol, userEnrolments } from '../../db/schema';

export type EnrolRow = typeof enrol.$inferSelect;
export type UserEnrolmentRow = typeof userEnrolments.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

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
  async getInstance(id: number): Promise<EnrolRow | undefined> {
    const [row] = await this.db.select().from(enrol).where(eq(enrol.id, id)); return row;
  }
  /**
   * Instance của một khoá học.
   */
  async listInstances(courseId: number): Promise<EnrolRow[]> {
    return this.db.select().from(enrol).where(eq(enrol.courseid, courseId)).orderBy(enrol.id);
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
  async listCohortInstances(cohortId: number): Promise<EnrolRow[]> {
    const rows = await this.db.select().from(enrol).where(eq(enrol.enrol, 'cohort'));
    return rows.filter((r) => r.customint1 === cohortId);
  }
  /**
   * Cập nhật instance.
   */
  async updateInstance(id: number, v: Partial<typeof enrol.$inferInsert>): Promise<void> {
    await this.db.update(enrol).set({ ...v, timemodified: new Date() }).where(eq(enrol.id, id));
  }
  /**
   * Xoá instance.
   */
  async deleteInstance(id: number): Promise<void> { await this.db.delete(enrol).where(eq(enrol.id, id)); }

  /**
   * Chèn ghi danh của user.
   */
  async insertUserEnrolment(v: typeof userEnrolments.$inferInsert, tx?: DbTx): Promise<UserEnrolmentRow> {
    const [row] = await (tx ?? this.db).insert(userEnrolments).values(v).returning(); return row!;
  }
  /**
   * Lấy ghi danh theo id.
   */
  async getUserEnrolment(enrolid: number, userid: number): Promise<UserEnrolmentRow | undefined> {
    const [row] = await this.db.select().from(userEnrolments)
      .where(and(eq(userEnrolments.enrolid, enrolid), eq(userEnrolments.userid, userid)));
    return row;
  }
  /**
   * Cập nhật ghi danh (trạng thái, thời hạn).
   */
  async updateUserEnrolment(id: number, v: Partial<typeof userEnrolments.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(userEnrolments).set({ ...v, timemodified: new Date() }).where(eq(userEnrolments.id, id));
  }
  /**
   * Xoá ghi danh.
   */
  async deleteUserEnrolment(id: number): Promise<void> {
    await this.db.delete(userEnrolments).where(eq(userEnrolments.id, id));
  }
  /**
   * Mọi ghi danh trong khoá học.
   */
  async listUserEnrolmentsForCourse(courseId: number): Promise<(UserEnrolmentRow & { enrolMethod: string })[]> {
    const instances = await this.listInstances(courseId);
    if (!instances.length) return [];
    const rows = await this.db.select().from(userEnrolments).where(inArray(userEnrolments.enrolid, instances.map((i) => i.id)));
    const methodById = new Map(instances.map((i) => [i.id, i.enrol]));
    return rows.map((r) => ({ ...r, enrolMethod: methodById.get(r.enrolid) ?? '' }));
  }
  /**
   * Mọi ghi danh của một user.
   */
  async listUserEnrolmentsForUser(userid: number): Promise<UserEnrolmentRow[]> {
    return this.db.select().from(userEnrolments).where(eq(userEnrolments.userid, userid));
  }
  /**
   * Các ghi danh đang hiệu lực nhưng đã quá hạn — đầu vào của tiến trình hết hạn.
   */
  async listExpiredActive(now: Date): Promise<UserEnrolmentRow[]> {
    const rows = await this.db.select().from(userEnrolments).where(eq(userEnrolments.status, 0));
    return rows.filter((r) => r.timeend !== null && r.timeend < now);
  }
}
