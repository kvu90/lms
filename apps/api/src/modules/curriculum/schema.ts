/** Các bảng của bounded context Curriculum — định nghĩa Drizzle do module curriculum sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { question } from '../questions/schema';

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
 *   cấp gốc của cây), 'topic' = chủ đề, 'lesson' = **nội dung của chương
 *   trình** (quy ước Chặng 2, mục A.4 của hồ sơ thiết kế): node 'lesson'
 *   là một đơn vị nội dung trong văn bản Chương trình môn học GDPT 2018
 *   (ví dụ "Tính đơn điệu của hàm số" trong CT Toán 12), KHÔNG phải
 *   chương/bài của bất kỳ cuốn SGK nào — cây này chỉ chứa node trích từ
 *   chương trình; dữ liệu chương/bài SGK thuộc tầng ánh xạ riêng đặt
 *   ngoài cây chuẩn, không bao giờ nhập thành node ở đây. Chọn cột
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
 * Truy vết nguồn (Chặng 2, mục A.3 của hồ sơ thiết kế): `source_kind`
 * phân biệt YCCĐ **nguyên văn chương trình** ('program' — chép nguyên
 * văn từ văn bản Chương trình môn học của Bộ, thẩm quyền Bộ, bất biến)
 * với YCCĐ **tổ chuyên môn biên tập/tách theo mức** ('derived' — thẩm
 * quyền trường, trỏ về YCCĐ gốc qua `derived_from_id`); `source_ref` là
 * trích dẫn nguồn nguyên văn (ví dụ "TT 32/2018/TT-BGDĐT — CT môn Toán,
 * lớp 12"). Định danh trình bày cho người dùng là vị trí trong chương
 * trình, không hiển thị uuid và không có "mã YCCĐ" (Bộ không ban hành mã).
 */
export const learningOutcomes = pgTable('learning_outcomes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  nodeId: uuid('node_id').notNull().references(() => curriculumNodes.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  position: integer('position').notNull().default(1),
  sourceKind: text('source_kind').notNull().default('program'),
  sourceRef: text('source_ref'),
  derivedFromId: uuid('derived_from_id').references((): AnyPgColumn => learningOutcomes.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      check('learning_outcomes_position_check', sql`${table.position} > 0`),
      check('learning_outcomes_source_kind_check', sql`${table.sourceKind} in ('program', 'derived')`),
      index('learning_outcomes_node_id_idx').on(table.nodeId, table.position),
      index('learning_outcomes_derived_from_id_idx').on(table.derivedFromId),
  ]);

/**
 * Gắn câu hỏi ↔ môn học ở CẤP DANH TÍNH CÂU HỎI (Chặng 2, mục A.1):
 * nối `question.id`, không nối phiên bản — sửa câu (ra version mới)
 * không làm mất gắn kết. Bảng này cho câu mới gắn ở mức môn (chưa/chưa
 * cần gắn YCCĐ cụ thể) và cho lọc/đếm câu theo môn; neo chính xác cho
 * ma trận đề là `question_learning_outcomes` bên dưới.
 */
export const questionSubjects = pgTable('question_subjects', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionId: uuid('question_id').notNull().references(() => question.id, { onDelete: 'cascade' }),
  subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('question_subjects_question_subject_unique').on(table.questionId, table.subjectId),
      index('question_subjects_subject_id_idx').on(table.subjectId),
      index('question_subjects_question_id_idx').on(table.questionId),
  ]);

