/** Các bảng của bounded context Reports (Report Builder) — định nghĩa Drizzle do module reports sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** Báo cáo tuỳ biến (Report Builder): columns/filters là cấu hình JSON, không bao giờ nới quyền. */
export const reportbuilderReport = pgTable('reportbuilder_report', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  datasource: text('datasource').notNull(), // enrolments | grades | completion
  columns: jsonb('columns').notNull().default([]),
  filters: jsonb('filters').notNull().default({}),
  createdby: integer('createdby').notNull(),
  contextid: integer('contextid').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Audience của báo cáo: userids/role shortnames được phép xem (giao với quyền từng dòng). */
export const reportbuilderAudience = pgTable('reportbuilder_audience', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  reportid: integer('reportid').notNull().references(() => reportbuilderReport.id, { onDelete: 'cascade' }),
  userid: integer('userid'),
  role: text('role'),
});

/** Lịch chạy báo cáo: chạy dưới danh tính người tạo với quyền tại thời điểm chạy. */
export const reportbuilderSchedule = pgTable('reportbuilder_schedule', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  reportid: integer('reportid').notNull().references(() => reportbuilderReport.id, { onDelete: 'cascade' }),
  createdby: integer('createdby').notNull(),
  cron: text('cron').notNull().default('daily'),
  enabled: boolean('enabled').notNull().default(true),
  lastrun: timestamp('lastrun', { withTimezone: true }),
  lastresult: jsonb('lastresult'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});
