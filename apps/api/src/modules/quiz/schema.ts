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
import { curricula, learningOutcomes, subjects } from '../curriculum/schema';
import { courseGroups } from '../groups/schema';
import { question, questionCategories, questionUsages } from '../questions/schema';

/**
 * Ma trận đề (Chặng 3, mục C.1 của hồ sơ thiết kế): thực thể đặt tên,
 * lưu trữ, tái sử dụng — neo theo Chương trình GDPT 2018 (môn + chương
 * trình), KHÔNG neo SGK. preset_kind: 'cv7991_periodic' (kiểm tra định
 * kỳ theo CV 7991) | 'qd764_graduation' (tốt nghiệp theo QĐ 764) |
 * 'custom'. target_*_percents là tỉ lệ % ĐIỂM mục tiêu CHỤP lúc tạo từ
 * preset (sửa preset về sau không đổi ma trận đã tạo); lệch tỉ lệ chỉ
 * CẢNH BÁO, không khoá cứng. level_set: 'three' (Biết/Hiểu/Vận dụng)
 * hoặc 'four' (thêm Vận dụng cao). scope_outcome_ids: phạm vi đã dạy
 * cắt từ tầng ánh xạ SGK — khi đặt, ma trận chỉ thêm ô cho outcome
 * trong phạm vi. context_id là context của môn (neo quyền như
 * curriculum). Đây là nền cho "ngân hàng ma trận" về sau.
 */
export const examMatrices = pgTable('exam_matrices', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
  curriculumId: uuid('curriculum_id').notNull().references(() => curricula.id, { onDelete: 'cascade' }),
  contextId: uuid('context_id').notNull(),
  /**
   * Các cột NGÂN HÀNG (lát MB-0 chặn nối đuối theo hồ sơ ngân hàng
   * đề/ma trận, mục G.1): bank_id trỏ question_banks của PR #83 (bảng
   * đó chưa có ở nhánh này nên để uuid mềm, MB-1 sẽ neo FK/khuôn bank);
   * status là vòng đời trong bank (draft/ready/hidden như câu hỏi);
   * is_template phân biệt ma trận mẫu ↔ ma trận làm việc;
   * derived_from_matrix_id truy vết copy (mẫu → bản làm việc);
   * version tăng khi sửa một ma trận đã ready (bản đặc tả đã nộp phải
   * khớp ma trận tại thời điểm nộp). Quyền trên ma trận chốt MỘT nguồn
   * duy nhất là BANK (điểm E-8): context_id hiện tại chỉ là neo phạm vi
   * dữ liệu môn — xem resolver quyền trong QuizService.
   */
  bankId: uuid('bank_id'),
  status: text('status').notNull().default('draft'),
  isTemplate: boolean('is_template').notNull().default(false),
  derivedFromMatrixId: uuid('derived_from_matrix_id'),
  version: integer('version').notNull().default(1),
  presetKind: text('preset_kind').notNull().default('custom'),
  targetFormPercents: jsonb('target_form_percents').$type<Record<string, number>>(),
  targetLevelPercents: jsonb('target_level_percents').$type<Record<string, number>>(),
  levelSet: text('level_set').notNull().default('three'),
  scopeNote: text('scope_note'),
  scopeOutcomeIds: jsonb('scope_outcome_ids').$type<string[]>(),
  totalScore: doublePrecision('total_score').notNull().default(10),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('exam_matrices_subject_idx').on(table.subjectId),
      index('exam_matrices_curriculum_idx').on(table.curriculumId),
      index('exam_matrices_bank_idx').on(table.bankId),
      check('exam_matrices_preset_kind_check', sql`${table.presetKind} in ('cv7991_periodic', 'qd764_graduation', 'custom')`),
      check('exam_matrices_level_set_check', sql`${table.levelSet} in ('three', 'four')`),
      check('exam_matrices_status_check', sql`${table.status} in ('draft', 'ready', 'hidden')`),
  ]);

/**
 * Một ô của ma trận = YCCĐ × mức nhận thức × dạng câu (mục C.1). Riêng
 * truefalse, question_count là số CHÙM (mỗi chùm 4 câu quanh một
 * stimulus, xem C.4). cell_score là tổng điểm của ô; điểm mỗi câu =
 * cell_score / question_count (riêng chùm: điểm chùm = cell_score /
 * số chùm, mỗi câu con mang điểm danh nghĩa = điểm chùm / 4). tf_scale
 * là thang Đ–S riêng của ô; null = thang của quiz/mặc định.
 */
