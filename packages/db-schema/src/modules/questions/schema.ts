/** Các bảng của bounded context Questions — định nghĩa Drizzle do module questions sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from '../tenants/schema';

/**
 * Bảng BANK ĐA LOẠI dùng chung của hệ thống (giữ tên vật lý
 * `question_banks` vì toàn bộ bề mặt QB đã quanh tên này — xem ghi nhận
 * trên issue #70): mỗi dòng là một bank của MỘT loại món theo `bank_kind`
 * (question / exam / matrix — research ngân hàng đề/ma trận điểm E-1/A.3)
 * tại MỘT scope. Lớp bank nằm TRÊN category/context hiện hữu: mỗi bank
 * sở hữu một context riêng (context_id) để tái dùng nguyên
 * PermissionEvaluator + capability tại context của bank; category câu
 * hỏi thuộc bank qua `question_categories.bank_id`, context của
 * category thuộc bank chính là context của bank. Bốn scope: personal
 * (owner_id = chủ sở hữu), team (scope_ref_id = cohort tổ chuyên môn,
 * owner_id = tổ trưởng), school (scope_ref_id null — bank trường duy
 * nhất cho mỗi kind), course (scope_ref_id = course id; context của
 * bank là con của context khoá nên quyền tại khoá thừa hưởng xuống bank
 * theo cây context). Ràng buộc duy nhất theo (scope, kind): mỗi chủ thể
 * có đúng một bank cho mỗi loại món.
 *
 * TENANT-0 (#168): bank mang `tenant_id` của tenant sở hữu; RIÊNG scope
 * `platform` (Ngân hàng hệ thống — câu hỏi/đề/ma trận CHUNG của Trang
 * chính) có `tenant_id = NULL`, chỉ platform được ghi, mọi tenant được
 * đọc/copy xuống. Bank trường duy nhất được hiểu lại là duy nhất **theo
 * tenant** (unique một phần (tenant_id, scope, kind) khi scope='school').
 */
export const questionBanks = pgTable('question_banks', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  /** NULL chỉ khi scope = 'platform' (ràng buộc check bên dưới). */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  /** Loại món của bank: question | exam | matrix (mặc định question — toàn bộ hành vi QB-1..4). */
  bankKind: text('bank_kind').notNull().default('question'),
  scope: text('scope').notNull(),
  ownerId: uuid('owner_id'),
  scopeRefId: uuid('scope_ref_id'),
  contextId: uuid('context_id').notNull(),
  status: text('status').notNull().default('active'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('question_banks_scope_idx').on(table.scope),
      index('question_banks_kind_idx').on(table.bankKind),
      index('question_banks_owner_id_idx').on(table.ownerId),
      index('question_banks_scope_ref_id_idx').on(table.scopeRefId),
      index('question_banks_tenant_id_idx').on(table.tenantId),
      uniqueIndex('question_banks_personal_owner_kind_unique').on(table.ownerId, table.bankKind).where(sql`scope = 'personal'`),
      uniqueIndex('question_banks_scope_ref_kind_unique').on(table.scope, table.scopeRefId, table.bankKind).where(sql`scope_ref_id is not null`),
      uniqueIndex('question_banks_school_kind_unique').on(table.tenantId, table.scope, table.bankKind).where(sql`scope = 'school'`),
      uniqueIndex('question_banks_platform_kind_unique').on(table.scope, table.bankKind).where(sql`scope = 'platform'`),
      check('question_banks_tenant_scope_check', sql`${table.tenantId} is not null or ${table.scope} = 'platform'`),
  ]);

/** Question categories live in a context (Moodle `question_categories`). */
export const questionCategories = pgTable('question_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  contextId: uuid('context_id').notNull(),
  /** Bank sở hữu category (feat Ngân hàng câu hỏi chung, QB-1); null với category cũ chưa gán bank — bank mặc định được suy từ context khi cần. */
  bankId: uuid('bank_id').references(() => questionBanks.id, { onDelete: 'set null' }),
  info: text('info').notNull().default(''),
  parent: uuid('parent'),
  sortOrder: integer('sort_order').notNull().default(0),
  stamp: text('stamp').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('question_categories_context_id_idx').on(table.contextId),
      index('question_categories_parent_idx').on(table.parent),
      index('question_categories_bank_id_idx').on(table.bankId),
  ]);


