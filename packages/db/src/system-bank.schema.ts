/**
 * Các bảng của KHO NGÂN HÀNG HỆ THỐNG (issue #585, chương trình tenant #579) —
 * database riêng trên cùng cụm Postgres với kho nghiệp vụ, phục vụ qua dịch vụ/API
 * riêng phía platform. Nội dung dùng chung duy nhất giữa các trung tâm là Ngân
 * hàng câu hỏi hệ thống: bản chính tập trung, phiên bản bất biến, giáo viên tìm
 * câu qua API, khi đưa câu vào đề thì sao chép bản chụp đúng phiên bản vào kho
 * của trung tâm kèm truy vết nguồn.
 *
 * Vì sao file này KHÔNG nằm trong barrel `src/index.ts`: barrel đó là nguồn sinh
 * migration của kho nghiệp vụ (`apps/api/drizzle.config.ts` trỏ vào index.ts).
 * Kho ngân hàng có database RIÊNG và bộ migration RIÊNG
 * (`apps/api/drizzle-system-bank.config.ts` trỏ thẳng vào file này, đầu ra
 * `apps/api/drizzle-system-bank/`) — trộn hai bộ schema vào một điểm sinh
 * migration sẽ làm mỗi phía sinh lệnh tạo/xoá bảng của phía kia. Điểm vào dùng
 * chung của file này là subpath `@lms/db/system-bank` (xem `src/system-bank.ts`).
 *
 * Quy ước dữ liệu của tầng này:
 * - Không khoá ngoại sang kho nghiệp vụ (hai database tách nhau, không tồn tại
 *   khoá ngoại xuyên kho ở bất kỳ đâu trong hệ): các định danh phía nghiệp vụ
 *   (người tạo, người nhập, YCCĐ nguồn) lưu dạng uuid thuần, toàn vẹn do tầng
 *   service bảo đảm. Khoá ngoại CHỈ tồn tại giữa các bảng trong chính kho này.
 * - Không RLS, không `tenant_id`: đây là dữ liệu của platform, không thuộc
 *   tenant nào; quyền truy cập cưỡng chế ở tầng service bằng cổng platform
 *   (quản trị phát hành) và ngữ cảnh trung tâm (khám phá/nhập). Các bảng này
 *   là bảng nền tảng của kho ngân hàng theo quyết định trong đặc tả issue
 *   #585 — ngoại lệ đích danh với khuôn RLS của bảng nghiệp vụ (xem
 *   AGENTS.md của package).
 * - Phiên bản bất biến: nội dung đã phát hành không sửa đè — mỗi lần sửa tạo
 *   một dòng version mới; trạng thái được phép dùng (đang phát hành / đã rút)
 *   là metadata trên dòng câu hỏi, tách khỏi nội dung phiên bản.
 * - Gói phiên bản là tài liệu JSON tự chứa: nội dung câu, đáp án và quy tắc
 *   chấm, phản hồi, ngữ liệu đi kèm (nội dung stimulus, không phải id — id
 *   stimulus thuộc kho nghiệp vụ nên không có nghĩa xuyên kho), tuỳ chọn
 *   theo dạng câu; media đi kèm nằm trong chính tài liệu Tiptap dưới dạng
 *   tham chiếu contentHash của object storage dùng chung nên không cần bảng
 *   riêng. Gắn chuẩn YCCĐ của phiên bản nằm ở bảng liên kết riêng để lọc
 *   khám phá được theo YCCĐ.
 */
