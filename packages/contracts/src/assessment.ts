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

/**
 * Payload mở sổ điểm VN (GB-VN-1, issue #95) cho một khoá học × học kì theo
 * TT 22/2021: `subjectPeriodsPerYear` là số tiết/năm của môn — hệ thống suy
 * số cột ĐĐGtx theo Điều 6.2b. `assessmentMode` bỏ trống thì phía server suy
 * từ môn học của khoá (nhóm chỉ-nhận-xét ở Điều 5.3a); môn chỉ-nhận-xét
 * không cần số tiết. `regime` ở lát này chỉ nhận `tt22`.
 */
export const createVnGradebookSchema = z.strictObject({
  term: z.enum(['hk1', 'hk2']),
  subjectPeriodsPerYear: z.number().int().min(1).max(1000).optional(),
  assessmentMode: z.enum(['score', 'comment']).optional(),
  regime: z.enum(['tt22', 'tt27', 'free']).optional(),
});
export type CreateVnGradebook = z.infer<typeof createVnGradebookSchema>;

/** Payload chốt kết quả học kì của một học sinh trong một sổ VN: ghi bản snapshot vào vn_term_results kèm nhận xét kì. */
export const finalizeVnTermResultSchema = z.strictObject({
  comment: z.string().max(2000).optional(),
});
export type FinalizeVnTermResult = z.infer<typeof finalizeVnTermResultSchema>;

/** Payload ghi kết quả môn chỉ-nhận-xét (Điều 5.3a) cho một học sinh trong một học kì. */
export const setVnCommentResultSchema = z.strictObject({
  result: z.enum(['Đạt', 'Chưa đạt']),
  comment: z.string().max(2000).optional(),
});
export type SetVnCommentResult = z.infer<typeof setVnCommentResultSchema>;

/** Payload chốt kết quả cả năm của một học sinh trong một khoá học (ĐTBmcn từ hai bản chốt học kì). */
export const finalizeVnYearResultSchema = z.strictObject({
  comment: z.string().max(2000).optional(),
});
export type FinalizeVnYearResult = z.infer<typeof finalizeVnYearResultSchema>;

/**
 * Payload khai vai trò điểm cho một hoạt động vào sổ VN (GB-VN-2, issue #104):
 * gắn course module `cmId` (quiz/assignment — hoạt động đã có grade item loại
 * `mod`) vào cột đích của sổ. Vai `dgtx` bắt buộc kèm `ordinal` (thứ tự cột
 * ĐĐGtx 1..quota của sổ); `dggk`/`dgck` là cột đơn, không kèm ordinal.
 */
export const createVnActivityMappingSchema = z.strictObject({
  cmId: uuidIdSchema,
  role: z.enum(['dgtx', 'dggk', 'dgck']),
  ordinal: z.number().int().min(1).max(99).optional(),
});
export type CreateVnActivityMapping = z.infer<typeof createVnActivityMappingSchema>;

/**
 * Payload chốt một ứng viên điểm vào cột (GB-VN-2): bỏ trống `value` thì chốt
 * đúng giá trị đã quy đổi thang 10 từ điểm hoạt động; truyền `value` là GV sửa
 * trước khi chốt — giá trị vào cột mang cờ overridden của engine.
 */
export const commitVnCandidateSchema = z.strictObject({
  value: z.number().min(0).max(10).optional(),
});
export type CommitVnCandidate = z.infer<typeof commitVnCandidateSchema>;

/** Payload bỏ qua một ứng viên điểm (GB-VN-2): không có tham số — ứng viên chỉ hiện lại khi điểm hoạt động thay đổi. */
export const dismissVnCandidateSchema = z.strictObject({});
export type DismissVnCandidate = z.infer<typeof dismissVnCandidateSchema>;

/**
 * Payload đặt trạng thái kiểm tra bù cho một cột định kì (ĐĐGgk/ĐĐGck) của một
 * học sinh (GB-VN-2, Điều 7.4–7.5 TT 22): `awaiting_makeup` = chờ kiểm tra bù
 * (chặn chốt sổ bằng mã riêng); `zero` = ghi hẳn 0 điểm theo Điều 7.5;
 * `clear` = gỡ đánh dấu chờ bù.
 */
