/** Các bảng của bounded context Quiz — định nghĩa Drizzle do module quiz sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  check,
  doublePrecision,
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
import { course } from '../courses/schema';
import { curricula, curriculumNodes, subjects } from '../curriculum/schema';
import { courseGroups } from '../groups/schema';
import { question, questionAttempts, questionBanks, questionCategories, questionUsages, questionVersions } from '../questions/schema';
import { examVersions, exams } from '../exams/schema';
import { tenants } from '../tenants/schema';

/**
 * Ma trận đề (Chặng 3, mục C.1 của hồ sơ thiết kế): thực thể đặt tên,
 * lưu trữ, tái sử dụng — neo theo Chương trình GDPT 2018 (môn + chương
 * trình), KHÔNG neo SGK. preset_kind: 'cv7991_periodic' (kiểm tra định
 * kỳ theo CV 7991) — khuôn duy nhất, không còn lựa chọn preset |
 * 'custom'. target_*_percents là tỉ lệ % ĐIỂM mục tiêu CHỤP lúc tạo từ
 * preset (sửa preset về sau không đổi ma trận đã tạo); lệch tỉ lệ chỉ
 * CẢNH BÁO, không khoá cứng. level_set: 'three' (Biết/Hiểu/Vận dụng)
 * hoặc 'four' (thêm Vận dụng cao). scope_node_ids: phạm vi đã dạy
 * theo ĐƠN VỊ KIẾN THỨC — khi đặt, ma trận chỉ thêm ô cho ĐVK trong
 * phạm vi. context_id là context của môn (neo quyền như
 * curriculum). Đây là nền cho "ngân hàng ma trận" về sau.
 */
export const examMatrices = pgTable('exam_matrices', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  /** Tenant sở hữu (TENANT-0, #168) — suy từ bank chủ; NULL khi ma trận thuộc bank platform. */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
  curriculumId: uuid('curriculum_id').notNull().references(() => curricula.id, { onDelete: 'cascade' }),
  contextId: uuid('context_id').notNull(),
  /**
   * Các cột NGÂN HÀNG (lát MB-0 chặn nối đuối theo hồ sơ ngân hàng
   * đề/ma trận, mục G.1): bank_id trỏ question_banks (bảng bank đa
   * loại của PR #83, bank_kind='matrix' với ma trận); MB-1 (issue
   * #111) neo khoá ngoại thật vào question_banks.id (xoá bank thì
   * ma trận rơi về "chưa thuộc bank nào", không mất ma trận); status
   * là vòng đời trong bank (draft/ready/hidden như câu hỏi);
   * is_template phân biệt ma trận mẫu ↔ ma trận làm việc;
   * derived_from_matrix_id truy vết copy (mẫu → bản làm việc);
   * version là SỐ VERSION HIỆN HÀNH: mỗi số version có đúng một hàng
   * bất biến trong exam_matrix_versions chụp cấu hình của version đó,
   * và toàn bộ ô của version nằm ở exam_matrix_cells theo
   * matrix_version_id — sửa nội dung một ma trận đã rời draft là tạo
   * version mới, không ghi đè version cũ (khuôn versions bất biến như
   * câu hỏi/đề; bản đặc tả đã nộp khớp ma trận tại thời điểm nộp nhờ
   * neo vào đúng version). Quyền trên ma trận chốt MỘT nguồn
   * duy nhất là BANK (điểm E-8): context_id hiện tại chỉ là neo phạm vi
   * dữ liệu môn — xem resolver quyền trong QuizService.
   */
  bankId: uuid('bank_id').references(() => questionBanks.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('draft'),
  isTemplate: boolean('is_template').notNull().default(false),
  derivedFromMatrixId: uuid('derived_from_matrix_id'),
  version: integer('version').notNull().default(1),
  presetKind: text('preset_kind').notNull().default('cv7991_periodic'),
  targetFormPercents: jsonb('target_form_percents').$type<Record<string, number>>(),
  targetLevelPercents: jsonb('target_level_percents').$type<Record<string, number>>(),
  levelSet: text('level_set').notNull().default('three'),
  scopeNote: text('scope_note'),
  scopeNodeIds: jsonb('scope_node_ids').$type<string[]>(),
  totalScore: doublePrecision('total_score').notNull().default(10),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_matrices_tenant_id_idx').on(table.tenantId),
      index('exam_matrices_subject_idx').on(table.subjectId),
      index('exam_matrices_curriculum_idx').on(table.curriculumId),
      index('exam_matrices_bank_idx').on(table.bankId),
      check('exam_matrices_preset_kind_check', sql`${table.presetKind} in ('cv7991_periodic')`),
      check('exam_matrices_level_set_check', sql`${table.levelSet} in ('three', 'four')`),
      check('exam_matrices_status_check', sql`${table.status} in ('draft', 'ready', 'hidden')`),
  ]);

