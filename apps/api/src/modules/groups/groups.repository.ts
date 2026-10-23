import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { cohort, cohortMembers, courseGroups, groupings, groupingsGroups, groupsMembers } from '../../db/schema';

export type GroupRow = typeof courseGroups.$inferSelect;
export type GroupingRow = typeof groupings.$inferSelect;
export type CohortRow = typeof cohort.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu nhóm: group, grouping, thành viên nhóm và cohort (nhóm hệ thống/danh mục).
 */
export class GroupsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /**
   * Chèn nhóm khoá học.
   */
  async insertGroup(v: typeof courseGroups.$inferInsert): Promise<GroupRow> {
    const [row] = await this.db.insert(courseGroups).values(v).returning(); return row!;
  }
  /**
   * Lấy nhóm theo id.
   */
  async getGroup(id: string): Promise<GroupRow | undefined> {
    const [row] = await this.db.select().from(courseGroups).where(eq(courseGroups.id, id)); return row;
  }
  /**
   * Liệt kê nhóm của khoá học.
   */
  async listGroups(courseId: string): Promise<GroupRow[]> {
    return this.db.select().from(courseGroups).where(eq(courseGroups.courseId, courseId)).orderBy(courseGroups.id);
  }
  /**
   * Cập nhật nhóm.
   */
  async updateGroup(id: string, v: Partial<typeof courseGroups.$inferInsert>): Promise<void> {
    await this.db.update(courseGroups).set({ ...v, updatedAt: new Date() }).where(eq(courseGroups.id, id));
  }
  /**
   * Xoá nhóm.
   */
  async deleteGroup(id: string): Promise<void> { await this.db.delete(courseGroups).where(eq(courseGroups.id, id)); }

  /**
   * Thêm thành viên vào nhóm.
   */
  async addMember(groupId: string, userId: string, component = '', itemId: string | null = null): Promise<void> {
    await this.db.insert(groupsMembers).values({ groupId, userId, component, itemId }).onConflictDoNothing();
  }
  /**
   * Gỡ thành viên khỏi nhóm.
   */
  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.db.delete(groupsMembers).where(and(eq(groupsMembers.groupId, groupId), eq(groupsMembers.userId, userId)));
  }
  /**
   * Thành viên của một nhóm.
   */
  async listMembers(groupId: string): Promise<(typeof groupsMembers.$inferSelect)[]> {
    return this.db.select().from(groupsMembers).where(eq(groupsMembers.groupId, groupId)).orderBy(groupsMembers.id);
  }
  /**
   * Thành viên của nhiều nhóm (gộp).
   */
  async listMembersOfGroups(groupIds: string[]): Promise<(typeof groupsMembers.$inferSelect)[]> {
    if (!groupIds.length) return [];
    return this.db.select().from(groupsMembers).where(inArray(groupsMembers.groupId, groupIds));
  }
  /**
   * Các nhóm user thuộc về trong khoá học.
   */
  async groupsOfUser(courseId: string, userId: string): Promise<GroupRow[]> {
    const memberRows = await this.db.select().from(groupsMembers).where(eq(groupsMembers.userId, userId));
    const ids = memberRows.map((m) => m.groupId);
    if (!ids.length) return [];
    const rows = await this.db.select().from(courseGroups).where(and(eq(courseGroups.courseId, courseId), inArray(courseGroups.id, ids)));
    return rows;
  }
  /**
   * User có là thành viên nhóm hay không.
   */
  async isMember(groupId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select().from(groupsMembers).where(and(eq(groupsMembers.groupId, groupId), eq(groupsMembers.userId, userId)));
    return !!row;
  }

  /**
   * Chèn grouping (nhóm của các nhóm).
   */
  async insertGrouping(v: typeof groupings.$inferInsert): Promise<GroupingRow> {
    const [row] = await this.db.insert(groupings).values(v).returning(); return row!;
  }
  /**
   * Lấy grouping theo id.
   */
  async getGrouping(id: string): Promise<GroupingRow | undefined> {
    const [row] = await this.db.select().from(groupings).where(eq(groupings.id, id)); return row;
  }
  /**
   * Liệt kê grouping của khoá học.
   */
  async listGroupings(courseId: string): Promise<GroupingRow[]> {
    return this.db.select().from(groupings).where(eq(groupings.courseId, courseId)).orderBy(groupings.id);
  }
  /**
   * Xoá grouping.
   */
  async deleteGrouping(id: string): Promise<void> { await this.db.delete(groupings).where(eq(groupings.id, id)); }
  /**
   * Đưa nhóm vào grouping.
   */
  async addGroupToGrouping(groupingId: string, groupId: string): Promise<void> {
    await this.db.insert(groupingsGroups).values({ groupingId, groupId }).onConflictDoNothing();
  }
  /**
   * Gỡ nhóm khỏi grouping.
   */
  async removeGroupFromGrouping(groupingId: string, groupId: string): Promise<void> {
    await this.db.delete(groupingsGroups).where(and(eq(groupingsGroups.groupingId, groupingId), eq(groupingsGroups.groupId, groupId)));
  }
  /**
   * Các nhóm thuộc grouping.
   */
  async groupsInGrouping(groupingId: string): Promise<GroupRow[]> {
    const links = await this.db.select().from(groupingsGroups).where(eq(groupingsGroups.groupingId, groupingId));
    if (!links.length) return [];
    return this.db.select().from(courseGroups).where(inArray(courseGroups.id, links.map((l) => l.groupId)));
  }

  /**
   * Chèn cohort.
   */
  async insertCohort(v: typeof cohort.$inferInsert): Promise<CohortRow> {
    const [row] = await this.db.insert(cohort).values(v).returning(); return row!;
  }
  /**
   * Lấy cohort theo id.
   */
  async getCohort(id: string): Promise<CohortRow | undefined> {
    const [row] = await this.db.select().from(cohort).where(eq(cohort.id, id)); return row;
  }
  /**
   * Liệt kê cohort.
   */
  async listCohorts(): Promise<CohortRow[]> { return this.db.select().from(cohort).orderBy(cohort.id); }
  /**
   * Cập nhật cohort.
   */
  async updateCohort(id: string, v: Partial<typeof cohort.$inferInsert>): Promise<void> {
    await this.db.update(cohort).set({ ...v, updatedAt: new Date() }).where(eq(cohort.id, id));
  }
  /**
   * Xoá cohort.
   */
  async deleteCohort(id: string): Promise<void> { await this.db.delete(cohort).where(eq(cohort.id, id)); }
  /**
   * Thêm thành viên cohort.
   */
  async addCohortMember(cohortId: string, userId: string): Promise<boolean> {
    const inserted = await this.db.insert(cohortMembers).values({ cohortId, userId }).onConflictDoNothing().returning();
    return inserted.length > 0;
  }
  /**
   * Gỡ thành viên cohort.
   */
  async removeCohortMember(cohortId: string, userId: string): Promise<boolean> {
    const deleted = await this.db.delete(cohortMembers).where(and(eq(cohortMembers.cohortId, cohortId), eq(cohortMembers.userId, userId))).returning();
    return deleted.length > 0;
  }
  /**
   * Thành viên của cohort.
   */
  async listCohortMembers(cohortId: string): Promise<(typeof cohortMembers.$inferSelect)[]> {
    return this.db.select().from(cohortMembers).where(eq(cohortMembers.cohortId, cohortId)).orderBy(cohortMembers.timeAdded);
  }
  /**
   * User có thuộc cohort hay không.
   */
  async isCohortMember(cohortId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select().from(cohortMembers).where(and(eq(cohortMembers.cohortId, cohortId), eq(cohortMembers.userId, userId)));
    return !!row;
  }
}
