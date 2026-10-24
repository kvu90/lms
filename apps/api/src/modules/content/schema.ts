/** Các bảng của bounded context Content (học liệu trong khoá) — định nghĩa Drizzle do module content sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { course, courseModules } from '../courses/schema';
import { files } from '../files/schema';

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('resources_course_idx').on(table.course),
      index('resources_cm_id_idx').on(table.cmId),
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
  ]);