export const setVnMakeupStatusSchema = z.strictObject({
  state: z.enum(['awaiting_makeup', 'zero', 'clear']),
});
export type SetVnMakeupStatus = z.infer<typeof setVnMakeupStatusSchema>;

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
  /** Bank sở hữu category (feat Ngân hàng câu hỏi chung, QB-1): khi có, contextId phải là context của bank đó. */
  bankId: uuidIdSchema.optional(),
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
 * truefalse (`showStandardInstruction`), shortanswer (`useCase` + cờ đáp
 * án số `numericAnswer`/`numericMaxLength`/`numericAllowSign`/
 * `numericAllowDecimal` — mặc định tắt, điểm 6.3.3 issue #30), essay
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
  numericAnswer: z.boolean().optional(),
  numericMaxLength: z.number().int().positive().nullable().optional(),
  numericAllowSign: z.boolean().optional(),
  numericAllowDecimal: z.boolean().optional(),
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
/** Nguồn gốc ngoài hệ thống của câu hỏi (truy vết nội bộ — không hiển thị cho học viên, quy tắc bản quyền 24/10/2026). */
export const QUESTION_SOURCE_KINDS = ['book', 'exam', 'manual', 'import', 'ai'] as const;
export const createQuestionSchema = z.strictObject({
  categoryId: uuidIdSchema,
  qtype: z.enum(['multichoice', 'truefalse', 'shortanswer', 'essay']),
  name: z.string().min(1),
  sourceKind: z.enum(QUESTION_SOURCE_KINDS).optional(),
  sourceRef: z.string().min(1).optional(),
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

/** Thang chấm Đ–S chùm: đúng 5 tỉ lệ % cho 0..4 ý đúng, đơn điệu không giảm, phần tử cuối = 100 (tầng nghiệp vụ kiểm tra tính đơn điệu). */
export const tfScaleSchema = z.array(z.number().min(0).max(100)).length(5);
export type TfScale = z.infer<typeof tfScaleSchema>;

/**
 * Một slot trong đề quiz (Moodle `quiz_slots`): hoặc câu cố định
 * (`questionId`), hoặc slot ngẫu nhiên rút từ một category (`categoryId`),
 * hoặc nguồn ô ma trận (`matrixCellId` — Chặng 3; đề cố định sinh từ ma
 * trận mang cả `questionId` lẫn `matrixCellId`). `maxMark` là điểm của
 * slot TRONG ĐỀ NÀY — nguồn điểm thật duy nhất; `default_mark` của câu
 * trong ngân hàng chỉ là gợi ý lúc thêm slot. `clusterId` gom 4 slot
 * của một chùm Đ–S.
 */
export const quizSlotViewSchema = z.object({
  id: uuidIdSchema,
  quizId: uuidIdSchema,
  slot: z.number().int(),
  page: z.number().int(),
  questionId: uuidIdSchema.nullable(),
  categoryId: uuidIdSchema.nullable(),
  matrixCellId: uuidIdSchema.nullable(),
  clusterId: uuidIdSchema.nullable(),
  maxMark: z.number(),
  /** Kỷ luật version của slot (QB-3): `pinned`/`follow_latest` cho slot cố định, null cho slot ngẫu nhiên. */
  versionMode: z.enum(['pinned', 'follow_latest']).nullable(),
  /** Số version đang ghim (slot pinned) và version ready mới nhất của câu — UI hiện "đang ghim v[n] · đã có v[m]". */
  pinnedVersion: z.number().int().nullable(),
  latestVersion: z.number().int().nullable(),
  hasNewerVersion: z.boolean(),
  /** Bank nguồn của câu trong slot (null với slot ngẫu nhiên hoặc câu chưa thuộc bank nào). */
  bankId: uuidIdSchema.nullable(),
  bankName: z.string().nullable(),
  bankScope: z.string().nullable(),
  /** Trạng thái của câu trong bank (ready/hidden/…) để UI báo câu đã rút. */
  questionStatus: z.string().nullable(),
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
  /** Đề có đặt mật khẩu vào thi hay không (không bao giờ lộ mật khẩu/băm). */
  hasPassword: z.boolean(),
  /** Danh sách IP/CIDR được phép (định dạng Moodle `quiz.subnet`), null = không giới hạn. */
  subnet: z.string().nullable(),
  /** Độ trễ bắt buộc (giây) sau lượt chốt thứ 1 / từ lượt thứ 3; null = không trễ. */
  delay1Seconds: z.number().int().nullable(),
  delay2Seconds: z.number().int().nullable(),
  /** Bảy bitmask tuỳ chọn xem lại kiểu Moodle (cửa sổ: trong lúc làm / ngay sau nộp / sau đó khi đề mở / sau khi đóng). */
  reviewAttempt: z.number().int(),
  reviewCorrectness: z.number().int(),
  reviewMarks: z.number().int(),
  reviewSpecificFeedback: z.number().int(),
  reviewGeneralFeedback: z.number().int(),
  reviewRightAnswer: z.number().int(),
  reviewOverallFeedback: z.number().int(),
  /** Ma trận nguồn khi đề sinh từ ma trận (Chặng 3); null với đề dựng tay. */
  matrixId: uuidIdSchema.nullable(),
  /** Đề ngân hàng đã triển khai vào quiz này (EB-1); null với quiz dựng tay hoặc sinh từ ma trận. */
  paperId: uuidIdSchema.nullable(),
  /** Paper version đã ghim lúc triển khai đề (EB-1); sửa đề về sau không đổi quiz này. */
  paperVersionId: uuidIdSchema.nullable(),
  /** Thang Đ–S chùm hiệu lực của đề; null = mặc định QĐ 764 [0, 10, 25, 50, 100]. */
  tfScale: tfScaleSchema.nullable(),
  /** Hình thức kiểm tra TT 22 đã chọn preset: regular (thường xuyên) | periodic (định kỳ) | mock (thi thử); null = không theo preset. */
  examKind: z.enum(['regular', 'periodic', 'mock']).nullable(),
  /** Phút vào thi muộn tối đa từ mốc mở hiệu lực (preset thi thử = 15, Điều 21 TT 24/2024); null = không áp. */
  lateEntryMinutes: z.number().int().nullable(),
  /** Có ghi nhận sự kiện giám sát trong lúc làm bài hay không (chỉ ghi nhận, không tự kết luận gian lận). */
  monitorEvents: z.boolean(),
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
  /** Nhãn kiểm tra bù (TT 22 Điều 7 k.4–5): lượt bắt đầu trong cửa sổ chỉ có nhờ override mở riêng. */
  makeup: z.boolean(),
  /** Snapshot quy tắc hiệu lực đã áp lúc bắt đầu lượt (giá trị + override nguồn + thứ tự câu đã rút); null với lượt cũ. */
  appliedSettings: z.record(z.string(), z.unknown()).nullable(),
});
export type QuizAttemptSummary = z.infer<typeof quizAttemptSummarySchema>;

/** Các trường quy tắc thi dùng chung cho tạo/sửa quiz (Chặng 2): mật khẩu dạng rõ ở biên API, tầng nghiệp vụ băm trước khi lưu. */
const quizAccessRuleFields = {
  /** Mật khẩu vào thi; `null` = gỡ mật khẩu (khi sửa) / không đặt (khi tạo). */
  password: z.string().min(1).nullable().optional(),
  subnet: z.string().min(1).nullable().optional(),
  delay1Seconds: z.number().int().min(0).nullable().optional(),
  delay2Seconds: z.number().int().min(0).nullable().optional(),
  /** Hình thức kiểm tra: khi tạo, chọn preset điền sẵn quy tắc theo bảng preset (trường gửi kèm thắng preset); khi sửa chỉ đổi nhãn. */
  examKind: z.enum(['regular', 'periodic', 'mock']).nullable().optional(),
  lateEntryMinutes: z.number().int().min(0).nullable().optional(),
  monitorEvents: z.boolean().optional(),
  reviewAttempt: z.number().int().min(0).optional(),
  reviewCorrectness: z.number().int().min(0).optional(),
  reviewMarks: z.number().int().min(0).optional(),
  reviewSpecificFeedback: z.number().int().min(0).optional(),
  reviewGeneralFeedback: z.number().int().min(0).optional(),
  reviewRightAnswer: z.number().int().min(0).optional(),
  reviewOverallFeedback: z.number().int().min(0).optional(),
};

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
  /** Thang Đ–S chùm của đề (Chặng 3); `null` = dùng mặc định QĐ 764. */
  tfScale: tfScaleSchema.nullable().optional(),
  ...quizAccessRuleFields,
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
  tfScale: tfScaleSchema.nullable().optional(),
  ...quizAccessRuleFields,
});
export type UpdateQuiz = z.infer<typeof updateQuizSchema>;

/** Một ghi đè cài đặt thi (Moodle `quiz_overrides`): đúng một đích — nhóm (`groupId`) hoặc người dùng (`userId`); trường null = kế thừa. */
export const quizOverrideViewSchema = z.object({
  id: uuidIdSchema,
  quizId: uuidIdSchema,
  groupId: uuidIdSchema.nullable(),
  groupName: z.string().nullable(),
  userId: uuidIdSchema.nullable(),
  userName: z.string().nullable(),
  timeOpen: z.string().nullable(),
  timeClose: z.string().nullable(),
  timeLimitSeconds: z.number().int().nullable(),
  attempts: z.number().int().nullable(),
  hasPassword: z.boolean(),
  /** Lý do của ghi đè (truy vết quyết định: cộng giờ KHGD cá nhân, mở cửa sổ bù...). */
  reason: z.string().nullable(),
});
export type QuizOverrideView = z.infer<typeof quizOverrideViewSchema>;

/** Payload tạo ghi đè: đúng một trong `groupId`/`userId` (tầng nghiệp vụ kiểm tra); mật khẩu dạng rõ, băm khi lưu. */
export const createQuizOverrideSchema = z.strictObject({
  groupId: uuidIdSchema.optional(),
  userId: uuidIdSchema.optional(),
  timeOpen: z.string().nullable().optional(),
  timeClose: z.string().nullable().optional(),
  timeLimitSeconds: z.number().int().positive().nullable().optional(),
  attempts: z.number().int().min(0).nullable().optional(),
  password: z.string().min(1).nullable().optional(),
  reason: z.string().min(1).nullable().optional(),
});
export type CreateQuizOverride = z.infer<typeof createQuizOverrideSchema>;

/** Payload sửa ghi đè (mọi trường tuỳ chọn; `null` ở các trường ghi đè = quay về kế thừa). */
export const updateQuizOverrideSchema = z.strictObject({
  timeOpen: z.string().nullable().optional(),
  timeClose: z.string().nullable().optional(),
  timeLimitSeconds: z.number().int().positive().nullable().optional(),
  attempts: z.number().int().min(0).nullable().optional(),
  password: z.string().min(1).nullable().optional(),
  reason: z.string().min(1).nullable().optional(),
});
export type UpdateQuizOverride = z.infer<typeof updateQuizOverrideSchema>;

/** Một dải nhận xét tổng quát theo khoảng % điểm (tầng feedback thứ tư, Moodle `quiz_feedback`). */
export const quizFeedbackViewSchema = z.object({
  id: uuidIdSchema,
  quizId: uuidIdSchema,
  minPercent: z.number(),
  maxPercent: z.number(),
  feedback: z.string(),
});
export type QuizFeedbackView = z.infer<typeof quizFeedbackViewSchema>;

/** Payload tạo dải nhận xét tổng quát: [minPercent, maxPercent) trên thang % điểm của bài. */
export const createQuizFeedbackSchema = z.strictObject({
  minPercent: z.number().min(0).max(100),
  maxPercent: z.number().min(0).max(100),
  feedback: z.string().min(1),
});
export type CreateQuizFeedback = z.infer<typeof createQuizFeedbackSchema>;

/** Sự kiện giám sát client được phép báo (chỉ ghi nhận — hệ thống không tự kết luận gian lận). */
export const QUIZ_ATTEMPT_EVENT_TYPES = ['fullscreen_exit', 'focus_lost', 'disconnect_long'] as const;

/** Payload báo một sự kiện giám sát của lượt đang làm. */
export const recordQuizAttemptEventSchema = z.strictObject({
  type: z.enum(QUIZ_ATTEMPT_EVENT_TYPES),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type RecordQuizAttemptEvent = z.infer<typeof recordQuizAttemptEventSchema>;

/** Payload chấm tay THEO CÂU cho nhiều lượt cùng lúc (grade-by-question): một câu, một danh sách (lượt, điểm, nhận xét). */
export const gradeQuizQuestionSchema = z.strictObject({
  questionId: uuidIdSchema,
  grades: z.array(z.strictObject({
    attemptId: uuidIdSchema,
    mark: z.number().min(0),
    comment: z.string().optional(),
  })).min(1),
});
export type GradeQuizQuestion = z.infer<typeof gradeQuizQuestionSchema>;

// ---------------------------------------------------------------------------
// Ma trận đề + bản đặc tả (Quiz Chặng 3, issue #30)
// ---------------------------------------------------------------------------

/** Bộ mức nhận thức trên cặp câu×YCCĐ (Curriculum Chặng 2): Biết / Hiểu / Vận dụng / Vận dụng cao. */
export const COGNITIVE_LEVELS = ['biet', 'hieu', 'van_dung', 'van_dung_cao'] as const;

/** Loại preset của ma trận: định kỳ theo CV 7991, tốt nghiệp theo QĐ 764, hoặc tự đặt. */
export const MATRIX_PRESET_KINDS = ['cv7991_periodic', 'qd764_graduation', 'custom'] as const;

/** Một ô ma trận = YCCĐ × mức × dạng câu (riêng truefalse, `questionCount` là số CHÙM 4 câu). */
export const examMatrixCellViewSchema = z.object({
  id: uuidIdSchema,
  matrixId: uuidIdSchema,
  learningOutcomeId: uuidIdSchema,
  cognitiveLevel: z.enum(COGNITIVE_LEVELS),
  qtype: z.enum(['multichoice', 'truefalse', 'shortanswer', 'essay']),
  questionCount: z.number().int(),
  cellScore: z.number(),
  minutes: z.number().int().nullable(),
  tfScale: tfScaleSchema.nullable(),
  position: z.number().int(),
});
export type ExamMatrixCellView = z.infer<typeof examMatrixCellViewSchema>;

/** Ma trận đề: thực thể lưu trữ neo Chương trình GDPT 2018; `warnings` là cảnh báo lệch tỉ lệ (không khoá cứng). */
export const examMatrixViewSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  subjectId: uuidIdSchema,
  curriculumId: uuidIdSchema,
  contextId: uuidIdSchema,
  presetKind: z.enum(MATRIX_PRESET_KINDS),
  targetFormPercents: z.record(z.string(), z.number()).nullable(),
  targetLevelPercents: z.record(z.string(), z.number()).nullable(),
  levelSet: z.enum(['three', 'four']),
  scopeNote: z.string().nullable(),
  scopeOutcomeIds: z.array(uuidIdSchema).nullable(),
  totalScore: z.number(),
  createdBy: uuidIdSchema.nullable(),
  /** Các trường ngân hàng (MB-0): bank chứa ma trận (null = chưa vào bank), vòng đời trong bank, cờ mẫu, truy vết copy, phiên bản. */
  bankId: uuidIdSchema.nullable(),
  status: z.enum(['draft', 'ready', 'hidden']),
  isTemplate: z.boolean(),
  derivedFromMatrixId: uuidIdSchema.nullable(),
  version: z.number().int(),
  cells: z.array(examMatrixCellViewSchema),
  warnings: z.array(z.string()),
});
export type ExamMatrixView = z.infer<typeof examMatrixViewSchema>;

/** Payload tạo ma trận; tỉ lệ mục tiêu không gửi thì chụp từ preset (custom = để trống). */
export const createExamMatrixSchema = z.strictObject({
  name: z.string().min(1),
  subjectId: uuidIdSchema,
  curriculumId: uuidIdSchema,
  presetKind: z.enum(MATRIX_PRESET_KINDS).optional(),
  targetFormPercents: z.record(z.string(), z.number().min(0).max(100)).nullable().optional(),
  targetLevelPercents: z.record(z.string(), z.number().min(0).max(100)).nullable().optional(),
  levelSet: z.enum(['three', 'four']).optional(),
  scopeNote: z.string().nullable().optional(),
  scopeOutcomeIds: z.array(uuidIdSchema).nullable().optional(),
  totalScore: z.number().positive().optional(),
  /** Trường ngân hàng (MB-0): luồng copy mẫu của MB-1 sẽ dùng bankId/derivedFromMatrixId/isTemplate khi tạo. */
  bankId: uuidIdSchema.nullable().optional(),
  status: z.enum(['draft', 'ready', 'hidden']).optional(),
  isTemplate: z.boolean().optional(),
  derivedFromMatrixId: uuidIdSchema.nullable().optional(),
});
export type CreateExamMatrix = z.infer<typeof createExamMatrixSchema>;

/** Payload sửa ma trận (không đổi môn/chương trình neo). */
export const updateExamMatrixSchema = z.strictObject({
  name: z.string().min(1).optional(),
  presetKind: z.enum(MATRIX_PRESET_KINDS).optional(),
  targetFormPercents: z.record(z.string(), z.number().min(0).max(100)).nullable().optional(),
  targetLevelPercents: z.record(z.string(), z.number().min(0).max(100)).nullable().optional(),
  levelSet: z.enum(['three', 'four']).optional(),
  scopeNote: z.string().nullable().optional(),
  scopeOutcomeIds: z.array(uuidIdSchema).nullable().optional(),
  totalScore: z.number().positive().optional(),
  bankId: uuidIdSchema.nullable().optional(),
  status: z.enum(['draft', 'ready', 'hidden']).optional(),
  isTemplate: z.boolean().optional(),
});
export type UpdateExamMatrix = z.infer<typeof updateExamMatrixSchema>;

/** Payload tạo ô ma trận. */
export const createExamMatrixCellSchema = z.strictObject({
  learningOutcomeId: uuidIdSchema,
  cognitiveLevel: z.enum(COGNITIVE_LEVELS),
  qtype: z.enum(['multichoice', 'truefalse', 'shortanswer', 'essay']),
  questionCount: z.number().int().positive(),
  cellScore: z.number().positive(),
  minutes: z.number().int().positive().nullable().optional(),
  tfScale: tfScaleSchema.nullable().optional(),
  position: z.number().int().positive().optional(),
});
export type CreateExamMatrixCell = z.infer<typeof createExamMatrixCellSchema>;

/** Payload sửa ô ma trận (không đổi khoá outcome/mức/dạng — xoá ô và tạo lại). */
export const updateExamMatrixCellSchema = z.strictObject({
  questionCount: z.number().int().positive().optional(),
  cellScore: z.number().positive().optional(),
  minutes: z.number().int().positive().nullable().optional(),
  tfScale: tfScaleSchema.nullable().optional(),
  position: z.number().int().positive().optional(),
});
export type UpdateExamMatrixCell = z.infer<typeof updateExamMatrixCellSchema>;

/**
 * MB-1 (issue #111): copy ma trận trong ngân hàng ma trận — đích mặc
 * định là bank ma trận cá nhân của người copy khi không gửi
 * targetBankId; name không gửi thì giữ tên nguồn.
 */
export const copyExamMatrixSchema = z.strictObject({
  targetBankId: uuidIdSchema.nullable().optional(),
  name: z.string().min(1).optional(),
});
export type CopyExamMatrix = z.infer<typeof copyExamMatrixSchema>;

/** MB-1: đề xuất đóng góp một ma trận ready vào bank ma trận dùng chung (cơ chế QB-4). */
export const createMatrixContributionSchema = z.strictObject({
  targetBankId: uuidIdSchema,
  note: z.string().max(2000).optional(),
});
export type CreateMatrixContribution = z.infer<typeof createMatrixContributionSchema>;

/** MB-1: duyệt đóng góp ma trận — duyệt = copy sâu vào bank đích, không có payload. */
export const approveMatrixContributionSchema = z.strictObject({});
export type ApproveMatrixContribution = z.infer<typeof approveMatrixContributionSchema>;

/** MB-1: từ chối đóng góp ma trận — lý do BẮT BUỘC, hiện lại cho người gửi. */
export const rejectMatrixContributionSchema = z.strictObject({
  reason: z.string().min(1),
});
export type RejectMatrixContribution = z.infer<typeof rejectMatrixContributionSchema>;

/** Một dòng hàng chờ đóng góp ma trận (MB-1): truy vết người đóng góp + kết quả duyệt. */
export const examMatrixContributionViewSchema = z.object({
  id: uuidIdSchema,
  matrixId: uuidIdSchema,
  matrixName: z.string().nullable(),
  targetBankId: uuidIdSchema,
  proposerId: uuidIdSchema,
  proposerName: z.string().nullable(),
  note: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  rejectReason: z.string().nullable(),
  reviewerId: uuidIdSchema.nullable(),
  resultMatrixId: uuidIdSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExamMatrixContributionView = z.infer<typeof examMatrixContributionViewSchema>;

/** Khả dụng ngân hàng cho một ô: cần bao nhiêu, có bao nhiêu (ô truefalse đếm theo CHÙM), thiếu bao nhiêu. */
export const matrixCellAvailabilitySchema = z.object({
  cellId: uuidIdSchema,
  required: z.number().int(),
  available: z.number().int(),
  deficit: z.number().int(),
});
export type MatrixCellAvailability = z.infer<typeof matrixCellAvailabilitySchema>;

/** Payload sinh đề từ ma trận: `fixed` = một bộ câu chung; `per_student` = mỗi học sinh rút theo ô lúc bắt đầu lượt. */
export const generateFromMatrixSchema = z.strictObject({
  courseId: uuidIdSchema,
  sectionId: uuidIdSchema,
  name: z.string().min(1),
  drawMode: z.enum(['fixed', 'per_student']),
  timeLimitSeconds: z.number().int().positive().nullable().optional(),
});
export type GenerateFromMatrix = z.infer<typeof generateFromMatrixSchema>;

/** Payload đổi câu của slot: slot cố định đổi `questionId` (ứng viên cùng ô); slot per-student đổi ô nguồn `matrixCellId`. */
export const swapQuizSlotSchema = z.strictObject({
  questionId: uuidIdSchema.optional(),
  matrixCellId: uuidIdSchema.optional(),
});
export type SwapQuizSlot = z.infer<typeof swapQuizSlotSchema>;

/** Payload gom/gỡ chùm Đ–S cho đề dựng tay: đúng 4 slot truefalse cùng một stimulus khi gom. */
export const clusterQuizSlotsSchema = z.strictObject({
  slotIds: z.array(uuidIdSchema).min(1),
});
export type ClusterQuizSlots = z.infer<typeof clusterQuizSlotsSchema>;

/** Payload thêm slot vào đề: đúng một trong `questionId` (câu cố định) hoặc `categoryId` (slot ngẫu nhiên); `maxMark` bỏ trống thì lấy điểm mặc định của câu (slot cố định). `versionMode` (QB-3): bỏ trống thì câu từ bank tổ/trường mặc định `pinned`, còn lại `follow_latest`. */
export const addQuizSlotSchema = z.strictObject({
  questionId: uuidIdSchema.optional(),
  categoryId: uuidIdSchema.optional(),
  maxMark: z.number().positive().optional(),
  page: z.number().int().positive().optional(),
  versionMode: z.enum(['pinned', 'follow_latest']).optional(),
});
export type AddQuizSlot = z.infer<typeof addQuizSlotSchema>;

/** Payload sửa một slot: đổi điểm, trang, vị trí (số thứ tự) trong đề hoặc chế độ version (QB-3 — chuyển sang `pinned` sẽ ghim vào version hiện tại). */
export const updateQuizSlotSchema = z.strictObject({
  maxMark: z.number().positive().optional(),
  page: z.number().int().positive().optional(),
  slot: z.number().int().positive().optional(),
  versionMode: z.enum(['pinned', 'follow_latest']).optional(),
});
export type UpdateQuizSlot = z.infer<typeof updateQuizSlotSchema>;

/** Payload bắt đầu lượt làm quiz; `preview` dành cho giáo viên xem trước đề (không tính lượt, không ghi điểm); `password` là mật khẩu vào thi khi đề/override yêu cầu. */
export const startQuizAttemptSchema = z.strictObject({
  preview: z.boolean().optional(),
  password: z.string().optional(),
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

/** Trạng thái bài nộp của một học sinh trong hoạt động Bài tập nộp tệp/ảnh (mod_assign). */
export const ASSIGN_SUBMISSION_STATUSES = ['none', 'draft', 'submitted', 'graded'] as const;
export type AssignSubmissionStatus = (typeof ASSIGN_SUBMISSION_STATUSES)[number];

/**
 * Chế độ kết quả của bài tập theo TT 22/2021 Điều 5: 'score' = chỉ điểm;
 * 'level' = chỉ mức Đạt/Chưa đạt + nhận xét (nhóm môn chỉ đánh giá bằng
 * nhận xét); 'score_feedback' = điểm kết hợp nhận xét.
 */
export const ASSIGN_RESULT_MODES = ['score', 'level', 'score_feedback'] as const;
export type AssignResultMode = (typeof ASSIGN_RESULT_MODES)[number];

/** Mức kết quả của bài ở chế độ chỉ-nhận-xét (Đạt / Chưa đạt). */
export const ASSIGN_GRADE_LEVELS = ['dat', 'chua_dat'] as const;
export type AssignGradeLevel = (typeof ASSIGN_GRADE_LEVELS)[number];

/** Trạng thái công bố của gói chấm: 'draft' = nháp (HS chưa thấy gì), 'released' = đã trả bài. */
export const ASSIGN_GRADE_STATUSES = ['draft', 'released'] as const;
export type AssignGradeStatus = (typeof ASSIGN_GRADE_STATUSES)[number];

/** Loại dấu chấm vector trên bề mặt bài nộp: đúng / sai / vẽ tay / ghi chú / tô đoạn / khoanh vùng. */
export const ASSIGN_ANNOTATION_KINDS = ['correct', 'incorrect', 'draw', 'note', 'highlight', 'frame'] as const;
export type AssignAnnotationKind = (typeof ASSIGN_ANNOTATION_KINDS)[number];

/** Nhóm của một câu trong ngân hàng lời phê cá nhân, theo cấu trúc lời phê 3 ô + tiến bộ. */
export const ASSIGN_COMMENT_BANK_CATEGORIES = ['strengths', 'weaknesses', 'improvement', 'progress', 'general'] as const;
export type AssignCommentBankCategory = (typeof ASSIGN_COMMENT_BANK_CATEGORIES)[number];

/** View một hoạt động Bài tập nộp tệp/ảnh (mod_assign): cấu hình bài + hạn nộp + quy tắc tệp. */
export const assignmentViewSchema = z.object({
  id: uuidIdSchema,
  courseId: uuidIdSchema,
  cmId: uuidIdSchema.nullable(),
  name: z.string(),
  intro: z.string(),
  /** Hạn nộp (ISO); null = không đặt hạn. Nộp sau hạn vẫn nhận nhưng bị đánh dấu trễ. */
  dueDate: z.string().nullable(),
  /** Số tệp tối đa trong một bài nộp. */
  maxFiles: z.number().int(),
  /** Danh sách đuôi tệp cho phép, cách nhau bằng dấu phẩy (vd "jpg,png,pdf"); null = mọi loại tệp. */
  acceptedFileTypes: z.string().nullable(),
  /** Thang điểm của bài (điểm giáo viên nhập nằm trong [0, grade]). */
  grade: z.number(),
  /** Chế độ kết quả của bài (chỉ điểm / chỉ mức / điểm + nhận xét). */
  resultMode: z.enum(ASSIGN_RESULT_MODES),
});
export type AssignmentView = z.infer<typeof assignmentViewSchema>;

/** Một tệp trong bài nộp: metadata + URL tải đã ký tạm thời để xem toàn màn. */
export const assignSubmissionFileViewSchema = z.object({
  fileId: uuidIdSchema,
  fileName: z.string(),
  fileSize: z.number().int(),
  mimeType: z.string().nullable(),
  contentHash: z.string(),
  signedUrl: z.string(),
  signedUrlExpiresAt: z.number().int(),
});
export type AssignSubmissionFileView = z.infer<typeof assignSubmissionFileViewSchema>;

/**
 * Gói chấm của giáo viên cho bài nộp: điểm/mức + lời phê cấu trúc 3 ô
 * theo TT 22 Điều 5 (tiến bộ / ưu điểm nổi bật / hạn chế chủ yếu) + ô
 * nhận xét chung. status 'draft' = bản nháp chấm (chỉ giáo viên thấy);
 * 'released' = đã trả bài (học sinh thấy, điểm đã vào sổ điểm).
 */
export const assignGradeViewSchema = z.object({
  grade: z.number().nullable(),
  level: z.enum(ASSIGN_GRADE_LEVELS).nullable(),
  feedback: z.string().nullable(),
  feedbackProgress: z.string().nullable(),
  feedbackStrengths: z.string().nullable(),
  feedbackWeaknesses: z.string().nullable(),
  graderId: uuidIdSchema,
  gradedAt: z.string(),
  attemptNumber: z.number().int(),
  status: z.enum(ASSIGN_GRADE_STATUSES),
  releasedAt: z.string().nullable(),
});
export type AssignGradeView = z.infer<typeof assignGradeViewSchema>;

/**
 * Một dấu chấm VECTOR trên bề mặt bài nộp: neo theo (tệp, trang, toạ độ
 * % so với khổ trang); 'draw' mang points là dãy điểm % của nét vẽ.
 * Ảnh gốc không bị đốt dấu — client render lớp dấu đè lên ảnh khi xem.
 */
export const assignAnnotationViewSchema = z.object({
  id: uuidIdSchema,
  submissionId: uuidIdSchema,
  fileId: uuidIdSchema,
  page: z.number().int(),
  x: z.number(),
  y: z.number(),
  kind: z.enum(ASSIGN_ANNOTATION_KINDS),
  color: z.string().nullable(),
  text: z.string().nullable(),
  points: z.array(z.object({ x: z.number(), y: z.number() })).nullable(),
  authorId: uuidIdSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssignAnnotationView = z.infer<typeof assignAnnotationViewSchema>;

/** Một mức thể hiện trong tiêu chí dạng rubric (nhãn + điểm của mức — cấu hình của bài). */
export const assignRubricLevelViewSchema = z.object({
  id: uuidIdSchema,
  label: z.string(),
  score: z.number(),
});
export type AssignRubricLevelView = z.infer<typeof assignRubricLevelViewSchema>;

/**
 * Một tiêu chí của bảng chấm: chế độ 'levels' (chọn mức rubric) hoặc
 * 'score' (marking guide — nhập điểm trong [0, maxScore]); neo YCCĐ qua
 * outcomeId + outcomeText (bản chụp nguyên văn). descriptionForGrader
 * chỉ hiện với người có quyền chấm/quản lý.
 */
export const assignRubricCriterionViewSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  descriptionForStudent: z.string().nullable(),
  descriptionForGrader: z.string().nullable(),
  mode: z.enum(['levels', 'score']),
  maxScore: z.number().nullable(),
  outcomeId: z.string().nullable(),
  outcomeText: z.string().nullable(),
  levels: z.array(assignRubricLevelViewSchema),
});
export type AssignRubricCriterionView = z.infer<typeof assignRubricCriterionViewSchema>;

/** Bảng chấm của một bài tập (tối đa một bảng/bài), công khai cho học sinh trước khi nộp. */
export const assignRubricViewSchema = z.object({
  id: uuidIdSchema,
  assignmentId: uuidIdSchema,
  title: z.string().nullable(),
  criteria: z.array(assignRubricCriterionViewSchema),
});
export type AssignRubricView = z.infer<typeof assignRubricViewSchema>;

/** Kết quả chấm theo một tiêu chí trong gói chấm: mức đã chọn / điểm đã nhập + nhận xét riêng. */
export const assignRubricEvaluationViewSchema = z.object({
  criterionId: uuidIdSchema,
  levelId: uuidIdSchema.nullable(),
  score: z.number().nullable(),
  note: z.string().nullable(),
});
export type AssignRubricEvaluationView = z.infer<typeof assignRubricEvaluationViewSchema>;

/** Một dòng vết kiểm toán khi gói chấm đã trả bị sửa: giá trị điểm/mức trước và sau. */
export const assignGradeRevisionViewSchema = z.object({
  id: uuidIdSchema,
  actorId: uuidIdSchema,
  createdAt: z.string(),
  previousGrade: z.number().nullable(),
  newGrade: z.number().nullable(),
  previousLevel: z.enum(ASSIGN_GRADE_LEVELS).nullable(),
  newLevel: z.enum(ASSIGN_GRADE_LEVELS).nullable(),
});
export type AssignGradeRevisionView = z.infer<typeof assignGradeRevisionViewSchema>;

/** Một tin nhắn trong hội thoại phản hồi trên bài đã trả (học sinh ↔ giáo viên). */
export const assignFeedbackMessageViewSchema = z.object({
  id: uuidIdSchema,
  authorId: uuidIdSchema,
  body: z.string(),
  createdAt: z.string(),
});
export type AssignFeedbackMessageView = z.infer<typeof assignFeedbackMessageViewSchema>;

/**
 * Bài nộp của chính người xem: trạng thái theo hạn, các tệp và — CHỈ KHI
 * đã trả bài — gói chấm + annotation + kết quả rubric + hội thoại phản
 * hồi. Khi giáo viên còn chấm nháp, các trường này rỗng/null.
 */
export const assignOwnSubmissionViewSchema = z.object({
  submissionId: uuidIdSchema.nullable(),
  status: z.enum(ASSIGN_SUBMISSION_STATUSES),
  attemptNumber: z.number().int(),
  submittedAt: z.string().nullable(),
  /** Đã nộp nhưng sau hạn nộp. */
  late: z.boolean(),
  files: z.array(assignSubmissionFileViewSchema),
  grade: assignGradeViewSchema.nullable(),
  annotations: z.array(assignAnnotationViewSchema),
  rubricEvaluations: z.array(assignRubricEvaluationViewSchema),
  feedbackMessages: z.array(assignFeedbackMessageViewSchema),
});
export type AssignOwnSubmissionView = z.infer<typeof assignOwnSubmissionViewSchema>;

/** View bài tập cho một người xem: cấu hình + bài nộp của chính mình + bảng chấm công khai + các cờ quyền đã phân giải tại context của module. */
export const assignmentForUserViewSchema = z.object({
  assignment: assignmentViewSchema,
  mySubmission: assignOwnSubmissionViewSchema,
  rubric: assignRubricViewSchema.nullable(),
  canSubmit: z.boolean(),
  canManage: z.boolean(),
  canGrade: z.boolean(),
  canViewAllSubmissions: z.boolean(),
});
export type AssignmentForUserView = z.infer<typeof assignmentForUserViewSchema>;

/** Một dòng trong danh sách bài nộp của giáo viên: mọi học sinh đã ghi danh, kể cả người chưa nộp. */
export const assignSubmissionSummarySchema = z.object({
  userId: uuidIdSchema,
  /** Tên hiển thị của học sinh (họ tên, thiếu thì username) — bề mặt chấm của giáo viên phải đọc được ai là ai. */
  displayName: z.string(),
  status: z.enum(ASSIGN_SUBMISSION_STATUSES),
  attemptNumber: z.number().int(),
  submittedAt: z.string().nullable(),
  late: z.boolean(),
  fileCount: z.number().int(),
  grade: z.number().nullable(),
  level: z.enum(ASSIGN_GRADE_LEVELS).nullable(),
  feedback: z.string().nullable(),
  /** Trạng thái gói chấm phía giáo viên: chưa chấm / đang nháp / đã trả bài. */
  gradeStatus: z.enum(['none', 'draft', 'released']),
});
export type AssignSubmissionSummary = z.infer<typeof assignSubmissionSummarySchema>;

/** Chi tiết một bài nộp cho giáo viên chấm: tệp kèm URL đã ký + gói chấm (kể cả nháp) + annotation + rubric + vết sửa sau trả + hội thoại. */
export const assignSubmissionDetailSchema = z.object({
  userId: uuidIdSchema,
  status: z.enum(ASSIGN_SUBMISSION_STATUSES),
  attemptNumber: z.number().int(),
  submittedAt: z.string().nullable(),
  late: z.boolean(),
  files: z.array(assignSubmissionFileViewSchema),
  grade: assignGradeViewSchema.nullable(),
  annotations: z.array(assignAnnotationViewSchema),
  rubricEvaluations: z.array(assignRubricEvaluationViewSchema),
  revisions: z.array(assignGradeRevisionViewSchema),
  feedbackMessages: z.array(assignFeedbackMessageViewSchema),
});
export type AssignSubmissionDetail = z.infer<typeof assignSubmissionDetailSchema>;

/** Payload tạo bài tập nộp tệp/ảnh trong một section (kèm course module + grade item ở tầng nghiệp vụ). */
export const createAssignmentSchema = z.strictObject({
  sectionId: uuidIdSchema,
  name: z.string().min(1),
  intro: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  maxFiles: z.number().int().min(1).max(50).optional(),
  acceptedFileTypes: z.string().nullable().optional(),
  grade: z.number().positive().optional(),
  resultMode: z.enum(ASSIGN_RESULT_MODES).optional(),
});
export type CreateAssignment = z.infer<typeof createAssignmentSchema>;

/** Payload sửa cài đặt bài tập (mọi trường tuỳ chọn; `dueDate`/`acceptedFileTypes` nhận `null` để gỡ). */
export const updateAssignmentSchema = z.strictObject({
  name: z.string().min(1).optional(),
  intro: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  maxFiles: z.number().int().min(1).max(50).optional(),
  acceptedFileTypes: z.string().nullable().optional(),
  grade: z.number().positive().optional(),
  resultMode: z.enum(ASSIGN_RESULT_MODES).optional(),
});
export type UpdateAssignment = z.infer<typeof updateAssignmentSchema>;

/** Kết quả chấm theo một tiêu chí trong payload lưu gói chấm. */
export const assignRubricEvaluationInputSchema = z.strictObject({
  criterionId: uuidIdSchema,
  levelId: uuidIdSchema.nullable().optional(),
  score: z.number().min(0).nullable().optional(),
  note: z.string().nullable().optional(),
});
export type AssignRubricEvaluationInput = z.infer<typeof assignRubricEvaluationInputSchema>;

/**
 * Payload LƯU gói chấm (bản nháp — chưa công bố): điểm (theo thang bài)
 * hoặc mức (chế độ chỉ-nhận-xét), lời phê cấu trúc 3 ô + nhận xét chung,
 * kết quả theo tiêu chí rubric. Mọi trường tuỳ chọn: nháp được phép dở
 * dang; tính đầy đủ theo chế độ kết quả chỉ bắt buộc tại thời điểm TRẢ
 * BÀI. Nếu có evaluations mà không gửi grade, điểm được suy từ rubric
 * (tổng điểm tiêu chí quy về thang bài) — giáo viên vẫn ghi đè được.
 */
export const gradeAssignmentSubmissionSchema = z.strictObject({
  grade: z.number().min(0).optional(),
  level: z.enum(ASSIGN_GRADE_LEVELS).nullable().optional(),
  feedback: z.string().optional(),
  feedbackProgress: z.string().nullable().optional(),
  feedbackStrengths: z.string().nullable().optional(),
  feedbackWeaknesses: z.string().nullable().optional(),
  evaluations: z.array(assignRubricEvaluationInputSchema).optional(),
});
export type GradeAssignmentSubmission = z.infer<typeof gradeAssignmentSubmissionSchema>;

/** Payload trả bài theo đợt: không gửi userIds = trả mọi gói chấm nháp đã đầy đủ của bài. */
export const releaseAssignmentGradesSchema = z.strictObject({
  userIds: z.array(uuidIdSchema).optional(),
});
export type ReleaseAssignmentGrades = z.infer<typeof releaseAssignmentGradesSchema>;

/** Kết quả một đợt trả bài: số gói chấm đã công bố + các học sinh bị bỏ qua (nháp chưa đầy đủ/chưa chấm). */
export const releaseAssignmentResultSchema = z.object({
  releasedCount: z.number().int(),
  skippedUserIds: z.array(uuidIdSchema),
});
export type ReleaseAssignmentResult = z.infer<typeof releaseAssignmentResultSchema>;

/** Payload tạo một dấu chấm vector trên tệp của bài nộp (toạ độ % so với khổ trang). */
export const createAssignAnnotationSchema = z.strictObject({
  fileId: uuidIdSchema,
  page: z.number().int().min(1).optional(),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  kind: z.enum(ASSIGN_ANNOTATION_KINDS),
  color: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  points: z.array(z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) })).max(2000).nullable().optional(),
});
export type CreateAssignAnnotation = z.infer<typeof createAssignAnnotationSchema>;

/** Payload sửa một dấu chấm (dời vị trí, đổi nội dung/màu/nét vẽ). */
export const updateAssignAnnotationSchema = z.strictObject({
  page: z.number().int().min(1).optional(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
  color: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  points: z.array(z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) })).max(2000).nullable().optional(),
});
export type UpdateAssignAnnotation = z.infer<typeof updateAssignAnnotationSchema>;

