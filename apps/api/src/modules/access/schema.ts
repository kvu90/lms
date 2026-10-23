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
    contextLevel: integer('context_level').notNull(),
    instanceId: uuid('instance_id'),
    path: text('path').notNull(),
    depth: integer('depth').notNull(),
    locked: boolean('locked').notNull().default(false),
    /** Bumped on any permission-relevant change in this context or a descendant; part of the evaluator cache key. */
    version: integer('version').notNull().default(1),
  },
  (table) => [
      index('context_instance_id_idx').on(table.instanceId),unique('context_level_instance_unique').on(table.contextLevel, table.instanceId)],
);

/** Registered capabilities (Moodle `capabilities`). Definitions live in code; rows are synced at boot/seed. */
export const capabilities = pgTable('capabilities', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().unique(),
  capType: text('cap_type').notNull().default('write'),
  contextLevel: integer('context_level').notNull().default(10),
  component: text('component').notNull().default('core'),
  riskBitmask: integer('risk_bitmask').notNull().default(0),
});

/** Roles (Moodle `role`). */
export const role = pgTable('role', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().default(''),
  shortName: text('short_name').notNull().unique(),
  description: text('description').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  archetype: text('archetype'),
});

/** Role assignments: user holds role at context (Moodle `role_assignments`). */
export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    roleId: uuid('role_id').notNull().references(() => role.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    contextId: uuid('context_id').notNull().references(() => context.id, { onDelete: 'cascade' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    modifierId: uuid('modifier_id'),
    component: text('component').notNull().default(''),
    itemId: uuid('item_id'),
  },
  (table) => [
      index('role_assignments_user_id_idx').on(table.userId),
      index('role_assignments_context_id_idx').on(table.contextId),
      index('role_assignments_modifier_id_idx').on(table.modifierId),
      index('role_assignments_item_id_idx').on(table.itemId),unique('role_assignments_unique').on(table.roleId, table.userId, table.contextId, table.component, table.itemId)],
);

/** Capability overrides per role+context (Moodle `role_capabilities`). permission: -1000 PROHIBIT, -1 PREVENT, 0 INHERIT, 1 ALLOW. */
export const roleCapabilities = pgTable(
  'role_capabilities',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    contextId: uuid('context_id').notNull().references(() => context.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull().references(() => role.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    permission: integer('permission').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    modifierId: uuid('modifier_id'),
  },
  (table) => [
      index('role_capabilities_role_id_idx').on(table.roleId),
      index('role_capabilities_modifier_id_idx').on(table.modifierId),unique('role_capabilities_unique').on(table.contextId, table.roleId, table.capability)],
);
