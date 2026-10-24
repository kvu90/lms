import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  extractRichTextPlainText,
  type QuestionCategory,
  type QuestionUsage,
  type QuestionView,
  type RichTextDocument,
  type StimulusView,
} from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { DataTable, type DataColumn } from '#components/data-table';

const QTYPES = ['multichoice', 'truefalse', 'shortanswer', 'essay'] as const;
type Qtype = (typeof QTYPES)[number];

const QTYPE_LABEL_KEYS: Record<Qtype, string> = {
  multichoice: 'qtypeMultichoice',
  truefalse: 'qtypeTruefalse',
  shortanswer: 'qtypeShortanswer',
  essay: 'qtypeEssay',
};

/** Mức độ nhận thức trên dòng nối câu hỏi × YCCĐ (issue #20 Chặng 2, mục A.2). */
const COGNITIVE_LEVELS = ['biet', 'hieu', 'van_dung', 'van_dung_cao'] as const;
const LEVEL_LABEL_KEYS: Record<(typeof COGNITIVE_LEVELS)[number], string> = {
  biet: 'levelBiet',
  hieu: 'levelHieu',
  van_dung: 'levelVanDung',
  van_dung_cao: 'levelVanDungCao',
};

/** Gắn kết chương trình của một câu hỏi — hình dạng của GET /questions/:id/curriculum-links. */
interface CurriculumLinksView {
  questionId: string;
  subjectIds: string[];
  outcomes: { outcomeId: string; cognitiveLevel: string }[];
}

