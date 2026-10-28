import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { PageSkeleton } from '#components/page-skeleton';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import {
  quizResultsQueryOptions,
  useGradeQuizQuestion,
  useQuizResults,
  type NeedsGradingItem,
} from '#lib/quiz-results-data';
import { queryClient } from '#lib/query-client';

/**
 * Trang kết quả quiz cho giáo viên: điểm bài hiện tại của từng học
 * sinh, mọi lượt làm, và hàng đợi chấm tay essay — chấm ngay tại trang,
 * điểm bài được API tính lại và ghi sổ sau mỗi lần chấm.
 */
export function QuizResultsPage() {
  const { t } = useTranslation('app');
  const { id: courseId, pinId: quizId } = useParams();
  // Dữ liệu trang qua TanStack (F-01 đợt 1): clientLoader đã prefetch
  // cùng khoá trước khi mount; chấm tay qua mutation — thành công tự
  // invalidate query kết quả thay cho reload thủ công. Trạng thái chờ
  // lần tải đầu trên isPending của query với skeleton sẵn có (F-14).
  const resultsQuery = useQuizResults(quizId);
  const data = resultsQuery.data ?? null;
  const gradeMutation = useGradeQuizQuestion();
  const busy = gradeMutation.isPending;
  const [actionError, setActionError] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});

  async function grade(item: NeedsGradingItem) {
    setActionError(null);
    try {
      await gradeMutation.mutateAsync({
        quizId: quizId ?? '',
        quizAttemptId: item.quizAttemptId,
        questionAttemptId: item.questionAttemptId,
        mark: Number(marks[item.questionAttemptId] ?? ''),
        comment: comments[item.questionAttemptId] || undefined,
      });
    } catch {
      setActionError(t('quizGradeFailed'));
    }
  }

  if (resultsQuery.isError && !resultsQuery.isFetching && !data)
    return (
      <PageShell width="medium">
        <PageHeader title={t('quizResultsHeading')} />
        <ErrorAlert variant="destructive" title={t('quizResultsHeading')}>
          {t('quizResultsLoadFailed')}
        </ErrorAlert>
        <div>
          <Button type="button" variant="outline" onClick={() => void resultsQuery.refetch()}>
            {t('retry')}
          </Button>
        </div>
      </PageShell>
    );
  if (resultsQuery.isPending || !data)
    return (
      <PageShell width="medium">
        <PageHeader title={t('quizResultsHeading')} />
        <PageSkeleton label={t('quizResultsLoading')} rows={['h-4 w-56', 'h-4 w-80', 'h-4 w-64']} />
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
            <ErrorAlert variant="destructive">
              {actionError}
            </ErrorAlert>
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
        <Link to={`/courses/${courseId}/exams/${quizId}`}>{t('quizBackToQuiz')}</Link>
      </p>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default function QuizResultsRoute() {
  return <QuizResultsPage />;
}

/**
 * clientLoader (F-01 đợt 1 + bổ sung clientLoader, rà soát #133):
 * prefetch query kết quả vào QueryClient singleton dùng chung, đúng
 * khoá factory, trước khi component mount.
 */
export async function clientLoader({ params }: { params: Record<string, string | undefined> }) {
  if (params.pinId) {
    await queryClient.prefetchQuery(quizResultsQueryOptions(params.pinId));
  }
  return null;
}

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Kết quả bài kiểm tra');
}
