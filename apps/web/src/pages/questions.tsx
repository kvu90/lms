import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { QuestionCategory, QuestionUsage, QuestionView } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';

/**
 * Question bank: categories, questions with their CURRENT version
 * badge, create/edit. Editing creates a new version server-side — the badge
 * increments and the version history shows every version (attempts already
 * started keep the version they pinned; that invariant is API-side).
 */
export function QuestionsPage() {
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

  useEffect(() => { void reload().catch(() => setMessage('Could not load the question bank')); }, [reload]);

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson('/api/v1/questions/categories', {
        method: 'POST', body: JSON.stringify({ name: catName, contextid: Number(contextId) }),
      });
      setCatName('');
      await reload();
    } catch { setMessage('Could not create the category (question:managecategory required).'); }
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
    } catch { setMessage('Could not create the question.'); }
  }

  async function editQuestion(view: QuestionView) {
    const newText = `${view.latestVersion.questiontext} (edited)`;
    try {
      const updated = await apiJson<QuestionView>(`/api/v1/questions/${view.question.id}`, {
        method: 'PATCH', body: JSON.stringify({ questiontext: newText }),
      });
      setMessage(`Saved as version ${updated.entry.latestversion}. Attempts already started keep their pinned version.`);
      await loadQuestions(view.question.category);
    } catch { setMessage('Could not edit the question.'); }
  }

  async function showVersions(view: QuestionView) {
    const versions = await apiJson<{ version: number; questiontext: string }[]>(`/api/v1/questions/${view.question.id}/versions`);
    setVersionsOf({ questionId: view.question.id, versions });
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Question bank</CardTitle>
          <CardDescription>Editing a question creates a new version; old versions are kept.</CardDescription>
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
                <Button type="button" variant="outline" onClick={() => void editQuestion(view)}>Edit (new version)</Button>
                <Button type="button" variant="outline" onClick={() => void showVersions(view)}>History</Button>
              </li>
            ))}
          </ul>
          {versionsOf && (
            <div data-testid="version-history">
              <h3 className="font-medium">Version history</h3>
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
        <CardHeader><CardTitle>New category</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={(e) => void createCategory(e)} className="space-y-3">
            <div>
              <Label htmlFor="qcat-name">Name</Label>
              <Input id="qcat-name" value={catName} onChange={(e) => setCatName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="qcat-context">Context id</Label>
              <Input id="qcat-context" value={contextId} onChange={(e) => setContextId(e.target.value)} />
            </div>
            <Button type="submit">Create category</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>New true/false question</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={(e) => void createQuestion(e)} className="space-y-3">
            <div>
              <Label htmlFor="q-name">Name</Label>
              <Input id="q-name" value={qName} onChange={(e) => setQName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="q-text">Question text</Label>
              <Input id="q-text" value={qText} onChange={(e) => setQText(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="q-correct">Correct answer is true</Label>
              <Input id="q-correct" value={qCorrect} onChange={(e) => setQCorrect(e.target.value)} />
            </div>
            <Button type="submit">Create question</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

/** Minimal attempt view: one usage of a simulated activity, with per-attempt state and pinned version. */
export function QuestionUsagePage() {
  const { id } = useParams();
  const [usage, setUsage] = useState<QuestionUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiJson<QuestionUsage>(`/api/v1/question-usages/${id}`)
      .then(setUsage)
      .catch(() => setError('Could not load this attempt'));
  }, [id]);
  if (error) return <main className="p-8"><p role="alert">{error}</p></main>;
  if (!usage) return <main className="p-8">Loading attempt…</main>;
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Question attempt — {usage.usage.component}</CardTitle>
          <CardDescription>Usage state: {usage.state}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {usage.attempts.map((a) => (
              <li key={a.id} data-testid={`attempt-${a.id}`}>
                Slot {a.slot}: <strong>{a.state}</strong>
                {a.fraction !== null ? ` — fraction ${a.fraction}` : ''}
                {a.questionversionid ? ` — pinned version id ${a.questionversionid}` : ''}
                <span className="block text-sm text-muted-foreground">
                  Steps: {a.steps.map((s) => s.state).join(' → ') || 'none'}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm"><Link to="/questions">Back to the question bank</Link></p>
        </CardContent>
      </Card>
    </main>
  );
}