import {
  check,
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
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Danh tính câu hỏi hệ thống: ổn định suốt vòng đời, là định danh nguồn mà
 * mọi bản chụp ở trung tâm truy vết về. Khi di trú dữ kiện hiện hữu, id này
 * giữ nguyên id của câu trong kho chung để truy vết không gãy.
 * `status`: `published` = đang phát hành (khám phá + nhập được),
 * `withdrawn` = đã rút (ngừng khám phá và ngừng nhập mới ngay; đề và bài
 * làm đã chốt chứa bản chụp vẫn thi/chấm nguyên trạng).
 */
export const systemQuestions = pgTable('system_questions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  /** Một trong bốn dạng câu của hệ: multichoice | truefalse | shortanswer | essay. */
  qtype: text('qtype').notNull(),
  /** published | withdrawn. */
  status: text('status').notNull().default('published'),
  /** Truy vết lần rút câu gần nhất: lý do bắt buộc + người rút + thời điểm. */
  withdrawnReason: text('withdrawn_reason'),
  withdrawnBy: uuid('withdrawn_by'),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('system_questions_qtype_idx').on(table.qtype),
      index('system_questions_status_idx').on(table.status),
      check('system_questions_status_check', sql`${table.status} in ('published', 'withdrawn')`),
      check('system_questions_qtype_check', sql`${table.qtype} in ('multichoice', 'truefalse', 'shortanswer', 'essay')`),
  ]);

/**
 * Một phiên bản nội dung bất biến của câu hệ thống. `package` là tài liệu
 * gói phiên bản tự chứa (xem ghi chú đầu file): questionText,
 * generalFeedback, stimulusContent (nội dung ngữ liệu, null khi không có),
 * answers[] (answer, isCorrect, feedback, sortOrder), answerKey
 * (guidance, solution), options (tuỳ chọn theo dạng câu). `checksum` là
 * sha256 trên JSON canonical của gói — thao tác nhập tính lại và từ chối
 * khi lệch.
 */
export const systemQuestionVersions = pgTable('system_question_versions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionId: uuid('question_id').notNull().references(() => systemQuestions.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  /** sha256 hex của JSON canonical của gói phiên bản. */
  checksum: text('checksum').notNull(),
  /** Tài liệu gói phiên bản tự chứa (xem ghi chú đầu file). */
  package: jsonb('package').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('system_question_versions_question_id_idx').on(table.questionId),
      unique('system_question_versions_question_version_unique').on(table.questionId, table.version),
  ]);

/**
 * Gắn phiên bản câu hệ thống ↔ YCCĐ ở cấp phiên bản: mỗi dòng mang mức độ
 * nhận thức riêng (như `question_learning_outcomes` ở kho nghiệp vụ, nhưng
 * ở đây outcomeId là định danh YCCĐ NGUỒN — id được giữ nguyên qua bản cài
 * gói YCCĐ ở trung tâm nên trung tâm giải quyết được ngay, không cần mã).
 */
export const systemQuestionVersionOutcomes = pgTable('system_question_version_outcomes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  versionId: uuid('version_id').notNull().references(() => systemQuestionVersions.id, { onDelete: 'cascade' }),
  /** Định danh YCCĐ nguồn (id của learning_outcomes ở phía platform). */
  outcomeId: uuid('outcome_id').notNull(),
  /** biet | hieu | van_dung | van_dung_cao (như check ở kho nghiệp vụ). */
  cognitiveLevel: text('cognitive_level').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('system_question_version_outcomes_version_id_idx').on(table.versionId),
      index('system_question_version_outcomes_outcome_id_idx').on(table.outcomeId),
      unique('system_question_version_outcomes_version_outcome_unique').on(table.versionId, table.outcomeId),
      check('system_question_version_outcomes_cognitive_level_check', sql`${table.cognitiveLevel} in ('biet', 'hieu', 'van_dung', 'van_dung_cao')`),
  ]);

/**
 * Dòng ghi nhận một trung tâm đã nhập một câu hệ thống — căn cứ để khi rút
 * câu, phía ngân hàng phát thông báo tới đúng các trung tâm đã nhập.
 * Thao tác nhập ghi dòng này TRƯỚC khi ghi câu vào kho trung tâm (upsert
 * idempotent theo cặp): ghi sau lỗi chỉ gây thông báo thừa lành tính,
 * còn ghi trước lỗi mới mất thông báo.
 */
export const systemQuestionImporters = pgTable('system_question_importers', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  sourceQuestionId: uuid('source_question_id').notNull().references(() => systemQuestions.id, { onDelete: 'cascade' }),
  /** Slug của trung tâm đã nhập (định danh địa chỉ trong sổ đăng ký). */
  centreSlug: text('centre_slug').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  importedBy: uuid('imported_by'),
},
  (table) => [
      index('system_question_importers_source_question_id_idx').on(table.sourceQuestionId),
      unique('system_question_importers_source_centre_unique').on(table.sourceQuestionId, table.centreSlug),
  ]);

