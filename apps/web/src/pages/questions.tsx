import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
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
  const [contextId, setContextId] = useState('');
  const [contextOptions, setContextOptions] = useState<ContextOption[]>([]);
  const [catName, setCatName] = useState('');
  const [qCategory, setQCategory] = useState('');
  const [stimulusContent, setStimulusContent] = useState('');
  const [editingStimulus, setEditingStimulus] = useState<StimulusView | null>(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    // Vai không có capability ngân hàng: không gọi API dữ liệu nào cả —
    // trang render trạng thái không-có-quyền ở dưới (issue #55 mục 1).
    if (!perms.ready || !perms.canUseQuestionBank) return;
    void reload()
      .catch(() => setMessage(t('questionBankLoadFailed')))
      .finally(() => setLoading(false));
  }, [reload, perms.ready, perms.canUseQuestionBank]);

  /**
   * Ngữ cảnh cho form "Danh mục mới" (issue #55 mục 2): control chọn tử
   * tế thay ô gõ ID thô điền sẵn "1" — chỉ liệt kê ngữ cảnh người dùng
   * thật sự có question:managecategory (theo ảnh chụp quyền; site admin
   * thì mọi ngữ cảnh hệ thống/danh mục/khoá), mặc định ngữ cảnh hệ
   * thống nếu có trong danh sách, không thì ngữ cảnh đầu tiên.
   */
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
      setCatName('');
      await reload();
    } catch (err) {
      setMessage(withApiReason(t('categoryCreateFailedShort'), err));
    }
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
      cell: (view) => view.question.name,
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
        </span>
      ),
    },
  ];

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
          <Button type="button" render={<Link to={`/questions/new?category=${qCategory}`} />}>
            {t('newQuestion')}
          </Button>
        }
      />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
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
          <CardTitle>{t('newCategory')}</CardTitle>
        </CardHeader>
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
                <textarea
                  id="stimulus-content"
                  className="w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs"
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