/**
 * Một VERSION bất biến của ma trận: chụp toàn bộ cấu hình thuộc về
 * nội dung của ma trận tại version đó (preset, tỉ lệ mục tiêu, bộ
 * mức, phạm vi đã dạy, tổng điểm) — các cột này trên exam_matrices
 * chỉ còn vai trò "bản hiện hành" phục vụ các đường đọc nhanh, còn
 * lịch sử đọc từ bảng này. Toàn bộ ô của version nằm ở
 * exam_matrix_cells.matrix_version_id. Bất biến: hàng đã tạo không
 * bao giờ sửa; sửa nội dung ma trận đã rời draft = tạo hàng mới với
 * version = số hiện hành + 1 và sao toàn bộ ô sang version mới rồi
 * mới áp thay đổi lên bản sao (tầng service giữ luật này). Ma trận
 * còn draft thì sửa tại chỗ trên version đang mở. Không có tenant_id
 * riêng — bám khuôn exam_versions/question_versions: tenant suy qua
 * exam_matrices cha.
 */
export const examMatrixVersions = pgTable('exam_matrix_versions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  matrixId: uuid('matrix_id').notNull().references(() => examMatrices.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  presetKind: text('preset_kind').notNull().default('cv7991_periodic'),
  targetFormPercents: jsonb('target_form_percents').$type<Record<string, number>>(),
  targetLevelPercents: jsonb('target_level_percents').$type<Record<string, number>>(),
  levelSet: text('level_set').notNull().default('three'),
  scopeNote: text('scope_note'),
  scopeNodeIds: jsonb('scope_node_ids').$type<string[]>(),
  totalScore: doublePrecision('total_score').notNull().default(10),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_matrix_versions_matrix_idx').on(table.matrixId),
      unique('exam_matrix_versions_matrix_version_unique').on(table.matrixId, table.version),
      check('exam_matrix_versions_preset_kind_check', sql`${table.presetKind} in ('cv7991_periodic')`),
      check('exam_matrix_versions_level_set_check', sql`${table.levelSet} in ('three', 'four')`),
  ]);

/**
 * Một ô của ma trận = ĐƠN VỊ KIẾN THỨC × mức nhận thức × dạng câu
 * (mục C.1; đính chính theo Phụ lục 1 CV 7991, issue #249): ma trận
 * chỉ là lưới số Chủ đề × ĐVK × dạng × mức, KHÔNG có cột YCCĐ — YCCĐ
 * chỉ thuộc BẢN ĐẶC TẢ (Phụ lục 2), là bảng suy ra dùng chung lưới số
 * của ma trận và thêm cột YCCĐ = các YCCĐ thuộc ĐVK của ô. Riêng
 * truefalse, question_count là số CHÙM (mỗi chùm 4 câu quanh một
 * stimulus, xem C.4). cell_score là tổng điểm của ô; điểm mỗi câu =
 * cell_score / question_count (riêng chùm: điểm chùm = cell_score /
 * số chùm, mỗi câu con mang điểm danh nghĩa = điểm chùm / 4). tf_scale
 * là thang Đ–S riêng của ô; null = thang của quiz/mặc định. Sinh đề
 * theo ô rút câu gắn BẤT KỲ YCCĐ nào thuộc ĐVK của ô ở đúng mức của
 * ô (mức nằm trên dòng nối câu × YCCĐ).
 */
