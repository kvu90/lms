/** Các bảng của bounded context Bài tập nộp tệp/ảnh (mod_assign) — định nghĩa Drizzle do module assignments sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
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
import { files } from '../files/schema';

/**
 * Hoạt động Bài tập nộp tệp/ảnh trong khoá học (Moodle `assign` với
 * submission type file/ảnh): instance của một course module
 * (course_modules trỏ instance_id về đây, component 'mod_assign'; cột
 * cm_id là bản sao tiện tra cứu — nguồn sự thật của quan hệ cm vẫn là
 * course_modules.instance_id). grade là thang điểm của BÀI. due_date là
 * hạn nộp: nộp sau hạn vẫn được nhận nhưng bị đánh dấu trễ (late).
 * accepted_file_types: danh sách đuôi tệp cách nhau bằng dấu phẩy
 * (không phân biệt hoa thường, không kèm dấu chấm); null = mọi loại tệp.
 */
export const assignments = pgTable('assignments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  cmId: uuid('cm_id'),
  name: text('name').notNull(),
  intro: text('intro').notNull().default(''),
  dueDate: timestamp('due_date', { withTimezone: true }),
  maxFiles: integer('max_files').notNull().default(10),
  acceptedFileTypes: text('accepted_file_types'),
  grade: doublePrecision('grade').notNull().default(10),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assignments_course_idx').on(table.course),
      index('assignments_cm_id_idx').on(table.cmId),
  ]);

/**
 * Bài nộp của một học sinh cho một bài tập (Moodle `assign_submission`):
 * mỗi (assignment, user) có đúng một bản ghi hiện hành. Vòng đời:
 * draft (đang soạn, thêm/bớt tệp được) → submitted (đã chốt nộp; muốn sửa
 * phải mở lại về draft khi chưa bị chấm) — đã chấm (có bản ghi ở
 * assign_grades khớp attempt_number) thì khoá hẳn. attempt_number tăng
 * mỗi lần nộp lại sau khi mở lại. submitted_at là mốc nộp gần nhất; nộp
 * trễ khi submitted_at > assignments.due_date.
 */
export const assignSubmissions = pgTable('assign_submissions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  assignmentId: uuid('assignment_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  status: text('status').notNull().default('draft'),
  attemptNumber: integer('attempt_number').notNull().default(1),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assign_submissions_assignment_id_idx').on(table.assignmentId),
      index('assign_submissions_user_id_idx').on(table.userId),
      unique('assign_submissions_assignment_user_unique').on(table.assignmentId, table.userId),
  ]);

/**
 * Tệp thuộc một bài nộp: bản ghi vật lý sống ở bảng `files` của module
 * Files (component 'mod_assign', file_area 'submission_files', item_id =
 * submission id, context = context của course module) — dedup theo
 * content hash và tải qua signed URL như mọi tệp trong hệ thống; bảng này
 * chỉ giữ quan hệ bài nộp ↔ tệp và thứ tự hiển thị khi chấm.
 */
export const assignSubmissionFiles = pgTable('assign_submission_files', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  submissionId: uuid('submission_id').notNull().references(() => assignSubmissions.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id').notNull().references(() => files.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assign_submission_files_submission_id_idx').on(table.submissionId),
      unique('assign_submission_files_submission_file_unique').on(table.submissionId, table.fileId),
  ]);

/**
 * Điểm + lời phê của giáo viên cho một bài nộp (Moodle `assign_grades`):
 * mỗi (assignment, user) một bản ghi hiện hành; attempt_number ghi lại
 * điểm này thuộc lần nộp nào — là điều kiện để trạng thái "graded" chỉ áp
 * cho đúng lần nộp đã chấm. Điểm số đồng thời được ghi vào sổ điểm qua
 * grade item 'mod' của course module (GradesService.recordActivityGrade,
 * source 'mod/assign') để chảy vào gradebook + completion như mọi hoạt
 * động; bản ghi ở đây là nơi giữ lời phê và truy vết người chấm.
 */
export const assignGrades = pgTable('assign_grades', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  assignmentId: uuid('assignment_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  graderId: uuid('grader_id').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  grade: doublePrecision('grade'),
  feedback: text('feedback'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('assign_grades_assignment_id_idx').on(table.assignmentId),
      index('assign_grades_user_id_idx').on(table.userId),
      unique('assign_grades_assignment_user_unique').on(table.assignmentId, table.userId),
  ]);
