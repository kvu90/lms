/** Các bảng của bounded context Reports (Report Builder) — định nghĩa Drizzle do module reports sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Báo cáo tuỳ biến (Report Builder): columns/filters là cấu hình JSON, không bao giờ nới quyền. */
export const reportbuilderReport = pgTable('reportbuilder_report', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  datasource: text('datasource').notNull(), // enrolments | grades | completion
  columns: jsonb('columns').notNull().default([]),
  filters: jsonb('filters').notNull().default({}),
  createdby: uuid('createdby').notNull(),
  contextid: uuid('contextid'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('reportbuilder_report_createdby_idx').on(table.createdby),
      index('reportbuilder_report_contextid_idx').on(table.contextid),
  ]);


/** Audience của báo cáo: userids/role shortnames được phép xem (giao với quyền từng dòng). */
export const reportbuilderAudience = pgTable('reportbuilder_audience', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  reportid: uuid('reportid').notNull().references(() => reportbuilderReport.id, { onDelete: 'cascade' }),
  userid: uuid('userid'),
  role: text('role'),
},
  (table) => [
      index('reportbuilder_audience_reportid_idx').on(table.reportid),
      index('reportbuilder_audience_userid_idx').on(table.userid),
  ]);


/** Lịch chạy báo cáo: chạy dưới danh tính người tạo với quyền tại thời điểm chạy. */
export const reportbuilderSchedule = pgTable('reportbuilder_schedule', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  reportid: uuid('reportid').notNull().references(() => reportbuilderReport.id, { onDelete: 'cascade' }),
  createdby: uuid('createdby').notNull(),
  cron: text('cron').notNull().default('daily'),
  enabled: boolean('enabled').notNull().default(true),
  lastrun: timestamp('lastrun', { withTimezone: true }),
  lastresult: jsonb('lastresult'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('reportbuilder_schedule_reportid_idx').on(table.reportid),
      index('reportbuilder_schedule_createdby_idx').on(table.createdby),
  ]);

