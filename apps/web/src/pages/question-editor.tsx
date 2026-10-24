import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { QuestionCategory, QuestionView, StimulusView } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
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
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiJson } from '#lib/api';
import {
  COGNITIVE_LEVELS,
  LEVEL_LABEL_KEYS,
  QTYPE_LABEL_KEYS,
  QTYPES,
  emptyForm,
  formContent,
  formFromView,
  hasAllOptions,
  plainText,
  withApiReason,
  type CurriculumLinksView,
  type CurriculumTreeNode,
  type OptionsRecord,
  type Qtype,
  type QuestionFormState,
} from './questions';

/**
 * Màn editor câu hỏi RIÊNG theo chuẩn §9 (tạo mới /questions/new, sửa
 * /questions/:questionId/edit?category=<id>): trước đây form này nhồi
 * ngay dưới danh sách ngân hàng trong cùng một trang. Sửa tạo phiên bản
 * mới phía server (PATCH) như trước; khối gắn kết chương trình chỉ hiện
 * ở màn sửa. Lưu xong quay về danh sách ngân hàng.
 */
export function QuestionEditorPage({ mode }: { mode: 'new' | 'edit' }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const { questionId } = useParams();
  const [searchParams] = useSearchParams();
  const categoryParam = searchParams.get('category') ?? '';
  const [categoryId, setCategoryId] = useState(categoryParam);
  const [editing, setEditing] = useState<QuestionView | null>(null);
  const [form, setForm] = useState<QuestionFormState>(() => emptyForm('multichoice'));
  const [stimuli, setStimuli] = useState<StimulusView[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

  const loadStimuli = useCallback(async (catId: string) => {
    const rows = await apiJson<StimulusView[]>(`/api/v1/stimuli?categoryId=${catId}`);
    setStimuli(rows);
  }, []);

  /** Nạp gắn kết chương trình của câu hỏi + nhãn nội dung cho các YCCĐ đã gắn. */
  const loadCurriculumLinks = useCallback(
    async (qid: string) => {
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
    },
    [],
  );

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
      setForm(formFromView(view));
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
          setForm(formFromView(view, latest.options));
        }
      } catch {
        // Không tải được options bổ sung thì giữ nguyên phần đã nạp từ view.
      }
    },
    [loadCurriculumLinks, loadLinkSubjects],
  );

  /** Khởi tạo màn: chốt danh mục (tham số ?category= hoặc danh mục đầu), nạp ngữ liệu, và (khi sửa) tìm câu hỏi. */
  useEffect(() => {
    void (async () => {
      try {
        let catId = categoryParam;
        if (!catId) {
          const cats = await apiJson<QuestionCategory[]>('/api/v1/questions/categories');
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

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    if (editing) {
      try {
        await apiJson<QuestionView>(`/api/v1/questions/${editing.question.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            ...formContent(form, true),
            stimulusId: form.stimulusId === '' ? null : form.stimulusId,
          }),
        });
        navigate('/questions');
      } catch (err) {
        setMessage(withApiReason(t('questionEditFailed'), err));
      }
      return;
    }
    try {
      await apiJson('/api/v1/questions', {
        method: 'POST',
        body: JSON.stringify({
          categoryId,
          qtype: form.qtype,
          ...formContent(form),
          ...(form.stimulusId ? { stimulusId: form.stimulusId } : {}),
        }),
      });
      navigate('/questions');
    } catch (err) {
      setMessage(withApiReason(t('questionCreateFailed'), err));
    }
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
      <PageShell width="medium">
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
      <PageShell width="medium">
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

  return (
    <PageShell width="medium">
      <PageHeader title={editing ? t('editQuestionTitle', { name: editing.question.name }) : t('newQuestion')} />
      {/* Thông báo kết quả gửi form giữ vai trò status như trang inline
          cũ trên main (hợp đồng đã có spec của issue #55). */}
      {message ? (
        <Alert role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent>
          <form onSubmit={(e) => void submitQuestion(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel id="q-type-label">{t('questionType')}</FieldLabel>
                <Select
                  items={Object.fromEntries(QTYPES.map((qtype) => [qtype, t(QTYPE_LABEL_KEYS[qtype])]))}
                  value={form.qtype}
                  disabled={editing !== null}
                  onValueChange={(v) => setForm(emptyForm((v ?? 'multichoice') as Qtype))}
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
                <FieldLabel htmlFor="q-name">{t('name')}</FieldLabel>
                <Input id="q-name" value={form.name} onChange={(e) => patchForm({ name: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="q-text">{t('questionText')}</FieldLabel>
                <Input
                  id="q-text"
                  value={form.questionText}
                  onChange={(e) => patchForm({ questionText: e.target.value })}
                />
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

              {form.qtype === 'multichoice' && (
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium">{t('choices')}</legend>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="q-mc-single"
                      checked={form.mcSingle}
                      onCheckedChange={(checked) => patchForm({ mcSingle: checked === true })}
                    />
                    <Label htmlFor="q-mc-single">{t('singleAnswerOnly')}</Label>
                  </div>
                  {form.mcChoices.map((choice, index) => (
                    <div key={index} className="space-y-2 rounded-md border p-3">
                      <Field>
                        <FieldLabel htmlFor={`q-choice-${index}`}>{t('choiceText', { index: index + 1 })}</FieldLabel>
                        <Input
                          id={`q-choice-${index}`}
                          value={choice.text}
                          onChange={(e) =>
                            patchForm({
                              mcChoices: form.mcChoices.map((c, i) => (i === index ? { ...c, text: e.target.value } : c)),
                            })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`q-choice-fraction-${index}`}>
                          {t('choiceFraction', { index: index + 1 })}
                        </FieldLabel>
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
                      </Field>
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
                    <Checkbox
                      id="q-sa-usecase"
                      checked={form.saUseCase}
                      onCheckedChange={(checked) => patchForm({ saUseCase: checked === true })}
                    />
                    <Label htmlFor="q-sa-usecase">{t('caseSensitive')}</Label>
                  </div>
                  {form.saAnswers.map((answer, index) => (
                    <div key={index} className="space-y-2 rounded-md border p-3">
                      <Field>
                        <FieldLabel htmlFor={`q-sa-answer-${index}`}>
                          {t('acceptedAnswerText', { index: index + 1 })}
                        </FieldLabel>
                        <Input
                          id={`q-sa-answer-${index}`}
                          value={answer.text}
                          onChange={(e) =>
                            patchForm({
                              saAnswers: form.saAnswers.map((a, i) => (i === index ? { ...a, text: e.target.value } : a)),
                            })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`q-sa-fraction-${index}`}>
                          {t('answerFraction', { index: index + 1 })}
                        </FieldLabel>
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
                      </Field>
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
                      id="q-essay-response-required"
                      checked={form.essayResponseRequired}
                      onCheckedChange={(checked) => patchForm({ essayResponseRequired: checked === true })}
                    />
                    <Label htmlFor="q-essay-response-required">{t('responseRequired')}</Label>
                  </div>
                  <Field>
                    <FieldLabel htmlFor="q-essay-response-field-lines">{t('responseFieldLines')}</FieldLabel>
                    <Input
                      id="q-essay-response-field-lines"
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
                  <Field>
                    <FieldLabel htmlFor="q-essay-graderinfo">{t('graderInfo')}</FieldLabel>
                    <textarea
                      id="q-essay-graderinfo"
                      className="w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs"
                      rows={3}
                      value={form.essayGraderInfo}
                      onChange={(e) => patchForm({ essayGraderInfo: e.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="q-essay-template">{t('responseTemplate')}</FieldLabel>
                    <textarea
                      id="q-essay-template"
                      className="w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs"
                      rows={3}
                      value={form.essayResponseTemplate}
                      onChange={(e) => patchForm({ essayResponseTemplate: e.target.value })}
                    />
                  </Field>
                </fieldset>
              )}

              <div className="flex gap-2">
                <Button type="submit">{editing ? t('saveNewVersion') : t('createQuestion')}</Button>
                {editing && (
                  <Button type="button" variant="outline" render={<Link to="/questions" />}>
                    {t('cancelEdit')}
                  </Button>
                )}
              </div>
            </FieldGroup>
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
