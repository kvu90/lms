import {
  boolean,
  doublePrecision,
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

// ---------------------------------------------------------------------------
// P2 — Course & Enrolment (Courses / Groups+Cohort / Enrol / Availability /
// Completion). Availability is a JSONB column, not a table (report §4).
// ---------------------------------------------------------------------------

/** Course categories form a tree (Moodle `course_categories`): path/depth like contexts. parent=0 means top level. */
export const courseCategories = pgTable('course_categories', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  idnumber: text('idnumber'),
  description: text('description').notNull().default(''),
  parent: integer('parent').notNull().default(0),
  sortorder: integer('sortorder').notNull().default(0),
  path: text('path').notNull().default(''),
  depth: integer('depth').notNull().default(1),
  visible: boolean('visible').notNull().default(true),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Courses (Moodle `course`). groupmode: 0=NOGROUPS, 1=SEPARATEGROUPS, 2=VISIBLEGROUPS. */
export const course = pgTable('course', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  category: integer('category').notNull().references(() => courseCategories.id, { onDelete: 'cascade' }),
  fullname: text('fullname').notNull(),
  shortname: text('shortname').notNull().unique(),
  idnumber: text('idnumber').notNull().default(''),
  summary: text('summary').notNull().default(''),
  format: text('format').notNull().default('topics'),
  visible: boolean('visible').notNull().default(true),
  startdate: timestamp('startdate', { withTimezone: true }),
  enddate: timestamp('enddate', { withTimezone: true }),
  groupmode: integer('groupmode').notNull().default(0),
  enablecompletion: boolean('enablecompletion').notNull().default(true),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Course sections (Moodle `course_sections`). `availability` is the AvailabilityTree JSON (report §2#10). */
export const courseSections = pgTable(
  'course_sections',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    course: integer('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
    section: integer('section').notNull().default(0),
    name: text('name'),
    summary: text('summary').notNull().default(''),
    visible: boolean('visible').notNull().default(true),
    availability: jsonb('availability'),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_sections_course_section_unique').on(table.course, table.section)],
);

/**
 * Course modules (Moodle `course_modules`) — the generic container joining a
 * section to an activity instance via (component, instanceid). P2 ships the
 * container only; activity content arrives in later phases.
 * completion: 0=none, 1=manual, 2=automatic. groupmode 0 inherits course mode.
 */
export const courseModules = pgTable('course_modules', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  course: integer('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  section: integer('section').notNull().references(() => courseSections.id, { onDelete: 'cascade' }),
  component: text('component').notNull(),
  instanceid: integer('instanceid').notNull().default(0),
  name: text('name').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
  groupmode: integer('groupmode').notNull().default(0),
  availability: jsonb('availability'),
  completion: integer('completion').notNull().default(0),
  completionview: boolean('completionview').notNull().default(false),
  completionusegrade: boolean('completionusegrade').notNull().default(false),
  completionmanual: boolean('completionmanual').notNull().default(false),
  completionexpected: timestamp('completionexpected', { withTimezone: true }),
  deletioninprogress: boolean('deletioninprogress').notNull().default(false),
  added: timestamp('added', { withTimezone: true }).notNull().defaultNow(),
});

/** Per-course format options (Moodle `course_format_options`). */
export const courseFormatOptions = pgTable(
  'course_format_options',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
    format: text('format').notNull(),
    sectionid: integer('sectionid').notNull().default(0),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [unique('course_format_options_unique').on(table.courseid, table.format, table.sectionid, table.name)],
);

/** Groups inside one course (Moodle `groups` → `course_groups`, reserved-word rename). */
export const courseGroups = pgTable(
  'course_groups',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    idnumber: text('idnumber').notNull().default(''),
    description: text('description').notNull().default(''),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_groups_course_name_unique').on(table.courseid, table.name)],
);

/** Group membership (Moodle `groups_members`). */
export const groupsMembers = pgTable(
  'groups_members',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupid: integer('groupid').notNull().references(() => courseGroups.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    timeadded: timestamp('timeadded', { withTimezone: true }).notNull().defaultNow(),
    component: text('component').notNull().default(''),
    itemid: integer('itemid').notNull().default(0),
  },
  (table) => [unique('groups_members_unique').on(table.groupid, table.userid, table.component, table.itemid)],
);

/** Groupings: groups-of-groups inside one course (Moodle `groupings`). */
export const groupings = pgTable(
  'groupings',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    idnumber: text('idnumber').notNull().default(''),
    description: text('description').notNull().default(''),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('groupings_course_name_unique').on(table.courseid, table.name)],
);

/** Grouping ↔ group links (Moodle `groupings_groups`). */
export const groupingsGroups = pgTable(
  'groupings_groups',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupingid: integer('groupingid').notNull().references(() => groupings.id, { onDelete: 'cascade' }),
    groupid: integer('groupid').notNull().references(() => courseGroups.id, { onDelete: 'cascade' }),
    timeadded: timestamp('timeadded', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('groupings_groups_unique').on(table.groupingid, table.groupid)],
);

/** Cohorts live at system or course-category context (Moodle `cohort`). contextid references `context`. */
export const cohort = pgTable('cohort', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  idnumber: text('idnumber').notNull().default(''),
  description: text('description').notNull().default(''),
  contextid: integer('contextid').notNull(),
  component: text('component').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Cohort membership (Moodle `cohort_members`). */
export const cohortMembers = pgTable(
  'cohort_members',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    cohortid: integer('cohortid').notNull().references(() => cohort.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    timeadded: timestamp('timeadded', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('cohort_members_unique').on(table.cohortid, table.userid)],
);

/**
 * Enrol instances per course (Moodle `enrol`). method: manual|cohort|self|guest.
 * status: 0=enabled, 1=disabled. For cohort instances customint1 = cohort id,
 * customint2 = group id to add members to (0=none), customtext1 = sync mode
 * ('suspend'|'unenrol') applied when a user leaves the cohort.
 */
export const enrol = pgTable('enrol', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
  enrol: text('enrol').notNull(),
  status: integer('status').notNull().default(0),
  name: text('name'),
  roleid: integer('roleid'),
  enrolperiod: integer('enrolperiod').notNull().default(0),
  timestart: timestamp('timestart', { withTimezone: true }),
  timeend: timestamp('timeend', { withTimezone: true }),
  customint1: integer('customint1').notNull().default(0),
  customint2: integer('customint2').notNull().default(0),
  customtext1: text('customtext1').notNull().default('suspend'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * User enrolments (Moodle `user_enrolments`).
 * status: 0=ACTIVE, 1=SUSPENDED, 2=WITHDRAWN (soft state used on unenrol when
 * the user still has related data — grades/completion/files — that must be
 * kept; the row is never hard-deleted in that case, report §2#5).
 */
export const userEnrolments = pgTable(
  'user_enrolments',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    enrolid: integer('enrolid').notNull().references(() => enrol.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    status: integer('status').notNull().default(0),
    timestart: timestamp('timestart', { withTimezone: true }).notNull().defaultNow(),
    timeend: timestamp('timeend', { withTimezone: true }),
    modifierid: integer('modifierid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('user_enrolments_unique').on(table.enrolid, table.userid)],
);

/**
 * Per-activity completion state (Moodle `course_modules_completion`).
 * completionstate: 0=incomplete, 1=complete, 2=complete-pass, 3=complete-fail
 * (pass/fail arrive with grades in P3; P2 writes 0/1 and `viewed`).
 */
export const courseModulesCompletion = pgTable(
  'course_modules_completion',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    coursemoduleid: integer('coursemoduleid').notNull().references(() => courseModules.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    completionstate: integer('completionstate').notNull().default(0),
    viewed: boolean('viewed').notNull().default(false),
    overrideby: integer('overrideby'),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_modules_completion_unique').on(table.coursemoduleid, table.userid)],
);

/** Course-level completion criteria (Moodle `course_completion_criteria`). criteriatype: 'module' | 'date' | 'grade' (grade wired in P3). */
export const courseCompletionCriteria = pgTable('course_completion_criteria', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  course: integer('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  criteriatype: text('criteriatype').notNull(),
  moduleinstance: integer('moduleinstance'),
  date: timestamp('date', { withTimezone: true }),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Per-course completion aggregation setting: method 1 = ALL (AND), 2 = ANY (OR). */
export const courseCompletionSettings = pgTable('course_completion_settings', {
  course: integer('course').primaryKey().references(() => course.id, { onDelete: 'cascade' }),
  method: integer('method').notNull().default(1),
});

/** Course completion state per user (Moodle `course_completions`). status: 'not_started' | 'in_progress' | 'complete'. */
export const courseCompletions = pgTable(
  'course_completions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userid: integer('userid').notNull(),
    course: integer('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('not_started'),
    timeenrolled: timestamp('timeenrolled', { withTimezone: true }).notNull().defaultNow(),
    timestarted: timestamp('timestarted', { withTimezone: true }),
    timecompleted: timestamp('timecompleted', { withTimezone: true }),
    reaggregate: timestamp('reaggregate', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_completions_unique').on(table.userid, table.course)],
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

// ---------------------------------------------------------------------------
// P3 — Assessment (Grades / Questions). Table names follow Moodle (no mdl_).
// ---------------------------------------------------------------------------

/** Scales (Moodle `scale`): courseid 0 = site scale. `scale` is a comma-separated list of values, lowest first. */
export const scales = pgTable('scales', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull().default(0),
  name: text('name').notNull(),
  scale: text('scale').notNull().default(''),
  description: text('description').notNull().default(''),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Grade categories form a tree per course (Moodle `grade_categories`).
 * aggregation: natural|mean|weightedmean|simpleweightedmean|median|lowest|highest|mode|sum.
 * The category's own total is a grade_items row with itemtype='category'
 * (course total: itemtype='course'), exactly like Moodle.
 */
export const gradeCategories = pgTable('grade_categories', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
  parent: integer('parent'),
  fullname: text('fullname').notNull().default(''),
  aggregation: text('aggregation').notNull().default('natural'),
  droplow: integer('droplow').notNull().default(0),
  keephigh: integer('keephigh').notNull().default(0),
  aggregateonlygraded: boolean('aggregateonlygraded').notNull().default(false),
  depth: integer('depth').notNull().default(1),
  path: text('path').notNull().default(''),
  hidden: boolean('hidden').notNull().default(false),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Grade items (Moodle `grade_items`). itemtype: course|category|manual|mod.
 * For 'mod', iteminstance = course_modules id and itemmodule = component.
 * For 'category', iteminstance = grade_categories id. For 'course', iteminstance = course id.
 * aggregationcoef is the item's weight inside its parent category (used by
 * weightedmean always, and by natural when weightoverride is set).
 */
export const gradeItems = pgTable(
  'grade_items',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
    categoryid: integer('categoryid').references(() => gradeCategories.id, { onDelete: 'cascade' }),
    itemname: text('itemname').notNull().default(''),
    itemtype: text('itemtype').notNull().default('manual'),
    itemmodule: text('itemmodule'),
    iteminstance: integer('iteminstance').notNull().default(0),
    gradetype: text('gradetype').notNull().default('value'),
    grademax: doublePrecision('grademax').notNull().default(100),
    grademin: doublePrecision('grademin').notNull().default(0),
    gradepass: doublePrecision('gradepass').notNull().default(0),
    scaleid: integer('scaleid').references(() => scales.id, { onDelete: 'set null' }),
    weightoverride: boolean('weightoverride').notNull().default(false),
    aggregationcoef: doublePrecision('aggregationcoef').notNull().default(0),
    extracredit: boolean('extracredit').notNull().default(false),
    multiplicator: doublePrecision('multiplicator').notNull().default(1),
    plusfactor: doublePrecision('plusfactor').notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    sortorder: integer('sortorder').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('grade_items_course_type_instance_unique').on(table.courseid, table.itemtype, table.iteminstance, table.itemmodule)],
);

/**
 * Per-user grades (Moodle `grade_grades`). rawgrade is what was entered;
 * finalgrade is what counts (after multiplicator/offset + aggregation for
 * category/course items). `frozen` is explicit data (report §2#7): once a
 * grade was produced with a multiplicator/offset (a penalty-style formula),
 * its finalgrade is frozen and regrades reuse it verbatim until unfrozen.
 */
export const gradeGrades = pgTable(
  'grade_grades',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    itemid: integer('itemid').notNull().references(() => gradeItems.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    rawgrade: doublePrecision('rawgrade'),
    rawgrademax: doublePrecision('rawgrademax').notNull().default(100),
    rawgrademin: doublePrecision('rawgrademin').notNull().default(0),
    finalgrade: doublePrecision('finalgrade'),
    hidden: boolean('hidden').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    locktime: timestamp('locktime', { withTimezone: true }),
    overridden: boolean('overridden').notNull().default(false),
    excluded: boolean('excluded').notNull().default(false),
    frozen: boolean('frozen').notNull().default(false),
    feedback: text('feedback'),
    information: text('information'),
    aggregationstatus: text('aggregationstatus').notNull().default('unknown'),
    aggregationweight: doublePrecision('aggregationweight'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('grade_grades_item_user_unique').on(table.itemid, table.userid)],
);

/** Grade change history (Moodle `grade_grades_history`). action: 1=insert, 2=update, 3=delete. */
export const gradeGradesHistory = pgTable('grade_grades_history', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  action: integer('action').notNull().default(2),
  oldid: integer('oldid'),
  itemid: integer('itemid').notNull(),
  userid: integer('userid').notNull(),
  rawgrade: doublePrecision('rawgrade'),
  finalgrade: doublePrecision('finalgrade'),
  overridden: boolean('overridden').notNull().default(false),
  excluded: boolean('excluded').notNull().default(false),
  frozen: boolean('frozen').notNull().default(false),
  source: text('source'),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  loggeduser: integer('loggeduser'),
});

/** Grade letters per context (Moodle `grade_letters`): letter applies when percentage >= lowerboundary. */
export const gradeLetters = pgTable(
  'grade_letters',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    contextid: integer('contextid').notNull(),
    lowerboundary: doublePrecision('lowerboundary').notNull(),
    letter: text('letter').notNull(),
  },
  (table) => [unique('grade_letters_context_boundary_unique').on(table.contextid, table.lowerboundary)],
);

/** Question categories live in a context (Moodle `question_categories`). */
export const questionCategories = pgTable('question_categories', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  contextid: integer('contextid').notNull(),
  info: text('info').notNull().default(''),
  parent: integer('parent'),
  sortorder: integer('sortorder').notNull().default(0),
  stamp: text('stamp').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Question identity (Moodle `question`): stable across versions; content lives in question_versions. */
export const question = pgTable('question', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  category: integer('category').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
  qtype: text('qtype').notNull(),
  name: text('name').notNull(),
  createdby: integer('createdby'),
  modifiedby: integer('modifiedby'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Bank entries (Moodle `question_bank_entries`) link a question identity to a
 * category and track the latest version number. Editing a question creates a
 * NEW question_versions row and bumps latestversion; attempts already started
 * keep pointing at the version they pinned.
 */
export const questionBankEntries = pgTable(
  'question_bank_entries',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    questioncategoryid: integer('questioncategoryid').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
    questionid: integer('questionid').notNull().references(() => question.id, { onDelete: 'cascade' }),
    latestversion: integer('latestversion').notNull().default(1),
    status: text('status').notNull().default('ready'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('question_bank_entries_question_unique').on(table.questionid)],
);

/**
 * Immutable question content versions (Moodle `question_versions`).
 * answerdata is the generic correct-answer payload of the version
 * (truefalse: {correct: boolean}; shortanswer: {answers: string[], casesensitive?: boolean}) —
 * qtypes are plugins and out of scope; the engine grades against THIS data.
 */
export const questionVersions = pgTable(
  'question_versions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    questionbankentryid: integer('questionbankentryid').notNull().references(() => questionBankEntries.id, { onDelete: 'cascade' }),
    questionid: integer('questionid').notNull().references(() => question.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('ready'),
    questiontext: text('questiontext').notNull().default(''),
    defaultmark: doublePrecision('defaultmark').notNull().default(1),
    answerdata: jsonb('answerdata').notNull().default({}),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('question_versions_entry_version_unique').on(table.questionbankentryid, table.version)],
);

/** Question usages group attempts for one activity instance (Moodle `question_usages`). */
export const questionUsages = pgTable('question_usages', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  component: text('component').notNull(),
  instanceid: integer('instanceid').notNull().default(0),
  owningcontextid: integer('owningcontextid'),
  preferredbehaviour: text('preferredbehaviour').notNull().default('deferredfeedback'),
  userid: integer('userid'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One attempt at one question inside a usage (Moodle `question_attempts`).
 * questionversionid is PINNED when the attempt starts: later edits of the
 * question (new versions) never change how this attempt is graded.
 * state follows Moodle question_state names.
 */
export const questionAttempts = pgTable(
  'question_attempts',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    questionusageid: integer('questionusageid').notNull().references(() => questionUsages.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    behaviour: text('behaviour').notNull().default('deferredfeedback'),
    questionid: integer('questionid').notNull().references(() => question.id, { onDelete: 'cascade' }),
    questionversionid: integer('questionversionid').references(() => questionVersions.id, { onDelete: 'set null' }),
    variant: integer('variant').notNull().default(1),
    maxmark: doublePrecision('maxmark').notNull().default(1),
    minfraction: doublePrecision('minfraction').notNull().default(0),
    maxfraction: doublePrecision('maxfraction').notNull().default(1),
    flagged: boolean('flagged').notNull().default(false),
    questionsummary: text('questionsummary'),
    responsesummary: text('responsesummary'),
    rightanswer: text('rightanswer'),
    state: text('state').notNull().default('notstarted'),
    fraction: doublePrecision('fraction'),
    userid: integer('userid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('question_attempts_usage_slot_unique').on(table.questionusageid, table.slot)],
);

/** Every state transition of an attempt is a step (Moodle `question_attempt_steps`). */
export const questionAttemptSteps = pgTable(
  'question_attempt_steps',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    questionattemptid: integer('questionattemptid').notNull().references(() => questionAttempts.id, { onDelete: 'cascade' }),
    sequencenumber: integer('sequencenumber').notNull(),
    state: text('state').notNull(),
    fraction: doublePrecision('fraction'),
    userid: integer('userid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('question_attempt_steps_attempt_seq_unique').on(table.questionattemptid, table.sequencenumber)],
);

// ---------------------------------------------------------------------------
// P4 — Communication & Engagement (Messaging / Calendar / Badges /
// Competencies / Social: Tag, Comment, Rating, Blog, Notes).
// Social tables are POLYMORPHIC (component + itemtype/area + itemid +
// contextid) with NO hard FK to any business table (report §2#16).
// ---------------------------------------------------------------------------

/** Conversations (Moodle `message_conversations`). type: 1=individual, 2=group, 3=self. */
export const messageConversations = pgTable('message_conversations', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  type: integer('type').notNull().default(1),
  name: text('name'),
  component: text('component'),
  itemtype: text('itemtype'),
  itemid: integer('itemid').notNull().default(0),
  contextid: integer('contextid'),
  enabled: boolean('enabled').notNull().default(true),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Conversation membership (Moodle `message_conversation_members`). */
export const messageConversationMembers = pgTable(
  'message_conversation_members',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    conversationid: integer('conversationid').notNull().references(() => messageConversations.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('message_conversation_members_unique').on(table.conversationid, table.userid)],
);

/**
 * User-to-user messages inside a conversation (Moodle `message` +
 * `messages`). Once sent, a message belongs to core_message: the sending
 * component/user can NEVER edit or delete it through the API (report §2#12).
 * `timeread` is the recipient-side read marker used for unread counts.
 */
export const message = pgTable('message', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  conversationid: integer('conversationid').notNull().references(() => messageConversations.id, { onDelete: 'cascade' }),
  useridfrom: integer('useridfrom').notNull(),
  subject: text('subject').notNull().default(''),
  fullmessage: text('fullmessage').notNull().default(''),
  smallmessage: text('smallmessage').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timeread: timestamp('timeread', { withTimezone: true }),
});

/** Blocked contacts (Moodle `message_users_blocked`): userid blocks blockeduserid from contacting them. */
export const messageUsersBlocked = pgTable(
  'message_users_blocked',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userid: integer('userid').notNull(),
    blockeduserid: integer('blockeduserid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('message_users_blocked_unique').on(table.userid, table.blockeduserid)],
);

/**
 * System notifications (Moodle `notifications`) — DISTINCT from user
 * messages: useridfrom is null/system, the record is produced by a message
 * provider (component + eventtype) and delivered per user preference.
 */
export const notifications = pgTable('notifications', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  useridfrom: integer('useridfrom'),
  useridto: integer('useridto').notNull(),
  subject: text('subject').notNull().default(''),
  fullmessage: text('fullmessage').notNull().default(''),
  smallmessage: text('smallmessage').notNull().default(''),
  component: text('component').notNull().default(''),
  eventtype: text('eventtype').notNull().default(''),
  contexturl: text('contexturl'),
  contexturlname: text('contexturlname'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timeread: timestamp('timeread', { withTimezone: true }),
});

/**
 * Per-channel dispatch log for notifications. The in-app (popup) channel is
 * the only REAL channel; email/push are ports whose dispatch is only LOGGED
 * (never actually sent) — status: delivered | queued | logged | skipped-preference | skipped-suspended.
 * `dedupekey` makes worker dispatch idempotent.
 */
export const notificationDispatchLog = pgTable(
  'notification_dispatch_log',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    notificationid: integer('notificationid'),
    userid: integer('userid').notNull(),
    provider: text('provider').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    subject: text('subject').notNull().default(''),
    dedupekey: text('dedupekey'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('notification_dispatch_log_dedupe_unique').on(table.dedupekey)],
);

/**
 * Calendar events (Moodle `event` → `calendar_events`). eventtype:
 * site|category|course|group|user decides visibility by the context tree +
 * group membership (report §2#13). A series is a set of rows sharing
 * `repeatid` (= id of the first event); the root carries the `rrule`
 * (FREQ=DAILY|WEEKLY|MONTHLY;COUNT=n|UNTIL=...). An exception is a row with
 * isexception=true and exceptionof = id of the occurrence it replaces.
 */
export const calendarEvents = pgTable('calendar_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  eventtype: text('eventtype').notNull().default('user'),
  courseid: integer('courseid').notNull().default(0),
  groupid: integer('groupid').notNull().default(0),
  categoryid: integer('categoryid').notNull().default(0),
  userid: integer('userid').notNull().default(0),
  contextid: integer('contextid'),
  subscriptionid: integer('subscriptionid'),
  uuid: text('uuid'),
  repeatid: integer('repeatid').notNull().default(0),
  rrule: text('rrule'),
  isexception: boolean('isexception').notNull().default(false),
  exceptionof: integer('exceptionof'),
  timestart: timestamp('timestart', { withTimezone: true }).notNull(),
  timeduration: integer('timeduration').notNull().default(0),
  visible: boolean('visible').notNull().default(true),
  location: text('location').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Calendar subscriptions (Moodle `calendar_subscriptions`): external ICS feeds imported by a worker job. */
export const calendarSubscriptions = pgTable('calendar_subscriptions', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  url: text('url'),
  icsdata: text('icsdata'),
  eventtype: text('eventtype').notNull().default('site'),
  courseid: integer('courseid').notNull().default(0),
  categoryid: integer('categoryid').notNull().default(0),
  userid: integer('userid').notNull().default(0),
  pollinterval: integer('pollinterval').notNull().default(604800),
  lastupdated: timestamp('lastupdated', { withTimezone: true }),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Badges (Moodle `badge`). type: 1=site, 2=course. status: 0=inactive, 1=active, 2=retired, 3=archived, 4=disabled(hidden active). */
export const badge = pgTable('badge', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  type: integer('type').notNull().default(1),
  courseid: integer('courseid'),
  issuername: text('issuername').notNull().default(''),
  issuerurl: text('issuerurl').notNull().default(''),
  issuercontact: text('issuercontact').notNull().default(''),
  expiredate: timestamp('expiredate', { withTimezone: true }),
  expireperiod: integer('expireperiod'),
  status: integer('status').notNull().default(0),
  version: text('version').notNull().default(''),
  language: text('language').notNull().default('en'),
  usercreated: integer('usercreated'),
  usermodified: integer('usermodified'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Badge criteria (Moodle `badge_criteria`). One row with criteriatype
 * 'overall' carries the aggregation method (1=ALL, 2=ANY) over the leaf
 * rows. Leaf types: coursecompletion | activitycompletion | competency |
 * badge | manual. Leaf parameters live in `params` jsonb
 * (e.g. {courseId} / {cmId} / {competencyId} / {badgeId} / {roleId}).
 * Criteria of an ACTIVE badge (or one with issued awards) are FROZEN.
 */
export const badgeCriteria = pgTable('badge_criteria', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  badgeid: integer('badgeid').notNull().references(() => badge.id, { onDelete: 'cascade' }),
  criteriatype: text('criteriatype').notNull(),
  method: integer('method').notNull().default(1),
  params: jsonb('params').notNull().default({}),
  description: text('description').notNull().default(''),
});

/**
 * Issued badge assertions (Moodle `badge_issued`): IMMUTABLE evidence that a
 * user earned a badge — a snapshot of the badge + criteria at issue time.
 * Revoking never deletes the row; it flips `revoked`.
 */
export const badgeIssued = pgTable(
  'badge_issued',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    badgeid: integer('badgeid').notNull().references(() => badge.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    uniquehash: text('uniquehash').notNull().unique(),
    snapshot: jsonb('snapshot').notNull().default({}),
    evidence: jsonb('evidence').notNull().default({}),
    dateissued: timestamp('dateissued', { withTimezone: true }).notNull().defaultNow(),
    dateexpire: timestamp('dateexpire', { withTimezone: true }),
    visible: boolean('visible').notNull().default(true),
    revoked: boolean('revoked').notNull().default(false),
    revokedat: timestamp('revokedat', { withTimezone: true }),
    issuernotified: boolean('issuernotified').notNull().default(false),
  },
  (table) => [unique('badge_issued_badge_user_unique').on(table.badgeid, table.userid)],
);

/** Manual awards (Moodle `badge_manual_award`): proof that a manual criterion was met by a role holder's decision. */
export const badgeManualAward = pgTable(
  'badge_manual_award',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    badgeid: integer('badgeid').notNull().references(() => badge.id, { onDelete: 'cascade' }),
    recipientid: integer('recipientid').notNull(),
    issuerid: integer('issuerid').notNull(),
    issuerrole: integer('issuerrole'),
    datemet: timestamp('datemet', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('badge_manual_award_unique').on(table.badgeid, table.recipientid, table.issuerid)],
);

/**
 * Competency frameworks (Moodle `competency_framework`). The scale is
 * CONFIGURATION, not a table join: `scaleconfiguration` jsonb =
 * { values: string[] (lowest first), proficient: number[] (indexes into
 * values that count as proficient) }. Proficiency is read off THIS scale —
 * never inferred from grades (report §2#15).
 */
export const competencyFramework = pgTable('competency_framework', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  shortname: text('shortname').notNull(),
  idnumber: text('idnumber').notNull().default(''),
  description: text('description').notNull().default(''),
  contextid: integer('contextid').notNull(),
  scaleconfiguration: jsonb('scaleconfiguration').notNull().default({}),
  taxonomies: text('taxonomies').notNull().default('competency'),
  visible: boolean('visible').notNull().default(true),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Competencies form a tree inside a framework (Moodle `competency`): path/depth like contexts. */
export const competency = pgTable('competency', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  frameworkid: integer('frameworkid').notNull().references(() => competencyFramework.id, { onDelete: 'cascade' }),
  shortname: text('shortname').notNull(),
  idnumber: text('idnumber').notNull().default(''),
  description: text('description').notNull().default(''),
  parentid: integer('parentid').notNull().default(0),
  path: text('path').notNull().default(''),
  depth: integer('depth').notNull().default(1),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Course ↔ competency link (Moodle `competency_coursecomp`). ruleoutcome is
 * EXPLICIT configuration applied when the course is completed:
 * 'complete' | 'attach-evidence' | 'nothing'.
 */
export const competencyCoursecomp = pgTable(
  'competency_coursecomp',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    courseid: integer('courseid').notNull(),
    competencyid: integer('competencyid').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    ruleoutcome: text('ruleoutcome').notNull().default('nothing'),
    sortorder: integer('sortorder').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('competency_coursecomp_unique').on(table.courseid, table.competencyid)],
);

/** Activity (cm) ↔ competency link (Moodle `competency_modulecomp`); ruleoutcome applies when the activity completes. */
export const competencyModulecomp = pgTable(
  'competency_modulecomp',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    coursemoduleid: integer('coursemoduleid').notNull(),
    competencyid: integer('competencyid').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    ruleoutcome: text('ruleoutcome').notNull().default('nothing'),
    sortorder: integer('sortorder').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('competency_modulecomp_unique').on(table.coursemoduleid, table.competencyid)],
);

/** Learning plan templates (Moodle `competency_template`). status: 0=draft(hidden), 1=active. */
export const competencyTemplate = pgTable('competency_template', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  shortname: text('shortname').notNull(),
  description: text('description').notNull().default(''),
  contextid: integer('contextid').notNull(),
  duedate: timestamp('duedate', { withTimezone: true }),
  visible: boolean('visible').notNull().default(true),
  status: integer('status').notNull().default(1),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Template ↔ competency links (Moodle `competency_templatecomp`). */
export const competencyTemplatecomp = pgTable(
  'competency_templatecomp',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    templateid: integer('templateid').notNull().references(() => competencyTemplate.id, { onDelete: 'cascade' }),
    competencyid: integer('competencyid').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    sortorder: integer('sortorder').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('competency_templatecomp_unique').on(table.templateid, table.competencyid)],
);

/** Template ↔ cohort links (Moodle `competency_templatecohort`): plans are generated for cohort members. */
export const competencyTemplatecohort = pgTable(
  'competency_templatecohort',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    templateid: integer('templateid').notNull().references(() => competencyTemplate.id, { onDelete: 'cascade' }),
    cohortid: integer('cohortid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('competency_templatecohort_unique').on(table.templateid, table.cohortid)],
);

/**
 * Learning plans per user (Moodle `competency_plan` → `learning_plans`).
 * status: 0=draft, 1=active, 2=waitingforreview, 3=inreview, 4=complete.
 */
export const learningPlans = pgTable('learning_plans', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  userid: integer('userid').notNull(),
  templateid: integer('templateid'),
  status: integer('status').notNull().default(0),
  duedate: timestamp('duedate', { withTimezone: true }),
  reviewerid: integer('reviewerid'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Plan ↔ competency links for plans not (or no longer) bound to a template (Moodle `competency_plancomp`). */
export const competencyPlancomp = pgTable(
  'competency_plancomp',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    planid: integer('planid').notNull().references(() => learningPlans.id, { onDelete: 'cascade' }),
    competencyid: integer('competencyid').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    sortorder: integer('sortorder').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('competency_plancomp_unique').on(table.planid, table.competencyid)],
);

/** Review history of a learning plan: every lifecycle transition is a row (request/start/stop/approve/unapprove/complete). */
export const competencyPlanReview = pgTable('competency_plan_review', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  planid: integer('planid').notNull().references(() => learningPlans.id, { onDelete: 'cascade' }),
  actorid: integer('actorid').notNull(),
  action: text('action').notNull(),
  statusfrom: integer('statusfrom').notNull(),
  statusto: integer('statusto').notNull(),
  note: text('note').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A user's standing on one competency (Moodle `competency_usercomp`).
 * `grade` is an INDEX into the framework scale; `proficiency` is derived
 * from the scale configuration, never from course grades. Review status:
 * 0=none, 1=waitingforreview, 2=inreview. Exactly one of planid/courseid
 * scopes the row (plan-based and course-based user competencies are
 * separate records in Moodle too).
 */
export const competencyUsercomp = pgTable(
  'competency_usercomp',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userid: integer('userid').notNull(),
    competencyid: integer('competencyid').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    planid: integer('planid').notNull().default(0),
    courseid: integer('courseid').notNull().default(0),
    status: integer('status').notNull().default(0),
    proficiency: boolean('proficiency'),
    grade: integer('grade'),
    reviewerid: integer('reviewerid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('competency_usercomp_unique').on(table.userid, table.competencyid, table.planid, table.courseid)],
);

/**
 * Evidence log for a user competency (Moodle `competency_evidence`). Every
 * material event is a row: manual evidence, course-completion evidence,
 * review requests and review outcomes — together they ARE the review
 * history. `grade` here is a scale index snapshot (nullable).
 */
export const competencyEvidence = pgTable('competency_evidence', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  usercompetencyid: integer('usercompetencyid').notNull().references(() => competencyUsercomp.id, { onDelete: 'cascade' }),
  contextid: integer('contextid'),
  actionuserid: integer('actionuserid').notNull(),
  action: text('action').notNull().default('evidence'),
  description: text('description').notNull().default(''),
  url: text('url'),
  grade: integer('grade'),
  note: text('note').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Tag collections (Moodle `tag_coll`): areas belong to a collection; the default collection is seeded. */
export const tagCollection = pgTable('tag_collection', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  isstandard: boolean('isstandard').notNull().default(false),
  component: text('component'),
  searchable: boolean('searchable').notNull().default(true),
  customurl: text('customurl'),
});

/** Tags (Moodle `tag`). name is the normalised (lowercase) form; rawname keeps the display form. */
export const tag = pgTable(
  'tag',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userid: integer('userid').notNull().default(0),
    tagcollid: integer('tagcollid').notNull().default(1),
    name: text('name').notNull(),
    rawname: text('rawname').notNull(),
    isstandard: boolean('isstandard').notNull().default(false),
    flag: integer('flag').notNull().default(0),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('tag_coll_name_unique').on(table.tagcollid, table.name)],
);

/** Tag instances (Moodle `tag_instance`): the polymorphic link — no FK to the tagged item, by design. */
export const tagInstance = pgTable(
  'tag_instance',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    tagid: integer('tagid').notNull().references(() => tag.id, { onDelete: 'cascade' }),
    component: text('component').notNull(),
    itemtype: text('itemtype').notNull(),
    itemid: integer('itemid').notNull(),
    contextid: integer('contextid').notNull(),
    tiuserid: integer('tiuserid').notNull().default(0),
    ordering: integer('ordering').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('tag_instance_unique').on(table.tagid, table.component, table.itemtype, table.itemid, table.contextid, table.tiuserid)],
);

/** Correlated tags (Moodle `tag_correlation`): tags that co-occur on the same items, as a comma list of tag ids. */
export const tagCorrelation = pgTable('tag_correlation', {
  tagid: integer('tagid').primaryKey().references(() => tag.id, { onDelete: 'cascade' }),
  correlatedtags: text('correlatedtags').notNull().default(''),
});

/** Comments (Moodle `comments`): polymorphic by (component, commentarea, itemid, contextid). */
export const comments = pgTable('comments', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  contextid: integer('contextid').notNull(),
  component: text('component').notNull(),
  commentarea: text('commentarea').notNull(),
  itemid: integer('itemid').notNull(),
  content: text('content').notNull(),
  format: integer('format').notNull().default(1),
  userid: integer('userid').notNull(),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timedeleted: timestamp('timedeleted', { withTimezone: true }),
});

/** Ratings (Moodle `rating`): polymorphic; aggregation (average/count/sum) is computed over THIS item only. */
export const rating = pgTable(
  'rating',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    contextid: integer('contextid').notNull(),
    component: text('component').notNull(),
    ratingarea: text('ratingarea').notNull(),
    itemid: integer('itemid').notNull(),
    scaleid: integer('scaleid').notNull(),
    rating: integer('rating').notNull(),
    userid: integer('userid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('rating_unique').on(table.contextid, table.component, table.ratingarea, table.itemid, table.userid)],
);

/** Blog posts (Moodle `post` → `blog_posts`). publishstate: 'draft' (author only) | 'site' (public). The owning context is the author's user context. */
export const blogPosts = pgTable('blog_posts', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userid: integer('userid').notNull(),
  subject: text('subject').notNull().default(''),
  summary: text('summary').notNull().default(''),
  content: text('content').notNull().default(''),
  publishstate: text('publishstate').notNull().default('draft'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  lastmodified: timestamp('lastmodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Blog associations (Moodle `blog_association`): a post linked to a course or a course module. */
export const blogAssociation = pgTable(
  'blog_association',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    blogid: integer('blogid').notNull().references(() => blogPosts.id, { onDelete: 'cascade' }),
    contextid: integer('contextid').notNull(),
    assoctype: text('assoctype').notNull(), // course | coursemodule
    associd: integer('associd').notNull(),
  },
  (table) => [unique('blog_association_unique').on(table.blogid, table.assoctype, table.associd)],
);

/**
 * Notes about a user (Moodle `note` → `notes`). publishstate decides who can
 * read: 'draft' = personal (creator only), 'public' = course note (readers
 * need moodle/notes:view at the COURSE context — in practice the course's
 * teachers), 'site' = site note (moodle/notes:view at system).
 */
export const notes = pgTable('notes', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull().default(0),
  userid: integer('userid').notNull(),
  createdby: integer('createdby').notNull(),
  content: text('content').notNull().default(''),
  format: integer('format').notNull().default(1),
  publishstate: text('publishstate').notNull().default('draft'),
  groupid: integer('groupid').notNull().default(0),
  usermodified: integer('usermodified'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  lastmodified: timestamp('lastmodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Step payload data (Moodle `question_attempt_step_data`): e.g. name='answer', value='true'. */
export const questionAttemptStepData = pgTable(
  'question_attempt_step_data',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    attemptstepid: integer('attemptstepid').notNull().references(() => questionAttemptSteps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [unique('question_attempt_step_data_step_name_unique').on(table.attemptstepid, table.name)],
);
