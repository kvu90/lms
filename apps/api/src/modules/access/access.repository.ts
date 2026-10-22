import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { capabilities, config, context, role, roleAssignments, roleCapabilities } from '../../db/schema';

export type ContextRow = typeof context.$inferSelect;
export type RoleRow = typeof role.$inferSelect;

/** Data access for the Access module only — other modules must use the Access facade services. */
@Injectable()
export class AccessRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  // --- contexts -----------------------------------------------------------
  async insertContext(values: typeof context.$inferInsert): Promise<ContextRow> {
    const [row] = await this.db.insert(context).values(values).returning();
    return row!;
  }
  async updateContextPath(id: number, path: string, depth: number): Promise<void> {
    await this.db.update(context).set({ path, depth }).where(eq(context.id, id));
  }
  async getContextById(id: number): Promise<ContextRow | undefined> {
    const [row] = await this.db.select().from(context).where(eq(context.id, id));
    return row;
  }
  async getContextByLevelInstance(contextlevel: number, instanceid: number): Promise<ContextRow | undefined> {
    const [row] = await this.db.select().from(context)
      .where(and(eq(context.contextlevel, contextlevel), eq(context.instanceid, instanceid)));
    return row;
  }
  async getContextsByIds(ids: number[]): Promise<ContextRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(context).where(inArray(context.id, ids));
  }
  async listContexts(): Promise<ContextRow[]> {
    return this.db.select().from(context).orderBy(context.path);
  }
  async deleteContext(id: number): Promise<void> {
    await this.db.delete(context).where(eq(context.id, id));
  }
  /** Bump `version` for a context and every descendant (path prefix) — the dirty-marking behind evaluator cache invalidation. */
  async bumpContextVersions(pathPrefix: string): Promise<void> {
    await this.db.update(context).set({ version: sql`${context.version} + 1` })
      .where(or(eq(context.path, pathPrefix), like(context.path, `${pathPrefix}/%`)));
  }

  // --- capabilities ---------------------------------------------------------
  async upsertCapability(def: { name: string; captype: string; contextlevel: number; component: string }): Promise<void> {
    await this.db.insert(capabilities).values(def)
      .onConflictDoUpdate({ target: capabilities.name, set: { captype: def.captype, contextlevel: def.contextlevel, component: def.component } });
  }
  async listCapabilities(): Promise<(typeof capabilities.$inferSelect)[]> {
    return this.db.select().from(capabilities).orderBy(capabilities.name);
  }

  // --- roles ----------------------------------------------------------------
  async insertRole(values: typeof role.$inferInsert): Promise<RoleRow> {
    const [row] = await this.db.insert(role).values(values).returning();
    return row!;
  }
  async getRoleById(id: number): Promise<RoleRow | undefined> {
    const [row] = await this.db.select().from(role).where(eq(role.id, id));
    return row;
  }
  async getRoleByShortname(shortname: string): Promise<RoleRow | undefined> {
    const [row] = await this.db.select().from(role).where(eq(role.shortname, shortname));
    return row;
  }
  async listRoles(): Promise<RoleRow[]> {
    return this.db.select().from(role).orderBy(role.sortorder);
  }
  async updateRole(id: number, values: Partial<typeof role.$inferInsert>): Promise<void> {
    await this.db.update(role).set(values).where(eq(role.id, id));
  }
  async deleteRole(id: number): Promise<void> {
    await this.db.delete(roleAssignments).where(eq(roleAssignments.roleid, id));
    await this.db.delete(roleCapabilities).where(eq(roleCapabilities.roleid, id));
    await this.db.delete(role).where(eq(role.id, id));
  }

  // --- assignments ------------------------------------------------------------
  async insertAssignment(values: typeof roleAssignments.$inferInsert): Promise<typeof roleAssignments.$inferSelect> {
    const [row] = await this.db.insert(roleAssignments).values(values)
      .onConflictDoNothing().returning();
    if (row) return row;
    const [existing] = await this.db.select().from(roleAssignments).where(and(
      eq(roleAssignments.roleid, values.roleid!), eq(roleAssignments.userid, values.userid!),
      eq(roleAssignments.contextid, values.contextid!)));
    return existing!;
  }
  async deleteAssignment(id: number): Promise<void> {
    await this.db.delete(roleAssignments).where(eq(roleAssignments.id, id));
  }
  async listAssignments(filter: { userid?: number; contextid?: number }): Promise<(typeof roleAssignments.$inferSelect)[]> {
    const conds = [];
    if (filter.userid !== undefined) conds.push(eq(roleAssignments.userid, filter.userid));
    if (filter.contextid !== undefined) conds.push(eq(roleAssignments.contextid, filter.contextid));
    return this.db.select().from(roleAssignments).where(conds.length ? and(...conds) : undefined);
  }
  /** Assignments whose context is on the given ancestor path (ids ordered as supplied). */
  async getAssignmentsForUserInContexts(userid: number, contextIds: number[]): Promise<(typeof roleAssignments.$inferSelect)[]> {
    if (contextIds.length === 0) return [];
    return this.db.select().from(roleAssignments)
      .where(and(eq(roleAssignments.userid, userid), inArray(roleAssignments.contextid, contextIds)));
  }

  // --- capability overrides ---------------------------------------------------
  async upsertRoleCapability(values: typeof roleCapabilities.$inferInsert): Promise<void> {
    await this.db.insert(roleCapabilities).values(values).onConflictDoUpdate({
      target: [roleCapabilities.contextid, roleCapabilities.roleid, roleCapabilities.capability],
      set: { permission: values.permission, timemodified: new Date() },
    });
  }
  async deleteRoleCapability(contextid: number, roleid: number, capability: string): Promise<void> {
    await this.db.delete(roleCapabilities).where(and(
      eq(roleCapabilities.contextid, contextid), eq(roleCapabilities.roleid, roleid),
      eq(roleCapabilities.capability, capability)));
  }
  async getOverridesForRoles(roleIds: number[], capability: string, contextIds: number[]): Promise<(typeof roleCapabilities.$inferSelect)[]> {
    if (roleIds.length === 0 || contextIds.length === 0) return [];
    return this.db.select().from(roleCapabilities).where(and(
      inArray(roleCapabilities.roleid, roleIds),
      eq(roleCapabilities.capability, capability),
      inArray(roleCapabilities.contextid, contextIds)));
  }
  /** Remove a role's seeded default overrides at one context (used by seed to keep archetype defaults in sync with code). */
  async deleteRoleCapabilitiesAtContext(roleid: number, contextid: number, capabilityNames: string[]): Promise<void> {
    await this.db.delete(roleCapabilities).where(and(
      eq(roleCapabilities.roleid, roleid), eq(roleCapabilities.contextid, contextid),
      inArray(roleCapabilities.capability, capabilityNames)));
  }
  async listRoleCapabilities(roleid: number): Promise<(typeof roleCapabilities.$inferSelect)[]> {
    return this.db.select().from(roleCapabilities).where(eq(roleCapabilities.roleid, roleid));
  }

  // --- site config (siteadmins lives in the `config` table, like Moodle $CFG->siteadmins) ---
  async getConfigValue(key: string): Promise<unknown> {
    const [row] = await this.db.select().from(config).where(eq(config.key, key));
    return row?.value;
  }
  async setConfigValue(key: string, value: unknown): Promise<void> {
    await this.db.insert(config).values({ key, value })
      .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: new Date() } });
  }
}