/** Một tiêu chí trong payload dựng bảng chấm (thay toàn bộ bảng — replace-all). */
export const assignRubricCriterionInputSchema = z.strictObject({
  name: z.string().min(1),
  descriptionForStudent: z.string().nullable().optional(),
  descriptionForGrader: z.string().nullable().optional(),
  mode: z.enum(['levels', 'score']),
  maxScore: z.number().positive().nullable().optional(),
  outcomeId: z.string().nullable().optional(),
  outcomeText: z.string().nullable().optional(),
  levels: z.array(z.strictObject({
    label: z.string().min(1),
    score: z.number().min(0),
  })).optional(),
});
export type AssignRubricCriterionInput = z.infer<typeof assignRubricCriterionInputSchema>;

/** Payload dựng/cập nhật bảng chấm của bài (tiêu chí phải tồn tại trước khi chấm — TT 22 Điều 7). */
export const upsertAssignRubricSchema = z.strictObject({
  title: z.string().nullable().optional(),
  criteria: z.array(assignRubricCriterionInputSchema).min(1).max(30),
});
export type UpsertAssignRubric = z.infer<typeof upsertAssignRubricSchema>;

/** Payload gửi một tin nhắn trong hội thoại phản hồi trên bài đã trả. */
export const createAssignFeedbackMessageSchema = z.strictObject({
  body: z.string().min(1),
});
export type CreateAssignFeedbackMessage = z.infer<typeof createAssignFeedbackMessageSchema>;

