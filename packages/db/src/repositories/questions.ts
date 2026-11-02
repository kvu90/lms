import { sql, type RawBuilder } from 'kysely';
import type { CentreDb, CentreTx } from '../client';
import type { LearningOutcomeDoc } from '../curriculum.schema';
import type { Json } from '../types/centre-db';

/**
 * Kho dữ liệu câu hỏi trên Kysely (issue #642, nhóm G2 của chiến
 * dịch chuyển tầng dữ liệu sang Kysely): TOÀN BỘ bề mặt của
 * `QuestionsRepository` cũ ở `apps/api` (Drizzle) được chuyển
 * nguyên vẹn sang đây — category, câu hỏi, entry/version, stimulus,
 * đáp án + options theo dạng câu, usage/attempt/step của engine, và
 * các gắn kết chương trình (môn/YCCĐ) kèm bộ lọc khám phá theo
 * chương trình.
 *
 * Khuôn truy vấn theo đúng pilot kho control plane (issue #640):
 * - Cột đọc khai tường minh kèm bí danh camelCase
 *   (`'bank_id as bankId'`) dùng chung cho select và returning —
 *   KHÔNG bật CamelCasePlugin (một nguồn sự thật là database thật).
 * - Ghi qua hàm ánh xạ Insert/Update loại `undefined` tường minh
 *   từng trường (thử nghiệm T-4): `undefined` = không ghi/không
 *   đổi, `null` = ghi NULL — hai nghĩa không được lẫn.
 * - Mọi ghi jsonb đi qua `jsonbValue` (xâu hoá tường minh +
 *   `::jsonb`); `null` của cột jsonb nullable giữ nguyên là SQL
 *   NULL, không bị xâu hoá thành JSON `null`.
 * - Khoá chính `uuidv7()` do database sinh (phụ lục U của kế
 *   hoạch): insert bỏ qua `id` (trừ khi phía gọi truyền tường
 *   minh) và lấy id qua `returning`.
 * - Điểm mở giao dịch của repository là `transaction(fn)`; các
 *   phương thức nhận handle tuỳ chọn (`QuestionsDb` = handle
 *   thường hoặc handle giao dịch) để phía gọi lồng thao tác vào
 *   giao dịch của mình.
 *
 * Bề mặt kiểu dòng (hàng `*Row` xuất khẩu dưới đây) giữ đúng hình
 * dạng `$inferSelect` của repository cũ để phía tiêu thụ trong
 * module questions không đổi hợp đồng: các cột jsonb nội dung
 * không có `$type<>` ở schema Drizzle được giữ là `unknown` như
 * hợp đồng cũ; `content` của YCCĐ giữ kiểu `LearningOutcomeDoc`
 * theo `$type<>` đã khai.
 *
 * Ngoại lệ chuyển tiếp C-7 (xem CORRECTIONS.md của chiến dịch):
 * repository này VẪN giữ `insertCategory` nhận handle Kysely làm
 * điểm ghi category chuẩn phía Kysely; riêng luồng `buildBank`
 * phía api còn mở giao dịch Drizzle (DL-09) nên tạm ghi category
 * mặc định qua điểm chuyển tiếp ở `QuestionBanksRepository` —
 * điểm đó do PR merge cuối trong ba issue #644/#651/#653 xoá.
 */

/** Handle kho trung tâm mà repository chấp nhận: thường hoặc trong giao dịch. */
export type QuestionsDb = CentreDb | CentreTx;
/** Handle giao dịch kho trung tâm (tham số bắt buộc của các thao tác đa bước). */
export type QuestionsTx = CentreTx;

// ---------------------------------------------------------------------------
// Kiểu dòng đọc (hợp đồng công khai — khớp `$inferSelect` của repository cũ)
// ---------------------------------------------------------------------------

