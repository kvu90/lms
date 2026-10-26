import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { QuestionCategory, QuestionView, RichTextDocument, StimulusView } from '@lms/contracts';
import { extractRichTextPlainText } from '@lms/contracts';
import {
  MultipleChoiceEditor,
  RichTextEditor,
  RichTextView,
  composeMultipleChoiceDocument,
  createEmptyMultipleChoiceDocument,
  splitMultipleChoiceDocument,
  type MultipleChoiceDocumentJson,
  type RichTextImagePick,
} from '@lms/editor';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@lms/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import {
  QUESTION_IMAGE_ACCEPT,
  QuestionImageError,
  uploadQuestionImage,
  type QuestionFileArea,
} from '../lib/question-files';
import '../i18n';
import { apiJson } from '#lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { clearQuestionBankListCache } from '#lib/questions-data';
import {
  COGNITIVE_LEVELS,
  LEVEL_LABEL_KEYS,
  QTYPES,
  QTYPE_LABEL_KEYS,
  hasAllOptions,
  plainText,
  withApiReason,
  type CurriculumLinksView,
  type CurriculumTreeNode,
  type OptionsRecord,
  type Qtype,
} from './questions';

/**
 * Màn soạn câu hỏi (issue #248) — flow tổng thể:
 *
 * 1. Nạp: danh mục (kèm context cho đường tải ảnh) + ngữ liệu của danh
 *    mục; khi sửa, nạp view câu hỏi rồi `editorFormFromView` lắp thành
 *    trạng thái form (options thiếu thì tìm thêm ở endpoint versions).
 * 2. Soạn: form riêng cho từng loại trong 4 loại — multichoice,
 *    truefalse (gồm dạng chùm mệnh đề Đ/S bám cùng ngữ liệu),
 *    shortanswer (kèm cờ đáp án số, mặc định TẮT) và essay. Câu hỏi
 *    KHÔNG có trường tên (quyết 11:28 ngày 26/10/2026): nhãn hiển thị
 *    ở mọi bề mặt là trích đoạn nội dung câu hỏi.
 * 3. Lưu: `editorFormContent` đóng gói payload theo hợp đồng mới (port
 *    giaokhoa, quyết 12:04 + 12:12 ngày 26/10/2026) rồi tạo câu/phiên
 *    bản mới, sau đó chốt trạng thái đích bằng
 *    `POST /questions/:id/status` (chuyển trạng thái không tạo phiên
 *    bản mới): "Lưu nháp" = `draft`, "Lưu & sẵn sàng" = `ready` (câu
 *    mới tạo qua API mặc định ở `ready`).
 *
 * Mô hình soạn theo loại (chi tiết ở các hàm compose/split của
 * `@lms/editor` và ở `editorFormContent`):
 * - Multichoice soạn trên MỘT tài liệu thống nhất (thân câu + 4 lựa
 *   chọn trong cùng tài liệu, radio đáp án đúng là metadata ngoài tài
 *   liệu); khi lưu tài liệu được TÁCH thành thân câu / các dòng
 *   answers / phản hồi theo lựa chọn.
 * - Mọi loại câu đều có trường HƯỚNG DẪN (guidance) rich text riêng và
 *   essay có thêm LỜI GIẢI MẪU (solution): cả hai KHÔNG nằm trong nội
 *   dung câu hỏi gửi đi — payload gắn chúng ở cấp `guidance` /
 *   `solution` để tầng nghiệp vụ ghi vào bản ghi phía đáp án
 *   (`question_answer_keys`) theo quyết 12:12.
 * - Đáp án của shortanswer là MẪU khớp đáp án của học sinh nên giữ ô
 *   nhập thuần; mọi mẫu liệt kê đều được chấp nhận (không tỉ trọng).
 *
 * Mọi trường nội dung trình bày đều là tài liệu rich text qua trình
 * soạn của @lms/editor — công thức toán và danh sách đến từ chính
 * editor đó; ảnh chèn qua bộ chọn ảnh của lát files (định danh bền
 * `/api/v1/files/<id>/content` nằm trong `attrs.src` của node image).
 * Mô hình form GIỮ NGUYÊN tài liệu Tiptap khi mở câu có sẵn nên câu
 * draft do MCP tạo mở ra sửa được nguyên trạng.
 */

// ---------------------------------------------------------------------------
// Tiện ích tài liệu rich text
// ---------------------------------------------------------------------------

type Doc = RichTextDocument;

/** Tài liệu rỗng chuẩn: một doc chứa đúng một paragraph rỗng. */
const emptyDoc = (): Doc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