/** Một câu trong ngân hàng lời phê cá nhân của giáo viên. */
export const teacherCommentBankEntryViewSchema = z.object({
  id: uuidIdSchema,
  category: z.enum(ASSIGN_COMMENT_BANK_CATEGORIES).nullable(),
  text: z.string(),
  createdAt: z.string(),
});
export type TeacherCommentBankEntryView = z.infer<typeof teacherCommentBankEntryViewSchema>;

/** Payload thêm một câu vào ngân hàng lời phê cá nhân (kể cả lưu nhanh từ câu vừa gõ khi chấm). */
export const createTeacherCommentBankEntrySchema = z.strictObject({
  text: z.string().min(1),
  category: z.enum(ASSIGN_COMMENT_BANK_CATEGORIES).nullable().optional(),
});
export type CreateTeacherCommentBankEntry = z.infer<typeof createTeacherCommentBankEntrySchema>;
// --- Ngân hàng câu hỏi chung (feat issue #70: QB-1 → QB-4) ---------------------

/** Năm scope của một bank câu hỏi: cá nhân / tổ chuyên môn / trường / khoá / platform (Ngân hàng hệ thống — TENANT-0, #168; bank platform chỉ platform tạo, tenant_id = NULL). */
export const QUESTION_BANK_SCOPES = ['personal', 'team', 'school', 'course', 'platform'] as const;

