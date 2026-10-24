import { z } from 'zod';
import { uuidIdSchema } from './ids.js';
import { richTextDocumentSchema, richTextInputSchema } from './rich-text.js';

/** Assessment contracts — the single shape source between api and web for grades & questions. */

export const AGGREGATIONS = [
  'natural', 'mean', 'weightedmean', 'simpleweightedmean', 'median', 'lowest', 'highest', 'mode', 'sum',
] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const gradeCategorySchema = z.object({
  id: uuidIdSchema,
  courseId: uuidIdSchema,
  parent: uuidIdSchema.nullable(),
  fullName: z.string(),
  aggregation: z.string(),
  dropLow: z.number().int(),
  keepHigh: z.number().int(),
  aggregateOnlyGraded: z.boolean(),
  depth: z.number().int(),
  path: z.string(),
  hidden: z.boolean(),
});
export type GradeCategory = z.infer<typeof gradeCategorySchema>;

export const gradeItemSchema = z.object({
  id: uuidIdSchema,
  courseId: uuidIdSchema,
  categoryId: uuidIdSchema.nullable(),
  itemName: z.string(),
  itemType: z.string(),
  itemModule: z.string().nullable(),
  itemInstance: uuidIdSchema.nullable(),
  gradeMax: z.number(),
  gradeMin: z.number(),
  gradePass: z.number(),
  weightOverride: z.boolean(),
  aggregationCoef: z.number(),
  extraCredit: z.boolean(),
  multiplicator: z.number(),
  plusFactor: z.number(),
  hidden: z.boolean(),
  locked: z.boolean(),
  gradeType: z.string().optional(),
  scaleId: uuidIdSchema.nullable().optional(),
  outcomeId: uuidIdSchema.nullable().optional(),
  idNumber: z.string().nullable().optional(),
  calculation: z.string().nullable().optional(),
});
export type GradeItem = z.infer<typeof gradeItemSchema>;

/** Một grade outcome: thang định tính mức site (courseId null) hoặc mức khoá học, gắn với một scale. */
export const gradeOutcomeSchema = z.object({
  id: uuidIdSchema,
  courseId: uuidIdSchema.nullable(),
  scaleId: uuidIdSchema,
  name: z.string(),
  description: z.string(),
});
export type GradeOutcome = z.infer<typeof gradeOutcomeSchema>;

export const gradeGradeSchema = z.object({
  id: uuidIdSchema,
  itemId: uuidIdSchema,
  userId: uuidIdSchema,
  rawGrade: z.number().nullable(),
  finalGrade: z.number().nullable(),
  hidden: z.boolean(),
  locked: z.boolean(),
  overridden: z.boolean(),
  excluded: z.boolean(),
  frozen: z.boolean(),
  feedback: z.string().nullable(),
  aggregationWeight: z.number().nullable(),
  letter: z.string().nullable(),
  scaleValue: z.string().nullable().optional(),
  outcomeName: z.string().nullable().optional(),
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
  contextId: uuidIdSchema,
  lowerBoundary: z.number(),
  letter: z.string(),
});
export type GradeLetter = z.infer<typeof gradeLetterSchema>;

export const gradeReportSchema = z.object({
  courseId: uuidIdSchema,
  rows: z.array(z.object({
    userId: uuidIdSchema,
    finalGrade: z.number().nullable(),
    letter: z.string().nullable(),
    outcomes: z.array(z.object({
      itemId: uuidIdSchema,
      outcomeId: uuidIdSchema,
      outcomeName: z.string(),
      scaleValue: z.string().nullable(),
      finalGrade: z.number().nullable(),
    })).optional(),
  })),
});
export type GradeReport = z.infer<typeof gradeReportSchema>;

// --- Questions ---------------------------------------------------------------

export const questionCategorySchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  contextId: uuidIdSchema,
  info: z.string(),
  parent: uuidIdSchema.nullable(),
});
export type QuestionCategory = z.infer<typeof questionCategorySchema>;

