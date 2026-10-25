import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import {
  extractRichTextPlainText,
  type QuestionCategory,
  type QuestionUsage,
  type QuestionView,
  type RichTextDocument,
  type StimulusView,
} from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@lms/ui/components/collapsible';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';
import { Skeleton } from '@lms/ui/components/skeleton';
import { Textarea } from '@lms/ui/components/textarea';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiJson, ApiError } from '#lib/api';
import { usePermissions } from '#lib/permissions';
import { DataTable, type DataColumn } from '#components/data-table';

/**
 * Thông báo lỗi kèm lý do thật từ API (ProblemDetails.detail) — trước
 * đây các catch nuốt lỗi gốc và chỉ hiện câu chung chung, giáo viên
 * không biết sai ở đâu (issue #55 mục 3). Export để màn editor riêng
 * (question-editor.tsx) dùng chung đúng hành vi này.
 */
export function withApiReason(fallback: string, err: unknown): string {
  if (err instanceof ApiError) {
    const reason = err.problem.detail ?? err.problem.title;
    if (reason) return `${fallback} ${reason}`;
  }
  return fallback;
}

/** Một lựa chọn ngữ cảnh cho form danh mục mới. */
interface ContextOption {
  id: string;
  level: number;
  label: string;
}

export const QTYPES = ['multichoice', 'truefalse', 'shortanswer', 'essay'] as const;
export type Qtype = (typeof QTYPES)[number];

export const QTYPE_LABEL_KEYS: Record<Qtype, string> = {
  multichoice: 'qtypeMultichoice',
  truefalse: 'qtypeTruefalse',
  shortanswer: 'qtypeShortanswer',
  essay: 'qtypeEssay',
};

/** Mức độ nhận thức trên dòng nối câu hỏi × YCCĐ (issue #20 Chặng 2, mục A.2). */
export const COGNITIVE_LEVELS = ['biet', 'hieu', 'van_dung', 'van_dung_cao'] as const;
export const LEVEL_LABEL_KEYS: Record<(typeof COGNITIVE_LEVELS)[number], string> = {
  biet: 'levelBiet',
  hieu: 'levelHieu',
  van_dung: 'levelVanDung',
  van_dung_cao: 'levelVanDungCao',
};

/** Gắn kết chương trình của một câu hỏi — hình dạng của GET /questions/:id/curriculum-links. */
export interface CurriculumLinksView {
  questionId: string;
  subjectIds: string[];
  outcomes: { outcomeId: string; cognitiveLevel: string }[];
}

/** Một node trong cây chương trình trả về bởi GET /curriculum/curricula/:id/tree. */
export interface CurriculumTreeNode {
  id: string;
  title: string;
  outcomes: { id: string; content: string }[];
  children: CurriculumTreeNode[];
}

/** Bank như API lớp bank trả về (feat Ngân hàng câu hỏi chung, issue #70; bankKind + capabilities.matrix* là của MB-1, issue #111). */
interface BankLite {
  id: string;
  name: string;
  scope: string;
  bankKind: string;
  defaultCategoryId: string | null;
  categoryIds: string[];
  capabilities: {
    use: boolean; add: boolean; moderate: boolean; copy: boolean;
    matrixView?: boolean; matrixManage?: boolean; matrixCopy?: boolean; matrixShare?: boolean; matrixModerate?: boolean;
  };
}

/** Một ma trận trong ngân hàng ma trận (MB-1) — hình dạng ExamMatrixView của API. */
interface MatrixLite {
  id: string;
  name: string;
  subjectId: string;
  curriculumId: string;
  bankId: string | null;
  status: string;
  isTemplate: boolean;
  derivedFromMatrixId: string | null;
  version: number;
  presetKind: string;
  cells: { id: string }[];
}

/** Một đề xuất đóng góp ma trận trong hàng chờ duyệt (MB-1). */
interface MatrixContributionLite {
  id: string;
  matrixId: string;
  matrixName: string | null;
  proposerName: string | null;
  status: string;
  note: string;
  rejectReason: string | null;
}

/** Dòng ghi công của một câu copy (GET /questions/:id/attribution). */
interface AttributionLite {
  originalAuthorName: string | null;
  sourceBankName: string | null;
}

/** Một dòng tóm tắt đề trong ngân hàng đề (GET /exam-papers/banks/:bankId/papers). */
interface PaperSummaryLite {
  id: string;
  bankId: string;
  status: string;
  name: string;
  examKind: string | null;
  slotCount: number;
  latestVersion: number;
  createdBy: string;
  copyCount: number;
  capabilities: { edit: boolean; copy: boolean; deploy: boolean; moderate: boolean };
}

/** Một đề xuất đóng góp ĐỀ trong hàng chờ của một bank đề (EB-1). */
interface ExamContributionLite {
  id: string;
  paperId: string;
  paperName: string | null;
  status: string;
  proposerId: string;
}

/** Khoá học cho hộp thoại triển khai đề vào quiz. */
interface CourseLite {
  id: string;
  fullName: string;
}

/** Quiz cho hộp thoại triển khai đề (GET /courses/:id/quizzes). */
interface QuizLite {
  id: string;
  name: string;
  paperId: string | null;
}

/** Một dòng của trang khám phá ngân hàng chung (GET /questions/discovery). */
interface DiscoveryItemLite {
  questionId: string;
  name: string;
  qtype: string;
  status: string;
  bankId: string;
  bankName: string;
  bankScope: string;
  authorName: string | null;
  originalAuthorName: string | null;
  useCount: number;
  copyCount: number;
}

/** Một đề xuất đóng góp trong hàng chờ duyệt (QB-4). */
interface ContributionLite {
  id: string;
  questionId: string;
  questionName: string | null;
  proposerName: string | null;
  status: string;
  mode: string;
  note: string;
  nearDuplicateOf: string | null;
}

/** Một dòng đáp án đang soạn trong form (fraction giữ dạng chuỗi để nhập liệu tự do). */
interface AnswerDraft {
  text: string;
  fraction: string;
}

/**
 * State của editor câu hỏi: dùng chung cho tạo mới và sửa. Phần đáp án của
 * cả bốn dạng sống cạnh nhau; khi lưu chỉ phần thuộc qtype đang chọn được
 * đóng gói vào payload theo đúng hợp đồng `createQuestionSchema` /
 * `updateQuestionSchema` (answers + options theo qtype; truefalse dùng
 * dạng payload `answer: { correct }` mà tầng nghiệp vụ yêu cầu).
 */
export interface QuestionFormState {
  qtype: Qtype;
  name: string;
  questionText: string;
  stimulusId: string;
  mcSingle: boolean;
  mcShuffleAnswers: boolean;
  mcAnswerNumbering: string;
  mcShowNumCorrect: boolean;
  mcShowStandardInstruction: boolean;
  mcCorrectFeedback: RichTextDocument | undefined;
  mcPartiallyCorrectFeedback: RichTextDocument | undefined;
  mcIncorrectFeedback: RichTextDocument | undefined;
  mcChoices: AnswerDraft[];
  tfCorrect: boolean;
  tfShowStandardInstruction: boolean;
  saUseCase: boolean;
  saAnswers: AnswerDraft[];
  essayResponseFormat: string;
  essayResponseRequired: boolean;
  essayResponseFieldLines: string;
  essayMinWords: string;
  essayMaxWords: string;
  essayGraderInfo: string;
  essayResponseTemplate: string;
}

export function plainText(doc: RichTextDocument | null | undefined): string {
  return doc ? extractRichTextPlainText(doc) : '';
}

export function emptyForm(qtype: Qtype): QuestionFormState {
  return {
    qtype,
    name: '',
    questionText: '',
    stimulusId: '',
    mcSingle: true,
    mcShuffleAnswers: false,
    mcAnswerNumbering: 'abc',
    mcShowNumCorrect: false,
    mcShowStandardInstruction: true,
    mcCorrectFeedback: undefined,
    mcPartiallyCorrectFeedback: undefined,
    mcIncorrectFeedback: undefined,
    mcChoices: [
      { text: '', fraction: '1' },
      { text: '', fraction: '0' },
    ],
    tfCorrect: true,
    tfShowStandardInstruction: true,
    saUseCase: false,
    saAnswers: [{ text: '', fraction: '1' }],
    essayResponseFormat: 'editor',
    essayResponseRequired: true,
    essayResponseFieldLines: '15',
    essayMinWords: '',
    essayMaxWords: '',
    essayGraderInfo: '',
    essayResponseTemplate: '',
  };
}

export type OptionsRecord = Record<string, unknown>;

/** Các trường options phải còn nguyên khi sửa; thiếu trường nào thì form sẽ tìm thêm ở endpoint versions. */
const OPTION_KEYS_BY_QTYPE: Record<Qtype, string[]> = {
  multichoice: [
    'single',
    'shuffleAnswers',
    'answerNumbering',
    'showNumCorrect',
    'showStandardInstruction',
    'correctFeedback',
    'partiallyCorrectFeedback',
    'incorrectFeedback',
  ],
  truefalse: ['showStandardInstruction'],
  shortanswer: ['useCase'],
  essay: [
    'responseFormat',
    'responseRequired',
    'responseFieldLines',
    'minWordLimit',
    'maxWordLimit',
    'graderInfo',
    'responseTemplate',
  ],
};

export function hasAllOptions(qtype: Qtype, options: OptionsRecord | null | undefined): boolean {
  if (!options) return false;
  return OPTION_KEYS_BY_QTYPE[qtype].every(
    (key) => Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined,
  );
}

function richTextDocument(value: unknown): RichTextDocument | undefined {
  return value !== null && typeof value === 'object' ? (value as RichTextDocument) : undefined;
}

