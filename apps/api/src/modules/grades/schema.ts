/** Các bảng của bounded context Grades — định nghĩa Drizzle do module grades sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { course } from '../courses/schema';

/**
 * Grade outcomes (Moodle `grade_outcomes`): thang định tính ở mức site (course_id = null)
 * hoặc mức khoá học, luôn gắn với một scale; grade item gắn outcome thì điểm của nó là
 * chỉ số (1-based) trong scale của outcome và không tham gia tổng hợp số của category.
 */
export const gradeOutcomes = pgTable('grade_outcomes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id').references(() => course.id, { onDelete: 'cascade' }),
  scaleId: uuid('scale_id').notNull().references(() => scales.id, { onDelete: 'restrict' }),
  name: text('name').notNull().default(''),
  description: text('description').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('grade_outcomes_course_id_idx').on(table.courseId),
      index('grade_outcomes_scale_id_idx').on(table.scaleId),
  ]);


/** Scales (Moodle `scale`): course_id 0 = site scale. `scale` is a comma-separated list of values, lowest first. */
export const scales = pgTable('scales', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id'),
  name: text('name').notNull(),
  scale: text('scale').notNull().default(''),
  description: text('description').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('scales_course_id_idx').on(table.courseId),
  ]);


/**
 * Grade categories form a tree per course (Moodle `grade_categories`).
 * aggregation: natural|mean|weightedmean|simpleweightedmean|median|lowest|highest|mode|sum.
 * The category's own total is a grade_items row with item_type='category'
 * (course total: item_type='course'), exactly like Moodle.
 */
export const gradeCategories = pgTable('grade_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
  parent: uuid('parent'),
  fullName: text('full_name').notNull().default(''),
  aggregation: text('aggregation').notNull().default('natural'),
  dropLow: integer('drop_low').notNull().default(0),
  keepHigh: integer('keep_high').notNull().default(0),
  aggregateOnlyGraded: boolean('aggregate_only_graded').notNull().default(false),
  depth: integer('depth').notNull().default(1),
  path: text('path').notNull().default(''),
  hidden: boolean('hidden').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('grade_categories_course_id_idx').on(table.courseId),
      index('grade_categories_parent_idx').on(table.parent),
  ]);


/**
 * Sổ điểm VN (GB-VN-1, issue #95): lớp preset quốc gia TT 22 đặt TRÊN gradebook
 * engine hiện có — một sổ là một khoá học × một học kì. Cột điểm của sổ vẫn là
 * grade_items thường (gắn qua vn_book_id/vn_role/vn_ordinal), nằm trong một
 * grade category `weightedmean` (hệ số 1/2/3) do sổ sở hữu qua category_id.
 * Môn chỉ-nhận-xét (Điều 5.3a) có assessment_mode='comment' và KHÔNG sinh cột điểm.
 */
