/** Các bảng của bounded context Analytics — định nghĩa Drizzle do module analytics sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** Mô hình phân tích: target + indicators là provider đăng ký trong code. */
export const analyticsModels = pgTable('analytics_models', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull().unique(),
  target: text('target').notNull(),
  indicators: jsonb('indicators').notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Dự đoán của model cho một user trong một context — suy luận, không phải dữ kiện. */
export const analyticsPredictions = pgTable('analytics_predictions', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  modelid: integer('modelid').notNull().references(() => analyticsModels.id, { onDelete: 'cascade' }),
  userid: integer('userid').notNull(),
  contextid: integer('contextid').notNull(),
  courseid: integer('courseid').notNull().default(0),
  score: doublePrecision('score').notNull().default(0),
  data: jsonb('data'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Insight sinh cho user có capability ở context liên quan. */
export const insights = pgTable('insights', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  modelid: integer('modelid').notNull().references(() => analyticsModels.id, { onDelete: 'cascade' }),
  predictionid: integer('predictionid'),
  userid: integer('userid').notNull(), // subject
  recipientid: integer('recipientid').notNull(),
  contextid: integer('contextid').notNull(),
  courseid: integer('courseid').notNull().default(0),
  heading: text('heading').notNull().default(''),
  data: jsonb('data'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});