/** Nạp một câu hỏi có sẵn vào editor: đáp án/options lấy từ view của phiên bản mới nhất. */
export function formFromView(view: QuestionView, fallbackOptions?: OptionsRecord | null): QuestionFormState {
  const qtype = (QTYPES as readonly string[]).includes(view.question.qtype)
    ? (view.question.qtype as Qtype)
    : 'truefalse';
  const base = emptyForm(qtype);
  const options: OptionsRecord = { ...(fallbackOptions ?? {}) };
  for (const [key, value] of Object.entries((view.options ?? {}) as OptionsRecord)) {
    if (value !== undefined) options[key] = value;
  }
  const answers = (view.answers ?? []).map((a) => ({ text: plainText(a.answer), fraction: String(a.fraction) }));
  const trueAnswer = (view.answers ?? []).find((a) => plainText(a.answer) === 'True');
  return {
    ...base,
    name: view.question.name,
    questionText: plainText(view.latestVersion.questionText),
    stimulusId: view.latestVersion.stimulusId ?? '',
    mcSingle: typeof options.single === 'boolean' ? options.single : true,
    mcShuffleAnswers: typeof options.shuffleAnswers === 'boolean' ? options.shuffleAnswers : false,
    mcAnswerNumbering: typeof options.answerNumbering === 'string' ? options.answerNumbering : 'abc',
    mcShowNumCorrect: typeof options.showNumCorrect === 'boolean' ? options.showNumCorrect : false,
    mcShowStandardInstruction:
      typeof options.showStandardInstruction === 'boolean' ? options.showStandardInstruction : true,
    mcCorrectFeedback: richTextDocument(options.correctFeedback),
    mcPartiallyCorrectFeedback: richTextDocument(options.partiallyCorrectFeedback),
    mcIncorrectFeedback: richTextDocument(options.incorrectFeedback),
    mcChoices: qtype === 'multichoice' && answers.length > 0 ? answers : base.mcChoices,
    tfCorrect: trueAnswer ? trueAnswer.fraction >= 1 : true,
    tfShowStandardInstruction:
      typeof options.showStandardInstruction === 'boolean' ? options.showStandardInstruction : true,
    saUseCase: options.useCase === true,
    saAnswers: qtype === 'shortanswer' && answers.length > 0 ? answers : base.saAnswers,
    essayResponseFormat: typeof options.responseFormat === 'string' ? options.responseFormat : 'editor',
    essayResponseRequired: typeof options.responseRequired === 'boolean' ? options.responseRequired : true,
    essayResponseFieldLines:
      typeof options.responseFieldLines === 'number' ? String(options.responseFieldLines) : '15',
    essayMinWords: typeof options.minWordLimit === 'number' ? String(options.minWordLimit) : '',
    essayMaxWords: typeof options.maxWordLimit === 'number' ? String(options.maxWordLimit) : '',
    essayGraderInfo: plainText(options.graderInfo as RichTextDocument | null | undefined),
    essayResponseTemplate: plainText(options.responseTemplate as RichTextDocument | null | undefined),
  };
}

/**
 * Đóng gói phần nội dung của form thành payload theo qtype. Rich text giữ
 * ở mức văn bản thuần (chuỗi) như lát hiện tại — hợp đồng API nhận chuỗi
 * và tự chuẩn hoá thành tài liệu Tiptap.
 */
export function formContent(form: QuestionFormState, preserveExistingOptions = false): Record<string, unknown> {
  const common = { name: form.name, questionText: form.questionText };
  switch (form.qtype) {
    case 'multichoice': {
      const options: Record<string, unknown> = { single: form.mcSingle };
      if (preserveExistingOptions) {
        options.shuffleAnswers = form.mcShuffleAnswers;
        options.answerNumbering = form.mcAnswerNumbering;
        options.showNumCorrect = form.mcShowNumCorrect;
        options.showStandardInstruction = form.mcShowStandardInstruction;
        // Feedback là rich text: gửi lại nguyên tài liệu đã nạp, không ép về text thuần.
        if (form.mcCorrectFeedback) options.correctFeedback = form.mcCorrectFeedback;
        if (form.mcPartiallyCorrectFeedback) options.partiallyCorrectFeedback = form.mcPartiallyCorrectFeedback;
        if (form.mcIncorrectFeedback) options.incorrectFeedback = form.mcIncorrectFeedback;
      }
      return {
        ...common,
        answers: form.mcChoices.map((c) => ({ text: c.text, fraction: Number(c.fraction) || 0 })),
        options,
      };
    }
    case 'truefalse':
      return {
        ...common,
        answer: { correct: form.tfCorrect },
        ...(preserveExistingOptions ? { options: { showStandardInstruction: form.tfShowStandardInstruction } } : {}),
      };
    case 'shortanswer':
      return {
        ...common,
        answers: form.saAnswers.map((a) => ({ text: a.text, fraction: Number(a.fraction) || 0 })),
        options: { useCase: form.saUseCase },
      };
    case 'essay':
      return {
        ...common,
        options: {
          responseFormat: form.essayResponseFormat,
          responseRequired: form.essayResponseRequired,
          responseFieldLines:
            form.essayResponseFieldLines.trim() === '' ? 15 : Number(form.essayResponseFieldLines) || 15,
          minWordLimit: form.essayMinWords.trim() === '' ? null : Number(form.essayMinWords),
          maxWordLimit: form.essayMaxWords.trim() === '' ? null : Number(form.essayMaxWords),
          graderInfo: form.essayGraderInfo,
          responseTemplate: form.essayResponseTemplate,
        },
      };
  }
}

/**
 * Question bank: categories, questions with their CURRENT version
 * badge, create/edit. Editing creates a new version server-side — the badge
 * increments and the version history shows every version (attempts already
 * started keep the version they pinned; that invariant is API-side).
 */
