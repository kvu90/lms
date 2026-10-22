import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/** Assessment contracts — the single shape source between api and web for grades & questions. */

export const AGGREGATIONS = [
  'natural', 'mean', 'weightedmean', 'simpleweightedmean', 'median', 'lowest', 'highest', 'mode', 'sum',
] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const gradeCategorySchema = z.object({
  id: uuidIdSchema,
  courseid: uuidIdSchema,
  parent: uuidIdSchema.nullable(),
  fullname: z.string(),
  aggregation: z.string(),
  droplow: z.number().int(),
  keephigh: z.number().int(),
  aggregateonlygraded: z.boolean(),
  depth: z.number().int(),
  path: z.string(),
  hidden: z.boolean(),
});
export type GradeCategory = z.infer<typeof gradeCategorySchema>;

export const gradeItemSchema = z.object({
  id: uuidIdSchema,
  courseid: uuidIdSchema,
  categoryid: uuidIdSchema.nullable(),
  itemname: z.string(),
  itemtype: z.string(),
  itemmodule: z.string().nullable(),
  iteminstance: uuidIdSchema.nullable(),
  grademax: z.number(),
  grademin: z.number(),
  gradepass: z.number(),
  weightoverride: z.boolean(),
  aggregationcoef: z.number(),
  extracredit: z.boolean(),
  multiplicator: z.number(),
  plusfactor: z.number(),
  hidden: z.boolean(),
  locked: z.boolean(),
});
export type GradeItem = z.infer<typeof gradeItemSchema>;

export const gradeGradeSchema = z.object({
  id: uuidIdSchema,
  itemid: uuidIdSchema,
  userid: uuidIdSchema,
  rawgrade: z.number().nullable(),
  finalgrade: z.number().nullable(),
  hidden: z.boolean(),
  locked: z.boolean(),
  overridden: z.boolean(),
  excluded: z.boolean(),
  frozen: z.boolean(),
  feedback: z.string().nullable(),
  aggregationweight: z.number().nullable(),
  letter: z.string().nullable(),
});
export type GradeGrade = z.infer<typeof gradeGradeSchema>;

export const gradebookItemViewSchema = z.object({
  item: gradeItemSchema,
  grade: gradeGradeSchema.nullable(),
});
export type GradebookItemView = z.infer<typeof gradebookItemViewSchema>;

export interface GradebookCategoryView {
  category: GradeCategory;
  total: GradebookItemView | null;
  items: GradebookItemView[];
  children: GradebookCategoryView[];
}
export const gradebookCategoryViewSchema: z.ZodType<GradebookCategoryView> = z.object({
  category: gradeCategorySchema,
  total: gradebookItemViewSchema.nullable(),
  items: z.array(gradebookItemViewSchema),
  children: z.lazy(() => z.array(gradebookCategoryViewSchema)),
});
export const gradebookSchema = z.object({
  courseId: uuidIdSchema,
  userId: uuidIdSchema,
  categories: z.array(gradebookCategoryViewSchema),
  courseTotal: gradebookItemViewSchema.nullable(),
});
export type Gradebook = z.infer<typeof gradebookSchema>;

export const gradeLetterSchema = z.object({
  id: uuidIdSchema,
  contextid: uuidIdSchema,
  lowerboundary: z.number(),
  letter: z.string(),
});
export type GradeLetter = z.infer<typeof gradeLetterSchema>;

export const gradeReportSchema = z.object({
  courseId: uuidIdSchema,
  rows: z.array(z.object({
    userId: uuidIdSchema,
    finalgrade: z.number().nullable(),
    letter: z.string().nullable(),
  })),
});
export type GradeReport = z.infer<typeof gradeReportSchema>;

// --- Questions ---------------------------------------------------------------

export const questionCategorySchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  contextid: uuidIdSchema,
  info: z.string(),
  parent: uuidIdSchema.nullable(),
});
export type QuestionCategory = z.infer<typeof questionCategorySchema>;

export const questionVersionSchema = z.object({
  id: uuidIdSchema,
  questionbankentryid: uuidIdSchema,
  questionid: uuidIdSchema,
  version: z.number().int(),
  questiontext: z.string(),
  defaultmark: z.number(),
  answerdata: z.record(z.string(), z.unknown()),
});
export type QuestionVersion = z.infer<typeof questionVersionSchema>;

export const questionViewSchema = z.object({
  question: z.object({
    id: uuidIdSchema,
    category: uuidIdSchema,
    qtype: z.string(),
    name: z.string(),
  }),
  entry: z.object({
    id: uuidIdSchema,
    questioncategoryid: uuidIdSchema,
    questionid: uuidIdSchema,
    latestversion: z.number().int(),
  }),
  latestVersion: questionVersionSchema,
});
export type QuestionView = z.infer<typeof questionViewSchema>;