/**
 * Gắn câu hỏi ↔ YCCĐ ở CẤP DANH TÍNH CÂU HỎI (Chặng 2, mục A.1 + A.2):
 * đây là neo chính xác cho ma trận đề của Quiz Chặng 3 — YCCĐ suy ngược
 * ra node → curriculum → môn + khối nên dòng nối không lưu thừa
 * subject/curriculum. **Mức độ nhận thức nằm trên dòng nối này**
 * (`cognitive_level`), không nằm trên câu hỏi hay phiên bản câu: bản
 * đặc tả của Bộ ghi mức ngay trên dòng YCCĐ, và một câu có thể đo hai
 * YCCĐ ở hai mức khác nhau. Khoá mức dạng text: 'biet' / 'hieu' /
 * 'van_dung' (khung 3 mức hiện hành cho trung học); check cho phép thêm
 * 'van_dung_cao' để biến thể 4 mức dùng được mà không sửa schema sau
 * này — tập mức đang áp do preset của ma trận quyết định, không do cột
 * này. Index (learning_outcome_id, cognitive_level) phục vụ đếm ứng
 * viên cho ô ma trận ở Chặng 3.
 */
export const questionLearningOutcomes = pgTable('question_learning_outcomes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionId: uuid('question_id').notNull().references(() => question.id, { onDelete: 'cascade' }),
  learningOutcomeId: uuid('learning_outcome_id').notNull().references(() => learningOutcomes.id, { onDelete: 'cascade' }),
  cognitiveLevel: text('cognitive_level').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('question_learning_outcomes_question_outcome_unique').on(table.questionId, table.learningOutcomeId),
      check('question_learning_outcomes_cognitive_level_check', sql`${table.cognitiveLevel} in ('biet', 'hieu', 'van_dung', 'van_dung_cao')`),
      index('question_learning_outcomes_outcome_level_idx').on(table.learningOutcomeId, table.cognitiveLevel),
      index('question_learning_outcomes_question_id_idx').on(table.questionId),
  ]);

/**
 * Sổ đăng ký nạp dữ liệu chương trình chuẩn (K0a): mỗi bản ghi của một
 * dataset đã kiểm chứng (ví dụ bản ghi TOAN-0001 trong
 * `program-data/program-toan.json`, trích nguyên văn từ văn bản ban hành
 * kèm Thông tư 32/2018/TT-BGDĐT) tương ứng đúng một node `lesson` trong
 * cây. Cặp (dataset_key, record_id) là **định danh ổn định của bản ghi**
 * làm khoá cho cơ chế nạp lại không nhân đôi: nạp lại tra sổ theo cặp
 * này, `content_hash` (sha256 của bản ghi gốc dạng chuẩn hoá) quyết định
 * bỏ qua (khớp) hay cập nhật node + toàn bộ YCCĐ của nó (lệch — dataset
 * được đính chính ở nguồn). Cột `source` giữ nguyên văn đối tượng truy
 * vết nguồn của dataset (văn bản, file PDF, cổng công bố, trang) để mọi
 * lần đối chiếu tự động truy được về văn bản chính chủ mà không phải mở
 * lại file dataset.
 */
export const curriculumProgramRecords = pgTable('curriculum_program_records', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  datasetKey: text('dataset_key').notNull(),
  recordId: text('record_id').notNull(),
  subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
  curriculumId: uuid('curriculum_id').notNull().references(() => curricula.id, { onDelete: 'cascade' }),
  nodeId: uuid('node_id').notNull().references(() => curriculumNodes.id, { onDelete: 'cascade' }),
  contentHash: text('content_hash').notNull(),
  source: jsonb('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('curriculum_program_records_dataset_record_unique').on(table.datasetKey, table.recordId),
      index('curriculum_program_records_subject_id_idx').on(table.subjectId),
      index('curriculum_program_records_node_id_idx').on(table.nodeId),
      index('curriculum_program_records_curriculum_id_idx').on(table.curriculumId),
  ]);

