/** Các bảng của bounded context Analytics — định nghĩa Drizzle do module analytics sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Mô hình phân tích: target + indicators là provider đăng ký trong code. */
export const analyticsModels = pgTable('analytics_models', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().unique(),
  target: text('target').notNull(),
  indicators: jsonb('indicators').notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Dự đoán của model cho một user trong một context — suy luận, không phải dữ kiện. */
export const analyticsPredictions = pgTable('analytics_predictions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  modelid: uuid('modelid').notNull().references(() => analyticsModels.id, { onDelete: 'cascade' }),
  userid: uuid('userid').notNull(),
  contextid: uuid('contextid').notNull(),
  courseid: uuid('courseid'),
  score: doublePrecision('score').notNull().default(0),
  data: jsonb('data'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('analytics_predictions_modelid_idx').on(table.modelid),
      index('analytics_predictions_userid_idx').on(table.userid),
      index('analytics_predictions_contextid_idx').on(table.contextid),
      index('analytics_predictions_courseid_idx').on(table.courseid),
  ]);


/** Insight sinh cho user có capability ở context liên quan. */
export const insights = pgTable('insights', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  modelid: uuid('modelid').notNull().references(() => analyticsModels.id, { onDelete: 'cascade' }),
  predictionid: uuid('predictionid'),
  userid: uuid('userid').notNull(), // subject
  recipientid: uuid('recipientid').notNull(),
  contextid: uuid('contextid').notNull(),
  courseid: uuid('courseid'),
  heading: text('heading').notNull().default(''),
  data: jsonb('data'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('insights_modelid_idx').on(table.modelid),
      index('insights_predictionid_idx').on(table.predictionid),
      index('insights_userid_idx').on(table.userid),
      index('insights_recipientid_idx').on(table.recipientid),
      index('insights_contextid_idx').on(table.contextid),
      index('insights_courseid_idx').on(table.courseid),
  ]);

