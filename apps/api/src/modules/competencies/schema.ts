/** Các bảng của bounded context Competencies — định nghĩa Drizzle do module competencies sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Competency frameworks (Moodle `competency_framework`). The scale is
 * CONFIGURATION, not a table join: `scaleconfiguration` jsonb =
 * { values: string[] (lowest first), proficient: number[] (indexes into
 * values that count as proficient) }. Proficiency is read off THIS scale —
 * never inferred from grades (report §2#15).
 */
export const competencyFramework = pgTable('competency_framework', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  shortname: text('shortname').notNull(),
  idnumber: text('idnumber').notNull().default(''),
  description: text('description').notNull().default(''),
  contextid: uuid('contextid').notNull(),
  scaleconfiguration: jsonb('scaleconfiguration').notNull().default({}),
  taxonomies: text('taxonomies').notNull().default('competency'),
  visible: boolean('visible').notNull().default(true),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('competency_framework_contextid_idx').on(table.contextid),
  ]);


/** Competencies form a tree inside a framework (Moodle `competency`): path/depth like contexts. */
export const competency = pgTable('competency', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  frameworkid: uuid('frameworkid').notNull().references(() => competencyFramework.id, { onDelete: 'cascade' }),
  shortname: text('shortname').notNull(),
  idnumber: text('idnumber').notNull().default(''),
  description: text('description').notNull().default(''),
  parentid: uuid('parentid'),
  path: text('path').notNull().default(''),
  depth: integer('depth').notNull().default(1),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('competency_frameworkid_idx').on(table.frameworkid),
      index('competency_parentid_idx').on(table.parentid),
  ]);


/**
 * Course ↔ competency link (Moodle `competency_coursecomp`). ruleoutcome is
 * EXPLICIT configuration applied when the course is completed:
 * 'complete' | 'attach-evidence' | 'nothing'.
 */
export const competencyCoursecomp = pgTable(
  'competency_coursecomp',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseid: uuid('courseid').notNull(),
    competencyid: uuid('competencyid').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    ruleoutcome: text('ruleoutcome').notNull().default('nothing'),
    sortorder: integer('sortorder').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_coursecomp_competencyid_idx').on(table.competencyid),unique('competency_coursecomp_unique').on(table.courseid, table.competencyid)],
);

/** Activity (cm) ↔ competency link (Moodle `competency_modulecomp`); ruleoutcome applies when the activity completes. */
export const competencyModulecomp = pgTable(
  'competency_modulecomp',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    coursemoduleid: uuid('coursemoduleid').notNull(),
    competencyid: uuid('competencyid').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    ruleoutcome: text('ruleoutcome').notNull().default('nothing'),
    sortorder: integer('sortorder').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_modulecomp_competencyid_idx').on(table.competencyid),unique('competency_modulecomp_unique').on(table.coursemoduleid, table.competencyid)],
);

/** Learning plan templates (Moodle `competency_template`). status: 0=draft(hidden), 1=active. */
export const competencyTemplate = pgTable('competency_template', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  shortname: text('shortname').notNull(),
  description: text('description').notNull().default(''),
  contextid: uuid('contextid').notNull(),
  duedate: timestamp('duedate', { withTimezone: true }),
  visible: boolean('visible').notNull().default(true),
  status: integer('status').notNull().default(1),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('competency_template_contextid_idx').on(table.contextid),
  ]);


/** Template ↔ competency links (Moodle `competency_templatecomp`). */
export const competencyTemplatecomp = pgTable(
  'competency_templatecomp',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    templateid: uuid('templateid').notNull().references(() => competencyTemplate.id, { onDelete: 'cascade' }),
    competencyid: uuid('competencyid').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    sortorder: integer('sortorder').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_templatecomp_competencyid_idx').on(table.competencyid),unique('competency_templatecomp_unique').on(table.templateid, table.competencyid)],
);