export function QuestionsPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const perms = usePermissions();
  const [selected, setSelected] = useState<string[]>([]);
  const [categories, setCategories] = useState<QuestionCategory[]>([]);
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [stimuli, setStimuli] = useState<StimulusView[]>([]);
  const [versionsOf, setVersionsOf] = useState<{
    questionId: string;
    versions: { version: number; questionText: RichTextDocument }[];
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [qCategory, setQCategory] = useState('');
  const [stimulusContent, setStimulusContent] = useState('');
  const [editingStimulus, setEditingStimulus] = useState<StimulusView | null>(null);
  const [loading, setLoading] = useState(true);
  // Lớp bank của feat Ngân hàng câu hỏi chung (issue #70): khu vực ngân
  // hàng riêng của giáo viên + khu vực Ngân hàng hệ thống (bank chung).
  const [banks, setBanks] = useState<BankLite[]>([]);
  const [myOpen, setMyOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [myQuestions, setMyQuestions] = useState<QuestionView[]>([]);
  const [attributions, setAttributions] = useState<Record<string, AttributionLite>>({});
  const [discBankId, setDiscBankId] = useState('');
  const [discKeyword, setDiscKeyword] = useState('');
  const [discQtype, setDiscQtype] = useState('');
  const [discResults, setDiscResults] = useState<DiscoveryItemLite[]>([]);
  const [contributions, setContributions] = useState<ContributionLite[]>([]);
  const [previewItem, setPreviewItem] = useState<QuestionView | null>(null);
  const [proposeQuestionId, setProposeQuestionId] = useState('');
  const [proposeBankId, setProposeBankId] = useState('');
  // Ngân hàng ma trận (MB-1, issue #111): khu riêng "Ma trận của tôi" +
  // section ma trận chung trong Ngân hàng hệ thống — cùng khuôn hai khu
  // vực phân biệt của ngân hàng câu hỏi.
  const [matrixBanks, setMatrixBanks] = useState<BankLite[]>([]);
  const [myMatrixOpen, setMyMatrixOpen] = useState(false);
  const [myMatrices, setMyMatrices] = useState<MatrixLite[]>([]);
  const [subjects, setSubjects] = useState<{ id: string; name: string }[]>([]);
  const [sharedMatrixBankId, setSharedMatrixBankId] = useState('');
  const [sharedMatrices, setSharedMatrices] = useState<MatrixLite[]>([]);
  const [matrixSubjectFilter, setMatrixSubjectFilter] = useState('');
  const [matrixPresetFilter, setMatrixPresetFilter] = useState('');
  const [matrixContributions, setMatrixContributions] = useState<MatrixContributionLite[]>([]);
  const [proposeMatrixId, setProposeMatrixId] = useState('');
  const [proposeMatrixBankId, setProposeMatrixBankId] = useState('');

  // Ngân hàng đề (EB-1, issue #113): bank đề dùng chung khuôn bank đa
  // loại (kind=exam); "Đề của tôi" là collapse riêng song song "Ngân
  // hàng riêng của tôi" của câu hỏi, theo mô hình hai khu vực đã chốt.
  const [examBanks, setExamBanks] = useState<BankLite[]>([]);
  const [myPapersOpen, setMyPapersOpen] = useState(false);
  const [myPapers, setMyPapers] = useState<PaperSummaryLite[]>([]);
  const [systemExamBankId, setSystemExamBankId] = useState('');
  const [systemPapers, setSystemPapers] = useState<PaperSummaryLite[]>([]);
  const [paperContributions, setPaperContributions] = useState<ExamContributionLite[]>([]);
  const [proposePaperId, setProposePaperId] = useState('');
  const [proposePaperBankId, setProposePaperBankId] = useState('');
  const [deployPaper, setDeployPaper] = useState<PaperSummaryLite | null>(null);
  const [deployCourses, setDeployCourses] = useState<CourseLite[]>([]);
  const [deployCourseId, setDeployCourseId] = useState('');
  const [deployQuizzes, setDeployQuizzes] = useState<QuizLite[]>([]);
  const [deployQuizId, setDeployQuizId] = useState('');

  const loadQuestions = useCallback(async (categoryId: string) => {
    const rows = await apiJson<QuestionView[]>(`/api/v1/questions/categories/${categoryId}/questions`);
    setQuestions(rows);
  }, []);
  const loadStimuli = useCallback(async (categoryId: string) => {
    const rows = await apiJson<StimulusView[]>(`/api/v1/stimuli?categoryId=${categoryId}`);
    setStimuli(rows);
  }, []);
  const reload = useCallback(async () => {
    const cats = await apiJson<QuestionCategory[]>('/api/v1/questions/categories');
    setCategories(cats);
    if (cats.length) {
      const effective = qCategory || String(cats[0]!.id);
      setQCategory((prev) => prev || String(cats[0]!.id));
      await loadQuestions(effective);
      await loadStimuli(effective).catch(() => setMessage(t('stimulusLoadFailed')));
    }
  }, [loadQuestions, loadStimuli, qCategory, t]);

  // Thông báo mang về từ màn sửa riêng (vd "Đã lưu thành phiên bản N…"
  // sau khi sửa câu hỏi) qua router state — giữ phản hồi lưu thành công
  // mà editor inline trước đây hiện ngay trên trang này.
  const location = useLocation();
  useEffect(() => {
    const notice = (location.state as { notice?: string } | null)?.notice;
    if (notice) setMessage(notice);
  }, [location.state]);

  useEffect(() => {
    // Vai không có capability ngân hàng: không gọi API dữ liệu nào cả —
    // trang render trạng thái không-có-quyền ở dưới (issue #55 mục 1).
    if (!perms.ready || !perms.canUseQuestionBank) return;
    void reload()
      .catch(() => setMessage(t('questionBankLoadFailed')))
      .finally(() => setLoading(false));
  }, [reload, perms.ready, perms.canUseQuestionBank]);

  const personalBank = banks.find((b) => b.scope === 'personal');
  const sharedBanks = banks.filter((b) => b.scope !== 'personal');

  const loadAttributionsFor = useCallback(async (views: QuestionView[]) => {
    const derived = views.filter(
      (v) => (v.question as { derivedFromQuestionId?: string | null }).derivedFromQuestionId,
    );
    for (const v of derived) {
      if (attributions[v.question.id]) continue;
      try {
        const a = await apiJson<AttributionLite>(`/api/v1/questions/${v.question.id}/attribution`);
        setAttributions((prev) => ({ ...prev, [v.question.id]: a }));
      } catch {
        // Không có dòng ghi công thì thôi — không chặn danh sách.
      }
    }
  }, [attributions]);

  const loadMyQuestions = useCallback(async (bankList: BankLite[]) => {
    const mine = bankList.find((b) => b.scope === 'personal');
    if (!mine) return;
    const all: QuestionView[] = [];
    for (const categoryId of mine.categoryIds) {
      try {
        const rows = await apiJson<QuestionView[]>(`/api/v1/questions/categories/${categoryId}/questions`);
        all.push(...rows);
      } catch {
        // Bỏ qua category lỗi.
      }
    }
    setMyQuestions(all);
    void loadAttributionsFor(all);
  }, [loadAttributionsFor]);

  const loadBanks = useCallback(async () => {
    try {
      const rows = await apiJson<BankLite[]>('/api/v1/question-banks');
      setBanks(rows);
      await loadMyQuestions(rows);
    } catch {
      setBanks([]);
    }
  }, [loadMyQuestions]);

  useEffect(() => {
    void loadBanks();
  }, [loadBanks]);

  // --- ngân hàng ma trận (MB-1) -------------------------------------------------

  const personalMatrixBank = matrixBanks.find((b) => b.scope === 'personal');
  const sharedMatrixBanks = matrixBanks.filter((b) => b.scope !== 'personal');

  const loadMyMatrices = useCallback(async (bankList: BankLite[]) => {
    const mine = bankList.find((b) => b.scope === 'personal');
    if (!mine) {
      setMyMatrices([]);
      return;
    }
    try {
      setMyMatrices(await apiJson<MatrixLite[]>(`/api/v1/question-banks/${mine.id}/matrices`));
    } catch {
      setMyMatrices([]);
    }
  }, []);

  const loadMatrixBanks = useCallback(async () => {
    try {
      const rows = await apiJson<BankLite[]>('/api/v1/question-banks?kind=matrix');
      setMatrixBanks(rows);
      await loadMyMatrices(rows);
    } catch {
      setMatrixBanks([]);
    }
  }, [loadMyMatrices]);

  useEffect(() => {
    void loadMatrixBanks();
  }, [loadMatrixBanks]);

  useEffect(() => {
    void (async () => {
      try {
        setSubjects(await apiJson<{ id: string; name: string }[]>('/api/v1/curriculum/subjects'));
      } catch {
        setSubjects([]);
      }
    })();
  }, []);

  /** Nạp ma trận + hàng chờ đóng góp của một bank ma trận chung đang chọn. */
  async function loadSharedMatrices(bankId: string) {
    if (!bankId) {
      setSharedMatrices([]);
      setMatrixContributions([]);
      return;
    }
    try {
      setSharedMatrices(await apiJson<MatrixLite[]>(`/api/v1/question-banks/${bankId}/matrices`));
    } catch {
      setSharedMatrices([]);
    }
    try {
      setMatrixContributions(
        await apiJson<MatrixContributionLite[]>(`/api/v1/question-banks/${bankId}/matrix-contributions?status=pending`),
      );
    } catch {
      setMatrixContributions([]);
    }
  }

  /** Copy một ma trận chung về ngân hàng ma trận cá nhân (cầu nối hai khu vực, MB-1). */
  async function copyMatrixToMyBank(matrixId: string) {
    try {
      await apiJson(`/api/v1/exam-matrices/${matrixId}/copy`, { method: 'POST', body: '{}' });
      setMessage(t('matrixCopiedToMyBank'));
      await loadMatrixBanks();
    } catch {
      setMessage(t('matrixCopyFailed'));
    }
  }

  /** Xoá một ma trận của mình ngay tại dòng (§9). */
  async function deleteMyMatrix(matrixId: string) {
    if (!window.confirm(t('matrixDeleteConfirm'))) return;
    try {
      await apiJson(`/api/v1/exam-matrices/${matrixId}`, { method: 'DELETE' });
      setMessage(t('matrixDeleted'));
      await loadMatrixBanks();
    } catch {
      setMessage(t('matrixDeleteFailed'));
    }
  }

  /** Đề xuất đóng góp một ma trận ready của mình lên bank ma trận chung. */
  async function proposeMatrixToBank(matrixId: string, targetBankId: string) {
    if (!matrixId || !targetBankId) return;
    try {
      await apiJson(`/api/v1/exam-matrices/${matrixId}/contributions`, {
        method: 'POST',
        body: JSON.stringify({ targetBankId }),
      });
      setMessage(t('proposedOk'));
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  /** Duyệt/từ chối một đóng góp ma trận (từ chối hỏi lý do — bắt buộc). */
  async function reviewMatrixContribution(bankId: string, contributionId: string, approve: boolean) {
    try {
      if (approve) {
        await apiJson(`/api/v1/question-banks/${bankId}/matrix-contributions/${contributionId}/approve`, {
          method: 'POST',
          body: '{}',
        });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await apiJson(`/api/v1/question-banks/${bankId}/matrix-contributions/${contributionId}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      }
      await loadSharedMatrices(bankId);
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  const subjectName = (subjectId: string) => subjects.find((s) => s.id === subjectId)?.name ?? '';
  const matrixStatusKey = (status: string) => `matrixStatus${status[0]!.toUpperCase()}${status.slice(1)}`;
  const matrixPresetKey = (kind: string) =>
    kind === 'cv7991_periodic' ? 'matrixPresetPeriodic' : kind === 'qd764_graduation' ? 'matrixPresetGraduation' : 'matrixPresetCustom';
  const filteredSharedMatrices = sharedMatrices.filter(
    (m) =>
      (!matrixSubjectFilter || m.subjectId === matrixSubjectFilter) &&
      (!matrixPresetFilter || m.presetKind === matrixPresetFilter),
  );

  const personalExamBank = examBanks.find((b) => b.scope === 'personal');
  const sharedExamBanks = examBanks.filter((b) => b.scope !== 'personal');

  const loadMyPapers = useCallback(async (bankList: BankLite[]) => {
    const mine = bankList.find((b) => b.scope === 'personal');
    if (!mine) { setMyPapers([]); return; }
    try {
      const rows = await apiJson<PaperSummaryLite[]>(`/api/v1/exam-papers/banks/${mine.id}/papers`);
      setMyPapers(rows);
    } catch {
      setMyPapers([]);
    }
  }, []);

  const loadExamBanks = useCallback(async () => {
    try {
      const rows = await apiJson<BankLite[]>('/api/v1/question-banks?kind=exam');
      setExamBanks(rows);
      await loadMyPapers(rows);
    } catch {
      setExamBanks([]);
    }
  }, [loadMyPapers]);

  useEffect(() => {
    void loadExamBanks();
  }, [loadExamBanks]);

  /** Danh sách đề + hàng chờ đóng góp của một bank đề trong Ngân hàng hệ thống. */
  async function loadSystemPapers(bankId: string) {
    setSystemExamBankId(bankId);
    if (!bankId) { setSystemPapers([]); setPaperContributions([]); return; }
    try {
      const rows = await apiJson<PaperSummaryLite[]>(`/api/v1/exam-papers/banks/${bankId}/papers`);
      setSystemPapers(rows);
    } catch {
      setSystemPapers([]);
    }
    try {
      const rows = await apiJson<ExamContributionLite[]>(`/api/v1/exam-papers/banks/${bankId}/contributions`);
      setPaperContributions(rows.filter((c) => c.status === 'pending'));
    } catch {
      setPaperContributions([]);
    }
  }

  /** Copy một đề từ ngân hàng hệ thống về ngân hàng đề cá nhân (cầu nối hai khu vực cho ĐỀ). */
  async function copyPaperToMine(paperId: string) {
    try {
      await apiJson(`/api/v1/exam-papers/${paperId}/copy`, { method: 'POST', body: '{}' });
      setMessage(t('paperCopiedToMyBank'));
      await loadExamBanks();
    } catch (err) {
      setMessage(withApiReason(t('examPaperCopyFailed'), err));
    }
  }

  async function setPaperStatus(paperId: string, status: 'ready' | 'hidden' | 'draft') {
    try {
      await apiJson(`/api/v1/exam-papers/${paperId}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      await loadExamBanks();
      if (systemExamBankId) await loadSystemPapers(systemExamBankId);
    } catch (err) {
      setMessage(withApiReason(t('examPaperSaveFailed'), err));
    }
  }

  async function deletePaper(paperId: string) {
    if (!window.confirm(t('examPaperDeleteConfirm'))) return;
    try {
      await apiJson(`/api/v1/exam-papers/${paperId}`, { method: 'DELETE' });
      setMessage(t('examPaperDeleted'));
      await loadExamBanks();
    } catch (err) {
      setMessage(withApiReason(t('examPaperDeleteFailed'), err));
    }
  }

  /** Đề xuất một đề của tôi lên bank đề chung (khuôn QB-4 cho đơn vị đề). */
  async function proposePaper() {
    if (!proposePaperId || !proposePaperBankId) return;
    try {
      await apiJson(`/api/v1/exam-papers/banks/${proposePaperBankId}/contributions`, {
        method: 'POST',
        body: JSON.stringify({ paperId: proposePaperId }),
      });
      setMessage(t('paperProposedOk'));
    } catch (err) {
      setMessage(withApiReason(t('proposeFailed'), err));
    }
  }

  /** Duyệt / từ chối một đề xuất đóng góp đề (người duyệt của bank đích). */
  async function reviewPaperContribution(bankId: string, contributionId: string, approve: boolean) {
    try {
      if (approve) {
        await apiJson(`/api/v1/exam-papers/banks/${bankId}/contributions/${contributionId}/approve`, { method: 'POST', body: '{}' });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await apiJson(`/api/v1/exam-papers/banks/${bankId}/contributions/${contributionId}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      }
      await loadSystemPapers(bankId);
    } catch (err) {
      setMessage(withApiReason(t('proposeFailed'), err));
    }
  }

  /** Mở hộp thoại triển khai: nạp danh sách khoá học cho giáo viên chọn quiz đích. */
  async function openDeploy(paper: PaperSummaryLite) {
    setDeployPaper(paper);
    setDeployQuizId('');
    setDeployQuizzes([]);
    try {
      const courses = await apiJson<CourseLite[]>('/api/v1/courses');
      setDeployCourses(courses);
    } catch {
      setDeployCourses([]);
    }
  }

  async function loadDeployQuizzes(courseId: string) {
    setDeployCourseId(courseId);
    setDeployQuizId('');
    if (!courseId) { setDeployQuizzes([]); return; }
    try {
      const rows = await apiJson<QuizLite[]>(`/api/v1/courses/${courseId}/quizzes`);
      setDeployQuizzes(rows);
    } catch {
      setDeployQuizzes([]);
    }
  }

  /** Triển khai đề vào quiz đã chọn; quiz dựng tay thì hỏi xác nhận thay thế rồi gọi lại với replace. */
  async function runDeploy(replace = false) {
    if (!deployPaper || !deployQuizId) return;
    try {
      await apiJson(`/api/v1/exam-papers/${deployPaper.id}/deploy`, {
        method: 'POST',
        body: JSON.stringify({ quizId: deployQuizId, ...(replace ? { replace: true } : {}) }),
      });
      setMessage(t('deployOk', { version: deployPaper.latestVersion }));
      setDeployPaper(null);
    } catch (err) {
      if (!replace && err instanceof ApiError && err.problem.code === 'exam.deploy_quiz_has_manual_slots') {
        if (window.confirm(t('deployReplaceConfirm'))) await runDeploy(true);
        return;
      }
      setMessage(withApiReason(t('deployFailed'), err));
    }
  }

  useEffect(() => {
    void loadAttributionsFor(questions);
  }, [questions, loadAttributionsFor]);

  async function runDiscovery() {
    try {
      const params = new URLSearchParams();
      if (discBankId) params.set('bankId', discBankId);
      if (discKeyword.trim()) params.set('keyword', discKeyword.trim());
      if (discQtype) params.set('qtype', discQtype);
      const rows = await apiJson<DiscoveryItemLite[]>(`/api/v1/questions/discovery?${params.toString()}`);
      setDiscResults(rows);
    } catch {
      setDiscResults([]);
    }
  }

  async function loadContributions(bankId: string) {
    try {
      const rows = await apiJson<ContributionLite[]>(`/api/v1/question-banks/${bankId}/contributions?status=pending`);
      setContributions(rows);
    } catch {
      setContributions([]);
    }
  }

  /** Copy một câu về ngân hàng cá nhân của mình (cầu nối hai khu vực). */
  async function copyToMyBank(questionId: string) {
    try {
      await apiJson(`/api/v1/questions/${questionId}/copy`, { method: 'POST', body: '{}' });
      setMessage(t('copiedToMyBank'));
      await loadBanks();
    } catch {
      setMessage(t('copyFailed'));
    }
  }

  /** Đề xuất đóng góp một câu (của mình) lên một bank chung. */
  async function proposeToBank(questionId: string, targetBankId: string) {
    if (!targetBankId) return;
    try {
      await apiJson(`/api/v1/question-banks/${targetBankId}/contributions`, {
        method: 'POST',
        body: JSON.stringify({ questionId }),
      });
      setMessage(t('proposedOk'));
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  async function reviewContribution(bankId: string, contributionId: string, approve: boolean) {
    try {
      if (approve) {
        await apiJson(`/api/v1/question-banks/${bankId}/contributions/${contributionId}/approve`, { method: 'POST', body: '{}' });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await apiJson(`/api/v1/question-banks/${bankId}/contributions/${contributionId}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      }
      await loadContributions(bankId);
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  /** Xoá vật lý một câu của mình (API chặn khi câu đã được dùng — khi đó hãy rút câu). */
  async function deleteMyQuestion(questionId: string) {
    if (!window.confirm(t('deleteQuestionConfirm'))) return;
    try {
      await apiJson(`/api/v1/questions/${questionId}`, { method: 'DELETE' });
      setMessage(t('questionDeleted'));
      await loadBanks();
      await loadQuestions(qCategory).catch(() => undefined);
    } catch {
      setMessage(t('deleteFailed'));
    }
  }

  /** Rút / hoàn rút một câu khỏi bank của nó. */
  async function toggleWithdraw(view: QuestionView) {
    const status = (view.entry as { status?: string }).status;
    try {
      if (status === 'hidden') {
        await apiJson(`/api/v1/questions/${view.question.id}/restore`, { method: 'POST', body: '{}' });
        setMessage(t('questionRestored'));
      } else {
        const reason = window.prompt(t('withdrawQuestion')) ?? '';
        if (!reason.trim()) return;
        await apiJson(`/api/v1/questions/${view.question.id}/withdraw`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        setMessage(t('questionWithdrawn'));
      }
      await loadBanks();
      await loadQuestions(qCategory).catch(() => undefined);
    } catch {
      setMessage(t('proposeFailed'));
    }
  }


  /** "Thêm mới" trong collapse ngân hàng riêng: mở màn soạn riêng (§9) với category mặc định của bank cá nhân. */
  function addNewMine() {
    if (!personalBank?.defaultCategoryId) return;
    navigate(`/questions/new?category=${personalBank.defaultCategoryId}`);
  }

  /** Sửa một câu trong ngân hàng riêng: mở màn sửa riêng của câu đó. */
  function editMine(view: QuestionView) {
    navigate(`/questions/${view.question.id}/edit?category=${view.question.category}`);
  }

  async function submitStimulus(event: FormEvent) {
    event.preventDefault();
    if (editingStimulus) {
      try {
        await apiJson(`/api/v1/stimuli/${editingStimulus.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ content: stimulusContent }),
        });
        setEditingStimulus(null);
        setStimulusContent('');
        await loadStimuli(qCategory);
      } catch {
        setMessage(t('stimulusSaveFailed'));
      }
      return;
    }
    try {
      await apiJson('/api/v1/stimuli', {
        method: 'POST',
        body: JSON.stringify({ categoryId: qCategory, content: stimulusContent }),
      });
      setStimulusContent('');
      await loadStimuli(qCategory);
    } catch {
      setMessage(t('stimulusCreateFailed'));
    }
  }

  async function deleteStimulus(stimulus: StimulusView) {
    try {
      await apiJson(`/api/v1/stimuli/${stimulus.id}`, { method: 'DELETE' });
      if (editingStimulus?.id === stimulus.id) {
        setEditingStimulus(null);
        setStimulusContent('');
      }
      await loadStimuli(qCategory);
    } catch {
      setMessage(t('stimulusDeleteFailed'));
    }
  }

  /**
   * Tạo lượt làm bài từ các câu hỏi đã chọn: slot chỉ cần `questionId`
   * (schema `questionUsageSlotSchema`) — server tự gắn phiên bản mới nhất
   * khi attempt bắt đầu, nên trang không gửi version id nào. Component
   * `mod_quiz` khớp cách API/e2e tạo usage cho một hoạt động quiz.
   */
  async function startUsageFromSelection() {
    try {
      const created = await apiJson<QuestionUsage>('/api/v1/question-usages', {
        method: 'POST',
        body: JSON.stringify({
          component: 'mod_quiz',
          slots: selected.map((questionId) => ({ questionId })),
        }),
      });
      await navigate(`/question-usages/${created.usage.id}`);
    } catch {
      setMessage(t('usageCreateFailed'));
    }
  }

  /** Xoá một câu hỏi qua DELETE /questions/:id sau khi xác nhận (§9: Xoá ngay tại dòng). */
  async function deleteQuestion(view: QuestionView) {
    if (!window.confirm(t('confirmDeleteQuestion', { name: view.question.name }))) return;
    setMessage(null);
    try {
      await apiJson(`/api/v1/questions/${view.question.id}`, { method: 'DELETE' });
      setMessage(t('questionDeleted'));
      setSelected((prev) => prev.filter((qid) => qid !== view.question.id));
      await loadQuestions(qCategory);
    } catch {
      setMessage(t('questionDeleteFailed'));
    }
  }

  async function showVersions(view: QuestionView) {
    const versions = await apiJson<{ version: number; questionText: RichTextDocument }[]>(
      `/api/v1/questions/${view.question.id}/versions`,
    );
    setVersionsOf({ questionId: view.question.id, versions });
  }

  /** Nội dung ngữ liệu gắn với phiên bản mới nhất của câu hỏi (rỗng khi không gắn). */
  function stimulusTextOf(view: QuestionView): string {
    if (view.stimulus) return plainText(view.stimulus.content);
    const stimulusId = view.latestVersion.stimulusId;
    if (!stimulusId) return '';
    const found = stimuli.find((s) => s.id === stimulusId);
    return found ? plainText(found.content) : '';
  }

  /**
   * Cột của bảng ngân hàng câu hỏi trên DataTable dùng chung (TanStack
   * Table): chọn câu hỏi để làm bài vẫn là state của trang (checkbox ở
   * cột đầu ghi vào `selected`), tên/phiên bản sắp xếp được, ô lọc toàn
   * bảng quét theo tên và nội dung câu hỏi. Trước đây danh sách này là
   * một <ul> tự chế không sắp xếp/lọc/phân trang.
   */
  const questionColumns: DataColumn<QuestionView>[] = [
    {
      id: 'select',
      header: '',
      cell: (view) => (
        <Checkbox
          aria-label={t('selectQuestionForAttempt', { name: view.question.name })}
          checked={selected.includes(view.question.id)}
          onCheckedChange={(checked) =>
            setSelected((prev) =>
              checked === true ? [...prev, view.question.id] : prev.filter((qid) => qid !== view.question.id),
            )
          }
        />
      ),
    },
    {
      id: 'name',
      header: t('name'),
      cell: (view) => {
        // Dòng ghi công KHÔNG tắt được cho câu copy (QB-2): hiện ngay
        // dưới tên câu khi đã nạp được attribution; câu đã rút có nhãn.
        const a = attributions[view.question.id];
        const isCopy = Boolean((view.question as { derivedFromQuestionId?: string | null }).derivedFromQuestionId);
        return (
          <span>
            {view.question.name}
            {(view.entry as { status?: string }).status === 'hidden' ? (
              <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t('withdrawnBadge')}</span>
            ) : null}
            {isCopy && a ? (
              <span className="block text-xs text-muted-foreground">
                {t('copiedFromLine', { author: a.originalAuthorName ?? '—', bank: a.sourceBankName ?? '—' })}
              </span>
            ) : null}
          </span>
        );
      },
      sortValue: (view) => view.question.name,
      filterValue: (view) => view.question.name,
    },
    {
      id: 'qtype',
      header: t('questionType'),
      cell: (view) =>
        t(QTYPE_LABEL_KEYS[(QTYPES as readonly string[]).includes(view.question.qtype) ? (view.question.qtype as Qtype) : 'truefalse']),
      sortValue: (view) => view.question.qtype,
      filterValue: (view) => view.question.qtype,
    },
    {
      id: 'version',
      header: t('version'),
      cell: (view) => (
        <span data-testid={`version-badge-${view.question.id}`} className="rounded bg-secondary px-2 py-0.5 text-xs">
          v{view.entry.latestVersion}
        </span>
      ),
      sortValue: (view) => view.entry.latestVersion,
    },
    {
      id: 'text',
      header: t('questionText'),
      cell: (view) => (
        <span>
          <span className="text-sm text-muted-foreground">{plainText(view.latestVersion.questionText)}</span>
          {stimulusTextOf(view) ? (
            <span data-testid={`stimulus-of-${view.question.id}`} className="block text-sm">
              {t('stimulusPreview', { content: stimulusTextOf(view) })}
            </span>
          ) : null}
        </span>
      ),
      filterValue: (view) => `${plainText(view.latestVersion.questionText)} ${stimulusTextOf(view)}`,
    },
    {
      id: 'actions',
      header: t('actions'),
      cell: (view) => (
        <span className="flex gap-2">
          {/* §9: Sửa đi sang màn editor riêng; Xoá ngay tại dòng. */}
          <Button
            type="button"
            variant="outline"
            render={<Link to={`/questions/${view.question.id}/edit?category=${view.question.category}`} />}
          >
            {t('editNewVersion')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void showVersions(view)}>
            {t('history')}
          </Button>
          <Button type="button" variant="destructive" onClick={() => void deleteQuestion(view)}>
            {t('deleteAction')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void copyToMyBank(view.question.id)}>
            {t('copyToMyBank')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void toggleWithdraw(view)}>
            {(view.entry as { status?: string }).status === 'hidden' ? t('restoreQuestion') : t('withdrawQuestion')}
          </Button>
        </span>
      ),
    },
  ];

  /** Xem trước một câu trong trang khám phá ngân hàng chung. */
  async function previewDiscoveryItem(questionId: string) {
    try {
      const view = await apiJson<QuestionView>(`/api/v1/questions/${questionId}`);
      setPreviewItem(view);
    } catch {
      setPreviewItem(null);
    }
  }

  // Chặn trang theo vai (issue #55 mục 1): sidebar đã ẩn mục điều hướng
  // với vai không có capability ngân hàng, trang chặn nốt khi vào thẳng
  // bằng URL — không render danh mục/câu hỏi/editor khi không có quyền.
  if (!perms.ready) {
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        {t('loading')}
      </main>
    );
  }
  if (!perms.canUseQuestionBank) {
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('questionBank')}</CardTitle>
            <CardDescription>{t('questionBankForbidden')}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <PageShell width="full">
      <PageHeader
        title={t('questionBank')}
        description={t('questionBankDescription')}
        actions={
          <>
            <Button type="button" variant="outline" render={<Link to="/questions/categories/new" />}>
              {t('newCategory')}
            </Button>
            <Button type="button" render={<Link to={`/questions/new?category=${qCategory}`} />}>
              {t('newQuestion')}
            </Button>
          </>
        }
      />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      {/* Khu vực RIÊNG của giáo viên (feat #70 theo đính chính của Lão gia):
          tách hẳn khỏi Ngân hàng hệ thống; mở collapse là danh sách câu
          của chính giáo viên + Thêm mới ngay trong collapse (§9). */}
      <Card>
        <CardHeader>
          <button type="button" aria-expanded={myOpen} onClick={() => setMyOpen((v) => !v)} className="text-left">
            <CardTitle>{t('myQuestionBank')}</CardTitle>
            <CardDescription>{t('myQuestionBankDescription')}</CardDescription>
          </button>
        </CardHeader>
        {myOpen && (
          <CardContent className="space-y-4">
            <Button type="button" onClick={addNewMine} disabled={!personalBank?.defaultCategoryId}>
              {t('addNew')}
            </Button>
            {myQuestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dashboard:emptyTable')}</p>
            ) : (
              <ul className="space-y-2">
                {myQuestions.map((view) => {
                  const a = attributions[view.question.id];
                  const isCopy = Boolean(
                    (view.question as { derivedFromQuestionId?: string | null }).derivedFromQuestionId,
                  );
                  return (
                    <li key={view.question.id} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {view.question.name}
                        {(view.entry as { status?: string }).status === 'hidden' ? (
                          <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t('withdrawnBadge')}</span>
                        ) : null}
                        <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">v{view.entry.latestVersion}</span>
                        {isCopy && a ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('copiedFromLine', { author: a.originalAuthorName ?? '—', bank: a.sourceBankName ?? '—' })}
                          </span>
                        ) : null}
                      </span>
                      <Button type="button" variant="outline" onClick={() => editMine(view)}>
                        {t('editRow')}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void toggleWithdraw(view)}>
                        {(view.entry as { status?: string }).status === 'hidden' ? t('restoreQuestion') : t('withdrawQuestion')}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void deleteMyQuestion(view.question.id)}>
                        {t('deleteRow')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {sharedBanks.length > 0 && myQuestions.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="propose-question">{t('proposeToBank')}</Label>
                  <select
                    id="propose-question"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={proposeQuestionId}
                    onChange={(e) => setProposeQuestionId(e.target.value)}
                  >
                    <option value="">—</option>
                    {myQuestions.map((view) => (
                      <option key={view.question.id} value={view.question.id}>
                        {view.question.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="propose-bank">{t('pickBank')}</Label>
                  <select
                    id="propose-bank"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={proposeBankId}
                    onChange={(e) => setProposeBankId(e.target.value)}
                  >
                    <option value="">—</option>
                    {sharedBanks.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  type="button"
                  disabled={!proposeQuestionId || !proposeBankId}
                  onClick={() => void proposeToBank(proposeQuestionId, proposeBankId)}
                >
                  {t('propose')}
                </Button>
              </div>
            ) : null}
          </CardContent>
        )}
      </Card>

      {/* Khu vực RIÊNG — Ma trận của tôi (MB-1, issue #111): collapse
          riêng phân biệt hẳn với Ngân hàng hệ thống, cùng hành vi §9
          như ngân hàng riêng: mở ra là danh sách ma trận của chính giáo
          viên + Thêm mới ngay trong collapse, Sửa/Xoá tại dòng. */}
      <Card>
        <CardHeader>
          <button
            type="button"
            aria-expanded={myMatrixOpen}
            onClick={() => {
              setMyMatrixOpen((v) => !v);
              void loadMatrixBanks();
            }}
            className="text-left"
          >
            <CardTitle>{t('myMatrixBank')}</CardTitle>
            <CardDescription>{t('myMatrixBankDescription')}</CardDescription>
          </button>
        </CardHeader>
        {myMatrixOpen && (
          <CardContent className="space-y-4">
            <Button type="button" onClick={() => navigate('/questions/matrices/new')} disabled={!personalMatrixBank}>
              {t('addNew')}
            </Button>
            {myMatrices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dashboard:emptyTable')}</p>
            ) : (
              <ul className="space-y-2">
                {myMatrices.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1">
                      {m.name}
                      {m.isTemplate ? (
                        <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t('matrixTemplateBadge')}</span>
                      ) : null}
                      <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t(matrixStatusKey(m.status))}</span>
                      <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">v{m.version}</span>
                      <span className="block text-xs text-muted-foreground">
                        {subjectName(m.subjectId)} · {t(matrixPresetKey(m.presetKind))} · {t('matrixCellsCount', { count: m.cells.length })}
                        {m.derivedFromMatrixId ? ` · ${t('matrixDerivedNote')}` : ''}
                      </span>
                    </span>
                    <Button type="button" variant="outline" onClick={() => navigate(`/questions/matrices/${m.id}/edit`)}>
                      {t('editRow')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void deleteMyMatrix(m.id)}>
                      {t('deleteRow')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {sharedMatrixBanks.length > 0 && myMatrices.some((m) => m.status === 'ready') ? (
              <div className="space-y-1">
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label htmlFor="propose-matrix">{t('proposeToBank')}</Label>
                    <select
                      id="propose-matrix"
                      className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                      value={proposeMatrixId}
                      onChange={(e) => setProposeMatrixId(e.target.value)}
                    >
                      <option value="">—</option>
                      {myMatrices
                        .filter((m) => m.status === 'ready')
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="propose-matrix-bank">{t('pickBank')}</Label>
                    <select
                      id="propose-matrix-bank"
                      className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                      value={proposeMatrixBankId}
                      onChange={(e) => setProposeMatrixBankId(e.target.value)}
                    >
                      <option value="">—</option>
                      {sharedMatrixBanks.map((bank) => (
                        <option key={bank.id} value={bank.id}>
                          {bank.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    type="button"
                    disabled={!proposeMatrixId || !proposeMatrixBankId}
                    onClick={() => void proposeMatrixToBank(proposeMatrixId, proposeMatrixBankId)}
                  >
                    {t('propose')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('matrixProposeHint')}</p>
              </div>
            ) : null}
          </CardContent>
        )}
      </Card>

      {/* Collapse "Đề của tôi" (EB-1): khu vực riêng của giáo viên cho
          ĐỀ — song song collapse câu hỏi ở trên theo mô hình hai khu
          vực đã chốt; mở collapse là danh sách đề của chính giáo viên
          + Thêm mới ngay trong collapse (§9), Sửa/Xoá tại dòng. */}
      <Card>
        <CardHeader>
          <button type="button" aria-expanded={myPapersOpen} onClick={() => setMyPapersOpen((v) => !v)} className="text-left">
            <CardTitle>{t('myExamBank')}</CardTitle>
            <CardDescription>{t('myExamBankDescription')}</CardDescription>
          </button>
        </CardHeader>
        {myPapersOpen && (
          <CardContent className="space-y-4">
            <Button
              type="button"
              disabled={!personalExamBank}
              onClick={() => personalExamBank && navigate(`/exam-papers/new?bank=${personalExamBank.id}`)}
            >
              {t('addNew')}
            </Button>
            {myPapers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('examPaperEmpty')}</p>
            ) : (
              <ul className="space-y-2">
                {myPapers.map((paper) => (
                  <li key={paper.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1">
                      {paper.name}
                      <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">
                        {paper.status === 'ready'
                          ? t('examPaperStatusReady')
                          : paper.status === 'hidden'
                            ? t('examPaperStatusHidden')
                            : t('examPaperStatusDraft')}
                      </span>
                      <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">v{paper.latestVersion}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t('examPaperSlotsCount', { count: paper.slotCount })}
                      </span>
                    </span>
                    <Button type="button" variant="outline" onClick={() => navigate(`/exam-papers/${paper.id}/edit`)}>
                      {t('editRow')}
                    </Button>
                    {paper.status === 'draft' ? (
                      <Button type="button" variant="outline" onClick={() => void setPaperStatus(paper.id, 'ready')}>
                        {t('examPaperMarkReady')}
                      </Button>
                    ) : null}
                    {paper.status === 'ready' ? (
                      <Button type="button" variant="outline" onClick={() => void setPaperStatus(paper.id, 'hidden')}>
                        {t('examPaperHide')}
                      </Button>
                    ) : null}
                    {paper.status === 'hidden' ? (
                      <Button type="button" variant="outline" onClick={() => void setPaperStatus(paper.id, 'ready')}>
                        {t('examPaperRestore')}
                      </Button>
                    ) : null}
                    {paper.status === 'ready' && paper.capabilities.deploy ? (
                      <Button type="button" variant="outline" onClick={() => void openDeploy(paper)}>
                        {t('deployPaper')}
                      </Button>
                    ) : null}
                    <Button type="button" variant="outline" onClick={() => void deletePaper(paper.id)}>
                      {t('deleteRow')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {deployPaper ? (
              <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
                <div>
                  <Label htmlFor="deploy-course">{t('deployPickCourse')}</Label>
                  <select
                    id="deploy-course"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={deployCourseId}
                    onChange={(e) => void loadDeployQuizzes(e.target.value)}
                  >
                    <option value="">—</option>
                    {deployCourses.map((c) => (
                      <option key={c.id} value={c.id}>{c.fullName}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="deploy-quiz">{t('deployPickQuiz')}</Label>
                  <select
                    id="deploy-quiz"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={deployQuizId}
                    onChange={(e) => setDeployQuizId(e.target.value)}
                  >
                    <option value="">—</option>
                    {deployQuizzes.map((q) => (
                      <option key={q.id} value={q.id}>{q.name}</option>
                    ))}
                  </select>
                </div>
                <Button type="button" disabled={!deployQuizId} onClick={() => void runDeploy()}>
                  {t('deployRun')}
                </Button>
                <Button type="button" variant="outline" onClick={() => setDeployPaper(null)}>
                  ✕
                </Button>
              </div>
            ) : null}
            {sharedExamBanks.length > 0 && myPapers.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="propose-paper">{t('proposePaperToBank')}</Label>
                  <select
                    id="propose-paper"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={proposePaperId}
                    onChange={(e) => setProposePaperId(e.target.value)}
                  >
                    <option value="">—</option>
                    {myPapers.filter((p) => p.status === 'ready').map((paper) => (
                      <option key={paper.id} value={paper.id}>{paper.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="propose-paper-bank">{t('pickBank')}</Label>
                  <select
                    id="propose-paper-bank"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={proposePaperBankId}
                    onChange={(e) => setProposePaperBankId(e.target.value)}
                  >
                    <option value="">—</option>
                    {sharedExamBanks.map((bank) => (
                      <option key={bank.id} value={bank.id}>{bank.name}</option>
                    ))}
                  </select>
                </div>
                <Button type="button" disabled={!proposePaperId || !proposePaperBankId} onClick={() => void proposePaper()}>
                  {t('propose')}
                </Button>
              </div>
            ) : null}
          </CardContent>
        )}
      </Card>

      {/* Khu vực Ngân hàng hệ thống: MỘT collapse chứa ba ngân hàng CHUNG
          (câu hỏi / đề / ma trận) — cả ba đã thi công: câu hỏi chung
          (feat #70), đề chung (EB-1, issue #113), ma trận chung
          (MB-1, issue #111). */}
      <Card>
        <CardHeader>
          <button type="button" aria-expanded={systemOpen} onClick={() => setSystemOpen((v) => !v)} className="text-left">
            <CardTitle>{t('systemBank')}</CardTitle>
            <CardDescription>{t('systemBankDescription')}</CardDescription>
          </button>
        </CardHeader>
        {systemOpen && (
          <CardContent className="space-y-6">
            <section className="space-y-3">
              <h3 className="font-medium">{t('sharedQuestionBank')}</h3>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="disc-bank">{t('pickBank')}</Label>
                  <select
                    id="disc-bank"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={discBankId}
                    onChange={(e) => {
                      setDiscBankId(e.target.value);
                      if (e.target.value) void loadContributions(e.target.value);
                      else setContributions([]);
                    }}
                  >
                    <option value="">{t('allSharedBanks')}</option>
                    {sharedBanks.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.name} ({t(`bankScope${bank.scope[0]!.toUpperCase()}${bank.scope.slice(1)}`)})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="disc-keyword">{t('discoveryKeyword')}</Label>
                  <Input
                    id="disc-keyword"
                    value={discKeyword}
                    onChange={(e) => setDiscKeyword(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="disc-qtype">{t('questionType')}</Label>
                  <select
                    id="disc-qtype"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={discQtype}
                    onChange={(e) => setDiscQtype(e.target.value)}
                  >
                    <option value="">—</option>
                    {QTYPES.map((qtype) => (
                      <option key={qtype} value={qtype}>
                        {t(QTYPE_LABEL_KEYS[qtype])}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="button" onClick={() => void runDiscovery()}>
                  {t('discoverySearch')}
                </Button>
              </div>
              {discResults.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('discoveryEmpty')}</p>
              ) : (
                <ul className="space-y-2">
                  {discResults.map((item) => (
                    <li key={item.questionId} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {item.name}
                        <span className="block text-xs text-muted-foreground">
                          {item.bankName} · {item.authorName ?? '—'} · {t('usedTimes', { count: item.useCount })} ·{' '}
                          {t('copiedTimes', { count: item.copyCount })}
                        </span>
                      </span>
                      <Button type="button" variant="outline" onClick={() => void previewDiscoveryItem(item.questionId)}>
                        {t('previewQuestion')}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void copyToMyBank(item.questionId)}>
                        {t('copyToMyBank')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {previewItem ? (
                <div className="rounded-md border p-3">
                  <p className="font-medium">{previewItem.question.name}</p>
                  <p className="text-sm text-muted-foreground">{plainText(previewItem.latestVersion.questionText)}</p>
                </div>
              ) : null}
              {discBankId ? (
                <div className="space-y-2">
                  <h4 className="font-medium">{t('contributionQueue')}</h4>
                  {contributions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('contributionEmpty')}</p>
                  ) : (
                    <ul className="space-y-2">
                      {contributions.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1">
                            {c.questionName ?? c.questionId}
                            <span className="block text-xs text-muted-foreground">
                              {t('contributionBy', { name: c.proposerName ?? '—' })}
                            </span>
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void reviewContribution(discBankId, c.id, true)}
                          >
                            {t('contributionApprove')}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void reviewContribution(discBankId, c.id, false)}
                          >
                            {t('contributionReject')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </section>
            {/* Ngân hàng đề chung (EB-1): chọn một bank đề chung → danh
                sách đề ready của bank đó + Copy về ngân hàng đề của tôi
                tại dòng; người duyệt của bank thấy hàng chờ đóng góp đề. */}
            <section className="space-y-3">
              <h3 className="font-medium">{t('sharedExamBank')}</h3>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="exam-bank-pick">{t('pickBank')}</Label>
                  <select
                    id="exam-bank-pick"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={systemExamBankId}
                    onChange={(e) => void loadSystemPapers(e.target.value)}
                  >
                    <option value="">—</option>
                    {sharedExamBanks.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.name} ({t(`bankScope${bank.scope[0]!.toUpperCase()}${bank.scope.slice(1)}`)})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {systemExamBankId && systemPapers.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('examPaperEmpty')}</p>
              ) : (
                <ul className="space-y-2">
                  {systemPapers.map((paper) => (
                    <li key={paper.id} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {paper.name}
                        <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">v{paper.latestVersion}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t('examPaperSlotsCount', { count: paper.slotCount })} · {t('copiedTimes', { count: paper.copyCount })}
                        </span>
                      </span>
                      {paper.capabilities.edit ? (
                        <Button type="button" variant="outline" onClick={() => navigate(`/exam-papers/${paper.id}/edit`)}>
                          {t('editRow')}
                        </Button>
                      ) : null}
                      <Button type="button" variant="outline" onClick={() => void copyPaperToMine(paper.id)}>
                        {t('copyPaperToMyBank')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {systemExamBankId && paperContributions.length > 0 ? (
                <div className="space-y-2">
                  <h4 className="font-medium">{t('examContributionQueue')}</h4>
                  <ul className="space-y-2">
                    {paperContributions.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1">{c.paperName ?? c.paperId}</span>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void reviewPaperContribution(systemExamBankId, c.id, true)}
                        >
                          {t('contributionApprove')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void reviewPaperContribution(systemExamBankId, c.id, false)}
                        >
                          {t('contributionReject')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
            <section className="space-y-3">
              <h3 className="font-medium">{t('sharedMatrixBank')}</h3>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="shared-matrix-bank">{t('pickBank')}</Label>
                  <select
                    id="shared-matrix-bank"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={sharedMatrixBankId}
                    onChange={(e) => {
                      setSharedMatrixBankId(e.target.value);
                      void loadSharedMatrices(e.target.value);
                    }}
                  >
                    <option value="">—</option>
                    {sharedMatrixBanks.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.name} ({t(`bankScope${bank.scope[0]!.toUpperCase()}${bank.scope.slice(1)}`)})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="matrix-subject-filter">{t('matrixFilterSubject')}</Label>
                  <select
                    id="matrix-subject-filter"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={matrixSubjectFilter}
                    onChange={(e) => setMatrixSubjectFilter(e.target.value)}
                  >
                    <option value="">{t('matrixAllSubjects')}</option>
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="matrix-preset-filter">{t('matrixFilterPreset')}</Label>
                  <select
                    id="matrix-preset-filter"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={matrixPresetFilter}
                    onChange={(e) => setMatrixPresetFilter(e.target.value)}
                  >
                    <option value="">{t('matrixAllPresets')}</option>
                    <option value="cv7991_periodic">{t('matrixPresetPeriodic')}</option>
                    <option value="qd764_graduation">{t('matrixPresetGraduation')}</option>
                    <option value="custom">{t('matrixPresetCustom')}</option>
                  </select>
                </div>
              </div>
              {!sharedMatrixBankId ? (
                <p className="text-sm text-muted-foreground">{t('discoveryEmpty')}</p>
              ) : filteredSharedMatrices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('dashboard:emptyTable')}</p>
              ) : (
                <ul className="space-y-2">
                  {filteredSharedMatrices.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {m.name}
                        {m.isTemplate ? (
                          <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t('matrixTemplateBadge')}</span>
                        ) : null}
                        <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t(matrixStatusKey(m.status))}</span>
                        <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">v{m.version}</span>
                        <span className="block text-xs text-muted-foreground">
                          {subjectName(m.subjectId)} · {t(matrixPresetKey(m.presetKind))} ·{' '}
                          {t('matrixCellsCount', { count: m.cells.length })}
                        </span>
                      </span>
                      <Button type="button" variant="outline" onClick={() => void copyMatrixToMyBank(m.id)}>
                        {t('copyToMyBank')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {sharedMatrixBankId ? (
                <div className="space-y-2">
                  <h4 className="font-medium">{t('contributionQueue')}</h4>
                  {matrixContributions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('contributionEmpty')}</p>
                  ) : (
                    <ul className="space-y-2">
                      {matrixContributions.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1">
                            {c.matrixName ?? c.matrixId}
                            <span className="block text-xs text-muted-foreground">
                              {t('contributionBy', { name: c.proposerName ?? '—' })}
                            </span>
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void reviewMatrixContribution(sharedMatrixBankId, c.id, true)}
                          >
                            {t('contributionApprove')}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void reviewMatrixContribution(sharedMatrixBankId, c.id, false)}
                          >
                            {t('contributionReject')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </section>
          </CardContent>
        )}
      </Card>

      {/* §9: mỗi danh mục là một mục thu/mở — bấm vào thì hiện danh sách
          câu hỏi của chính danh mục đó ngay dưới. */}
      {categories.map((cat) => {
        const isActive = qCategory === String(cat.id);
        return (
          <Collapsible
            key={cat.id}
            open={isActive}
            onOpenChange={(open) => {
              if (open) {
                setQCategory(String(cat.id));
                void loadQuestions(cat.id);
                void loadStimuli(cat.id).catch(() => setMessage(t('stimulusLoadFailed')));
              }
            }}
          >
            <Card>
              <CardHeader>
                <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
                  <span className="font-semibold">{cat.name}</span>
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                {isActive ? (
                  <>
                    <DataTable
                      data={questions}
                      columns={questionColumns}
                      labels={{
                        columns: t('dashboard:tableColumns'),
                        previous: t('dashboard:tablePrevious'),
                        next: t('dashboard:tableNext'),
                        empty: t('dashboard:emptyTable'),
                        filterPlaceholder: t('dashboard:tableFilterPlaceholder'),
                        pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
                      }}
                      getRowId={(view) => view.question.id}
                      rowTestId={(view) => `question-${view.question.id}`}
                    />
                    <CardContent className="space-y-4">
                      <Button
                        type="button"
                        disabled={selected.length === 0}
                        onClick={() => void startUsageFromSelection()}
                      >
                        {t('startAttemptFromSelection')}
                      </Button>
                      {versionsOf && (
                        <div data-testid="version-history">
                          <h3 className="font-medium">{t('versionHistory')}</h3>
                          <ul>
                            {versionsOf.versions.map((v) => (
                              <li key={v.version}>
                                v{v.version} — {plainText(v.questionText)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </>
                ) : null}
              </CollapsibleContent>
            </Card>
          </Collapsible>
        );
      })}
      {loading && categories.length === 0 ? (
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('stimuli')}</CardTitle>
          <CardDescription>{t('stimuliDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {stimuli.map((stimulus) => (
              <li key={stimulus.id} data-testid={`stimulus-row-${stimulus.id}`} className="flex items-start gap-2">
                <span className="flex-1 text-sm">{plainText(stimulus.content)}</span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditingStimulus(stimulus);
                    setStimulusContent(plainText(stimulus.content));
                  }}
                >
                  {t('editStimulus')}
                </Button>
                <Button type="button" variant="outline" onClick={() => void deleteStimulus(stimulus)}>
                  {t('deleteStimulus')}
                </Button>
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => void submitStimulus(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="stimulus-content">
                  {editingStimulus ? t('stimulusContent') : t('newStimulus')}
                </FieldLabel>
                <Textarea
                  id="stimulus-content"
                  rows={4}
                  value={stimulusContent}
                  onChange={(e) => setStimulusContent(e.target.value)}
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit">{editingStimulus ? t('saveStimulus') : t('createStimulus')}</Button>
                {editingStimulus && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditingStimulus(null);
                      setStimulusContent('');
                    }}
                  >
                    {t('cancelStimulusEdit')}
                  </Button>
                )}
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </PageShell>
  );
}

/**
 * Màn tạo danh mục câu hỏi RIÊNG theo chuẩn §9 (route
 * /questions/categories/new): trước đây form này nhồi ngay dưới danh
 * sách ngân hàng trong cùng một trang (§9: tạo mới là màn riêng, không
 * nhồi form vào danh sách). Ngữ cảnh vẫn là control Select của @lms/ui
 * chỉ liệt kê ngữ cảnh người dùng thật sự có question:managecategory
 * (issue #55 mục 2), mặc định ngữ cảnh hệ thống. Tạo xong quay về danh
 * sách ngân hàng (trang danh sách tự nạp lại khi mở).
 */
export function QuestionCategoryNewPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const perms = usePermissions();
  const [catName, setCatName] = useState('');
  const [contextId, setContextId] = useState('');
  const [contextOptions, setContextOptions] = useState<ContextOption[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!perms.ready || !perms.canUseQuestionBank) return;
    let cancelled = false;
    void (async () => {
      try {
        const contexts = await apiJson<{ id: string; contextLevel: number; instanceId: string }[]>(
          '/api/v1/access/contexts',
        );
        const manageable = new Set(
          (perms.access?.contexts ?? [])
            .filter((c) => c.capabilities.includes('question:managecategory'))
            .map((c) => c.contextId),
        );
        const courseName = (instanceId: string) =>
          perms.courses.find((c) => c.course.id === instanceId)?.course.fullName;
        const options: ContextOption[] = contexts
          .filter((c) => c.contextLevel === 10 || c.contextLevel === 40 || c.contextLevel === 50)
          .filter((c) => perms.access?.isSiteAdmin || manageable.has(c.id))
          .map((c) => ({
            id: c.id,
            level: c.contextLevel,
            label:
              c.contextLevel === 10
                ? t('contextSystem')
                : c.contextLevel === 50
                  ? `${t('contextCourse')}: ${courseName(c.instanceId) ?? c.instanceId.slice(0, 8)}`
                  : `${t('contextCourseCategory')}: ${c.instanceId.slice(0, 8)}`,
          }));
        if (cancelled) return;
        setContextOptions(options);
        setContextId((prev) => prev || options.find((o) => o.level === 10)?.id || options[0]?.id || '');
      } catch {
        // Không tải được danh sách ngữ cảnh thì select để rỗng; nếu vẫn
        // gửi tạo danh mục, lỗi hiện lý do thật từ API (mục 3).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [perms.ready, perms.canUseQuestionBank, perms.access]);

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson('/api/v1/questions/categories', {
        method: 'POST',
        body: JSON.stringify({ name: catName, contextId: contextId }),
      });
      navigate('/questions');
    } catch (err) {
      setMessage(withApiReason(t('categoryCreateFailedShort'), err));
    }
  }

  if (!perms.ready) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('newCategory')} />
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </PageShell>
    );
  }
  if (!perms.canUseQuestionBank) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('newCategory')} />
        <Card>
          <CardHeader>
            <CardTitle>{t('questionBank')}</CardTitle>
            <CardDescription>{t('questionBankForbidden')}</CardDescription>
          </CardHeader>
        </Card>
        <p>
          <Link to="/questions" className="text-sm underline">
            {t('backToQuestionBankList')}
          </Link>
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell width="medium">
      <PageHeader title={t('newCategory')} />
      {message ? (
        <Alert role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent>
          <form onSubmit={(e) => void createCategory(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="qcat-name">{t('name')}</FieldLabel>
                <Input id="qcat-name" value={catName} onChange={(e) => setCatName(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel id="qcat-context-label">{t('questionCategoryContext')}</FieldLabel>
                <Select
                  items={Object.fromEntries(contextOptions.map((option) => [option.id, option.label]))}
                  value={contextId === '' ? null : contextId}
                  onValueChange={(v) => setContextId(v ?? '')}
                >
                  <SelectTrigger aria-labelledby="qcat-context-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {contextOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex justify-end">
                <Button type="submit" disabled={!contextId}>
                  {t('createCategory')}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <p>
        <Link to="/questions" className="text-sm underline">
          {t('backToQuestionBankList')}
        </Link>
      </p>
    </PageShell>
  );
}

/** Một phiên bản câu hỏi như endpoint versions trả về (có stimulusId để tra ngữ liệu đã gắn). */
interface PinnedVersion {
  id: string;
  version: number;
  questionText: RichTextDocument;
  stimulusId: string | null;
}

/** Nội dung hiển thị của một attempt: đề của phiên bản đã pin + ngữ liệu gắn kèm (nếu có). */
interface PinnedContent {
  questionText: string;
  stimulusText: string | null;
}

/**
 * Lượt làm bài câu hỏi: thao tác theo trạng thái của usage và từng attempt
 * (bắt đầu usage/attempt, nộp câu trả lời, kết thúc attempt/usage). Sau mỗi
 * thao tác trang nạp lại usage từ API để hiển thị state/fraction mới nhất.
 * Behaviour mặc định là deferredfeedback: nộp chỉ ghi đáp án thành step,
 * điểm (fraction) chỉ chốt khi kết thúc attempt hoặc toàn bộ usage.
 */
export function QuestionUsagePage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const perms = usePermissions();
  const [usage, setUsage] = useState<QuestionUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pinned, setPinned] = useState<Record<string, PinnedContent>>({});

  /**
   * Nạp nội dung của phiên bản ĐÃ PIN cho từng attempt đã bắt đầu: usage chỉ
   * mang questionId/questionVersionId, nên đề và ngữ liệu phải tra qua
   * endpoint versions (đúng phiên bản đã pin, không phải bản mới nhất) rồi
   * endpoint stimuli. Lỗi ở bước phụ này không chặn thao tác làm bài.
   */
  const loadPinned = useCallback(async (fresh: QuestionUsage) => {
    const entries = await Promise.all(
      fresh.attempts
        .filter((a) => a.questionVersionId)
        .map(async (a) => {
          try {
            const versions = await apiJson<PinnedVersion[]>(`/api/v1/questions/${a.questionId}/versions`);
            const version = versions.find((v) => v.id === a.questionVersionId);
            if (!version) return null;
            let stimulusText: string | null = null;
            if (version.stimulusId) {
              const stimulus = await apiJson<StimulusView>(`/api/v1/stimuli/${version.stimulusId}`);
              stimulusText = plainText(stimulus.content);
            }
            return [a.id, { questionText: plainText(version.questionText), stimulusText }] as const;
          } catch {
            return null;
          }
        }),
    );
    setPinned((prev) => {
      const next = { ...prev };
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      return next;
    });
  }, []);

  /** Nạp (lại) usage hiện tại từ API — nguồn sự thật cho state/fraction. */
  const reload = useCallback(async () => {
    const fresh = await apiJson<QuestionUsage>(`/api/v1/question-usages/${id}`);
    setUsage(fresh);
    void loadPinned(fresh);
  }, [id, loadPinned]);

  useEffect(() => {
    // Trang làm thử thuộc bộ công cụ ngân hàng: cùng cổng vai với trang
    // ngân hàng (issue #55 mục 1); API usage cũng đã gác chủ sở hữu/quyền.
    if (!perms.ready || !perms.canUseQuestionBank) return;
    void reload().catch(() => setError(t('attemptLoadFailed')));
  }, [reload, t, perms.ready, perms.canUseQuestionBank]);

  /** Chạy một thao tác làm bài rồi nạp lại usage; lỗi hiện thân thiện qua i18n. */
  async function act(run: () => Promise<unknown>) {
    setActionError(null);
    try {
      await run();
      await reload();
    } catch {
      setActionError(t('usageActionFailed'));
    }
  }

  if (!perms.ready)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        {t('loading')}
      </main>
    );
  if (!perms.canUseQuestionBank)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('questionBank')}</CardTitle>
            <CardDescription>{t('questionBankForbidden')}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  if (error)
    return (
      <PageShell width="medium">
        <PageHeader title={t('questionAttemptTitle', { component: '' })} />
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setError(null);
              void reload().catch(() => setError(t('attemptLoadFailed')));
            }}
          >
            {t('retry')}
          </Button>
        </div>
      </PageShell>
    );
  if (!usage)
    return (
      <PageShell width="medium">
        <div className="space-y-2" aria-label={t('attemptLoading')}>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </PageShell>
    );
  const usageId = usage.usage.id;
  const gradedStates = ['gradedright', 'gradedpartial', 'gradedwrong', 'gaveup'];
  return (
    <PageShell width="medium">
      <PageHeader
        title={t('questionAttemptTitle', { component: usage.usage.component })}
        description={t('usageState', { state: usage.state })}
      />
      <Card>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('deferredFeedbackNote')}</p>
          {actionError ? (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex gap-2">
            {usage.state === 'notstarted' ? (
              <Button
                type="button"
                onClick={() =>
                  void act(() => apiJson(`/api/v1/question-usages/${usageId}/start`, { method: 'POST', body: '{}' }))
                }
              >
                {t('usageStart')}
              </Button>
            ) : null}
            {usage.state === 'inprogress' ? (
              <Button
                type="button"
                onClick={() =>
                  void act(() => apiJson(`/api/v1/question-usages/${usageId}/finish`, { method: 'POST', body: '{}' }))
                }
              >
                {t('usageFinish')}
              </Button>
            ) : null}
          </div>
          <ul className="space-y-4">
            {usage.attempts.map((a) => {
              const started = a.state !== 'notstarted';
              const finishedAttempt = gradedStates.includes(a.state);
              const lastAnswer = [...a.steps].reverse().find((s) => s.data.answer)?.data.answer ?? '';
              const content = pinned[a.id];
              return (
                <li key={a.id} data-testid={`attempt-${a.id}`} className="space-y-2">
                  <div>
                    {t('slotLine', { slot: a.slot })} <strong>{a.state}</strong>
                    {a.fraction !== null ? ` ${t('fractionSuffix', { fraction: a.fraction })}` : ''}
                    {a.questionVersionId ? ` ${t('pinnedVersionSuffix', { versionId: a.questionVersionId })}` : ''}
                    <span className="block text-sm text-muted-foreground">
                      {t('stepsLine', { steps: a.steps.map((s) => s.state).join(' → ') || t('stepsNone') })}
                    </span>
                  </div>
                  {content ? (
                    <div className="space-y-2">
                      {content.stimulusText ? (
                        <div data-testid={`attempt-stimulus-${a.id}`} className="rounded-md border p-3">
                          <h4 className="text-sm font-medium">{t('stimulusHeading')}</h4>
                          <p className="text-sm whitespace-pre-wrap">{content.stimulusText}</p>
                        </div>
                      ) : null}
                      <p className="text-sm whitespace-pre-wrap">{content.questionText}</p>
                    </div>
                  ) : null}
                  {!started ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void act(() =>
                          apiJson(`/api/v1/question-usages/${usageId}/attempts/${a.id}/start`, {
                            method: 'POST',
                            body: '{}',
                          }),
                        )
                      }
                    >
                      {t('attemptStart')}
                    </Button>
                  ) : null}
                  {started && !finishedAttempt ? (
                    <div className="space-y-2">
                      <Field>
                        <FieldLabel htmlFor={`answer-${a.id}`}>{t('answerForSlot', { slot: a.slot })}</FieldLabel>
                        <Input
                          id={`answer-${a.id}`}
                          value={answers[a.id] ?? lastAnswer}
                          onChange={(e) => setAnswers((prev) => ({ ...prev, [a.id]: e.target.value }))}
                        />
                      </Field>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          onClick={() =>
                            void act(() =>
                              apiJson(`/api/v1/question-usages/${usageId}/attempts/${a.id}/submit`, {
                                method: 'POST',
                                body: JSON.stringify({
                                  response: (answers[a.id] ?? lastAnswer).trim() ? (answers[a.id] ?? lastAnswer) : null,
                                }),
                              }),
                            )
                          }
                        >
                          {t('attemptSubmit')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            void act(() =>
                              apiJson(`/api/v1/question-usages/${usageId}/attempts/${a.id}/finish`, {
                                method: 'POST',
                                body: '{}',
                              }),
                            )
                          }
                        >
                          {t('attemptFinish')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-4 text-sm">
            <Link to="/questions">{t('backToQuestionBank')}</Link>
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default QuestionsPage;
