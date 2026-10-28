import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { QuestionCategory, QuestionView, StimulusView } from '@lms/contracts';
import { composeMultipleChoiceDocument, splitMultipleChoiceDocument } from '@lms/editor';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { FieldGroup } from '@lms/ui/components/field';
import { Skeleton } from '@lms/ui/components/skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import { AnswersSection } from '../components/question-editor/answers-section';
import {
  editorFormContent,
  editorFormFromView,
  emptyEditorForm,
  entryStatus,
  type Doc,
  type QuestionEditorFormState,
} from '../components/question-editor/form-model';
import { GeneralSection } from '../components/question-editor/general-section';
import { ProgrammeLinks } from '../components/question-editor/programme-links';
import { StudentPreview, formExcerpt } from '../components/question-editor/student-preview';
import '../i18n';
import { useQueryClient } from '@tanstack/react-query';
import { accessContextsQueryOptions } from '#lib/access';
import {
  curriculumOutcomeQueryOptions,
  curriculumSubjectsScopedQueryOptions,
  curriculumTreeScopedQueryOptions,
  type CurriculumTreeNode as LibCurriculumTreeNode,
} from '#lib/curriculum';
import { curriculaBySubjectQueryOptions } from '#lib/matrix-data';
import {
  categoryQuestionsQueryOptions,
  categoryStimuliQueryOptions,
  clearQuestionBankListCache,
  editorQuestionVersionsQueryOptions,
  questionCategoriesQueryOptions,
  questionCurriculumLinksQueryOptions,
  useAttachQuestionOutcome,
  useAttachQuestionSubject,
  useCreateQuestion,
  useDetachQuestionOutcome,
  useDetachQuestionSubject,
  useSetQuestionStatus,
  useUpdateQuestionContent,
  useUpdateQuestionOutcomeLink,
} from '#lib/questions-data';
import { QTYPES, hasAllOptions, withApiReason, type CurriculumLinksView, type Qtype } from './questions';

export { editorFormContent, editorFormFromView, emptyEditorForm, type QuestionEditorFormState };

