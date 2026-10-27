import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  AssignSubmissionDetail,
  AssignSubmissionSummary,
  AssignmentForUserView,
  TeacherCommentBankEntryView,
} from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Skeleton } from '@lms/ui/components/skeleton';
import { Textarea } from '@lms/ui/components/textarea';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  commentBankQueryOptions,
  submissionDetailQueryOptions,
  useAddSubmissionAnnotation,
  useCreateCommentBankEntry,
  useDeleteSubmissionAnnotation,
  useGradeSubmission,
  useReleaseSubmission,
} from '#lib/assignment-data';
import { FeedbackMessages } from './feedback-messages';
import { ANNOTATION_KINDS, SubmissionFileView, type AnnotationKind } from './submission-file';
import { dateLabel, selectClass } from './shared';

const BANK_CATEGORIES = ['strengths', 'weaknesses', 'improvement', 'progress', 'general'] as const;

/** Bề mặt chấm một bài nộp: xem tệp + thả dấu vector + gói chấm nháp + trả bài. */
export function GradingPanel({
  assignmentId,
  resultMode,
  gradeMax,
  rubric,
  summary,
  onChanged,
}: {
  assignmentId: string;
  resultMode: string;
  gradeMax: number;
  rubric: AssignmentForUserView['rubric'];
  summary: AssignSubmissionSummary;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation('app');
  const [detail, setDetail] = useState<AssignSubmissionDetail | null>(null);
  const [gradeInput, setGradeInput] = useState('');
  const [levelInput, setLevelInput] = useState('');
  const [feedback, setFeedback] = useState('');
  const [feedbackProgress, setFeedbackProgress] = useState('');
  const [feedbackStrengths, setFeedbackStrengths] = useState('');
  const [feedbackWeaknesses, setFeedbackWeaknesses] = useState('');
  const [evaluations, setEvaluations] = useState<Record<string, { levelId: string; score: string; note: string }>>({});
  const [annKind, setAnnKind] = useState<AnnotationKind>('correct');
  const [annText, setAnnText] = useState('');
  const [bank, setBank] = useState<TeacherCommentBankEntryView[]>([]);
  const [bankDraft, setBankDraft] = useState('');
  const [bankCategory, setBankCategory] = useState<string>('general');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const gradeMutation = useGradeSubmission();
  const addAnnotationMutation = useAddSubmissionAnnotation();
  const deleteAnnotationMutation = useDeleteSubmissionAnnotation();
  const releaseMutation = useReleaseSubmission();
  const createBankEntryMutation = useCreateCommentBankEntry();

  const loadDetail = useCallback(async () => {
    const fresh = await queryClient.fetchQuery(submissionDetailQueryOptions(assignmentId, summary.userId));
    setDetail(fresh);
    setGradeInput(fresh.grade?.grade !== null && fresh.grade?.grade !== undefined ? String(fresh.grade.grade) : '');
    setLevelInput(fresh.grade?.level ?? '');
    setFeedback(fresh.grade?.feedback ?? '');
    setFeedbackProgress(fresh.grade?.feedbackProgress ?? '');
    setFeedbackStrengths(fresh.grade?.feedbackStrengths ?? '');
    setFeedbackWeaknesses(fresh.grade?.feedbackWeaknesses ?? '');
    setEvaluations(
      Object.fromEntries(
        fresh.rubricEvaluations.map((e) => [
          e.criterionId,
          { levelId: e.levelId ?? '', score: e.score !== null ? String(e.score) : '', note: e.note ?? '' },
        ]),
      ),
    );
  }, [assignmentId, queryClient, summary.userId]);

  useEffect(() => {
    void loadDetail().catch(() => setError(t('assignLoadFailed')));
  }, [loadDetail, t]);

  useEffect(() => {
    void queryClient
      .fetchQuery(commentBankQueryOptions())
      .then(setBank)
      .catch(() => undefined);
  }, [queryClient]);

  async function act(run: () => Promise<unknown>, doneNotice?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      await loadDetail();
      await onChanged();
      if (doneNotice) setNotice(doneNotice);
    } catch {
      setError(t('assignActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function saveGrade(event: FormEvent) {
    event.preventDefault();
    const evalPayload = (rubric?.criteria ?? [])
      .map((c) => {
        const ev = evaluations[c.id];
        if (!ev) return null;
        if (c.mode === 'levels' && !ev.levelId && !ev.note) return null;
        if (c.mode === 'score' && !ev.score && !ev.note) return null;
        return {
          criterionId: c.id,
          ...(c.mode === 'levels' ? { levelId: ev.levelId || null } : { score: ev.score ? Number(ev.score) : null }),
          note: ev.note || null,
        };
      })
      .filter((e) => e !== null);
    await act(
      () =>
        gradeMutation.mutateAsync({
          assignmentId,
          userId: summary.userId,
          body: {
            ...(resultMode === 'level'
              ? { level: levelInput || null }
              : gradeInput.trim()
                ? { grade: Number(gradeInput) }
                : {}),
            feedback,
            feedbackProgress: feedbackProgress || null,
            feedbackStrengths: feedbackStrengths || null,
            feedbackWeaknesses: feedbackWeaknesses || null,
            ...(evalPayload.length ? { evaluations: evalPayload } : {}),
          },
        }),
      t('assignGradeSaved'),
    );
  }

  function placeAnnotation(fileId: string, point: { x: number; y: number }, points?: { x: number; y: number }[]) {
    const isDraw = points !== undefined;
    void act(() =>
      addAnnotationMutation.mutateAsync({
        assignmentId,
        userId: summary.userId,
        body: {
          fileId,
          page: 1,
          x: point.x,
          y: point.y,
          kind: isDraw ? 'draw' : annKind,
          text: !isDraw && annText.trim() ? annText.trim() : null,
          ...(isDraw ? { points } : {}),
        },
      }),
    );
  }

  if (!detail) return <Skeleton className="h-40 w-full" />;

  const canGradeThis = detail.status === 'submitted' || detail.status === 'graded';

  return (
    <div className="space-y-4" data-testid="assign-grading-panel">
      <h3 className="font-medium">
        {t('assignGradingTitle', { name: summary.displayName })}
        {detail.late ? (
          <>
            {' '}
            <Badge variant="destructive">{t('assignLateBadge')}</Badge>
          </>
        ) : null}
      </h3>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {detail.files.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('assignNoFiles')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="ann-kind">{t('assignAnnotationToolLabel')}</Label>
            <select id="ann-kind" className={selectClass} value={annKind} onChange={(e) => setAnnKind(e.target.value as AnnotationKind)}>
              {ANNOTATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`assignKind_${k}`)}
                </option>
              ))}
            </select>
            <Input
              aria-label={t('assignAnnotationTextLabel')}
              value={annText}
              onChange={(e) => setAnnText(e.target.value)}
              placeholder={t('assignAnnotationTextPlaceholder')}
              className="max-w-xs"
            />
          </div>
          <ul className="space-y-3">
            {detail.files.map((f) => (
              <SubmissionFileView key={f.fileId} file={f} annotations={detail.annotations} onPlace={placeAnnotation} />
            ))}
          </ul>
          {detail.annotations.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {detail.annotations.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <span>
                    {t(`assignKind_${a.kind}`)}
                    {a.text ? `: ${a.text}` : ''}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        deleteAnnotationMutation.mutateAsync({
                          assignmentId,
                          userId: summary.userId,
                          annotationId: a.id,
                        }),
                      )
                    }
                  >
                    {t('assignDeleteAnnotation')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      {canGradeThis ? (
        <form onSubmit={(e) => void saveGrade(e)} className="space-y-3">
          {resultMode === 'level' ? (
            <div className="space-y-1">
              <Label htmlFor="grade-level">{t('assignLevelInput')}</Label>
              <select id="grade-level" className={selectClass} value={levelInput} onChange={(e) => setLevelInput(e.target.value)}>
                <option value="">—</option>
                <option value="dat">{t('assignLevel_dat')}</option>
                <option value="chua_dat">{t('assignLevel_chua_dat')}</option>
              </select>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="grade-value">{t('assignGradeInput', { max: gradeMax })}</Label>
              <Input
                id="grade-value"
                type="number"
                min={0}
                max={gradeMax}
                step="0.25"
                value={gradeInput}
                onChange={(e) => setGradeInput(e.target.value)}
              />
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="fb-progress">{t('assignFeedbackProgress')}</Label>
              <Textarea id="fb-progress" value={feedbackProgress} onChange={(e) => setFeedbackProgress(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fb-strengths">{t('assignFeedbackStrengths')}</Label>
              <Textarea id="fb-strengths" value={feedbackStrengths} onChange={(e) => setFeedbackStrengths(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fb-weaknesses">{t('assignFeedbackWeaknesses')}</Label>
              <Textarea id="fb-weaknesses" value={feedbackWeaknesses} onChange={(e) => setFeedbackWeaknesses(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="fb-general">{t('assignFeedbackGeneral')}</Label>
            <Textarea id="fb-general" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          </div>
          {bank.length > 0 ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('assignCommentBankTitle')}</p>
              <ul className="flex flex-wrap gap-2">
                {bank.map((entry) => (
                  <li key={entry.id}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      title={entry.text}
                      onClick={() => setFeedback((prev) => (prev ? `${prev}\n${entry.text}` : entry.text))}
                    >
                      {t('assignCommentBankInsert')}: {entry.text.length > 24 ? `${entry.text.slice(0, 24)}…` : entry.text}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t('assignCommentBankNewLabel')}
              value={bankDraft}
              onChange={(e) => setBankDraft(e.target.value)}
              placeholder={t('assignCommentBankPlaceholder')}
              className="max-w-xs"
            />
            <select aria-label={t('assignCommentBankCategoryLabel')} className={selectClass} value={bankCategory} onChange={(e) => setBankCategory(e.target.value)}>
              {BANK_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`assignBankCat_${c}`)}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !bankDraft.trim()}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    const created = await createBankEntryMutation.mutateAsync({
                      category: bankCategory,
                      text: bankDraft.trim(),
                    });
                    setBank((prev) => [...prev, created]);
                    setBankDraft('');
                  } catch {
                    setError(t('assignActionFailed'));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              {t('assignCommentBankAdd')}
            </Button>
          </div>
          {rubric && rubric.criteria.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('assignRubricResultsTitle')}</p>
              {rubric.criteria.map((c) => {
                const ev = evaluations[c.id] ?? { levelId: '', score: '', note: '' };
                const setEv = (patch: Partial<typeof ev>) =>
                  setEvaluations((prev) => ({ ...prev, [c.id]: { ...(prev[c.id] ?? ev), ...patch } }));
                return (
                  <div key={c.id} className="flex flex-wrap items-end gap-2 rounded border p-2">
                    <span className="min-w-40 text-sm font-medium">{c.name}</span>
                    {c.mode === 'levels' ? (
                      <select
                        aria-label={c.name}
                        className={selectClass}
                        value={ev.levelId}
                        onChange={(e) => setEv({ levelId: e.target.value })}
                      >
                        <option value="">—</option>
                        {c.levels.map((lv) => (
                          <option key={lv.id} value={lv.id}>
                            {lv.label} ({lv.score})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        aria-label={c.name}
                        type="number"
                        min={0}
                        max={c.maxScore ?? undefined}
                        step="0.25"
                        value={ev.score}
                        onChange={(e) => setEv({ score: e.target.value })}
                        className="max-w-28"
                      />
                    )}
                    <Input
                      aria-label={t('assignRubricEvalNote')}
                      value={ev.note}
                      onChange={(e) => setEv({ note: e.target.value })}
                      placeholder={t('assignRubricEvalNote')}
                      className="max-w-xs"
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {t('assignSaveGrade')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || detail.grade?.status === 'released'}
              onClick={() =>
                void act(
                  () => releaseMutation.mutateAsync({ assignmentId, userId: summary.userId }),
                  t('assignReleased'),
                )
              }
            >
              {t('assignReleaseOne')}
            </Button>
          </div>
          {detail.grade?.status === 'released' ? <p className="text-sm text-muted-foreground">{t('assignReleased')}</p> : null}
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{t('assignNotSubmittedYet')}</p>
      )}

      {detail.revisions.length > 0 ? (
        <div>
          <h4 className="text-sm font-medium">{t('assignRevisionsTitle')}</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {detail.revisions.map((r) => (
              <li key={r.id}>
                {dateLabel(r.createdAt)}: {r.previousGrade ?? '—'} → {r.newGrade ?? '—'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail.grade?.status === 'released' ? (
        <FeedbackMessages assignmentId={assignmentId} userId={summary.userId} messages={detail.feedbackMessages} onPosted={loadDetail} />
      ) : null}
    </div>
  );
}
