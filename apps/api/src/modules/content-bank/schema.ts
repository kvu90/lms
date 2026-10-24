/** Các bảng của bounded context Content Bank — định nghĩa Drizzle do module content-bank sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { subjects, curriculumNodes } from '../curriculum/schema';
import { questionCategories } from '../questions/schema';

/**
 * Nội dung Content Bank / Kho học liệu (CB-1, issue #69): thuộc context, có
 * tác giả, trạng thái draft/public, file qua FilesModule — mở rộng thành
 * Kho học liệu tổ/trường:
 * - `resourceType`: loại học liệu — lecture (bài giảng) | worksheet (phiếu
 *   học tập) | video (video/liên kết) | question_set (tham chiếu bộ câu
 *   hỏi trong Ngân hàng câu hỏi qua `questionCategoryId`, KHÔNG chứa bản
 *   sao câu hỏi) | other.
 * - `scope` + `spaceId`: không gian — personal (cá nhân, context = context
 *   của tác giả) | org (tổ chuyên môn, `spaceId` = id cohort đóng vai trò
 *   tổ) | school (toàn trường, context = hệ thống).
 * - Metadata chương trình: `subjectId` (môn), `grade` (khối 1–12),
 *   `curriculumNodeId` (node chương trình), `outcomeIds` (danh sách YCCĐ,
 *   jsonb) — FK lỏng (set null) để cây chương trình đổi không làm mất học
 *   liệu; cùng khuôn metadata với Ngân hàng câu hỏi.
 * - Duyệt: `reviewStatus` draft → pending → approved/rejected. Học liệu
 *   scope org/school chỉ hiện với người khác khi approved; cá nhân không
 *   qua duyệt (approved ngay khi tạo).
 */
export const contentBankContent = pgTable('content_bank_content', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  contentType: text('content_type').notNull().default('file-based'),
  contextId: uuid('context_id').notNull(),
  creatorId: uuid('creator_id').notNull(),
  visibility: text('visibility').notNull().default('draft'), // draft | public
  fileId: uuid('file_id'),
  configData: jsonb('config_data'),
  resourceType: text('resource_type').notNull().default('other'), // lecture | worksheet | video | question_set | other
  scope: text('scope').notNull().default('personal'), // personal | org | school
  spaceId: uuid('space_id'), // cohort id khi scope = org
  subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
  grade: smallint('grade'),
  curriculumNodeId: uuid('curriculum_node_id').references(() => curriculumNodes.id, { onDelete: 'set null' }),
  outcomeIds: jsonb('outcome_ids'), // string[] — id các YCCĐ gắn với học liệu
  questionCategoryId: uuid('question_category_id').references(() => questionCategories.id, { onDelete: 'set null' }),
  externalUrl: text('external_url'),
  reviewStatus: text('review_status').notNull().default('draft'), // draft | pending | approved | rejected
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNote: text('review_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('content_bank_content_context_id_idx').on(table.contextId),
      index('content_bank_content_creator_id_idx').on(table.creatorId),
      index('content_bank_content_file_id_idx').on(table.fileId),
      index('content_bank_content_scope_idx').on(table.scope),
      index('content_bank_content_space_id_idx').on(table.spaceId),
      index('content_bank_content_subject_id_idx').on(table.subjectId),
      index('content_bank_content_review_status_idx').on(table.reviewStatus),
      check('content_bank_content_grade_check', sql`${table.grade} is null or (${table.grade} between 1 and 12)`),
  ]);