/**
 * Ngữ liệu dùng chung (stimulus) — thực thể độc lập, KHÔNG thuộc câu hỏi nào:
 * một dòng question_versions tham chiếu qua stimulus_id. Nội dung là tài liệu
 * Tiptap (jsonb). Stimulus chia sẻ theo question category/context như ngân
 * hàng câu hỏi: category_id quyết định phạm vi quyền qua PermissionEvaluator
 * tại context của category; created_by chỉ để truy vết. Khi đã có version
 * tham chiếu thì stimulus bất biến (không sửa/không xoá — tạo stimulus mới).
 */
export const stimuli = pgTable('stimuli', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  categoryId: uuid('category_id').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by'),
  content: jsonb('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('stimuli_category_id_idx').on(table.categoryId),
      index('stimuli_created_by_idx').on(table.createdBy),
  ]);


/** Question identity (Moodle `question`): stable across versions; content lives in question_versions. */
export const question = pgTable('question', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  category: uuid('category').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
  qtype: text('qtype').notNull(),
  name: text('name').notNull(),
  createdBy: uuid('created_by'),
  modifiedBy: uuid('modified_by'),
  /**
   * Truy vết nguồn gốc khi câu là bản copy (feat Ngân hàng câu hỏi chung,
   * QB-2): câu nguồn + version nguồn đã copy + bank nguồn + tác giả gốc
   * (giữ nguyên qua các đời copy — ghi công không tắt được). Các cột là
   * con trỏ truy vết (không FK cứng) như các con trỏ xuyên module khác.
   * `idnumber` là mã định danh tuỳ chọn của câu TRONG bank (Moodle
   * question.idnumber) phục vụ đối soát/chống trùng ở QB-4.
   */
  derivedFromQuestionId: uuid('derived_from_question_id'),
  derivedFromVersionId: uuid('derived_from_version_id'),
  derivedFromBankId: uuid('derived_from_bank_id'),
  originalAuthorId: uuid('original_author_id'),
  /**
   * Nguồn gốc NGOÀI hệ thống của câu hỏi (ghi nhận thiết kế 24/10/2026):
   * cặp (source_kind, source_ref) theo mẫu truy vết của dữ liệu chương
   * trình — source_kind ∈ book (sách, thực thể `books` độc lập) / exam
   * (đề thi, thực thể exam_papers ở lát EB-1) / manual (giáo viên tự
   * soạn, mặc định khi tạo câu) / import (nạp từ ngoài); source_ref là
   * tham chiếu dạng chữ (id sách/đề hoặc tham chiếu ngoài) — KHÔNG FK
   * cứng và KHÔNG khoá vào bank nội bộ, để gắn book/exam sau này không
   * cần di trú. Khác derived_from_* (chuỗi copy TRONG hệ bank): nguồn
   * ngoài được KẾ THỪA nguyên qua các đời copy.
   * QUY TẮC BẢN QUYỀN (Lão gia chốt 22:58 24/10/2026): cặp trường này
   * chỉ để TRUY VẾT NỘI BỘ phía server/quản trị — bề mặt học viên
   * (attempt/usage/quiz attempt) KHÔNG BAO GIỜ trả chúng; việc hiện
   * nguồn công khai sau này quyết bởi cờ của SÁCH (theo sách, không
   * theo câu; mặc định tắt), không phải bởi dữ liệu ở đây.
   */
  sourceKind: text('source_kind'),
  sourceRef: text('source_ref'),
  idnumber: text('idnumber'),
  /** Số lượt câu này đã được copy đi (tín hiệu QB-4; use_count tính trực tiếp từ quiz_slots khi hiển thị). */
  copyCount: integer('copy_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('question_category_idx').on(table.category),
      index('question_created_by_idx').on(table.createdBy),
      index('question_modified_by_idx').on(table.modifiedBy),
      index('question_derived_from_idx').on(table.derivedFromQuestionId),
  ]);