export const examMatrixCells = pgTable('exam_matrix_cells', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  matrixId: uuid('matrix_id').notNull().references(() => examMatrices.id, { onDelete: 'cascade' }),
  learningOutcomeId: uuid('learning_outcome_id').notNull().references(() => learningOutcomes.id, { onDelete: 'cascade' }),
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
      unique('exam_matrix_cells_unique').on(table.matrixId, table.learningOutcomeId, table.cognitiveLevel, table.qtype),
      check('exam_matrix_cells_level_check', sql`${table.cognitiveLevel} in ('biet', 'hieu', 'van_dung', 'van_dung_cao')`),
      check('exam_matrix_cells_qtype_check', sql`${table.qtype} in ('multichoice', 'truefalse', 'shortanswer', 'essay')`),
      check('exam_matrix_cells_count_check', sql`${table.questionCount} > 0`),
      check('exam_matrix_cells_score_check', sql`${table.cellScore} > 0`),
  ]);

/**
 * Hoạt động Quiz trong khoá học (Moodle `quiz`): instance của một course
 * module (course_modules trỏ instance_id về đây, component 'mod_quiz';
 * cột cm_id là bản sao tiện tra cứu — nguồn sự thật của quan hệ cm vẫn là
 * course_modules.instance_id). grade là thang điểm của BÀI (điểm các slot
 * cộng lại rồi quy về thang này khi ghi sổ điểm). attempts_allowed = 0
 * nghĩa là không giới hạn (như Moodle). time_limit tính bằng giây.
 * grade_method: highest | average | first | last (Moodle grademethod).
 *
 * Chặng 2 (quy tắc thi, issue #30): password_hash là mật khẩu vào thi
 * ĐÃ BĂM argon2 (Moodle lưu plaintext — sai lệch có chủ đích vì bảo mật,
 * xem hồ sơ thiết kế mục B.1); subnet là danh sách IP/CIDR cách nhau dấu
 * phẩy (định dạng Moodle quiz.subnet); delay1/delay2 là độ trễ bắt buộc
 * (giây) sau lượt chốt thứ 1 / từ lượt thứ 3 (Moodle quiz.delay1/delay2).
 * Bảy cột review_* là bitmask tuỳ chọn xem lại của Moodle trên bốn cửa
 * sổ: DURING=0x10000, IMMEDIATELY_AFTER=0x01000, LATER_WHILE_OPEN=0x00100,
 * AFTER_CLOSE=0x00010 (hằng số mod_quiz display options); giá trị mặc
 * định của cột là mặc định của form cài đặt Moodle cho quiz mới.
 */
