/** Các bảng của bounded context Badges — định nghĩa Drizzle do module badges sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Huy hiệu (Moodle `badge`). type: 1=site, 2=course. status: 0=inactive, 1=active, 2=retired, 3=archived, 4=disabled (đang active nhưng bị ẩn). */
export const badge = pgTable('badge', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  type: integer('type').notNull().default(1),
  courseId: uuid('course_id'),
  issuerName: text('issuer_name').notNull().default(''),
  issuerUrl: text('issuer_url').notNull().default(''),
  issuerContact: text('issuer_contact').notNull().default(''),
  expireDate: timestamp('expire_date', { withTimezone: true }),
  expirePeriod: integer('expire_period'),
  status: integer('status').notNull().default(0),
  version: text('version').notNull().default(''),
  language: text('language').notNull().default('en'),
  userCreated: uuid('user_created'),
  userModified: uuid('user_modified'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('badge_course_id_idx').on(table.courseId),
      index('badge_user_created_idx').on(table.userCreated),
  ]);


/**
 * Tiêu chí huy hiệu (Moodle `badge_criteria`). Một dòng có criteria_type
 * 'overall' mang phương thức tổng hợp (1=ALL, 2=ANY) trên các dòng lá.
 * Các loại lá: coursecompletion | activitycompletion | competency |
 * badge | manual | cohort | profile. Tham số của lá nằm trong `params` jsonb
 * (ví dụ {courseId, byDate?} / {cmId} / {competencyId} / {badgeId} /
 * {roleId} / {cohortId} hoặc {cohortIds} / {field, value?}).
 * Tiêu chí của một huy hiệu đang ACTIVE (hoặc đã có lượt trao) bị ĐÓNG BĂNG.
 */
export const badgeCriteria = pgTable('badge_criteria', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  badgeId: uuid('badge_id').notNull().references(() => badge.id, { onDelete: 'cascade' }),
  criteriaType: text('criteria_type').notNull(),
  method: integer('method').notNull().default(1),
  params: jsonb('params').notNull().default({}),
  description: text('description').notNull().default(''),
},
  (table) => [
      index('badge_criteria_badge_id_idx').on(table.badgeId),
  ]);


/**
 * Khẳng định huy hiệu đã cấp (Moodle `badge_issued`): bằng chứng BẤT BIẾN rằng một
 * user đã đạt được một huy hiệu — bản chụp của huy hiệu + tiêu chí tại thời điểm cấp.
 * Thu hồi không bao giờ xoá dòng; chỉ lật cờ `revoked`.
 */
export const badgeIssued = pgTable(
  'badge_issued',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    badgeId: uuid('badge_id').notNull().references(() => badge.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    uniqueHash: text('unique_hash').notNull().unique(),
    snapshot: jsonb('snapshot').notNull().default({}),
    evidence: jsonb('evidence').notNull().default({}),
    dateIssued: timestamp('date_issued', { withTimezone: true }).notNull().defaultNow(),
    dateExpire: timestamp('date_expire', { withTimezone: true }),
    visible: boolean('visible').notNull().default(true),
    revoked: boolean('revoked').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    issuerNotified: boolean('issuer_notified').notNull().default(false),
  },
  (table) => [
      index('badge_issued_user_id_idx').on(table.userId),unique('badge_issued_badge_user_unique').on(table.badgeId, table.userId)],
);

/** Lượt trao thủ công (Moodle `badge_manual_award`): bằng chứng cho việc một tiêu chí thủ công đã được đáp ứng theo quyết định của người giữ vai trò. */
export const badgeManualAward = pgTable(
  'badge_manual_award',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    badgeId: uuid('badge_id').notNull().references(() => badge.id, { onDelete: 'cascade' }),
    recipientId: uuid('recipient_id').notNull(),
    issuerId: uuid('issuer_id').notNull(),
    issuerRole: uuid('issuer_role'),
    dateMet: timestamp('date_met', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('badge_manual_award_recipient_id_idx').on(table.recipientId),
      index('badge_manual_award_issuer_id_idx').on(table.issuerId),
      index('badge_manual_award_issuer_role_idx').on(table.issuerRole),unique('badge_manual_award_unique').on(table.badgeId, table.recipientId, table.issuerId)],
);