/**
 * Bank entries (Moodle `question_bank_entries`) link a question identity to a
 * category and track the latest version number. Editing a question creates a
 * NEW question_versions row and bumps latest_version; attempts already started
 * keep pointing at the version they pinned.
 */
export const questionBankEntries = pgTable(
  'question_bank_entries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    questionCategoryId: uuid('question_category_id').notNull().references(() => questionCategories.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id').notNull().references(() => question.id, { onDelete: 'cascade' }),
    latestVersion: integer('latest_version').notNull().default(1),
    /** Trạng thái hiển thị của câu trong bank: draft / ready / hidden. hidden = đã rút (QB-3): mất khỏi khám phá + không thêm mới vào đề, version đã ghim vẫn phục vụ đề hiện hữu. */
    status: text('status').notNull().default('ready'),
    /** Truy vết lần rút câu gần nhất (QB-3): lý do bắt buộc + người rút + thời điểm. */
    withdrawnReason: text('withdrawn_reason'),
    withdrawnBy: uuid('withdrawn_by'),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('question_bank_entries_question_category_id_idx').on(table.questionCategoryId),unique('question_bank_entries_question_unique').on(table.questionId)],
);

/**
 * Đề xuất đóng góp câu hỏi vào bank chung (feat Ngân hàng câu hỏi chung,
 * QB-4): một dòng = một đề xuất của một giáo viên đưa câu của mình (ở bank
 * nguồn) vào bank đích (tổ/trường/khoá). `mode` = 'new' (câu mới — duyệt
 * đạt thì COPY vào bank đích bằng cơ chế QB-2) hoặc 'update' (đề xuất bản
 * mới cho câu đã có ở bank đích qua liên kết derived_from — duyệt đạt thì
 * tạo version mới trên chính danh tính câu đích). Chống trùng: content_hash
 * của version nguồn tại thời điểm đề xuất + near_duplicate_of trỏ câu gần
 * trùng trong bank đích để người duyệt cân nhắc.
 */
export const questionBankContributions = pgTable('question_bank_contributions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionId: uuid('question_id').notNull().references(() => question.id, { onDelete: 'cascade' }),
  targetBankId: uuid('target_bank_id').notNull().references(() => questionBanks.id, { onDelete: 'cascade' }),
  targetQuestionId: uuid('target_question_id'),
  proposerId: uuid('proposer_id').notNull(),
  note: text('note').notNull().default(''),
  mode: text('mode').notNull().default('new'),
  status: text('status').notNull().default('pending'),
  contentHash: text('content_hash').notNull().default(''),
  nearDuplicateOf: uuid('near_duplicate_of'),
  rejectReason: text('reject_reason'),
  reviewerId: uuid('reviewer_id'),
  resultQuestionId: uuid('result_question_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('question_bank_contributions_target_bank_idx').on(table.targetBankId),
      index('question_bank_contributions_question_idx').on(table.questionId),
      index('question_bank_contributions_proposer_idx').on(table.proposerId),
      index('question_bank_contributions_status_idx').on(table.status),
  ]);

/**
 * Immutable question content versions (Moodle `question_versions` + bản ghi
 * `question` của Moodle). question_text/general_feedback là tài liệu Tiptap
 * (jsonb); guidance là cột rich text MỞ RỘNG ngoài chuẩn Moodle (hướng dẫn
 * cho học viên — Moodle không có trường tương đương). Đáp án và options
 * KHÔNG nằm ở đây: chúng tách sang question_answers + bảng options riêng
 * từng qtype như cấu trúc Moodle. stimulus_id trỏ tới ngữ liệu dùng chung;
 * đổi ngữ liệu = tạo version mới.
 */
export const questionVersions = pgTable(
  'question_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    questionBankEntryId: uuid('question_bank_entry_id').notNull().references(() => questionBankEntries.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id').notNull().references(() => question.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('ready'),
    questionText: jsonb('question_text').notNull().default(sql`'{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb`),
    generalFeedback: jsonb('general_feedback'),
    guidance: jsonb('guidance'),
    defaultMark: doublePrecision('default_mark').notNull().default(1),
    penalty: doublePrecision('penalty').notNull().default(0),
    stimulusId: uuid('stimulus_id').references(() => stimuli.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('question_versions_question_id_idx').on(table.questionId),
      index('question_versions_stimulus_id_idx').on(table.stimulusId),unique('question_versions_entry_version_unique').on(table.questionBankEntryId, table.version)],
);

