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
 * Khung năng lực (Moodle `competency_framework`). Thang đo là
 * CẤU HÌNH, không phải phép nối bảng: `scale_configuration` jsonb =
 * { values: string[] (thấp nhất trước), proficient: number[] (các chỉ số trong
 * values được tính là đạt) }. Mức đạt được đọc từ CHÍNH thang đo này —
 * không bao giờ suy ra từ điểm số (report §2#15).
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
 * Các năng lực tạo thành một cây bên trong một khung (Moodle `competency`): path/depth giống như các context.
 * Các trường quy tắc phản ánh `competency.ruletype`/`ruleconfig`/`ruleoutcome` của Moodle:
 * `rule_type` là 'points' (Moodle `competency_rule_points`) hoặc null; `rule_config`
 * jsonb = { pointsRequired: number, entries: [{ competencyId, points, required }] }
 * trong đó các entries là các năng lực con TRỰC TIẾP của năng lực này; `rule_outcome` là
 * điều xảy ra khi quy tắc khớp: 'complete' | 'attach-evidence' | 'nothing'.
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
 * Liên kết khoá học ↔ năng lực (Moodle `competency_coursecomp`). rule_outcome là
 * cấu hình TƯỜNG MINH được áp dụng khi khoá học được hoàn thành:
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

/** Liên kết hoạt động (cm) ↔ năng lực (Moodle `competency_modulecomp`); rule_outcome áp dụng khi hoạt động hoàn thành. */
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

/** Mẫu kế hoạch học tập (Moodle `competency_template`). status: 0=draft (ẩn), 1=active. */
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


/** Liên kết mẫu ↔ năng lực (Moodle `competency_templatecomp`). */
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

/** Liên kết mẫu ↔ cohort (Moodle `competency_templatecohort`): kế hoạch được sinh cho các thành viên của cohort. */
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
 * Kế hoạch học tập theo từng user (Moodle `competency_plan` → `learning_plans`).
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


/** Liên kết kế hoạch ↔ năng lực cho các kế hoạch không (hoặc không còn) gắn với một mẫu (Moodle `competency_plancomp`). */
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

/** Lịch sử duyệt của một kế hoạch học tập: mỗi lần chuyển đổi vòng đời là một dòng (request/start/stop/approve/unapprove/complete). */
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
 * Vị thế của một user trên một năng lực (Moodle `competency_usercomp`).
 * `grade` là một CHỈ SỐ vào thang đo của khung; `proficiency` được suy ra
 * từ cấu hình thang đo, không bao giờ từ điểm của khoá học. Trạng thái duyệt:
 * 0=none, 1=waitingforreview, 2=inreview. Đúng một trong plan_id/course_id
 * xác định phạm vi của dòng (năng lực của user theo kế hoạch và theo khoá học cũng là
 * các bản ghi tách biệt trong Moodle).
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
 * Nhật ký bằng chứng cho một năng lực của user (Moodle `competency_evidence`). Mỗi
 * sự kiện trọng yếu là một dòng: bằng chứng thủ công, bằng chứng hoàn thành khoá học,
 * yêu cầu duyệt và kết quả duyệt — gộp lại chúng CHÍNH LÀ lịch sử
 * duyệt. `grade` ở đây là bản chụp chỉ số trên thang đo (có thể null).
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