/** Dòng `question_categories`. */
export interface QCategoryRow {
  id: string;
  name: string;
  contextId: string;
  bankId: string | null;
  info: string;
  parent: string | null;
  sortOrder: number;
  stamp: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `question_banks` (chỉ đọc tại đây — ghi bank thuộc repository phía bank). */
export interface QuestionBankRow {
  id: string;
  tenantId: string | null;
  name: string;
  bankKind: string;
  scope: string;
  ownerId: string | null;
  scopeRefId: string | null;
  contextId: string;
  status: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `question`. */
export interface QuestionRow {
  id: string;
  category: string;
  qtype: string;
  createdBy: string | null;
  modifiedBy: string | null;
  derivedFromQuestionId: string | null;
  derivedFromVersionId: string | null;
  derivedFromBankId: string | null;
  originalAuthorId: string | null;
  sourceKind: string | null;
  sourceRef: string | null;
  idnumber: string | null;
  copyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `question_bank_entries`. */
export interface EntryRow {
  id: string;
  questionCategoryId: string;
  questionId: string;
  latestVersion: number;
  status: string;
  withdrawnReason: string | null;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `question_versions` (không có `updated_at` — version bất biến sau khi tạo). */
export interface VersionRow {
  id: string;
  questionBankEntryId: string;
  questionId: string;
  version: number;
  status: string;
  questionText: unknown;
  generalFeedback: unknown;
  defaultMark: number;
  penalty: number;
  stimulusId: string | null;
  createdAt: Date;
}

/** Dòng `stimuli`. */
export interface StimulusRow {
  id: string;
  categoryId: string;
  createdBy: string | null;
  content: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `question_answers`. */
export interface AnswerRow {
  id: string;
  questionVersionId: string;
  answer: unknown;
  isCorrect: boolean;
  feedback: unknown;
  sortOrder: number;
}

/** Dòng `question_answer_keys`. */
export interface AnswerKeyRow {
  id: string;
  questionVersionId: string;
  guidance: unknown;
  solution: unknown;
}

/** Dòng `qtype_multichoice_options`. */
export interface MultichoiceOptionsRow {
  id: string;
  questionVersionId: string;
  shuffleAnswers: boolean;
  answerNumbering: string;
  correctFeedback: unknown;
  incorrectFeedback: unknown;
  showStandardInstruction: boolean;
}

/** Dòng `question_truefalse`. */
export interface TruefalseOptionsRow {
  id: string;
  questionVersionId: string;
  trueAnswer: string;
  falseAnswer: string;
  showStandardInstruction: boolean;
}

/** Dòng `qtype_shortanswer_options`. */
export interface ShortanswerOptionsRow {
  id: string;
  questionVersionId: string;
  useCase: boolean;
  numericAnswer: boolean;
  numericMaxLength: number | null;
  numericAllowSign: boolean;
  numericAllowDecimal: boolean;
}

/** Dòng `qtype_essay_options`. */
export interface EssayOptionsRow {
  id: string;
  questionVersionId: string;
  responseFormat: string;
  responseRequired: boolean;
  responseFieldLines: number;
  minWordLimit: number | null;
  maxWordLimit: number | null;
  graderInfo: unknown;
  responseTemplate: unknown;
}

/** Dòng `question_usages`. */
export interface UsageRow {
  id: string;
  component: string;
  instanceId: string | null;
  owningContextId: string | null;
  preferredBehaviour: string;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `exam_attempts` (điểm nối usage → lượt thi của engine). */
export interface QuizAttemptLinkRow {
  id: string;
  pinId: string;
  userId: string;
  attemptNumber: number;
  usageId: string;
  state: string;
  preview: boolean;
  makeup: boolean;
  appliedSettings: Record<string, unknown> | null;
  timeStart: Date;
  timeFinish: Date | null;
  sumGrades: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `question_attempts`. */
export interface AttemptRow {
  id: string;
  questionUsageId: string;
  slot: number;
  behaviour: string;
  questionId: string;
  questionVersionId: string | null;
  variant: number;
  maxMark: number;
  minFraction: number;
  maxFraction: number;
  flagged: boolean;
  questionSummary: string | null;
  responseSummary: string | null;
  rightAnswer: string | null;
  state: string;
  fraction: number | null;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `question_attempt_steps`. */
export interface StepRow {
  id: string;
  questionAttemptId: string;
  sequenceNumber: number;
  state: string;
  fraction: number | null;
  userId: string | null;
  createdAt: Date;
}

/** Dòng `question_attempt_step_data`. */
export interface StepDataRow {
  id: string;
  attemptStepId: string;
  name: string;
  value: string | null;
}

/** Dòng `question_subjects`. */
export interface QuestionSubjectLinkRow {
  id: string;
  questionId: string;
  subjectId: string;
  createdAt: Date;
}

/** Dòng `question_learning_outcomes`. */
export interface QuestionOutcomeLinkRow {
  id: string;
  questionId: string;
  learningOutcomeId: string;
  cognitiveLevel: string;
  createdAt: Date;
}

/** Dòng `subjects`. */
export interface SubjectRow {
  id: string;
  contextId: string;
  name: string;
  slug: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `learning_outcomes`. */
export interface LearningOutcomeRow {
  id: string;
  tenantId: string | null;
  nodeId: string;
  content: LearningOutcomeDoc;
  position: number;
  sourceKind: string;
  sourceRef: string | null;
  derivedFromId: string | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `curriculum_nodes`. */
export interface CurriculumNodeRow {
  id: string;
  curriculumId: string;
  parentId: string | null;
  title: string;
  kind: string;
  position: number;
  durationPeriods: number | null;
  durationPercent: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `curricula`. */
export interface CurriculumRow {
  id: string;
  subjectId: string;
  grade: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Chuỗi chương trình của một YCCĐ (kết quả `getOutcomeChain`). */
export interface OutcomeChain {
  outcome: LearningOutcomeRow;
  node: CurriculumNodeRow;
  curriculum: CurriculumRow;
  subject: SubjectRow;
}

// ---------------------------------------------------------------------------
// Kiểu giá trị chèn (khớp `$inferInsert` của repository cũ)
// ---------------------------------------------------------------------------

/** Giá trị chèn `question_categories`. */
export interface NewQCategory {
  id?: string;
  name: string;
  contextId: string;
  bankId?: string | null;
  info?: string;
  parent?: string | null;
  sortOrder?: number;
  stamp?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Giá trị chèn `question`. */
export interface NewQuestion {
  id?: string;
  category: string;
  qtype: string;
  createdBy?: string | null;
  modifiedBy?: string | null;
  derivedFromQuestionId?: string | null;
  derivedFromVersionId?: string | null;
  derivedFromBankId?: string | null;
  originalAuthorId?: string | null;
  sourceKind?: string | null;
  sourceRef?: string | null;
  idnumber?: string | null;
  copyCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Giá trị chèn `question_bank_entries`. */
export interface NewEntry {
  id?: string;
  questionCategoryId: string;
  questionId: string;
  latestVersion?: number;
  status?: string;
  withdrawnReason?: string | null;
  withdrawnBy?: string | null;
  withdrawnAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Giá trị chèn `question_versions` (jsonb nội dung giữ `unknown` như hợp đồng cũ). */
export interface NewVersion {
  id?: string;
  questionBankEntryId: string;
  questionId: string;
  version: number;
  status?: string;
  questionText?: unknown;
  generalFeedback?: unknown;
  defaultMark?: number;
  penalty?: number;
  stimulusId?: string | null;
  createdAt?: Date;
}

/** Giá trị chèn `stimuli`. */
export interface NewStimulus {
  id?: string;
  categoryId: string;
  createdBy?: string | null;
  content: unknown;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Giá trị chèn `question_answers`. */
export interface NewAnswer {
  id?: string;
  questionVersionId: string;
  answer: unknown;
  isCorrect?: boolean;
  feedback?: unknown;
  sortOrder?: number;
}

/** Giá trị chèn `question_answer_keys`. */
export interface NewAnswerKey {
  id?: string;
  questionVersionId: string;
  guidance?: unknown;
  solution?: unknown;
}

/** Giá trị chèn `qtype_multichoice_options`. */
export interface NewMultichoiceOptions {
  id?: string;
  questionVersionId: string;
  shuffleAnswers?: boolean;
  answerNumbering?: string;
  correctFeedback?: unknown;
  incorrectFeedback?: unknown;
  showStandardInstruction?: boolean;
}

/** Giá trị chèn `question_truefalse`. */
export interface NewTruefalseOptions {
  id?: string;
  questionVersionId: string;
  trueAnswer: string;
  falseAnswer: string;
  showStandardInstruction?: boolean;
}

/** Giá trị chèn `qtype_shortanswer_options`. */
export interface NewShortanswerOptions {
  id?: string;
  questionVersionId: string;
  useCase?: boolean;
  numericAnswer?: boolean;
  numericMaxLength?: number | null;
  numericAllowSign?: boolean;
  numericAllowDecimal?: boolean;
}

/** Giá trị chèn `qtype_essay_options`. */
export interface NewEssayOptions {
  id?: string;
  questionVersionId: string;
  responseFormat?: string;
  responseRequired?: boolean;
  responseFieldLines?: number;
  minWordLimit?: number | null;
  maxWordLimit?: number | null;
  graderInfo?: unknown;
  responseTemplate?: unknown;
}

/** Giá trị chèn `question_usages`. */
export interface NewUsage {
  id?: string;
  component: string;
  instanceId?: string | null;
  owningContextId?: string | null;
  preferredBehaviour?: string;
  userId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Giá trị chèn `question_attempts`. */
export interface NewAttempt {
  id?: string;
  questionUsageId: string;
  slot: number;
  behaviour?: string;
  questionId: string;
  questionVersionId?: string | null;
  variant?: number;
  maxMark?: number;
  minFraction?: number;
  maxFraction?: number;
  flagged?: boolean;
  questionSummary?: string | null;
  responseSummary?: string | null;
  rightAnswer?: string | null;
  state?: string;
  fraction?: number | null;
  userId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Giá trị chèn `question_attempt_steps` (`state` không có mặc định ở DB nên bắt buộc như `$inferInsert`). */
export interface NewStep {
  id?: string;
  questionAttemptId: string;
  sequenceNumber: number;
  state: string;
  fraction?: number | null;
  userId?: string | null;
  createdAt?: Date;
}

/** Giá trị chèn `question_attempt_step_data`. */
export interface NewStepData {
  id?: string;
  attemptStepId: string;
  name: string;
  value?: string | null;
}

/** Giá trị chèn `question_subjects`. */
export interface NewQuestionSubjectLink {
  id?: string;
  questionId: string;
  subjectId: string;
  createdAt?: Date;
}

/** Giá trị chèn `question_learning_outcomes`. */
export interface NewQuestionOutcomeLink {
  id?: string;
  questionId: string;
  learningOutcomeId: string;
  cognitiveLevel: string;
  createdAt?: Date;
}

// ---------------------------------------------------------------------------
// Danh sách cột đọc: tên cột thật kèm bí danh camelCase, dùng chung cho
// select và returning của từng bảng (khuôn pilot — không CamelCasePlugin).
// ---------------------------------------------------------------------------

const Q_CATEGORY_COLUMNS = [
  'id', 'name', 'context_id as contextId', 'bank_id as bankId', 'info',
  'parent', 'sort_order as sortOrder', 'stamp',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const QUESTION_BANK_COLUMNS = [
  'id', 'tenant_id as tenantId', 'name', 'bank_kind as bankKind', 'scope',
  'owner_id as ownerId', 'scope_ref_id as scopeRefId',
  'context_id as contextId', 'status', 'created_by as createdBy',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const QUESTION_COLUMNS = [
  'id', 'category', 'qtype', 'created_by as createdBy',
  'modified_by as modifiedBy',
  'derived_from_question_id as derivedFromQuestionId',
  'derived_from_version_id as derivedFromVersionId',
  'derived_from_bank_id as derivedFromBankId',
  'original_author_id as originalAuthorId', 'source_kind as sourceKind',
  'source_ref as sourceRef', 'idnumber', 'copy_count as copyCount',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

/** Cột của `question` khi truy vấn qua bí danh `q` (bộ lọc chương trình). */
const QUESTION_COLUMNS_Q = [
  'q.id as id', 'q.category as category', 'q.qtype as qtype',
  'q.created_by as createdBy', 'q.modified_by as modifiedBy',
  'q.derived_from_question_id as derivedFromQuestionId',
  'q.derived_from_version_id as derivedFromVersionId',
  'q.derived_from_bank_id as derivedFromBankId',
  'q.original_author_id as originalAuthorId',
  'q.source_kind as sourceKind', 'q.source_ref as sourceRef',
  'q.idnumber as idnumber', 'q.copy_count as copyCount',
  'q.created_at as createdAt', 'q.updated_at as updatedAt',
] as const;

const ENTRY_COLUMNS = [
  'id', 'question_category_id as questionCategoryId',
  'question_id as questionId', 'latest_version as latestVersion', 'status',
  'withdrawn_reason as withdrawnReason', 'withdrawn_by as withdrawnBy',
  'withdrawn_at as withdrawnAt',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const VERSION_COLUMNS = [
  'id', 'question_bank_entry_id as questionBankEntryId',
  'question_id as questionId', 'version', 'status',
  'question_text as questionText', 'general_feedback as generalFeedback',
  'default_mark as defaultMark', 'penalty', 'stimulus_id as stimulusId',
  'created_at as createdAt',
] as const;

/** Cột của `question_versions` khi truy vấn qua bí danh `v` (nối version mới nhất). */
const VERSION_COLUMNS_V = [
  'v.id as id', 'v.question_bank_entry_id as questionBankEntryId',
  'v.question_id as questionId', 'v.version as version',
  'v.status as status', 'v.question_text as questionText',
  'v.general_feedback as generalFeedback',
  'v.default_mark as defaultMark', 'v.penalty as penalty',
  'v.stimulus_id as stimulusId', 'v.created_at as createdAt',
] as const;

const STIMULUS_COLUMNS = [
  'id', 'category_id as categoryId', 'created_by as createdBy', 'content',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const ANSWER_COLUMNS = [
  'id', 'question_version_id as questionVersionId', 'answer',
  'is_correct as isCorrect', 'feedback', 'sort_order as sortOrder',
] as const;

const ANSWER_KEY_COLUMNS = [
  'id', 'question_version_id as questionVersionId', 'guidance', 'solution',
] as const;

const MULTICHOICE_OPTIONS_COLUMNS = [
  'id', 'question_version_id as questionVersionId',
  'shuffle_answers as shuffleAnswers',
  'answer_numbering as answerNumbering',
  'correct_feedback as correctFeedback',
  'incorrect_feedback as incorrectFeedback',
  'show_standard_instruction as showStandardInstruction',
] as const;

const TRUEFALSE_OPTIONS_COLUMNS = [
  'id', 'question_version_id as questionVersionId',
  'true_answer as trueAnswer', 'false_answer as falseAnswer',
  'show_standard_instruction as showStandardInstruction',
] as const;

const SHORTANSWER_OPTIONS_COLUMNS = [
  'id', 'question_version_id as questionVersionId', 'use_case as useCase',
  'numeric_answer as numericAnswer',
  'numeric_max_length as numericMaxLength',
  'numeric_allow_sign as numericAllowSign',
  'numeric_allow_decimal as numericAllowDecimal',
] as const;

const ESSAY_OPTIONS_COLUMNS = [
  'id', 'question_version_id as questionVersionId',
  'response_format as responseFormat',
  'response_required as responseRequired',
  'response_field_lines as responseFieldLines',
  'min_word_limit as minWordLimit', 'max_word_limit as maxWordLimit',
  'grader_info as graderInfo', 'response_template as responseTemplate',
] as const;

const USAGE_COLUMNS = [
  'id', 'component', 'instance_id as instanceId',
  'owning_context_id as owningContextId',
  'preferred_behaviour as preferredBehaviour', 'user_id as userId',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const QUIZ_ATTEMPT_LINK_COLUMNS = [
  'id', 'pin_id as pinId', 'user_id as userId',
  'attempt_number as attemptNumber', 'usage_id as usageId', 'state',
  'preview', 'makeup', 'applied_settings as appliedSettings',
  'time_start as timeStart', 'time_finish as timeFinish',
  'sum_grades as sumGrades',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const ATTEMPT_COLUMNS = [
  'id', 'question_usage_id as questionUsageId', 'slot', 'behaviour',
  'question_id as questionId',
  'question_version_id as questionVersionId', 'variant',
  'max_mark as maxMark', 'min_fraction as minFraction',
  'max_fraction as maxFraction', 'flagged',
  'question_summary as questionSummary',
  'response_summary as responseSummary', 'right_answer as rightAnswer',
  'state', 'fraction', 'user_id as userId',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const STEP_COLUMNS = [
  'id', 'question_attempt_id as questionAttemptId',
  'sequence_number as sequenceNumber', 'state', 'fraction',
  'user_id as userId', 'created_at as createdAt',
] as const;

const STEP_DATA_COLUMNS = [
  'id', 'attempt_step_id as attemptStepId', 'name', 'value',
] as const;

const QUESTION_SUBJECT_LINK_COLUMNS = [
  'id', 'question_id as questionId', 'subject_id as subjectId',
  'created_at as createdAt',
] as const;

const QUESTION_OUTCOME_LINK_COLUMNS = [
  'id', 'question_id as questionId',
  'learning_outcome_id as learningOutcomeId',
  'cognitive_level as cognitiveLevel', 'created_at as createdAt',
] as const;

const SUBJECT_COLUMNS = [
  'id', 'context_id as contextId', 'name', 'slug', 'position',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const LEARNING_OUTCOME_COLUMNS = [
  'id', 'tenant_id as tenantId', 'node_id as nodeId', 'content',
  'position', 'source_kind as sourceKind', 'source_ref as sourceRef',
  'derived_from_id as derivedFromId', 'retired_at as retiredAt',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const CURRICULUM_NODE_COLUMNS = [
  'id', 'curriculum_id as curriculumId', 'parent_id as parentId',
  'title', 'kind', 'position', 'duration_periods as durationPeriods',
  'duration_percent as durationPercent',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

const CURRICULUM_COLUMNS = [
  'id', 'subject_id as subjectId', 'grade',
  'created_at as createdAt', 'updated_at as updatedAt',
] as const;

// ---------------------------------------------------------------------------
// Ánh xạ ghi: loại `undefined` tường minh từng trường (T-4); cột jsonb
// nullable phân biệt ba trạng thái — `undefined` bỏ qua, `null` ghi SQL
// NULL, giá trị thì xâu hoá qua `jsonbValue`.
// ---------------------------------------------------------------------------

/**
 * Biểu thức tham số jsonb cho một giá trị ghi: xâu hoá tường minh
 * rồi ép `::jsonb`, theo khuôn của tài liệu Kysely (mục
 * `JSONColumnType` ở Getting Started) và của pilot — pg không suy
 * được kiểu tham số khi ghi jsonb, ghi thẳng object sẽ lỗi.
 */
function jsonbValue<T>(value: T): RawBuilder<T> {
  return sql<T>`${JSON.stringify(value)}::jsonb`;
}

/**
 * Ánh xạ phần jsonb nullable cho values/set: giữ ba trạng thái
 * như ghi chú trên. Giá trị phía tiêu thụ là `unknown` (hợp đồng
 * cũ không có `$type<>` cho các cột này) nên ép về kiểu `Json`
 * của codegen tại điểm ghi — đúng kiểu cột mà Kysely kiểm chứng.
 */
function jsonbField(value: unknown): RawBuilder<Json> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return jsonbValue(value as Json);
}

function qCategoryInsertValues(v: NewQCategory) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    name: v.name,
    context_id: v.contextId,
    ...(v.bankId !== undefined ? { bank_id: v.bankId } : {}),
    ...(v.info !== undefined ? { info: v.info } : {}),
    ...(v.parent !== undefined ? { parent: v.parent } : {}),
    ...(v.sortOrder !== undefined ? { sort_order: v.sortOrder } : {}),
    ...(v.stamp !== undefined ? { stamp: v.stamp } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

function questionInsertValues(v: NewQuestion) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    category: v.category,
    qtype: v.qtype,
    ...(v.createdBy !== undefined ? { created_by: v.createdBy } : {}),
    ...(v.modifiedBy !== undefined ? { modified_by: v.modifiedBy } : {}),
    ...(v.derivedFromQuestionId !== undefined ? { derived_from_question_id: v.derivedFromQuestionId } : {}),
    ...(v.derivedFromVersionId !== undefined ? { derived_from_version_id: v.derivedFromVersionId } : {}),
    ...(v.derivedFromBankId !== undefined ? { derived_from_bank_id: v.derivedFromBankId } : {}),
    ...(v.originalAuthorId !== undefined ? { original_author_id: v.originalAuthorId } : {}),
    ...(v.sourceKind !== undefined ? { source_kind: v.sourceKind } : {}),
    ...(v.sourceRef !== undefined ? { source_ref: v.sourceRef } : {}),
    ...(v.idnumber !== undefined ? { idnumber: v.idnumber } : {}),
    ...(v.copyCount !== undefined ? { copy_count: v.copyCount } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

function questionUpdateSet(patch: Partial<QuestionRow>) {
  return {
    ...(patch.category !== undefined ? { category: patch.category } : {}),
    ...(patch.qtype !== undefined ? { qtype: patch.qtype } : {}),
    ...(patch.createdBy !== undefined ? { created_by: patch.createdBy } : {}),
    ...(patch.modifiedBy !== undefined ? { modified_by: patch.modifiedBy } : {}),
    ...(patch.derivedFromQuestionId !== undefined ? { derived_from_question_id: patch.derivedFromQuestionId } : {}),
    ...(patch.derivedFromVersionId !== undefined ? { derived_from_version_id: patch.derivedFromVersionId } : {}),
    ...(patch.derivedFromBankId !== undefined ? { derived_from_bank_id: patch.derivedFromBankId } : {}),
    ...(patch.originalAuthorId !== undefined ? { original_author_id: patch.originalAuthorId } : {}),
    ...(patch.sourceKind !== undefined ? { source_kind: patch.sourceKind } : {}),
    ...(patch.sourceRef !== undefined ? { source_ref: patch.sourceRef } : {}),
    ...(patch.idnumber !== undefined ? { idnumber: patch.idnumber } : {}),
    ...(patch.copyCount !== undefined ? { copy_count: patch.copyCount } : {}),
    updated_at: new Date(),
  };
}

function entryInsertValues(v: NewEntry) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_category_id: v.questionCategoryId,
    question_id: v.questionId,
    ...(v.latestVersion !== undefined ? { latest_version: v.latestVersion } : {}),
    ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.withdrawnReason !== undefined ? { withdrawn_reason: v.withdrawnReason } : {}),
    ...(v.withdrawnBy !== undefined ? { withdrawn_by: v.withdrawnBy } : {}),
    ...(v.withdrawnAt !== undefined ? { withdrawn_at: v.withdrawnAt } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

function entryUpdateSet(patch: Partial<EntryRow>) {
  return {
    ...(patch.questionCategoryId !== undefined ? { question_category_id: patch.questionCategoryId } : {}),
    ...(patch.questionId !== undefined ? { question_id: patch.questionId } : {}),
    ...(patch.latestVersion !== undefined ? { latest_version: patch.latestVersion } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.withdrawnReason !== undefined ? { withdrawn_reason: patch.withdrawnReason } : {}),
    ...(patch.withdrawnBy !== undefined ? { withdrawn_by: patch.withdrawnBy } : {}),
    ...(patch.withdrawnAt !== undefined ? { withdrawn_at: patch.withdrawnAt } : {}),
    updated_at: new Date(),
  };
}

function versionInsertValues(v: NewVersion) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_bank_entry_id: v.questionBankEntryId,
    question_id: v.questionId,
    version: v.version,
    ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.questionText !== undefined ? { question_text: jsonbValue(v.questionText as Json) } : {}),
    ...(v.generalFeedback !== undefined ? { general_feedback: jsonbField(v.generalFeedback) } : {}),
    ...(v.defaultMark !== undefined ? { default_mark: v.defaultMark } : {}),
    ...(v.penalty !== undefined ? { penalty: v.penalty } : {}),
    ...(v.stimulusId !== undefined ? { stimulus_id: v.stimulusId } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
  };
}

function versionUpdateSet(patch: Partial<VersionRow>) {
  // `question_versions` không có cột `updated_at` — patch không tự
  // thêm dấu thời gian như các bảng khác (đúng hợp đồng cũ).
  return {
    ...(patch.questionBankEntryId !== undefined ? { question_bank_entry_id: patch.questionBankEntryId } : {}),
    ...(patch.questionId !== undefined ? { question_id: patch.questionId } : {}),
    ...(patch.version !== undefined ? { version: patch.version } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.questionText !== undefined ? { question_text: jsonbValue(patch.questionText as Json) } : {}),
    ...(patch.generalFeedback !== undefined ? { general_feedback: jsonbField(patch.generalFeedback) } : {}),
    ...(patch.defaultMark !== undefined ? { default_mark: patch.defaultMark } : {}),
    ...(patch.penalty !== undefined ? { penalty: patch.penalty } : {}),
    ...(patch.stimulusId !== undefined ? { stimulus_id: patch.stimulusId } : {}),
  };
}

function stimulusInsertValues(v: NewStimulus) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    category_id: v.categoryId,
    ...(v.createdBy !== undefined ? { created_by: v.createdBy } : {}),
    content: jsonbValue(v.content as Json),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

function stimulusUpdateSet(patch: Partial<StimulusRow>) {
  return {
    ...(patch.categoryId !== undefined ? { category_id: patch.categoryId } : {}),
    ...(patch.createdBy !== undefined ? { created_by: patch.createdBy } : {}),
    ...(patch.content !== undefined ? { content: jsonbValue(patch.content as Json) } : {}),
    updated_at: new Date(),
  };
}

function answerInsertValues(v: NewAnswer) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_version_id: v.questionVersionId,
    answer: jsonbValue(v.answer as Json),
    ...(v.isCorrect !== undefined ? { is_correct: v.isCorrect } : {}),
    ...(v.feedback !== undefined ? { feedback: jsonbField(v.feedback) } : {}),
    ...(v.sortOrder !== undefined ? { sort_order: v.sortOrder } : {}),
  };
}

function answerKeyInsertValues(v: NewAnswerKey) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_version_id: v.questionVersionId,
    ...(v.guidance !== undefined ? { guidance: jsonbField(v.guidance) } : {}),
    ...(v.solution !== undefined ? { solution: jsonbField(v.solution) } : {}),
  };
}

function multichoiceOptionsInsertValues(v: NewMultichoiceOptions) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_version_id: v.questionVersionId,
    ...(v.shuffleAnswers !== undefined ? { shuffle_answers: v.shuffleAnswers } : {}),
    ...(v.answerNumbering !== undefined ? { answer_numbering: v.answerNumbering } : {}),
    ...(v.correctFeedback !== undefined ? { correct_feedback: jsonbField(v.correctFeedback) } : {}),
    ...(v.incorrectFeedback !== undefined ? { incorrect_feedback: jsonbField(v.incorrectFeedback) } : {}),
    ...(v.showStandardInstruction !== undefined ? { show_standard_instruction: v.showStandardInstruction } : {}),
  };
}

function truefalseOptionsInsertValues(v: NewTruefalseOptions) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_version_id: v.questionVersionId,
    true_answer: v.trueAnswer,
    false_answer: v.falseAnswer,
    ...(v.showStandardInstruction !== undefined ? { show_standard_instruction: v.showStandardInstruction } : {}),
  };
}

function shortanswerOptionsInsertValues(v: NewShortanswerOptions) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_version_id: v.questionVersionId,
    ...(v.useCase !== undefined ? { use_case: v.useCase } : {}),
    ...(v.numericAnswer !== undefined ? { numeric_answer: v.numericAnswer } : {}),
    ...(v.numericMaxLength !== undefined ? { numeric_max_length: v.numericMaxLength } : {}),
    ...(v.numericAllowSign !== undefined ? { numeric_allow_sign: v.numericAllowSign } : {}),
    ...(v.numericAllowDecimal !== undefined ? { numeric_allow_decimal: v.numericAllowDecimal } : {}),
  };
}

function essayOptionsInsertValues(v: NewEssayOptions) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_version_id: v.questionVersionId,
    ...(v.responseFormat !== undefined ? { response_format: v.responseFormat } : {}),
    ...(v.responseRequired !== undefined ? { response_required: v.responseRequired } : {}),
    ...(v.responseFieldLines !== undefined ? { response_field_lines: v.responseFieldLines } : {}),
    ...(v.minWordLimit !== undefined ? { min_word_limit: v.minWordLimit } : {}),
    ...(v.maxWordLimit !== undefined ? { max_word_limit: v.maxWordLimit } : {}),
    ...(v.graderInfo !== undefined ? { grader_info: jsonbField(v.graderInfo) } : {}),
    ...(v.responseTemplate !== undefined ? { response_template: jsonbField(v.responseTemplate) } : {}),
  };
}

function usageInsertValues(v: NewUsage) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    component: v.component,
    ...(v.instanceId !== undefined ? { instance_id: v.instanceId } : {}),
    ...(v.owningContextId !== undefined ? { owning_context_id: v.owningContextId } : {}),
    ...(v.preferredBehaviour !== undefined ? { preferred_behaviour: v.preferredBehaviour } : {}),
    ...(v.userId !== undefined ? { user_id: v.userId } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

function attemptInsertValues(v: NewAttempt) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_usage_id: v.questionUsageId,
    slot: v.slot,
    ...(v.behaviour !== undefined ? { behaviour: v.behaviour } : {}),
    question_id: v.questionId,
    ...(v.questionVersionId !== undefined ? { question_version_id: v.questionVersionId } : {}),
    ...(v.variant !== undefined ? { variant: v.variant } : {}),
    ...(v.maxMark !== undefined ? { max_mark: v.maxMark } : {}),
    ...(v.minFraction !== undefined ? { min_fraction: v.minFraction } : {}),
    ...(v.maxFraction !== undefined ? { max_fraction: v.maxFraction } : {}),
    ...(v.flagged !== undefined ? { flagged: v.flagged } : {}),
    ...(v.questionSummary !== undefined ? { question_summary: v.questionSummary } : {}),
    ...(v.responseSummary !== undefined ? { response_summary: v.responseSummary } : {}),
    ...(v.rightAnswer !== undefined ? { right_answer: v.rightAnswer } : {}),
    ...(v.state !== undefined ? { state: v.state } : {}),
    ...(v.fraction !== undefined ? { fraction: v.fraction } : {}),
    ...(v.userId !== undefined ? { user_id: v.userId } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
    ...(v.updatedAt !== undefined ? { updated_at: v.updatedAt } : {}),
  };
}

function attemptUpdateSet(patch: Partial<AttemptRow>) {
  return {
    ...(patch.behaviour !== undefined ? { behaviour: patch.behaviour } : {}),
    ...(patch.questionVersionId !== undefined ? { question_version_id: patch.questionVersionId } : {}),
    ...(patch.variant !== undefined ? { variant: patch.variant } : {}),
    ...(patch.maxMark !== undefined ? { max_mark: patch.maxMark } : {}),
    ...(patch.minFraction !== undefined ? { min_fraction: patch.minFraction } : {}),
    ...(patch.maxFraction !== undefined ? { max_fraction: patch.maxFraction } : {}),
    ...(patch.flagged !== undefined ? { flagged: patch.flagged } : {}),
    ...(patch.questionSummary !== undefined ? { question_summary: patch.questionSummary } : {}),
    ...(patch.responseSummary !== undefined ? { response_summary: patch.responseSummary } : {}),
    ...(patch.rightAnswer !== undefined ? { right_answer: patch.rightAnswer } : {}),
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.fraction !== undefined ? { fraction: patch.fraction } : {}),
    ...(patch.userId !== undefined ? { user_id: patch.userId } : {}),
    updated_at: new Date(),
  };
}

function stepInsertValues(v: NewStep) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_attempt_id: v.questionAttemptId,
    sequence_number: v.sequenceNumber,
    state: v.state,
    ...(v.fraction !== undefined ? { fraction: v.fraction } : {}),
    ...(v.userId !== undefined ? { user_id: v.userId } : {}),
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
  };
}

function stepDataInsertValues(v: NewStepData) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    attempt_step_id: v.attemptStepId,
    name: v.name,
    ...(v.value !== undefined ? { value: v.value } : {}),
  };
}

function questionSubjectLinkInsertValues(v: NewQuestionSubjectLink) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_id: v.questionId,
    subject_id: v.subjectId,
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
  };
}

function questionOutcomeLinkInsertValues(v: NewQuestionOutcomeLink) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    question_id: v.questionId,
    learning_outcome_id: v.learningOutcomeId,
    cognitive_level: v.cognitiveLevel,
    ...(v.createdAt !== undefined ? { created_at: v.createdAt } : {}),
  };
}

/**
 * Repository câu hỏi trên Kysely. Mọi phương thức nhận handle
 * tuỳ chọn: không truyền thì chạy trên handle gốc của repository,
 * truyền handle giao dịch (từ `transaction(fn)` của repository
 * này hoặc của repository Kysely khác cùng kho) thì chạy trong
 * giao dịch đó — đúng khuôn `(tx ?? this.db)` của repository cũ.
 */
export class QuestionsRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Handle gốc của repository (điểm mở giao dịch + truy vấn ngoài giao dịch). */
  db(): CentreDb {
    return this.handle;
  }

