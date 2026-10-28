/** Các bảng của bounded context Backup — định nghĩa Drizzle do module backup sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Việc sao lưu/khôi phục: archive là manifest JSON có version riêng (không phải .mbz).
 * `scope`: 'course' (mặc định, gắn một khoá học) | 'site' (sao lưu mức hệ
 * thống — khi đó `course_id` là NULL và archive chỉ chứa các contributor mức
 * site: question bank mức site, badge mức site, calendar mức site).
 */
export const backupJobs = pgTable('backup_jobs', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  type: text('type').notNull(), // backup | restore
  scope: text('scope').notNull().default('course'),
  courseId: uuid('course_id'),
  targetCourseId: uuid('target_course_id'),
  mode: text('mode').notNull().default('new'), // new | merge | replace (restore)
  status: text('status').notNull().default('pending'), // pending | running | completed | failed
  anonymize: boolean('anonymize').notNull().default(false),
  userId: uuid('user_id').notNull(),
  archive: jsonb('archive'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  timeFinished: timestamp('time_finished', { withTimezone: true }),
},
  (table) => [
      index('backup_jobs_course_id_idx').on(table.courseId),
      index('backup_jobs_target_course_id_idx').on(table.targetCourseId),
      index('backup_jobs_user_id_idx').on(table.userId),
  ]);


/** Các bước của một backup/restore job (kế hoạch nhiều bước chạy ở worker). */
export const backupJobSteps = pgTable('backup_job_steps', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  jobId: uuid('job_id').notNull().references(() => backupJobs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: text('status').notNull().default('pending'),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('backup_job_steps_job_id_idx').on(table.jobId),
  ]);


/** Ánh xạ id gốc → id mới khi restore; id gốc KHÔNG BAO GIỜ được giữ lại. */
export const backupIdMappings = pgTable('backup_id_mappings', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  jobId: uuid('job_id').notNull().references(() => backupJobs.id, { onDelete: 'cascade' }),
  itemType: text('item_type').notNull(),
  oldId: uuid('old_id').notNull(),
  newId: uuid('new_id').notNull(),
}, (t) => [
      index('backup_id_mappings_job_id_idx').on(t.jobId),
      index('backup_id_mappings_old_id_idx').on(t.oldId),
      index('backup_id_mappings_new_id_idx').on(t.newId),unique('backup_id_mappings_unique').on(t.jobId, t.itemType, t.oldId)]);