export const QUESTION_STATES = [
  'notstarted', 'todo', 'incomplete', 'complete',
  'gradedright', 'gradedpartial', 'gradedwrong', 'gaveup', 'finished',
] as const;

export const questionAttemptSchema = z.object({
  id: uuidIdSchema,
  questionusageid: uuidIdSchema,
  slot: z.number().int(),
  behaviour: z.string(),
  questionid: uuidIdSchema,
  questionversionid: uuidIdSchema.nullable(),
  maxmark: z.number(),
  state: z.string(),
  fraction: z.number().nullable(),
  steps: z.array(z.object({
    id: uuidIdSchema,
    sequencenumber: z.number().int(),
    state: z.string(),
    fraction: z.number().nullable(),
    data: z.record(z.string(), z.string().nullable()),
  })),
});
export type QuestionAttempt = z.infer<typeof questionAttemptSchema>;

export const questionUsageSchema = z.object({
  usage: z.object({
    id: uuidIdSchema,
    component: z.string(),
    instanceid: uuidIdSchema.nullable(),
    preferredbehaviour: z.string(),
  }),
  state: z.string(),
  attempts: z.array(questionAttemptSchema),
});
export type QuestionUsage = z.infer<typeof questionUsageSchema>;

/* ---- Request payload schemas (Zod — nguồn sự thật duy nhất; xem ADR Zod-only) ---- */

/** Một tiêu chí hoàn thành khoá học: loại tiêu chí + tham số riêng theo loại. */
export const completionCriterionSchema = z.strictObject({
  criteriatype: z.string(),
  moduleinstance: uuidIdSchema.optional(),
  date: z.string().optional(),
});
export type CompletionCriterion = z.infer<typeof completionCriterionSchema>;

/** Payload đặt bộ tiêu chí hoàn thành cho một khoá học. */
export const setCompletionCriteriaSchema = z.strictObject({
  method: z.number().int().optional(),
  criteria: z.array(completionCriterionSchema),
});
export type SetCompletionCriteria = z.infer<typeof setCompletionCriteriaSchema>;

/** Payload đánh dấu hoàn thành thủ công cho một course module. */
export const markManualCompletionSchema = z.strictObject({
  userid: uuidIdSchema,
  complete: z.boolean(),
});
export type MarkManualCompletion = z.infer<typeof markManualCompletionSchema>;

/** Payload tạo hạng mục điểm (grade category). */
export const createGradeCategorySchema = z.strictObject({
  fullname: z.string().min(1),
  parentId: uuidIdSchema.optional(),
  aggregation: z.string().optional(),
  droplow: z.number().int().optional(),
  keephigh: z.number().int().optional(),
  aggregateonlygraded: z.boolean().optional(),
  hidden: z.boolean().optional(),
});
export type CreateGradeCategory = z.infer<typeof createGradeCategorySchema>;

/** Payload sửa hạng mục điểm; `parentId` nhận `null` để đưa hạng mục về gốc. */
export const updateGradeCategorySchema = z.strictObject({
  fullname: z.string().optional(),
  aggregation: z.string().optional(),
  droplow: z.number().int().optional(),
  keephigh: z.number().int().optional(),
  aggregateonlygraded: z.boolean().optional(),
  hidden: z.boolean().optional(),
  parentId: uuidIdSchema.nullable().optional(),
});
export type UpdateGradeCategory = z.infer<typeof updateGradeCategorySchema>;

/** Payload tạo mục điểm (grade item): `itemtype` manual | mod; `cmId` bắt buộc ở tầng nghiệp vụ khi là mod. */
export const createGradeItemSchema = z.strictObject({
  itemname: z.string().min(1),
  itemtype: z.string().optional(),
  categoryId: uuidIdSchema.optional(),
  cmId: uuidIdSchema.optional(),
  grademax: z.number().optional(),
  grademin: z.number().optional(),
  gradepass: z.number().optional(),
  scaleId: uuidIdSchema.optional(),
  weightoverride: z.boolean().optional(),
  weight: z.number().optional(),
  extracredit: z.boolean().optional(),
  multiplicator: z.number().optional(),
  plusfactor: z.number().optional(),
  hidden: z.boolean().optional(),
});
export type CreateGradeItem = z.infer<typeof createGradeItemSchema>;

