/** Các bảng của bounded context Access — định nghĩa Drizzle do module access sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Access contexts form a tree (Moodle `context`). Levels: system=10, user=30, coursecat=40, course=50, module=70, block=80. */
export const context = pgTable(
  'context',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    contextlevel: integer('contextlevel').notNull(),
    instanceid: uuid('instanceid'),
    path: text('path').notNull(),
    depth: integer('depth').notNull(),
    locked: boolean('locked').notNull().default(false),
    /** Bumped on any permission-relevant change in this context or a descendant; part of the evaluator cache key. */
    version: integer('version').notNull().default(1),
  },
  (table) => [
      index('context_instanceid_idx').on(table.instanceid),unique('context_level_instance_unique').on(table.contextlevel, table.instanceid)],
);

/** Registered capabilities (Moodle `capabilities`). Definitions live in code; rows are synced at boot/seed. */
export const capabilities = pgTable('capabilities', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().unique(),
  captype: text('captype').notNull().default('write'),
  contextlevel: integer('contextlevel').notNull().default(10),
  component: text('component').notNull().default('core'),
  riskbitmask: integer('riskbitmask').notNull().default(0),
});

/** Roles (Moodle `role`). */
export const role = pgTable('role', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().default(''),
  shortname: text('shortname').notNull().unique(),
  description: text('description').notNull().default(''),
  sortorder: integer('sortorder').notNull().default(0),
  archetype: text('archetype'),
});

/** Role assignments: user holds role at context (Moodle `role_assignments`). */
export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    roleid: uuid('roleid').notNull().references(() => role.id, { onDelete: 'cascade' }),
    userid: uuid('userid').notNull(),
    contextid: uuid('contextid').notNull().references(() => context.id, { onDelete: 'cascade' }),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
    modifierid: uuid('modifierid'),
    component: text('component').notNull().default(''),
    itemid: uuid('itemid'),
  },
  (table) => [
      index('role_assignments_userid_idx').on(table.userid),
      index('role_assignments_contextid_idx').on(table.contextid),
      index('role_assignments_modifierid_idx').on(table.modifierid),
      index('role_assignments_itemid_idx').on(table.itemid),unique('role_assignments_unique').on(table.roleid, table.userid, table.contextid, table.component, table.itemid)],
);

/** Capability overrides per role+context (Moodle `role_capabilities`). permission: -1000 PROHIBIT, -1 PREVENT, 0 INHERIT, 1 ALLOW. */
export const roleCapabilities = pgTable(
  'role_capabilities',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    contextid: uuid('contextid').notNull().references(() => context.id, { onDelete: 'cascade' }),
    roleid: uuid('roleid').notNull().references(() => role.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    permission: integer('permission').notNull(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
    modifierid: uuid('modifierid'),
  },
  (table) => [
      index('role_capabilities_roleid_idx').on(table.roleid),
      index('role_capabilities_modifierid_idx').on(table.modifierid),unique('role_capabilities_unique').on(table.contextid, table.roleid, table.capability)],
);