/**
 * Nhật ký sự kiện của kho ngân hàng, chỉ thêm (append-only): mỗi lần rút
 * câu là một dòng `question_withdrawn` kèm payload (lý do, thời điểm).
 * Trung tâm ghi nhận đã nhận bằng bảng receipts ở kho của mình; bảng này
 * không xoá dòng cũ để vết sự kiện còn đối chiếu được.
 */
export const systemBankEvents = pgTable('system_bank_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  /** question_withdrawn (mở rộng sau này thêm loại sự kiện khác cũng tại đây). */
  type: text('type').notNull(),
  /** Định danh câu nguồn của sự kiện (uuid thuần, không FK — nhật ký độc lập). */
  sourceQuestionId: uuid('source_question_id').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('system_bank_events_source_question_id_idx').on(table.sourceQuestionId),
      index('system_bank_events_created_at_idx').on(table.createdAt),
  ]);

/**
 * Một đợt phát hành gói YCCĐ phía platform: định danh phiên bản, phạm vi
 * áp dụng, checksum trên JSON canonical của toàn bộ items trong gói.
 * `scope`: `all` (toàn bộ cây) hoặc slug môn học (một môn). Trung tâm giữ
 * bản cài cục bộ và cập nhật khi chủ động nhận gói mới.
 */
export const systemOutcomePackages = pgTable('system_outcome_packages', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  /** Định danh phiên bản gói, duy nhất toàn kho (ví dụ `2026.10.31.1`). */
  version: text('version').notNull().unique(),
  /** all | slug môn học. */
  scope: text('scope').notNull(),
  /** sha256 hex của JSON canonical của toàn bộ items trong gói. */
  checksum: text('checksum').notNull(),
  outcomeCount: integer('outcome_count').notNull().default(0),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('system_outcome_packages_scope_idx').on(table.scope),
  ]);

/**
 * Một chương trình (curriculum) trong gói YCCĐ: id giữ nguyên id nguồn để
 * bản cài ở trung tâm upsert theo id (liên kết cũ theo id không đổi).
 * Môn học không nằm trong gói (môn mang context phân quyền, thuộc dữ
 * kiện nền của trung tâm): bản cài giải quyết môn qua `subjectSlug`
 * (slug môn duy nhất toàn hệ); môn chưa có ở trung tâm thì cài đặt bị
 * từ chối fail-closed.
 */
export const systemOutcomePackageCurricula = pgTable('system_outcome_package_curricula', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  packageId: uuid('package_id').notNull().references(() => systemOutcomePackages.id, { onDelete: 'cascade' }),
  /** Id chương trình nguồn, giữ nguyên qua bản cài. */
  curriculumId: uuid('curriculum_id').notNull(),
  /** Slug môn học của chương trình (khoá giải quyết môn ở trung tâm). */
  subjectSlug: text('subject_slug').notNull(),
  grade: smallint('grade').notNull(),
},
  (table) => [
      index('system_outcome_package_curricula_package_id_idx').on(table.packageId),
      unique('system_outcome_package_curricula_package_curriculum_unique').on(table.packageId, table.curriculumId),
  ]);

/**
 * Một node trong cây nội dung của gói YCCĐ: id và id cha giữ nguyên id
 * nguồn; bản cài chèn theo thứ tự cha trước (tính depth từ chuỗi cha
 * trong code cài đặt, vì bảng node gốc không có cột depth).
 */