/** Template ↔ cohort links (Moodle `competency_templatecohort`): plans are generated for cohort members. */
export const competencyTemplatecohort = pgTable(
  'competency_templatecohort',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    templateid: uuid('templateid').notNull().references(() => competencyTemplate.id, { onDelete: 'cascade' }),
    cohortid: uuid('cohortid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_templatecohort_cohortid_idx').on(table.cohortid),unique('competency_templatecohort_unique').on(table.templateid, table.cohortid)],
);

/**
 * Learning plans per user (Moodle `competency_plan` → `learning_plans`).
 * status: 0=draft, 1=active, 2=waitingforreview, 3=inreview, 4=complete.
 */
export const learningPlans = pgTable('learning_plans', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  userid: uuid('userid').notNull(),
  templateid: uuid('templateid'),
  status: integer('status').notNull().default(0),
  duedate: timestamp('duedate', { withTimezone: true }),
  reviewerid: uuid('reviewerid'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('learning_plans_userid_idx').on(table.userid),
      index('learning_plans_templateid_idx').on(table.templateid),
      index('learning_plans_reviewerid_idx').on(table.reviewerid),
  ]);


/** Plan ↔ competency links for plans not (or no longer) bound to a template (Moodle `competency_plancomp`). */
export const competencyPlancomp = pgTable(
  'competency_plancomp',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    planid: uuid('planid').notNull().references(() => learningPlans.id, { onDelete: 'cascade' }),
    competencyid: uuid('competencyid').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    sortorder: integer('sortorder').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_plancomp_competencyid_idx').on(table.competencyid),unique('competency_plancomp_unique').on(table.planid, table.competencyid)],
);

/** Review history of a learning plan: every lifecycle transition is a row (request/start/stop/approve/unapprove/complete). */
export const competencyPlanReview = pgTable('competency_plan_review', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  planid: uuid('planid').notNull().references(() => learningPlans.id, { onDelete: 'cascade' }),
  actorid: uuid('actorid').notNull(),
  action: text('action').notNull(),
  statusfrom: integer('statusfrom').notNull(),
  statusto: integer('statusto').notNull(),
  note: text('note').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('competency_plan_review_planid_idx').on(table.planid),
      index('competency_plan_review_actorid_idx').on(table.actorid),
  ]);


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
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userid: uuid('userid').notNull(),
    competencyid: uuid('competencyid').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    planid: uuid('planid'),
    courseid: uuid('courseid'),
    status: integer('status').notNull().default(0),
    proficiency: boolean('proficiency'),
    grade: integer('grade'),
    reviewerid: uuid('reviewerid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_usercomp_competencyid_idx').on(table.competencyid),
      index('competency_usercomp_planid_idx').on(table.planid),
      index('competency_usercomp_courseid_idx').on(table.courseid),
      index('competency_usercomp_reviewerid_idx').on(table.reviewerid),unique('competency_usercomp_unique').on(table.userid, table.competencyid, table.planid, table.courseid)],
);

/**
 * Evidence log for a user competency (Moodle `competency_evidence`). Every
 * material event is a row: manual evidence, course-completion evidence,
 * review requests and review outcomes — together they ARE the review
 * history. `grade` here is a scale index snapshot (nullable).
 */
export const competencyEvidence = pgTable('competency_evidence', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  usercompetencyid: uuid('usercompetencyid').notNull().references(() => competencyUsercomp.id, { onDelete: 'cascade' }),
  contextid: uuid('contextid'),
  actionuserid: uuid('actionuserid').notNull(),
  action: text('action').notNull().default('evidence'),
  description: text('description').notNull().default(''),
  url: text('url'),
  grade: integer('grade'),
  note: text('note').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('competency_evidence_usercompetencyid_idx').on(table.usercompetencyid),
      index('competency_evidence_contextid_idx').on(table.contextid),
      index('competency_evidence_actionuserid_idx').on(table.actionuserid),
  ]);