export const examMatrixCells = pgTable('exam_matrix_cells', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  matrixId: uuid('matrix_id').notNull().references(() => examMatrices.id, { onDelete: 'cascade' }),
  /**
   * Version bất biến mà ô thuộc về (exam_matrix_versions): ô của các
   * version khác nhau của cùng một ma trận là các hàng khác nhau;
   * matrix_id giữ vai trò phi chuẩn hoá phục vụ truy vấn theo ma
   * trận. Khoá tự nhiên của ô chỉ duy nhất TRONG một version.
   */
  matrixVersionId: uuid('matrix_version_id').notNull().references(() => examMatrixVersions.id, { onDelete: 'cascade' }),
  curriculumNodeId: uuid('curriculum_node_id').notNull().references(() => curriculumNodes.id, { onDelete: 'restrict' }),
  cognitiveLevel: text('cognitive_level').notNull(),
  qtype: text('qtype').notNull(),
  questionCount: integer('question_count').notNull(),
  cellScore: doublePrecision('cell_score').notNull(),
  minutes: integer('minutes'),
  tfScale: jsonb('tf_scale').$type<number[]>(),
  position: integer('position').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_matrix_cells_matrix_idx').on(table.matrixId),
      index('exam_matrix_cells_matrix_version_idx').on(table.matrixVersionId),
      index('exam_matrix_cells_curriculum_node_idx').on(table.curriculumNodeId),
      unique('exam_matrix_cells_unique').on(table.matrixVersionId, table.curriculumNodeId, table.cognitiveLevel, table.qtype),
      check('exam_matrix_cells_level_check', sql`${table.cognitiveLevel} in ('biet', 'hieu', 'van_dung', 'van_dung_cao')`),
      check('exam_matrix_cells_qtype_check', sql`${table.qtype} in ('multichoice', 'truefalse', 'shortanswer', 'essay')`),
      check('exam_matrix_cells_count_check', sql`${table.questionCount} > 0`),
      check('exam_matrix_cells_score_check', sql`${table.cellScore} > 0`),
  ]);

/**
 * Hàng chờ ĐÓNG GÓP ma trận lên bank chung (MB-1, issue #111 — cơ chế
 * QB-4 của ngân hàng câu hỏi áp cho ma trận, mục A.2/G.1 của hồ sơ):
 * giáo viên đề xuất đưa ma trận ready của mình vào một bank ma trận
 * dùng chung (tổ/trường); người có matrix:moderate tại bank đích duyệt
 * — duyệt = copy sâu ma trận vào bank đích (result_matrix_id trỏ bản đã
 * vào bank, derived_from của bản đó trỏ về ma trận nguồn, proposer_id
 * là truy vết người đóng góp), từ chối bắt buộc có lý do hiện lại cho
 * người gửi. Ma trận KHÔNG có vòng version như câu hỏi nên hàng chờ chỉ
 * có một chế độ (tương đương mode 'new' của question_bank_contributions).
 */
export const examMatrixContributions = pgTable('exam_matrix_contributions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  matrixId: uuid('matrix_id').notNull().references(() => examMatrices.id, { onDelete: 'cascade' }),
  targetBankId: uuid('target_bank_id').notNull().references(() => questionBanks.id, { onDelete: 'cascade' }),
  proposerId: uuid('proposer_id').notNull(),
  note: text('note').notNull().default(''),
  status: text('status').notNull().default('pending'),
  rejectReason: text('reject_reason'),
  reviewerId: uuid('reviewer_id'),
  resultMatrixId: uuid('result_matrix_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_matrix_contributions_target_bank_idx').on(table.targetBankId),
      index('exam_matrix_contributions_matrix_idx').on(table.matrixId),
      index('exam_matrix_contributions_proposer_idx').on(table.proposerId),
      index('exam_matrix_contributions_status_idx').on(table.status),
      check('exam_matrix_contributions_status_check', sql`${table.status} in ('pending', 'approved', 'rejected')`),
  ]);

/** Một biến thể mã đề của một lần ghim: mã in trên đề + seed hoán vị thứ tự câu/đáp án khi in (kế thừa từ exam_deployments). */
export interface ExamVariant {
  code: string;
  seed: number;
}