/**
 * Một phiên bản nội dung câu hỏi như API trả về: `questionText`,
 * `generalFeedback` và `guidance` luôn là tài liệu Tiptap (đầu vào dạng
 * chuỗi đã được chuẩn hoá ở tầng nghiệp vụ). `guidance` là hướng dẫn mở
 * rộng cho học viên — Moodle không có trường chuẩn tương đương.
 * `stimulusId` trỏ tới ngữ liệu dùng chung mà phiên bản tham chiếu
 * (`null` khi câu hỏi không gắn ngữ liệu); đáp án và options KHÔNG nằm ở
 * đây mà tách ra ở cấp view (xem `questionViewSchema`).
 */
export const questionVersionSchema = z.object({
  id: uuidIdSchema,
  questionBankEntryId: uuidIdSchema,
  questionId: uuidIdSchema,
  version: z.number().int(),
  questionText: richTextDocumentSchema,
  generalFeedback: richTextDocumentSchema.nullable(),
  guidance: richTextDocumentSchema.nullable(),
  defaultMark: z.number(),
  penalty: z.number(),
  stimulusId: uuidIdSchema.nullable(),
});
export type QuestionVersion = z.infer<typeof questionVersionSchema>;

/**
 * Một đáp án của một phiên bản câu hỏi như API trả về (Moodle
 * `question_answers` dùng chung mọi qtype): nội dung đáp án và feedback
 * đều là tài liệu Tiptap; `fraction` là tỷ trọng đúng/sai tương đối trong
 * nội bộ câu hỏi, không phải điểm tuyệt đối.
 */
export const questionAnswerViewSchema = z.object({
  id: uuidIdSchema,
  questionVersionId: uuidIdSchema,
  answer: richTextDocumentSchema,
  fraction: z.number(),
  feedback: richTextDocumentSchema.nullable(),
  sortOrder: z.number().int(),
});
export type QuestionAnswerView = z.infer<typeof questionAnswerViewSchema>;

/**
 * Options của một phiên bản câu hỏi ở view: bản ghi phẳng theo qtype do
 * tầng nghiệp vụ dựng từ bảng options riêng của qtype đó (`null` khi
 * phiên bản không có options).
 */
export const questionOptionsViewSchema = z.record(z.string(), z.unknown()).nullable();
export type QuestionOptionsView = z.infer<typeof questionOptionsViewSchema>;

/**
 * Một ngữ liệu dùng chung (stimulus) như API trả về: thực thể độc lập gắn
 * với một question category, nội dung là một tài liệu Tiptap; nhiều phiên
 * bản câu hỏi có thể cùng tham chiếu một stimulus qua `stimulusId`.
 */
export const stimulusViewSchema = z.object({
  id: uuidIdSchema,
  categoryId: uuidIdSchema,
  createdBy: uuidIdSchema.nullable(),
  content: richTextDocumentSchema,
  createdAt: z.string().optional(),
});
export type StimulusView = z.infer<typeof stimulusViewSchema>;

/**
 * View đầy đủ của một câu hỏi: định danh + phiên bản mới nhất, kèm danh
 * sách đáp án và options của chính phiên bản đó, và `stimulus` là ngữ
 * liệu đã gắn của phiên bản mới nhất (tầng nghiệp vụ nạp sẵn từ
 * `latestVersion.stimulusId`; `null` khi phiên bản không gắn ngữ liệu).
 */
export const questionViewSchema = z.object({
  question: z.object({
    id: uuidIdSchema,
    category: uuidIdSchema,
    qtype: z.string(),
    name: z.string(),
  }),
  entry: z.object({
    id: uuidIdSchema,
    questionCategoryId: uuidIdSchema,
    questionId: uuidIdSchema,
    latestVersion: z.number().int(),
  }),
  latestVersion: questionVersionSchema,
  answers: z.array(questionAnswerViewSchema),
  options: questionOptionsViewSchema,
  stimulus: stimulusViewSchema.nullable(),
});
export type QuestionView = z.infer<typeof questionViewSchema>;