/**
 * Đáp án của một version (Moodle `question_answers` dùng chung mọi qtype):
 * multichoice — mỗi lựa chọn một dòng, fraction là tỷ trọng của lựa chọn;
 * truefalse — đúng 2 dòng (đúng/sai) được question_truefalse trỏ vào;
 * shortanswer — mỗi đáp án mẫu một dòng với fraction riêng, chấm theo thứ tự
 * sort_order (đáp án khớp đầu tiên thắng). answer/feedback là tài liệu Tiptap;
 * fraction là cột số thật (tỷ trọng trong nội bộ câu, KHÔNG phải điểm).
 */
export const questionAnswers = pgTable('question_answers', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionVersionId: uuid('question_version_id').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  answer: jsonb('answer').notNull(),
  fraction: doublePrecision('fraction').notNull().default(0),
  feedback: jsonb('feedback'),
  sortOrder: integer('sort_order').notNull().default(0),
},
  (table) => [
      index('question_answers_question_version_id_idx').on(table.questionVersionId),
  ]);


/** Options của multichoice (Moodle `qtype_multichoice_options`): một dòng cho mỗi version. */
export const qtypeMultichoiceOptions = pgTable('qtype_multichoice_options', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionVersionId: uuid('question_version_id').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  single: boolean('single').notNull().default(true),
  shuffleAnswers: boolean('shuffle_answers').notNull().default(false),
  answerNumbering: text('answer_numbering').notNull().default('abc'),
  correctFeedback: jsonb('correct_feedback'),
  partiallyCorrectFeedback: jsonb('partially_correct_feedback'),
  incorrectFeedback: jsonb('incorrect_feedback'),
  showNumCorrect: boolean('show_num_correct').notNull().default(false),
  showStandardInstruction: boolean('show_standard_instruction').notNull().default(true),
},
  (table) => [
      unique('qtype_multichoice_options_version_unique').on(table.questionVersionId),
  ]);


/** Options của truefalse (Moodle `question_truefalse`): trỏ vào 2 dòng question_answers đúng/sai của version. */
export const questionTruefalse = pgTable('question_truefalse', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionVersionId: uuid('question_version_id').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  trueAnswer: uuid('true_answer').notNull().references(() => questionAnswers.id, { onDelete: 'cascade' }),
  falseAnswer: uuid('false_answer').notNull().references(() => questionAnswers.id, { onDelete: 'cascade' }),
  showStandardInstruction: boolean('show_standard_instruction').notNull().default(true),
},
  (table) => [
      index('question_truefalse_true_answer_idx').on(table.trueAnswer),
      index('question_truefalse_false_answer_idx').on(table.falseAnswer),
      unique('question_truefalse_version_unique').on(table.questionVersionId),
  ]);


/**
 * Options của shortanswer (Moodle `qtype_shortanswer_options`): use_case
 * của Moodle; đáp án nằm hết ở question_answers. Bốn cột numeric_* là
 * chế độ đáp án số kiểu thi tốt nghiệp (điểm 6.3.3 đã chốt trên issue
 * #30): cờ cấu hình MẶC ĐỊNH TẮT — tắt thì ngữ nghĩa Moodle nguyên vẹn,
 * bật thì engine ràng buộc đáp án là một số trong độ dài/bộ ký tự cấu
 * hình trước khi so khớp mẫu.
 */
export const qtypeShortanswerOptions = pgTable('qtype_shortanswer_options', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionVersionId: uuid('question_version_id').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  useCase: boolean('use_case').notNull().default(false),
  numericAnswer: boolean('numeric_answer').notNull().default(false),
  numericMaxLength: integer('numeric_max_length'),
  numericAllowSign: boolean('numeric_allow_sign').notNull().default(true),
  numericAllowDecimal: boolean('numeric_allow_decimal').notNull().default(true),
},
  (table) => [
      unique('qtype_shortanswer_options_version_unique').on(table.questionVersionId),
  ]);