/**
 * Một LẦN GHIM một exam version vào một khoá (feat #226 — hợp nhất
 * quizzes + exam_deployments): đây chính là "Bài kiểm tra" hiển thị
 * trong khoá. GHIM đúng một exam version (exam_version_id bất biến
 * sau khi đã có attempt thật — luật đóng băng exam.pin_locked ở tầng
 * service); toàn bộ cấu hình của lần tổ chức sống ở đây (giờ mở/đóng,
 * giới hạn, số lượt, mật khẩu, subnet, bộ review, preset luật thi,
 * mã đề) — thang điểm đọc từ total_score của exam version đã ghim,
 * KHÔNG giữ bản sao ở pin. cm_id là instance của course module
 * (component 'mod_quiz' giữ nguyên theo ngoại lệ tên kỹ thuật).
 * attempts_allowed = 0 nghĩa là không giới hạn. time_limit tính
 * bằng giây. grade_method: highest | average | first | last.
 * password_hash đã băm argon2. results_published_at: mốc công bố
 * điểm của bài (nghiệp vụ công bố cấp bài của #224 sống ở đây).
 */
export const examPins = pgTable('exam_pins', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  examId: uuid('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
  examVersionId: uuid('exam_version_id').notNull().references(() => examVersions.id, { onDelete: 'cascade' }),
  courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
  cmId: uuid('cm_id'),
  /**
   * Nhóm đích của lần ghim (chốt bổ sung 26/10): null = ghim toàn
   * khoá; có giá trị = chỉ học sinh thuộc nhóm đó mới thấy và làm
   * được bài. Nhóm dùng thực thể course_groups sẵn có của khoá —
   * validate nhóm thuộc đúng khoá này ở service.
   */
  targetGroupId: uuid('target_group_id').references(() => courseGroups.id, { onDelete: 'set null' }),
  /** Tên hiển thị ghi đè trong khoá; null = dùng tên của exam version đã ghim. */
  name: text('name'),
  intro: text('intro').notNull().default(''),
  timeOpen: timestamp('time_open', { withTimezone: true }),
  timeClose: timestamp('time_close', { withTimezone: true }),
  timeLimit: integer('time_limit'),
  attemptsAllowed: integer('attempts_allowed').notNull().default(0),
  gradeMethod: text('grade_method').notNull().default('highest'),
  shuffleAnswers: boolean('shuffle_answers').notNull().default(false),
  passwordHash: text('password_hash'),
  subnet: text('subnet'),
  reviewAttempt: integer('review_attempt').notNull().default(69904),
  reviewCorrectness: integer('review_correctness').notNull().default(4368),
  reviewMarks: integer('review_marks').notNull().default(4368),
  reviewSpecificFeedback: integer('review_specific_feedback').notNull().default(4368),
  reviewGeneralFeedback: integer('review_general_feedback').notNull().default(4368),
  reviewRightAnswer: integer('review_right_answer').notNull().default(272),
  reviewOverallFeedback: integer('review_overall_feedback').notNull().default(4368),
  /**
   * PRESET luật thi đã áp lúc tạo ('regular' thường xuyên | 'periodic'
   * định kỳ | 'mock' thi thử tốt nghiệp) — chỉ ghi lại để truy vết;
   * giá trị hiệu lực nằm ở từng trường cấu hình cụ thể. Khác hẳn
   * exam_kind của exam_versions (loại kiểm tra của NỘI DUNG đề).
   */
  preset: text('preset'),
  /**
   * Chế độ tham chiếu version của câu hỏi cho các lượt làm MỚI của lần
   * ghim (issue #254 — mô hình lai ghim/trôi): 'pinned' (mặc định) =
   * mọi lượt dùng đúng version câu đã chụp trong exam version đã ghim,
   * hai học sinh cùng cửa sổ luôn thấy cùng một version; 
   * 'float_latest_ready' = lúc bắt đầu lượt, mỗi slot phân giải bản
   * ready MỚI NHẤT của câu tại thời điểm đó (attempt vẫn ghim version
   * đã phân giải, không trôi giữa chừng). Float CHỈ được phép cho lần
   * ghim luyện tập — cụ thể hoá theo preset: preset 'regular' (thường
   * xuyên/luyện tập) mới được float; preset kiểm tra chính thức
   * ('periodic', 'mock') hoặc không preset thì API chặn ở tầng service
   * bằng lỗi `exam.version_mode_not_allowed`. Cột này KHÔNG đổi cách
   * các attempt đã bắt đầu được chấm — attempt luôn neo version đã
   * ghim trong question_attempts.
   */
  versionMode: text('version_mode').notNull().default('pinned'),
  /** Số phút tối đa được vào thi muộn từ time_open hiệu lực (preset thi thử = 15 theo TT 24/2024); null = không áp. */
  lateEntryMinutes: integer('late_entry_minutes'),
  /** Bật ghi nhận sự kiện giám sát lúc làm bài — CHỈ ghi nhận + báo cáo, không tự kết luận gian lận. */
  monitorEvents: boolean('monitor_events').notNull().default(false),
  variantCount: integer('variant_count').notNull().default(1),
  variants: jsonb('variants').$type<ExamVariant[]>().notNull(),
  resultsPublishedAt: timestamp('results_published_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_pins_course_idx').on(table.courseId),
      index('exam_pins_cm_id_idx').on(table.cmId),
      index('exam_pins_exam_idx').on(table.examId),
      index('exam_pins_exam_version_idx').on(table.examVersionId),
      index('exam_pins_target_group_idx').on(table.targetGroupId),
      check('exam_pins_preset_check', sql`${table.preset} is null or ${table.preset} in ('regular', 'periodic', 'mock')`),
      check('exam_pins_version_mode_check', sql`${table.versionMode} in ('pinned', 'float_latest_ready')`),
  ]);

