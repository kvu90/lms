import { boolean, doublePrecision, integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * Worker's view of the shared schema. P0 only needs `outbox_events` (the full
 * canonical schema lives in apps/api/src/db/schema.ts; extracting a shared
 * backend-schema package is a P1 chore, noted in the root README).
 */
export const outboxEvents = pgTable('outbox_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  aggregate: text('aggregate').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});

/** Worker's view of `files` (canonical schema in apps/api) — needed for refcount checks during orphan cleanup. */
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

/** Worker's view of P2 enrol tables (canonical schema in apps/api) — needed by the enrol-expiry processor. */
export const enrol = pgTable('enrol', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull(),
  enrol: text('enrol').notNull(),
  status: integer('status').notNull().default(0),
  roleid: integer('roleid'),
  customint1: integer('customint1').notNull().default(0),
  customtext1: text('customtext1').notNull().default('suspend'),
});

/** status: 0=ACTIVE, 1=SUSPENDED, 2=WITHDRAWN. */
export const userEnrolments = pgTable('user_enrolments', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  enrolid: integer('enrolid').notNull(),
  userid: integer('userid').notNull(),
  status: integer('status').notNull().default(0),
  timestart: timestamp('timestart', { withTimezone: true }).notNull().defaultNow(),
  timeend: timestamp('timeend', { withTimezone: true }),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Worker's view of P2 completion tables — needed by the completion-recalculate processor. */
export const courseModules = pgTable('course_modules', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  course: integer('course').notNull(),
});

export const courseModulesCompletion = pgTable('course_modules_completion', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  coursemoduleid: integer('coursemoduleid').notNull(),
  userid: integer('userid').notNull(),
  completionstate: integer('completionstate').notNull().default(0),
  viewed: boolean('viewed').notNull().default(false),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('cmc_unique_worker').on(t.coursemoduleid, t.userid)]);

export const courseCompletionCriteria = pgTable('course_completion_criteria', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  course: integer('course').notNull(),
  criteriatype: text('criteriatype').notNull(),
  moduleinstance: integer('moduleinstance'),
  date: timestamp('date', { withTimezone: true }),
  sortorder: integer('sortorder').notNull().default(0),
});

export const courseCompletionSettings = pgTable('course_completion_settings', {
  course: integer('course').primaryKey(),
  method: integer('method').notNull().default(1),
});

export const courseCompletions = pgTable('course_completions', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userid: integer('userid').notNull(),
  course: integer('course').notNull(),
  status: text('status').notNull().default('not_started'),
  timeenrolled: timestamp('timeenrolled', { withTimezone: true }).notNull().defaultNow(),
  timestarted: timestamp('timestarted', { withTimezone: true }),
  timecompleted: timestamp('timecompleted', { withTimezone: true }),
  reaggregate: timestamp('reaggregate', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('cc_unique_worker').on(t.userid, t.course)]);

/** Worker's view of P3 grade tables (canonical schema in apps/api) — needed by the grade-regrade processor. */
export const gradeCategories = pgTable('grade_categories', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull(),
  parent: integer('parent'),
  fullname: text('fullname').notNull().default(''),
  aggregation: text('aggregation').notNull().default('natural'),
  droplow: integer('droplow').notNull().default(0),
  keephigh: integer('keephigh').notNull().default(0),
  aggregateonlygraded: boolean('aggregateonlygraded').notNull().default(false),
  depth: integer('depth').notNull().default(1),
});

export const gradeItems = pgTable('grade_items', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull(),
  categoryid: integer('categoryid'),
  itemname: text('itemname').notNull().default(''),
  itemtype: text('itemtype').notNull().default('manual'),
  iteminstance: integer('iteminstance').notNull().default(0),
  grademax: doublePrecision('grademax').notNull().default(100),
  grademin: doublePrecision('grademin').notNull().default(0),
  gradepass: doublePrecision('gradepass').notNull().default(0),
  weightoverride: boolean('weightoverride').notNull().default(false),
  aggregationcoef: doublePrecision('aggregationcoef').notNull().default(0),
  extracredit: boolean('extracredit').notNull().default(false),
  multiplicator: doublePrecision('multiplicator').notNull().default(1),
  plusfactor: doublePrecision('plusfactor').notNull().default(0),
});

export const gradeGrades = pgTable('grade_grades', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  itemid: integer('itemid').notNull(),
  userid: integer('userid').notNull(),
  rawgrade: doublePrecision('rawgrade'),
  finalgrade: doublePrecision('finalgrade'),
  hidden: boolean('hidden').notNull().default(false),
  locked: boolean('locked').notNull().default(false),
  overridden: boolean('overridden').notNull().default(false),
  excluded: boolean('excluded').notNull().default(false),
  frozen: boolean('frozen').notNull().default(false),
  feedback: text('feedback'),
  aggregationstatus: text('aggregationstatus').notNull().default('unknown'),
  aggregationweight: doublePrecision('aggregationweight'),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('gg_unique_worker').on(t.itemid, t.userid)]);

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
