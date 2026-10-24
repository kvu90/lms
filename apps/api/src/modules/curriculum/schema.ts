/** Các bảng của bounded context Curriculum — định nghĩa Drizzle do module curriculum sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Môn học — cấp gốc của chương trình (port từ giaokhoa `subjects`).
 * Khác giaokhoa ở điểm neo quyền: môn học thuộc về một context (như
 * question_categories của ngân hàng câu hỏi) và mọi quyền đọc/ghi trên
 * cây curriculum được quyết qua PermissionEvaluator tại context đó,
 * không theo sở hữu cá nhân. Slug là mã đường dẫn duy nhất toàn hệ.
 */
export const subjects = pgTable('subjects', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  contextId: uuid('context_id').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  position: integer('position').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('subjects_context_id_idx').on(table.contextId),
      check('subjects_position_check', sql`${table.position} > 0`),
  ]);

/**
 * Chương trình của một môn ở một khối lớp (port từ giaokhoa `curricula`):
 * mỗi cặp (môn, khối 1–12) chỉ có tối đa một chương trình.
 */
export const curricula = pgTable('curricula', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
  grade: smallint('grade').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('curricula_subject_id_idx').on(table.subjectId),
      check('curricula_grade_check', sql`${table.grade} between 1 and 12`),
      unique('curricula_subject_id_grade_unique').on(table.subjectId, table.grade),
  ]);

/**
 * Một node trong cây nội dung của chương trình (port từ giaokhoa
 * `curriculum_nodes`). Bổ sung cho số hoá GDPT 2018:
 * - `kind` là tầng tường minh của node: 'strand' = mạch nội dung (thường ở
 *   cấp gốc của cây), 'topic' = chủ đề, 'lesson' = bài/nội dung. Chọn cột
 *   phân loại tường minh thay vì bảng mạch riêng vì mạch có đúng cấu trúc
 *   của một node (tiêu đề, thứ tự, thời lượng, node con, outcomes treo bên
 *   dưới) — bảng riêng sẽ nhân đôi cơ chế cây của giaokhoa.
 * - `duration_periods` (số tiết dự kiến) và `duration_percent` (tỉ trọng %
 *   thời lượng) là căn cứ suy tỉ lệ điểm của ma trận đề về sau.
 * Khoá ngoại ghép (curriculum_id, parent_id) bảo đảm node con không thể
 * trỏ sang chương trình khác — giữ nguyên thiết kế giaokhoa.
 */
export const curriculumNodes = pgTable('curriculum_nodes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  curriculumId: uuid('curriculum_id').notNull().references(() => curricula.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  title: text('title').notNull(),
  kind: text('kind').notNull().default('topic'),
  position: integer('position').notNull().default(1),
  durationPeriods: integer('duration_periods'),
  durationPercent: doublePrecision('duration_percent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('curriculum_nodes_curriculum_id_id_unique').on(table.curriculumId, table.id),
      foreignKey({
        name: 'curriculum_nodes_parent_fk',
        columns: [table.curriculumId, table.parentId],
        foreignColumns: [table.curriculumId, table.id],
      }).onDelete('cascade'),
      check('curriculum_nodes_parent_not_self_check', sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`),
      check('curriculum_nodes_position_check', sql`${table.position} > 0`),
      check('curriculum_nodes_kind_check', sql`${table.kind} in ('strand', 'topic', 'lesson')`),
      check('curriculum_nodes_duration_periods_check', sql`${table.durationPeriods} is null or ${table.durationPeriods} >= 0`),
      check('curriculum_nodes_duration_percent_check', sql`${table.durationPercent} is null or (${table.durationPercent} >= 0 and ${table.durationPercent} <= 100)`),
      index('curriculum_nodes_tree_idx').on(table.curriculumId, table.parentId, table.position),
  ]);

/**
 * Yêu cầu cần đạt (port từ giaokhoa `learning_outcomes`): mỗi node nội
 * dung mang nhiều YCCD; đây là điểm neo để Chặng 2 gắn câu hỏi vào
 * chương trình (question_learning_outcomes).
 */
export const learningOutcomes = pgTable('learning_outcomes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  nodeId: uuid('node_id').notNull().references(() => curriculumNodes.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  position: integer('position').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      check('learning_outcomes_position_check', sql`${table.position} > 0`),
      index('learning_outcomes_node_id_idx').on(table.nodeId, table.position),
  ]);