/**
 * Ghi đè cài đặt thi cho một nhóm hoặc một người dùng (Moodle
 * `quiz_overrides`, Chặng 2 mục B.2): đúng một trong group_id/user_id
 * khác null; mỗi trường null = kế thừa tầng dưới (nhóm → quiz). Mỗi đích
 * tối đa một override cho một quiz (partial unique index). user_id theo
 * quy ước repo không FK cứng (nhất quán quiz_attempts.user_id).
 */
export const examPinOverrides = pgTable('exam_pin_overrides', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  pinId: uuid('pin_id').notNull().references(() => examPins.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').references(() => courseGroups.id, { onDelete: 'cascade' }),
  userId: uuid('user_id'),
  timeOpen: timestamp('time_open', { withTimezone: true }),
  timeClose: timestamp('time_close', { withTimezone: true }),
  timeLimit: integer('time_limit'),
  attempts: integer('attempts'),
  passwordHash: text('password_hash'),
  /**
   * Lý do của override (truy vết quyết định): bắt buộc về mặt nghiệp
   * vụ khi override là cộng thời gian theo KHGD cá nhân cho HS hoà
   * nhập hoặc mở cửa sổ kiểm tra bù — kiểm ở tầng service.
   */
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_pin_overrides_pin_idx').on(table.pinId),
      index('exam_pin_overrides_group_idx').on(table.groupId),
      check('exam_pin_overrides_exactly_one_target', sql`(${table.groupId} is null) <> (${table.userId} is null)`),
      unique('exam_pin_overrides_pin_group_unique').on(table.pinId, table.groupId),
      unique('exam_pin_overrides_pin_user_unique').on(table.pinId, table.userId),
  ]);


/**
 * Một lượt làm bài của một học sinh (Moodle `quiz_attempts`): gắn đúng một
 * question usage của engine (component 'mod_quiz', instance là quiz); các
 * question attempt trong usage mang slot trùng số slot của quiz_slots và
 * max_mark lấy từ max_mark của slot. state: inprogress | needsgrading
 * (đã nộp, còn câu chờ chấm tay) | finished (đã chốt, điểm bài đã/đang ghi
 * sổ theo grade_method). sum_grades là tổng điểm các slot ĐÃ CHẤM (thang
 * điểm slot, trước khi quy về thang grade của quiz); null khi đang làm.
 * preview = lượt xem trước của giáo viên: không đếm vào attempts_allowed,
 * không ghi điểm, không tính completion.
 */