export const quizzes = pgTable('quizzes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  cmId: uuid('cm_id'),
  name: text('name').notNull(),
  intro: text('intro').notNull().default(''),
  timeOpen: timestamp('time_open', { withTimezone: true }),
  timeClose: timestamp('time_close', { withTimezone: true }),
  timeLimit: integer('time_limit'),
  attemptsAllowed: integer('attempts_allowed').notNull().default(0),
  gradeMethod: text('grade_method').notNull().default('highest'),
  grade: doublePrecision('grade').notNull().default(10),
  shuffleAnswers: boolean('shuffle_answers').notNull().default(false),
  passwordHash: text('password_hash'),
  subnet: text('subnet'),
  delay1: integer('delay1'),
  delay2: integer('delay2'),
  reviewAttempt: integer('review_attempt').notNull().default(69904),
  reviewCorrectness: integer('review_correctness').notNull().default(4368),
  reviewMarks: integer('review_marks').notNull().default(4368),
  reviewSpecificFeedback: integer('review_specific_feedback').notNull().default(4368),
  reviewGeneralFeedback: integer('review_general_feedback').notNull().default(4368),
  reviewRightAnswer: integer('review_right_answer').notNull().default(272),
  reviewOverallFeedback: integer('review_overall_feedback').notNull().default(4368),
  /** Ma trận nguồn khi đề được sinh từ ma trận (Chặng 3); null với đề dựng tay. */
  matrixId: uuid('matrix_id').references(() => examMatrices.id, { onDelete: 'set null' }),
  /** Thang chấm Đ–S chùm (mảng 5 tỉ lệ % cho 0..4 ý đúng); null = mặc định QĐ 764 [0,10,25,50,100]. */
  tfScale: jsonb('tf_scale').$type<number[]>(),
  /**
   * Hình thức kiểm tra theo TT 22 (preset quy tắc thi — hồ sơ tổ chức
   * thi trực tuyến VN mục 5.1): 'regular' thường xuyên | 'periodic'
   * định kỳ | 'mock' thi thử tốt nghiệp. Chọn preset lúc tạo là điền
   * sẵn quy tắc (số lượt, bitmask review, giám sát, trễ vào thi), giáo
   * viên vẫn sửa từng trường sau đó. exam_kind cũng là nguồn nhãn loại
   * điểm TT 22 (hệ số) cho grade item khi triển khai đề (điểm nối EB).
   */
  examKind: text('exam_kind'),
  /**
   * Số phút tối đa được vào thi muộn tính từ time_open hiệu lực
   * (preset thi thử = 15 theo Điều 21 TT 24/2024: đến chậm quá 15 phút
   * không được dự thi); null = không áp giới hạn vào muộn.
   */
  lateEntryMinutes: integer('late_entry_minutes'),
  /**
   * Bật ghi nhận sự kiện giám sát trong lúc làm bài (thoát fullscreen,
   * mất focus...) — CHỈ ghi nhận + báo cáo, không tự kết luận gian lận
   * (theo tài liệu chính chủ Azota). Preset định kỳ/thi thử bật sẵn.
   */
  monitorEvents: boolean('monitor_events').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('quizzes_course_idx').on(table.course),
      index('quizzes_cm_id_idx').on(table.cmId),
      check('quizzes_exam_kind_check', sql`${table.examKind} is null or ${table.examKind} in ('regular', 'periodic', 'mock')`),
  ]);

/**
 * Ghi đè cài đặt thi cho một nhóm hoặc một người dùng (Moodle
 * `quiz_overrides`, Chặng 2 mục B.2): đúng một trong group_id/user_id
 * khác null; mỗi trường null = kế thừa tầng dưới (nhóm → quiz). Mỗi đích
 * tối đa một override cho một quiz (partial unique index). user_id theo
 * quy ước repo không FK cứng (nhất quán quiz_attempts.user_id).
 */
export const quizOverrides = pgTable('quiz_overrides', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
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
      index('quiz_overrides_quiz_idx').on(table.quizId),
      check('quiz_overrides_exactly_one_target', sql`(${table.groupId} is null) <> (${table.userId} is null)`),
      unique('quiz_overrides_quiz_group_unique').on(table.quizId, table.groupId),
      unique('quiz_overrides_quiz_user_unique').on(table.quizId, table.userId),
  ]);


/**
 * Một vị trí trong đề (Moodle `quiz_slots`). Hai dạng slot:
 *  - câu cố định: question_id trỏ câu trong ngân hàng (version được pin
 *    lúc lượt làm bắt đầu qua question engine như mọi usage khác);
 *  - slot ngẫu nhiên: category_id trỏ question category, câu cụ thể được
 *    rút ngẫu nhiên khi mỗi lượt làm bắt đầu và ghi vào attempt của engine.
 * max_mark là ĐIỂM CỦA SLOT TRONG ĐỀ NÀY: khởi tạo từ default_mark của
 * phiên bản câu lúc thêm slot nhưng sống độc lập sau đó — cùng một câu ở
 * hai đề khác nhau có thể mang hai max_mark khác nhau. page là trang hiển
 * thị của slot khi làm bài (Moodle quiz_slots.page).
 */
/**
 * Một vị trí câu trong đề. Đúng MỘT trong ba nguồn (ràng buộc check):
 * question_id (câu cố định), category_id (rút ngẫu nhiên theo category)
 * hoặc matrix_cell_id (nguồn ô ma trận — Chặng 3: đề cố định thì
 * question_id được điền kèm lúc generate; đề per_student chỉ giữ
 * matrix_cell_id và câu được rút lúc bắt đầu từng lượt). cluster_id
 * gom 4 slot truefalse của cùng một chùm Đ–S (cùng stimulus): điểm của
 * chùm tính theo thang lũy tiến ở tầng quiz, không cộng tuyến tính.
 */
