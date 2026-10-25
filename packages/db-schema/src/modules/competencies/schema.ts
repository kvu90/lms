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
 * CONFIGURATION, not a table join: `scale_configuration` jsonb =
 * { values: string[] (lowest first), proficient: number[] (indexes into
 * values that count as proficient) }. Proficiency is read off THIS scale —
 * never inferred from grades (report §2#15).
 */
export const competencyFramework = pgTable('competency_framework', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  shortName: text('short_name').notNull(),
  idNumber: text('id_number').notNull().default(''),
  description: text('description').notNull().default(''),
  contextId: uuid('context_id').notNull(),
  scaleConfiguration: jsonb('scale_configuration').notNull().default({}),
  taxonomies: text('taxonomies').notNull().default('competency'),
  visible: boolean('visible').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('competency_framework_context_id_idx').on(table.contextId),
  ]);


/**
 * Competencies form a tree inside a framework (Moodle `competency`): path/depth like contexts.
 * Rule fields mirror Moodle's `competency.ruletype`/`ruleconfig`/`ruleoutcome`:
 * `rule_type` is 'points' (Moodle `competency_rule_points`) or null; `rule_config`
 * jsonb = { pointsRequired: number, entries: [{ competencyId, points, required }] }
 * where the entries are DIRECT children of this competency; `rule_outcome` is
 * what happens when the rule matches: 'complete' | 'attach-evidence' | 'nothing'.
 */
export const competency = pgTable('competency', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  frameworkId: uuid('framework_id').notNull().references(() => competencyFramework.id, { onDelete: 'cascade' }),
  shortName: text('short_name').notNull(),
  idNumber: text('id_number').notNull().default(''),
  description: text('description').notNull().default(''),
  parentId: uuid('parent_id'),
  path: text('path').notNull().default(''),
  depth: integer('depth').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
  ruleType: text('rule_type'),
  ruleConfig: jsonb('rule_config'),
  ruleOutcome: text('rule_outcome').notNull().default('nothing'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('competency_framework_id_idx').on(table.frameworkId),
      index('competency_parent_id_idx').on(table.parentId),
  ]);


/**
 * Course ↔ competency link (Moodle `competency_coursecomp`). rule_outcome is
 * EXPLICIT configuration applied when the course is completed:
 * 'complete' | 'attach-evidence' | 'nothing'.
 */
export const competencyCourseComp = pgTable(
  'competency_course_comp',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseId: uuid('course_id').notNull(),
    competencyId: uuid('competency_id').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    ruleOutcome: text('rule_outcome').notNull().default('nothing'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_course_comp_competency_id_idx').on(table.competencyId),unique('competency_course_comp_unique').on(table.courseId, table.competencyId)],
);

/** Activity (cm) ↔ competency link (Moodle `competency_modulecomp`); rule_outcome applies when the activity completes. */
export const competencyModuleComp = pgTable(
  'competency_module_comp',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseModuleId: uuid('course_module_id').notNull(),
    competencyId: uuid('competency_id').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    ruleOutcome: text('rule_outcome').notNull().default('nothing'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_module_comp_competency_id_idx').on(table.competencyId),unique('competency_module_comp_unique').on(table.courseModuleId, table.competencyId)],
);

/** Learning plan templates (Moodle `competency_template`). status: 0=draft(hidden), 1=active. */
export const competencyTemplate = pgTable('competency_template', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  shortName: text('short_name').notNull(),
  description: text('description').notNull().default(''),
  contextId: uuid('context_id').notNull(),
  dueDate: timestamp('due_date', { withTimezone: true }),
  visible: boolean('visible').notNull().default(true),
  status: integer('status').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('competency_template_context_id_idx').on(table.contextId),
  ]);


/** Template ↔ competency links (Moodle `competency_templatecomp`). */
export const competencyTemplateComp = pgTable(
  'competency_template_comp',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    templateId: uuid('template_id').notNull().references(() => competencyTemplate.id, { onDelete: 'cascade' }),
    competencyId: uuid('competency_id').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_template_comp_competency_id_idx').on(table.competencyId),unique('competency_template_comp_unique').on(table.templateId, table.competencyId)],
);

/** Template ↔ cohort links (Moodle `competency_templatecohort`): plans are generated for cohort members. */
export const competencyTemplateCohort = pgTable(
  'competency_template_cohort',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    templateId: uuid('template_id').notNull().references(() => competencyTemplate.id, { onDelete: 'cascade' }),
    cohortId: uuid('cohort_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_template_cohort_cohort_id_idx').on(table.cohortId),unique('competency_template_cohort_unique').on(table.templateId, table.cohortId)],
);

