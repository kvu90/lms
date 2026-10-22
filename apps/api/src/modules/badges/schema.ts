/** Các bảng của bounded context Badges — định nghĩa Drizzle do module badges sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Badges (Moodle `badge`). type: 1=site, 2=course. status: 0=inactive, 1=active, 2=retired, 3=archived, 4=disabled(hidden active). */
export const badge = pgTable('badge', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  type: integer('type').notNull().default(1),
  courseid: integer('courseid'),
  issuername: text('issuername').notNull().default(''),
  issuerurl: text('issuerurl').notNull().default(''),
  issuercontact: text('issuercontact').notNull().default(''),
  expiredate: timestamp('expiredate', { withTimezone: true }),
  expireperiod: integer('expireperiod'),
  status: integer('status').notNull().default(0),
  version: text('version').notNull().default(''),
  language: text('language').notNull().default('en'),
  usercreated: integer('usercreated'),
  usermodified: integer('usermodified'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Badge criteria (Moodle `badge_criteria`). One row with criteriatype
 * 'overall' carries the aggregation method (1=ALL, 2=ANY) over the leaf
 * rows. Leaf types: coursecompletion | activitycompletion | competency |
 * badge | manual. Leaf parameters live in `params` jsonb
 * (e.g. {courseId} / {cmId} / {competencyId} / {badgeId} / {roleId}).
 * Criteria of an ACTIVE badge (or one with issued awards) are FROZEN.
 */
export const badgeCriteria = pgTable('badge_criteria', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  badgeid: integer('badgeid').notNull().references(() => badge.id, { onDelete: 'cascade' }),
  criteriatype: text('criteriatype').notNull(),
  method: integer('method').notNull().default(1),
  params: jsonb('params').notNull().default({}),
  description: text('description').notNull().default(''),
});

/**
 * Issued badge assertions (Moodle `badge_issued`): IMMUTABLE evidence that a
 * user earned a badge — a snapshot of the badge + criteria at issue time.
 * Revoking never deletes the row; it flips `revoked`.
 */
export const badgeIssued = pgTable(
  'badge_issued',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    badgeid: integer('badgeid').notNull().references(() => badge.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    uniquehash: text('uniquehash').notNull().unique(),
    snapshot: jsonb('snapshot').notNull().default({}),
    evidence: jsonb('evidence').notNull().default({}),
    dateissued: timestamp('dateissued', { withTimezone: true }).notNull().defaultNow(),
    dateexpire: timestamp('dateexpire', { withTimezone: true }),
    visible: boolean('visible').notNull().default(true),
    revoked: boolean('revoked').notNull().default(false),
    revokedat: timestamp('revokedat', { withTimezone: true }),
    issuernotified: boolean('issuernotified').notNull().default(false),
  },
  (table) => [unique('badge_issued_badge_user_unique').on(table.badgeid, table.userid)],
);

/** Manual awards (Moodle `badge_manual_award`): proof that a manual criterion was met by a role holder's decision. */
export const badgeManualAward = pgTable(
  'badge_manual_award',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    badgeid: integer('badgeid').notNull().references(() => badge.id, { onDelete: 'cascade' }),
    recipientid: integer('recipientid').notNull(),
    issuerid: integer('issuerid').notNull(),
    issuerrole: integer('issuerrole'),
    datemet: timestamp('datemet', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('badge_manual_award_unique').on(table.badgeid, table.recipientid, table.issuerid)],
);