export const examAttempts = pgTable(
  'exam_attempts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    pinId: uuid('pin_id').notNull().references(() => examPins.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    usageId: uuid('usage_id').notNull().references(() => questionUsages.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('inprogress'),
    preview: boolean('preview').notNull().default(false),
    /**
     * Nhãn kiểm tra bù (TT 22 Điều 7 k.4–5): lượt bắt đầu trong cửa sổ
     * CHỈ tồn tại nhờ user override mở riêng (cửa sổ khác cửa sổ gốc
     * của quiz) thì makeup = true. Cộng giờ HS hoà nhập đi qua chính
     * user override time_limit — không có hệ số hệ thống.
     */
    makeup: boolean('makeup').notNull().default(false),
    /**
     * Snapshot quy tắc hiệu lực ĐÃ ÁP cho lượt này lúc bắt đầu (giá trị
     * + id override nguồn + thứ tự câu đã rút) — attempt ghim quy tắc
     * đã áp như ghim version câu; thay đổi override về sau không viết
     * lại lịch sử của lượt đã thi.
     */
    appliedSettings: jsonb('applied_settings').$type<Record<string, unknown>>(),
    timeStart: timestamp('time_start', { withTimezone: true }).notNull().defaultNow(),
    timeFinish: timestamp('time_finish', { withTimezone: true }),
    sumGrades: doublePrecision('sum_grades'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('exam_attempts_pin_id_idx').on(table.pinId),
      index('exam_attempts_user_id_idx').on(table.userId),unique('exam_attempts_usage_unique').on(table.usageId),unique('exam_attempts_pin_user_number_unique').on(table.pinId, table.userId, table.attemptNumber)],
);

/**
 * Dải nhận xét tổng quát theo khoảng điểm (Moodle `quiz_feedback`) —
 * tầng feedback thứ tư (sau feedback theo đáp án đã chọn / theo câu /
 * tổng quát của câu): khi một lượt chốt, % điểm của lượt rơi vào dải
 * [min_percent, max_percent) nào thì học sinh nhận nhận xét của dải đó,
 * qua cổng review_overall_feedback như các khía cạnh khác.
 */
export const examPinFeedbacks = pgTable('exam_pin_feedbacks', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  pinId: uuid('pin_id').notNull().references(() => examPins.id, { onDelete: 'cascade' }),
  minPercent: doublePrecision('min_percent').notNull(),
  maxPercent: doublePrecision('max_percent').notNull(),
  feedback: text('feedback').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_pin_feedbacks_pin_idx').on(table.pinId),
      check('exam_pin_feedbacks_range_check', sql`${table.minPercent} >= 0 and ${table.maxPercent} <= 100 and ${table.minPercent} < ${table.maxPercent}`),
  ]);

/**
 * Nhật ký sự kiện trong lúc làm bài (giám sát thi): client báo các sự
 * kiện quan sát được (thoát fullscreen, mất focus/đổi tab trên desktop,
 * ngắt kết nối dài) và server tự ghi sự kiện nộp tự động khi hết giờ.
 * CHỈ GHI NHẬN để giáo viên xem lại sau thi — hệ thống không tự kết
 * luận gian lận, không tự huỳ/trừ điểm (theo tài liệu chính chủ Azota).
 */
export const examAttemptEvents = pgTable('exam_attempt_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  attemptId: uuid('attempt_id').notNull().references(() => examAttempts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_attempt_events_attempt_idx').on(table.attemptId),
  ]);

/**
 * Vết một lần CẬP NHẬT TƯỜNG MINH exam version đã ghim của một pin
 * (issue #254): giáo viên xem diff từng slot giữa version đang ghim và
 * version đích rồi mới áp; mỗi lần áp ghi đúng một dòng ở đây — ai
 * (actor_id), khi nào (created_at), từ exam version nào lên exam
 * version nào. Thao tác áp chỉ đi được khi pin CHƯA có lượt làm thật
 * (luật khoá exam.pin_locked ở tầng service); pin đã có attempt thì
 * đường duy nhất để sửa hệ quả điểm là chấm lại theo đáp án (bảng
 * exam_attempt_regrades), không phải bảng này. Bảng con của exam_pins
 * theo đúng khuôn exam_attempt_events: không mang tenant_id riêng,
 * mọi truy cập đều đi qua pin/khoá của nó.
 */