export const systemOutcomePackageNodes = pgTable('system_outcome_package_nodes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  packageId: uuid('package_id').notNull().references(() => systemOutcomePackages.id, { onDelete: 'cascade' }),
  /** Id node nguồn, giữ nguyên qua bản cài. */
  nodeId: uuid('node_id').notNull(),
  /** Id chương trình nguồn chứa node. */
  curriculumId: uuid('curriculum_id').notNull(),
  /** Id node cha nguồn, null với node gốc. */
  parentId: uuid('parent_id'),
  title: text('title').notNull(),
  /** strand | topic | lesson (như check ở kho nghiệp vụ). */
  kind: text('kind').notNull().default('topic'),
  position: integer('position').notNull().default(1),
  durationPeriods: integer('duration_periods'),
  durationPercent: doublePrecision('duration_percent'),
},
  (table) => [
      index('system_outcome_package_nodes_package_id_idx').on(table.packageId),
      unique('system_outcome_package_nodes_package_node_unique').on(table.packageId, table.nodeId),
      check('system_outcome_package_nodes_kind_check', sql`${table.kind} in ('strand', 'topic', 'lesson')`),
  ]);

/**
 * Một YCCĐ trong gói: id giữ nguyên id nguồn; bản cài upsert theo id nên
 * các gắn chuẩn cũ (theo id) không bị sửa ngược khi cập nhật gói.
 */
export const systemOutcomePackageOutcomes = pgTable('system_outcome_package_outcomes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  packageId: uuid('package_id').notNull().references(() => systemOutcomePackages.id, { onDelete: 'cascade' }),
  /** Id YCCĐ nguồn, giữ nguyên qua bản cài. */
  outcomeId: uuid('outcome_id').notNull(),
  /** Id node nguồn chứa YCCĐ. */
  nodeId: uuid('node_id').notNull(),
  position: integer('position').notNull().default(1),
  /** Tài liệu Tiptap của YCCĐ, nguyên trạng. */
  content: jsonb('content').notNull(),
  /** program | derived (như check ở kho nghiệp vụ). */
  sourceKind: text('source_kind').notNull().default('program'),
  sourceRef: text('source_ref'),
},
  (table) => [
      index('system_outcome_package_outcomes_package_id_idx').on(table.packageId),
      unique('system_outcome_package_outcomes_package_outcome_unique').on(table.packageId, table.outcomeId),
      check('system_outcome_package_outcomes_source_kind_check', sql`${table.sourceKind} in ('program', 'derived')`),
  ]);

/**
 * Bảng ánh xạ mã cũ sang mã mới của một gói YCCĐ: khi phiên bản mới đổi
 * định danh một YCCĐ (tách/gộp/sửa vị trí), dòng này nói trung tâm rằng
 * YCCĐ cũ trỏ sang YCCĐ mới nào. Ánh xạ là thông tin tham chiếu — bản
 * cài không tự sửa các gắn chuẩn cũ theo ánh xạ (gắn chuẩn cũ giữ
 * nguyên theo id cũ).
 */
export const systemOutcomePackageMappings = pgTable('system_outcome_package_mappings', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  packageId: uuid('package_id').notNull().references(() => systemOutcomePackages.id, { onDelete: 'cascade' }),
  fromOutcomeId: uuid('from_outcome_id').notNull(),
  toOutcomeId: uuid('to_outcome_id').notNull(),
  note: text('note').notNull().default(''),
},
  (table) => [
      index('system_outcome_package_mappings_package_id_idx').on(table.packageId),
      unique('system_outcome_package_mappings_package_from_unique').on(table.packageId, table.fromOutcomeId),
  ]);

/** Kiểu dòng select của từng bảng trong kho ngân hàng (dùng ở tầng service). */
export type SystemQuestionRow = typeof systemQuestions.$inferSelect;
export type SystemQuestionVersionRow = typeof systemQuestionVersions.$inferSelect;
export type SystemQuestionVersionOutcomeRow = typeof systemQuestionVersionOutcomes.$inferSelect;
export type SystemQuestionImporterRow = typeof systemQuestionImporters.$inferSelect;
export type SystemBankEventRow = typeof systemBankEvents.$inferSelect;
export type SystemOutcomePackageRow = typeof systemOutcomePackages.$inferSelect;
export type SystemOutcomePackageCurriculumRow = typeof systemOutcomePackageCurricula.$inferSelect;
export type SystemOutcomePackageNodeRow = typeof systemOutcomePackageNodes.$inferSelect;
export type SystemOutcomePackageOutcomeRow = typeof systemOutcomePackageOutcomes.$inferSelect;
export type SystemOutcomePackageMappingRow = typeof systemOutcomePackageMappings.$inferSelect;
