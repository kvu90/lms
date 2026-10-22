/** Các bảng của bounded context Backup — định nghĩa Drizzle do module backup sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Việc sao lưu/khôi phục: archive là manifest JSON có version riêng (không phải .mbz). */
export const backupJobs = pgTable('backup_jobs', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  type: text('type').notNull(), // backup | restore
  courseid: integer('courseid').notNull(),
  targetcourseid: integer('targetcourseid'),
  mode: text('mode').notNull().default('new'), // new | merge | replace (restore)
  status: text('status').notNull().default('pending'), // pending | running | completed | failed
  anonymize: boolean('anonymize').notNull().default(false),
  userid: integer('userid').notNull(),
  archive: jsonb('archive'),
  error: text('error'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timefinished: timestamp('timefinished', { withTimezone: true }),
});

/** Các bước của một backup/restore job (kế hoạch nhiều bước chạy ở worker). */
export const backupJobSteps = pgTable('backup_job_steps', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  jobid: integer('jobid').notNull().references(() => backupJobs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: text('status').notNull().default('pending'),
  detail: jsonb('detail'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Ánh xạ id gốc → id mới khi restore; id gốc KHÔNG BAO GIỜ được giữ lại. */
export const backupIdMappings = pgTable('backup_id_mappings', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  jobid: integer('jobid').notNull().references(() => backupJobs.id, { onDelete: 'cascade' }),
  itemtype: text('itemtype').notNull(),
  oldid: integer('oldid').notNull(),
  newid: integer('newid').notNull(),
}, (t) => [unique('backup_id_mappings_unique').on(t.jobid, t.itemtype, t.oldid)]);