/**
 * Options của essay (Moodle `qtype_essay_options`): một dòng cho mỗi version.
 * grader_info là rich text cho NGƯỜI CHẤM; response_template là khung bài làm
 * mẫu hiện cho học viên lúc bắt đầu. Essay chấm tay: engine đưa attempt về
 * trạng thái needsgrading thay vì tự chấm.
 */
export const qtypeEssayOptions = pgTable('qtype_essay_options', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  questionVersionId: uuid('question_version_id').notNull().references(() => questionVersions.id, { onDelete: 'cascade' }),
  responseFormat: text('response_format').notNull().default('editor'),
  responseRequired: boolean('response_required').notNull().default(true),
  responseFieldLines: integer('response_field_lines').notNull().default(15),
  minWordLimit: integer('min_word_limit'),
  maxWordLimit: integer('max_word_limit'),
  graderInfo: jsonb('grader_info'),
  responseTemplate: jsonb('response_template'),
},
  (table) => [
      unique('qtype_essay_options_version_unique').on(table.questionVersionId),
  ]);

/** Question usages group attempts for one activity instance (Moodle `question_usages`). */
export const questionUsages = pgTable('question_usages', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  component: text('component').notNull(),
  instanceId: uuid('instance_id'),
  owningContextId: uuid('owning_context_id'),
  preferredBehaviour: text('preferred_behaviour').notNull().default('deferredfeedback'),
  userId: uuid('user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('question_usages_instance_id_idx').on(table.instanceId),
      index('question_usages_owning_context_id_idx').on(table.owningContextId),
      index('question_usages_user_id_idx').on(table.userId),
  ]);


/**
 * One attempt at one question inside a usage (Moodle `question_attempts`).
 * question_version_id is PINNED when the attempt starts: later edits of the
 * question (new versions) never change how this attempt is graded.
 * state follows Moodle question_state names.
 */
export const questionAttempts = pgTable(
  'question_attempts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    questionUsageId: uuid('question_usage_id').notNull().references(() => questionUsages.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    behaviour: text('behaviour').notNull().default('deferredfeedback'),
    questionId: uuid('question_id').notNull().references(() => question.id, { onDelete: 'cascade' }),
    questionVersionId: uuid('question_version_id').references(() => questionVersions.id, { onDelete: 'set null' }),
    variant: integer('variant').notNull().default(1),
    maxMark: doublePrecision('max_mark').notNull().default(1),
    minFraction: doublePrecision('min_fraction').notNull().default(0),
    maxFraction: doublePrecision('max_fraction').notNull().default(1),
    flagged: boolean('flagged').notNull().default(false),
    questionSummary: text('question_summary'),
    responseSummary: text('response_summary'),
    rightAnswer: text('right_answer'),
    state: text('state').notNull().default('notstarted'),
    fraction: doublePrecision('fraction'),
    userId: uuid('user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('question_attempts_question_id_idx').on(table.questionId),
      index('question_attempts_question_version_id_idx').on(table.questionVersionId),
      index('question_attempts_user_id_idx').on(table.userId),unique('question_attempts_usage_slot_unique').on(table.questionUsageId, table.slot)],
);

/** Every state transition of an attempt is a step (Moodle `question_attempt_steps`). */
export const questionAttemptSteps = pgTable(
  'question_attempt_steps',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    questionAttemptId: uuid('question_attempt_id').notNull().references(() => questionAttempts.id, { onDelete: 'cascade' }),
    sequenceNumber: integer('sequence_number').notNull(),
    state: text('state').notNull(),
    fraction: doublePrecision('fraction'),
    userId: uuid('user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('question_attempt_steps_user_id_idx').on(table.userId),unique('question_attempt_steps_attempt_seq_unique').on(table.questionAttemptId, table.sequenceNumber)],
);

/** Step payload data (Moodle `question_attempt_step_data`): e.g. name='answer', value='true'. */
export const questionAttemptStepData = pgTable(
  'question_attempt_step_data',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    attemptStepId: uuid('attempt_step_id').notNull().references(() => questionAttemptSteps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [unique('question_attempt_step_data_step_name_unique').on(table.attemptStepId, table.name)],
);