// ---------------------------------------------------------------------------
// Tầng SGK "Kết nối tri thức với cuộc sống" (K0b, issue #67)
//
// Tầng này đặt NGOÀI cây curriculum chuẩn theo đúng kết luận của hồ sơ
// neo ma trận/bản đặc tả: cây chuẩn chỉ chứa chương trình GDPT 2018;
// chương/bài SGK là lớp ánh xạ + cắt phạm vi tiến độ, tham chiếu vào cây
// chuẩn qua bảng ánh xạ riêng — tuyệt đối không nhập node SGK thành node
// trong `curriculum_nodes`. Từ năm học 2026–2027 cả nước dùng một bộ
// SGK thống nhất (QĐ 3588/QĐ-BGDĐT) nên `series` hiện chỉ có một giá trị;
// cột vẫn tồn tại tường minh để truy vết nguồn ghi rõ bộ sách của mọi
// bản ghi.
// ---------------------------------------------------------------------------

/**
 * Một cuốn SGK của bộ thống nhất cho một môn × khối (ví dụ "Toán 1").
 * Sách thuộc về môn (`subjects`) đã có trong cây chuẩn — tầng sách không
 * tạo môn riêng. Một cặp (môn, khối, tựa) là duy nhất: hai tập của cùng
 * một cuốn là MỘT bản ghi sách, các chương ghi `volume` để phân biệt.
 */
export const curriculumTextbooks = pgTable('curriculum_textbooks', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
  grade: smallint('grade').notNull(),
  title: text('title').notNull(),
  series: text('series').notNull().default('ket-noi-tri-thuc-voi-cuoc-song'),
  position: integer('position').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('curriculum_textbooks_subject_grade_title_unique').on(table.subjectId, table.grade, table.title),
      index('curriculum_textbooks_subject_id_idx').on(table.subjectId),
      check('curriculum_textbooks_grade_check', sql`${table.grade} between 1 and 12`),
      check('curriculum_textbooks_position_check', sql`${table.position} > 0`),
      check('curriculum_textbooks_series_check', sql`${table.series} in ('ket-noi-tri-thuc-voi-cuoc-song')`),
  ]);

/**
 * Một node trong cây của một cuốn SGK: `kind` = 'chapter' (chủ đề/chương
 * — node gốc của cây sách) hoặc 'lesson' (bài học — node lá nằm dưới một
 * chapter). `volume` là tập sách chứa node (1 hoặc 2; null khi cuốn chỉ
 * có một tập). `lessonNumber` là số bài in trong sách (1, 2, 3, …); null
 * cho chapter và cho bài mở đầu không đánh số (ví dụ "Tiết học đầu
 * tiên"). Khoá ngoại ghép (textbook_id, parent_id) như cây chuẩn: node
 * con không thể trỏ sang sách khác, và chapter không thể làm con của
 * lesson (ràng buộc tầng service khi nạp).
 */
