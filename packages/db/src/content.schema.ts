/** Các bảng của bounded context Content (học liệu trong khoá) — định nghĩa Drizzle do module content sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { course, courseModules } from './courses.schema';
import { files } from './files.schema';

/**
 * Trang đọc (Moodle `page` của mod_page): instance của một course module
 * (course_modules trỏ instance_id về đây, component 'mod_page'; cột cm_id
 * là bản sao tiện tra cứu như quiz). content là HTML hiển thị trong player.
 */
export const pages = pgTable('pages', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  cmId: uuid('cm_id'),
  name: text('name').notNull(),
  content: text('content').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('pages_course_idx').on(table.course),
      index('pages_cm_id_idx').on(table.cmId),
  ]);

/**
 * Tài nguyên (Moodle `resource` của mod_resource): đúng một nguồn cho mỗi
 * bản ghi — file_id (tệp đã tải lên qua Files: xem trực tuyến/tải xuống,
 * tệp video thì phát trong player) hoặc url (liên kết ngoài / video nhúng
 * như YouTube). kind ghi rõ nguồn đang dùng.
 */
export const resources = pgTable('resources', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  cmId: uuid('cm_id'),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('file'),
  fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
  url: text('url'),
  /** Bản chữ (transcript) đi kèm video — bản thay thế cho học sinh mạng yếu/khuyết tật và để ôn tập nhanh. */
  transcript: text('transcript'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('resources_course_idx').on(table.course),
      index('resources_cm_id_idx').on(table.cmId),
      index('resources_file_id_idx').on(table.fileId),
  ]);

/**
 * Dấu vết lần mở học gần nhất của một học sinh trong một khoá (nền của
 * "Học tiếp" theo last-access): mỗi (user, course) giữ đúng một dòng —
 * cm được mở gần nhất trong player và thời điểm mở. Ghi bởi endpoint
 * player mỗi lần học sinh mở một mục.
 */
export const courseLastAccess = pgTable('course_last_access', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
  cmId: uuid('cm_id').notNull().references(() => courseModules.id, { onDelete: 'cascade' }),
  accessedAt: timestamp('accessed_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('course_last_access_user_course_unique').on(table.userId, table.courseId),
      index('course_last_access_course_idx').on(table.courseId),
      index('course_last_access_cm_id_idx').on(table.cmId),
  ]);

/**
 * Tiến độ xem theo từng mục của một học sinh (nền của hoàn thành kiểu
 * progress cho video và của "học tiếp đúng vị trí dở"): percent là % đã
 * xem CAO NHẤT từng đạt (chỉ tăng, không giảm — ôn lại không bị phạt),
 * position_seconds/page là vị trí xem dở gần nhất. Sự kiện học được lưu
 * bền ở đây theo HS–mục–thời điểm (Điều 8 TT 09/2021: dữ liệu quá trình
 * học là hồ sơ); client gửi bù khi rớt mạng.
 */
export const courseModuleProgress = pgTable('course_module_progress', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
  cmId: uuid('cm_id').notNull().references(() => courseModules.id, { onDelete: 'cascade' }),
  percent: integer('percent').notNull().default(0),
  positionSeconds: integer('position_seconds'),
  page: integer('page'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('course_module_progress_user_cm_unique').on(table.userId, table.cmId),
      index('course_module_progress_course_idx').on(table.courseId),
      index('course_module_progress_cm_id_idx').on(table.cmId),
  ]);

/**
 * Bản ghi hồ sơ hoàn thành (Điều 8 TT 09/2021): chụp lại TÊN + loại mục
 * tại thời điểm học sinh hoàn thành, theo HS–mục–thời điểm. Cố ý KHÔNG
 * khoá ngoại vào course_modules/course: bản ghi phải sống sót khi giáo
 * viên sửa cấu trúc khoá hay xoá mục — completion hiện tại bị xoá theo
 * cm, còn hồ sơ này là minh chứng quá trình học. Một dòng cho lần hoàn
 * thành ĐẦU TIÊN của mỗi (HS, mục); học lại không ghi đè.
 */
export const learningRecords = pgTable('learning_records', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  courseId: uuid('course_id').notNull(),
  cmId: uuid('cm_id').notNull(),
  cmName: text('cm_name').notNull().default(''),
  component: text('component').notNull().default(''),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('learning_records_user_cm_unique').on(table.userId, table.cmId),
      index('learning_records_course_idx').on(table.courseId),
  ]);
