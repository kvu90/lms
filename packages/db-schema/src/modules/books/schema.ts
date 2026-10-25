import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, smallint, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { curriculumNodes, learningOutcomes, subjects } from '../curriculum/schema';

// ---------------------------------------------------------------------------
// Tầng SÁCH (K0b tái cấu trúc theo chốt của Lão gia tối 24/10/2026): sách
// là THỰC THỂ ĐỘC LẬP (`books`), không nằm dưới chương trình và không
// khoá cứng một bộ sách. Chương trình GDPT 2018 chỉ liên quan qua lớp
// ÁNH XẠ riêng (`book_mappings`: node sách → node chương trình / YCCĐ).
// Môn/khối trên sách chỉ là metadata mô tả của cuốn sách (nullable),
// không phải khoá thuộc cây chương trình. `kind` là loại sách mở rộng
// được — validate ở tầng app (contracts BOOK_KINDS: textbook /
// reference / workbook / other), DB không khoá cứng danh sách. `series`
// là thuộc tính mô tả nullable, không default cứng. `attribution_public`
// là cờ bản quyền THEO SÁCH (mặc định false): chỉ khi bật mới được ghi
// công khai nguồn sách ở các bề mặt dùng chung; truy vết nội bộ luôn
// đầy đủ bất kể cờ.
// ---------------------------------------------------------------------------

/**
 * Một cuốn sách (ấn phẩm thật): SGK, sách tham khảo, sách bài tập, …
 * Hai tập của cùng một cuốn là MỘT bản ghi sách; các chương ghi
 * `volume` để phân biệt. Định danh nạp lại của dataset nằm ở sổ
 * `book_records`, không dựa vào unique mô tả ở bảng này.
 */
export const books = pgTable('books', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  kind: text('kind').notNull().default('textbook'),
  title: text('title').notNull(),
  subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
  grade: smallint('grade'),
  series: text('series'),
  author: text('author'),
  publisher: text('publisher'),
  publishedYear: smallint('published_year'),
  isbn: text('isbn'),
  attributionPublic: boolean('attribution_public').notNull().default(false),
  position: integer('position').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('books_subject_grade_title_unique').on(table.subjectId, table.grade, table.title),
      index('books_subject_id_idx').on(table.subjectId),
      index('books_kind_idx').on(table.kind),
      check('books_grade_check', sql`${table.grade} is null or ${table.grade} between 1 and 12`),
      check('books_position_check', sql`${table.position} > 0`),
  ]);

/**
 * Một node trong cây mục lục CỦA SÁCH: `kind` = 'chapter' (chủ đề/chương
 * — node gốc của cây sách) hoặc 'lesson' (bài học — node lá nằm dưới một
 * chapter). `volume` là tập sách chứa node (1 hoặc 2; null khi cuốn chỉ
 * có một tập). `lessonNumber` là số bài in trong sách; null cho chapter
 * và cho bài mở đầu không đánh số. Khoá ngoại ghép (book_id, parent_id):
 * node con không thể trỏ sang sách khác.
 */
export const bookNodes = pgTable('book_nodes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  title: text('title').notNull(),
  kind: text('kind').notNull().default('lesson'),
  volume: smallint('volume'),
  lessonNumber: integer('lesson_number'),
  position: integer('position').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('book_nodes_book_id_id_unique').on(table.bookId, table.id),
      foreignKey({
        name: 'book_nodes_parent_fk',
        columns: [table.bookId, table.parentId],
        foreignColumns: [table.bookId, table.id],
      }).onDelete('cascade'),
      check('book_nodes_parent_not_self_check', sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`),
      check('book_nodes_kind_check', sql`${table.kind} in ('chapter', 'lesson')`),
      check('book_nodes_volume_check', sql`${table.volume} is null or ${table.volume} between 1 and 2`),
      check('book_nodes_lesson_number_check', sql`${table.lessonNumber} is null or ${table.lessonNumber} > 0`),
      check('book_nodes_position_check', sql`${table.position} > 0`),
      index('book_nodes_tree_idx').on(table.bookId, table.parentId, table.position),
  ]);

/**
 * Ánh xạ một BÀI của sách sang chương trình GDPT 2018: mỗi dòng nối một
 * node bài (`book_node_id`, luôn là kind 'lesson') tới đúng MỘT đích —
 * một node nội dung của cây chuẩn (`curriculum_node_id`) hoặc một YCCĐ
 * cụ thể (`learning_outcome_id`). Đây là bảng duy nhất nối tầng sách với
 * cây chuẩn. Phía sách vẫn cascade (xoá bài = xoá ánh xạ của bài), còn
 * hai đích phía chương trình là RESTRICT (GDPT-SEED): dữ liệu chuẩn có
 * định danh ổn định và không bao giờ bị xoá âm thầm qua ánh xạ — xoá
 * node/YCCĐ còn ánh xạ trỏ vào bị DB chặn, bề mặt quản trị báo lỗi
 * nghiệp vụ trước (curriculum.delete_referenced).
 */
export const bookMappings = pgTable('book_mappings', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  bookNodeId: uuid('book_node_id').notNull().references(() => bookNodes.id, { onDelete: 'cascade' }),
  curriculumNodeId: uuid('curriculum_node_id').references(() => curriculumNodes.id, { onDelete: 'restrict' }),
  learningOutcomeId: uuid('learning_outcome_id').references(() => learningOutcomes.id, { onDelete: 'restrict' }),
  /** Thứ tự ánh xạ của bài (thứ tự dataset) — quyết định thứ tự YCCĐ suy qua ánh xạ; created_at trong cùng transaction không phân biệt được. */
  position: integer('position').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      check('book_mappings_one_target_check', sql`(${table.curriculumNodeId} is null) <> (${table.learningOutcomeId} is null)`),
      uniqueIndex('book_mappings_node_unique').on(table.bookNodeId, table.curriculumNodeId)
        .where(sql`${table.curriculumNodeId} is not null`),
      uniqueIndex('book_mappings_outcome_unique').on(table.bookNodeId, table.learningOutcomeId)
        .where(sql`${table.learningOutcomeId} is not null`),
      index('book_mappings_book_node_idx').on(table.bookNodeId),
      index('book_mappings_curriculum_node_idx').on(table.curriculumNodeId),
      index('book_mappings_outcome_idx').on(table.learningOutcomeId),
  ]);

/**
 * Sổ đăng ký nạp dữ liệu sách — đối ứng của `curriculum_program_records`
 * ở tầng chương trình: mỗi bản ghi của một dataset sách đã kiểm chứng
 * tương ứng đúng một node `lesson` trong cây sách. Cặp (dataset_key,
 * record_id) là định danh ổn định làm khoá nạp lại không nhân đôi;
 * `content_hash` quyết định bỏ qua hay cập nhật; `source` giữ nguyên
 * văn đối tượng truy vết nguồn của dataset.
 */
export const bookRecords = pgTable('book_records', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  datasetKey: text('dataset_key').notNull(),
  recordId: text('record_id').notNull(),
  bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  nodeId: uuid('node_id').notNull().references(() => bookNodes.id, { onDelete: 'cascade' }),
  contentHash: text('content_hash').notNull(),
  source: jsonb('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('book_records_dataset_record_unique').on(table.datasetKey, table.recordId),
      index('book_records_book_id_idx').on(table.bookId),
      index('book_records_node_id_idx').on(table.nodeId),
  ]);