/** Payload tạo bank: `scopeRefId` là cohort (team) hoặc course (course); `leaderId` là tổ trưởng của bank tổ (mặc định người tạo). */
/** Loại món của bank đa loại (bank_kind): question là mặc định của feat Ngân hàng câu hỏi chung; exam/matrix dùng chung khuôn bank. */
export const QUESTION_BANK_KINDS = ['question', 'exam', 'matrix'] as const;
export const createQuestionBankSchema = z.strictObject({
  name: z.string().min(1),
  scope: z.enum(QUESTION_BANK_SCOPES),
  bankKind: z.enum(QUESTION_BANK_KINDS).optional(),
  scopeRefId: uuidIdSchema.optional(),
  leaderId: uuidIdSchema.optional(),
});
export type CreateQuestionBank = z.infer<typeof createQuestionBankSchema>;

/** Payload copy một câu: đích mặc định là ngân hàng cá nhân của người copy ("Copy về ngân hàng của tôi"). */
export const copyQuestionSchema = z.strictObject({
  targetBankId: uuidIdSchema.optional(),
  targetCategoryId: uuidIdSchema.optional(),
  name: z.string().min(1).optional(),
});
export type CopyQuestion = z.infer<typeof copyQuestionSchema>;

/** Payload copy hàng loạt (tối đa 100 câu một lượt). */
export const copyQuestionsBatchSchema = z.strictObject({
  questionIds: z.array(uuidIdSchema).min(1).max(100),
  targetBankId: uuidIdSchema.optional(),
  targetCategoryId: uuidIdSchema.optional(),
});
export type CopyQuestionsBatch = z.infer<typeof copyQuestionsBatchSchema>;

