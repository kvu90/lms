import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { QuizAttemptSummary, QuizView } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';

/** Một câu essay đang chờ chấm tay (hàng đợi của giáo viên). */
interface NeedsGradingItem {
  quizAttemptId: string;
  userId: string;
  attemptNumber: number;
  questionAttemptId: string;
  slot: number;
  questionId: string;
  maxMark: number;
  response: string | null;
}

/** Hình dạng trả về của GET /quizzes/:id/results. */
interface QuizResults {
  quiz: QuizView;
  attempts: QuizAttemptSummary[];
  gradesByUser: { userId: string; grade: number | null }[];
  needsGrading: NeedsGradingItem[];
}

/**
 * Trang kết quả quiz cho giáo viên: điểm bài hiện tại của từng học
 * sinh, mọi lượt làm, và hàng đợi chấm tay essay — chấm ngay tại trang,
 * điểm bài được API tính lại và ghi sổ sau mỗi lần chấm.
 */
export function QuizResultsPage() {
  const { t } = useTranslation('app');
  const { id: courseId, quizId } = useParams();
  const [data, setData] = useState<QuizResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const fresh = await apiJson<QuizResults>(`/api/v1/quizzes/${quizId}/results`);
    setData(fresh);
  }, [quizId]);

  useEffect(() => {
    void reload().catch(() => setError(t('quizResultsLoadFailed')));
  }, [reload, t]);

  async function grade(item: NeedsGradingItem) {
    setActionError(null);
    setBusy(true);
    try {
      await apiJson(`/api/v1/quiz-attempts/${item.quizAttemptId}/questions/${item.questionAttemptId}/grade`, {
        method: 'POST',
        body: JSON.stringify({
          mark: Number(marks[item.questionAttemptId] ?? ''),
          ...(comments[item.questionAttemptId] ? { comment: comments[item.questionAttemptId] } : {}),
        }),
      });
      await reload();
    } catch {
      setActionError(t('quizGradeFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <p role="alert">{error}</p>
      </main>
    );
  if (!data)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">{t('quizResultsLoading')}</main>
    );

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('quizResultsTitle', { name: data.quiz.name })}</CardTitle>
          <CardDescription>{t('quizResultsDescription', { method: t(`quizGradeMethod_${data.quiz.gradeMethod}`) })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {actionError ? <p role="alert">{actionError}</p> : null}
          <div>
            <h3 className="text-sm font-medium">{t('quizResultsGradesHeading')}</h3>
            <ul className="text-sm">
              {data.gradesByUser.map((g) => (
                <li key={g.userId} data-testid={`grade-user-${g.userId}`}>
                  {g.userId}: {g.grade === null ? t('quizResultsNoGrade') : `${g.grade}/${data.quiz.grade}`}
                </li>
              ))}
              {data.gradesByUser.length === 0 ? <li className="text-muted-foreground">{t('quizResultsNoAttempts')}</li> : null}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-medium">{t('quizResultsAttemptsHeading')}</h3>
            <ul className="text-sm">
              {data.attempts.map((a) => (
                <li key={a.id} data-testid={`result-attempt-${a.id}`}>
                  {a.userId} — {t('quizAttemptLine', { number: a.attemptNumber, state: t(`quizAttemptState_${a.state}`) })}
                  {a.sumGrades !== null ? ` — ${a.sumGrades}/${data.quiz.sumGrades}` : ''}{' '}
                  <Link to={`/quiz-attempts/${a.id}`}>{t('quizViewAttempt')}</Link>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('quizGradingQueueTitle')}</CardTitle>
          <CardDescription>{t('quizGradingQueueDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.needsGrading.map((item) => (
            <div key={item.questionAttemptId} data-testid={`grading-${item.questionAttemptId}`} className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">
                {t('quizGradingLine', { slot: item.slot, max: item.maxMark, user: item.userId, number: item.attemptNumber })}
              </p>
              <p className="text-sm whitespace-pre-wrap">{item.response ?? ''}</p>
              <div className="flex flex-wrap gap-2">
                <div className="space-y-1">
                  <Label htmlFor={`mark-${item.questionAttemptId}`}>{t('quizGradingMark')}</Label>
                  <Input
                    id={`mark-${item.questionAttemptId}`}
                    className="w-24"
                    value={marks[item.questionAttemptId] ?? ''}
                    onChange={(e) => setMarks((prev) => ({ ...prev, [item.questionAttemptId]: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`comment-${item.questionAttemptId}`}>{t('quizGradingComment')}</Label>
                  <Input
                    id={`comment-${item.questionAttemptId}`}
                    value={comments[item.questionAttemptId] ?? ''}
                    onChange={(e) => setComments((prev) => ({ ...prev, [item.questionAttemptId]: e.target.value }))}
                  />
                </div>
                <div className="flex items-end">
                  <Button type="button" disabled={busy} onClick={() => void grade(item)}>
                    {t('quizGradingSubmit')}
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {data.needsGrading.length === 0 ? <p className="text-sm text-muted-foreground">{t('quizGradingQueueEmpty')}</p> : null}
        </CardContent>
      </Card>

      <p className="text-sm">
        <Link to={`/courses/${courseId}/quizzes/${quizId}`}>{t('quizBackToQuiz')}</Link>
      </p>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default function QuizResultsRoute() {
  return <QuizResultsPage />;
}
