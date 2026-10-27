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
 * maxLength, mọi mảng có maxItems, đáp án chỉ mang cờ `correct`
 * đúng/sai nhị phân (tỉ trọng `fraction` đã BỎ HẲN — quyết 12:04
 * ngày 26/10/2026) và câu hỏi KHÔNG có trường tên (nhãn hiển thị là
 * trích đoạn nội dung câu hỏi).
 * Sau lớp schema này, payload vẫn chạy qua ĐÚNG `createQuestionSchema`
 * + `QuestionsService` như REST — không tồn tại validator song song.
 */

/**
 * Một đáp án ở biên MCP: nội dung chuỗi thuần + cờ `correct` (đáp án
 * này là đáp án ĐÚNG; vắng mặt = không đúng). Đáp án chỉ đúng/sai nhị
 * phân — KHÔNG còn `fraction` (quyết 12:04 ngày 26/10/2026). Riêng
 * shortanswer, mọi đáp án liệt kê đều là đáp án được chấp nhận.
 */
export const mcpAnswerInputSchema = z.strictObject({
  text: z.string().min(1).max(5000),
  correct: z.boolean().optional(),
  feedback: z.string().max(5000).optional(),
});
export type McpAnswerInput = z.infer<typeof mcpAnswerInputSchema>;

/** Options theo qtype ở biên MCP: các trường rich text của hợp đồng gốc thu về chuỗi thuần. Đã bỏ `single`/`showNumCorrect`/`partiallyCorrectFeedback` cùng hợp đồng gốc (điểm quyết D-5). */
export const mcpQuestionOptionsInputSchema = z.strictObject({
  shuffleAnswers: z.boolean().optional(),
  answerNumbering: z.string().max(50).optional(),
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

/**
 * Tool `submit_contribution` (lát MCP-2 của issue #110, scope OAuth
 * `lms.banks.contribute`): đề xuất đưa các câu CỦA CHÍNH chủ token (đã
 * `ready`) vào một bank chung (tổ/trường/khoá) qua cơ chế đóng góp QB-4
 * hiện hữu — server tạo `question_bank_contributions` ở trạng thái
 * `pending`, người có `question:moderate` tại bank đích duyệt thì câu
 * mới vào bank đích. AI KHÔNG ghi thẳng được vào bank chung ở bất kỳ
 * scope nào (ranh giới ghi cứng, hồ sơ research Phần 3.2).
 * `idempotencyKey` bắt buộc như mọi write tool (đặc tả 2026-07-28):
 * phát lại cùng key + cùng payload trả kết quả cũ, không tạo đề xuất
 * trùng; cùng key khác payload là lỗi `question.idempotency_conflict`.
 * Từ issue #228 tool mở đối xứng cho đề và ma trận (cùng scope
 * `lms.banks.contribute`, không thêm scope mới): đề đi vào đường
 * đóng góp duy nhất của đề (`exam_contributions`, mode 'new'), ma
 * trận vào hàng chờ đóng góp ma trận — cả hai đều qua đúng cổng chủ
 * sở hữu + trạng thái + đích chung của từng đường như phía câu hỏi.
 */
/**
 * Đầu vào `submit_contribution` — từ đợt đồng bộ cơ chế ngân hàng
 * (issue #228), tool mở đối xứng cho cả ba thực thể ngân hàng: ngoài
 * `questionIds` (câu hỏi), client có thể gửi `examIds` (đề — vào
 * đường đóng góp duy nhất của đề, mode 'new') và/hoặc `matrixIds`
 * (ma trận — vào hàng chờ đóng góp ma trận) trong CÙNG một lượt gọi
 * tới cùng một bank đích. Ít nhất một trong ba danh sách phải có
 * phần tử; mỗi danh sách tối đa 50 phần tử như trần batch hiện hữu.
 * Ràng buộc "ít nhất một danh sách" kiểm ngay tại schema
 * (superRefine) để client nhận lỗi hình dạng trước khi chạm tầng
 * nghiệp vụ. `questionIds` giữ optional thay vì bắt buộc là chủ
 * đích: payload cũ chỉ-câu-hỏi vẫn hợp lệ nguyên vẹn.
 */
export const mcpSubmitContributionInputSchema = z.strictObject({
  targetBankId: uuidIdSchema,
  questionIds: z.array(uuidIdSchema).min(1).max(50).optional(),
  examIds: z.array(uuidIdSchema).min(1).max(50).optional(),
  matrixIds: z.array(uuidIdSchema).min(1).max(50).optional(),
  note: z.string().max(2000).optional(),
  idempotencyKey: z.string().min(1).max(200),
}).superRefine((value, ctx) => {
  if (!value.questionIds?.length && !value.examIds?.length && !value.matrixIds?.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['questionIds'],
      message: 'submit_contribution cần ít nhất một trong ba danh sách: questionIds, examIds, matrixIds.',
    });
  }
});
export type McpSubmitContributionInput = z.infer<typeof mcpSubmitContributionInputSchema>;

