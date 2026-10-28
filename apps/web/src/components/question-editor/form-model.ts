/**
 * Mô hình form của màn soạn câu hỏi (tách cấu trúc từ
 * `pages/question-editor.tsx` theo đợt A của issue #223): tiện ích
 * tài liệu rich text và mô hình trạng thái form của editor — lắp
 * form từ view của câu có sẵn (`editorFormFromView`), form rỗng
 * (`emptyEditorForm`) và đóng gói payload tạo/sửa
 * (`editorFormContent`). Toàn bộ là logic thuần: không JSX, không
 * gọi API; trang soạn và các khối giao diện của nó dùng chung mô
 * hình này.
 */
import type { QuestionView, RichTextDocument } from '@lms/contracts';
import { extractRichTextPlainText } from '@lms/contracts';
import {
  composeMultipleChoiceDocument,
  composeTrueFalseDocument,
  createEmptyMultipleChoiceDocument,
  createEmptyTrueFalseDocument,
  splitMultipleChoiceDocument,
  splitTrueFalseDocument,
  type MultipleChoiceDocumentJson,
  type TrueFalseDocumentJson,
} from '@lms/editor';
import { QTYPES, plainText, type OptionsRecord, type Qtype } from '../../pages/questions';

// ---------------------------------------------------------------------------
// Tiện ích tài liệu rich text
// ---------------------------------------------------------------------------

export type Doc = RichTextDocument;

/** Tài liệu rỗng chuẩn: một doc chứa đúng một paragraph rỗng. */
export const emptyDoc = (): Doc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

/** Tài liệu một paragraph từ chuỗi thuần (chỉ dùng cho dữ liệu cũ dạng chuỗi). */
function docFromText(text: string): Doc {
  return text ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } : emptyDoc();
}

/** Ép giá trị options (có thể là tài liệu, chuỗi thuần, hoặc rác) về tài liệu. */
function asDoc(value: unknown): Doc | undefined {
  if (typeof value === 'string') return value ? docFromText(value) : undefined;
  if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'doc') {
    return value as Doc;
  }
  return undefined;
}

/** Tài liệu có nội dung thật (chữ, hoặc node phi văn bản như ảnh/công thức) hay không. */
export function docHasContent(doc: Doc | null | undefined): boolean {
  if (!doc) return false;
  if (extractRichTextPlainText(doc).trim() !== '') return true;
  return (doc.content ?? []).some((node) =>
    ((node as { content?: { type: string }[] }).content ?? []).some((child) => child.type !== 'text'),
  );
}

/** Bỏ qua tài liệu rỗng khi dựng payload (trường tuỳ chọn không gửi doc rỗng). */
function docOrUndefined(doc: Doc | undefined): Doc | undefined {
  return docHasContent(doc) ? doc : undefined;
}

/** Trạng thái bank của một view như API trả về (contracts chưa khai `status` ở entry). */
export function entryStatus(view: QuestionView | null | undefined): string | undefined {
  return (view?.entry as { status?: string } | undefined)?.status;
}

// ---------------------------------------------------------------------------
// Mô hình form
// ---------------------------------------------------------------------------

/**
 * Trạng thái form của màn soạn. Ranh giới dữ liệu theo mô hình port
 * giaokhoa (quyết 12:04 + 12:12 ngày 26/10/2026):
 * - multichoice: thân câu + lựa chọn sống trong MỘT tài liệu thống
 *   nhất (`mcDocument`); đáp án đúng là `mcCorrectChoiceId` (id của
 *   choice, nằm NGOÀI tài liệu); phản hồi theo lựa chọn là map theo
 *   id choice (`mcChoiceFeedbacks`) vì nó là metadata của dòng đáp
 *   án, không phải nội dung lựa chọn.
 * - truefalse (TF-A): thân câu + 4 mệnh đề sống trong MỘT tài liệu
 *   (`tfDocument` — cũng chính là tài liệu lưu trữ); đáp án Đ/S của
 *   từng mệnh đề là map theo id mệnh đề (`tfAnswers`, nằm NGOÀI tài
 *   liệu), khi lưu thành `solution.answers` ở phía đáp án.
 * - `guidance` (hướng dẫn) và `essaySolution` (lời giải mẫu của tự
 *   luận) là trường soạn riêng cho MỌI/loại tương ứng — khi lưu
 *   chúng đi ở cấp `guidance`/`solution` của payload (phía đáp án),
 *   không bao giờ nằm trong thân câu.
 */