export const quizSlots = pgTable(
  'quiz_slots',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    page: integer('page').notNull().default(1),
    questionId: uuid('question_id').references(() => question.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => questionCategories.id, { onDelete: 'cascade' }),
    matrixCellId: uuid('matrix_cell_id').references(() => examMatrixCells.id, { onDelete: 'cascade' }),
    clusterId: uuid('cluster_id'),
    maxMark: doublePrecision('max_mark').notNull().default(1),
    /**
     * Kỷ luật version của slot (feat Ngân hàng câu hỏi chung, QB-3):
     * 'pinned' = slot ghim cứng vào pinned_version_id (mặc định khi thêm
     * câu từ bank tổ/trường); 'follow_latest' = mỗi lượt làm lấy version
     * ready mới nhất (hành vi cũ). pinned_version_number là bản sao số
     * version để hiển thị "đang ghim v[n] · đã có v[m]" không cần join.
     */
    versionMode: text('version_mode').notNull().default('follow_latest'),
    pinnedVersionId: uuid('pinned_version_id'),
    pinnedVersionNumber: integer('pinned_version_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('quiz_slots_question_id_idx').on(table.questionId),
      index('quiz_slots_category_id_idx').on(table.categoryId),
      index('quiz_slots_matrix_cell_id_idx').on(table.matrixCellId),
      index('quiz_slots_cluster_id_idx').on(table.clusterId),
      unique('quiz_slots_quiz_slot_unique').on(table.quizId, table.slot),
      check('quiz_slots_source_rule', sql`(${table.questionId} is not null or ${table.categoryId} is not null or ${table.matrixCellId} is not null) and not (${table.categoryId} is not null and (${table.questionId} is not null or ${table.matrixCellId} is not null))`),
  ],
);

/**
 * Nhật ký nâng version đã ghim của slot (QB-3): mỗi lần giáo viên bấm
 * "Nâng lên v[m]" ghi một dòng (slot, câu, từ version nào lên version
 * nào, ai nâng, khi nào) — truy vết đầy đủ cho đề dùng câu của bank chung.
 */
export const quizSlotVersionEvents = pgTable('quiz_slot_version_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
  slotId: uuid('slot_id').notNull().references(() => quizSlots.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id').notNull(),
  fromVersion: integer('from_version'),
  toVersion: integer('to_version').notNull(),
  actorId: uuid('actor_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('quiz_slot_version_events_slot_idx').on(table.slotId),
      index('quiz_slot_version_events_quiz_idx').on(table.quizId),
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
export const quizAttempts = pgTable(
  'quiz_attempts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
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
      index('quiz_attempts_quiz_id_idx').on(table.quizId),
      index('quiz_attempts_user_id_idx').on(table.userId),unique('quiz_attempts_usage_unique').on(table.usageId),unique('quiz_attempts_quiz_user_number_unique').on(table.quizId, table.userId, table.attemptNumber)],
);

/**
 * Dải nhận xét tổng quát theo khoảng điểm (Moodle `quiz_feedback`) —
 * tầng feedback thứ tư (sau feedback theo đáp án đã chọn / theo câu /
 * tổng quát của câu): khi một lượt chốt, % điểm của lượt rơi vào dải
 * [min_percent, max_percent) nào thì học sinh nhận nhận xét của dải đó,
 * qua cổng review_overall_feedback như các khía cạnh khác.
 */
export const quizFeedbacks = pgTable('quiz_feedbacks', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
  minPercent: doublePrecision('min_percent').notNull(),
  maxPercent: doublePrecision('max_percent').notNull(),
  feedback: text('feedback').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('quiz_feedbacks_quiz_idx').on(table.quizId),
      check('quiz_feedbacks_range_check', sql`${table.minPercent} >= 0 and ${table.maxPercent} <= 100 and ${table.minPercent} < ${table.maxPercent}`),
  ]);

/**
 * Nhật ký sự kiện trong lúc làm bài (giám sát thi): client báo các sự
 * kiện quan sát được (thoát fullscreen, mất focus/đổi tab trên desktop,
 * ngắt kết nối dài) và server tự ghi sự kiện nộp tự động khi hết giờ.
 * CHỈ GHI NHẬN để giáo viên xem lại sau thi — hệ thống không tự kết
 * luận gian lận, không tự huỳ/trừ điểm (theo tài liệu chính chủ Azota).
 */
export const quizAttemptEvents = pgTable('quiz_attempt_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  attemptId: uuid('attempt_id').notNull().references(() => quizAttempts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('quiz_attempt_events_attempt_idx').on(table.attemptId),
  ]);