/** Payload rút câu khỏi bank chung: lý do bắt buộc (QB-3). */
export const withdrawQuestionSchema = z.strictObject({
  reason: z.string().min(1),
});
export type WithdrawQuestion = z.infer<typeof withdrawQuestionSchema>;

/** Chế độ version của slot đề thi (QB-3): ghim cứng hoặc theo version mới nhất. */
export const QUIZ_SLOT_VERSION_MODES = ['pinned', 'follow_latest'] as const;

/**
 * Payload đề xuất đóng góp câu vào bank đích (QB-4): `mode` = 'new' (câu
 * mới vào bank đích) hoặc 'update' (bản mới cho câu đã có ở bank đích —
 * bắt buộc `targetQuestionId` và câu nguồn phải là bản copy suy từ câu đích).
 */
export const createContributionSchema = z.strictObject({
  questionId: uuidIdSchema,
  note: z.string().optional(),
  mode: z.enum(['new', 'update']).optional(),
  targetQuestionId: uuidIdSchema.optional(),
});
export type CreateContribution = z.infer<typeof createContributionSchema>;

/** Payload duyệt một đề xuất đóng góp: có thể chỉ định category đích trong bank (mặc định category mặc định của bank). */
export const approveContributionSchema = z.strictObject({
  targetCategoryId: uuidIdSchema.optional(),
});
export type ApproveContribution = z.infer<typeof approveContributionSchema>;

/** Payload từ chối đề xuất đóng góp: lý do bắt buộc để giáo viên sửa và đề xuất lại. */
export const rejectContributionSchema = z.strictObject({
  reason: z.string().min(1),
});
export type RejectContribution = z.infer<typeof rejectContributionSchema>;

/**
 * Payload đặt chính sách công bố (posting policy) cho một grade item —
 * PH-0, issue #116, theo Canvas Grade Posting Policy: `auto` = điểm/lời phê
 * hiện phía học sinh ngay khi chấm (mặc định, giữ hành vi hiện hữu);
 * `manual` = ẩn hoàn toàn cho tới khi giáo viên bấm công bố cho item.
 */
export const setGradePostingPolicySchema = z.strictObject({
  policy: z.enum(['auto', 'manual']),
});
export type SetGradePostingPolicy = z.infer<typeof setGradePostingPolicySchema>;

/** Payload công bố / rút công bố (theo item, theo kết quả kì/năm của một học sinh): ghi chú tuỳ chọn lưu vào vết công bố. */
export const gradePublicationActionSchema = z.strictObject({
  note: z.string().max(500).optional(),
});
export type GradePublicationAction = z.infer<typeof gradePublicationActionSchema>;

/**
 * Payload tạo liên kết giám hộ PH–HS (PH-0, issue #116): liên kết do
 * GV/admin xác lập theo hồ sơ giám hộ đã xác minh (TT 22 Đ.20.6, NĐ
 * 13/2023 Đ.20) — `relationship` là quan hệ với học sinh (cha/mẹ/người
 * giám hộ...); `note` ghi nguồn xác minh khi cần truy vết.
 */
export const createGuardianLinkSchema = z.strictObject({
  guardianUserId: uuidIdSchema,
  studentUserId: uuidIdSchema,
  relationship: z.string().min(1).max(100),
  note: z.string().max(500).optional(),
});
export type CreateGuardianLink = z.infer<typeof createGuardianLinkSchema>;
// --- Ngân hàng đề (feat issue #113: EB-1) ---------------------------------------

/** Hai dạng tồn tại của một đề: snapshot (bản chụp câu cụ thể, ghim version) / recipe (công thức theo ma trận — EB-2). Lát EB-1 chỉ snapshot sống. */
export const EXAM_PAPER_KINDS = ['snapshot', 'recipe'] as const;

/** Loại kiểm tra của đề theo nghiệp vụ VN: thường xuyên / giữa kỳ / cuối kỳ / thi thử / ôn tập. */
export const EXAM_PAPER_EXAM_KINDS = ['regular', 'midterm', 'final', 'mock', 'practice'] as const;

/** Trạng thái vòng đời của một đề trong ngân hàng (như câu hỏi): draft / ready / hidden. */
export const EXAM_PAPER_STATUSES = ['draft', 'ready', 'hidden'] as const;

/**
 * Một slot trong payload soạn đề: câu được chọn từ ngân hàng câu hỏi;
 * version ghim được server phân giải tại thời điểm lưu (mặc định version
 * ready mới nhất — kỷ luật QB-3). `section` là tên phần (Phần I/II…)
 * để chia phần trong đề; `clusterId` gom các slot truefalse cùng chùm Đ–S.
 */
export const examPaperSlotInputSchema = z.strictObject({
  questionId: uuidIdSchema,
  maxMark: z.number().positive().optional(),
  section: z.string().max(200).optional(),
  clusterId: uuidIdSchema.nullable().optional(),
});
export type ExamPaperSlotInput = z.infer<typeof examPaperSlotInputSchema>;

/** Payload tạo đề snapshot trong một bank đề (bankKind='exam'): metadata + danh sách slot tuỳ chọn (rỗng = đề trắng). */
export const createExamPaperSchema = z.strictObject({
  name: z.string().min(1),
  subjectId: uuidIdSchema.nullable().optional(),
  grade: z.number().int().min(1).max(12).nullable().optional(),
  examKind: z.enum(EXAM_PAPER_EXAM_KINDS).nullable().optional(),
  totalScore: z.number().positive().optional(),
  durationMinutes: z.number().int().positive().nullable().optional(),
  tfScale: z.array(z.number()).length(5).nullable().optional(),
  matrixId: uuidIdSchema.nullable().optional(),
  slots: z.array(examPaperSlotInputSchema).max(500).optional(),
});
export type CreateExamPaper = z.infer<typeof createExamPaperSchema>;

