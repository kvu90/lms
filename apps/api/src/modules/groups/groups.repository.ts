import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { cohort, cohortMembers, courseGroups, groupings, groupingsGroups, groupsMembers } from '../../db/schema';

export type GroupRow = typeof courseGroups.$inferSelect;
export type GroupingRow = typeof groupings.$inferSelect;
export type CohortRow = typeof cohort.$inferSelect;

@Injectable()
export class GroupsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  async insertGroup(v: typeof courseGroups.$inferInsert): Promise<GroupRow> {
    const [row] = await this.db.insert(courseGroups).values(v).returning(); return row!;
  }
  async getGroup(id: number): Promise<GroupRow | undefined> {
    const [row] = await this.db.select().from(courseGroups).where(eq(courseGroups.id, id)); return row;
  }
  async listGroups(courseId: number): Promise<GroupRow[]> {
    return this.db.select().from(courseGroups).where(eq(courseGroups.courseid, courseId)).orderBy(courseGroups.id);
  }
  async updateGroup(id: number, v: Partial<typeof courseGroups.$inferInsert>): Promise<void> {
    await this.db.update(courseGroups).set({ ...v, timemodified: new Date() }).where(eq(courseGroups.id, id));
  }
  async deleteGroup(id: number): Promise<void> { await this.db.delete(courseGroups).where(eq(courseGroups.id, id)); }

  async addMember(groupid: number, userid: number, component = '', itemid = 0): Promise<void> {
    await this.db.insert(groupsMembers).values({ groupid, userid, component, itemid }).onConflictDoNothing();
  }
  async removeMember(groupid: number, userid: number): Promise<void> {
    await this.db.delete(groupsMembers).where(and(eq(groupsMembers.groupid, groupid), eq(groupsMembers.userid, userid)));
  }
  async listMembers(groupid: number): Promise<(typeof groupsMembers.$inferSelect)[]> {
    return this.db.select().from(groupsMembers).where(eq(groupsMembers.groupid, groupid)).orderBy(groupsMembers.id);
  }
  async listMembersOfGroups(groupIds: number[]): Promise<(typeof groupsMembers.$inferSelect)[]> {
    if (!groupIds.length) return [];
    return this.db.select().from(groupsMembers).where(inArray(groupsMembers.groupid, groupIds));
  }
  async groupsOfUser(courseId: number, userid: number): Promise<GroupRow[]> {
    const memberRows = await this.db.select().from(groupsMembers).where(eq(groupsMembers.userid, userid));
    const ids = memberRows.map((m) => m.groupid);
    if (!ids.length) return [];
    const rows = await this.db.select().from(courseGroups).where(and(eq(courseGroups.courseid, courseId), inArray(courseGroups.id, ids)));
    return rows;
  }
  async isMember(groupid: number, userid: number): Promise<boolean> {
    const [row] = await this.db.select().from(groupsMembers).where(and(eq(groupsMembers.groupid, groupid), eq(groupsMembers.userid, userid)));
    return !!row;
  }

  async insertGrouping(v: typeof groupings.$inferInsert): Promise<GroupingRow> {
    const [row] = await this.db.insert(groupings).values(v).returning(); return row!;
  }
  async getGrouping(id: number): Promise<GroupingRow | undefined> {
    const [row] = await this.db.select().from(groupings).where(eq(groupings.id, id)); return row;
  }
  async listGroupings(courseId: number): Promise<GroupingRow[]> {
    return this.db.select().from(groupings).where(eq(groupings.courseid, courseId)).orderBy(groupings.id);
  }
  async deleteGrouping(id: number): Promise<void> { await this.db.delete(groupings).where(eq(groupings.id, id)); }
  async addGroupToGrouping(groupingid: number, groupid: number): Promise<void> {
    await this.db.insert(groupingsGroups).values({ groupingid, groupid }).onConflictDoNothing();
  }
  async removeGroupFromGrouping(groupingid: number, groupid: number): Promise<void> {
    await this.db.delete(groupingsGroups).where(and(eq(groupingsGroups.groupingid, groupingid), eq(groupingsGroups.groupid, groupid)));
  }
  async groupsInGrouping(groupingid: number): Promise<GroupRow[]> {
    const links = await this.db.select().from(groupingsGroups).where(eq(groupingsGroups.groupingid, groupingid));
    if (!links.length) return [];
    return this.db.select().from(courseGroups).where(inArray(courseGroups.id, links.map((l) => l.groupid)));
  }

  async insertCohort(v: typeof cohort.$inferInsert): Promise<CohortRow> {
    const [row] = await this.db.insert(cohort).values(v).returning(); return row!;
  }
  async getCohort(id: number): Promise<CohortRow | undefined> {
    const [row] = await this.db.select().from(cohort).where(eq(cohort.id, id)); return row;
  }
  async listCohorts(): Promise<CohortRow[]> { return this.db.select().from(cohort).orderBy(cohort.id); }
  async updateCohort(id: number, v: Partial<typeof cohort.$inferInsert>): Promise<void> {
    await this.db.update(cohort).set({ ...v, timemodified: new Date() }).where(eq(cohort.id, id));
  }
  async deleteCohort(id: number): Promise<void> { await this.db.delete(cohort).where(eq(cohort.id, id)); }
  async addCohortMember(cohortid: number, userid: number): Promise<boolean> {
    const inserted = await this.db.insert(cohortMembers).values({ cohortid, userid }).onConflictDoNothing().returning();
    return inserted.length > 0;
  }
  async removeCohortMember(cohortid: number, userid: number): Promise<boolean> {
    const deleted = await this.db.delete(cohortMembers).where(and(eq(cohortMembers.cohortid, cohortid), eq(cohortMembers.userid, userid))).returning();
    return deleted.length > 0;
  }
  async listCohortMembers(cohortid: number): Promise<(typeof cohortMembers.$inferSelect)[]> {
    return this.db.select().from(cohortMembers).where(eq(cohortMembers.cohortid, cohortid)).orderBy(cohortMembers.id);
  }
  async isCohortMember(cohortid: number, userid: number): Promise<boolean> {
    const [row] = await this.db.select().from(cohortMembers).where(and(eq(cohortMembers.cohortid, cohortid), eq(cohortMembers.userid, userid)));
    return !!row;
  }
}