/**
 * Kết quả `submit_contribution` theo từng item (ngữ nghĩa từng-item
 * như batch): `pending` kèm contributionId khi đề xuất đã tạo;
 * `failed` kèm mã lỗi nghiệp vụ của đúng cổng đã chặn (chưa ready,
 * không phải của chủ token, đích là bank personal, trùng trong bank
 * đích…). Ba mảng kết quả tách theo loại thực thể: `results` (câu
 * hỏi — giữ nguyên hình dạng cũ), `examResults` và `matrixResults`
 * (mặc định rỗng khi payload cũ được phát lại từ sổ idempotency ghi
 * trước đợt mở đối xứng, để bản ghi cũ vẫn hợp lệ với schema mới).
 * `created`/`failed` là tổng trên cả ba loại.
 */
export const mcpSubmitContributionOutputSchema = z.object({
  targetBankId: uuidIdSchema,
  results: z.array(
    z.object({
      questionId: uuidIdSchema,
      status: z.enum(['pending', 'failed']),
      contributionId: uuidIdSchema.nullable(),
      code: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
  examResults: z.array(
    z.object({
      examId: uuidIdSchema,
      status: z.enum(['pending', 'failed']),
      contributionId: uuidIdSchema.nullable(),
      code: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ).default([]),
  matrixResults: z.array(
    z.object({
      matrixId: uuidIdSchema,
      status: z.enum(['pending', 'failed']),
      contributionId: uuidIdSchema.nullable(),
      code: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ).default([]),
  created: z.number().int(),
  failed: z.number().int(),
});
export type McpSubmitContributionOutput = z.infer<typeof mcpSubmitContributionOutputSchema>;

/**
 * ── Lát MCP-1 (issue #163) ──────────────────────────────────────────
 * Các tool dưới đây dùng cùng một bộ nguyên tắc biên như MCP-0: strict
 * object, chuỗi/mảng có trần, idempotencyKey bắt buộc ở mọi tool ghi,
 * kết quả ghi theo TỪNG ITEM (một item lỗi không kéo cả lô xuống, trừ
 * tool nhóm ngữ liệu nguyên tử ghi rõ ở mô tả của nó).
 */

/**
 * Một câu trong lô của `create_questions_batch`: đúng hình của
 * create_question trừ bankId/categoryId/idempotencyKey (chung cả lô).
 * `clientItemId` do client đặt để đối chiếu kết quả từng câu và làm
 * khoá idempotency TỪNG CÂU (khoá lô + clientItemId). `stimulusRef`
 * trỏ tới một ngữ liệu khai trong mảng `stimuli` của cùng lô (server
 * tạo trước trong cùng thao tác); `stimulusId` trỏ ngữ liệu đã có —
 * hai trường loại trừ nhau.
 */
export const mcpBatchQuestionItemSchema = z.strictObject({
  clientItemId: z.string().min(1).max(64),
  qtype: z.enum(['multichoice', 'truefalse', 'shortanswer', 'essay']),
  questionText: z.string().min(1).max(20000),
  generalFeedback: z.string().max(5000).optional(),
  guidance: z.string().max(5000).optional(),
  defaultMark: z.number().gt(0).max(100).optional(),
  penalty: z.number().min(0).max(1).optional(),
  stimulusId: uuidIdSchema.optional(),
  stimulusRef: z.string().min(1).max(64).optional(),
  answers: z.array(mcpAnswerInputSchema).max(10).optional(),
  options: mcpQuestionOptionsInputSchema.optional(),
});
export type McpBatchQuestionItem = z.infer<typeof mcpBatchQuestionItemSchema>;

/**
 * Tool `create_questions_batch`: tạo NHIỀU câu draft trong bank cá
 * nhân của chủ token trong một lần gọi. Ngữ nghĩa từng-item như
 * submit_contribution: item trùng exact → `duplicate_exact` (không
 * tạo), item lỗi → `failed` kèm mã + fieldPath, các item còn lại vẫn
 * chạy. Idempotency TỪNG CÂU: phát lại cùng khoá lô + cùng payload
 * của một item thì trả kết quả cũ của item đó.
 */
export const mcpCreateQuestionsBatchInputSchema = z.strictObject({
  bankId: uuidIdSchema,
  categoryId: uuidIdSchema,
  stimuli: z
    .array(
      z.strictObject({
        ref: z.string().min(1).max(64),
        content: z.string().min(1).max(20000),
      }),
    )
    .max(10)
    .optional(),
  items: z.array(mcpBatchQuestionItemSchema).min(1).max(50),
  idempotencyKey: z.string().min(1).max(200),
});
export type McpCreateQuestionsBatchInput = z.infer<typeof mcpCreateQuestionsBatchInputSchema>;

export const mcpBatchItemResultSchema = z.object({
  clientItemId: z.string(),
  status: z.enum(['created', 'duplicate_exact', 'failed']),
  questionId: uuidIdSchema.nullable(),
  existingQuestionId: uuidIdSchema.nullable(),
  entryId: uuidIdSchema.nullable(),
  version: z.number().int().nullable(),
  questionStatus: z.string().nullable(),
  duplicate: z.enum(['none', 'near', 'exact']),
  nearDuplicateOf: uuidIdSchema.nullable(),
  reviewUrl: z.string().nullable(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  fieldPath: z.string().nullable(),
});
export type McpBatchItemResult = z.infer<typeof mcpBatchItemResultSchema>;

export const mcpCreateQuestionsBatchOutputSchema = z.object({
  bankId: uuidIdSchema,
  categoryId: uuidIdSchema,
  stimuli: z.array(
    z.object({
      ref: z.string(),
      stimulusId: uuidIdSchema.nullable(),
      status: z.enum(['created', 'failed']),
      code: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
  results: z.array(mcpBatchItemResultSchema),
  created: z.number().int(),
  failed: z.number().int(),
});
export type McpCreateQuestionsBatchOutput = z.infer<typeof mcpCreateQuestionsBatchOutputSchema>;

/** Một câu trong nhóm của `create_stimulus_with_questions`: hình của create_question trừ bank/category/key; stimulus là ngữ liệu của chính tool này nên không có stimulusId/Ref. */
export const mcpStimulusQuestionItemSchema = z.strictObject({
  qtype: z.enum(['multichoice', 'truefalse', 'shortanswer', 'essay']),
  questionText: z.string().min(1).max(20000),
  generalFeedback: z.string().max(5000).optional(),
  guidance: z.string().max(5000).optional(),
  defaultMark: z.number().gt(0).max(100).optional(),
  penalty: z.number().min(0).max(1).optional(),
  answers: z.array(mcpAnswerInputSchema).max(10).optional(),
  options: mcpQuestionOptionsInputSchema.optional(),
});
export type McpStimulusQuestionItem = z.infer<typeof mcpStimulusQuestionItemSchema>;

/**
 * Tool `create_stimulus_with_questions`: tạo một ngữ liệu + nhóm câu
 * bám ngữ liệu đó NGUYÊN TỬ (một giao dịch ở tầng service — hoặc cả
 * nhóm tồn tại, hoặc không gì tồn tại; khác hẳn batch từng-item).
 * Mọi câu vào draft như create_question.
 */
export const mcpCreateStimulusWithQuestionsInputSchema = z.strictObject({
  bankId: uuidIdSchema,
  categoryId: uuidIdSchema,
  stimulusContent: z.string().min(1).max(20000),
  questions: z.array(mcpStimulusQuestionItemSchema).min(1).max(50),
  idempotencyKey: z.string().min(1).max(200),
});
export type McpCreateStimulusWithQuestionsInput = z.infer<typeof mcpCreateStimulusWithQuestionsInputSchema>;

export const mcpCreateStimulusWithQuestionsOutputSchema = z.object({
  stimulusId: uuidIdSchema,
  results: z.array(mcpCreateQuestionOutputSchema),
  created: z.number().int(),
});
export type McpCreateStimulusWithQuestionsOutput = z.infer<typeof mcpCreateStimulusWithQuestionsOutputSchema>;

/**
 * Tool `publish_questions` (scope `lms.questions.write`): duyệt phát
 * hành các câu DRAFT của CHÍNH chủ token trong bank cá nhân của họ lên
 * `ready` — đúng đường nghiệp vụ `setQuestionStatus` mà giao diện web
 * dùng. Từng-item: câu không phải của chủ token coi như không tồn
 * tại; câu không ở draft → failed `question.publish_not_draft`.
 */
export const mcpPublishQuestionsInputSchema = z.strictObject({
  questionIds: z.array(uuidIdSchema).min(1).max(50),
  idempotencyKey: z.string().min(1).max(200),
});
export type McpPublishQuestionsInput = z.infer<typeof mcpPublishQuestionsInputSchema>;

export const mcpPublishQuestionsOutputSchema = z.object({
  results: z.array(
    z.object({
      questionId: uuidIdSchema,
      status: z.enum(['published', 'failed']),
      code: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
  published: z.number().int(),
  failed: z.number().int(),
});
export type McpPublishQuestionsOutput = z.infer<typeof mcpPublishQuestionsOutputSchema>;

/**
 * Tool `search_questions`: tìm câu trong MỘT bank mà chủ token xem
 * được, theo chuỗi con trong thân câu (đã chuẩn hoá NFC + thường
 * hoá hai phía như cổng chống trùng) và lọc qtype tuỳ chọn. Chỉ trả
 * SIÊU DỮ LIỆU (không đáp án, không tên — câu hỏi không có trường
 * tên, nhãn hiển thị là trích đoạn nội dung lấy qua get_question).
 */
export const mcpSearchQuestionsInputSchema = z.strictObject({
  bankId: uuidIdSchema,
  query: z.string().min(1).max(200),
  qtype: z.enum(['multichoice', 'truefalse', 'shortanswer', 'essay']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type McpSearchQuestionsInput = z.infer<typeof mcpSearchQuestionsInputSchema>;

export const mcpSearchQuestionsOutputSchema = z.object({
  bankId: uuidIdSchema,
  questions: z.array(
    z.object({
      id: uuidIdSchema,
      qtype: z.string(),
      status: z.string(),
      categoryId: uuidIdSchema,
      categoryName: z.string(),
      mine: z.boolean(),
    }),
  ),
  truncated: z.boolean(),
});
export type McpSearchQuestionsOutput = z.infer<typeof mcpSearchQuestionsOutputSchema>;

/**
 * Tool `check_duplicates`: soi trùng (exact/near) cho các câu SẮP tạo
 * trong một bank mà không ghi gì cả — cùng cơ chế băm nội dung QB-4
 * với cổng tạo, để client AI tự quyết định bỏ/sửa trước khi tạo thật.
 */
export const mcpCheckDuplicatesInputSchema = z.strictObject({
  bankId: uuidIdSchema,
  items: z
    .array(
      z.strictObject({
        clientItemId: z.string().min(1).max(64),
        qtype: z.enum(['multichoice', 'truefalse', 'shortanswer', 'essay']),
        questionText: z.string().min(1).max(20000),
        answers: z.array(mcpAnswerInputSchema).max(10).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type McpCheckDuplicatesInput = z.infer<typeof mcpCheckDuplicatesInputSchema>;

export const mcpCheckDuplicatesOutputSchema = z.object({
  bankId: uuidIdSchema,
  results: z.array(
    z.object({
      clientItemId: z.string(),
      verdict: z.enum(['exact', 'near', 'none']),
      existingQuestionId: uuidIdSchema.nullable(),
      nearDuplicateOf: uuidIdSchema.nullable(),
    }),
  ),
});
export type McpCheckDuplicatesOutput = z.infer<typeof mcpCheckDuplicatesOutputSchema>;

/**
 * Tool `search_curriculum_outcomes`: tra YCCĐ THẬT của chương trình
 * GDPT theo từ khoá (+ lọc môn/khối) trong các môn chủ token đọc được
 * (`curriculum:view` tại context môn) — để model bám đúng YCCĐ khi
 * soạn câu. Liên kết câu×YCCĐ chính thức vẫn ở tầng ma trận/quiz; kết
 * quả ở đây thuần tra cứu, kèm `sourceRef` làm truy vết nhẹ.
 */
export const mcpSearchCurriculumOutcomesInputSchema = z.strictObject({
  query: z.string().min(1).max(200),
  subjectId: uuidIdSchema.optional(),
  gradeLevel: z.number().int().min(1).max(12).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type McpSearchCurriculumOutcomesInput = z.infer<typeof mcpSearchCurriculumOutcomesInputSchema>;

export const mcpSearchCurriculumOutcomesOutputSchema = z.object({
  outcomes: z.array(
    z.object({
      id: uuidIdSchema,
      content: z.string(),
      sourceKind: z.string(),
      sourceRef: z.string().nullable(),
      nodeId: uuidIdSchema,
      nodeTitle: z.string(),
      subjectId: uuidIdSchema,
      subjectName: z.string(),
      grade: z.number().int(),
    }),
  ),
});
export type McpSearchCurriculumOutcomesOutput = z.infer<typeof mcpSearchCurriculumOutcomesOutputSchema>;
