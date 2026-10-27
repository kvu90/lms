/** Các bảng của bounded context Platform Infrastructure — định nghĩa Drizzle do tầng hạ tầng nền tảng (src/db) sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

/** Cấu hình site (Moodle `config`). */
export const config = pgTable('config', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  key: text('key').notNull().unique(),
  value: jsonb('value'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Cấu hình theo plugin (Moodle `config_plugins`). `tenant_id` NULL = cấu hình của platform; có giá trị = ghi đè của tenant đó (TENANT-0, #168). */
export const pluginConfig = pgTable(
  'plugin_config',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    plugin: text('plugin').notNull(),
    name: text('name').notNull(),
    value: text('value'),
    tenantId: uuid('tenant_id'),
  },
  (table) => [
    unique('plugin_config_tenant_plugin_name_unique').on(table.tenantId, table.plugin, table.name),
    // Postgres coi NULL là phân biệt trong unique — giữ tính duy nhất cho
    // các dòng platform (tenant_id NULL) như unique (plugin, name) cũ.
    uniqueIndex('plugin_config_platform_plugin_name_unique').on(table.plugin, table.name).where(sql`tenant_id is null`),
    index('plugin_config_tenant_id_idx').on(table.tenantId),
  ],
);

/** Vết kiểm toán cho các thay đổi cài đặt của quản trị viên. `tenant_id` NULL = đổi ở tầng platform; có giá trị = đổi cấu hình của tenant (TENANT-0, #168). */
export const adminSettingAudit = pgTable('admin_setting_audit', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  settingKey: text('setting_key').notNull(),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  changedBy: text('changed_by'),
  tenantId: uuid('tenant_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Outbox giao dịch (tự xây dựng). `tenant_id` nạp từ ngữ cảnh tenant của request/job khi phát sinh (TENANT-0, #168) — NULL = sự kiện platform/không gian chung. */
export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`).$defaultFn(() => uuidv7()),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().unique(),
  aggregate: text('aggregate').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  tenantId: uuid('tenant_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
},
  (table) => [index('outbox_events_tenant_id_idx').on(table.tenantId)]);

/** Nhật ký sự kiện miền bất biến (tương đương logstore của Moodle). */
export const eventLog = pgTable('event_log', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`).$defaultFn(() => uuidv7()),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().unique(),
  eventType: text('event_type').notNull(),
  contextId: uuid('context_id'),
  userId: uuid('user_id'),
  /** Tenant của ngữ cảnh phát sinh sự kiện (TENANT-0, #168) — NULL = platform. */
  tenantId: uuid('tenant_id'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('event_log_context_id_idx').on(table.contextId),
      index('event_log_user_id_idx').on(table.userId),
      index('event_log_tenant_id_idx').on(table.tenantId),
  ]);


/** Lịch cho các tác vụ đã lên lịch, có thể chỉnh sửa bởi quản trị viên (Moodle `task_scheduled`). */
export const scheduledTaskConfig = pgTable('scheduled_task_config', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  taskName: text('task_name').notNull().unique(),
  schedule: text('schedule').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Nhật ký thực thi của các tác vụ đã lên lịch/adhoc. */
export const taskLog = pgTable('task_log', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  taskName: text('task_name').notNull(),
  status: text('status').notNull(),
  message: text('message'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});
