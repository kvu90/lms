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
export const reportBuilderReport = pgTable('report_builder_report', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  dataSource: text('data_source').notNull(), // enrolments | grades | completion
  columns: jsonb('columns').notNull().default([]),
  filters: jsonb('filters').notNull().default({}),
  createdBy: uuid('created_by').notNull(),
  contextId: uuid('context_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('report_builder_report_created_by_idx').on(table.createdBy),
      index('report_builder_report_context_id_idx').on(table.contextId),
  ]);


/** Audience của báo cáo: userids/role shortnames được phép xem (giao với quyền từng dòng). */
export const reportBuilderAudience = pgTable('report_builder_audience', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  reportId: uuid('report_id').notNull().references(() => reportBuilderReport.id, { onDelete: 'cascade' }),
  userId: uuid('user_id'),
  role: text('role'),
},
  (table) => [
      index('report_builder_audience_report_id_idx').on(table.reportId),
      index('report_builder_audience_user_id_idx').on(table.userId),
  ]);


/** Lịch chạy báo cáo: chạy dưới danh tính người tạo với quyền tại thời điểm chạy. */
export const reportBuilderSchedule = pgTable('report_builder_schedule', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  reportId: uuid('report_id').notNull().references(() => reportBuilderReport.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').notNull(),
  cron: text('cron').notNull().default('daily'),
  enabled: boolean('enabled').notNull().default(true),
  lastRun: timestamp('last_run', { withTimezone: true }),
  lastResult: jsonb('last_result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('report_builder_schedule_report_id_idx').on(table.reportId),
      index('report_builder_schedule_created_by_idx').on(table.createdBy),
  ]);

