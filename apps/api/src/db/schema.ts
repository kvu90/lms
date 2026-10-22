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

// ---------------------------------------------------------------------------
// P1 — Identity & Access (Access / Users / Auth / CustomFields / Files)
// Table names follow the research report §3.2/§4 (Moodle names, no `mdl_`).
// ---------------------------------------------------------------------------

/** Access contexts form a tree (Moodle `context`). Levels: system=10, user=30, coursecat=40, course=50, module=70, block=80. */
export const context = pgTable(
  'context',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    contextlevel: integer('contextlevel').notNull(),
    instanceid: integer('instanceid').notNull().default(0),
    path: text('path').notNull(),
    depth: integer('depth').notNull(),
    locked: boolean('locked').notNull().default(false),
    /** Bumped on any permission-relevant change in this context or a descendant; part of the evaluator cache key. */
    version: integer('version').notNull().default(1),
  },
  (table) => [unique('context_level_instance_unique').on(table.contextlevel, table.instanceid)],
);

/** Registered capabilities (Moodle `capabilities`). Definitions live in code; rows are synced at boot/seed. */
export const capabilities = pgTable('capabilities', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull().unique(),
  captype: text('captype').notNull().default('write'),
  contextlevel: integer('contextlevel').notNull().default(10),
  component: text('component').notNull().default('core'),
  riskbitmask: integer('riskbitmask').notNull().default(0),
});

/** Roles (Moodle `role`). */
export const role = pgTable('role', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
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
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    roleid: integer('roleid').notNull().references(() => role.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    contextid: integer('contextid').notNull().references(() => context.id, { onDelete: 'cascade' }),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
    modifierid: integer('modifierid'),
    component: text('component').notNull().default(''),
    itemid: integer('itemid').notNull().default(0),
  },
  (table) => [unique('role_assignments_unique').on(table.roleid, table.userid, table.contextid, table.component, table.itemid)],
);

/** Capability overrides per role+context (Moodle `role_capabilities`). permission: -1000 PROHIBIT, -1 PREVENT, 0 INHERIT, 1 ALLOW. */
export const roleCapabilities = pgTable(
  'role_capabilities',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    contextid: integer('contextid').notNull().references(() => context.id, { onDelete: 'cascade' }),
    roleid: integer('roleid').notNull().references(() => role.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    permission: integer('permission').notNull(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
    modifierid: integer('modifierid'),
  },
  (table) => [unique('role_capabilities_unique').on(table.contextid, table.roleid, table.capability)],
);

/** Users (Moodle `user` → `users`, reserved-word rename per report §3.2). Soft delete keeps the row (deleted=1). */
export const users = pgTable('users', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  firstname: text('firstname').notNull().default(''),
  lastname: text('lastname').notNull().default(''),
  suspended: boolean('suspended').notNull().default(false),
  deleted: boolean('deleted').notNull().default(false),
  forcePasswordChange: boolean('force_password_change').notNull().default(false),
  isGuest: boolean('is_guest').notNull().default(false),
  lastlogin: timestamp('lastlogin', { withTimezone: true }),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Free-form per-user preferences (Moodle `user_preferences`). */
export const userPreferences = pgTable(
  'user_preferences',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userid: integer('userid').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [unique('user_preferences_unique').on(table.userid, table.name)],
);

/** Refresh token families for rotation + reuse detection (self-built per report §3.7). Only hashes are stored. */
export const refreshTokenFamily = pgTable('refresh_token_family', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  familyId: text('family_id').notNull().unique(),
  userid: integer('userid').notNull().references(() => users.id, { onDelete: 'cascade' }),
  currentTokenHash: text('current_token_hash').notNull(),
  previousTokenHash: text('previous_token_hash'),
  revoked: boolean('revoked').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Failed-login bookkeeping for lockout (Moodle authlib lockout semantics). */
export const loginAttempts = pgTable('login_attempts', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userid: integer('userid').references(() => users.id, { onDelete: 'cascade' }),
  username: text('username').notNull(),
  success: boolean('success').notNull(),
  ip: text('ip'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Custom field categories (Moodle `customfield_category`), scoped by component+area (e.g. core_user/user). */
export const customfieldCategory = pgTable('customfield_category', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  component: text('component').notNull(),
  area: text('area').notNull(),
  itemid: integer('itemid').notNull().default(0),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Custom field definitions (Moodle `customfield_field`). type: text|textarea|select|checkbox|date. configdata holds options/required/default. */
export const customfieldField = pgTable('customfield_field', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  categoryid: integer('categoryid').notNull().references(() => customfieldCategory.id, { onDelete: 'cascade' }),
  shortname: text('shortname').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  configdata: jsonb('configdata').notNull().default({}),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Custom field values (Moodle `customfield_data`): one row per field+instance (instance = user id for profile fields). */
export const customfieldData = pgTable(
  'customfield_data',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    fieldid: integer('fieldid').notNull().references(() => customfieldField.id, { onDelete: 'cascade' }),
    instanceid: integer('instanceid').notNull(),
    value: text('value'),
    valueformat: integer('valueformat').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('customfield_data_unique').on(table.fieldid, table.instanceid)],
);

/** Logical file records (Moodle `files`). Physical bytes live once per contenthash (SHA-256) in content-addressed storage. */
export const files = pgTable('files', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  contenthash: text('contenthash').notNull(),
  contextid: integer('contextid').notNull(),
  component: text('component').notNull(),
  filearea: text('filearea').notNull(),
  itemid: integer('itemid').notNull().default(0),
  filepath: text('filepath').notNull().default('/'),
  filename: text('filename').notNull(),
  userid: integer('userid'),
  filesize: integer('filesize').notNull(),
  mimetype: text('mimetype'),
  status: integer('status').notNull().default(0),
  source: text('source'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});