/** Payload sửa metadata của đề — mỗi lần sửa tạo một paper version mới (slots giữ nguyên từ version hiện tại nếu không gửi kèm). */
export const updateExamPaperSchema = z.strictObject({
  name: z.string().min(1).optional(),
  subjectId: uuidIdSchema.nullable().optional(),
  grade: z.number().int().min(1).max(12).nullable().optional(),
  examKind: z.enum(EXAM_PAPER_EXAM_KINDS).nullable().optional(),
  totalScore: z.number().positive().optional(),
  durationMinutes: z.number().int().positive().nullable().optional(),
  tfScale: z.array(z.number()).length(5).nullable().optional(),
  matrixId: uuidIdSchema.nullable().optional(),
});
export type UpdateExamPaper = z.infer<typeof updateExamPaperSchema>;

/** Payload thay toàn bộ danh sách slot của đề — tạo paper version mới với đúng danh sách này. */
export const setExamPaperSlotsSchema = z.strictObject({
  slots: z.array(examPaperSlotInputSchema).max(500),
});
export type SetExamPaperSlots = z.infer<typeof setExamPaperSlotsSchema>;

/** Payload đổi trạng thái vòng đời của đề. */
export const setExamPaperStatusSchema = z.strictObject({
  status: z.enum(EXAM_PAPER_STATUSES),
});
export type SetExamPaperStatus = z.infer<typeof setExamPaperStatusSchema>;

/** Payload copy một đề sang bank đích (mặc định ngân hàng đề cá nhân của người copy): deep copy slots, question + pinned version giữ nguyên. */
export const copyExamPaperSchema = z.strictObject({
  targetBankId: uuidIdSchema.optional(),
  name: z.string().min(1).optional(),
});
export type CopyExamPaper = z.infer<typeof copyExamPaperSchema>;

/** Payload đề xuất đóng góp một đề vào bank đích (khuôn QB-4, chỉ mode 'new': duyệt đạt thì deep copy vào bank đích). */
export const createExamPaperContributionSchema = z.strictObject({
  paperId: uuidIdSchema,
  note: z.string().optional(),
});
export type CreateExamPaperContribution = z.infer<typeof createExamPaperContributionSchema>;

/** Payload duyệt đề xuất đóng góp đề (không tham số — bản copy vào bank đích mang tên + truy vết của đề nguồn). */
export const approveExamPaperContributionSchema = z.strictObject({});
export type ApproveExamPaperContribution = z.infer<typeof approveExamPaperContributionSchema>;

/** Payload từ chối đề xuất đóng góp đề: lý do bắt buộc. */
export const rejectExamPaperContributionSchema = z.strictObject({
  reason: z.string().min(1),
});
export type RejectExamPaperContribution = z.infer<typeof rejectExamPaperContributionSchema>;

/**
 * Payload triển khai một đề (paper version hiện tại) vào một quiz: slots
 * của đề được chụp sang `quiz_slots` của quiz và quiz ghim paper
 * version. Quiz đã có slots dựng tay thì phải `replace: true` tường minh.
 */
export const deployExamPaperSchema = z.strictObject({
  quizId: uuidIdSchema,
  replace: z.boolean().optional(),
  /**
   * Số mã đề (variant) sinh cho lần triển khai này ở tầng deployment
   * (EB-2, điểm E-5): mỗi mã 001, 002… kèm seed hoán vị để in/chấm
   * khớp. Bỏ trống = 1 mã duy nhất.
   */
  variantCount: z.number().int().min(1).max(50).optional(),
});
export type DeployExamPaper = z.infer<typeof deployExamPaperSchema>;

/**
 * Payload chụp (materialize) một đề RECIPE xuống SNAPSHOT (EB-2, điểm
 * D.3): recipe không sửa tay trực tiếp — sửa là chụp thành snapshot
 * mới (derived_from trỏ về recipe + matrix version) rồi sửa trên
 * snapshot. `name` bỏ trống thì lấy tên recipe kèm hậu tố "bản chụp".
 */
export const materializeExamPaperSchema = z.strictObject({
  name: z.string().min(1).optional(),
});
export type MaterializeExamPaper = z.infer<typeof materializeExamPaperSchema>;

/**
 * Payload đổi câu của một slot snapshot BẰNG SWAP-CÙNG-Ô (EB-2, điểm
 * D.3): slot đích (theo `position`) phải mang ô ma trận nguồn; câu thay
 * phải thuộc pool của chính ô đó (cùng YCCĐ + mức + dạng). Điểm của
 * slot giữ nguyên nên tỉ lệ ô chỉ lệch khi cấu trúc bị sửa bằng đường
 * khác — báo cáo lệch tỉ lệ đi kèm chi tiết đề.
 */
export const swapExamPaperSlotSchema = z.strictObject({
  position: z.number().int().positive(),
  questionId: uuidIdSchema,
});
export type SwapExamPaperSlot = z.infer<typeof swapExamPaperSlotSchema>;

// --- Bộ hồ sơ duyệt đề (feat issue #165: EB-3) ----------------------------------

/**
 * Trạng thái vòng đời của một BỘ HỒ SƠ duyệt đề: `draft` (giáo viên
 * đang lập, chưa nộp) → `pending` (chờ cấp duyệt 1 — tổ trưởng/người
 * có exam:moderate tại bank đích) → `pending_board` (chỉ khi cấu hình
 * trường bật cấp duyệt 2: đã qua cấp 1, chờ ban giám hiệu) →
 * `approved` (bộ đã hiệu lực, đề đã vào bank đích) / `rejected` (bị
 * từ chối ở một cấp, kèm lý do bắt buộc).
 */
export const EXAM_DOSSIER_STATUSES = ['draft', 'pending', 'pending_board', 'approved', 'rejected'] as const;
export type ExamDossierStatus = (typeof EXAM_DOSSIER_STATUSES)[number];

/**
 * Payload lập bộ hồ sơ cho một đề: đích là một bank đề dùng chung
 * (tổ/trường/khoá). Bộ hồ sơ chỉ ở trạng thái nháp sau bước này —
 * version của đề + ma trận được GHIM tại lúc nộp (submit), không phải
 * lúc lập, để giáo viên chốt bản cuối mới nộp.
 */
export const createExamDossierSchema = z.strictObject({
  targetBankId: uuidIdSchema,
  note: z.string().max(1000).optional(),
});
export type CreateExamDossier = z.infer<typeof createExamDossierSchema>;

/** Payload duyệt bộ hồ sơ (áp cho cả hai cấp — cấp do endpoint quyết định: approve = cấp 1, board-approve = cấp 2). */
export const approveExamDossierSchema = z.strictObject({});
export type ApproveExamDossier = z.infer<typeof approveExamDossierSchema>;

/** Payload từ chối bộ hồ sơ ở một cấp duyệt: lý do BẮT BUỘC để người đóng góp sửa và nộp lại (chuỗi toàn khoảng trắng không tính là lý do). */
export const rejectExamDossierSchema = z.strictObject({
  reason: z.string().trim().min(1),
});
export type RejectExamDossier = z.infer<typeof rejectExamDossierSchema>;

