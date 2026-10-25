import { z } from 'zod';
import { uuidIdSchema } from './ids.js';
import { questionViewSchema } from './assessment.js';

/**
 * Hợp đồng bề mặt MCP (issue #110, lát MCP-0): input/output của các tool
 * mà client AI (Claude.ai/ChatGPT/MCP Inspector…) gọi vào LMS.
 *
 * Nguyên tắc (hồ sơ research MCP Phần 2.3/3.1): input tạo câu hỏi là
 * DẠNG THU HẸP có chủ đích của `createQuestionSchema` — cùng một hợp
 * đồng, chặt hơn ở biên AI: nội dung chỉ nhận CHUỖI THUẦN (không nhận
 * tài liệu Tiptap, server chuẩn hoá qua cùng đường `toRichTextDocument`
 * như REST), KHÔNG nhận dạng payload cũ `answer`, KHÔNG nhận
 * sourceKind/sourceRef (server tự ghi `source_kind='ai'`), mọi chuỗi có
 * maxLength, mọi mảng có maxItems, fraction ∈ [0,1] ngay tại schema.
 * Sau lớp schema này, payload vẫn chạy qua ĐÚNG `createQuestionSchema`
 * + `QuestionsService` như REST — không tồn tại validator song song.
 */

export const mcpAnswerInputSchema = z.strictObject({
  text: z.string().min(1).max(5000),
  fraction: z.number().min(0).max(1),
  feedback: z.string().max(5000).optional(),
});
export type McpAnswerInput = z.infer<typeof mcpAnswerInputSchema>;

/** Options theo qtype ở biên MCP: các trường rich text của hợp đồng gốc thu về chuỗi thuần. */
export const mcpQuestionOptionsInputSchema = z.strictObject({
  single: z.boolean().optional(),
  shuffleAnswers: z.boolean().optional(),
  answerNumbering: z.string().max(50).optional(),
  showNumCorrect: z.boolean().optional(),
  showStandardInstruction: z.boolean().optional(),
  useCase: z.boolean().optional(),
  responseFormat: z.string().max(50).optional(),
  responseRequired: z.boolean().optional(),
  responseFieldLines: z.number().int().min(0).max(100).optional(),
  minWordLimit: z.number().int().min(0).nullable().optional(),
  maxWordLimit: z.number().int().min(0).nullable().optional(),
  graderInfo: z.string().max(5000).optional(),
  responseTemplate: z.string().max(5000).optional(),
  correctFeedback: z.string().max(5000).optional(),
  partiallyCorrectFeedback: z.string().max(5000).optional(),
  incorrectFeedback: z.string().max(5000).optional(),
});
export type McpQuestionOptionsInput = z.infer<typeof mcpQuestionOptionsInputSchema>;

/**
 * Tool `create_question`: đích ghi là bank CÁ NHÂN của chính chủ token
 * (ràng buộc cứng phía server — bankId của người khác coi như không tồn
 * tại), category phải thuộc bank đó. `idempotencyKey` do client sinh,
 * bắt buộc theo đặc tả 2026-07-28 (stream đứt = client phát hành lại,
 * server không được nhân đôi câu).
 */
export const mcpCreateQuestionInputSchema = z.strictObject({
  bankId: uuidIdSchema,
  categoryId: uuidIdSchema,
  qtype: z.enum(['multichoice', 'truefalse', 'shortanswer', 'essay']),
  name: z.string().min(1).max(255),
  questionText: z.string().min(1).max(20000),
  generalFeedback: z.string().max(5000).optional(),
  guidance: z.string().max(5000).optional(),
  defaultMark: z.number().gt(0).max(100).optional(),
  penalty: z.number().min(0).max(1).optional(),
  stimulusId: uuidIdSchema.optional(),
  answers: z.array(mcpAnswerInputSchema).max(10).optional(),
  options: mcpQuestionOptionsInputSchema.optional(),
  idempotencyKey: z.string().min(1).max(200),
});
export type McpCreateQuestionInput = z.infer<typeof mcpCreateQuestionInputSchema>;

/**
 * Kết quả `create_question`: `created` (câu mới ở trạng thái draft) hoặc
 * `duplicate_exact` (trùng hoàn toàn với câu đã có trong bank — KHÔNG
 * tạo bản sao, trả questionId hiện có để model tự quyết định bỏ qua).
 */
export const mcpCreateQuestionOutputSchema = z.object({
  status: z.enum(['created', 'duplicate_exact']),
  questionId: uuidIdSchema.nullable(),
  existingQuestionId: uuidIdSchema.nullable(),
  entryId: uuidIdSchema.nullable(),
  version: z.number().int().nullable(),
  questionStatus: z.string().nullable(),
  duplicate: z.enum(['none', 'near', 'exact']),
  nearDuplicateOf: uuidIdSchema.nullable(),
  reviewUrl: z.string().nullable(),
});
export type McpCreateQuestionOutput = z.infer<typeof mcpCreateQuestionOutputSchema>;

export const mcpListMyBanksOutputSchema = z.object({
  banks: z.array(
    z.object({
      id: uuidIdSchema,
      name: z.string(),
      scope: z.string(),
      kind: z.string(),
      ownerId: uuidIdSchema.nullable(),
      capabilities: z.object({
        use: z.boolean(),
        add: z.boolean(),
        edit: z.boolean(),
        manageCategory: z.boolean(),
        copy: z.boolean(),
        share: z.boolean(),
        moderate: z.boolean(),
      }),
      defaultCategoryId: uuidIdSchema.nullable(),
      categoryCount: z.number().int(),
    }),
  ),
});
export type McpListMyBanksOutput = z.infer<typeof mcpListMyBanksOutputSchema>;

export const mcpListCategoriesInputSchema = z.strictObject({
  bankId: uuidIdSchema,
});
export type McpListCategoriesInput = z.infer<typeof mcpListCategoriesInputSchema>;

export const mcpListCategoriesOutputSchema = z.object({
  bankId: uuidIdSchema,
  categories: z.array(
    z.object({
      id: uuidIdSchema,
      name: z.string(),
      parentId: uuidIdSchema.nullable(),
      questionCount: z.number().int(),
    }),
  ),
});
export type McpListCategoriesOutput = z.infer<typeof mcpListCategoriesOutputSchema>;

export const mcpGetQuestionInputSchema = z.strictObject({
  questionId: uuidIdSchema,
});
export type McpGetQuestionInput = z.infer<typeof mcpGetQuestionInputSchema>;

/** Tool `get_question` trả ĐÚNG projection của REST (questionViewSchema — không chứa source_kind/source_ref). */
export const mcpGetQuestionOutputSchema = questionViewSchema;
