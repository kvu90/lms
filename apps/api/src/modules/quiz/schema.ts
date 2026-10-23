/** Các bảng của bounded context Quiz — định nghĩa Drizzle do module quiz sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
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
import { question, questionCategories, questionUsages } from '../questions/schema';

/**
 * Hoạt động Quiz trong khoá học (Moodle `quiz`): instance của một course
 * module (course_modules trỏ instance_id về đây, component 'mod_quiz';
 * cột cm_id là bản sao tiện tra cứu — nguồn sự thật của quan hệ cm vẫn là
 * course_modules.instance_id). grade là thang điểm của BÀI (điểm các slot
 * cộng lại rồi quy về thang này khi ghi sổ điểm). attempts_allowed = 0
 * nghĩa là không giới hạn (như Moodle). time_limit tính bằng giây.
 * grade_method: highest | average | first | last (Moodle grademethod).
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('quizzes_course_idx').on(table.course),
      index('quizzes_cm_id_idx').on(table.cmId),
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
export const quizSlots = pgTable(
  'quiz_slots',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    page: integer('page').notNull().default(1),
    questionId: uuid('question_id').references(() => question.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => questionCategories.id, { onDelete: 'cascade' }),
    maxMark: doublePrecision('max_mark').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('quiz_slots_question_id_idx').on(table.questionId),
      index('quiz_slots_category_id_idx').on(table.categoryId),unique('quiz_slots_quiz_slot_unique').on(table.quizId, table.slot)],
);

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