export interface QuestionEditorFormState {
  qtype: Qtype;
  questionText: Doc;
  generalFeedback: Doc | undefined;
  /** Hướng dẫn (guidance) — gợi ý cách làm cho học sinh, phía đáp án. */
  guidance: Doc | undefined;
  stimulusId: string;
  // multichoice: tài liệu thống nhất + metadata ngoài tài liệu
  mcDocument: MultipleChoiceDocumentJson;
  mcCorrectChoiceId: string | undefined;
  mcChoiceFeedbacks: Record<string, Doc | undefined>;
  mcShuffleAnswers: boolean;
  mcAnswerNumbering: string;
  mcShowStandardInstruction: boolean;
  mcCorrectFeedback: Doc | undefined;
  mcIncorrectFeedback: Doc | undefined;
  // truefalse TF-A: tài liệu thống nhất (thân + 4 mệnh đề) + đáp án theo mệnh đề
  tfDocument: TrueFalseDocumentJson;
  tfAnswers: Record<string, boolean>;
  // shortanswer: đáp án là mẫu khớp nên giữ chuỗi thuần; mọi mẫu đều được chấp nhận
  saUseCase: boolean;
  saNumericAnswer: boolean;
  saNumericMaxLength: string;
  saNumericAllowSign: boolean;
  saNumericAllowDecimal: boolean;
  // Mỗi đáp án mang `id` phía client ổn định cho key/id của dòng
  // đáp án (danh sách có lên/xuống + xoá nên không dùng index làm
  // key); payload gửi API chỉ gồm `text`, không mang trường này.
  saAnswers: { id: string; text: string }[];
  // essay
  essayResponseFormat: string;
  essayResponseRequired: boolean;
  essayResponseFieldLines: string;
  essayMinWords: string;
  essayMaxWords: string;
  essayGraderInfo: Doc | undefined;
  essayResponseTemplate: Doc | undefined;
  /** Lời giải mẫu của tự luận (solution.answer ở phía đáp án). */
  essaySolution: Doc | undefined;
}

export function emptyEditorForm(qtype: Qtype = 'multichoice'): QuestionEditorFormState {
  return {
    qtype,
    questionText: emptyDoc(),
    generalFeedback: undefined,
    guidance: undefined,
    stimulusId: '',
    mcDocument: createEmptyMultipleChoiceDocument(),
    mcCorrectChoiceId: undefined,
    mcChoiceFeedbacks: {},
    mcShuffleAnswers: true,
    mcAnswerNumbering: 'abc',
    mcShowStandardInstruction: true,
    mcCorrectFeedback: undefined,
    mcIncorrectFeedback: undefined,
    tfDocument: createEmptyTrueFalseDocument(),
    tfAnswers: {},
    saUseCase: false,
    saNumericAnswer: false,
    saNumericMaxLength: '',
    saNumericAllowSign: false,
    saNumericAllowDecimal: false,
    saAnswers: [{ id: crypto.randomUUID(), text: '' }],
    essayResponseFormat: 'editor',
    essayResponseRequired: true,
    essayResponseFieldLines: '15',
    essayMinWords: '',
    essayMaxWords: '',
    essayGraderInfo: undefined,
    essayResponseTemplate: undefined,
    essaySolution: undefined,
  };
}

/**
 * Nạp form từ view của một câu có sẵn, GIỮ NGUYÊN tài liệu Tiptap của
 * thân câu/phương án/phản hồi (điều kiện để câu draft MCP mở ra sửa được
 * nguyên trạng). `fallbackOptions` lấy từ endpoint versions khi view
 * chưa mang đủ options của loại câu.
 */
