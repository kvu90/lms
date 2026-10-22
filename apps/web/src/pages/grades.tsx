import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import type { Gradebook, GradebookCategoryView, GradeReport } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';

/**
 * Gradebook: category/item tree with the student's grades, letters at
 * display time, the teacher report (course totals per student) and a grade
 * entry form. All permission/hidden rules are enforced by the API; this page
 * only renders what it is given.
 */
export function GradebookPage() {
  const { id } = useParams();
  const courseId = Number(id);
  const [book, setBook] = useState<Gradebook | null>(null);
  const [report, setReport] = useState<GradeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [gradeItemId, setGradeItemId] = useState('');
  const [gradeUserId, setGradeUserId] = useState('');
  const [gradeValue, setGradeValue] = useState('');

  const reload = useCallback(async () => {
    const mine = await apiJson<Gradebook>(`/api/v1/courses/${courseId}/gradebook`);
    setBook(mine);
    const rep = await apiJson<GradeReport>(`/api/v1/courses/${courseId}/grades/report`).catch(() => null);
    setReport(rep);
  }, [courseId]);

  useEffect(() => {
    void reload().catch(() => setError('Could not load the gradebook (are you enrolled in this course?)'));
  }, [reload]);

  async function enterGrade(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson(`/api/v1/courses/grades/items/${gradeItemId}/grades`, {
        method: 'POST',
        body: JSON.stringify({ userid: Number(gradeUserId), rawgrade: Number(gradeValue) }),
      });
      setMessage('Grade saved and totals recalculated.');
      await reload();
    } catch {
      setMessage('Could not save the grade (grade:edit capability required).');
    }
  }

  function renderCategory(view: GradebookCategoryView, depth: number) {
    return (
      <div key={view.category.id} style={{ marginLeft: depth * 16 }}>
        <h3 className="font-medium">
          {view.category.fullname || 'Course'} <span className="text-sm text-muted-foreground">({view.category.aggregation})</span>
          {view.total?.grade?.finalgrade !== null && view.total?.grade
            ? <span data-testid={`cat-total-${view.category.id}`}> — Total: {view.total.grade.finalgrade} / {view.total.item.grademax}{view.total.grade.letter ? ` (${view.total.grade.letter})` : ''}</span>
            : null}
        </h3>
        <table className="w-full text-sm">
          <thead>
            <tr><th className="text-left">Item</th><th className="text-left">Grade</th><th className="text-left">Letter</th><th className="text-left">Max</th></tr>
          </thead>
          <tbody>
            {view.items.map(({ item, grade }) => (
              <tr key={item.id} data-testid={`grade-item-${item.id}`}>
                <td>{item.itemname}{item.extracredit ? ' (extra credit)' : ''}</td>
                <td>{grade?.finalgrade ?? '—'}</td>
                <td>{grade?.letter ?? ''}</td>
                <td>{item.grademax}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {view.children.map((child) => renderCategory(child, depth + 1))}
      </div>
    );
  }

  if (error) return <main className="p-8"><p role="alert">{error}</p></main>;
  if (!book) return <main className="p-8">Loading gradebook…</main>;

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Gradebook</CardTitle>
          <CardDescription>
            Course total: {book.courseTotal?.grade?.finalgrade ?? '—'}
            {book.courseTotal?.grade?.letter ? ` (${book.courseTotal.grade.letter})` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {book.categories.map((c) => renderCategory(c, 0))}
        </CardContent>
      </Card>

      {report && (
        <Card>
          <CardHeader><CardTitle>Class report</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead><tr><th className="text-left">Student (user id)</th><th className="text-left">Course total</th><th className="text-left">Letter</th></tr></thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.userId}><td>{row.userId}</td><td>{row.finalgrade ?? '—'}</td><td>{row.letter ?? ''}</td></tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Enter a grade (teachers)</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={(e) => void enterGrade(e)} className="space-y-3">
            <div>
              <Label htmlFor="grade-item">Grade item id</Label>
              <Input id="grade-item" value={gradeItemId} onChange={(e) => setGradeItemId(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="grade-user">Student user id</Label>
              <Input id="grade-user" value={gradeUserId} onChange={(e) => setGradeUserId(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="grade-value">Grade</Label>
              <Input id="grade-value" value={gradeValue} onChange={(e) => setGradeValue(e.target.value)} />
            </div>
            <Button type="submit">Save grade</Button>
            {message && <p role="status">{message}</p>}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
