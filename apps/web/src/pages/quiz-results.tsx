import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { QuizAttemptSummary, QuizView } from '@lms/contracts';
import { Alert, AlertDescription, AlertTitle } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
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

/** Một học sinh làm chưa trọn vẹn một câu trong thống kê câu sai. */
interface QuestionWrongStudent {
  userId: string;
  displayName: string;
  quizAttemptId: string;
  attemptNumber: number;
  fraction: number;
  mark: number;
}

/**
 * Thống kê một slot trong đề (API gộp theo vị trí câu, chỉ tính lượt
 * đã nộp): câu sai nhiều nhất được API xếp lên đầu. questionName null
 * khi slot rút câu ngẫu nhiên (mỗi lượt một câu khác nhau).
 */
interface QuestionStat {
  slot: number;
  questionId: string | null;
  questionName: string | null;
  maxMark: number;
  attemptsCount: number;
  gradedCount: number;
  pendingCount: number;
  wrongCount: number;
  fullyWrongCount: number;
  wrongStudents: QuestionWrongStudent[];
}

/** Hình dạng trả về của GET /quizzes/:id/results. */
interface QuizResults {
  quiz: QuizView;
  attempts: QuizAttemptSummary[];
  gradesByUser: { userId: string; grade: number | null }[];
  needsGrading: NeedsGradingItem[];
  questionStats: QuestionStat[];
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
      <PageShell width="medium">
        <PageHeader title={t('quizResultsHeading')} />
        <Alert variant="destructive">
          <AlertTitle>{t('quizResultsHeading')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setError(null);
              void reload().catch(() => setError(t('quizResultsLoadFailed')));
            }}
          >
            {t('retry')}
          </Button>
        </div>
      </PageShell>
    );
  if (!data)
    return (
      <PageShell width="medium">
        <PageHeader title={t('quizResultsHeading')} />
        <div className="space-y-2" aria-label={t('quizResultsLoading')}>
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="h-4 w-64" />
        </div>
      </PageShell>
    );

  return (
    <PageShell width="medium">
      <PageHeader
        title={t('quizResultsTitle', { name: data.quiz.name })}
        description={t('quizResultsDescription', { method: t(`quizGradeMethod_${data.quiz.gradeMethod}`) })}
      />
      <Card>
        <CardContent className="space-y-4">
          {actionError ? (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}
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
                  {a.makeup ? (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">{t('quizMakeupBadge')}</span>
                  ) : null}
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
          {data.needsGrading.length === 0 ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{t('quizGradingQueueEmpty')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('quizStatsTitle')}</CardTitle>
          <CardDescription>{t('quizStatsDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.questionStats.map((stat) => (
            <div key={stat.slot} data-testid={`question-stat-${stat.slot}`} className="space-y-1">
              <p className="text-sm font-medium">
                {t('quizStatsSlotLine', { slot: stat.slot, max: stat.maxMark })}
                {stat.questionName ? `: ${stat.questionName}` : ` (${t('quizStatsRandomSlot')})`}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('quizStatsWrongOf', { wrong: stat.wrongCount, graded: stat.gradedCount })}
                {stat.fullyWrongCount > 0 && stat.fullyWrongCount !== stat.wrongCount
                  ? ` · ${t('quizStatsFullyWrongPart', { count: stat.fullyWrongCount })}`
                  : ''}
                {stat.pendingCount > 0 ? ` · ${t('quizStatsPendingPart', { count: stat.pendingCount })}` : ''}
              </p>
              {stat.wrongStudents.length > 0 ? (
                <ul className="text-sm">
                  {stat.wrongStudents.map((w) => (
                    <li key={`${w.quizAttemptId}`} data-testid={`question-stat-${stat.slot}-wrong-${w.userId}`}>
                      {t('quizStatsStudentLine', { name: w.displayName, mark: w.mark, max: stat.maxMark })}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('quizStatsNoWrong')}</p>
              )}
            </div>
          ))}
          {data.questionStats.length === 0 ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{t('quizStatsEmpty')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null}
        </CardContent>
      </Card>

      <p className="text-sm">
        <Link to={`/courses/${courseId}/quizzes/${quizId}`}>{t('quizBackToQuiz')}</Link>
      </p>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default function QuizResultsRoute() {
  return <QuizResultsPage />;
}

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Kết quả bài kiểm tra');
}
