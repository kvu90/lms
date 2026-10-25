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

/** Badges (Moodle `badge`). type: 1=site, 2=course. status: 0=inactive, 1=active, 2=retired, 3=archived, 4=disabled(hidden active). */
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
 * Badge criteria (Moodle `badge_criteria`). One row with criteria_type
 * 'overall' carries the aggregation method (1=ALL, 2=ANY) over the leaf
 * rows. Leaf types: coursecompletion | activitycompletion | competency |
 * badge | manual | cohort | profile. Leaf parameters live in `params` jsonb
 * (e.g. {courseId, byDate?} / {cmId} / {competencyId} / {badgeId} /
 * {roleId} / {cohortId} hoặc {cohortIds} / {field, value?}).
 * Criteria of an ACTIVE badge (or one with issued awards) are FROZEN.
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
 * Issued badge assertions (Moodle `badge_issued`): IMMUTABLE evidence that a
 * user earned a badge — a snapshot of the badge + criteria at issue time.
 * Revoking never deletes the row; it flips `revoked`.
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

/** Manual awards (Moodle `badge_manual_award`): proof that a manual criterion was met by a role holder's decision. */
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