export const QUESTION_STATES = [
  'notstarted', 'todo', 'incomplete', 'complete',
  'gradedright', 'gradedpartial', 'gradedwrong', 'gaveup', 'finished',
] as const;

export const questionAttemptSchema = z.object({
  id: uuidIdSchema,
  questionUsageId: uuidIdSchema,
  slot: z.number().int(),
  behaviour: z.string(),
  questionId: uuidIdSchema,
  questionVersionId: uuidIdSchema.nullable(),
  maxMark: z.number(),
  state: z.string(),
  fraction: z.number().nullable(),
  steps: z.array(z.object({
    id: uuidIdSchema,
    sequenceNumber: z.number().int(),
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
    instanceId: uuidIdSchema.nullable(),
    preferredBehaviour: z.string(),
  }),
  state: z.string(),
  attempts: z.array(questionAttemptSchema),
});
export type QuestionUsage = z.infer<typeof questionUsageSchema>;

/* ---- Request payload schemas (Zod — nguồn sự thật duy nhất; xem ADR Zod-only) ---- */

/**
 * Một tiêu chí hoàn thành khoá học: loại tiêu chí + tham số riêng theo loại
 * (đủ 8 loại của Moodle: module, date, grade, self, course, duration, role,
 * unenrol). `courseInstance` là khoá tiên quyết của loại `course`;
 * `enrolPeriodDays` là số ngày sau ghi danh của loại `duration`; `roleId`
 * là vai trò được quyền duyệt hoàn thành của loại `role`. Loại `self` và
 * `unenrol` không có tham số. Tính bắt buộc của từng tham số do tầng nghiệp
 * vụ kiểm (theo loại), không nằm ở schema này.
 */
export const completionCriterionSchema = z.strictObject({
  criteriaType: z.string(),
  moduleInstance: uuidIdSchema.optional(),
  date: z.string().optional(),
  courseInstance: uuidIdSchema.optional(),
  enrolPeriodDays: z.number().int().min(0).optional(),
  roleId: uuidIdSchema.optional(),
});
export type CompletionCriterion = z.infer<typeof completionCriterionSchema>;

/** Payload đặt bộ tiêu chí hoàn thành cho một khoá học. */
export const setCompletionCriteriaSchema = z.strictObject({
  method: z.number().int().optional(),
  criteria: z.array(completionCriterionSchema),
});
export type SetCompletionCriteria = z.infer<typeof setCompletionCriteriaSchema>;

/** Payload học viên tự đánh dấu/bỏ đánh dấu hoàn thành khoá học (tiêu chí `self` của Moodle). */
export const markCourseSelfCompletionSchema = z.strictObject({
  complete: z.boolean(),
});
export type MarkCourseSelfCompletion = z.infer<typeof markCourseSelfCompletionSchema>;

/**
 * Payload người giữ vai trò chỉ định trong tiêu chí `role` đánh dấu/bỏ đánh
 * dấu hoàn thành cho một học viên (manual completion by others của Moodle).
 */
export const markCourseCriteriaCompletionSchema = z.strictObject({
  userId: uuidIdSchema,
  complete: z.boolean(),
});
export type MarkCourseCriteriaCompletion = z.infer<typeof markCourseCriteriaCompletionSchema>;

/** Payload đánh dấu hoàn thành thủ công cho một course module. */
export const markManualCompletionSchema = z.strictObject({
  userId: uuidIdSchema,
  complete: z.boolean(),
});
export type MarkManualCompletion = z.infer<typeof markManualCompletionSchema>;

/** Payload tạo hạng mục điểm (grade category). */
export const createGradeCategorySchema = z.strictObject({
  fullName: z.string().min(1),
  parentId: uuidIdSchema.optional(),
  aggregation: z.string().optional(),
  dropLow: z.number().int().optional(),
  keepHigh: z.number().int().optional(),
  aggregateOnlyGraded: z.boolean().optional(),
  hidden: z.boolean().optional(),
});
export type CreateGradeCategory = z.infer<typeof createGradeCategorySchema>;

/** Payload sửa hạng mục điểm; `parentId` nhận `null` để đưa hạng mục về gốc. */
export const updateGradeCategorySchema = z.strictObject({
  fullName: z.string().optional(),
  aggregation: z.string().optional(),
  dropLow: z.number().int().optional(),
  keepHigh: z.number().int().optional(),
  aggregateOnlyGraded: z.boolean().optional(),
  hidden: z.boolean().optional(),
  parentId: uuidIdSchema.nullable().optional(),
});
export type UpdateGradeCategory = z.infer<typeof updateGradeCategorySchema>;

/** Payload tạo mục điểm (grade item): `itemType` manual | mod | calculated; `cmId` bắt buộc ở tầng nghiệp vụ khi là mod; `calculation` bắt buộc khi là calculated; `outcomeId` gắn outcome (điểm lưu theo chỉ số scale của outcome). */
export const createGradeItemSchema = z.strictObject({
  itemName: z.string().min(1),
  itemType: z.string().optional(),
  categoryId: uuidIdSchema.optional(),
  cmId: uuidIdSchema.optional(),
  gradeMax: z.number().optional(),
  gradeMin: z.number().optional(),
  gradePass: z.number().optional(),
  scaleId: uuidIdSchema.optional(),
  outcomeId: uuidIdSchema.optional(),
  idNumber: z.string().min(1).optional(),
  calculation: z.string().min(1).optional(),
  weightOverride: z.boolean().optional(),
  weight: z.number().optional(),
  extraCredit: z.boolean().optional(),
  multiplicator: z.number().optional(),
  plusFactor: z.number().optional(),
  hidden: z.boolean().optional(),
});
export type CreateGradeItem = z.infer<typeof createGradeItemSchema>;

/** Payload sửa mục điểm (mọi trường đều tuỳ chọn); `outcomeId`/`scaleId` nhận `null` để gỡ gắn kết. */
export const updateGradeItemSchema = z.strictObject({
  itemName: z.string().optional(),
  categoryId: uuidIdSchema.optional(),
  gradeMax: z.number().optional(),
  gradeMin: z.number().optional(),
  gradePass: z.number().optional(),
  scaleId: uuidIdSchema.nullable().optional(),
  outcomeId: uuidIdSchema.nullable().optional(),
  idNumber: z.string().min(1).nullable().optional(),
  calculation: z.string().min(1).nullable().optional(),
  weightOverride: z.boolean().optional(),
  weight: z.number().optional(),
  extraCredit: z.boolean().optional(),
  multiplicator: z.number().optional(),
  plusFactor: z.number().optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
});
export type UpdateGradeItem = z.infer<typeof updateGradeItemSchema>;

/** Payload chấm điểm thô cho một người dùng; `rawGrade` nhận `null` để xoá điểm. */
export const setGradeSchema = z.strictObject({
  userId: uuidIdSchema,
  rawGrade: z.number().nullable().optional(),
  feedback: z.string().optional(),
});
export type SetGrade = z.infer<typeof setGradeSchema>;

/** Payload cập nhật trạng thái một grade đã có (ghi đè/khoá/loại trừ/ẩn/đóng băng). */
export const updateGradeSchema = z.strictObject({
  overridden: z.boolean().optional(),
  finalGrade: z.number().nullable().optional(),
  locked: z.boolean().optional(),
  excluded: z.boolean().optional(),
  hidden: z.boolean().optional(),
  frozen: z.boolean().optional(),
  feedback: z.string().optional(),
});
export type UpdateGrade = z.infer<typeof updateGradeSchema>;

/**
 * Payload xuất sổ điểm ra Excel theo cấu trúc vnEdu/TT 22/2021 (issue #53):
 * giáo viên ánh xạ tường minh từng mục điểm lá sang một loại cột — các mục
 * thường xuyên (hệ số 1, ít nhất 1), đúng một mục giữa kỳ (hệ số 2) và một
 * mục cuối kỳ (hệ số 3). `semester` là học kỳ 1 hoặc 2; tên lớp/môn/năm học
 * bỏ trống thì phía server lấy mặc định từ khoá học.
 */
export const exportGradesVneduSchema = z.strictObject({
  regularItemIds: z.array(uuidIdSchema).min(1),
  midtermItemId: uuidIdSchema,
  finalItemId: uuidIdSchema,
  semester: z.union([z.literal(1), z.literal(2)]),
  schoolYear: z.string().min(1).max(32).optional(),
  subjectName: z.string().min(1).max(200).optional(),
  className: z.string().min(1).max(200).optional(),
});
export type ExportGradesVnedu = z.infer<typeof exportGradesVneduSchema>;

/** Một mốc chữ cái trong thang điểm chữ (grade letter). */
export const gradeLetterBoundarySchema = z.strictObject({
  letter: z.string().min(1),
  lowerBoundary: z.number(),
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

/** Payload tạo grade outcome: gắn với một scale có sẵn; dùng cho cả outcome mức site và mức khoá học. */
export const createGradeOutcomeSchema = z.strictObject({
  name: z.string().min(1),
  scaleId: uuidIdSchema,
  description: z.string().optional(),
});
export type CreateGradeOutcome = z.infer<typeof createGradeOutcomeSchema>;

/** Payload sửa grade outcome (mọi trường đều tuỳ chọn). */
export const updateGradeOutcomeSchema = z.strictObject({
  name: z.string().min(1).optional(),
  scaleId: uuidIdSchema.optional(),
  description: z.string().optional(),
});
export type UpdateGradeOutcome = z.infer<typeof updateGradeOutcomeSchema>;

/** Payload tạo danh mục câu hỏi trong ngân hàng câu hỏi. */
export const createQuestionCategorySchema = z.strictObject({
  name: z.string().min(1),
  contextId: uuidIdSchema,
  info: z.string().optional(),
  parent: uuidIdSchema.optional(),
});
export type CreateQuestionCategory = z.infer<typeof createQuestionCategorySchema>;

/**
 * Một đáp án trong payload tạo/sửa câu hỏi: nội dung rich text, `fraction`
 * là tỷ trọng đúng/sai tương đối trong nội bộ câu hỏi (không phải điểm),
 * `feedback` rich text tuỳ chọn hiện riêng cho đáp án này.
 */
export const questionAnswerInputSchema = z.strictObject({
  text: richTextInputSchema,
  fraction: z.number(),
  feedback: richTextInputSchema.optional(),
});
export type QuestionAnswerInput = z.infer<typeof questionAnswerInputSchema>;

/**
 * Options theo qtype trong payload tạo/sửa câu hỏi — mọi trường đều tuỳ
 * chọn, tầng nghiệp vụ chỉ lấy các trường thuộc về qtype của câu hỏi:
 * multichoice (`single`, `shuffleAnswers`, `answerNumbering`,
 * `showNumCorrect`, `showStandardInstruction`, ba feedback theo mức đúng),
 * truefalse (`showStandardInstruction`), shortanswer (`useCase`), essay
 * (`responseFormat`, `responseRequired`, `responseFieldLines`,
 * `minWordLimit`, `maxWordLimit`, `graderInfo`, `responseTemplate`).
 */
export const questionOptionsInputSchema = z.strictObject({
  single: z.boolean().optional(),
  shuffleAnswers: z.boolean().optional(),
  answerNumbering: z.string().optional(),
  showNumCorrect: z.boolean().optional(),
  showStandardInstruction: z.boolean().optional(),
  useCase: z.boolean().optional(),
  responseFormat: z.string().optional(),
  responseRequired: z.boolean().optional(),
  responseFieldLines: z.number().int().optional(),
  minWordLimit: z.number().int().nullable().optional(),
  maxWordLimit: z.number().int().nullable().optional(),
  graderInfo: richTextInputSchema.optional(),
  responseTemplate: richTextInputSchema.optional(),
  correctFeedback: richTextInputSchema.optional(),
  partiallyCorrectFeedback: richTextInputSchema.optional(),
  incorrectFeedback: richTextInputSchema.optional(),
});
export type QuestionOptionsInput = z.infer<typeof questionOptionsInputSchema>;

/**
 * Payload tạo câu hỏi theo bốn qtype chuẩn Moodle (`multichoice`,
 * `truefalse`, `shortanswer`, `essay`): `questionText` nhận chuỗi thuần
 * hoặc tài liệu Tiptap; đáp án truyền qua `answers` + `options` theo
 * qtype và được tầng nghiệp vụ bung ra các bảng đáp án/options riêng.
 * Trường `answer` là dạng payload CŨ còn giữ để tương thích client/test
 * hiện hữu (truefalse: {correct: boolean}; shortanswer: {answers:
 * string[], casesensitive?: boolean}) — tầng nghiệp vụ ánh xạ nó sang
 * `answers`/`options`. Tầng nghiệp vụ bắt buộc payload mang một trong hai
 * dạng (`answers`/`options` mới hoặc `answer` cũ) tuỳ theo qtype.
 */
export const createQuestionSchema = z.strictObject({
  categoryId: uuidIdSchema,
  qtype: z.enum(['multichoice', 'truefalse', 'shortanswer', 'essay']),
  name: z.string().min(1),
  questionText: richTextInputSchema,
  generalFeedback: richTextInputSchema.optional(),
  guidance: richTextInputSchema.optional(),
  defaultMark: z.number().optional(),
  penalty: z.number().optional(),
  stimulusId: uuidIdSchema.optional(),
  answers: z.array(questionAnswerInputSchema).optional(),
  options: questionOptionsInputSchema.optional(),
  answer: z.record(z.string(), z.unknown()).optional(),
});
export type CreateQuestion = z.infer<typeof createQuestionSchema>;

/**
 * Payload sửa câu hỏi (tạo phiên bản mới ở tầng nghiệp vụ; mọi trường đều
 * tuỳ chọn, ngữ nghĩa từng trường như payload tạo). `stimulusId` nhận
 * `null` để gỡ gắn ngữ liệu khỏi phiên bản mới; `answer` là dạng payload
 * cũ như ở payload tạo.
 */
export const updateQuestionSchema = z.strictObject({
  name: z.string().optional(),
  questionText: richTextInputSchema.optional(),
  generalFeedback: richTextInputSchema.optional(),
  guidance: richTextInputSchema.optional(),
  defaultMark: z.number().optional(),
  penalty: z.number().optional(),
  stimulusId: uuidIdSchema.nullable().optional(),
  answers: z.array(questionAnswerInputSchema).optional(),
  options: questionOptionsInputSchema.optional(),
  answer: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateQuestion = z.infer<typeof updateQuestionSchema>;

/** Payload tạo ngữ liệu dùng chung (stimulus) gắn với một question category; `content` nhận chuỗi thuần hoặc tài liệu Tiptap. */
export const createStimulusSchema = z.strictObject({
  categoryId: uuidIdSchema,
  content: richTextInputSchema,
});
export type CreateStimulus = z.infer<typeof createStimulusSchema>;

/** Payload sửa ngữ liệu dùng chung; chỉ nội dung được sửa (stimulus đã có câu hỏi tham chiếu là bất biến ở tầng nghiệp vụ). */
export const updateStimulusSchema = z.strictObject({
  content: richTextInputSchema,
});
export type UpdateStimulus = z.infer<typeof updateStimulusSchema>;

/** Một slot trong một lượt sử dụng câu hỏi (question usage). */
export const questionUsageSlotSchema = z.strictObject({
  questionId: uuidIdSchema,
  maxMark: z.number().optional(),
});
export type QuestionUsageSlot = z.infer<typeof questionUsageSlotSchema>;

/** Payload tạo một lượt sử dụng câu hỏi (đề/bài làm) với danh sách slot. */
export const createQuestionUsageSchema = z.strictObject({
  component: z.string().min(1),
  instanceId: uuidIdSchema.optional(),
  contextId: uuidIdSchema.optional(),
  preferredBehaviour: z.string().optional(),
  slots: z.array(questionUsageSlotSchema),
});
export type CreateQuestionUsage = z.infer<typeof createQuestionUsageSchema>;

/** Payload nộp câu trả lời cho một attempt; `response` nhận `null`, `finish` kết thúc attempt. */
export const submitQuestionResponseSchema = z.strictObject({
  response: z.string().nullable().optional(),
  finish: z.boolean().optional(),
});
export type SubmitQuestionResponse = z.infer<typeof submitQuestionResponseSchema>;

// --- Quiz (mod_quiz) -----------------------------------------------------------

/** Cách tính điểm bài khi học sinh có nhiều lượt làm (Moodle quiz grade method). */
export const QUIZ_GRADE_METHODS = ['highest', 'average', 'first', 'last'] as const;
export type QuizGradeMethod = (typeof QUIZ_GRADE_METHODS)[number];

/** Trạng thái một lượt làm quiz: đang làm, đã nộp chờ chấm tay (còn essay), đã chốt. */
export const QUIZ_ATTEMPT_STATES = ['inprogress', 'needsgrading', 'finished'] as const;
export type QuizAttemptState = (typeof QUIZ_ATTEMPT_STATES)[number];

/**
 * Một slot trong đề quiz (Moodle `quiz_slots`): hoặc câu cố định
 * (`questionId`), hoặc slot ngẫu nhiên rút từ một category (`categoryId`).
 * `maxMark` là điểm của slot TRONG ĐỀ NÀY — nguồn điểm thật duy nhất;
 * `default_mark` của câu trong ngân hàng chỉ là gợi ý lúc thêm slot.
 */
export const quizSlotViewSchema = z.object({
  id: uuidIdSchema,
  quizId: uuidIdSchema,
  slot: z.number().int(),
  page: z.number().int(),
  questionId: uuidIdSchema.nullable(),
  categoryId: uuidIdSchema.nullable(),
  maxMark: z.number(),
});
export type QuizSlotView = z.infer<typeof quizSlotViewSchema>;

/**
 * View một quiz (hoạt động trong khoá học): cấu hình đề + danh sách slot +
 * tổng điểm các slot (`sumGrades` — mẫu số trước khi quy về thang `grade`).
 * `cmId` là course module chứa hoạt động này.
 */
export const quizViewSchema = z.object({
  id: uuidIdSchema,
  courseId: uuidIdSchema,
  cmId: uuidIdSchema.nullable(),
  name: z.string(),
  intro: z.string(),
  timeOpen: z.string().nullable(),
  timeClose: z.string().nullable(),
  timeLimitSeconds: z.number().int().nullable(),
  attemptsAllowed: z.number().int(),
  gradeMethod: z.enum(QUIZ_GRADE_METHODS),
  grade: z.number(),
  shuffleAnswers: z.boolean(),
  slots: z.array(quizSlotViewSchema),
  sumGrades: z.number(),
});
export type QuizView = z.infer<typeof quizViewSchema>;

/** Tóm tắt một lượt làm quiz trong danh sách (của học sinh hoặc của cả lớp). */
export const quizAttemptSummarySchema = z.object({
  id: uuidIdSchema,
  quizId: uuidIdSchema,
  userId: uuidIdSchema,
  attemptNumber: z.number().int(),
  usageId: uuidIdSchema,
  state: z.string(),
  preview: z.boolean(),
  timeStart: z.string(),
  timeFinish: z.string().nullable(),
  sumGrades: z.number().nullable(),
  /** Điểm của riêng lượt này đã quy về thang điểm của quiz (null khi chưa chốt). */
  grade: z.number().nullable(),
});
export type QuizAttemptSummary = z.infer<typeof quizAttemptSummarySchema>;

/** Payload tạo quiz trong một section của khoá học (kèm course module + grade item ở tầng nghiệp vụ). */
export const createQuizSchema = z.strictObject({
  sectionId: uuidIdSchema,
  name: z.string().min(1),
  intro: z.string().optional(),
  timeOpen: z.string().nullable().optional(),
  timeClose: z.string().nullable().optional(),
  timeLimitSeconds: z.number().int().positive().nullable().optional(),
  attemptsAllowed: z.number().int().min(0).optional(),
  gradeMethod: z.enum(QUIZ_GRADE_METHODS).optional(),
  grade: z.number().positive().optional(),
  shuffleAnswers: z.boolean().optional(),
});
export type CreateQuiz = z.infer<typeof createQuizSchema>;

/** Payload sửa cài đặt quiz (mọi trường tuỳ chọn; `timeOpen`/`timeClose`/`timeLimitSeconds` nhận `null` để gỡ). */
export const updateQuizSchema = z.strictObject({
  name: z.string().min(1).optional(),
  intro: z.string().optional(),
  timeOpen: z.string().nullable().optional(),
  timeClose: z.string().nullable().optional(),
  timeLimitSeconds: z.number().int().positive().nullable().optional(),
  attemptsAllowed: z.number().int().min(0).optional(),
  gradeMethod: z.enum(QUIZ_GRADE_METHODS).optional(),
  grade: z.number().positive().optional(),
  shuffleAnswers: z.boolean().optional(),
});
export type UpdateQuiz = z.infer<typeof updateQuizSchema>;

/** Payload thêm slot vào đề: đúng một trong `questionId` (câu cố định) hoặc `categoryId` (slot ngẫu nhiên); `maxMark` bỏ trống thì lấy điểm mặc định của câu (slot cố định). */
export const addQuizSlotSchema = z.strictObject({
  questionId: uuidIdSchema.optional(),
  categoryId: uuidIdSchema.optional(),
  maxMark: z.number().positive().optional(),
  page: z.number().int().positive().optional(),
});
export type AddQuizSlot = z.infer<typeof addQuizSlotSchema>;

/** Payload sửa một slot: đổi điểm, trang hoặc vị trí (số thứ tự) trong đề. */
export const updateQuizSlotSchema = z.strictObject({
  maxMark: z.number().positive().optional(),
  page: z.number().int().positive().optional(),
  slot: z.number().int().positive().optional(),
});
export type UpdateQuizSlot = z.infer<typeof updateQuizSlotSchema>;

/** Payload bắt đầu lượt làm quiz; `preview` dành cho giáo viên xem trước đề (không tính lượt, không ghi điểm). */
export const startQuizAttemptSchema = z.strictObject({
  preview: z.boolean().optional(),
});
export type StartQuizAttempt = z.infer<typeof startQuizAttemptSchema>;

/** Payload lưu câu trả lời của một câu trong lượt làm quiz (ủy quyền cho question engine). */
export const submitQuizResponseSchema = z.strictObject({
  questionAttemptId: uuidIdSchema,
  response: z.string().nullable().optional(),
});
export type SubmitQuizResponse = z.infer<typeof submitQuizResponseSchema>;

/** Payload chấm tay một câu (essay) trong lượt làm quiz: điểm tuyệt đối theo maxMark của slot, nhận xét tuỳ chọn. */
export const manualGradeQuizSchema = z.strictObject({
  mark: z.number().min(0),
  comment: z.string().optional(),
});
export type ManualGradeQuiz = z.infer<typeof manualGradeQuizSchema>;
