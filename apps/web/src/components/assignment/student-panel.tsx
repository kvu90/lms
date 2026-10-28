import { useEffect, useState } from 'react';
import type { AssignmentForUserView } from '@lms/contracts';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  currentUserQueryOptions,
  useDeleteSubmissionFile,
  useReopenSubmission,
  useSubmitSubmission,
  useUploadSubmissionFile,
} from '#lib/assignment-data';
import { FeedbackMessages } from './feedback-messages';
import { SubmissionFileView } from './submission-file';
import { dateLabel } from './shared';

/**
 * Phía học sinh: xem trạng thái bài nộp, tải tệp/ảnh vào bản nháp, chốt
 * nộp (sau hạn vẫn nộp được — máy chủ đánh dấu trễ), mở lại khi chưa bị
 * trả bài; sau khi giáo viên TRẢ bài thì thấy điểm/mức + lời phê + dấu
 * chấm trên bài của mình + kết quả rubric + hội thoại phản hồi.
 */
export function StudentPanel({ data, reload }: { data: AssignmentForUserView; reload: () => Promise<void> }) {
  const { t } = useTranslation('app');
  const { assignment, mySubmission: mine, rubric } = data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [chosenFile, setChosenFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const queryClient = useQueryClient();
  const uploadFileMutation = useUploadSubmissionFile();
  const deleteFileMutation = useDeleteSubmissionFile();
  const submitMutation = useSubmitSubmission();
  const reopenMutation = useReopenSubmission();

  useEffect(() => {
    void queryClient
      .fetchQuery(currentUserQueryOptions())
      .then((me) => setMeId(me.id))
      .catch(() => undefined);
  }, [queryClient]);

  const released = mine.grade !== null;
  const editable = !released && (mine.status === 'none' || mine.status === 'draft');

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await reload();
    } catch {
      setError(t('assignActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function uploadChosen() {
    if (!chosenFile) return;
    const fd = new FormData();
    fd.append('file', chosenFile);
    await act(async () => {
      await uploadFileMutation.mutateAsync({ assignmentId: assignment.id, formData: fd });
      setChosenFile(null);
      setFileInputKey((k) => k + 1);
    });
  }

  const evalByCriterion = new Map(mine.rubricEvaluations.map((e) => [e.criterionId, e]));

  return (
    <Card data-testid="assign-student-panel">
      <CardHeader>
        <CardTitle>{t('assignMySubmissionTitle')}</CardTitle>
        <CardDescription>
          {t(`assignStatus_${mine.status}`)}
          {mine.late ? (
            <>
              {' '}
              <Badge variant="destructive">{t('assignLateBadge')}</Badge>
            </>
          ) : null}
          {mine.submittedAt ? ` · ${t('assignSubmittedAtLine', { date: dateLabel(mine.submittedAt), number: mine.attemptNumber })}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <ErrorAlert variant="destructive">
            {error}
          </ErrorAlert>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {assignment.acceptedFileTypes
            ? t('assignAcceptedTypes', { types: assignment.acceptedFileTypes })
            : t('assignAllTypes')}{' '}
          · {t('assignMaxFilesLine', { count: assignment.maxFiles })}
        </p>
        {mine.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('assignNoFiles')}</p>
        ) : (
          <ul className="space-y-3">
            {mine.files.map((f) => (
              <SubmissionFileView key={f.fileId} file={f} annotations={released ? mine.annotations : []} />
            ))}
          </ul>
        )}
        {editable ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                key={fileInputKey}
                type="file"
                aria-label={t('assignUploadLabel')}
                className="max-w-xs"
                onChange={(e) => setChosenFile(e.target.files?.[0] ?? null)}
              />
              <Button type="button" variant="outline" disabled={busy || !chosenFile} onClick={() => void uploadChosen()}>
                {t('assignUploadButton')}
              </Button>
            </div>
            <ul className="space-y-1">
              {mine.files.map((f) => (
                <li key={f.fileId} className="flex items-center gap-2 text-sm">
                  <span>{f.fileName}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        deleteFileMutation.mutateAsync({ assignmentId: assignment.id, fileId: f.fileId }),
                      )
                    }
                  >
                    {t('assignRemoveFile')}
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              disabled={busy || mine.files.length === 0}
              onClick={() => void act(() => submitMutation.mutateAsync(assignment.id))}
            >
              {t('assignSubmitButton')}
            </Button>
          </div>
        ) : null}
        {mine.status === 'submitted' && !released ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => reopenMutation.mutateAsync(assignment.id))}
          >
            {t('assignReopenButton')}
          </Button>
        ) : null}

        {released && mine.grade ? (
          <div className="space-y-3" data-testid="assign-result">
            <h3 className="font-medium">{t('assignResultTitle')}</h3>
            {assignment.resultMode !== 'level' && mine.grade.grade !== null ? (
              <p className="text-lg font-semibold">{t('assignGradeLine', { grade: mine.grade.grade, max: assignment.grade })}</p>
            ) : null}
            {mine.grade.level ? (
              <p>
                <Badge>{t(`assignLevel_${mine.grade.level}`)}</Badge>
              </p>
            ) : null}
            {mine.grade.feedbackProgress ? (
              <p className="text-sm">
                <span className="font-medium">{t('assignFeedbackProgress')}: </span>
                {mine.grade.feedbackProgress}
              </p>
            ) : null}
            {mine.grade.feedbackStrengths ? (
              <p className="text-sm">
                <span className="font-medium">{t('assignFeedbackStrengths')}: </span>
                {mine.grade.feedbackStrengths}
              </p>
            ) : null}
            {mine.grade.feedbackWeaknesses ? (
              <p className="text-sm">
                <span className="font-medium">{t('assignFeedbackWeaknesses')}: </span>
                {mine.grade.feedbackWeaknesses}
              </p>
            ) : null}
            {mine.grade.feedback ? (
              <p className="text-sm">
                <span className="font-medium">{t('assignFeedbackGeneral')}: </span>
                {mine.grade.feedback}
              </p>
            ) : null}
            {rubric && mine.rubricEvaluations.length > 0 ? (
              <div>
                <h4 className="text-sm font-medium">{t('assignRubricResultsTitle')}</h4>
                <ul className="mt-1 space-y-1 text-sm">
                  {rubric.criteria.map((c) => {
                    const ev = evalByCriterion.get(c.id);
                    if (!ev) return null;
                    const level = c.levels.find((lv) => lv.id === ev.levelId);
                    return (
                      <li key={c.id}>
                        <span className="font-medium">{c.name}</span>
                        {': '}
                        {level ? `${level.label} (${level.score})` : ev.score !== null ? String(ev.score) : '—'}
                        {ev.note ? ` — ${ev.note}` : ''}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {meId ? (
              <FeedbackMessages assignmentId={assignment.id} userId={meId} messages={mine.feedbackMessages} onPosted={reload} />
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