export const examPinVersionUpdates = pgTable('exam_pin_version_updates', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  pinId: uuid('pin_id').notNull().references(() => examPins.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').notNull(),
  fromExamVersionId: uuid('from_exam_version_id').notNull().references(() => examVersions.id, { onDelete: 'cascade' }),
  toExamVersionId: uuid('to_exam_version_id').notNull().references(() => examVersions.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_pin_version_updates_pin_idx').on(table.pinId),
      index('exam_pin_version_updates_from_version_idx').on(table.fromExamVersionId),
      index('exam_pin_version_updates_to_version_idx').on(table.toExamVersionId),
  ]);

/**
 * Một lần CHẤM LẠI THEO ĐÁP ÁN của một pin (issue #254): giáo viên đã
 * sửa đáp án bằng cách tạo version mới của câu hỏi, rồi chấm lại các
 * lượt đã nộp đang ghim version cũ theo dữ kiện chấm của version đích.
 * Đây là cơ chế RIÊNG, tách khỏi chấm tay essay (sự kiện
 * `exam_attempt_regraded` của chấm tay không dùng lại — chấm lại theo
 * đáp án phát sự kiện `exam_attempt_answer_key_regraded`). Một dòng =
 * một thao tác áp thật cho một câu (dry-run KHÔNG ghi bảng này); điểm
 * đổi của từng lượt nằm ở exam_attempt_regrade_items. from_version_id
 * là version mà các lượt ứng viên đang ghim lúc chấm lại. Một thao
 * tác áp gồm nhiều version nguồn khác nhau (chỉ xảy ra ở pin trôi —
 * các lượt bắt đầu ở các thời điểm khác nhau đã phân giải các bản
 * ready khác nhau) thì ghi MỘT DÒNG cho mỗi version nguồn, cùng
 * actor/thời điểm áp; version đích là bản ready giáo viên chỉ định.
 */
export const examAttemptRegrades = pgTable('exam_attempt_regrades', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  pinId: uuid('pin_id').notNull().references(() => examPins.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id').notNull().references(() => question.id, { onDelete: 'cascade' }),
  fromVersionId: uuid('from_version_id').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  toVersionId: uuid('to_version_id').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_attempt_regrades_pin_idx').on(table.pinId),
      index('exam_attempt_regrades_question_idx').on(table.questionId),
      index('exam_attempt_regrades_from_version_idx').on(table.fromVersionId),
      index('exam_attempt_regrades_to_version_idx').on(table.toVersionId),
  ]);

/**
 * Điểm đổi của TỪNG lượt trong một lần chấm lại theo đáp án: fraction
 * của câu được chấm lại và tổng điểm của lượt (sum_grades, thang điểm
 * slot) trước/sau. user_id ghi kèm (phi chuẩn hoá từ exam_attempts) để
 * bề mặt "lịch sử sửa điểm của tôi" của học sinh truy vấn thẳng theo
 * người mà không phải giải usage của engine; học sinh chỉ đọc được các
 * dòng của chính mình và chỉ sau khi pin đã công bố kết quả (cổng công
 * bố ở tầng service). Chỉ các lượt có điểm THẬT SỰ đổi mới có dòng ở
 * đây — lượt chấm lại ra cùng fraction thì không ghi.
 */
export const examAttemptRegradeItems = pgTable('exam_attempt_regrade_items', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  regradeId: uuid('regrade_id').notNull().references(() => examAttemptRegrades.id, { onDelete: 'cascade' }),
  examAttemptId: uuid('exam_attempt_id').notNull().references(() => examAttempts.id, { onDelete: 'cascade' }),
  questionAttemptId: uuid('question_attempt_id').notNull().references(() => questionAttempts.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  oldFraction: doublePrecision('old_fraction'),
  newFraction: doublePrecision('new_fraction'),
  oldSumGrades: doublePrecision('old_sum_grades'),
  newSumGrades: doublePrecision('new_sum_grades'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_attempt_regrade_items_regrade_idx').on(table.regradeId),
      index('exam_attempt_regrade_items_user_idx').on(table.userId),
      index('exam_attempt_regrade_items_attempt_idx').on(table.examAttemptId),
      index('exam_attempt_regrade_items_question_attempt_idx').on(table.questionAttemptId),
  ]);
