import { useCallback, useEffect, useState } from 'react';
import type { AssignSubmissionSummary, AssignmentForUserView } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { useTranslation } from 'react-i18next';
import { apiJson } from '#lib/api';
import { GradingPanel } from './grading-panel';

/** Phía giáo viên: danh sách bài nộp cả lớp + trả bài theo đợt + mở bề mặt chấm từng em. */
export function TeacherPanel({ data }: { data: AssignmentForUserView }) {
  const { t } = useTranslation('app');
  const { assignment, rubric } = data;
  const [summaries, setSummaries] = useState<AssignSubmissionSummary[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<string | null>(null);

  const loadSummaries = useCallback(async () => {
    setSummaries(await apiJson<AssignSubmissionSummary[]>(`/api/v1/assignments/${assignment.id}/submissions`));
  }, [assignment.id]);

  useEffect(() => {
    void loadSummaries().catch(() => setError(t('assignLoadFailed')));
  }, [loadSummaries, t]);

  async function releaseBatch() {
    setBusy(true);
    setError(null);
    setBatchResult(null);
    try {
      const res = await apiJson<{ releasedCount: number; skippedUserIds: string[] }>(
        `/api/v1/assignments/${assignment.id}/release-batch`,
        { method: 'POST', body: JSON.stringify({}) },
      );
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
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
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
