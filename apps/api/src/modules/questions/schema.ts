/** Các bảng của bounded context Questions — định nghĩa Drizzle do module questions sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  doublePrecision,
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

/** Question categories live in a context (Moodle `question_categories`). */
export const questionCategories = pgTable('question_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  contextid: uuid('contextid').notNull(),
  info: text('info').notNull().default(''),
  parent: uuid('parent'),
  sortorder: integer('sortorder').notNull().default(0),
  stamp: text('stamp').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('question_categories_contextid_idx').on(table.contextid),
      index('question_categories_parent_idx').on(table.parent),
  ]);


/** Question identity (Moodle `question`): stable across versions; content lives in question_versions. */
export const question = pgTable('question', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  category: uuid('category').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
  qtype: text('qtype').notNull(),
  name: text('name').notNull(),
  createdby: uuid('createdby'),
  modifiedby: uuid('modifiedby'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('question_category_idx').on(table.category),
      index('question_createdby_idx').on(table.createdby),
      index('question_modifiedby_idx').on(table.modifiedby),
  ]);


/**
 * Bank entries (Moodle `question_bank_entries`) link a question identity to a
 * category and track the latest version number. Editing a question creates a
 * NEW question_versions row and bumps latestversion; attempts already started
 * keep pointing at the version they pinned.
 */
export const questionBankEntries = pgTable(
  'question_bank_entries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    questioncategoryid: uuid('questioncategoryid').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
    questionid: uuid('questionid').notNull().references(() => question.id, { onDelete: 'cascade' }),
    latestversion: integer('latestversion').notNull().default(1),
    status: text('status').notNull().default('ready'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('question_bank_entries_questioncategoryid_idx').on(table.questioncategoryid),unique('question_bank_entries_question_unique').on(table.questionid)],
);

/**
 * Immutable question content versions (Moodle `question_versions`).
 * answerdata is the generic correct-answer payload of the version
 * (truefalse: {correct: boolean}; shortanswer: {answers: string[], casesensitive?: boolean}) —
 * qtypes are plugins and out of scope; the engine grades against THIS data.
 */
export const questionVersions = pgTable(
  'question_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    questionbankentryid: uuid('questionbankentryid').notNull().references(() => questionBankEntries.id, { onDelete: 'cascade' }),
    questionid: uuid('questionid').notNull().references(() => question.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('ready'),
    questiontext: text('questiontext').notNull().default(''),
    defaultmark: doublePrecision('defaultmark').notNull().default(1),
    answerdata: jsonb('answerdata').notNull().default({}),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('question_versions_questionid_idx').on(table.questionid),unique('question_versions_entry_version_unique').on(table.questionbankentryid, table.version)],
);

/** Question usages group attempts for one activity instance (Moodle `question_usages`). */
export const questionUsages = pgTable('question_usages', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  component: text('component').notNull(),
  instanceid: uuid('instanceid'),
  owningcontextid: uuid('owningcontextid'),
  preferredbehaviour: text('preferredbehaviour').notNull().default('deferredfeedback'),
  userid: uuid('userid'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('question_usages_instanceid_idx').on(table.instanceid),
      index('question_usages_owningcontextid_idx').on(table.owningcontextid),
      index('question_usages_userid_idx').on(table.userid),
  ]);


/**
 * One attempt at one question inside a usage (Moodle `question_attempts`).
 * questionversionid is PINNED when the attempt starts: later edits of the
 * question (new versions) never change how this attempt is graded.
 * state follows Moodle question_state names.
 */
export const questionAttempts = pgTable(
  'question_attempts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    questionusageid: uuid('questionusageid').notNull().references(() => questionUsages.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    behaviour: text('behaviour').notNull().default('deferredfeedback'),
    questionid: uuid('questionid').notNull().references(() => question.id, { onDelete: 'cascade' }),
    questionversionid: uuid('questionversionid').references(() => questionVersions.id, { onDelete: 'set null' }),
    variant: integer('variant').notNull().default(1),
    maxmark: doublePrecision('maxmark').notNull().default(1),
    minfraction: doublePrecision('minfraction').notNull().default(0),
    maxfraction: doublePrecision('maxfraction').notNull().default(1),
    flagged: boolean('flagged').notNull().default(false),
    questionsummary: text('questionsummary'),
    responsesummary: text('responsesummary'),
    rightanswer: text('rightanswer'),
    state: text('state').notNull().default('notstarted'),
    fraction: doublePrecision('fraction'),
    userid: uuid('userid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('question_attempts_questionid_idx').on(table.questionid),
      index('question_attempts_questionversionid_idx').on(table.questionversionid),
      index('question_attempts_userid_idx').on(table.userid),unique('question_attempts_usage_slot_unique').on(table.questionusageid, table.slot)],
);

/** Every state transition of an attempt is a step (Moodle `question_attempt_steps`). */
export const questionAttemptSteps = pgTable(
  'question_attempt_steps',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    questionattemptid: uuid('questionattemptid').notNull().references(() => questionAttempts.id, { onDelete: 'cascade' }),
    sequencenumber: integer('sequencenumber').notNull(),
    state: text('state').notNull(),
    fraction: doublePrecision('fraction'),
    userid: uuid('userid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('question_attempt_steps_userid_idx').on(table.userid),unique('question_attempt_steps_attempt_seq_unique').on(table.questionattemptid, table.sequencenumber)],
);

/** Step payload data (Moodle `question_attempt_step_data`): e.g. name='answer', value='true'. */
export const questionAttemptStepData = pgTable(
  'question_attempt_step_data',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    attemptstepid: uuid('attemptstepid').notNull().references(() => questionAttemptSteps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [unique('question_attempt_step_data_step_name_unique').on(table.attemptstepid, table.name)],
);