/** Tài liệu một paragraph từ chuỗi thuần (chỉ dùng cho dữ liệu cũ dạng chuỗi). */
function docFromText(text: string): Doc {
  return text
    ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
    : emptyDoc();
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
function docHasContent(doc: Doc | null | undefined): boolean {
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
function entryStatus(view: QuestionView | null | undefined): string | undefined {
  return (view?.entry as { status?: string } | undefined)?.status;
}

// ---------------------------------------------------------------------------
// Mô hình form
// ---------------------------------------------------------------------------

/** Một mệnh đề Đ/S trong chùm truefalse: nội dung + đáp án đúng của mệnh đề. */
interface TrueFalseStatementDraft {
  doc: Doc;
  correct: boolean;
}

/**
 * Trạng thái form của màn soạn. Ranh giới dữ liệu theo mô hình port
 * giaokhoa (quyết 12:04 + 12:12 ngày 26/10/2026):
 * - multichoice: thân câu + lựa chọn sống trong MỘT tài liệu thống
 *   nhất (`mcDocument`); đáp án đúng là `mcCorrectChoiceId` (id của
 *   choice, nằm NGOÀI tài liệu); phản hồi theo lựa chọn là map theo
 *   id choice (`mcChoiceFeedbacks`) vì nó là metadata của dòng đáp
 *   án, không phải nội dung lựa chọn.
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
  // truefalse: danh sách mệnh đề (sửa một câu thì danh sách có đúng 1 mệnh đề)
  tfStatements: TrueFalseStatementDraft[];
  tfShowStandardInstruction: boolean;
  // shortanswer: đáp án là mẫu khớp nên giữ chuỗi thuần; mọi mẫu đều được chấp nhận
  saUseCase: boolean;
  saNumericAnswer: boolean;
  saNumericMaxLength: string;
  saNumericAllowSign: boolean;
  saNumericAllowDecimal: boolean;
  saAnswers: { text: string }[];
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
    tfStatements: [{ doc: emptyDoc(), correct: true }],
    tfShowStandardInstruction: true,
    saUseCase: false,
    saNumericAnswer: false,
    saNumericMaxLength: '',
    saNumericAllowSign: false,
    saNumericAllowDecimal: false,
    saAnswers: [{ text: '' }],
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
    form.tfShowStandardInstruction = options.showStandardInstruction !== false;
    const sorted = [...(view.answers ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
    // Phía đúng của câu = nội dung của dòng answers mang isCorrect:
    // nhãn của nó là "Đúng"/"True" thì mệnh đề đúng, là "Sai"/"False"
    // thì mệnh đề sai (cùng cách nhận diện nhãn như tầng nghiệp vụ).
    const correctAnswer = sorted.find((a) => a.isCorrect);
    const correctText = correctAnswer ? plainText(correctAnswer.answer).trim().toLowerCase() : '';
    form.tfStatements = [
      {
        doc: view.latestVersion.questionText ?? emptyDoc(),
        correct: correctText === 'true' || correctText === 'đúng',
      },
    ];
  }

  if (qtype === 'shortanswer') {
    form.saUseCase = options.useCase === true;
    form.saNumericAnswer = options.numericAnswer === true;
    form.saNumericMaxLength =
      typeof options.numericMaxLength === 'number' ? String(options.numericMaxLength) : '';
    form.saNumericAllowSign = options.numericAllowSign === true;
    form.saNumericAllowDecimal = options.numericAllowDecimal === true;
    const answers = [...(view.answers ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((answer) => ({ text: plainText(answer.answer) }));
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
    form.essaySolution =
      solution && 'answer' in solution ? (solution.answer as Doc) : undefined;
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
 * - Truefalse: MỘT mệnh đề thành một câu với hai dòng answers
 *   "Đúng"/"Sai", cờ `correct` đặt ở phía đúng (đường `answer:
 *   {correct}` cấp câu đã bỏ hẳn ở hợp đồng); chùm nhiều mệnh đề được
 *   nơi gọi tách thành nhiều lần tạo.
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
    const statement = form.tfStatements[0] ?? { doc: emptyDoc(), correct: true };
    return {
      questionText: statement.doc,
      ...(generalFeedback ? { generalFeedback } : {}),
      ...(guidance ? { guidance } : {}),
      answers: [
        { text: 'Đúng', correct: statement.correct },
        { text: 'Sai', correct: !statement.correct },
      ],
      options: { showStandardInstruction: form.tfShowStandardInstruction },
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

// ---------------------------------------------------------------------------
// Trường soạn rich text kèm chèn ảnh
// ---------------------------------------------------------------------------

/**
 * Mở trình chọn tệp để xin MỘT tệp ảnh cho callback `onRequestImage` khi
 * người soạn bấm nút ảnh trong toolbar của editor (trường hợp callback
 * được gọi KHÔNG kèm tệp). Input được tạo tạm, gắn vào cuối body trong
 * lúc chọn rồi tự gỡ bỏ; người soạn huỷ chọn thì trả `null`.
 */
function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = QUESTION_IMAGE_ACCEPT;
    input.style.display = 'none';
    const settle = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => settle(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => settle(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Đường chèn ảnh dùng chung của mọi trường soạn trong form câu hỏi
 * (giao diện chốt ở comment 6405254997 trên issue #248, bàn giao QE-1
 * ở comment 6406028273): editor gọi kèm tệp khi người soạn dán/kéo-thả
 * ảnh — tải thẳng tệp đó; gọi không kèm tệp khi bấm nút ảnh — mở
 * trình chọn tệp trước. Chưa có context của bank đích hoặc tải ảnh
 * lỗi thì trả `null` (editor không chèn gì) và lỗi được giữ ở
 * `imageError` để trường soạn hiện ngay dưới trường.
 *
 * @param contextId - Context của bank đích; chưa có thì đường ảnh tắt.
 * @param fileArea - Khu vực file của trường soạn (metadata phân loại).
 * @param itemId - Id câu hỏi đang sửa (định danh mục của file).
 * @returns Handler xin ảnh cho editor + thông báo lỗi tải ảnh hiện tại.
 */
function useQuestionImageHandler(
  contextId: string | undefined,
  fileArea: QuestionFileArea,
  itemId: string | undefined,
): {
  handleRequestImage: (file?: File) => Promise<RichTextImagePick | null>;
  imageError: string | null;
} {
  const { t } = useTranslation('app');
  const [imageError, setImageError] = useState<string | null>(null);
  const handleRequestImage = useCallback(
    async (file?: File): Promise<RichTextImagePick | null> => {
      if (!contextId) return null;
      const chosen = file ?? (await pickImageFile());
      if (!chosen) return null;
      try {
        const result = await uploadQuestionImage(chosen, { contextId, fileArea, itemId });
        setImageError(null);
        return { src: result.src, alt: result.alt };
      } catch (err) {
        if (err instanceof QuestionImageError && err.code === 'file.image_too_large') {
          setImageError(t('questionImageTooLarge'));
        } else if (err instanceof QuestionImageError && err.code === 'file.not_image') {
          setImageError(t('questionImageNotImage'));
        } else {
          setImageError(t('questionImageFailed'));
        }
        return null;
      }
    },
    [contextId, fileArea, itemId, t],
  );
  return { handleRequestImage, imageError };
}

/**
 * Một trường nội dung rich text của form câu hỏi. Chèn ảnh chỉ còn MỘT
 * đường qua chính editor (lát E3 #248, theo mô hình một-toolbar của
 * giaokhoa): nút ảnh trên toolbar của editor đang active, dán và
 * kéo-thả vào vùng soạn — cả ba đều gọi callback `onRequestImage`,
 * tải qua `uploadQuestionImage` của lát files và editor tự chèn
 * node `image` tại con trỏ bằng định danh bền mà callback trả về. Hàng
 * chọn ảnh riêng bọc ngoài từng trường (QuestionImagePicker) đã bỏ —
 * trước lát này mỗi trường mang một hàng như vậy, lặp 10 lần trên form.
 */
function RichField({
  label,
  value,
  onChange,
  fileArea,
  contextId,
  itemId,
  size = 'compact',
}: {
  label: string;
  value: Doc | undefined;
  onChange: (doc: Doc) => void;
  fileArea: QuestionFileArea;
  contextId?: string;
  itemId?: string;
  /** Cỡ vùng soạn của editor: trường thân câu là `default`, còn lại `compact`. */
  size?: 'default' | 'compact';
}) {
  const doc = value ?? emptyDoc();
  const { handleRequestImage, imageError } = useQuestionImageHandler(contextId, fileArea, itemId);

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <RichTextEditor
        value={doc}
        onChange={onChange}
        ariaLabel={label}
        size={size}
        onRequestImage={contextId ? handleRequestImage : undefined}
      />
      {imageError ? <p className="mt-1 text-sm text-red-600">{imageError}</p> : null}
    </Field>
  );
}

/**
 * Trường soạn trắc nghiệm trên tài liệu thống nhất: thân câu + bốn
 * lựa chọn trong MỘT editor (`MultipleChoiceEditor` của @lms/editor),
 * radio đáp án đúng gắn tại từng lựa chọn. Đường chèn ảnh dùng chung
 * một handler cho cả tài liệu — khu vực file ghi là `questiontext`
 * vì vị trí con trỏ (thân câu hay trong lựa chọn) không lộ ra qua
 * callback ảnh của editor; khu vực chỉ là metadata phân loại của bản
 * ghi file, ảnh vẫn tải/hiển thị theo định danh bền như mọi trường
 * khác.
 */
function McDocumentField({
  label,
  value,
  correctChoiceId,
  onChange,
  onCorrectChoiceChange,
  contextId,
  itemId,
}: {
  label: string;
  value: MultipleChoiceDocumentJson;
  correctChoiceId: string | undefined;
  onChange: (doc: MultipleChoiceDocumentJson) => void;
  onCorrectChoiceChange: (choiceId: string) => void;
  contextId?: string;
  itemId?: string;
}) {
  const { handleRequestImage, imageError } = useQuestionImageHandler(
    contextId,
    'questiontext',
    itemId,
  );

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <MultipleChoiceEditor
        value={value}
        onChange={onChange}
        correctChoiceId={correctChoiceId}
        onCorrectChoiceChange={onCorrectChoiceChange}
        ariaLabel={label}
        onRequestImage={contextId ? handleRequestImage : undefined}
      />
      {imageError ? <p className="mt-1 text-sm text-red-600">{imageError}</p> : null}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Xem trước như học sinh
// ---------------------------------------------------------------------------

/** Nhãn thứ tự của một phương án theo kiểu đánh số giáo viên đã chọn. */
function numberingLabel(numbering: string, index: number): string {
  switch (numbering) {
    case 'ABC':
      return `${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[index] ?? index + 1}.`;
    case '123':
      return `${index + 1}.`;
    case 'iii':
      return `${['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][index] ?? index + 1}.`;
    case 'IIII':
      return `${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][index] ?? index + 1}.`;
    case 'none':
      return '';
    default:
      return `${'abcdefghijklmnopqrstuvwxyz'[index] ?? index + 1}.`;
  }
}

/**
 * Cột xem trước TRỰC TIẾP như học sinh sẽ thấy câu hỏi: ngữ liệu (nếu
 * gắn), thân câu, khối Hướng dẫn (guidance hiện kèm câu hỏi trong lúc
 * làm — điểm quyết D-4) và vùng trả lời tĩnh theo loại câu. Với
 * multichoice, bản xem trước dựng từ tài liệu thống nhất ĐÃ TÁCH
 * (cùng hàm split với đường lưu) nên thứ tự/đánh số lựa chọn khớp
 * đúng thứ tự đáp án khi lưu; đáp án đúng không lộ ở bề mặt này.
 * Riêng tự luận có thêm khối Lời giải mẫu ở cuối — đó là phần giáo
 * viên đối chiếu khi soạn (học sinh chỉ thấy ở màn xem lại sau khi
 * nộp, theo cổng xem lại của lần ghim). Phản hồi sau làm bài không
 * thuộc bề mặt này.
 */
function StudentPreview({ form, stimulus }: { form: QuestionEditorFormState; stimulus: StimulusView | null }) {
  const { t } = useTranslation('app');
  const mcSplit =
    form.qtype === 'multichoice' ? splitMultipleChoiceDocument(form.mcDocument) : null;
  return (
    <Card className="lg:sticky lg:top-4">
      <CardHeader>
        <CardTitle>{t('questionStudentPreview')}</CardTitle>
        <CardDescription>{t('questionStudentPreviewHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stimulus ? (
          <div className="rounded-md bg-slate-50 p-3">
            <p className="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              {t('stimulusHeading')}
            </p>
            <RichTextView value={stimulus.content} />
          </div>
        ) : null}
        {form.qtype === 'multichoice' && mcSplit ? (
          <RichTextView value={mcSplit.question as Doc} />
        ) : form.qtype !== 'truefalse' ? (
          <RichTextView value={form.questionText} />
        ) : null}
        {docHasContent(form.guidance) ? (
          <div className="rounded-md border p-3">
            <p className="mb-1 text-sm font-medium">{t('guidanceHeading')}</p>
            <RichTextView value={form.guidance ?? null} />
          </div>
        ) : null}
        {form.qtype === 'multichoice' && mcSplit ? (
          <div className="space-y-2">
            {mcSplit.choices.map((choice, index) => (
              <div key={choice.attrs.id} className="flex items-start gap-2 text-sm">
                <input type="radio" disabled className="mt-1" />
                <span className="font-medium">{numberingLabel(form.mcAnswerNumbering, index)}</span>
                <span className="min-w-0 flex-1">
                  {/* Nội dung choice là lát block của hợp đồng —
                      ép về Doc tại biên xem trước như đường lưu. */}
                  <RichTextView value={{ type: 'doc', content: choice.content ?? [] } as Doc} />
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {form.qtype === 'truefalse' ? (
          <div className="space-y-3">
            {form.tfStatements.map((statement, index) => (
              <div key={index} className="space-y-1">
                <RichTextView value={statement.doc} />
                <div className="flex gap-4 text-sm">
                  <span className="flex items-center gap-1">
                    <input type="radio" disabled /> {t('questionTrue')}
                  </span>
                  <span className="flex items-center gap-1">
                    <input type="radio" disabled /> {t('questionFalse')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {form.qtype === 'shortanswer' ? (
          <Input disabled placeholder={t('questionAnswerPlaceholder')} />
        ) : null}
        {form.qtype === 'essay' ? (
          <textarea
            disabled
            rows={Math.min(15, Math.max(3, Number(form.essayResponseFieldLines) || 15))}
            className="w-full rounded-md border p-2 text-sm"
            placeholder={t('questionAnswerPlaceholder')}
          />
        ) : null}
        {form.qtype === 'essay' && docHasContent(form.essaySolution) ? (
          <div className="rounded-md border p-3">
            <p className="mb-1 text-sm font-medium">{t('modelAnswerHeading')}</p>
            <RichTextView value={form.essaySolution ?? null} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Trang soạn
// ---------------------------------------------------------------------------

/**
 * Trích đoạn nội dung của form đang soạn — nhãn hiển thị của câu hỏi
 * ở các bề mặt cần nhãn (tiêu đề màn sửa) vì câu hỏi không còn trường
 * tên (quyết 11:28 ngày 26/10/2026). Nguồn trích đoạn theo loại:
 * multichoice lấy phần thân câu của tài liệu thống nhất đã tách,
 * truefalse lấy mệnh đề đầu của chùm, hai loại còn lại lấy thân câu.
 *
 * @param form - Trạng thái form hiện tại.
 * @returns Chuỗi thuần tối đa 80 ký tự đầu của nội dung câu hỏi.
 */
function formExcerpt(form: QuestionEditorFormState): string {
  if (form.qtype === 'multichoice') {
    const { question } = splitMultipleChoiceDocument(form.mcDocument);
    return plainText(question as Doc).slice(0, 80);
  }
  const source = form.qtype === 'truefalse' ? form.tfStatements[0]?.doc : form.questionText;
  return source ? plainText(source).slice(0, 80) : '';
}

export function QuestionEditorPage({ mode }: { mode: 'new' | 'edit' }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const { questionId } = useParams();
  const [searchParams] = useSearchParams();
  const categoryParam = searchParams.get('category') ?? '';
  const [categories, setCategories] = useState<QuestionCategory[]>([]);
  const [categoryId, setCategoryId] = useState(categoryParam);
  const [editing, setEditing] = useState<QuestionView | null>(null);
  const [form, setForm] = useState<QuestionEditorFormState>(() => emptyEditorForm('multichoice'));
  const [stimuli, setStimuli] = useState<StimulusView[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'draft' | 'ready' | null>(null);
  const queryClient = useQueryClient();
  const editOptionsRequestRef = useRef(0);
  // Gắn kết chương trình (issue #20 Chặng 2) của câu hỏi đang sửa.
  const [links, setLinks] = useState<CurriculumLinksView | null>(null);
  const [linkSubjects, setLinkSubjects] = useState<{ id: string; name: string }[]>([]);
  const [linkSubjectPick, setLinkSubjectPick] = useState('');
  const [linkOutcomeOptions, setLinkOutcomeOptions] = useState<{ id: string; label: string }[]>([]);
  const [linkOutcomePick, setLinkOutcomePick] = useState('');
  const [linkLevelPick, setLinkLevelPick] = useState<string>('biet');
  const [outcomeLabels, setOutcomeLabels] = useState<Record<string, string>>({});

  const patchForm = useCallback((patch: Partial<QuestionEditorFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  /** Context của bank đích — bộ chọn ảnh tải lên đúng context này. */
  const contextId = categories.find((c) => c.id === categoryId)?.contextId;

  const loadStimuli = useCallback(async (catId: string) => {
    const rows = await apiJson<StimulusView[]>(`/api/v1/stimuli?categoryId=${catId}`);
    setStimuli(rows);
  }, []);

  /** Nạp gắn kết chương trình của câu hỏi + nhãn nội dung cho các YCCĐ đã gắn. */
  const loadCurriculumLinks = useCallback(async (qid: string) => {
    try {
      const view = await apiJson<CurriculumLinksView>(`/api/v1/questions/${qid}/curriculum-links`);
      setLinks(view);
      const labels: Record<string, string> = {};
      for (const o of view.outcomes) {
        try {
          const oc = await apiJson<{ id: string; content: string }>(`/api/v1/curriculum/outcomes/${o.outcomeId}`);
          labels[oc.id] = oc.content;
        } catch {
          // Thiếu nhãn thì dòng gắn vẫn hiện bằng id của YCCĐ.
        }
      }
      if (Object.keys(labels).length > 0) setOutcomeLabels((prev) => ({ ...prev, ...labels }));
    } catch {
      setLinks(null);
    }
  }, []);

  /** Môn học cho khối Chương trình: chương trình quốc gia GDPT 2018 neo ở context hệ thống. */
  const loadLinkSubjects = useCallback(async () => {
    try {
      const contexts = await apiJson<{ id: string; contextLevel: number }[]>('/api/v1/access/contexts');
      const system = contexts.find((c) => c.contextLevel === 10);
      if (!system) return;
      const rows = await apiJson<{ id: string; name: string }[]>(`/api/v1/curriculum/subjects?contextId=${system.id}`);
      setLinkSubjects(rows);
    } catch {
      // Khối chương trình là phụ trợ của editor; bỏ qua khi không tải được.
    }
  }, []);

  /** Mở editor sửa: nạp form từ view và tìm options đầy đủ ở endpoint versions khi view còn thiếu. */
  const startEdit = useCallback(
    async (view: QuestionView) => {
      const requestId = ++editOptionsRequestRef.current;
      setEditing(view);
      setForm(editorFormFromView(view));
      setLinks(null);
      setLinkSubjectPick('');
      setLinkOutcomePick('');
      setLinkOutcomeOptions([]);
      void loadCurriculumLinks(view.question.id);
      void loadLinkSubjects();

      const qtype = (QTYPES as readonly string[]).includes(view.question.qtype)
        ? (view.question.qtype as Qtype)
        : 'truefalse';
      if (hasAllOptions(qtype, view.options)) return;
      try {
        const versions = await apiJson<{ id: string; version: number; options?: OptionsRecord | null }[]>(
          `/api/v1/questions/${view.question.id}/versions`,
        );
        const latest =
          versions.find((version) => version.id === view.latestVersion.id) ??
          versions.find((version) => version.version === view.entry.latestVersion);
        if (latest?.options && editOptionsRequestRef.current === requestId) {
          setForm(editorFormFromView(view, latest.options));
        }
      } catch {
        // Không tải được options bổ sung thì giữ nguyên phần đã nạp từ view.
      }
    },
    [loadCurriculumLinks, loadLinkSubjects],
  );

  /** Khởi tạo màn: nạp danh mục (cần contextId cho bộ chọn ảnh), chốt danh mục đích, nạp ngữ liệu, và (khi sửa) tìm câu hỏi. */
  useEffect(() => {
    void (async () => {
      try {
        const cats = await apiJson<QuestionCategory[]>('/api/v1/questions/categories');
        setCategories(cats);
        let catId = categoryParam;
        if (!catId) {
          if (!cats.length) {
            setLoadError(t('questionBankLoadFailed'));
            return;
          }
          catId = String(cats[0]!.id);
          setCategoryId(catId);
        }
        await loadStimuli(catId).catch(() => setMessage(t('stimulusLoadFailed')));
        if (mode === 'edit' && questionId) {
          const rows = await apiJson<QuestionView[]>(`/api/v1/questions/categories/${catId}/questions`);
          const view = rows.find((r) => r.question.id === questionId);
          if (!view) {
            setLoadError(t('questionBankLoadFailed'));
            return;
          }
          await startEdit(view);
        }
      } catch {
        setLoadError(t('questionBankLoadFailed'));
      } finally {
        setLoading(false);
      }
    })();
    // Chỉ chạy một lần khi mở màn; categoryParam/questionId cố định theo route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Đưa trạng thái bank của câu về trạng thái đích sau khi lưu nội dung (không tạo phiên bản). */
  async function applyStatus(id: string, current: string | undefined, target: 'draft' | 'ready') {
    const needsCall =
      current === 'draft' || current === 'ready'
        ? current !== target
        : current === undefined && target === 'draft';
    if (!needsCall) return;
    await apiJson(`/api/v1/questions/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: target }),
    });
  }

  /** Lưu nội dung (tạo mới hoặc tạo phiên bản mới) rồi chốt trạng thái đích. */
  async function submitWith(target: 'draft' | 'ready') {
    if (saving) return;
    setMessage(null);
    setSaving(target);
    try {
      const effective = form;
      if (editing) {
        const updated = await apiJson<QuestionView>(`/api/v1/questions/${editing.question.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            ...editorFormContent(effective),
            stimulusId: form.stimulusId === '' ? null : form.stimulusId,
          }),
        });
        await applyStatus(editing.question.id, entryStatus(updated) ?? entryStatus(editing), target);
        clearQuestionBankListCache(queryClient);
        navigate('/questions', {
          state: {
            notice:
              target === 'draft'
                ? t('questionSavedDraft')
                : t('questionSavedAsVersion', { version: updated.entry.latestVersion }),
          },
        });
        return;
      }
      // Tạo chùm Đ/S: mỗi mệnh đề là một câu truefalse bám cùng ngữ liệu —
      // đúng mô hình của hệ (đường MCP cũng tạo mỗi mệnh đề một câu).
      if (form.qtype === 'truefalse' && form.tfStatements.length > 1) {
        let createdCount = 0;
        for (const statement of form.tfStatements) {
          const single: QuestionEditorFormState = {
            ...effective,
            tfStatements: [statement],
          };
          const created = await apiJson<QuestionView>('/api/v1/questions', {
            method: 'POST',
            body: JSON.stringify({
              categoryId,
              qtype: 'truefalse',
              ...editorFormContent(single),
              ...(form.stimulusId ? { stimulusId: form.stimulusId } : {}),
            }),
          });
          createdCount += 1;
          await applyStatus(created.question.id, entryStatus(created), target);
        }
        clearQuestionBankListCache(queryClient);
        navigate('/questions', { state: { notice: t('questionClusterCreated', { count: createdCount }) } });
        return;
      }
      const created = await apiJson<QuestionView>('/api/v1/questions', {
        method: 'POST',
        body: JSON.stringify({
          categoryId,
          qtype: form.qtype,
          ...editorFormContent(effective),
          ...(form.stimulusId ? { stimulusId: form.stimulusId } : {}),
        }),
      });
      await applyStatus(created.question.id, entryStatus(created), target);
      navigate('/questions', {
        state: { notice: target === 'draft' ? t('questionSavedDraft') : t('questionCreated') },
      });
    } catch (err) {
      setMessage(withApiReason(editing ? t('questionEditFailed') : t('questionCreateFailed'), err));
    } finally {
      setSaving(null);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submitWith('ready');
  }

  /** Chọn môn → nạp cây của mọi khối thuộc môn đó → danh sách YCCĐ chọn được. */
  async function pickLinkSubject(subjectId: string) {
    setLinkSubjectPick(subjectId);
    setLinkOutcomePick('');
    setLinkOutcomeOptions([]);
    if (!subjectId) return;
    try {
      const curricula = await apiJson<{ id: string; grade: number }[]>(
        `/api/v1/curriculum/curricula?subjectId=${subjectId}`,
      );
      const options: { id: string; label: string }[] = [];
      const labels: Record<string, string> = {};
      for (const curr of curricula) {
        const tree = await apiJson<{ nodes: CurriculumTreeNode[] }>(`/api/v1/curriculum/curricula/${curr.id}/tree`);
        const walk = (nodes: CurriculumTreeNode[]): void => {
          for (const node of nodes) {
            for (const outcome of node.outcomes) {
              options.push({ id: outcome.id, label: `${curr.grade} · ${node.title} · ${outcome.content}` });
              labels[outcome.id] = outcome.content;
            }
            walk(node.children);
          }
        };
        walk(tree.nodes);
      }
      setLinkOutcomeOptions(options);
      if (Object.keys(labels).length > 0) setOutcomeLabels((prev) => ({ ...prev, ...labels }));
    } catch {
      setMessage(t('programmeLoadFailed'));
    }
  }

  async function attachLinkSubject() {
    if (!editing || !linkSubjectPick) return;
    try {
      setLinks(
        await apiJson<CurriculumLinksView>(`/api/v1/questions/${editing.question.id}/subjects`, {
          method: 'POST',
          body: JSON.stringify({ subjectId: linkSubjectPick }),
        }),
      );
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function detachLinkSubject(subjectId: string) {
    if (!editing) return;
    try {
      setLinks(
        await apiJson<CurriculumLinksView>(`/api/v1/questions/${editing.question.id}/subjects/${subjectId}`, {
          method: 'DELETE',
        }),
      );
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function attachLinkOutcome() {
    if (!editing || !linkOutcomePick) return;
    try {
      setLinks(
        await apiJson<CurriculumLinksView>(`/api/v1/questions/${editing.question.id}/outcomes`, {
          method: 'POST',
          body: JSON.stringify({ outcomeId: linkOutcomePick, cognitiveLevel: linkLevelPick }),
        }),
      );
      setLinkOutcomePick('');
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function changeOutcomeLevel(outcomeId: string, cognitiveLevel: string) {
    if (!editing) return;
    try {
      setLinks(
        await apiJson<CurriculumLinksView>(`/api/v1/questions/${editing.question.id}/outcomes/${outcomeId}`, {
          method: 'PATCH',
          body: JSON.stringify({ cognitiveLevel }),
        }),
      );
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function detachLinkOutcome(outcomeId: string) {
    if (!editing) return;
    try {
      setLinks(
        await apiJson<CurriculumLinksView>(`/api/v1/questions/${editing.question.id}/outcomes/${outcomeId}`, {
          method: 'DELETE',
        }),
      );
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  if (loading) {
    return (
      <PageShell width="full">
        <PageHeader title={mode === 'edit' ? t('editNewVersion') : t('newQuestion')} />
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </PageShell>
    );
  }
  if (loadError) {
    return (
      <PageShell width="full">
        <PageHeader title={mode === 'edit' ? t('editNewVersion') : t('newQuestion')} />
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <p>
          <Link to="/questions" className="text-sm underline">
            {t('backToQuestionBankList')}
          </Link>
        </p>
      </PageShell>
    );
  }

  const currentStatus = entryStatus(editing);
  const statusLabel =
    currentStatus === 'draft'
      ? t('questionStatusDraft')
      : currentStatus === 'hidden'
        ? t('questionStatusHidden')
        : t('questionStatusReady');
  const selectedStimulus = stimuli.find((s) => s.id === form.stimulusId) ?? null;

  const moveItem = <T,>(items: T[], index: number, delta: number): T[] => {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) return items;
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    return next;
  };

  // Các lựa chọn hiện tại của tài liệu thống nhất (theo thứ tự soạn)
  // — chỉ để dựng hàng phản hồi theo lựa chọn ở dưới editor.
  const mcSplit = form.qtype === 'multichoice' ? splitMultipleChoiceDocument(form.mcDocument) : null;

  return (
    <PageShell width="full">
      <PageHeader title={mode === 'edit' ? t('editQuestionTitle', { name: formExcerpt(form) }) : t('newQuestion')} />
      {/* Slot toolbar của editor (lát E3 #248, theo cơ chế
          #editor-toolbar-slot của giaokhoa): editor đang active portal
          toolbar duy nhất của nó vào đây; chưa editor nào active thì
          slot rỗng và tự ẩn. */}
      <div
        id="editor-toolbar-slot"
        className="sticky top-2 z-30 mb-2 min-h-11 rounded-lg border bg-background shadow-sm empty:hidden"
      />
      <form onSubmit={onSubmit}>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                {editing ? statusLabel : t('questionStatusNew')}
              </span>
              <div className="ml-auto flex flex-wrap gap-2">
                {editing && (
                  <Button type="button" variant="outline" render={<Link to="/questions" />}>
                    {t('cancelEdit')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving !== null}
                  onClick={() => void submitWith('draft')}
                >
                  {t('saveDraft')}
                </Button>
                <Button type="submit" disabled={saving !== null}>
                  {editing ? t('saveNewVersion') : t('createQuestion')}
                </Button>
              </div>
            </div>
            {message ? (
              <Alert role="status" variant="destructive">
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}
            {/* Bố cục 2 cột BẰNG NHAU như giaokhoa (grid gap-6
                lg:grid-cols-2) + trang dùng toàn bề rộng (PageShell
                width="full" ở trên): trái soạn, phải xem trước. Trước
                lát E3 cột xem trước bị bó cố định 360px. */}
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <FieldGroup>
                {!editing && (
                  <Field>
                    <FieldLabel id="q-category-label">{t('category')}</FieldLabel>
                    <Select
                      items={Object.fromEntries(categories.map((c) => [c.id, c.name]))}
                      value={categoryId}
                      onValueChange={(v) => {
                        if (!v) return;
                        setCategoryId(v);
                        patchForm({ stimulusId: '' });
                        void loadStimuli(v).catch(() => setMessage(t('stimulusLoadFailed')));
                      }}
                    >
                      <SelectTrigger aria-labelledby="q-category-label" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
                <Field>
                  <FieldLabel id="q-type-label">{t('questionType')}</FieldLabel>
                  <Select
                    items={Object.fromEntries(QTYPES.map((qtype) => [qtype, t(QTYPE_LABEL_KEYS[qtype])]))}
                    value={form.qtype}
                    disabled={editing !== null}
                    onValueChange={(v) => {
                      const qtype = (v ?? 'multichoice') as Qtype;
                      setForm((prev) => {
                        const next = {
                          ...emptyEditorForm(qtype),
                          questionText: prev.questionText,
                          generalFeedback: prev.generalFeedback,
                          guidance: prev.guidance,
                          stimulusId: prev.stimulusId,
                        };
                        // Thân câu đi theo khi đổi loại: rời trắc
                        // nghiệm thì tách phần thân câu khỏi tài
                        // liệu thống nhất; vào trắc nghiệm thì lắp
                        // thân câu hiện có vào tài liệu thống nhất
                        // mới (lựa chọn bắt đầu rỗng).
                        if (prev.qtype === 'multichoice' && qtype !== 'multichoice') {
                          next.questionText = splitMultipleChoiceDocument(prev.mcDocument)
                            .question as Doc;
                        }
                        if (qtype === 'multichoice' && prev.qtype !== 'multichoice') {
                          next.mcDocument = composeMultipleChoiceDocument(prev.questionText, []);
                        }
                        return next;
                      });
                    }}
                  >
                    <SelectTrigger aria-labelledby="q-type-label" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QTYPES.map((qtype) => (
                        <SelectItem key={qtype} value={qtype}>
                          {t(QTYPE_LABEL_KEYS[qtype])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel id="q-stimulus-label">{t('attachedStimulus')}</FieldLabel>
                  <Select
                    items={Object.fromEntries([
                      ['none', t('noStimulus')],
                      ...stimuli.map((s) => [s.id, plainText(s.content).slice(0, 80)] as [string, string]),
                    ])}
                    value={form.stimulusId === '' ? 'none' : form.stimulusId}
                    onValueChange={(v) => patchForm({ stimulusId: v === 'none' || v === null ? '' : v })}
                  >
                    <SelectTrigger aria-labelledby="q-stimulus-label" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('noStimulus')}</SelectItem>
                      {stimuli.map((stimulus) => (
                        <SelectItem key={stimulus.id} value={stimulus.id}>
                          {plainText(stimulus.content).slice(0, 80)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                {form.qtype !== 'truefalse' && form.qtype !== 'multichoice' && (
                  <RichField
                    label={t('questionText')}
                    value={form.questionText}
                    onChange={(questionText) => patchForm({ questionText })}
                    size="default"
                    fileArea="questiontext"
                    contextId={contextId}
                    itemId={editing?.question.id}
                  />
                )}

                {form.qtype === 'multichoice' && (
                  <fieldset className="space-y-3">
                    <legend className="sr-only">{t('choices')}</legend>
                    {/* Soạn thống nhất kiểu giaokhoa: thân câu + 4
                        lựa chọn trong một tài liệu; chọn đáp án
                        đúng bằng radio tại từng lựa chọn trong
                        chính editor; kéo-thả trong editor để đổi
                        thứ tự lựa chọn. */}
                    <McDocumentField
                      label={t('questionText')}
                      value={form.mcDocument}
                      correctChoiceId={form.mcCorrectChoiceId}
                      onChange={(mcDocument) => patchForm({ mcDocument })}
                      onCorrectChoiceChange={(mcCorrectChoiceId) => patchForm({ mcCorrectChoiceId })}
                      contextId={contextId}
                      itemId={editing?.question.id}
                    />
                    <p className="text-sm text-muted-foreground">{t('mcAuthoringHint')}</p>
                    {/* Phản hồi theo lựa chọn là metadata của dòng
                        đáp án nên soạn ở các trường riêng bám theo
                        id choice (đi theo lựa chọn khi kéo-thả đổi
                        thứ tự), không nằm trong tài liệu lựa chọn. */}
                    {mcSplit?.choices.map((choice, index) => (
                      <RichField
                        key={choice.attrs.id}
                        label={t('answerFeedback', { index: index + 1 })}
                        value={form.mcChoiceFeedbacks[choice.attrs.id]}
                        onChange={(feedback) =>
                          patchForm({
                            mcChoiceFeedbacks: {
                              ...form.mcChoiceFeedbacks,
                              [choice.attrs.id]: feedback,
                            },
                          })
                        }
                        fileArea="feedback"
                        contextId={contextId}
                        itemId={editing?.question.id}
                      />
                    ))}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="q-mc-shuffle"
                          checked={form.mcShuffleAnswers}
                          onCheckedChange={(checked) => patchForm({ mcShuffleAnswers: checked === true })}
                        />
                        <Label htmlFor="q-mc-shuffle">{t('shuffleAnswers')}</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="q-mc-instruction"
                          checked={form.mcShowStandardInstruction}
                          onCheckedChange={(checked) =>
                            patchForm({ mcShowStandardInstruction: checked === true })
                          }
                        />
                        <Label htmlFor="q-mc-instruction">{t('showStandardInstruction')}</Label>
                      </div>
                      <Field>
                        <FieldLabel id="q-mc-numbering-label">{t('answerNumbering')}</FieldLabel>
                        <Select
                          items={{
                            abc: t('answerNumberingAbc'),
                            ABC: t('answerNumberingABC'),
                            '123': t('answerNumbering123'),
                            iii: t('answerNumberingIii'),
                            IIII: t('answerNumberingIIII'),
                            none: t('answerNumberingNone'),
                          }}
                          value={form.mcAnswerNumbering}
                          onValueChange={(v) => patchForm({ mcAnswerNumbering: v ?? 'abc' })}
                        >
                          <SelectTrigger aria-labelledby="q-mc-numbering-label" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="abc">{t('answerNumberingAbc')}</SelectItem>
                            <SelectItem value="ABC">{t('answerNumberingABC')}</SelectItem>
                            <SelectItem value="123">{t('answerNumbering123')}</SelectItem>
                            <SelectItem value="iii">{t('answerNumberingIii')}</SelectItem>
                            <SelectItem value="IIII">{t('answerNumberingIIII')}</SelectItem>
                            <SelectItem value="none">{t('answerNumberingNone')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                    <RichField
                      label={t('correctFeedback')}
                      value={form.mcCorrectFeedback}
                      onChange={(mcCorrectFeedback) => patchForm({ mcCorrectFeedback })}
                      fileArea="feedback"
                      contextId={contextId}
                      itemId={editing?.question.id}
                    />
                    <RichField
                      label={t('incorrectFeedback')}
                      value={form.mcIncorrectFeedback}
                      onChange={(mcIncorrectFeedback) => patchForm({ mcIncorrectFeedback })}
                      fileArea="feedback"
                      contextId={contextId}
                      itemId={editing?.question.id}
                    />
                  </fieldset>
                )}

                {form.qtype === 'truefalse' && (
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium">{t('tfStatementsHeading')}</legend>
                    <p className="text-sm text-muted-foreground">{t('tfClusterHint')}</p>
                    {form.tfStatements.map((statement, index) => (
                      <div key={index} className="space-y-2 rounded-md border p-3">
                        <RichField
                          label={t('tfStatement', { index: index + 1 })}
                          value={statement.doc}
                          onChange={(doc) =>
                            patchForm({
                              tfStatements: form.tfStatements.map((s, i) => (i === index ? { ...s, doc } : s)),
                            })
                          }
                          fileArea="questiontext"
                          contextId={contextId}
                          itemId={editing?.question.id}
                        />
                        <RadioGroup
                          value={statement.correct ? 'true' : 'false'}
                          onValueChange={(v) =>
                            patchForm({
                              tfStatements: form.tfStatements.map((s, i) =>
                                i === index ? { ...s, correct: v === 'true' } : s,
                              ),
                            })
                          }
                        >
                          <div className="flex items-center gap-2">
                            <RadioGroupItem id={`q-tf-${index}-true`} value="true" />
                            <Label htmlFor={`q-tf-${index}-true`}>{t('correctAnswerIsTrue')}</Label>
                          </div>
                          <div className="flex items-center gap-2">
                            <RadioGroupItem id={`q-tf-${index}-false`} value="false" />
                            <Label htmlFor={`q-tf-${index}-false`}>{t('correctAnswerIsFalse')}</Label>
                          </div>
                        </RadioGroup>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={index === 0}
                            aria-label={t('questionMoveUp')}
                            onClick={() => patchForm({ tfStatements: moveItem(form.tfStatements, index, -1) })}
                          >
                            ↑
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={index === form.tfStatements.length - 1}
                            aria-label={t('questionMoveDown')}
                            onClick={() => patchForm({ tfStatements: moveItem(form.tfStatements, index, 1) })}
                          >
                            ↓
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={form.tfStatements.length <= 1}
                            onClick={() =>
                              patchForm({ tfStatements: form.tfStatements.filter((_, i) => i !== index) })
                            }
                          >
                            {t('removeStatement', { index: index + 1 })}
                          </Button>
                        </div>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        patchForm({ tfStatements: [...form.tfStatements, { doc: emptyDoc(), correct: true }] })
                      }
                    >
                      {t('addStatement')}
                    </Button>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="q-tf-instruction"
                        checked={form.tfShowStandardInstruction}
                        onCheckedChange={(checked) =>
                          patchForm({ tfShowStandardInstruction: checked === true })
                        }
                      />
                      <Label htmlFor="q-tf-instruction">{t('showStandardInstruction')}</Label>
                    </div>
                  </fieldset>
                )}

                {form.qtype === 'shortanswer' && (
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium">{t('acceptedAnswers')}</legend>
                    {form.saAnswers.map((answer, index) => (
                      <div key={index} className="flex flex-wrap items-end gap-3 rounded-md border p-3">
                        <Field className="min-w-48 flex-1">
                          <FieldLabel htmlFor={`q-sa-answer-${index}`}>
                            {t('acceptedAnswerText', { index: index + 1 })}
                          </FieldLabel>
                          <Input
                            id={`q-sa-answer-${index}`}
                            value={answer.text}
                            onChange={(e) =>
                              patchForm({
                                saAnswers: form.saAnswers.map((a, i) =>
                                  i === index ? { ...a, text: e.target.value } : a,
                                ),
                              })
                            }
                          />
                        </Field>
                        <div className="flex gap-1 pb-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={index === 0}
                            aria-label={t('questionMoveUp')}
                            onClick={() => patchForm({ saAnswers: moveItem(form.saAnswers, index, -1) })}
                          >
                            ↑
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={index === form.saAnswers.length - 1}
                            aria-label={t('questionMoveDown')}
                            onClick={() => patchForm({ saAnswers: moveItem(form.saAnswers, index, 1) })}
                          >
                            ↓
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={form.saAnswers.length <= 1}
                            onClick={() => patchForm({ saAnswers: form.saAnswers.filter((_, i) => i !== index) })}
                          >
                            {t('removeAnswer', { index: index + 1 })}
                          </Button>
                        </div>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => patchForm({ saAnswers: [...form.saAnswers, { text: '' }] })}
                    >
                      {t('addAnswer')}
                    </Button>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="q-sa-usecase"
                        checked={form.saUseCase}
                        onCheckedChange={(checked) => patchForm({ saUseCase: checked === true })}
                      />
                      <Label htmlFor="q-sa-usecase">{t('caseSensitive')}</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="q-sa-numeric"
                        checked={form.saNumericAnswer}
                        onCheckedChange={(checked) => patchForm({ saNumericAnswer: checked === true })}
                      />
                      <Label htmlFor="q-sa-numeric">{t('numericAnswer')}</Label>
                    </div>
                    {form.saNumericAnswer && (
                      <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-3">
                        <Field>
                          <FieldLabel htmlFor="q-sa-numeric-maxlength">{t('numericMaxLength')}</FieldLabel>
                          <Input
                            id="q-sa-numeric-maxlength"
                            type="number"
                            min="1"
                            value={form.saNumericMaxLength}
                            onChange={(e) => patchForm({ saNumericMaxLength: e.target.value })}
                          />
                        </Field>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="q-sa-numeric-sign"
                            checked={form.saNumericAllowSign}
                            onCheckedChange={(checked) => patchForm({ saNumericAllowSign: checked === true })}
                          />
                          <Label htmlFor="q-sa-numeric-sign">{t('numericAllowSign')}</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="q-sa-numeric-decimal"
                            checked={form.saNumericAllowDecimal}
                            onCheckedChange={(checked) => patchForm({ saNumericAllowDecimal: checked === true })}
                          />
                          <Label htmlFor="q-sa-numeric-decimal">{t('numericAllowDecimal')}</Label>
                        </div>
                      </div>
                    )}
                  </fieldset>
                )}

                {form.qtype === 'essay' && (
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium">{t('questionOptions')}</legend>
                    <Field>
                      <FieldLabel id="q-essay-format-label">{t('responseFormat')}</FieldLabel>
                      <Select
                        items={{ editor: t('responseFormatEditor'), plain: t('responseFormatPlain') }}
                        value={form.essayResponseFormat}
                        onValueChange={(v) => patchForm({ essayResponseFormat: v ?? 'editor' })}
                      >
                        <SelectTrigger aria-labelledby="q-essay-format-label" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="editor">{t('responseFormatEditor')}</SelectItem>
                          <SelectItem value="plain">{t('responseFormatPlain')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="q-essay-required"
                        checked={form.essayResponseRequired}
                        onCheckedChange={(checked) => patchForm({ essayResponseRequired: checked === true })}
                      />
                      <Label htmlFor="q-essay-required">{t('responseRequired')}</Label>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field>
                        <FieldLabel htmlFor="q-essay-lines">{t('responseFieldLines')}</FieldLabel>
                        <Input
                          id="q-essay-lines"
                          type="number"
                          min="1"
                          value={form.essayResponseFieldLines}
                          onChange={(e) => patchForm({ essayResponseFieldLines: e.target.value })}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="q-essay-minwords">{t('minWordLimit')}</FieldLabel>
                        <Input
                          id="q-essay-minwords"
                          type="number"
                          min="0"
                          value={form.essayMinWords}
                          onChange={(e) => patchForm({ essayMinWords: e.target.value })}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="q-essay-maxwords">{t('maxWordLimit')}</FieldLabel>
                        <Input
                          id="q-essay-maxwords"
                          type="number"
                          min="0"
                          value={form.essayMaxWords}
                          onChange={(e) => patchForm({ essayMaxWords: e.target.value })}
                        />
                      </Field>
                    </div>
                    <RichField
                      label={t('graderInfo')}
                      value={form.essayGraderInfo}
                      onChange={(essayGraderInfo) => patchForm({ essayGraderInfo })}
                      fileArea="guidance"
                      contextId={contextId}
                      itemId={editing?.question.id}
                    />
                    <RichField
                      label={t('responseTemplate')}
                      value={form.essayResponseTemplate}
                      onChange={(essayResponseTemplate) => patchForm({ essayResponseTemplate })}
                      fileArea="guidance"
                      contextId={contextId}
                      itemId={editing?.question.id}
                    />
                    {/* Lời giải mẫu thuộc phía đáp án (answer_key)
                        như guidance — học sinh chỉ thấy ở màn xem
                        lại sau khi nộp; khác graderInfo ở trên là
                        thông tin riêng cho người chấm. */}
                    <RichField
                      label={t('modelAnswer')}
                      value={form.essaySolution}
                      onChange={(essaySolution) => patchForm({ essaySolution })}
                      fileArea="guidance"
                      contextId={contextId}
                      itemId={editing?.question.id}
                    />
                  </fieldset>
                )}

                {/* Hướng dẫn (guidance) có ở MỌI loại câu: gợi ý
                    cách làm hiện kèm câu hỏi khi học sinh làm bài
                    (điểm quyết D-4) — khác phản hồi chung/lời giải
                    là phần chỉ hiện sau khi nộp. Khi lưu nó đi ở
                    phía đáp án, không nằm trong thân câu. */}
                <div className="space-y-1">
                  <RichField
                    label={t('guidance')}
                    value={form.guidance}
                    onChange={(guidance) => patchForm({ guidance })}
                    fileArea="guidance"
                    contextId={contextId}
                    itemId={editing?.question.id}
                  />
                  <p className="text-sm text-muted-foreground">{t('guidanceHint')}</p>
                </div>

                <RichField
                  label={t('generalFeedback')}
                  value={form.generalFeedback}
                  onChange={(generalFeedback) => patchForm({ generalFeedback })}
                  fileArea="generalfeedback"
                  contextId={contextId}
                  itemId={editing?.question.id}
                />
              </FieldGroup>
              <StudentPreview form={form} stimulus={selectedStimulus} />
            </div>
          </CardContent>
        </Card>
      </form>

      {editing && (
        <Card data-testid="question-programme">
          <CardHeader>
            <CardTitle>{t('programmeHeading')}</CardTitle>
            <CardDescription>{t('programmeDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {links === null ? (
              <p className="text-sm text-muted-foreground">{t('programmeLoadFailed')}</p>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>{t('programmeSubjects')}</Label>
                  <ul className="space-y-2">
                    {links.subjectIds.map((subjectId) => (
                      <li key={subjectId} data-testid={`programme-subject-${subjectId}`} className="flex items-center gap-2">
                        <span className="flex-1 text-sm">
                          {linkSubjects.find((s) => s.id === subjectId)?.name ?? subjectId}
                        </span>
                        <Button type="button" variant="outline" onClick={() => void detachLinkSubject(subjectId)}>
                          {t('programmeDetach')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-end gap-2">
                    <Field className="flex-1">
                      <FieldLabel id="programme-subject-pick-label">{t('programmePickSubject')}</FieldLabel>
                      <Select
                        items={Object.fromEntries(linkSubjects.map((s) => [s.id, s.name]))}
                        value={linkSubjectPick === '' ? null : linkSubjectPick}
                        onValueChange={(v) => {
                          // Base UI tự phát null khi giá trị đang chọn bị
                          // lọc khỏi options (môn vừa gắn xong bị loại khỏi
                          // danh sách chọn) — đó không phải thao tác chọn
                          // của người dùng; bỏ qua để không xoá mất danh
                          // sách YCCĐ vừa nạp cho môn đó. Select native
                          // trước đây không có hiệu ứng phụ này.
                          if (!v) return;
                          void pickLinkSubject(v);
                        }}
                      >
                        <SelectTrigger aria-labelledby="programme-subject-pick-label" className="w-full">
                          <SelectValue placeholder={t('programmePickSubject')} />
                        </SelectTrigger>
                        <SelectContent>
                          {linkSubjects
                            .filter((s) => !links.subjectIds.includes(s.id))
                            .map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Button type="button" onClick={() => void attachLinkSubject()} disabled={!linkSubjectPick}>
                      {t('programmeAttach')}
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t('programmeOutcomes')}</Label>
                  <ul className="space-y-2">
                    {links.outcomes.map((o) => (
                      <li key={o.outcomeId} data-testid={`programme-outcome-${o.outcomeId}`} className="flex items-center gap-2">
                        <span className="flex-1 text-sm">{outcomeLabels[o.outcomeId] ?? o.outcomeId}</span>
                        <Select
                          items={Object.fromEntries(COGNITIVE_LEVELS.map((level) => [level, t(LEVEL_LABEL_KEYS[level])]))}
                          value={o.cognitiveLevel}
                          onValueChange={(v) => void changeOutcomeLevel(o.outcomeId, v ?? o.cognitiveLevel)}
                        >
                          <SelectTrigger aria-label={t('programmeLevel')} className="w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {COGNITIVE_LEVELS.map((level) => (
                              <SelectItem key={level} value={level}>
                                {t(LEVEL_LABEL_KEYS[level])}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button type="button" variant="outline" onClick={() => void detachLinkOutcome(o.outcomeId)}>
                          {t('programmeDetach')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-end gap-2">
                    <Field className="flex-1">
                      <FieldLabel id="programme-outcome-pick-label">{t('programmePickOutcome')}</FieldLabel>
                      <Select
                        items={Object.fromEntries(
                          linkOutcomeOptions
                            .filter((o) => !links.outcomes.some((l) => l.outcomeId === o.id))
                            .map((o) => [o.id, o.label]),
                        )}
                        value={linkOutcomePick === '' ? null : linkOutcomePick}
                        onValueChange={(v) => setLinkOutcomePick(v ?? '')}
                      >
                        <SelectTrigger aria-labelledby="programme-outcome-pick-label" className="w-full">
                          <SelectValue placeholder={t('programmePickOutcome')} />
                        </SelectTrigger>
                        <SelectContent>
                          {linkOutcomeOptions
                            .filter((o) => !links.outcomes.some((l) => l.outcomeId === o.id))
                            .map((o) => (
                              <SelectItem key={o.id} value={o.id}>
                                {o.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel id="programme-level-pick-label">{t('programmeLevel')}</FieldLabel>
                      <Select items={Object.fromEntries(COGNITIVE_LEVELS.map((level) => [level, t(LEVEL_LABEL_KEYS[level])]))} value={linkLevelPick} onValueChange={(v) => setLinkLevelPick(v ?? 'biet')}>
                        <SelectTrigger aria-labelledby="programme-level-pick-label" className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {COGNITIVE_LEVELS.map((level) => (
                            <SelectItem key={level} value={level}>
                              {t(LEVEL_LABEL_KEYS[level])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Button type="button" onClick={() => void attachLinkOutcome()} disabled={!linkOutcomePick}>
                      {t('programmeAttach')}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <p>
        <Link to="/questions" className="text-sm underline">
          {t('backToQuestionBankList')}
        </Link>
      </p>
    </PageShell>
  );
}

/** Màn tạo câu hỏi mới (route /questions/new). */
export function QuestionNewPage() {
  return <QuestionEditorPage mode="new" />;
}

/** Màn sửa câu hỏi (route /questions/:questionId/edit) — lưu thành phiên bản mới. */
export function QuestionEditPage() {
  return <QuestionEditorPage mode="edit" />;
}

export default QuestionNewPage;