/** Một node trong cây chương trình trả về bởi GET /curriculum/curricula/:id/tree. */
interface CurriculumTreeNode {
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
interface QuestionFormState {
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

function plainText(doc: RichTextDocument | null | undefined): string {
  return doc ? extractRichTextPlainText(doc) : '';
}

function emptyForm(qtype: Qtype): QuestionFormState {
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

type OptionsRecord = Record<string, unknown>;

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

function hasAllOptions(qtype: Qtype, options: OptionsRecord | null | undefined): boolean {
  if (!options) return false;
  return OPTION_KEYS_BY_QTYPE[qtype].every(
    (key) => Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined,
  );
}

function richTextDocument(value: unknown): RichTextDocument | undefined {
  return value !== null && typeof value === 'object' ? (value as RichTextDocument) : undefined;
}

/** Nạp một câu hỏi có sẵn vào editor: đáp án/options lấy từ view của phiên bản mới nhất. */
function formFromView(view: QuestionView, fallbackOptions?: OptionsRecord | null): QuestionFormState {
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
function formContent(form: QuestionFormState, preserveExistingOptions = false): Record<string, unknown> {
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
  const [selected, setSelected] = useState<string[]>([]);
  const [categories, setCategories] = useState<QuestionCategory[]>([]);
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [stimuli, setStimuli] = useState<StimulusView[]>([]);
  const [versionsOf, setVersionsOf] = useState<{
    questionId: string;
    versions: { version: number; questionText: RichTextDocument }[];
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [contextId, setContextId] = useState('1');
  const [catName, setCatName] = useState('');
  const [qCategory, setQCategory] = useState('');
  const [form, setForm] = useState<QuestionFormState>(() => emptyForm('multichoice'));
  const [editing, setEditing] = useState<QuestionView | null>(null);
  const [stimulusContent, setStimulusContent] = useState('');
  const [editingStimulus, setEditingStimulus] = useState<StimulusView | null>(null);
  const editOptionsRequestRef = useRef(0);
  // Gắn kết chương trình (issue #20 Chặng 2) của câu hỏi đang sửa.
  const [links, setLinks] = useState<CurriculumLinksView | null>(null);
  const [linkSubjects, setLinkSubjects] = useState<{ id: string; name: string }[]>([]);
  const [linkSubjectPick, setLinkSubjectPick] = useState('');
  const [linkOutcomeOptions, setLinkOutcomeOptions] = useState<{ id: string; label: string }[]>([]);
  const [linkOutcomePick, setLinkOutcomePick] = useState('');
  const [linkLevelPick, setLinkLevelPick] = useState<string>('biet');
  const [outcomeLabels, setOutcomeLabels] = useState<Record<string, string>>({});

  const patchForm = useCallback((patch: Partial<QuestionFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

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
    void reload().catch(() => setMessage(t('questionBankLoadFailed')));
  }, [reload]);

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson('/api/v1/questions/categories', {
        method: 'POST',
        body: JSON.stringify({ name: catName, contextId: contextId }),
      });
      setCatName('');
      await reload();
    } catch {
      setMessage(t('categoryCreateFailedShort'));
    }
  }

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    if (editing) {
      try {
        const updated = await apiJson<QuestionView>(`/api/v1/questions/${editing.question.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            ...formContent(form, true),
            stimulusId: form.stimulusId === '' ? null : form.stimulusId,
          }),
        });
        setMessage(t('questionSavedAsVersion', { version: updated.entry.latestVersion }));
        setEditing(null);
        setForm(emptyForm('multichoice'));
        await loadQuestions(editing.question.category);
      } catch {
        setMessage(t('questionEditFailed'));
      }
      return;
    }
    try {
      await apiJson('/api/v1/questions', {
        method: 'POST',
        body: JSON.stringify({
          categoryId: qCategory,
          qtype: form.qtype,
          ...formContent(form),
          ...(form.stimulusId ? { stimulusId: form.stimulusId } : {}),
        }),
      });
      setForm((prev) => ({ ...emptyForm(prev.qtype), stimulusId: prev.stimulusId }));
      await loadQuestions(qCategory);
    } catch {
      setMessage(t('questionCreateFailed'));
    }
  }

  async function startEdit(view: QuestionView) {
    const requestId = ++editOptionsRequestRef.current;
    setEditing(view);
    setForm(formFromView(view));
    // Gắn kết chương trình gắn ở cấp danh tính câu hỏi: nạp kèm khi mở editor.
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
      // Endpoint versions hiện chỉ trả metadata của version; nếu bản ghi của
      // version mới nhất có kèm options thì dùng nó để lấp trường view còn thiếu.
      const versions = await apiJson<
        { id: string; version: number; options?: OptionsRecord | null }[]
      >(`/api/v1/questions/${view.question.id}/versions`);
      const latest = versions.find((version) => version.id === view.latestVersion.id)
        ?? versions.find((version) => version.version === view.entry.latestVersion);
      if (latest?.options && editOptionsRequestRef.current === requestId) {
        setForm(formFromView(view, latest.options));
      }
    } catch {
      // Không tải được options bổ sung thì giữ nguyên phần đã nạp từ view.
    }
  }

  function cancelEdit() {
    editOptionsRequestRef.current += 1;
    setEditing(null);
    setForm(emptyForm('multichoice'));
    setLinks(null);
    setLinkSubjectPick('');
    setLinkOutcomePick('');
    setLinkOutcomeOptions([]);
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
   * Môn học cho khối Chương trình: chương trình quốc gia GDPT 2018 neo ở
   * context hệ thống (contextLevel 10). Lỗi tải chỉ làm khối này trống —
   * không chặn việc soạn câu hỏi.
   */
  async function loadLinkSubjects() {
    try {
      const contexts = await apiJson<{ id: string; contextLevel: number }[]>('/api/v1/access/contexts');
      const system = contexts.find((c) => c.contextLevel === 10);
      if (!system) return;
      const rows = await apiJson<{ id: string; name: string }[]>(`/api/v1/curriculum/subjects?contextId=${system.id}`);
      setLinkSubjects(rows);
    } catch {
      // Khối chương trình là phụ trợ của editor; bỏ qua khi không tải được.
    }
  }

  /** Nạp gắn kết chương trình của câu hỏi + nhãn nội dung cho các YCCĐ đã gắn. */
  async function loadCurriculumLinks(questionId: string) {
    try {
      const view = await apiJson<CurriculumLinksView>(`/api/v1/questions/${questionId}/curriculum-links`);
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
  }

  /** Chọn môn → nạp cây của mọi khối thuộc môn đó → danh sách YCCĐ chọn được. */
  async function pickLinkSubject(subjectId: string) {
    setLinkSubjectPick(subjectId);
    setLinkOutcomePick('');
    setLinkOutcomeOptions([]);
    if (!subjectId) return;
    try {
      const curricula = await apiJson<{ id: string; grade: number }[]>(`/api/v1/curriculum/curricula?subjectId=${subjectId}`);
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
      setLinks(await apiJson<CurriculumLinksView>(`/api/v1/questions/${editing.question.id}/subjects`, {
        method: 'POST',
        body: JSON.stringify({ subjectId: linkSubjectPick }),
      }));
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function detachLinkSubject(subjectId: string) {
    if (!editing) return;
    try {
      setLinks(await apiJson<CurriculumLinksView>(`/api/v1/questions/${editing.question.id}/subjects/${subjectId}`, { method: 'DELETE' }));
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function attachLinkOutcome() {
    if (!editing || !linkOutcomePick) return;
    try {
      setLinks(await apiJson<CurriculumLinksView>(`/api/v1/questions/${editing.question.id}/outcomes`, {
        method: 'POST',
        body: JSON.stringify({ outcomeId: linkOutcomePick, cognitiveLevel: linkLevelPick }),
      }));
      setLinkOutcomePick('');
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function changeOutcomeLevel(outcomeId: string, cognitiveLevel: string) {
    if (!editing) return;
    try {
      setLinks(await apiJson<CurriculumLinksView>(`/api/v1/questions/${editing.question.id}/outcomes/${outcomeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ cognitiveLevel }),
      }));
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function detachLinkOutcome(outcomeId: string) {
    if (!editing) return;
    try {
      setLinks(await apiJson<CurriculumLinksView>(`/api/v1/questions/${editing.question.id}/outcomes/${outcomeId}`, { method: 'DELETE' }));
    } catch {
      setMessage(t('programmeSaveFailed'));
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
        <input
          type="checkbox"
          aria-label={t('selectQuestionForAttempt', { name: view.question.name })}
          checked={selected.includes(view.question.id)}
          onChange={(e) =>
            setSelected((prev) =>
              e.target.checked ? [...prev, view.question.id] : prev.filter((qid) => qid !== view.question.id),
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
          <Button type="button" variant="outline" onClick={() => void startEdit(view)}>
            {t('editNewVersion')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void showVersions(view)}>
            {t('history')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('questionBank')}</CardTitle>
          <CardDescription>{t('questionBankDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {categories.map((cat) => (
              <li key={cat.id}>
                <button
                  type="button"
                  onClick={() => {
                    setQCategory(String(cat.id));
                    editOptionsRequestRef.current += 1;
                    setEditing(null);
                    void loadQuestions(cat.id);
                    void loadStimuli(cat.id).catch(() => setMessage(t('stimulusLoadFailed')));
                  }}
                >
                  {cat.name}
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
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
          <Button type="button" disabled={selected.length === 0} onClick={() => void startUsageFromSelection()}>
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
          {message && <p role="status">{message}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('newCategory')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void createCategory(e)} className="space-y-3">
            <div>
              <Label htmlFor="qcat-name">{t('name')}</Label>
              <Input id="qcat-name" value={catName} onChange={(e) => setCatName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="qcat-context">{t('contextId')}</Label>
              <Input id="qcat-context" value={contextId} onChange={(e) => setContextId(e.target.value)} />
            </div>
            <Button type="submit">{t('createCategory')}</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{editing ? t('editQuestionTitle', { name: editing.question.name }) : t('newQuestion')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void submitQuestion(e)} className="space-y-3">
            <div>
              <Label htmlFor="q-type">{t('questionType')}</Label>
              <select
                id="q-type"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                value={form.qtype}
                disabled={editing !== null}
                onChange={(e) => setForm(emptyForm(e.target.value as Qtype))}
              >
                {QTYPES.map((qtype) => (
                  <option key={qtype} value={qtype}>
                    {t(QTYPE_LABEL_KEYS[qtype])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="q-name">{t('name')}</Label>
              <Input id="q-name" value={form.name} onChange={(e) => patchForm({ name: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="q-text">{t('questionText')}</Label>
              <Input id="q-text" value={form.questionText} onChange={(e) => patchForm({ questionText: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="q-stimulus">{t('attachedStimulus')}</Label>
              <select
                id="q-stimulus"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                value={form.stimulusId}
                onChange={(e) => patchForm({ stimulusId: e.target.value })}
              >
                <option value="">{t('noStimulus')}</option>
                {stimuli.map((stimulus) => (
                  <option key={stimulus.id} value={stimulus.id}>
                    {plainText(stimulus.content).slice(0, 80)}
                  </option>
                ))}
              </select>
            </div>

            {form.qtype === 'multichoice' && (
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">{t('choices')}</legend>
                <div className="flex items-center gap-2">
                  <input
                    id="q-mc-single"
                    type="checkbox"
                    checked={form.mcSingle}
                    onChange={(e) => patchForm({ mcSingle: e.target.checked })}
                  />
                  <Label htmlFor="q-mc-single">{t('singleAnswerOnly')}</Label>
                </div>
                {form.mcChoices.map((choice, index) => (
                  <div key={index} className="space-y-2 rounded-md border p-3">
                    <div>
                      <Label htmlFor={`q-choice-${index}`}>{t('choiceText', { index: index + 1 })}</Label>
                      <Input
                        id={`q-choice-${index}`}
                        value={choice.text}
                        onChange={(e) =>
                          patchForm({
                            mcChoices: form.mcChoices.map((c, i) => (i === index ? { ...c, text: e.target.value } : c)),
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor={`q-choice-fraction-${index}`}>{t('choiceFraction', { index: index + 1 })}</Label>
                      <Input
                        id={`q-choice-fraction-${index}`}
                        type="number"
                        step="0.05"
                        min="-1"
                        max="1"
                        value={choice.fraction}
                        onChange={(e) =>
                          patchForm({
                            mcChoices: form.mcChoices.map((c, i) =>
                              i === index ? { ...c, fraction: e.target.value } : c,
                            ),
                          })
                        }
                      />
                    </div>
                    {form.mcSingle && (
                      <div className="flex items-center gap-2">
                        <input
                          id={`q-choice-correct-${index}`}
                          type="radio"
                          name="q-correct-choice"
                          checked={Number(choice.fraction) === 1}
                          onChange={() =>
                            patchForm({
                              mcChoices: form.mcChoices.map((c, i) => ({
                                ...c,
                                fraction: i === index ? '1' : '0',
                              })),
                            })
                          }
                        />
                        <Label htmlFor={`q-choice-correct-${index}`}>{t('correctChoice')}</Label>
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={form.mcChoices.length <= 2}
                      onClick={() => patchForm({ mcChoices: form.mcChoices.filter((_, i) => i !== index) })}
                    >
                      {t('removeChoice', { index: index + 1 })}
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => patchForm({ mcChoices: [...form.mcChoices, { text: '', fraction: '0' }] })}
                >
                  {t('addChoice')}
                </Button>
              </fieldset>
            )}

            {form.qtype === 'truefalse' && (
              <fieldset className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    id="q-tf-true"
                    type="radio"
                    name="q-tf-correct"
                    checked={form.tfCorrect}
                    onChange={() => patchForm({ tfCorrect: true })}
                  />
                  <Label htmlFor="q-tf-true">{t('correctAnswerIsTrue')}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="q-tf-false"
                    type="radio"
                    name="q-tf-correct"
                    checked={!form.tfCorrect}
                    onChange={() => patchForm({ tfCorrect: false })}
                  />
                  <Label htmlFor="q-tf-false">{t('correctAnswerIsFalse')}</Label>
                </div>
              </fieldset>
            )}

            {form.qtype === 'shortanswer' && (
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">{t('acceptedAnswers')}</legend>
                <div className="flex items-center gap-2">
                  <input
                    id="q-sa-usecase"
                    type="checkbox"
                    checked={form.saUseCase}
                    onChange={(e) => patchForm({ saUseCase: e.target.checked })}
                  />
                  <Label htmlFor="q-sa-usecase">{t('caseSensitive')}</Label>
                </div>
                {form.saAnswers.map((answer, index) => (
                  <div key={index} className="space-y-2 rounded-md border p-3">
                    <div>
                      <Label htmlFor={`q-sa-answer-${index}`}>{t('acceptedAnswerText', { index: index + 1 })}</Label>
                      <Input
                        id={`q-sa-answer-${index}`}
                        value={answer.text}
                        onChange={(e) =>
                          patchForm({
                            saAnswers: form.saAnswers.map((a, i) => (i === index ? { ...a, text: e.target.value } : a)),
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor={`q-sa-fraction-${index}`}>{t('answerFraction', { index: index + 1 })}</Label>
                      <Input
                        id={`q-sa-fraction-${index}`}
                        type="number"
                        step="0.05"
                        min="0"
                        max="1"
                        value={answer.fraction}
                        onChange={(e) =>
                          patchForm({
                            saAnswers: form.saAnswers.map((a, i) =>
                              i === index ? { ...a, fraction: e.target.value } : a,
                            ),
                          })
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={form.saAnswers.length <= 1}
                      onClick={() => patchForm({ saAnswers: form.saAnswers.filter((_, i) => i !== index) })}
                    >
                      {t('removeAnswer', { index: index + 1 })}
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => patchForm({ saAnswers: [...form.saAnswers, { text: '', fraction: '0' }] })}
                >
                  {t('addAnswer')}
                </Button>
              </fieldset>
            )}

            {form.qtype === 'essay' && (
              <fieldset className="space-y-3">
                <div>
                  <Label htmlFor="q-essay-format">{t('responseFormat')}</Label>
                  <select
                    id="q-essay-format"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={form.essayResponseFormat}
                    onChange={(e) => patchForm({ essayResponseFormat: e.target.value })}
                  >
                    <option value="editor">{t('responseFormatEditor')}</option>
                    <option value="plain">{t('responseFormatPlain')}</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="q-essay-response-required"
                    type="checkbox"
                    checked={form.essayResponseRequired}
                    onChange={(e) => patchForm({ essayResponseRequired: e.target.checked })}
                  />
                  <Label htmlFor="q-essay-response-required">{t('responseRequired')}</Label>
                </div>
                <div>
                  <Label htmlFor="q-essay-response-field-lines">{t('responseFieldLines')}</Label>
                  <Input
                    id="q-essay-response-field-lines"
                    type="number"
                    min="1"
                    value={form.essayResponseFieldLines}
                    onChange={(e) => patchForm({ essayResponseFieldLines: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="q-essay-minwords">{t('minWordLimit')}</Label>
                  <Input
                    id="q-essay-minwords"
                    type="number"
                    min="0"
                    value={form.essayMinWords}
                    onChange={(e) => patchForm({ essayMinWords: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="q-essay-maxwords">{t('maxWordLimit')}</Label>
                  <Input
                    id="q-essay-maxwords"
                    type="number"
                    min="0"
                    value={form.essayMaxWords}
                    onChange={(e) => patchForm({ essayMaxWords: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="q-essay-graderinfo">{t('graderInfo')}</Label>
                  <textarea
                    id="q-essay-graderinfo"
                    className="w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs"
                    rows={3}
                    value={form.essayGraderInfo}
                    onChange={(e) => patchForm({ essayGraderInfo: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="q-essay-template">{t('responseTemplate')}</Label>
                  <textarea
                    id="q-essay-template"
                    className="w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs"
                    rows={3}
                    value={form.essayResponseTemplate}
                    onChange={(e) => patchForm({ essayResponseTemplate: e.target.value })}
                  />
                </div>
              </fieldset>
            )}

            <div className="flex gap-2">
              <Button type="submit">{editing ? t('saveNewVersion') : t('createQuestion')}</Button>
              {editing && (
                <Button type="button" variant="outline" onClick={cancelEdit}>
                  {t('cancelEdit')}
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

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
                        <span className="flex-1 text-sm">{linkSubjects.find((s) => s.id === subjectId)?.name ?? subjectId}</span>
                        <Button type="button" variant="outline" onClick={() => void detachLinkSubject(subjectId)}>
                          {t('programmeDetach')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2">
                    <select
                      id="programme-subject-pick"
                      aria-label={t('programmePickSubject')}
                      className="h-9 flex-1 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                      value={linkSubjectPick}
                      onChange={(e) => void pickLinkSubject(e.target.value)}
                    >
                      <option value="">{t('programmePickSubject')}</option>
                      {linkSubjects
                        .filter((s) => !links.subjectIds.includes(s.id))
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
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
                        <select
                          aria-label={t('programmeLevel')}
                          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                          value={o.cognitiveLevel}
                          onChange={(e) => void changeOutcomeLevel(o.outcomeId, e.target.value)}
                        >
                          {COGNITIVE_LEVELS.map((level) => (
                            <option key={level} value={level}>
                              {t(LEVEL_LABEL_KEYS[level])}
                            </option>
                          ))}
                        </select>
                        <Button type="button" variant="outline" onClick={() => void detachLinkOutcome(o.outcomeId)}>
                          {t('programmeDetach')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2">
                    <select
                      id="programme-outcome-pick"
                      aria-label={t('programmePickOutcome')}
                      className="h-9 flex-1 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                      value={linkOutcomePick}
                      onChange={(e) => setLinkOutcomePick(e.target.value)}
                    >
                      <option value="">{t('programmePickOutcome')}</option>
                      {linkOutcomeOptions
                        .filter((o) => !links.outcomes.some((l) => l.outcomeId === o.id))
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                    </select>
                    <select
                      aria-label={t('programmeLevel')}
                      className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                      value={linkLevelPick}
                      onChange={(e) => setLinkLevelPick(e.target.value)}
                    >
                      {COGNITIVE_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {t(LEVEL_LABEL_KEYS[level])}
                        </option>
                      ))}
                    </select>
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
          <form onSubmit={(e) => void submitStimulus(e)} className="space-y-3">
            <div>
              <Label htmlFor="stimulus-content">{editingStimulus ? t('stimulusContent') : t('newStimulus')}</Label>
              <textarea
                id="stimulus-content"
                className="w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs"
                rows={4}
                value={stimulusContent}
                onChange={(e) => setStimulusContent(e.target.value)}
              />
            </div>
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
          </form>
        </CardContent>
      </Card>
    </main>
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
    void reload().catch(() => setError(t('attemptLoadFailed')));
  }, [reload, t]);

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

  if (error)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <p role="alert">{error}</p>
      </main>
    );
  if (!usage) return <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">{t('attemptLoading')}</main>;
  const usageId = usage.usage.id;
  const gradedStates = ['gradedright', 'gradedpartial', 'gradedwrong', 'gaveup'];
  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('questionAttemptTitle', { component: usage.usage.component })}</CardTitle>
          <CardDescription>{t('usageState', { state: usage.state })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('deferredFeedbackNote')}</p>
          {actionError ? <p role="alert">{actionError}</p> : null}
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
                      <div>
                        <Label htmlFor={`answer-${a.id}`}>{t('answerForSlot', { slot: a.slot })}</Label>
                        <Input
                          id={`answer-${a.id}`}
                          value={answers[a.id] ?? lastAnswer}
                          onChange={(e) => setAnswers((prev) => ({ ...prev, [a.id]: e.target.value }))}
                        />
                      </div>
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
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default QuestionsPage;
