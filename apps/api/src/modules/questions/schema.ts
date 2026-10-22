/** Các bảng của bounded context Questions — định nghĩa Drizzle do module questions sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Question categories live in a context (Moodle `question_categories`). */
export const questionCategories = pgTable('question_categories', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  contextid: integer('contextid').notNull(),
  info: text('info').notNull().default(''),
  parent: integer('parent'),
  sortorder: integer('sortorder').notNull().default(0),
  stamp: text('stamp').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Question identity (Moodle `question`): stable across versions; content lives in question_versions. */
export const question = pgTable('question', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  category: integer('category').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
  qtype: text('qtype').notNull(),
  name: text('name').notNull(),
  createdby: integer('createdby'),
  modifiedby: integer('modifiedby'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Bank entries (Moodle `question_bank_entries`) link a question identity to a
 * category and track the latest version number. Editing a question creates a
 * NEW question_versions row and bumps latestversion; attempts already started
 * keep pointing at the version they pinned.
 */
export const questionBankEntries = pgTable(
  'question_bank_entries',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    questioncategoryid: integer('questioncategoryid').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
    questionid: integer('questionid').notNull().references(() => question.id, { onDelete: 'cascade' }),
    latestversion: integer('latestversion').notNull().default(1),
    status: text('status').notNull().default('ready'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('question_bank_entries_question_unique').on(table.questionid)],
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
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    questionbankentryid: integer('questionbankentryid').notNull().references(() => questionBankEntries.id, { onDelete: 'cascade' }),
    questionid: integer('questionid').notNull().references(() => question.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('ready'),
    questiontext: text('questiontext').notNull().default(''),
    defaultmark: doublePrecision('defaultmark').notNull().default(1),
    answerdata: jsonb('answerdata').notNull().default({}),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('question_versions_entry_version_unique').on(table.questionbankentryid, table.version)],
);

/** Question usages group attempts for one activity instance (Moodle `question_usages`). */
export const questionUsages = pgTable('question_usages', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  component: text('component').notNull(),
  instanceid: integer('instanceid').notNull().default(0),
  owningcontextid: integer('owningcontextid'),
  preferredbehaviour: text('preferredbehaviour').notNull().default('deferredfeedback'),
  userid: integer('userid'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One attempt at one question inside a usage (Moodle `question_attempts`).
 * questionversionid is PINNED when the attempt starts: later edits of the
 * question (new versions) never change how this attempt is graded.
 * state follows Moodle question_state names.
 */
export const questionAttempts = pgTable(
  'question_attempts',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    questionusageid: integer('questionusageid').notNull().references(() => questionUsages.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    behaviour: text('behaviour').notNull().default('deferredfeedback'),
    questionid: integer('questionid').notNull().references(() => question.id, { onDelete: 'cascade' }),
    questionversionid: integer('questionversionid').references(() => questionVersions.id, { onDelete: 'set null' }),
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
    userid: integer('userid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('question_attempts_usage_slot_unique').on(table.questionusageid, table.slot)],
);

/** Every state transition of an attempt is a step (Moodle `question_attempt_steps`). */
export const questionAttemptSteps = pgTable(
  'question_attempt_steps',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    questionattemptid: integer('questionattemptid').notNull().references(() => questionAttempts.id, { onDelete: 'cascade' }),
    sequencenumber: integer('sequencenumber').notNull(),
    state: text('state').notNull(),
    fraction: doublePrecision('fraction'),
    userid: integer('userid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('question_attempt_steps_attempt_seq_unique').on(table.questionattemptid, table.sequencenumber)],
);

/** Step payload data (Moodle `question_attempt_step_data`): e.g. name='answer', value='true'. */
export const questionAttemptStepData = pgTable(
  'question_attempt_step_data',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    attemptstepid: integer('attemptstepid').notNull().references(() => questionAttemptSteps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [unique('question_attempt_step_data_step_name_unique').on(table.attemptstepid, table.name)],
);
