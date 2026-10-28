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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Dự đoán của model cho một user trong một context — suy luận, không phải dữ kiện. */
export const analyticsPredictions = pgTable('analytics_predictions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  modelId: uuid('model_id').notNull().references(() => analyticsModels.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  contextId: uuid('context_id').notNull(),
  courseId: uuid('course_id'),
  score: doublePrecision('score').notNull().default(0),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('analytics_predictions_model_id_idx').on(table.modelId),
      index('analytics_predictions_user_id_idx').on(table.userId),
      index('analytics_predictions_context_id_idx').on(table.contextId),
      index('analytics_predictions_course_id_idx').on(table.courseId),
  ]);


/** Insight sinh cho user có capability ở context liên quan. */
export const insights = pgTable('insights', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  modelId: uuid('model_id').notNull().references(() => analyticsModels.id, { onDelete: 'cascade' }),
  predictionId: uuid('prediction_id'),
  userId: uuid('user_id').notNull(), // chủ thể
  recipientId: uuid('recipient_id').notNull(),
  contextId: uuid('context_id').notNull(),
  courseId: uuid('course_id'),
  heading: text('heading').notNull().default(''),
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('insights_model_id_idx').on(table.modelId),
      index('insights_prediction_id_idx').on(table.predictionId),
      index('insights_user_id_idx').on(table.userId),
      index('insights_recipient_id_idx').on(table.recipientId),
      index('insights_context_id_idx').on(table.contextId),
      index('insights_course_id_idx').on(table.courseId),
  ]);

