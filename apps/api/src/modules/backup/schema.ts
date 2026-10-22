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

/** Việc sao lưu/khôi phục: archive là manifest JSON có version riêng (không phải .mbz). */
export const backupJobs = pgTable('backup_jobs', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  type: text('type').notNull(), // backup | restore
  courseid: uuid('courseid').notNull(),
  targetcourseid: uuid('targetcourseid'),
  mode: text('mode').notNull().default('new'), // new | merge | replace (restore)
  status: text('status').notNull().default('pending'), // pending | running | completed | failed
  anonymize: boolean('anonymize').notNull().default(false),
  userid: uuid('userid').notNull(),
  archive: jsonb('archive'),
  error: text('error'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timefinished: timestamp('timefinished', { withTimezone: true }),
},
  (table) => [
      index('backup_jobs_courseid_idx').on(table.courseid),
      index('backup_jobs_targetcourseid_idx').on(table.targetcourseid),
      index('backup_jobs_userid_idx').on(table.userid),
  ]);


/** Các bước của một backup/restore job (kế hoạch nhiều bước chạy ở worker). */
export const backupJobSteps = pgTable('backup_job_steps', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  jobid: uuid('jobid').notNull().references(() => backupJobs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: text('status').notNull().default('pending'),
  detail: jsonb('detail'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('backup_job_steps_jobid_idx').on(table.jobid),
  ]);


/** Ánh xạ id gốc → id mới khi restore; id gốc KHÔNG BAO GIỜ được giữ lại. */
export const backupIdMappings = pgTable('backup_id_mappings', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  jobid: uuid('jobid').notNull().references(() => backupJobs.id, { onDelete: 'cascade' }),
  itemtype: text('itemtype').notNull(),
  oldid: uuid('oldid').notNull(),
  newid: uuid('newid').notNull(),
}, (t) => [
      index('backup_id_mappings_jobid_idx').on(t.jobid),
      index('backup_id_mappings_oldid_idx').on(t.oldid),
      index('backup_id_mappings_newid_idx').on(t.newid),unique('backup_id_mappings_unique').on(t.jobid, t.itemtype, t.oldid)]);