export const curriculumTextbookNodes = pgTable('curriculum_textbook_nodes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  textbookId: uuid('textbook_id').notNull().references(() => curriculumTextbooks.id, { onDelete: 'cascade' }),
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
      unique('curriculum_textbook_nodes_textbook_id_id_unique').on(table.textbookId, table.id),
      foreignKey({
        name: 'curriculum_textbook_nodes_parent_fk',
        columns: [table.textbookId, table.parentId],
        foreignColumns: [table.textbookId, table.id],
      }).onDelete('cascade'),
      check('curriculum_textbook_nodes_parent_not_self_check', sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`),
      check('curriculum_textbook_nodes_kind_check', sql`${table.kind} in ('chapter', 'lesson')`),
      check('curriculum_textbook_nodes_volume_check', sql`${table.volume} is null or ${table.volume} between 1 and 2`),
      check('curriculum_textbook_nodes_lesson_number_check', sql`${table.lessonNumber} is null or ${table.lessonNumber} > 0`),
      check('curriculum_textbook_nodes_position_check', sql`${table.position} > 0`),
      index('curriculum_textbook_nodes_tree_idx').on(table.textbookId, table.parentId, table.position),
  ]);

/**
 * Ánh xạ một BÀI SGK sang chương trình GDPT 2018: mỗi dòng nối một node
 * bài (`textbook_node_id`, luôn là kind 'lesson') tới đúng MỘT đích —
 * một node nội dung của cây chuẩn (`curriculum_node_id`) hoặc một YCCĐ
 * cụ thể (`learning_outcome_id`). Đây là bảng duy nhất nối tầng SGK với
 * cây chuẩn; nhờ nó mọi section/mục nạp từ khung SGK đều truy ngược
 * được về YCCĐ của chương trình. Đích bị xoá thì dòng ánh xạ bị xoá
 * theo (cascade cả hai phía) để không tồn tại ánh xạ treo nửa vời vi
 * phạm check "đúng một đích".
 */
export const curriculumTextbookMappings = pgTable('curriculum_textbook_mappings', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  textbookNodeId: uuid('textbook_node_id').notNull().references(() => curriculumTextbookNodes.id, { onDelete: 'cascade' }),
  curriculumNodeId: uuid('curriculum_node_id').references(() => curriculumNodes.id, { onDelete: 'cascade' }),
  learningOutcomeId: uuid('learning_outcome_id').references(() => learningOutcomes.id, { onDelete: 'cascade' }),
  /** Thứ tự ánh xạ của bài (thứ tự dataset) — quyết định thứ tự YCCĐ suy qua ánh xạ; created_at trong cùng transaction không phân biệt được. */
  position: integer('position').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      check('curriculum_textbook_mappings_one_target_check', sql`(${table.curriculumNodeId} is null) <> (${table.learningOutcomeId} is null)`),
      uniqueIndex('curriculum_textbook_mappings_node_unique').on(table.textbookNodeId, table.curriculumNodeId)
        .where(sql`${table.curriculumNodeId} is not null`),
      uniqueIndex('curriculum_textbook_mappings_outcome_unique').on(table.textbookNodeId, table.learningOutcomeId)
        .where(sql`${table.learningOutcomeId} is not null`),
      index('curriculum_textbook_mappings_textbook_node_idx').on(table.textbookNodeId),
      index('curriculum_textbook_mappings_curriculum_node_idx').on(table.curriculumNodeId),
      index('curriculum_textbook_mappings_outcome_idx').on(table.learningOutcomeId),
  ]);

/**
 * Sổ đăng ký nạp dữ liệu SGK (K0b) — đối ứng của
 * `curriculum_program_records` ở tầng chương trình: mỗi bản ghi của một
 * dataset SGK đã kiểm chứng (ví dụ bản ghi SGK-TOAN1-007, Bài 1 của sách
 * Toán 1) tương ứng đúng một node `lesson` trong cây sách. Cặp
 * (dataset_key, record_id) là định danh ổn định làm khoá nạp lại không
 * nhân đôi; `content_hash` (sha256 của bản ghi gốc dạng chuẩn hoá, gồm
 * cả danh sách ánh xạ theo mã bản ghi chương trình) quyết định bỏ qua
 * hay cập nhật; `source` giữ nguyên văn đối tượng truy vết nguồn của
 * dataset (bộ sách, cuốn/tập, hiện vật đối chiếu) để truy về nguồn
 * chính chủ mà không phải mở lại file dataset.
 */
export const curriculumTextbookRecords = pgTable('curriculum_textbook_records', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  datasetKey: text('dataset_key').notNull(),
  recordId: text('record_id').notNull(),
  textbookId: uuid('textbook_id').notNull().references(() => curriculumTextbooks.id, { onDelete: 'cascade' }),
  nodeId: uuid('node_id').notNull().references(() => curriculumTextbookNodes.id, { onDelete: 'cascade' }),
  contentHash: text('content_hash').notNull(),
  source: jsonb('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('curriculum_textbook_records_dataset_record_unique').on(table.datasetKey, table.recordId),
      index('curriculum_textbook_records_textbook_id_idx').on(table.textbookId),
      index('curriculum_textbook_records_node_id_idx').on(table.nodeId),
  ]);