/**
 * Learning plans per user (Moodle `competency_plan` → `learning_plans`).
 * status: 0=draft, 1=active, 2=waitingforreview, 3=inreview, 4=complete.
 */
export const learningPlans = pgTable('learning_plans', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  userId: uuid('user_id').notNull(),
  templateId: uuid('template_id'),
  status: integer('status').notNull().default(0),
  dueDate: timestamp('due_date', { withTimezone: true }),
  reviewerId: uuid('reviewer_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('learning_plans_user_id_idx').on(table.userId),
      index('learning_plans_template_id_idx').on(table.templateId),
      index('learning_plans_reviewer_id_idx').on(table.reviewerId),
  ]);


/** Plan ↔ competency links for plans not (or no longer) bound to a template (Moodle `competency_plancomp`). */
export const competencyPlanComp = pgTable(
  'competency_plan_comp',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    planId: uuid('plan_id').notNull().references(() => learningPlans.id, { onDelete: 'cascade' }),
    competencyId: uuid('competency_id').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_plan_comp_competency_id_idx').on(table.competencyId),unique('competency_plan_comp_unique').on(table.planId, table.competencyId)],
);

/** Review history of a learning plan: every lifecycle transition is a row (request/start/stop/approve/unapprove/complete). */
export const competencyPlanReview = pgTable('competency_plan_review', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  planId: uuid('plan_id').notNull().references(() => learningPlans.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').notNull(),
  action: text('action').notNull(),
  statusFrom: integer('status_from').notNull(),
  statusTo: integer('status_to').notNull(),
  note: text('note').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('competency_plan_review_plan_id_idx').on(table.planId),
      index('competency_plan_review_actor_id_idx').on(table.actorId),
  ]);


/**
 * A user's standing on one competency (Moodle `competency_usercomp`).
 * `grade` is an INDEX into the framework scale; `proficiency` is derived
 * from the scale configuration, never from course grades. Review status:
 * 0=none, 1=waitingforreview, 2=inreview. Exactly one of plan_id/course_id
 * scopes the row (plan-based and course-based user competencies are
 * separate records in Moodle too).
 */
export const competencyUserComp = pgTable(
  'competency_user_comp',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    competencyId: uuid('competency_id').notNull().references(() => competency.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id'),
    courseId: uuid('course_id'),
    status: integer('status').notNull().default(0),
    proficiency: boolean('proficiency'),
    grade: integer('grade'),
    reviewerId: uuid('reviewer_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('competency_user_comp_competency_id_idx').on(table.competencyId),
      index('competency_user_comp_plan_id_idx').on(table.planId),
      index('competency_user_comp_course_id_idx').on(table.courseId),
      index('competency_user_comp_reviewer_id_idx').on(table.reviewerId),unique('competency_user_comp_unique').on(table.userId, table.competencyId, table.planId, table.courseId)],
);

/**
 * Evidence log for a user competency (Moodle `competency_evidence`). Every
 * material event is a row: manual evidence, course-completion evidence,
 * review requests and review outcomes — together they ARE the review
 * history. `grade` here is a scale index snapshot (nullable).
 */
export const competencyEvidence = pgTable('competency_evidence', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userCompetencyId: uuid('user_competency_id').notNull().references(() => competencyUserComp.id, { onDelete: 'cascade' }),
  contextId: uuid('context_id'),
  actionUserId: uuid('action_user_id').notNull(),
  action: text('action').notNull().default('evidence'),
  description: text('description').notNull().default(''),
  url: text('url'),
  grade: integer('grade'),
  note: text('note').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('competency_evidence_user_competency_id_idx').on(table.userCompetencyId),
      index('competency_evidence_context_id_idx').on(table.contextId),
      index('competency_evidence_action_user_id_idx').on(table.actionUserId),
  ]);

