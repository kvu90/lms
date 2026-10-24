/** Các bảng của bounded context Question Import — định nghĩa Drizzle do module question-import sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
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
import { question, questionCategories } from '../questions/schema';

/**
 * Một đợt nhập đề từ file (issue #52): giáo viên tải một file docx/pdf lên
 * một question category đích; hệ thống tách câu thuần quy tắc thành các
 * mục chờ duyệt (question_import_items). Câu CHƯA duyệt không tồn tại ở
 * bất kỳ bảng ngân hàng nào — đây là bất biến cốt lõi của lát này: hàng
 * đợi duyệt là vùng đệm tách hẳn khỏi ngân hàng câu hỏi chính thức.
 * status: 'in_review' (còn mục chờ) → 'completed' (không còn mục chờ).
 */
export const questionImportBatches = pgTable('question_import_batches', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  categoryId: uuid('category_id').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
  uploadedBy: uuid('uploaded_by').notNull(),
  fileName: text('file_name').notNull(),
  fileKind: text('file_kind').notNull(),
  fileSize: integer('file_size').notNull(),
  contentHash: text('content_hash').notNull(),
  status: text('status').notNull().default('in_review'),
  totalItems: integer('total_items').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('question_import_batches_category_id_idx').on(table.categoryId),
      index('question_import_batches_uploaded_by_idx').on(table.uploadedBy),
  ]);

/**
 * Một câu đã tách đang chờ duyệt trong một đợt nhập. `payload` là dạng
 * hợp đồng QuestionImportItemPayload (packages/contracts): nội dung câu +
 * đáp án + các liên kết YCCĐ/mức giáo viên chọn tại bước duyệt. `issues`
 * là danh sách vấn đề do bộ tách/bộ kiểm tra ghi ({severity, code,
 * message}[]) — mục có issue severity 'error' bị chặn duyệt cho tới khi
 * giáo viên sửa payload hết lỗi. Khi duyệt thành công, `questionId` trỏ
 * tới câu hỏi chính thức vừa tạo trong ngân hàng; `rawText` giữ nguyên
 * khối văn bản gốc trong file để giáo viên đối chiếu khi duyệt.
 * status: 'pending' → 'approved' | 'rejected'.
 */
export const questionImportItems = pgTable('question_import_items', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  batchId: uuid('batch_id').notNull().references(() => questionImportBatches.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  sourceNumber: integer('source_number'),
  qtype: text('qtype').notNull(),
  status: text('status').notNull().default('pending'),
  payload: jsonb('payload').notNull(),
  issues: jsonb('issues').notNull().default(sql`'[]'::jsonb`),
  rawText: text('raw_text').notNull().default(''),
  questionId: uuid('question_id').references(() => question.id, { onDelete: 'set null' }),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('question_import_items_batch_id_idx').on(table.batchId),
      index('question_import_items_question_id_idx').on(table.questionId),
      unique('question_import_items_batch_ordinal_unique').on(table.batchId, table.ordinal),
  ]);
