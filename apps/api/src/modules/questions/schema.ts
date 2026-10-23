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


/**
 * Ngữ liệu dùng chung (stimulus) — thực thể độc lập, KHÔNG thuộc câu hỏi nào:
 * một dòng question_versions tham chiếu qua stimulusid. Nội dung là tài liệu
 * Tiptap (jsonb). Stimulus chia sẻ theo question category/context như ngân
 * hàng câu hỏi: categoryid quyết định phạm vi quyền qua PermissionEvaluator
 * tại context của category; createdby chỉ để truy vết. Khi đã có version
 * tham chiếu thì stimulus bất biến (không sửa/không xoá — tạo stimulus mới).
 */
export const stimuli = pgTable('stimuli', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  categoryid: uuid('categoryid').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
  createdby: uuid('createdby'),
  content: jsonb('content').notNull(),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('stimuli_categoryid_idx').on(table.categoryid),
      index('stimuli_createdby_idx').on(table.createdby),
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
 * Immutable question content versions (Moodle `question_versions` + bản ghi
 * `question` của Moodle). questiontext/generalfeedback là tài liệu Tiptap
 * (jsonb); guidance là cột rich text MỞ RỘNG ngoài chuẩn Moodle (hướng dẫn
 * cho học viên — Moodle không có trường tương đương). Đáp án và options
 * KHÔNG nằm ở đây: chúng tách sang question_answers + bảng options riêng
 * từng qtype như cấu trúc Moodle. stimulusid trỏ tới ngữ liệu dùng chung;
 * đổi ngữ liệu = tạo version mới.
 */
export const questionVersions = pgTable(
  'question_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    questionbankentryid: uuid('questionbankentryid').notNull().references(() => questionBankEntries.id, { onDelete: 'cascade' }),
    questionid: uuid('questionid').notNull().references(() => question.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('ready'),
    questiontext: jsonb('questiontext').notNull().default(sql`'{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb`),
    generalfeedback: jsonb('generalfeedback'),
    guidance: jsonb('guidance'),
    defaultmark: doublePrecision('defaultmark').notNull().default(1),
    penalty: doublePrecision('penalty').notNull().default(0),
    stimulusid: uuid('stimulusid').references(() => stimuli.id, { onDelete: 'set null' }),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('question_versions_questionid_idx').on(table.questionid),
      index('question_versions_stimulusid_idx').on(table.stimulusid),unique('question_versions_entry_version_unique').on(table.questionbankentryid, table.version)],
);

/**
 * Đáp án của một version (Moodle `question_answers` dùng chung mọi qtype):
 * multichoice — mỗi lựa chọn một dòng, fraction là tỷ trọng của lựa chọn;
 * truefalse — đúng 2 dòng (đúng/sai) được question_truefalse trỏ vào;
 * shortanswer — mỗi đáp án mẫu một dòng với fraction riêng, chấm theo thứ tự
 * sortorder (đáp án khớp đầu tiên thắng). answer/feedback là tài liệu Tiptap;
 * fraction là cột số thật (tỷ trọng trong nội bộ câu, KHÔNG phải điểm).
 */
export const questionAnswers = pgTable('question_answers', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionversionid: uuid('questionversionid').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  answer: jsonb('answer').notNull(),
  fraction: doublePrecision('fraction').notNull().default(0),
  feedback: jsonb('feedback'),
  sortorder: integer('sortorder').notNull().default(0),
},
  (table) => [
      index('question_answers_questionversionid_idx').on(table.questionversionid),
  ]);


/** Options của multichoice (Moodle `qtype_multichoice_options`): một dòng cho mỗi version. */
export const qtypeMultichoiceOptions = pgTable('qtype_multichoice_options', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionversionid: uuid('questionversionid').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  single: boolean('single').notNull().default(true),
  shuffleanswers: boolean('shuffleanswers').notNull().default(false),
  answernumbering: text('answernumbering').notNull().default('abc'),
  correctfeedback: jsonb('correctfeedback'),
  partiallycorrectfeedback: jsonb('partiallycorrectfeedback'),
  incorrectfeedback: jsonb('incorrectfeedback'),
  shownumcorrect: boolean('shownumcorrect').notNull().default(false),
  showstandardinstruction: boolean('showstandardinstruction').notNull().default(true),
},
  (table) => [
      unique('qtype_multichoice_options_version_unique').on(table.questionversionid),
  ]);


/** Options của truefalse (Moodle `question_truefalse`): trỏ vào 2 dòng question_answers đúng/sai của version. */
export const questionTruefalse = pgTable('question_truefalse', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionversionid: uuid('questionversionid').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  trueanswer: uuid('trueanswer').notNull().references(() => questionAnswers.id, { onDelete: 'cascade' }),
  falseanswer: uuid('falseanswer').notNull().references(() => questionAnswers.id, { onDelete: 'cascade' }),
  showstandardinstruction: boolean('showstandardinstruction').notNull().default(true),
},
  (table) => [
      index('question_truefalse_trueanswer_idx').on(table.trueanswer),
      index('question_truefalse_falseanswer_idx').on(table.falseanswer),
      unique('question_truefalse_version_unique').on(table.questionversionid),
  ]);


/** Options của shortanswer (Moodle `qtype_shortanswer_options`): chỉ có usecase; đáp án nằm hết ở question_answers. */
export const qtypeShortanswerOptions = pgTable('qtype_shortanswer_options', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionversionid: uuid('questionversionid').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  usecase: boolean('usecase').notNull().default(false),
},
  (table) => [
      unique('qtype_shortanswer_options_version_unique').on(table.questionversionid),
  ]);


/**
 * Options của essay (Moodle `qtype_essay_options`): một dòng cho mỗi version.
 * graderinfo là rich text cho NGƯỜI CHẤM; responsetemplate là khung bài làm
 * mẫu hiện cho học viên lúc bắt đầu. Essay chấm tay: engine đưa attempt về
 * trạng thái needsgrading thay vì tự chấm.
 */
export const qtypeEssayOptions = pgTable('qtype_essay_options', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionversionid: uuid('questionversionid').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  responseformat: text('responseformat').notNull().default('editor'),
  responserequired: boolean('responserequired').notNull().default(true),
  responsefieldlines: integer('responsefieldlines').notNull().default(15),
  minwordlimit: integer('minwordlimit'),
  maxwordlimit: integer('maxwordlimit'),
  graderinfo: jsonb('graderinfo'),
  responsetemplate: jsonb('responsetemplate'),
},
  (table) => [
      unique('qtype_essay_options_version_unique').on(table.questionversionid),
  ]);

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