  /** Mở giao dịch trên handle gốc và chạy `fn` với handle giao dịch. */
  transaction<T>(fn: (tx: QuestionsTx) => Promise<T>): Promise<T> {
    return this.handle.transaction().execute(fn);
  }

  // --- categories & banks (đọc) ---------------------------------------------

  /**
   * Chèn category mới — điểm ghi category chuẩn phía Kysely.
   * (Luồng `buildBank` phía api còn ở giao dịch Drizzle nên tạm
   * ghi qua điểm chuyển tiếp C-7; xem đầu file.)
   */
  async insertCategory(v: NewQCategory, tx?: QuestionsDb): Promise<QCategoryRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_categories')
      .values(qCategoryInsertValues(v))
      .returning(Q_CATEGORY_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Category theo id. */
  async getCategory(id: string, tx?: QuestionsDb): Promise<QCategoryRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_categories')
      .select(Q_CATEGORY_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Nhiều category theo tập id trong một truy vấn (tập rỗng trả `[]` ngay, không truy vấn). */
  async getCategoriesByIds(ids: string[], tx?: QuestionsDb): Promise<QCategoryRow[]> {
    if (!ids.length) return [];
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_categories')
      .select(Q_CATEGORY_COLUMNS)
      .where('id', 'in', ids)
      .execute();
  }

  /** Bank theo id (chỉ đọc — bank do phía bank sở hữu ghi). */
  async getBankById(id: string, tx?: QuestionsDb): Promise<QuestionBankRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Bank theo context của nó. */
  async getBankByContextId(contextId: string, tx?: QuestionsDb): Promise<QuestionBankRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_banks')
      .select(QUESTION_BANK_COLUMNS)
      .where('context_id', '=', contextId)
      .executeTakeFirst();
  }

  /**
   * Mọi category (hoặc chỉ của một context), sắp xếp tại bộ nhớ
   * theo thời gian tạo rồi id — giữ nguyên cách sắp của repository
   * cũ (không đẩy xuống `ORDER BY`).
   */
  async listCategories(contextId?: string, tx?: QuestionsDb): Promise<QCategoryRow[]> {
    const db = tx ?? this.handle;
    let query = db.selectFrom('question_categories').select(Q_CATEGORY_COLUMNS);
    if (contextId !== undefined) query = query.where('context_id', '=', contextId);
    const rows = await query.execute();
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  // --- questions ---------------------------------------------------------------

  /** Chèn câu hỏi mới. */
  async insertQuestion(v: NewQuestion, tx?: QuestionsDb): Promise<QuestionRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question')
      .values(questionInsertValues(v))
      .returning(QUESTION_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Câu hỏi theo id. */
  async getQuestion(id: string, tx?: QuestionsDb): Promise<QuestionRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question')
      .select(QUESTION_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Nhiều câu hỏi theo tập id trong một truy vấn (tập rỗng trả `[]` ngay). */
  async getQuestionsByIds(ids: string[], tx?: QuestionsDb): Promise<QuestionRow[]> {
    if (!ids.length) return [];
    const db = tx ?? this.handle;
    return db
      .selectFrom('question')
      .select(QUESTION_COLUMNS)
      .where('id', 'in', ids)
      .execute();
  }

  /** Cập nhật câu hỏi theo patch (trường `undefined` giữ nguyên — T-4) + `updated_at` mới. */
  async updateQuestion(id: string, patch: Partial<QuestionRow>): Promise<void> {
    await this.handle
      .updateTable('question')
      .set(questionUpdateSet(patch))
      .where('id', '=', id)
      .execute();
  }

  /** Mọi câu hỏi trong một category, thứ tự id. */
  async listQuestionsInCategory(categoryId: string, tx?: QuestionsDb): Promise<QuestionRow[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question')
      .select(QUESTION_COLUMNS)
      .where('category', '=', categoryId)
      .orderBy('id')
      .execute();
  }

  // --- entries & versions ---------------------------------------------------------

  /** Chèn entry mới. */
  async insertEntry(v: NewEntry, tx?: QuestionsDb): Promise<EntryRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_bank_entries')
      .values(entryInsertValues(v))
      .returning(ENTRY_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Entry của một câu hỏi. */
  async getEntryByQuestion(questionId: string, tx?: QuestionsDb): Promise<EntryRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_bank_entries')
      .select(ENTRY_COLUMNS)
      .where('question_id', '=', questionId)
      .executeTakeFirst();
  }

  /** Entry của nhiều câu hỏi trong một truy vấn (tập rỗng trả `[]` ngay). */
  async getEntriesByQuestionIds(questionIds: string[], tx?: QuestionsDb): Promise<EntryRow[]> {
    if (!questionIds.length) return [];
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_bank_entries')
      .select(ENTRY_COLUMNS)
      .where('question_id', 'in', questionIds)
      .execute();
  }

  /** Cập nhật entry theo patch (trường `undefined` giữ nguyên — T-4) + `updated_at` mới. */
  async updateEntry(id: string, patch: Partial<EntryRow>, tx?: QuestionsDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .updateTable('question_bank_entries')
      .set(entryUpdateSet(patch))
      .where('id', '=', id)
      .execute();
  }

  /**
   * Cập nhật version theo patch (trường `undefined` giữ nguyên —
   * T-4; cột jsonb phân biệt `null` ghi NULL với giá trị xâu hoá).
   * Bảng này không có `updated_at` nên không tự thêm dấu thời gian.
   */
  async updateVersion(id: string, patch: Partial<VersionRow>): Promise<void> {
    await this.handle
      .updateTable('question_versions')
      .set(versionUpdateSet(patch))
      .where('id', '=', id)
      .execute();
  }

  /** Chèn version mới. */
  async insertVersion(v: NewVersion, tx?: QuestionsDb): Promise<VersionRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_versions')
      .values(versionInsertValues(v))
      .returning(VERSION_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Version theo id. */
  async getVersion(id: string, tx?: QuestionsDb): Promise<VersionRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_versions')
      .select(VERSION_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Version theo (entry, số hiệu version). */
  async getVersionByNumber(entryId: string, version: number, tx?: QuestionsDb): Promise<VersionRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_versions')
      .select(VERSION_COLUMNS)
      .where('question_bank_entry_id', '=', entryId)
      .where('version', '=', version)
      .executeTakeFirst();
  }

  /** Mọi version của một entry, thứ tự số hiệu version. */
  async listVersions(entryId: string, tx?: QuestionsDb): Promise<VersionRow[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_versions')
      .select(VERSION_COLUMNS)
      .where('question_bank_entry_id', '=', entryId)
      .orderBy('version')
      .execute();
  }

  /** Mọi version của nhiều entry trong một truy vấn (tập rỗng trả `[]` ngay), thứ tự (entry, version). */
  async listVersionsForEntries(entryIds: string[], tx?: QuestionsDb): Promise<VersionRow[]> {
    if (!entryIds.length) return [];
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_versions')
      .select(VERSION_COLUMNS)
      .where('question_bank_entry_id', 'in', entryIds)
      .orderBy('question_bank_entry_id')
      .orderBy('version')
      .execute();
  }

  // --- stimuli --------------------------------------------------------------------

  /** Chèn stimulus mới. */
  async insertStimulus(v: NewStimulus, tx?: QuestionsDb): Promise<StimulusRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('stimuli')
      .values(stimulusInsertValues(v))
      .returning(STIMULUS_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Stimulus theo id. */
  async getStimulus(id: string, tx?: QuestionsDb): Promise<StimulusRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('stimuli')
      .select(STIMULUS_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Mọi stimulus trong một category. */
  async listStimuliInCategory(categoryId: string, tx?: QuestionsDb): Promise<StimulusRow[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('stimuli')
      .select(STIMULUS_COLUMNS)
      .where('category_id', '=', categoryId)
      .execute();
  }

  /** Cập nhật stimulus theo patch (trường `undefined` giữ nguyên — T-4) + `updated_at` mới. */
  async updateStimulus(id: string, patch: Partial<StimulusRow>): Promise<void> {
    await this.handle
      .updateTable('stimuli')
      .set(stimulusUpdateSet(patch))
      .where('id', '=', id)
      .execute();
  }

  /** Xoá stimulus theo id. */
  async deleteStimulus(id: string): Promise<void> {
    await this.handle.deleteFrom('stimuli').where('id', '=', id).execute();
  }

  /**
   * Số version đang tham chiếu một stimulus — đếm tại bộ nhớ từ
   * danh sách id (giữ nguyên cách đếm của repository cũ, không đổi
   * sang `count(*)` ở database).
   */
  async countVersionsReferencingStimulus(stimulusId: string, tx?: QuestionsDb): Promise<number> {
    const db = tx ?? this.handle;
    const rows = await db
      .selectFrom('question_versions')
      .select('id')
      .where('stimulus_id', '=', stimulusId)
      .execute();
    return rows.length;
  }

  // --- answers & options --------------------------------------------------------------

  /** Chèn một đáp án của version. */
  async insertAnswer(v: NewAnswer, tx?: QuestionsDb): Promise<AnswerRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_answers')
      .values(answerInsertValues(v))
      .returning(ANSWER_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Mọi đáp án của một version, thứ tự (sort_order, id). */
  async listAnswers(versionId: string, tx?: QuestionsDb): Promise<AnswerRow[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_answers')
      .select(ANSWER_COLUMNS)
      .where('question_version_id', '=', versionId)
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
  }

  /** Chèn bản ghi phía đáp án (guidance/solution) của version. */
  async insertAnswerKey(v: NewAnswerKey, tx?: QuestionsDb): Promise<AnswerKeyRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_answer_keys')
      .values(answerKeyInsertValues(v))
      .returning(ANSWER_KEY_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Bản ghi phía đáp án của một version. */
  async getAnswerKey(versionId: string, tx?: QuestionsDb): Promise<AnswerKeyRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_answer_keys')
      .select(ANSWER_KEY_COLUMNS)
      .where('question_version_id', '=', versionId)
      .executeTakeFirst();
  }

  /** Chèn options multichoice của version. */
  async insertMultichoiceOptions(v: NewMultichoiceOptions, tx?: QuestionsDb): Promise<MultichoiceOptionsRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('qtype_multichoice_options')
      .values(multichoiceOptionsInsertValues(v))
      .returning(MULTICHOICE_OPTIONS_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Options multichoice của một version. */
  async getMultichoiceOptions(versionId: string, tx?: QuestionsDb): Promise<MultichoiceOptionsRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('qtype_multichoice_options')
      .select(MULTICHOICE_OPTIONS_COLUMNS)
      .where('question_version_id', '=', versionId)
      .executeTakeFirst();
  }

  /** Chèn options true/false của version. */
  async insertTruefalseOptions(v: NewTruefalseOptions, tx?: QuestionsDb): Promise<TruefalseOptionsRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_truefalse')
      .values(truefalseOptionsInsertValues(v))
      .returning(TRUEFALSE_OPTIONS_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Options true/false của một version. */
  async getTruefalseOptions(versionId: string, tx?: QuestionsDb): Promise<TruefalseOptionsRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('question_truefalse')
      .select(TRUEFALSE_OPTIONS_COLUMNS)
      .where('question_version_id', '=', versionId)
      .executeTakeFirst();
  }

  /** Chèn options shortanswer của version. */
  async insertShortanswerOptions(v: NewShortanswerOptions, tx?: QuestionsDb): Promise<ShortanswerOptionsRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('qtype_shortanswer_options')
      .values(shortanswerOptionsInsertValues(v))
      .returning(SHORTANSWER_OPTIONS_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Options shortanswer của một version. */
  async getShortanswerOptions(versionId: string, tx?: QuestionsDb): Promise<ShortanswerOptionsRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('qtype_shortanswer_options')
      .select(SHORTANSWER_OPTIONS_COLUMNS)
      .where('question_version_id', '=', versionId)
      .executeTakeFirst();
  }

  /** Chèn options essay của version. */
  async insertEssayOptions(v: NewEssayOptions, tx?: QuestionsDb): Promise<EssayOptionsRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('qtype_essay_options')
      .values(essayOptionsInsertValues(v))
      .returning(ESSAY_OPTIONS_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Options essay của một version. */
  async getEssayOptions(versionId: string, tx?: QuestionsDb): Promise<EssayOptionsRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('qtype_essay_options')
      .select(ESSAY_OPTIONS_COLUMNS)
      .where('question_version_id', '=', versionId)
      .executeTakeFirst();
  }

  // --- usages, attempts & steps (engine) -----------------------------------------

  /** Chèn question usage (một lượt sử dụng bộ câu hỏi, vd một lần làm bài quiz). */
  async insertUsage(v: NewUsage): Promise<UsageRow> {
    return this.handle
      .insertInto('question_usages')
      .values(usageInsertValues(v))
      .returning(USAGE_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Usage theo id. */
  async getUsage(id: string): Promise<UsageRow | undefined> {
    return this.handle
      .selectFrom('question_usages')
      .select(USAGE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Nhiều usage theo tập id trong một truy vấn (DL-03, issue
   * #489): bản theo lô của `getUsage`; thứ tự trả về không cam
   * kết, caller tự tra theo id. Tập rỗng trả `[]` ngay.
   */
  async getUsagesByIds(ids: string[]): Promise<UsageRow[]> {
    if (!ids.length) return [];
    return this.handle
      .selectFrom('question_usages')
      .select(USAGE_COLUMNS)
      .where('id', 'in', ids)
      .execute();
  }

  /**
   * Xoá usage (attempts/steps cascade theo khoá ngoại) — dùng khi
   * hoạt động sở hữu usage bị xoá (vd quiz bị xoá kéo theo các
   * lượt làm).
   */
  async deleteUsage(id: string): Promise<void> {
    await this.handle.deleteFrom('question_usages').where('id', '=', id).execute();
  }

  /**
   * Lượt thi (`exam_attempts`) đang gắn với một usage, nếu có —
   * `usage_id` là unique trong `exam_attempts` nên tối đa một
   * dòng. Dùng để cổng kênh HTTP biết usage này thuộc về một lượt
   * thi (issue #60).
   */
  async findQuizAttemptByUsageId(usageId: string): Promise<QuizAttemptLinkRow | undefined> {
    return this.handle
      .selectFrom('exam_attempts')
      .select(QUIZ_ATTEMPT_LINK_COLUMNS)
      .where('usage_id', '=', usageId)
      .executeTakeFirst();
  }

  /** Chèn question attempt (một câu trong một usage). */
  async insertAttempt(v: NewAttempt): Promise<AttemptRow> {
    return this.handle
      .insertInto('question_attempts')
      .values(attemptInsertValues(v))
      .returning(ATTEMPT_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Attempt theo id. */
  async getAttempt(id: string): Promise<AttemptRow | undefined> {
    return this.handle
      .selectFrom('question_attempts')
      .select(ATTEMPT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Các attempt của một usage, thứ tự slot. */
  async listAttempts(usageId: string): Promise<AttemptRow[]> {
    return this.handle
      .selectFrom('question_attempts')
      .select(ATTEMPT_COLUMNS)
      .where('question_usage_id', '=', usageId)
      .orderBy('slot')
      .execute();
  }

  /**
   * Attempt của NHIỀU usage trong một truy vấn (DL-03, issue
   * #489): bản theo lô của `listAttempts`; sắp theo usage rồi
   * theo slot để khi caller gom theo usage, thứ tự attempt trong
   * từng usage vẫn là slot tăng dần như đường đọc lẻ.
   */
  async listAttemptsForUsages(usageIds: string[]): Promise<AttemptRow[]> {
    if (!usageIds.length) return [];
    return this.handle
      .selectFrom('question_attempts')
      .select(ATTEMPT_COLUMNS)
      .where('question_usage_id', 'in', usageIds)
      .orderBy('question_usage_id')
      .orderBy('slot')
      .execute();
  }

  /** Cập nhật attempt theo patch (trường `undefined` giữ nguyên — T-4) + `updated_at` mới. */
  async updateAttempt(id: string, patch: Partial<AttemptRow>): Promise<void> {
    await this.handle
      .updateTable('question_attempts')
      .set(attemptUpdateSet(patch))
      .where('id', '=', id)
      .execute();
  }

  /** Ghi một bước tương tác (step) của attempt. */
  async insertStep(v: NewStep, tx?: QuestionsDb): Promise<StepRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_attempt_steps')
      .values(stepInsertValues(v))
      .returning(STEP_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Các bước của một attempt theo thứ tự số hiệu bước. */
  async listSteps(attemptId: string): Promise<StepRow[]> {
    return this.handle
      .selectFrom('question_attempt_steps')
      .select(STEP_COLUMNS)
      .where('question_attempt_id', '=', attemptId)
      .orderBy('sequence_number')
      .execute();
  }

  /**
   * Các bước của NHIỀU attempt trong một truy vấn (DL-03, issue
   * #489): bản theo lô của `listSteps`; sắp theo attempt rồi theo
   * số thứ tự bước để thứ tự bước trong từng attempt giữ nguyên
   * như đường đọc lẻ khi caller gom lại.
   */
  async listStepsForAttempts(attemptIds: string[]): Promise<StepRow[]> {
    if (!attemptIds.length) return [];
    return this.handle
      .selectFrom('question_attempt_steps')
      .select(STEP_COLUMNS)
      .where('question_attempt_id', 'in', attemptIds)
      .orderBy('question_attempt_id')
      .orderBy('sequence_number')
      .execute();
  }

  /** Ghi dữ kiện của một bước (câu trả lời đã nộp) — không trả dòng. */
  async insertStepData(v: NewStepData, tx?: QuestionsDb): Promise<void> {
    const db = tx ?? this.handle;
    await db.insertInto('question_attempt_step_data').values(stepDataInsertValues(v)).execute();
  }

  /** Dữ kiện bước theo id bước (đường đọc lẻ không sắp xếp). */
  async listStepData(stepId: string): Promise<StepDataRow[]> {
    return this.handle
      .selectFrom('question_attempt_step_data')
      .select(STEP_DATA_COLUMNS)
      .where('attempt_step_id', '=', stepId)
      .execute();
  }

  /**
   * Dữ kiện của NHIỀU bước trong một truy vấn (DL-03, issue
   * #489): bản theo lô của `listStepData`; đường đọc lẻ không sắp
   * xếp nên bản theo lô cũng không sắp — dữ kiện của mỗi bước
   * được gom theo tên ở tầng service, thứ tự dòng không mang
   * nghĩa.
   */
  async listStepDataForSteps(stepIds: string[]): Promise<StepDataRow[]> {
    if (!stepIds.length) return [];
    return this.handle
      .selectFrom('question_attempt_step_data')
      .select(STEP_DATA_COLUMNS)
      .where('attempt_step_id', 'in', stepIds)
      .execute();
  }

  // --- truy vết nhập từ ngân hàng hệ thống ----------------------------------------

  /**
   * Đánh dấu bản nhập từ ngân hàng hệ thống của một câu là
   * `derived` (đã có version do trung tâm tạo thêm) — trước đây
   * tầng service ghi thẳng bằng Drizzle trên handle giao dịch của
   * nó (điểm A3 của kiểm kê #642); nay khép vào repository để
   * module questions không còn lệnh ghi Drizzle nào ngoài
   * repository của chính nó. Chỉ các dòng còn `pristine` mới đổi.
   */
  async markSystemImportDerived(questionId: string, tx: QuestionsDb): Promise<void> {
    await tx
      .updateTable('system_question_imports')
      .set({ kind: 'derived' })
      .where('question_id', '=', questionId)
      .where('kind', '=', 'pristine')
      .execute();
  }

  // --- curriculum links (issue #20 Chặng 2) -----------------------------------
  // Hai bảng nối thuộc module curriculum (question_subjects,
  // question_learning_outcomes) nhưng API gắn kết đặt ở module questions —
  // nơi sở hữu danh tính câu hỏi (mục A.6) — nên repository này truy vấn
  // thẳng các bảng đó cùng chuỗi outcome → node → curriculum → subject.

  /** Môn học theo id (đích gắn kết mức môn). */
  async getSubjectRow(id: string): Promise<SubjectRow | undefined> {
    return this.handle
      .selectFrom('subjects')
      .select(SUBJECT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Chuỗi đầy đủ của một YCCĐ để suy ra môn học sở hữu nó: bốn
   * lần tra tuần tự outcome → node → curriculum → subject, thiếu
   * một mắt xích thì trả `undefined`.
   */
  async getOutcomeChain(id: string): Promise<OutcomeChain | undefined> {
    const outcome = await this.handle
      .selectFrom('learning_outcomes')
      .select(LEARNING_OUTCOME_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!outcome) return undefined;
    const node = await this.handle
      .selectFrom('curriculum_nodes')
      .select(CURRICULUM_NODE_COLUMNS)
      .where('id', '=', outcome.nodeId)
      .executeTakeFirst();
    if (!node) return undefined;
    const curriculum = await this.handle
      .selectFrom('curricula')
      .select(CURRICULUM_COLUMNS)
      .where('id', '=', node.curriculumId)
      .executeTakeFirst();
    if (!curriculum) return undefined;
    const subject = await this.getSubjectRow(curriculum.subjectId);
    if (!subject) return undefined;
    return { outcome, node, curriculum, subject };
  }

  /** Các dòng gắn môn của một câu hỏi, thứ tự tạo. */
  async listQuestionSubjectLinks(questionId: string): Promise<QuestionSubjectLinkRow[]> {
    return this.handle
      .selectFrom('question_subjects')
      .select(QUESTION_SUBJECT_LINK_COLUMNS)
      .where('question_id', '=', questionId)
      .orderBy('created_at')
      .execute();
  }

  /**
   * Các dòng gắn môn của NHIỀU câu hỏi trong một truy vấn (DL-04,
   * issue #489): bản theo lô của `listQuestionSubjectLinks`; sắp
   * theo câu hỏi rồi theo thời điểm tạo để thứ tự dòng gắn trong
   * từng câu hỏi giữ nguyên như đường đọc lẻ khi caller gom lại.
   */
  async listQuestionSubjectLinksForQuestions(questionIds: string[]): Promise<QuestionSubjectLinkRow[]> {
    if (!questionIds.length) return [];
    return this.handle
      .selectFrom('question_subjects')
      .select(QUESTION_SUBJECT_LINK_COLUMNS)
      .where('question_id', 'in', questionIds)
      .orderBy('question_id')
      .orderBy('created_at')
      .execute();
  }

  /** Một dòng gắn môn theo cặp (câu hỏi, môn). */
  async getQuestionSubjectLink(questionId: string, subjectId: string): Promise<QuestionSubjectLinkRow | undefined> {
    return this.handle
      .selectFrom('question_subjects')
      .select(QUESTION_SUBJECT_LINK_COLUMNS)
      .where('question_id', '=', questionId)
      .where('subject_id', '=', subjectId)
      .executeTakeFirst();
  }

  /** Chèn dòng gắn môn. */
  async insertQuestionSubjectLink(v: NewQuestionSubjectLink, tx?: QuestionsDb): Promise<QuestionSubjectLinkRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_subjects')
      .values(questionSubjectLinkInsertValues(v))
      .returning(QUESTION_SUBJECT_LINK_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Xoá dòng gắn môn; trả `true` khi có dòng bị xoá. */
  async deleteQuestionSubjectLink(questionId: string, subjectId: string): Promise<boolean> {
    const rows = await this.handle
      .deleteFrom('question_subjects')
      .where('question_id', '=', questionId)
      .where('subject_id', '=', subjectId)
      .returningAll()
      .execute();
    return rows.length > 0;
  }

  /** Các dòng gắn YCCĐ của một câu hỏi, thứ tự tạo. */
  async listQuestionOutcomeLinks(questionId: string): Promise<QuestionOutcomeLinkRow[]> {
    return this.handle
      .selectFrom('question_learning_outcomes')
      .select(QUESTION_OUTCOME_LINK_COLUMNS)
      .where('question_id', '=', questionId)
      .orderBy('created_at')
      .execute();
  }

  /**
   * Các dòng gắn YCCĐ của NHIỀU câu hỏi trong một truy vấn
   * (DL-04, issue #489): bản theo lô của
   * `listQuestionOutcomeLinks`; sắp theo câu hỏi rồi theo thời
   * điểm tạo như đường đọc lẻ.
   */
  async listQuestionOutcomeLinksForQuestions(questionIds: string[]): Promise<QuestionOutcomeLinkRow[]> {
    if (!questionIds.length) return [];
    return this.handle
      .selectFrom('question_learning_outcomes')
      .select(QUESTION_OUTCOME_LINK_COLUMNS)
      .where('question_id', 'in', questionIds)
      .orderBy('question_id')
      .orderBy('created_at')
      .execute();
  }

  /** Một dòng gắn YCCĐ theo cặp (câu hỏi, YCCĐ). */
  async getQuestionOutcomeLink(questionId: string, outcomeId: string): Promise<QuestionOutcomeLinkRow | undefined> {
    return this.handle
      .selectFrom('question_learning_outcomes')
      .select(QUESTION_OUTCOME_LINK_COLUMNS)
      .where('question_id', '=', questionId)
      .where('learning_outcome_id', '=', outcomeId)
      .executeTakeFirst();
  }

  /** Chèn dòng gắn YCCĐ kèm mức độ nhận thức của cặp. */
  async insertQuestionOutcomeLink(v: NewQuestionOutcomeLink, tx?: QuestionsDb): Promise<QuestionOutcomeLinkRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('question_learning_outcomes')
      .values(questionOutcomeLinkInsertValues(v))
      .returning(QUESTION_OUTCOME_LINK_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Đổi mức độ nhận thức của một dòng gắn YCCĐ (chỉ cột này — bảng nối không có `updated_at`). */
  async updateQuestionOutcomeLink(questionId: string, outcomeId: string, cognitiveLevel: string): Promise<void> {
    await this.handle
      .updateTable('question_learning_outcomes')
      .set({ cognitive_level: cognitiveLevel })
      .where('question_id', '=', questionId)
      .where('learning_outcome_id', '=', outcomeId)
      .execute();
  }

  /** Xoá dòng gắn YCCĐ; trả `true` khi có dòng bị xoá. */
  async deleteQuestionOutcomeLink(questionId: string, outcomeId: string): Promise<boolean> {
    const rows = await this.handle
      .deleteFrom('question_learning_outcomes')
      .where('question_id', '=', questionId)
      .where('learning_outcome_id', '=', outcomeId)
      .returningAll()
      .execute();
    return rows.length > 0;
  }

  // --- nạp theo lô cho view danh sách (issue #488) ---------------------------

  /**
   * Mọi entry của một tập câu hỏi trong MỘT lượt truy vấn — bản
   * theo lô của `getEntryByQuestion` cho loader view danh sách.
   * Entry là duy nhất theo câu hỏi (unique
   * `question_bank_entries_question_unique`).
   */
  async getEntriesByQuestions(questionIds: string[]): Promise<EntryRow[]> {
    if (!questionIds.length) return [];
    return this.handle
      .selectFrom('question_bank_entries')
      .select(ENTRY_COLUMNS)
      .where('question_id', 'in', questionIds)
      .execute();
  }

  /**
   * Version MỚI NHẤT của mỗi entry trong tập — bản theo lô của
   * `getVersionByNumber`: ràng buộc ngay trong SQL bằng phép nối
   * với `question_bank_entries` trên điều kiện số version bằng
   * con trỏ `latestVersion` của chính entry, nên cơ sở dữ liệu
   * chỉ trả đúng dòng version mới nhất của mỗi entry trong tập
   * (cặp entry × số version là duy nhất) thay vì kéo toàn bộ lịch
   * sử version về lọc trong bộ nhớ. Entry thiếu dòng version mới
   * nhất không có dòng nào trong kết quả — phía lắp view giữ
   * nguyên đường lỗi `question.version_missing` như đường đọc
   * đơn.
   */
  async getLatestVersionsByEntries(entries: EntryRow[]): Promise<VersionRow[]> {
    if (!entries.length) return [];
    return this.handle
      .selectFrom('question_versions as v')
      .innerJoin('question_bank_entries as e', (join) =>
        join
          .onRef('v.question_bank_entry_id', '=', 'e.id')
          .onRef('v.version', '=', 'e.latest_version'))
      .select(VERSION_COLUMNS_V)
      .where('e.id', 'in', entries.map((e) => e.id))
      .execute();
  }

  /**
   * Mọi đáp án của một tập version trong một lượt truy vấn, giữ
   * thứ tự hiển thị trong từng version (sortOrder rồi id — cùng
   * thứ tự của `listAnswers`) để phía lắp view nhóm lại theo
   * version không đổi thứ tự đáp án.
   */
  async listAnswersByVersions(versionIds: string[]): Promise<AnswerRow[]> {
    if (!versionIds.length) return [];
    return this.handle
      .selectFrom('question_answers')
      .select(ANSWER_COLUMNS)
      .where('question_version_id', 'in', versionIds)
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
  }

  /** Mọi bản ghi phía đáp án (guidance + solution) của một tập version. */
  async listAnswerKeysByVersions(versionIds: string[]): Promise<AnswerKeyRow[]> {
    if (!versionIds.length) return [];
    return this.handle
      .selectFrom('question_answer_keys')
      .select(ANSWER_KEY_COLUMNS)
      .where('question_version_id', 'in', versionIds)
      .execute();
  }

  /** Mọi options multichoice của một tập version. */
  async listMultichoiceOptionsByVersions(versionIds: string[]): Promise<MultichoiceOptionsRow[]> {
    if (!versionIds.length) return [];
    return this.handle
      .selectFrom('qtype_multichoice_options')
      .select(MULTICHOICE_OPTIONS_COLUMNS)
      .where('question_version_id', 'in', versionIds)
      .execute();
  }

  /** Mọi options shortanswer của một tập version. */
  async listShortanswerOptionsByVersions(versionIds: string[]): Promise<ShortanswerOptionsRow[]> {
    if (!versionIds.length) return [];
    return this.handle
      .selectFrom('qtype_shortanswer_options')
      .select(SHORTANSWER_OPTIONS_COLUMNS)
      .where('question_version_id', 'in', versionIds)
      .execute();
  }

  /** Mọi options essay của một tập version. */
  async listEssayOptionsByVersions(versionIds: string[]): Promise<EssayOptionsRow[]> {
    if (!versionIds.length) return [];
    return this.handle
      .selectFrom('qtype_essay_options')
      .select(ESSAY_OPTIONS_COLUMNS)
      .where('question_version_id', 'in', versionIds)
      .execute();
  }

  /** Mọi stimulus theo một tập id trong một lượt truy vấn. */
  async listStimuliByIds(ids: string[]): Promise<StimulusRow[]> {
    if (!ids.length) return [];
    return this.handle
      .selectFrom('stimuli')
      .select(STIMULUS_COLUMNS)
      .where('id', 'in', ids)
      .execute();
  }

  // --- bộ lọc khám phá theo chương trình -------------------------------------------

  /**
   * Lọc ngân hàng câu hỏi theo gắn kết chương trình (mục A.6):
   * subjectId khớp cả gắn mức môn lẫn YCCĐ thuộc môn đó (môn suy
   * ngược từ YCCĐ); outcomeId + cognitiveLevel phải khớp trên
   * **cùng một dòng nối** khi đi cùng nhau; qtype là dạng của
   * danh tính câu; status là trạng thái của bank entry. Các điều
   * kiện gắn kết giao nhau (AND).
   */
  async filterQuestionsByCurriculumLinks(filter: CurriculumLinkFilter): Promise<QuestionRow[]> {
    const candidateIds = await this.resolveCurriculumCandidateIds(filter);
    if (candidateIds !== null && candidateIds.size === 0) return [];
    let query = this.handle
      .selectFrom('question as q')
      .innerJoin('question_bank_entries as e', 'e.question_id', 'q.id')
      .select(QUESTION_COLUMNS_Q)
      .orderBy('q.created_at');
    // Chuỗi `.where` nối nhau tương đương `and(...)` của repository
    // cũ; từng điều kiện chỉ gắn khi giá trị hiện diện — không bao
    // giờ truyền `undefined` vào `where` (khuôn T-13).
    if (candidateIds !== null) query = query.where('q.id', 'in', [...candidateIds]);
    if (filter.qtype !== undefined) query = query.where('q.qtype', '=', filter.qtype);
    if (filter.status !== undefined) query = query.where('e.status', '=', filter.status);
    return query.execute();
  }

  /**
   * Đếm số câu khớp bộ lọc chương trình, NHÓM THEO category của
   * bank entry, bằng `count(*)` tại SQL (issue #488) — đường đếm
   * cho các nơi chỉ cần số lượng (ứng viên của ô ma trận) thay vì
   * lắp view. Tập ứng viên và điều kiện lọc dùng CHUNG đường phân
   * giải với `filterQuestionsByCurriculumLinks`
   * (resolveCurriculumCandidateIds + cùng phép join question ×
   * entry) nên số đếm luôn khớp đúng tập câu mà đường lọc trả về,
   * chia theo category của entry của từng câu.
   *
   * Ép `::int` tường minh (rủi ro R-G2-1 của đợt chuẩn bị, T-7):
   * `count(*)` của PostgreSQL là int8 — qua pg/Kysely sẽ về dạng
   * `string` và làm trôi kiểu `number` của hợp đồng cũ; ép kiểu
   * tại SQL giữ đúng kiểu runtime của kết quả.
   */
  async countQuestionsByCurriculumFilterPerCategory(
    filter: CurriculumLinkFilter,
  ): Promise<{ categoryId: string; count: number }[]> {
    const candidateIds = await this.resolveCurriculumCandidateIds(filter);
    if (candidateIds !== null && candidateIds.size === 0) return [];
    let query = this.handle
      .selectFrom('question as q')
      .innerJoin('question_bank_entries as e', 'e.question_id', 'q.id')
      .select(['e.question_category_id as categoryId', sql<number>`count(*)::int`.as('count')])
      .groupBy('e.question_category_id');
    if (candidateIds !== null) query = query.where('q.id', 'in', [...candidateIds]);
    if (filter.qtype !== undefined) query = query.where('q.qtype', '=', filter.qtype);
    if (filter.status !== undefined) query = query.where('e.status', '=', filter.status);
    return query.execute();
  }

  /**
   * Phân giải tập id ứng viên theo các điều kiện GẮN KẾT của bộ
   * lọc chương trình (subjectId / outcomeId / nodeId /
   * cognitiveLevel): mỗi điều kiện sinh một tập id, các tập giao
   * nhau trong bộ nhớ (AND). Trả `null` khi bộ lọc không mang
   * điều kiện gắn kết nào — mọi câu đều thuộc diện xét; tập rỗng
   * nghĩa là không câu nào khớp.
   *
   * CẤM gộp các truy vấn phân giải thành một join duy nhất (rủi
   * ro R-G2-2 của đợt chuẩn bị): cấu trúc nhiều select + giao tập
   * trong bộ nhớ là một phần của hợp đồng hành vi — nhánh môn
   * hợp nhất hai đường gắn (mức môn và qua YCCĐ), và điều kiện
   * YCCĐ hiện hành chỉ áp trên các nhánh có join outcome.
   */
  private async resolveCurriculumCandidateIds(filter: CurriculumLinkFilter): Promise<Set<string> | null> {
    // Điều kiện HIỆN HÀNH của dòng YCCĐ trên các nhánh có join
    // outcome (đợt neo lại định danh, issue #161): dòng đã rút
    // (retired_at khác NULL) không còn đưa câu vào diện lọc; dòng
    // derived chỉ hiện hành khi dòng GỐC của nó hiện hành. Cùng
    // một định nghĩa "hiện hành" với bản đặc tả. Nhánh chỉ tra
    // đích danh theo outcomeId (không join outcome) KHÔNG áp điều
    // kiện này — tra theo id phải luôn tìm thấy dòng nối của nó.
    // Tự nối `learning_outcomes` qua bí danh `learning_outcome_root`
    // đóng vai trò dòng gốc.
    const idSets: Set<string>[] = [];
    if (filter.subjectId !== undefined) {
      const viaSubjects = await this.handle
        .selectFrom('question_subjects')
        .select('question_id as questionId')
        .where('subject_id', '=', filter.subjectId)
        .execute();
      const viaOutcomes = await this.handle
        .selectFrom('question_learning_outcomes as qlo')
        .innerJoin('learning_outcomes as lo', 'lo.id', 'qlo.learning_outcome_id')
        .leftJoin('learning_outcomes as learning_outcome_root', 'learning_outcome_root.id', 'lo.derived_from_id')
        .innerJoin('curriculum_nodes as n', 'n.id', 'lo.node_id')
        .innerJoin('curricula as c', 'c.id', 'n.curriculum_id')
        .select('qlo.question_id as questionId')
        .where('c.subject_id', '=', filter.subjectId)
        .where('lo.retired_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('lo.derived_from_id', 'is', null),
            eb('learning_outcome_root.retired_at', 'is', null),
          ]))
        .execute();
      idSets.push(new Set([...viaSubjects.map((r) => r.questionId), ...viaOutcomes.map((r) => r.questionId)]));
    }
    if (filter.outcomeId !== undefined || filter.nodeId !== undefined || filter.cognitiveLevel !== undefined) {
      let rows: { questionId: string }[];
      if (filter.nodeId !== undefined) {
        // Nhánh có nodeId: join outcome + dòng gốc, áp điều kiện
        // hiện hành; nodeId khớp trên `node_id` của chính outcome.
        let query = this.handle
          .selectFrom('question_learning_outcomes as qlo')
          .innerJoin('learning_outcomes as lo', 'lo.id', 'qlo.learning_outcome_id')
          .leftJoin('learning_outcomes as learning_outcome_root', 'learning_outcome_root.id', 'lo.derived_from_id')
          .select('qlo.question_id as questionId')
          .where('lo.node_id', '=', filter.nodeId)
          .where('lo.retired_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('lo.derived_from_id', 'is', null),
              eb('learning_outcome_root.retired_at', 'is', null),
            ]));
        if (filter.outcomeId !== undefined) query = query.where('qlo.learning_outcome_id', '=', filter.outcomeId);
        if (filter.cognitiveLevel !== undefined) query = query.where('qlo.cognitive_level', '=', filter.cognitiveLevel);
        rows = await query.execute();
      } else {
        // Nhánh không nodeId: tra thẳng trên bảng nối, không join
        // outcome, không áp điều kiện hiện hành (xem ghi chú đầu
        // phương thức).
        let query = this.handle
          .selectFrom('question_learning_outcomes')
          .select('question_id as questionId');
        if (filter.outcomeId !== undefined) query = query.where('learning_outcome_id', '=', filter.outcomeId);
        if (filter.cognitiveLevel !== undefined) query = query.where('cognitive_level', '=', filter.cognitiveLevel);
        rows = await query.execute();
      }
      idSets.push(new Set(rows.map((r) => r.questionId)));
    }
    let candidateIds: Set<string> | null = null;
    for (const set of idSets) {
      if (candidateIds === null) {
        candidateIds = set;
        continue;
      }
      const current: Set<string> = candidateIds;
      candidateIds = new Set([...current].filter((id) => set.has(id)));
    }
    return candidateIds;
  }
}

/** Điều kiện của bộ lọc khám phá theo chương trình (mục A.6). */
interface CurriculumLinkFilter {
  subjectId?: string;
  outcomeId?: string;
  nodeId?: string;
  cognitiveLevel?: string;
  qtype?: string;
  status?: string;
}