/** Một mốc duyệt trong vết của bộ hồ sơ: mỗi cấp duyệt là một bản ghi độc lập (người duyệt, quyết định, lý do, thời điểm). */
export const examDossierReviewViewSchema = z.object({
  id: z.string(),
  dossierId: z.string(),
  level: z.number().int(),
  reviewerId: z.string(),
  reviewerName: z.string().nullable(),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type ExamDossierReviewView = z.infer<typeof examDossierReviewViewSchema>;

/**
 * View bộ hồ sơ như API trả về: bộ ba đã ghim (phiên bản đề + phiên
 * bản ma trận + bản đặc tả chụp tại lúc nộp — đặc tả đọc qua endpoint
 * riêng), truy vết hai đầu (người đóng góp, đề kết quả trong bank
 * đích) và toàn bộ vết duyệt theo cấp.
 */
export const examDossierViewSchema = z.object({
  id: z.string(),
  paperId: z.string(),
  paperName: z.string().nullable(),
  sourceBankId: z.string().nullable(),
  targetBankId: z.string(),
  proposerId: z.string(),
  proposerName: z.string().nullable(),
  note: z.string(),
  status: z.enum(EXAM_DOSSIER_STATUSES),
  paperVersionId: z.string().nullable(),
  paperVersionNumber: z.number().nullable(),
  matrixId: z.string().nullable(),
  matrixName: z.string().nullable(),
  matrixVersion: z.number().nullable(),
  /** Cấu hình cấp duyệt 2 (BGH) hiệu lực tại lúc đọc — khi true và bộ đang `pending`, duyệt cấp 1 chỉ đưa bộ sang `pending_board`. */
  boardApprovalRequired: z.boolean(),
  resultPaperId: z.string().nullable(),
  reviews: z.array(examDossierReviewViewSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExamDossierView = z.infer<typeof examDossierViewSchema>;
// ---------------------------------------------------------------------------
// Chấm bài giấy bằng camera (CAM-0, issue #112): phiếu trả lời in từ quiz,
// OMR xác định phía server, hai hàng chờ (gán định danh / xác nhận ca mơ hồ)
// và attempt "thi giấy" chảy vào Quiz. OMR chỉ trả "ô nào được tô" — việc
// chấm (kể cả thang Đ–S chùm) là của engine Quiz như attempt online.

/** Trạng thái một phiếu đã quét: chờ gán định danh → chờ xác nhận mơ hồ → sẵn sàng ghi → đã ghi thành attempt. */
export const PAPER_SCAN_STATUSES = ['needs_identity', 'needs_review', 'ready', 'recorded'] as const;
export type PaperScanStatus = (typeof PAPER_SCAN_STATUSES)[number];

/** Nguồn định danh của phiếu: QR cá nhân hoá, ô tô mã học sinh, hoặc giáo viên gán tay trong hàng chờ. */
export const PAPER_IDENTITY_SOURCES = ['qr', 'bubbles', 'manual'] as const;
export type PaperIdentitySource = (typeof PAPER_IDENTITY_SOURCES)[number];

/** Một dòng của đề đã ghim tại thời điểm sinh phiếu: version câu + đáp án của version đó theo đúng thứ tự in trên phiếu. */
export const paperSlotLayoutSchema = z.object({
  slot: z.number().int(),
  questionId: uuidIdSchema,
  versionId: uuidIdSchema,
  qtype: z.string(),
  /** Số bong bóng in cho câu này (= số đáp án của version đã ghim; đúng/sai = 2). */
  optionCount: z.number().int(),
  /** Đáp án của version đã ghim theo thứ tự in — chỉ phía giáo viên (chấm giấy) mới nhận trường này. */
  answerIds: z.array(uuidIdSchema),
  /** Điểm tối đa của slot tại thời điểm sinh phiếu (snapshot như attempt online). */
  maxMark: z.number(),
  clusterId: uuidIdSchema.nullable(),
});
export type PaperSlotLayout = z.infer<typeof paperSlotLayoutSchema>;

/** Một học sinh trong roster chụp tại lúc sinh lô phiếu: mã tô cho phiếu dùng chung (4 số tại lớp — 3 số thứ tự + 1 số kiểm tra; hoặc 8 số thi thử — 7 số thứ tự + 1 số kiểm tra, đúng độ dài SBD của Bộ). */
export const paperRosterEntrySchema = z.object({
  code: z.string(),
  userId: uuidIdSchema,
  displayName: z.string(),
});
export type PaperRosterEntry = z.infer<typeof paperRosterEntrySchema>;

/** Một lô IN phiếu (một mã đề) của một quiz: layout đã ghim + roster tại thời điểm sinh. Lô in khác lô chụp: một buổi chụp gồm nhiều lô in (mỗi mã đề một lô), phiếu được định tuyến về lô in theo mã đề đọc từ phiếu. */
export const paperBatchSchema = z.object({
  id: uuidIdSchema,
  quizId: uuidIdSchema,
  variantCode: z.string(),
  /** Mã đề 4 số giống Bộ của variant này (giao diện khớp variant_code của tầng triển khai đề); học sinh ghi + tô mã này lên phiếu dùng chung. Null với các lô sinh trước khi có mã đề số. */
  examCode: z.string().nullable(),
  /** Số cột của lưới mã học sinh trên phiếu của lô: 4 (tại lớp) hoặc 8 (thi thử theo phòng, định dạng SBD). */
  codeDigits: z.number().int(),
  layout: z.array(paperSlotLayoutSchema),
  roster: z.array(paperRosterEntrySchema),
  createdBy: uuidIdSchema,
  createdAt: z.string(),
});
export type PaperBatch = z.infer<typeof paperBatchSchema>;

/** Payload sinh lô phiếu: mã đề chữ tuỳ chọn (mặc định hệ thống tự đánh A, B, C… theo thứ tự lô của quiz); mã đề số 4 số tuỳ chọn (mặc định hệ thống tự cấp dãy từ 1001); số cột lưới mã học sinh tuỳ chọn (mặc định 4 = tại lớp; 8 = thi thử SBD). */
export const createPaperBatchSchema = z.strictObject({
  variantCode: z.string().min(1).max(8).optional(),
  examCode: z.string().regex(/^\d{4}$/).optional(),
  codeDigits: z.union([z.literal(4), z.literal(8)]).optional(),
});
export type CreatePaperBatch = z.infer<typeof createPaperBatchSchema>;

/** Kết quả đọc một câu trên phiếu: mật độ mực từng ô, ô được chọn (null = trống/chưa quyết), trạng thái quyết định. */
export const paperReadingSchema = z.object({
  slot: z.number().int(),
  densities: z.array(z.number()),
  chosen: z.number().int().nullable(),
  state: z.enum(['filled', 'blank', 'ambiguous']),
  /** Chênh mật độ giữa ô đậm nhất và ô nhì — nhỏ là dấu hiệu mơ hồ. */
  margin: z.number(),
  /** Ai đã quyết ô chọn cuối: OMR tự quyết hay giáo viên xác nhận trong hàng chờ. */
  resolvedBy: z.enum(['omr', 'teacher']).nullable(),
});
export type PaperReading = z.infer<typeof paperReadingSchema>;

/** Số đo cổng chất lượng ảnh của một phiếu đã quét. */
export const paperQualitySchema = z.object({
  blurVariance: z.number(),
  glareRatio: z.number(),
  fiducialCount: z.number().int(),
});
export type PaperQuality = z.infer<typeof paperQualitySchema>;

/** Một phiếu đã quét như API trả cho giáo viên: ảnh gốc + ảnh đã nắn phẳng (file trong module files), kết quả đọc và trạng thái hàng chờ. */
export const paperRowGeometrySchema = z.object({
  slot: z.number().int().positive(),
  /** Tâm bong bóng trong không gian template 1240×1754 của ảnh đã nắn (warpedFileId). */
  centers: z.array(z.object({ x: z.number(), y: z.number() })),
});
export type PaperRowGeometry = z.infer<typeof paperRowGeometrySchema>;

/** Một vùng cắt trên ảnh đã nắn phẳng (không gian template 1240×1754) — web cắt vùng này để giáo viên đối chiếu khi xử lý hàng chờ. */
export const paperRegionSchema = z.object({
  x: z.number(), y: z.number(), w: z.number(), h: z.number(),
});
export type PaperRegion = z.infer<typeof paperRegionSchema>;

/** Các vùng cắt phục vụ hàng chờ định danh: vùng họ tên viết tay, vùng lưới mã học sinh, vùng ghi + tô mã đề. */
export const paperScanRegionsSchema = z.object({
  name: paperRegionSchema,
  studentCode: paperRegionSchema,
  variantCode: paperRegionSchema,
});
export type PaperScanRegions = z.infer<typeof paperScanRegionsSchema>;

export const paperScanSchema = z.object({
  id: uuidIdSchema,
  quizId: uuidIdSchema,
  /** Lô in mà phiếu thuộc về (theo mã đề đọc được / QR / giáo viên gán); null khi phiếu chưa định tuyến được về lô in nào — phiếu nằm ở hàng chờ gán lô. */
  batchId: uuidIdSchema.nullable(),
  /** Lô chụp (một lượt tải ảnh của một buổi) chứa phiếu này; mọi phiếu trong cùng lượt tải mang cùng mã. */
  sessionId: uuidIdSchema.nullable(),
  status: z.enum(PAPER_SCAN_STATUSES),
  studentId: uuidIdSchema.nullable(),
  studentName: z.string().nullable(),
  identitySource: z.enum(PAPER_IDENTITY_SOURCES).nullable(),
  identityCode: z.string().nullable(),
  /** Mã đề 4 số hiệu lực của phiếu: đọc chắc chắn từ lưới tô mã đề, hoặc giáo viên xác nhận khi gán lô (bản đọc gốc của máy được giữ trong event log). Null khi không tô/không chắc chắn và chưa được xác nhận — hệ thống không đoán mã đề. */
  variantCodeRead: z.string().nullable(),
  fileId: uuidIdSchema,
  warpedFileId: uuidIdSchema.nullable(),
  /** Hình học lưới của lô (theo layout lúc sinh phiếu) để web cắt vùng từng câu trên ảnh đã nắn; rỗng khi phiếu chưa gắn lô in. */
  rows: z.array(paperRowGeometrySchema),
  /** Ứng viên gợi ý cho hàng chờ định danh: học sinh trong roster của lô in CHƯA khớp phiếu nào, theo đúng thứ tự roster (kiêm gợi ý theo thứ tự thu bài). */
  identityCandidates: z.array(paperRosterEntrySchema),
  /** Vùng cắt vùng mã + vùng tên trên ảnh đã nắn, cho giáo viên đối chiếu khi gán định danh. */
  regions: paperScanRegionsSchema,
  quality: paperQualitySchema.nullable(),
  readings: z.array(paperReadingSchema),
  attemptId: uuidIdSchema.nullable(),
  uploadedBy: uuidIdSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PaperScan = z.infer<typeof paperScanSchema>;

/** Payload gán định danh trong hàng chờ: giáo viên chọn đúng học sinh cho phiếu chưa định danh chắc chắn. */
export const assignPaperIdentitySchema = z.strictObject({
  studentId: uuidIdSchema,
});
export type AssignPaperIdentity = z.infer<typeof assignPaperIdentitySchema>;

/** Payload gán lô in trong hàng chờ: giáo viên gắn phiếu chưa định tuyến được (hoặc sửa mã đề sai) về đúng lô in của quiz — hệ thống đọc lại phiếu theo layout của lô đó. */
export const assignPaperBatchSchema = z.strictObject({
  batchId: uuidIdSchema,
});
export type AssignPaperBatch = z.infer<typeof assignPaperBatchSchema>;

/** Payload xác nhận ca mơ hồ: giáo viên quyết ô chọn cho từng câu mơ hồ (chosen null = để trống). */
export const resolvePaperReadingsSchema = z.strictObject({
  readings: z.array(z.strictObject({
    slot: z.number().int(),
    chosen: z.number().int().min(0).nullable(),
  })).min(1),
});
export type ResolvePaperReadings = z.infer<typeof resolvePaperReadingsSchema>;
