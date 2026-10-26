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
import { tenants } from '../tenants/schema';

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
 *
 * Trạng thái rút (đợt neo lại định danh theo vị trí, issue #161, sổ
 * quyết định mục E dòng 19:57 ngày 26/10/2026): `retired_at` khác NULL
 * nghĩa là dòng YCCĐ `program` do dataset quản đã rời khỏi chương
 * trình hiện hành (Bộ rút dòng hoặc rút cả bản ghi) — dòng được GIỮ
 * NGUYÊN trong DB cùng mọi liên kết trỏ vào nó (diff không xoá, FK
 * restrict), chỉ rời khỏi mọi đường đọc "chương trình hiện hành"
 * (lọc tại `CurriculumRepository.listOutcomes`). Chỉ importer được
 * ghi cột này: đặt khi rút, xoá về NULL khi dòng được hồi sinh vì
 * nguyên văn quay lại dataset. Dòng do admin tạo tay và dòng
 * `derived` luôn có `retired_at` NULL.
 */
export const learningOutcomes = pgTable('learning_outcomes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  /** NULL = YCCĐ chuẩn của platform (dữ liệu chuẩn GDPT dùng chung); có giá trị = outcome `derived` thuộc tenant đó (TENANT-0, #168). */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  nodeId: uuid('node_id').notNull().references(() => curriculumNodes.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  position: integer('position').notNull().default(1),
  sourceKind: text('source_kind').notNull().default('program'),
  sourceRef: text('source_ref'),
  derivedFromId: uuid('derived_from_id').references((): AnyPgColumn => learningOutcomes.id, { onDelete: 'set null' }),
  /** Thời điểm dòng bị rút khỏi chương trình hiện hành bởi importer; NULL = đang hiện hành (xem ghi chú đầu bảng). */
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      check('learning_outcomes_position_check', sql`${table.position} > 0`),
      check('learning_outcomes_source_kind_check', sql`${table.sourceKind} in ('program', 'derived')`),
      index('learning_outcomes_tenant_id_idx').on(table.tenantId),
      index('learning_outcomes_node_id_idx').on(table.nodeId, table.position),
      index('learning_outcomes_derived_from_id_idx').on(table.derivedFromId),
      // Chốt chặn ở tầng DB cho bất biến "một ô (node, vị trí) của diện
      // dataset quản có tối đa MỘT dòng hiện hành": thuật toán diff của
      // importer duy trì bất biến này, index biến lỗi diff thành lỗi ồn
      // ào ngay ở lần nạp thay vì lặng lẽ nhân đôi ô. Dòng ngoài diện
      // quản (source_ref NULL — kể cả dòng program admin tạo tay) nằm
      // ngoài index, không bị ảnh hưởng.
      uniqueIndex('learning_outcomes_dataset_slot_unique')
        .on(table.nodeId, table.position)
        .where(sql`${table.sourceKind} = 'program' and ${table.sourceRef} is not null and ${table.retiredAt} is null`),
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
  learningOutcomeId: uuid('learning_outcome_id').notNull().references(() => learningOutcomes.id, { onDelete: 'restrict' }),
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

