/** Các bảng của bounded context Platform Infrastructure — định nghĩa Drizzle do tầng hạ tầng nền tảng (src/db) sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Site configuration (Moodle `config`). */
export const config = pgTable('config', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  key: text('key').notNull().unique(),
  value: jsonb('value'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Per-plugin configuration (Moodle `config_plugins`). */
export const pluginConfig = pgTable(
  'plugin_config',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    plugin: text('plugin').notNull(),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [unique('plugin_config_plugin_name_unique').on(table.plugin, table.name)],
);

/** Audit trail for admin setting changes. */
export const adminSettingAudit = pgTable('admin_setting_audit', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  settingKey: text('setting_key').notNull(),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  changedBy: text('changed_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Transactional outbox (self-built, ADR-004). */
export const outboxEvents = pgTable('outbox_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  aggregate: text('aggregate').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});

/** Immutable domain event log (Moodle logstore equivalent). */
export const eventLog = pgTable('event_log', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  eventType: text('event_type').notNull(),
  contextId: integer('context_id'),
  userId: integer('user_id'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Admin-editable schedule for scheduled tasks (Moodle `task_scheduled`). */
export const scheduledTaskConfig = pgTable('scheduled_task_config', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  taskName: text('task_name').notNull().unique(),
  schedule: text('schedule').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Execution log of scheduled/adhoc tasks. */
export const taskLog = pgTable('task_log', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  taskName: text('task_name').notNull(),
  status: text('status').notNull(),
  message: text('message'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});