/**
 * Màn soạn câu hỏi (issue #248) — flow tổng thể:
 *
 * 1. Nạp: danh mục (kèm context cho đường tải ảnh) + ngữ liệu của danh
 *    mục; khi sửa, nạp view câu hỏi rồi `editorFormFromView` lắp thành
 *    trạng thái form (options thiếu thì tìm thêm ở endpoint versions).
 * 2. Soạn: form riêng cho từng loại trong 4 loại — multichoice,
 *    truefalse (TF-A: MỘT câu chùm gồm thân chung + 4 mệnh đề soạn
 *    trong một tài liệu thống nhất với đáp án Đ/S theo từng mệnh đề),
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
// Trang soạn
// ---------------------------------------------------------------------------

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

  // Thao tác ghi của màn soạn qua đột biến của lib/questions-data
  // (F-01): lưu nội dung/trạng thái câu và các gắn kết chương trình.
  const setStatusMutation = useSetQuestionStatus();
  const updateQuestionMutation = useUpdateQuestionContent();
  const createQuestionMutation = useCreateQuestion();
  const attachSubjectMutation = useAttachQuestionSubject();
  const detachSubjectMutation = useDetachQuestionSubject();
  const attachOutcomeMutation = useAttachQuestionOutcome();
  const updateOutcomeLinkMutation = useUpdateQuestionOutcomeLink();
  const detachOutcomeMutation = useDetachQuestionOutcome();

  /** Context của bank đích — bộ chọn ảnh tải lên đúng context này. */
  const contextId = categories.find((c) => c.id === categoryId)?.contextId;

  // Các lượt đọc của màn soạn đi qua fetchQuery với tuỳ chọn của
  // lib/questions-data và các module miền liên quan (F-01 của rà
  // soát #133): vẫn qua bộ nhớ đệm + dedupe của TanStack, nhịp
  // trạng thái tại chỗ của màn giữ nguyên như bản fetch thủ công.
  const loadStimuli = useCallback(
    async (catId: string) => {
      const rows = await queryClient.fetchQuery(categoryStimuliQueryOptions(catId));
      setStimuli(rows);
    },
    [queryClient],
  );

  /** Nạp gắn kết chương trình của câu hỏi + nhãn nội dung cho các YCCĐ đã gắn. */
  const loadCurriculumLinks = useCallback(
    async (qid: string) => {
      try {
        const view = await queryClient.fetchQuery(questionCurriculumLinksQueryOptions(qid));
        setLinks(view);
        const labels: Record<string, string> = {};
        for (const o of view.outcomes) {
          try {
            const oc = await queryClient.fetchQuery(curriculumOutcomeQueryOptions(o.outcomeId));
            labels[oc.id] = oc.content;
          } catch {
            // Thiếu nhãn thì dòng gắn vẫn hiện bằng id của YCCĐ.
          }
        }
        if (Object.keys(labels).length > 0) setOutcomeLabels((prev) => ({ ...prev, ...labels }));
      } catch {
        setLinks(null);
      }
    },
    [queryClient],
  );

  /** Môn học cho khối Chương trình: chương trình quốc gia GDPT 2018 neo ở context hệ thống. */
  const loadLinkSubjects = useCallback(async () => {
    try {
      const contexts = await queryClient.fetchQuery(accessContextsQueryOptions());
      const system = contexts.find((c) => c.contextLevel === 10);
      if (!system) return;
      const rows = await queryClient.fetchQuery(curriculumSubjectsScopedQueryOptions(system.id));
      setLinkSubjects(rows);
    } catch {
      // Khối chương trình là phụ trợ của editor; bỏ qua khi không tải được.
    }
  }, [queryClient]);

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
        const versions = await queryClient.fetchQuery(editorQuestionVersionsQueryOptions(view.question.id));
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
        const cats = await queryClient.fetchQuery(questionCategoriesQueryOptions());
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
          const rows = await queryClient.fetchQuery(categoryQuestionsQueryOptions(catId));
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
      current === 'draft' || current === 'ready' ? current !== target : current === undefined && target === 'draft';
    if (!needsCall) return;
    await setStatusMutation.mutateAsync({ questionId: id, status: target });
  }

  /** Lưu nội dung (tạo mới hoặc tạo phiên bản mới) rồi chốt trạng thái đích. */
  async function submitWith(target: 'draft' | 'ready') {
    if (saving) return;
    setMessage(null);
    setSaving(target);
    try {
      const effective = form;
      if (editing) {
        const updated = await updateQuestionMutation.mutateAsync({
          questionId: editing.question.id,
          body: {
            ...editorFormContent(effective),
            stimulusId: form.stimulusId === '' ? null : form.stimulusId,
          },
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
      const created = await createQuestionMutation.mutateAsync({
        categoryId,
        qtype: form.qtype,
        ...editorFormContent(effective),
        ...(form.stimulusId ? { stimulusId: form.stimulusId } : {}),
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

  /** Đổi danh mục đích: chốt danh mục mới, bỏ ngữ liệu đang gắn và nạp ngữ liệu của danh mục mới. */
  function handleCategoryChange(v: string | null) {
    if (!v) return;
    setCategoryId(v);
    patchForm({ stimulusId: '' });
    void loadStimuli(v).catch(() => setMessage(t('stimulusLoadFailed')));
  }

  /** Đổi loại câu hỏi: dựng form của loại mới, giữ các trường chung và đưa thân câu qua lại với tài liệu thống nhất của trắc nghiệm. */
  function handleQtypeChange(v: string | null) {
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
        next.questionText = splitMultipleChoiceDocument(prev.mcDocument).question as Doc;
      }
      if (qtype === 'multichoice' && prev.qtype !== 'multichoice') {
        next.mcDocument = composeMultipleChoiceDocument(prev.questionText, []);
      }
      return next;
    });
  }

  /** Chọn môn → nạp cây của mọi khối thuộc môn đó → danh sách YCCĐ chọn được. */
  async function pickLinkSubject(subjectId: string) {
    setLinkSubjectPick(subjectId);
    setLinkOutcomePick('');
    setLinkOutcomeOptions([]);
    if (!subjectId) return;
    try {
      const curricula = await queryClient.fetchQuery(curriculaBySubjectQueryOptions(subjectId));
      const options: { id: string; label: string }[] = [];
      const labels: Record<string, string> = {};
      for (const curr of curricula) {
        const tree = await queryClient.fetchQuery(curriculumTreeScopedQueryOptions(curr.id, undefined));
        const walk = (nodes: LibCurriculumTreeNode[]): void => {
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
        await attachSubjectMutation.mutateAsync({ questionId: editing.question.id, subjectId: linkSubjectPick }),
      );
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function detachLinkSubject(subjectId: string) {
    if (!editing) return;
    try {
      setLinks(await detachSubjectMutation.mutateAsync({ questionId: editing.question.id, subjectId }));
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function attachLinkOutcome() {
    if (!editing || !linkOutcomePick) return;
    try {
      setLinks(
        await attachOutcomeMutation.mutateAsync({
          questionId: editing.question.id,
          outcomeId: linkOutcomePick,
          cognitiveLevel: linkLevelPick,
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
        await updateOutcomeLinkMutation.mutateAsync({
          questionId: editing.question.id,
          outcomeId,
          cognitiveLevel,
        }),
      );
    } catch {
      setMessage(t('programmeSaveFailed'));
    }
  }

  async function detachLinkOutcome(outcomeId: string) {
    if (!editing) return;
    try {
      setLinks(await detachOutcomeMutation.mutateAsync({ questionId: editing.question.id, outcomeId }));
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
        <ErrorAlert variant="destructive">
          {loadError}
        </ErrorAlert>
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
              <ErrorAlert variant="destructive" role="status">
                {message}
              </ErrorAlert>
            ) : null}
            {/* Bố cục 2 cột BẰNG NHAU như giaokhoa (grid gap-6
                lg:grid-cols-2) + trang dùng toàn bề rộng (PageShell
                width="full" ở trên): trái soạn, phải xem trước. Trước
                lát E3 cột xem trước bị bó cố định 360px. */}
            <div className="grid items-start gap-6 lg:grid-cols-2">
              <FieldGroup>
                <GeneralSection
                  form={form}
                  patchForm={patchForm}
                  categories={categories}
                  categoryId={categoryId}
                  editing={editing !== null}
                  stimuli={stimuli}
                  contextId={contextId}
                  itemId={editing?.question.id}
                  onCategoryChange={handleCategoryChange}
                  onQtypeChange={handleQtypeChange}
                />
                <AnswersSection
                  form={form}
                  patchForm={patchForm}
                  contextId={contextId}
                  itemId={editing?.question.id}
                  moveItem={moveItem}
                />
              </FieldGroup>
              <StudentPreview form={form} stimulus={selectedStimulus} />
            </div>
          </CardContent>
        </Card>
      </form>

      {editing && (
        <ProgrammeLinks
          links={links}
          linkSubjects={linkSubjects}
          outcomeLabels={outcomeLabels}
          linkSubjectPick={linkSubjectPick}
          linkOutcomeOptions={linkOutcomeOptions}
          linkOutcomePick={linkOutcomePick}
          linkLevelPick={linkLevelPick}
          pickLinkSubject={pickLinkSubject}
          attachLinkSubject={attachLinkSubject}
          detachLinkSubject={detachLinkSubject}
          attachLinkOutcome={attachLinkOutcome}
          changeOutcomeLevel={changeOutcomeLevel}
          detachLinkOutcome={detachLinkOutcome}
          setLinkOutcomePick={setLinkOutcomePick}
          setLinkLevelPick={setLinkLevelPick}
        />
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
