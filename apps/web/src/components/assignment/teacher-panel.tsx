import { useCallback, useState } from 'react';
import type { AssignmentForUserView } from '@lms/contracts';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { assignmentSubmissionsQueryOptions, useReleaseSubmissionsBatch } from '#lib/assignment-data';
import { queryKeys } from '#lib/query-keys';
import { GradingPanel } from './grading-panel';

/**
 * Phía giáo viên: danh sách bài nộp cả lớp + trả bài theo đợt + mở
 * bề mặt chấm từng em. Danh sách bài nộp là dữ kiện máy chủ nên đọc
 * trực tiếp từ cache TanStack qua `assignmentSubmissionsQueryOptions`
 * (CN-13, issue #493) — các đột biến chấm/trả bài tự invalidate
 * khoá này ở tầng dữ kiện; `loadSummaries` chỉ còn là lần nạp lại
 * tường minh cho bề mặt chấm gọi sau mỗi hành động.
 */
export function TeacherPanel({ data }: { data: AssignmentForUserView }) {
  const { t } = useTranslation('app');
  const { assignment, rubric } = data;
  const summariesQuery = useQuery(assignmentSubmissionsQueryOptions(assignment.id));
  const summaries = summariesQuery.data ?? [];
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const releaseBatchMutation = useReleaseSubmissionsBatch();

  /** Lỗi nạp danh sách lần đầu (chưa từng có dữ kiện trong cache) — lỗi hành động vẫn qua state `error`. */
  const loadError = summariesQuery.isError && !summariesQuery.data ? t('assignLoadFailed') : null;
  const shownError = error ?? loadError;

  /** Nạp lại danh sách bài nộp từ server (bề mặt chấm gọi sau mỗi hành động ghi). */
  const loadSummaries = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: queryKeys.assignmentSubmissions(assignment.id) });
  }, [assignment.id, queryClient]);

  async function releaseBatch() {
    setBusy(true);
    setError(null);
    setBatchResult(null);
    try {
      const res = await releaseBatchMutation.mutateAsync(assignment.id);
      setBatchResult(t('assignReleaseBatchResult', { count: res.releasedCount, skipped: res.skippedUserIds.length }));
      await loadSummaries();
    } catch {
      setError(t('assignActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  const selected = summaries.find((s) => s.userId === selectedUserId) ?? null;

  return (
    <Card data-testid="assign-teacher-panel">
      <CardHeader>
        <CardTitle>{t('assignSubmissionsTitle')}</CardTitle>
        <CardDescription>{t('assignSubmissionsHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {shownError ? (
          <ErrorAlert variant="destructive">
            {shownError}
          </ErrorAlert>
        ) : null}
        {data.canGrade ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={busy} onClick={() => void releaseBatch()}>
              {t('assignReleaseBatch')}
            </Button>
            {batchResult ? <span className="text-sm">{batchResult}</span> : null}
          </div>
        ) : null}
        {summaries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('assignSubmissionsEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {summaries.map((s) => (
              <li key={s.userId} className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm">
                <span className="font-medium">{s.displayName}</span>
                <Badge variant={s.status === 'none' ? 'secondary' : 'default'}>{t(`assignStatus_${s.status}`)}</Badge>
                {s.late ? <Badge variant="destructive">{t('assignLateBadge')}</Badge> : null}
                <span className="text-muted-foreground">{t('assignFileCount', { count: s.fileCount })}</span>
                <Badge variant="outline">{t(`assignGradeStatus_${s.gradeStatus}`)}</Badge>
                {s.grade !== null ? <span>{t('assignGradeLine', { grade: s.grade, max: assignment.grade })}</span> : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setSelectedUserId(selectedUserId === s.userId ? null : s.userId)}
                >
                  {t('assignGradeAction')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {selected ? (
          <GradingPanel
            key={selected.userId}
            assignmentId={assignment.id}
            resultMode={assignment.resultMode}
            gradeMax={assignment.grade}
            rubric={rubric}
            summary={selected}
            onChanged={loadSummaries}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
