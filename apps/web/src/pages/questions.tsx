import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { QuestionCategory, QuestionUsage, QuestionView } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';

/**
 * Question bank: categories, questions with their CURRENT version
 * badge, create/edit. Editing creates a new version server-side — the badge
 * increments and the version history shows every version (attempts already
 * started keep the version they pinned; that invariant is API-side).
 */
export function QuestionsPage() {
  const { t } = useTranslation('app');
  const [categories, setCategories] = useState<QuestionCategory[]>([]);
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [versionsOf, setVersionsOf] = useState<{ questionId: number; versions: { version: number; questiontext: string }[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [contextId, setContextId] = useState('1');
  const [catName, setCatName] = useState('');
  const [qCategory, setQCategory] = useState('');
  const [qName, setQName] = useState('');
  const [qText, setQText] = useState('');
  const [qCorrect, setQCorrect] = useState('true');

  const loadQuestions = useCallback(async (categoryId: number) => {
    const rows = await apiJson<QuestionView[]>(`/api/v1/questions/categories/${categoryId}/questions`);
    setQuestions(rows);
  }, []);
  const reload = useCallback(async () => {
    const cats = await apiJson<QuestionCategory[]>('/api/v1/questions/categories');
    setCategories(cats);
    if (cats.length) {
      setQCategory((prev) => prev || String(cats[0]!.id));
      await loadQuestions(Number(qCategory || cats[0]!.id));
    }
  }, [loadQuestions, qCategory]);

  useEffect(() => { void reload().catch(() => setMessage(t('questionBankLoadFailed'))); }, [reload]);

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson('/api/v1/questions/categories', {
        method: 'POST', body: JSON.stringify({ name: catName, contextid: Number(contextId) }),
      });
      setCatName('');
      await reload();
    } catch { setMessage(t('categoryCreateFailedShort')); }
  }

  async function createQuestion(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson('/api/v1/questions', {
        method: 'POST',
        body: JSON.stringify({
          categoryId: Number(qCategory), qtype: 'truefalse', name: qName, questiontext: qText,
          answer: { correct: qCorrect === 'true' },
        }),
      });
      setQName(''); setQText('');
      await loadQuestions(Number(qCategory));
    } catch { setMessage(t('questionCreateFailed')); }
  }

  async function editQuestion(view: QuestionView) {
    const newText = `${view.latestVersion.questiontext} (edited)`;
    try {
      const updated = await apiJson<QuestionView>(`/api/v1/questions/${view.question.id}`, {
        method: 'PATCH', body: JSON.stringify({ questiontext: newText }),
      });
      setMessage(t('questionSavedAsVersion', { version: updated.entry.latestversion }));
      await loadQuestions(view.question.category);
    } catch { setMessage(t('questionEditFailed')); }
  }

  async function showVersions(view: QuestionView) {
    const versions = await apiJson<{ version: number; questiontext: string }[]>(`/api/v1/questions/${view.question.id}/versions`);
    setVersionsOf({ questionId: view.question.id, versions });
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('questionBank')}</CardTitle>
          <CardDescription>{t('questionBankDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {categories.map((cat) => (
              <li key={cat.id}>
                <button type="button" onClick={() => { setQCategory(String(cat.id)); void loadQuestions(cat.id); }}>
                  {cat.name}
                </button>
              </li>
            ))}
          </ul>
          <ul className="space-y-2">
            {questions.map((view) => (
              <li key={view.question.id} data-testid={`question-${view.question.id}`} className="flex items-center gap-3">
                <span>{view.question.name}</span>
                <span data-testid={`version-badge-${view.question.id}`} className="rounded bg-secondary px-2 py-0.5 text-xs">
                  v{view.entry.latestversion}
                </span>
                <span className="text-sm text-muted-foreground">{view.latestVersion.questiontext}</span>
                <Button type="button" variant="outline" onClick={() => void editQuestion(view)}>{t('editNewVersion')}</Button>
                <Button type="button" variant="outline" onClick={() => void showVersions(view)}>{t('history')}</Button>
              </li>
            ))}
          </ul>
          {versionsOf && (
            <div data-testid="version-history">
              <h3 className="font-medium">{t('versionHistory')}</h3>
              <ul>
                {versionsOf.versions.map((v) => (
                  <li key={v.version}>v{v.version} — {v.questiontext}</li>
                ))}
              </ul>
            </div>
          )}
          {message && <p role="status">{message}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('newCategory')}</CardTitle></CardHeader>
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
        <CardHeader><CardTitle>{t('newTrueFalseQuestion')}</CardTitle></CardHeader>
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

/** Minimal attempt view: one usage of a simulated activity, with per-attempt state and pinned version. */
export function QuestionUsagePage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const [usage, setUsage] = useState<QuestionUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiJson<QuestionUsage>(`/api/v1/question-usages/${id}`)
      .then(setUsage)
      .catch(() => setError(t('attemptLoadFailed')));
  }, [id]);
  if (error) return <main className="p-8"><p role="alert">{error}</p></main>;
  if (!usage) return <main className="p-8">{t('attemptLoading')}</main>;
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('questionAttemptTitle', { component: usage.usage.component })}</CardTitle>
          <CardDescription>{t('usageState', { state: usage.state })}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {usage.attempts.map((a) => (
              <li key={a.id} data-testid={`attempt-${a.id}`}>
                {t('slotLine', { slot: a.slot })} <strong>{a.state}</strong>
                {a.fraction !== null ? ` ${t('fractionSuffix', { fraction: a.fraction })}` : ''}
                {a.questionversionid ? ` ${t('pinnedVersionSuffix', { versionId: a.questionversionid })}` : ''}
                <span className="block text-sm text-muted-foreground">
                  {t('stepsLine', { steps: a.steps.map((s) => s.state).join(' → ') || t('stepsNone') })}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm"><Link to="/questions">{t('backToQuestionBank')}</Link></p>
        </CardContent>
      </Card>
    </main>
  );
}