export function editorFormFromView(
  view: QuestionView,
  fallbackOptions?: OptionsRecord | null,
): QuestionEditorFormState {
  const options = (view.options ?? fallbackOptions ?? {}) as OptionsRecord;
  const qtype = (QTYPES as readonly string[]).includes(view.question.qtype)
    ? (view.question.qtype as Qtype)
    : 'multichoice';
  const form = emptyEditorForm(qtype);
  form.questionText = view.latestVersion.questionText ?? emptyDoc();
  form.generalFeedback = view.latestVersion.generalFeedback ?? undefined;
  form.stimulusId = view.latestVersion.stimulusId ?? view.stimulus?.id ?? '';
  // Hướng dẫn nằm ở bản ghi phía đáp án của phiên bản (answerKey),
  // không còn ở phiên bản — nạp thẳng từ đó.
  form.guidance = view.answerKey?.guidance ?? undefined;

  if (qtype === 'multichoice') {
    form.mcShuffleAnswers = options.shuffleAnswers !== false;
    form.mcAnswerNumbering = typeof options.answerNumbering === 'string' ? options.answerNumbering : 'abc';
    form.mcShowStandardInstruction = options.showStandardInstruction !== false;
    form.mcCorrectFeedback = asDoc(options.correctFeedback);
    form.mcIncorrectFeedback = asDoc(options.incorrectFeedback);
    // Lắp thân câu + các dòng answers thành tài liệu thống nhất:
    // id của choice = id của dòng answers, đáp án đúng = dòng mang
    // isCorrect, phản hồi theo lựa chọn vào map theo id choice.
    const answers = [...(view.answers ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
    form.mcDocument = composeMultipleChoiceDocument(view.latestVersion.questionText, answers);
    form.mcCorrectChoiceId = answers.find((a) => a.isCorrect)?.id;
    form.mcChoiceFeedbacks = Object.fromEntries(
      answers.filter((a) => a.feedback).map((a) => [a.id, a.feedback ?? undefined]),
    );
  }

  if (qtype === 'truefalse') {
    // TF-A: thân câu đã lưu CHÍNH LÀ tài liệu soạn (thân + danh sách
    // mệnh đề trong cùng một tài liệu); đáp án từng mệnh đề nạp từ
    // phía đáp án của version (answerKey.solution dạng {answers}).
    form.tfDocument = composeTrueFalseDocument(view.latestVersion.questionText);
    const solution = view.answerKey?.solution;
    form.tfAnswers =
      solution && 'answers' in solution
        ? Object.fromEntries(
            (solution.answers as unknown[])
              .filter(
                (a): a is { statementId: string; value: boolean } =>
                  typeof a === 'object' && a !== null && 'statementId' in a,
              )
              .map((a) => [a.statementId, a.value]),
          )
        : {};
  }

  if (qtype === 'shortanswer') {
    form.saUseCase = options.useCase === true;
    form.saNumericAnswer = options.numericAnswer === true;
    form.saNumericMaxLength = typeof options.numericMaxLength === 'number' ? String(options.numericMaxLength) : '';
    form.saNumericAllowSign = options.numericAllowSign === true;
    form.saNumericAllowDecimal = options.numericAllowDecimal === true;
    const answers = [...(view.answers ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((answer) => ({ id: crypto.randomUUID(), text: plainText(answer.answer) }));
    if (answers.length > 0) form.saAnswers = answers;
  }

  if (qtype === 'essay') {
    form.essayResponseFormat = typeof options.responseFormat === 'string' ? options.responseFormat : 'editor';
    form.essayResponseRequired = options.responseRequired !== false;
    form.essayResponseFieldLines =
      typeof options.responseFieldLines === 'number' ? String(options.responseFieldLines) : '15';
    form.essayMinWords = typeof options.minWordLimit === 'number' ? String(options.minWordLimit) : '';
    form.essayMaxWords = typeof options.maxWordLimit === 'number' ? String(options.maxWordLimit) : '';
    form.essayGraderInfo = asDoc(options.graderInfo);
    form.essayResponseTemplate = asDoc(options.responseTemplate);
    // Lời giải mẫu của tự luận nằm ở phía đáp án (answerKey.solution
    // dạng {answer}) — khác graderInfo là thông tin cho người chấm.
    const solution = view.answerKey?.solution;
    form.essaySolution = solution && 'answer' in solution ? (solution.answer as Doc) : undefined;
  }

  return form;
}

function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Dựng phần thân payload tạo/sửa từ form (chưa gồm `categoryId`, `qtype`,
 * `stimulusId` — nơi gọi gắn tuỳ đường tạo/sửa) theo hợp đồng port
 * giaokhoa. Các bước tách theo loại:
 * - Chung: KHÔNG còn trường tên; `guidance` (khi có nội dung) gắn ở
 *   cấp payload để tầng nghiệp vụ ghi vào phía đáp án — nó không bao
 *   giờ nằm trong `questionText`.
 * - Multichoice: TÁCH tài liệu thống nhất bằng
 *   `splitMultipleChoiceDocument` — phần thân câu thành `questionText`
 *   (tài liệu hợp đồng thuần, không node lựa chọn), từng choice theo
 *   đúng thứ tự trong tài liệu thành một dòng `answers` (`correct`
 *   khi id của choice khớp đáp án đúng đã chọn; phản hồi lấy từ map
 *   theo id choice).
 * - Truefalse (TF-A): tài liệu thống nhất đi thẳng vào
 *   `questionText` (thân + 4 mệnh đề); đáp án Đ/S theo từng mệnh đề
 *   thành `solution: {answers}` ở phía đáp án theo đúng thứ tự mệnh
 *   đề trong tài liệu; KHÔNG có dòng answers.
 * - Shortanswer: mọi mẫu liệt kê đều là đáp án được chấp nhận
 *   (`correct: true`) — chấm khớp chính xác, không tỉ trọng.
 * - Essay: không dòng answers; lời giải mẫu (khi có) đi qua
 *   `solution: {answer}` ở phía đáp án.
 */
export function editorFormContent(form: QuestionEditorFormState): Record<string, unknown> {
  const generalFeedback = docOrUndefined(form.generalFeedback);
  const guidance = docOrUndefined(form.guidance);
  const base: Record<string, unknown> = {
    questionText: form.questionText,
    ...(generalFeedback ? { generalFeedback } : {}),
    ...(guidance ? { guidance } : {}),
  };

  if (form.qtype === 'multichoice') {
    const correctFeedback = docOrUndefined(form.mcCorrectFeedback);
    const incorrectFeedback = docOrUndefined(form.mcIncorrectFeedback);
    const { question, choices } = splitMultipleChoiceDocument(form.mcDocument);
    return {
      ...base,
      questionText: question as Doc,
      answers: choices.map((choice) => {
        const feedback = docOrUndefined(form.mcChoiceFeedbacks[choice.attrs.id]);
        return {
          text: { type: 'doc', content: choice.content ?? [] } as Doc,
          correct: choice.attrs.id === form.mcCorrectChoiceId,
          ...(feedback ? { feedback } : {}),
        };
      }),
      options: {
        shuffleAnswers: form.mcShuffleAnswers,
        answerNumbering: form.mcAnswerNumbering,
        showStandardInstruction: form.mcShowStandardInstruction,
        ...(correctFeedback ? { correctFeedback } : {}),
        ...(incorrectFeedback ? { incorrectFeedback } : {}),
      },
    };
  }

  if (form.qtype === 'truefalse') {
    const { statements } = splitTrueFalseDocument(form.tfDocument);
    return {
      questionText: form.tfDocument as Doc,
      ...(generalFeedback ? { generalFeedback } : {}),
      ...(guidance ? { guidance } : {}),
      solution: {
        // Chỉ gửi các mệnh đề ĐÃ chọn Đ/S: mệnh đề chưa chọn làm
        // payload thiếu phủ tập mệnh đề và bị API từ chối với lỗi rõ
        // ràng — tuyệt đối không mặc định "Sai" cho mệnh đề chưa chọn.
        answers: statements
          .filter((statement) => typeof form.tfAnswers[statement.attrs.id] === 'boolean')
          .map((statement) => ({
            statementId: statement.attrs.id,
            value: form.tfAnswers[statement.attrs.id] === true,
          })),
      },
    };
  }

  if (form.qtype === 'shortanswer') {
    const numericMaxLength = numberOrUndefined(form.saNumericMaxLength);
    return {
      ...base,
      answers: form.saAnswers.map((answer) => ({
        text: answer.text,
        correct: true,
      })),
      options: {
        useCase: form.saUseCase,
        numericAnswer: form.saNumericAnswer,
        ...(form.saNumericAnswer && numericMaxLength !== undefined ? { numericMaxLength } : {}),
        ...(form.saNumericAnswer
          ? { numericAllowSign: form.saNumericAllowSign, numericAllowDecimal: form.saNumericAllowDecimal }
          : {}),
      },
    };
  }

  // essay
  const minWordLimit = numberOrUndefined(form.essayMinWords);
  const maxWordLimit = numberOrUndefined(form.essayMaxWords);
  const graderInfo = docOrUndefined(form.essayGraderInfo);
  const responseTemplate = docOrUndefined(form.essayResponseTemplate);
  const solution = docOrUndefined(form.essaySolution);
  return {
    ...base,
    ...(solution ? { solution: { answer: solution } } : {}),
    options: {
      responseFormat: form.essayResponseFormat,
      responseRequired: form.essayResponseRequired,
      responseFieldLines: numberOrUndefined(form.essayResponseFieldLines) ?? 15,
      ...(minWordLimit !== undefined ? { minWordLimit } : {}),
      ...(maxWordLimit !== undefined ? { maxWordLimit } : {}),
      ...(graderInfo ? { graderInfo } : {}),
      ...(responseTemplate ? { responseTemplate } : {}),
    },
  };
}
