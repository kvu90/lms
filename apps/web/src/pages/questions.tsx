import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { extractRichTextPlainText, type QuestionCategory, type QuestionUsage, type QuestionView, type RichTextDocument } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { DataTable, type DataColumn } from '#components/data-table';

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
  const [versionsOf, setVersionsOf] = useState<{
    questionId: string;
    versions: { version: number; questionText: RichTextDocument }[];
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [contextId, setContextId] = useState('1');
  const [catName, setCatName] = useState('');
  const [qCategory, setQCategory] = useState('');
  const [qName, setQName] = useState('');
  const [qText, setQText] = useState('');
  const [qCorrect, setQCorrect] = useState('true');

  const loadQuestions = useCallback(async (categoryId: string) => {
    const rows = await apiJson<QuestionView[]>(`/api/v1/questions/categories/${categoryId}/questions`);
    setQuestions(rows);
  }, []);
  const reload = useCallback(async () => {
    const cats = await apiJson<QuestionCategory[]>('/api/v1/questions/categories');
    setCategories(cats);
    if (cats.length) {
      setQCategory((prev) => prev || String(cats[0]!.id));
      await loadQuestions(qCategory || cats[0]!.id);
    }
  }, [loadQuestions, qCategory]);

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

  async function createQuestion(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson('/api/v1/questions', {
        method: 'POST',
        body: JSON.stringify({
          categoryId: qCategory,
          qtype: 'truefalse',
          name: qName,
          questionText: qText,
          answer: { correct: qCorrect === 'true' },
        }),
      });
      setQName('');
      setQText('');
      await loadQuestions(qCategory);
    } catch {
      setMessage(t('questionCreateFailed'));
    }
  }

  async function editQuestion(view: QuestionView) {
    const newText = `${extractRichTextPlainText(view.latestVersion.questionText)} (edited)`;
    try {
      const updated = await apiJson<QuestionView>(`/api/v1/questions/${view.question.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ questionText: newText }),
      });
      setMessage(t('questionSavedAsVersion', { version: updated.entry.latestVersion }));
      await loadQuestions(view.question.category);
    } catch {
      setMessage(t('questionEditFailed'));
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
      cell: (view) => <span className="text-sm text-muted-foreground">{extractRichTextPlainText(view.latestVersion.questionText)}</span>,
      filterValue: (view) => extractRichTextPlainText(view.latestVersion.questionText),
    },
    {
      id: 'actions',
      header: t('actions'),
      cell: (view) => (
        <span className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => void editQuestion(view)}>
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
                    void loadQuestions(cat.id);
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
                    v{v.version} — {extractRichTextPlainText(v.questionText)}
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
          <CardTitle>{t('newTrueFalseQuestion')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void createQuestion(e)} className="space-y-3">
            <div>
              <Label htmlFor="q-name">{t('name')}</Label>
              <Input id="q-name" value={qName} onChange={(e) => setQName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="q-text">{t('questionText')}</Label>
              <Input id="q-text" value={qText} onChange={(e) => setQText(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="q-correct">{t('correctAnswerIsTrue')}</Label>
              <Input id="q-correct" value={qCorrect} onChange={(e) => setQCorrect(e.target.value)} />
            </div>
            <Button type="submit">{t('createQuestion')}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
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

  /** Nạp (lại) usage hiện tại từ API — nguồn sự thật cho state/fraction. */
  const reload = useCallback(async () => {
    const fresh = await apiJson<QuestionUsage>(`/api/v1/question-usages/${id}`);
    setUsage(fresh);
  }, [id]);

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