/** Payload sửa mục điểm (mọi trường đều tuỳ chọn). */
export const updateGradeItemSchema = z.strictObject({
  itemname: z.string().optional(),
  categoryId: uuidIdSchema.optional(),
  grademax: z.number().optional(),
  grademin: z.number().optional(),
  gradepass: z.number().optional(),
  weightoverride: z.boolean().optional(),
  weight: z.number().optional(),
  extracredit: z.boolean().optional(),
  multiplicator: z.number().optional(),
  plusfactor: z.number().optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
});
export type UpdateGradeItem = z.infer<typeof updateGradeItemSchema>;

/** Payload chấm điểm thô cho một người dùng; `rawgrade` nhận `null` để xoá điểm. */
export const setGradeSchema = z.strictObject({
  userid: uuidIdSchema,
  rawgrade: z.number().nullable().optional(),
  feedback: z.string().optional(),
});
export type SetGrade = z.infer<typeof setGradeSchema>;

/** Payload cập nhật trạng thái một grade đã có (ghi đè/khoá/loại trừ/ẩn/đóng băng). */
export const updateGradeSchema = z.strictObject({
  overridden: z.boolean().optional(),
  finalgrade: z.number().nullable().optional(),
  locked: z.boolean().optional(),
  excluded: z.boolean().optional(),
  hidden: z.boolean().optional(),
  frozen: z.boolean().optional(),
  feedback: z.string().optional(),
});
export type UpdateGrade = z.infer<typeof updateGradeSchema>;

/** Một mốc chữ cái trong thang điểm chữ (grade letter). */
export const gradeLetterBoundarySchema = z.strictObject({
  letter: z.string().min(1),
  lowerboundary: z.number(),
});
export type GradeLetterBoundary = z.infer<typeof gradeLetterBoundarySchema>;

/** Payload đặt toàn bộ thang điểm chữ cho một context. */
export const setGradeLettersSchema = z.strictObject({
  letters: z.array(gradeLetterBoundarySchema),
});
export type SetGradeLetters = z.infer<typeof setGradeLettersSchema>;

/** Payload tạo thang điểm (grade scale): `scale` là danh sách mức phân tách bằng dấu phẩy. */
export const createGradeScaleSchema = z.strictObject({
  name: z.string().min(1),
  scale: z.string().min(1),
  description: z.string().optional(),
});
export type CreateGradeScale = z.infer<typeof createGradeScaleSchema>;

/** Payload tạo danh mục câu hỏi trong ngân hàng câu hỏi. */
export const createQuestionCategorySchema = z.strictObject({
  name: z.string().min(1),
  contextid: uuidIdSchema,
  info: z.string().optional(),
  parent: uuidIdSchema.optional(),
});
export type CreateQuestionCategory = z.infer<typeof createQuestionCategorySchema>;

/** Payload tạo câu hỏi; `answer` là dữ liệu đáp án dùng chung theo loại câu hỏi (truefalse: {correct}; shortanswer: {answers, casesensitive?}). */
export const createQuestionSchema = z.strictObject({
  categoryId: uuidIdSchema,
  qtype: z.string().min(1),
  name: z.string().min(1),
  questiontext: z.string(),
  defaultmark: z.number().optional(),
  answer: z.record(z.string(), z.unknown()),
});
export type CreateQuestion = z.infer<typeof createQuestionSchema>;

/** Payload sửa câu hỏi (tạo phiên bản mới ở tầng nghiệp vụ; mọi trường đều tuỳ chọn). */
export const updateQuestionSchema = z.strictObject({
  name: z.string().optional(),
  questiontext: z.string().optional(),
  defaultmark: z.number().optional(),
  answer: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateQuestion = z.infer<typeof updateQuestionSchema>;

/** Một slot trong một lượt sử dụng câu hỏi (question usage). */
export const questionUsageSlotSchema = z.strictObject({
  questionId: uuidIdSchema,
  maxmark: z.number().optional(),
});
export type QuestionUsageSlot = z.infer<typeof questionUsageSlotSchema>;

/** Payload tạo một lượt sử dụng câu hỏi (đề/bài làm) với danh sách slot. */
export const createQuestionUsageSchema = z.strictObject({
  component: z.string().min(1),
  instanceid: uuidIdSchema.optional(),
  contextid: uuidIdSchema.optional(),
  preferredbehaviour: z.string().optional(),
  slots: z.array(questionUsageSlotSchema),
});
export type CreateQuestionUsage = z.infer<typeof createQuestionUsageSchema>;

/** Payload nộp câu trả lời cho một attempt; `response` nhận `null`, `finish` kết thúc attempt. */
export const submitQuestionResponseSchema = z.strictObject({
  response: z.string().nullable().optional(),
  finish: z.boolean().optional(),
});
export type SubmitQuestionResponse = z.infer<typeof submitQuestionResponseSchema>;