export const vnGradebooks = pgTable('vn_gradebooks', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
  /** Học kì: hk1 | hk2. */
  term: text('term').notNull(),
  /** Chế độ đánh giá: tt22 | tt27 | free (lát GB-VN-1 chỉ thi công tt22). */
  regime: text('regime').notNull().default('tt22'),
  /** score = môn điểm số kết hợp nhận xét; comment = môn chỉ-nhận-xét (Điều 5.3a). */
  assessmentMode: text('assessment_mode').notNull().default('score'),
  /** Số tiết/năm của môn — đầu vào suy quota ĐĐGtx (Điều 6.2b); null ở môn nhận xét khi không khai. */
  subjectPeriodsPerYear: integer('subject_periods_per_year'),
  /** Số cột ĐĐGtx đã suy ra (lưu để truy vết quyết định sinh cột). */
  dgtxQuota: integer('dgtx_quota').notNull().default(0),
  /** Category weightedmean chứa các cột của sổ (null ở môn nhận xét — không có cột điểm). */
  categoryId: uuid('category_id').references(() => gradeCategories.id, { onDelete: 'set null' }),
  /** open | closed — chốt sổ theo đợt là GB-VN-4; lát này chỉ ghi trạng thái mở. */
  status: text('status').notNull().default('open'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
  closeNote: text('close_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('vn_gradebooks_course_id_idx').on(table.courseId),
      index('vn_gradebooks_category_id_idx').on(table.categoryId),
      unique('vn_gradebooks_course_term_unique').on(table.courseId, table.term),
  ]);


/**
 * Grade items (Moodle `grade_items`). item_type: course|category|manual|mod.
 * For 'mod', item_instance = course_modules id and item_module = component.
 * For 'category', item_instance = grade_categories id. For 'course', item_instance = course id.
 * aggregation_coef is the item's weight inside its parent category (used by
 * weightedmean always, and by natural when weight_override is set).
 */
export const gradeItems = pgTable(
  'grade_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => gradeCategories.id, { onDelete: 'cascade' }),
    itemName: text('item_name').notNull().default(''),
    itemType: text('item_type').notNull().default('manual'),
    itemModule: text('item_module'),
    itemInstance: uuid('item_instance'),
    gradeType: text('grade_type').notNull().default('value'),
    gradeMax: doublePrecision('grade_max').notNull().default(100),
    gradeMin: doublePrecision('grade_min').notNull().default(0),
    gradePass: doublePrecision('grade_pass').notNull().default(0),
    scaleId: uuid('scale_id').references(() => scales.id, { onDelete: 'set null' }),
    /** Outcome gắn với item (Moodle grade_items.outcomeid); item có outcome thì grade_type='scale' và scale_id là scale của outcome. */
    outcomeId: uuid('outcome_id').references(() => gradeOutcomes.id, { onDelete: 'set null' }),
    /** Định danh dùng trong công thức tính (Moodle grade_items.idnumber); duy nhất trong một khoá học khi không null. */
    idNumber: text('id_number'),
    /** Công thức của item loại 'calculated' (Moodle grade_items.calculation), dạng `=sum([[a]],[[b]])`. */
    calculation: text('calculation'),
    weightOverride: boolean('weight_override').notNull().default(false),
    aggregationCoef: doublePrecision('aggregation_coef').notNull().default(0),
    extraCredit: boolean('extra_credit').notNull().default(false),
    multiplicator: doublePrecision('multiplicator').notNull().default(1),
    plusFactor: doublePrecision('plus_factor').notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Sổ VN sở hữu cột này (GB-VN-1); null = item gradebook tự do, không thuộc sổ VN nào. */
    vnBookId: uuid('vn_book_id').references(() => vnGradebooks.id, { onDelete: 'set null' }),
    /** Vai trò cột TT 22: dgtx|dggk|dgck (môn điểm số); nx_tx|nx_gk|nx_ck|ktdk|tong_hop dành cho GB-VN-3. */
    vnRole: text('vn_role'),
    /** Thứ tự cột trong vai trò (ĐĐGtx 1..N); null ở các vai trò đơn cột. */
    vnOrdinal: integer('vn_ordinal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('grade_items_category_id_idx').on(table.categoryId),
      index('grade_items_vn_book_id_idx').on(table.vnBookId),
      index('grade_items_item_instance_idx').on(table.itemInstance),
      index('grade_items_scale_id_idx').on(table.scaleId),index('grade_items_outcome_id_idx').on(table.outcomeId),unique('grade_items_course_id_number_unique').on(table.courseId, table.idNumber),unique('grade_items_course_type_instance_unique').on(table.courseId, table.itemType, table.itemInstance, table.itemModule)],
);

/**
 * Per-user grades (Moodle `grade_grades`). raw_grade is what was entered;
 * final_grade is what counts (after multiplicator/offset + aggregation for
 * category/course items). `frozen` is explicit data (report §2#7): once a
 * grade was produced with a multiplicator/offset (a penalty-style formula),
 * its final_grade is frozen and regrades reuse it verbatim until unfrozen.
 */
export const gradeGrades = pgTable(
  'grade_grades',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    itemId: uuid('item_id').notNull().references(() => gradeItems.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    rawGrade: doublePrecision('raw_grade'),
    rawGradeMax: doublePrecision('raw_grade_max').notNull().default(100),
    rawGradeMin: doublePrecision('raw_grade_min').notNull().default(0),
    finalGrade: doublePrecision('final_grade'),
    hidden: boolean('hidden').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    lockTime: timestamp('lock_time', { withTimezone: true }),
    overridden: boolean('overridden').notNull().default(false),
    excluded: boolean('excluded').notNull().default(false),
    frozen: boolean('frozen').notNull().default(false),
    feedback: text('feedback'),
    information: text('information'),
    aggregationStatus: text('aggregation_status').notNull().default('unknown'),
    aggregationWeight: doublePrecision('aggregation_weight'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('grade_grades_user_id_idx').on(table.userId),unique('grade_grades_item_user_unique').on(table.itemId, table.userId)],
);

/** Grade change history (Moodle `grade_grades_history`). action: 1=insert, 2=update, 3=delete. */
export const gradeGradesHistory = pgTable('grade_grades_history', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  action: integer('action').notNull().default(2),
  oldId: uuid('old_id'),
  itemId: uuid('item_id').notNull(),
  userId: uuid('user_id').notNull(),
  rawGrade: doublePrecision('raw_grade'),
  finalGrade: doublePrecision('final_grade'),
  overridden: boolean('overridden').notNull().default(false),
  excluded: boolean('excluded').notNull().default(false),
  frozen: boolean('frozen').notNull().default(false),
  source: text('source'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  loggedUser: uuid('logged_user'),
},
  (table) => [
      index('grade_grades_history_old_id_idx').on(table.oldId),
      index('grade_grades_history_item_id_idx').on(table.itemId),
      index('grade_grades_history_user_id_idx').on(table.userId),
      index('grade_grades_history_logged_user_idx').on(table.loggedUser),
  ]);


/** Grade letters per context (Moodle `grade_letters`): letter applies when percentage >= lower_boundary. */
export const gradeLetters = pgTable(
  'grade_letters',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    contextId: uuid('context_id').notNull(),
    lowerBoundary: doublePrecision('lower_boundary').notNull(),
    letter: text('letter').notNull(),
  },
  (table) => [unique('grade_letters_context_boundary_unique').on(table.contextId, table.lowerBoundary)],
);


/**
 * Bản chốt kết quả của sổ VN (GB-VN-1): scope 'term' gắn một sổ (ĐTBmhk của môn
 * điểm số, hoặc kết quả Đạt/Chưa đạt của môn nhận xét qua comment_result);
 * scope 'year' gắn khoá học (book_id null) với ĐTBmcn tính từ hai bản chốt kì.
 * Chốt lại tạo bản mới với version tăng dần — không sửa đè bản cũ;
 * replaced_by_result_id dành cho điểm đánh giá lại mùa hè (Điều 14, GB-VN-4).
 */
export const vnTermResults = pgTable('vn_term_results', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  bookId: uuid('book_id').references(() => vnGradebooks.id, { onDelete: 'cascade' }),
  courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  /** term = kết quả một học kì của một sổ; year = kết quả cả năm của một khoá học. */
  scope: text('scope').notNull().default('term'),
  /** ĐTB môn học kì đã làm tròn 1 chữ số thập phân (scope term, môn điểm số). */
  dtbHk: doublePrecision('dtb_hk'),
  /** ĐTB môn cả năm đã làm tròn (scope year). */
  dtbYear: doublePrecision('dtb_year'),
  /** Kết quả Đạt | Chưa đạt của môn chỉ-nhận-xét (scope term). */
  commentResult: text('comment_result'),
  /** Nhận xét kì đi kèm kết quả (Điều 5.1). */
  comment: text('comment'),
  /** Bản chốt này thay thế bản nào (đánh giá lại — Điều 14); không có khoá ngoại để giữ vết độc lập. */
  replacedByResultId: uuid('replaced_by_result_id'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('vn_term_results_book_id_idx').on(table.bookId),
      index('vn_term_results_course_id_idx').on(table.courseId),
      index('vn_term_results_user_id_idx').on(table.userId),
  ]);
