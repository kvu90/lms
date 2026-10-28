/** Các bảng của bounded context Content Bank — định nghĩa Drizzle do module content-bank sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { subjects, curriculumNodes } from './curriculum.schema';
import { questionCategories } from './questions.schema';

/**
 * Nội dung Content Bank / Kho học liệu (CB-1, issue #69): thuộc context, có
 * tác giả, trạng thái draft/public, file qua FilesModule — mở rộng thành
 * Kho học liệu tổ/trường:
 * - `resourceType`: loại học liệu — đúng 5 nhóm của Điều 7 TT 09/2021:
 *   multimedia_lecture (bài giảng đa phương tiện, gồm video bài giảng) |
 *   lab_guide (hướng dẫn thí nghiệm, thực hành) | simulation (phần mềm
 *   mô phỏng) | question_set (hệ thống câu hỏi, bài tập luyện tập và kiểm
 *   tra, đánh giá — khi gắn `questionCategoryId` mà không có file thì chỉ
 *   THAM CHIẾU Ngân hàng câu hỏi, KHÔNG chứa bản sao câu hỏi) |
 *   reference (tài liệu tham khảo, bổ trợ).
 * - Bản quyền/nguồn gốc (CB1-B1, TT 09/2021 Điều 4.3 + thể lệ QĐ
 *   2915/2021 + QĐ 1965/QĐ-TTg): `originalAuthor` (tác giả gốc),
 *   `sourceKind` (self = tự soạn | cited = sưu tầm/trích dẫn |
 *   derived = dẫn xuất từ học liệu khác trong kho), `sourceCitation`
 *   (nguồn cụ thể), `license` (giấy phép/mức sử dụng), `derivedFromId`
 *   (học liệu gốc khi dẫn xuất). Học liệu scope trường chưa đủ các
 *   trường này thì KHÔNG gửi duyệt được.
 * - Metadata kỹ thuật/liên thông (CB1-B2): `level` (cấp học độc lập với
 *   khối: primary | lower_secondary | upper_secondary | multi),
 *   `techFormat` (mp4/pdf/pptx/html5/scorm/xapi/link…), `sizeBytes`,
 *   `durationSeconds` (video/audio), `language`.
 * - Metadata sư phạm bắt buộc khi gửi duyệt scope tổ/trường (CB1-B3):
 *   `description`, `keywords`, `targetAudience` (students | teachers |
 *   both), `lessonPosition` (vị trí trong bài theo khung CV 5512:
 *   opening | new_knowledge | practice | application).
 * - `reviewChecklist`: checklist duyệt theo tiêu chí thể lệ Bộ mà người
 *   duyệt đã xác nhận khi phê duyệt (CB1-B3).
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
  resourceType: text('resource_type').notNull().default('reference'), // 5 nhóm Điều 7 TT 09/2021 — xem đầu file
  scope: text('scope').notNull().default('personal'), // personal | org | school
  spaceId: uuid('space_id'), // cohort id khi scope = org
  subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
  grade: smallint('grade'),
  level: text('level'), // primary | lower_secondary | upper_secondary | multi — cấp học độc lập với khối
  curriculumNodeId: uuid('curriculum_node_id').references(() => curriculumNodes.id, { onDelete: 'set null' }),
  outcomeIds: jsonb('outcome_ids'), // string[] — id các YCCĐ gắn với học liệu
  questionCategoryId: uuid('question_category_id').references(() => questionCategories.id, { onDelete: 'set null' }),
  externalUrl: text('external_url'),
  description: text('description'),
  keywords: jsonb('keywords'), // string[]
  targetAudience: text('target_audience'), // students | teachers | both
  lessonPosition: text('lesson_position'), // opening | new_knowledge | practice | application (khung CV 5512)
  techFormat: text('tech_format'), // mp4 | pdf | pptx | docx | html5 | scorm | xapi | link | …
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  durationSeconds: integer('duration_seconds'),
  language: text('language').notNull().default('vi'),
  originalAuthor: text('original_author'),
  sourceKind: text('source_kind'), // self | cited | derived
  sourceCitation: text('source_citation'),
  license: text('license'),
  derivedFromId: uuid('derived_from_id').references((): AnyPgColumn => contentBankContent.id, { onDelete: 'set null' }),
  reviewStatus: text('review_status').notNull().default('draft'), // draft | pending | approved | rejected
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNote: text('review_note'),
  reviewChecklist: jsonb('review_checklist'), // { contentAccurate, sourceClear, pedagogyAesthetics, mobileReady }
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
      index('content_bank_content_curriculum_node_id_idx').on(table.curriculumNodeId),
      index('content_bank_content_question_category_id_idx').on(table.questionCategoryId),
      index('content_bank_content_review_status_idx').on(table.reviewStatus),
      index('content_bank_content_derived_from_id_idx').on(table.derivedFromId),
      check('content_bank_content_grade_check', sql`${table.grade} is null or (${table.grade} between 1 and 12)`),
  ]);
