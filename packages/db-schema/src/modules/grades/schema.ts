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
 * Grade items — ĐIỂM THEO TỪNG BÀI (quyết định Lão gia 23:49 ngày
 * 25/10/2026, issue #224): nguồn sự thật duy nhất của điểm là điểm của
 * từng hoạt động. Mỗi hoạt động có đúng một item loại 'mod'
 * (item_instance = course_modules id, item_module = component); GV cũng
 * có thể tạo item 'manual' cho điểm nhập tay của một bài/đợt riêng.
 * KHÔNG còn category/letters/scales/outcomes, KHÔNG còn điểm tổng khoá
 * hay tổng category — mô hình gradebook tổng hợp đã bị gỡ hẳn.
 */
export const gradeItems = pgTable(
  'grade_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
    itemName: text('item_name').notNull().default(''),
    /** manual | mod. */
    itemType: text('item_type').notNull().default('manual'),
    itemModule: text('item_module'),
    itemInstance: uuid('item_instance'),
    gradeType: text('grade_type').notNull().default('value'),
    gradeMax: doublePrecision('grade_max').notNull().default(100),
    gradeMin: doublePrecision('grade_min').notNull().default(0),
    gradePass: doublePrecision('grade_pass').notNull().default(0),
    multiplicator: doublePrecision('multiplicator').notNull().default(1),
    plusFactor: doublePrecision('plus_factor').notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Chính sách công bố điểm của item (PH-0, issue #116 — Canvas Grade
     * Posting Policy): 'auto' = điểm/lời phê hiện phía học sinh ngay khi
     * chấm (mặc định); 'manual' = ẩn hoàn toàn cho tới khi giáo viên
     * công bố cho item (vết ở grade_publications). Công bố ở cấp BÀI.
     */
    postingPolicy: text('posting_policy').notNull().default('auto'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('grade_items_item_instance_idx').on(table.itemInstance),
      unique('grade_items_course_type_instance_unique').on(table.courseId, table.itemType, table.itemInstance, table.itemModule)],
);

/**
 * Điểm của từng học sinh tại một item (một bài). raw_grade là điểm nhập;
 * final_grade là điểm hiệu lực (sau hệ số/offset của item qua engine
 * @lms/grades). `frozen`: điểm đã sinh bởi công thức hệ số/offset thì
 * giữ nguyên verbatim cho tới khi GV gỡ đóng băng.
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

/** Lịch sử thay đổi điểm của một bài. action: 1=insert, 2=update, 3=delete. */
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

/**
 * Vết công bố điểm của một BÀI (PH-0, issue #116): bảng append-only —
 * mỗi hàng là một hành động công bố/rút công bố của giáo viên cho một
 * grade item; trạng thái hiệu lực của item là hành động mới nhất của
 * nó. Chỉ có nghĩa khi item đặt posting_policy='manual'. (Trước đây
 * bảng này còn scope vn_term/vn_year của Sổ điểm VN — đã gỡ cùng mô
 * hình sổ ở issue #224; scope nay chỉ còn 'item'.)
 */
export const gradePublications = pgTable('grade_publications', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
  /** item. */
  scope: text('scope').notNull(),
  itemId: uuid('item_id').references(() => gradeItems.id, { onDelete: 'cascade' }),
  /** publish | unpublish. */
  action: text('action').notNull(),
  actorId: uuid('actor_id').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('grade_publications_course_id_idx').on(table.courseId),
      index('grade_publications_item_id_idx').on(table.itemId),
  ]);
