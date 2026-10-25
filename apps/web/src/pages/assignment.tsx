import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type PointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type {
  AssignAnnotationView,
  AssignRubricCriterionView,
  AssignSubmissionDetail,
  AssignSubmissionFileView,
  AssignSubmissionSummary,
  AssignmentForUserView,
  TeacherCommentBankEntryView,
} from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Skeleton } from '@lms/ui/components/skeleton';
import { Textarea } from '@lms/ui/components/textarea';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiJson } from '#lib/api';

const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';

const ANNOTATION_KINDS = ['correct', 'incorrect', 'note', 'highlight', 'frame', 'draw'] as const;
type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

const BANK_CATEGORIES = ['strengths', 'weaknesses', 'improvement', 'progress', 'general'] as const;

/** Định dạng mốc thời gian ISO cho người đọc (theo ngôn ngữ trình duyệt). */
function dateLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Chuyển ISO sang giá trị của input datetime-local. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(file: AssignSubmissionFileView): boolean {
  return (file.mimeType ?? '').startsWith('image/');
}

const KIND_MARK: Record<string, { symbol: string; className: string }> = {
  correct: { symbol: '✓', className: 'bg-green-600 text-white' },
  incorrect: { symbol: '✗', className: 'bg-red-600 text-white' },
  note: { symbol: '✎', className: 'bg-amber-500 text-white' },
  highlight: { symbol: '', className: 'bg-yellow-300/50 border border-yellow-500' },
  frame: { symbol: '', className: 'border-2 border-sky-600 bg-sky-400/10' },
  draw: { symbol: '', className: '' },
};

/**
 * Một tệp của bài nộp: ảnh hiển thị trực tiếp kèm lớp dấu chấm vector
 * đè lên (toạ độ % neo theo khổ ảnh — ảnh gốc không bị đốt dấu); tệp
 * khác hiện dạng liên kết mở URL đã ký. Ở bề mặt chấm, bấm vào ảnh để
 * thả dấu (hoặc kéo để vẽ khi đang chọn nét vẽ).
 */
function SubmissionFileView({
  file,
  annotations,
  onPlace,
}: {
  file: AssignSubmissionFileView;
  annotations: AssignAnnotationView[];
  onPlace?: (fileId: string, point: { x: number; y: number }, points?: { x: number; y: number }[]) => void;
}) {
  const { t } = useTranslation('app');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef<{ x: number; y: number }[] | null>(null);
  const [preview, setPreview] = useState<{ x: number; y: number }[]>([]);
  const own = annotations.filter((a) => a.fileId === file.fileId);

  function pointOf(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  }

  function handleClick(event: MouseEvent) {
    if (!onPlace || drawingRef.current) return;
    const p = pointOf(event);
    if (p) onPlace(file.fileId, p);
  }
  function handlePointerDown(event: PointerEvent) {
    if (!onPlace) return;
    const p = pointOf(event);
    if (p) {
      drawingRef.current = [p];
      setPreview([p]);
    }
  }
  function handlePointerMove(event: PointerEvent) {
    if (!drawingRef.current) return;
    const p = pointOf(event);
    if (!p) return;
    const last = drawingRef.current[drawingRef.current.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
    drawingRef.current = [...drawingRef.current, p];
    setPreview(drawingRef.current);
  }
  function handlePointerUp() {
    const pts = drawingRef.current;
    drawingRef.current = null;
    setPreview([]);
    if (!onPlace || !pts || pts.length === 0) return;
    // Kéo thật sự (≥2 điểm cách nhau) = nét vẽ; còn lại là một cú bấm thả dấu.
    if (pts.length >= 2) onPlace(file.fileId, pts[0]!, pts);
  }

  if (!isImage(file)) {
    return (
      <li className="rounded border p-3" data-testid={`assign-file-${file.fileId}`}>
        <a href={file.signedUrl} target="_blank" rel="noreferrer" className="font-medium underline">
          {file.fileName}
        </a>{' '}
        <span className="text-sm text-muted-foreground">({fileSizeLabel(file.fileSize)})</span>
        {own.length > 0 ? (
          <ul className="mt-1 list-disc pl-5 text-sm">
            {own.map((a) => (
              <li key={a.id}>
                {t(`assignKind_${a.kind}`)}
                {a.text ? `: ${a.text}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </li>
    );
  }
  return (
    <li className="space-y-1" data-testid={`assign-file-${file.fileId}`}>
      <div
        ref={wrapRef}
        className="relative inline-block max-w-full"
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <img src={file.signedUrl} alt={file.fileName} className="max-h-[70vh] w-auto max-w-full rounded border" draggable={false} />
        {own.map((a) => {
          if (a.kind === 'draw' && a.points && a.points.length > 1) {
            return (
              <svg
                key={a.id}
                className="pointer-events-none absolute inset-0 h-full w-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-label={t('assignKind_draw')}
              >
                <polyline
                  points={a.points.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={a.color ?? '#dc2626'}
                  strokeWidth={0.8}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            );
          }
          const mark = KIND_MARK[a.kind] ?? KIND_MARK.note!;
          const sized = a.kind === 'highlight' || a.kind === 'frame';
          return (
            <span
              key={a.id}
              title={a.text ?? t(`assignKind_${a.kind}`)}
              className={`absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-xs font-bold ${mark.className} ${sized ? 'h-[10%] w-[16%] rounded-sm' : 'h-6 w-6'}`}
              style={{ left: `${a.x}%`, top: `${a.y}%` }}
            >
              {mark.symbol}
            </span>
          );
        })}
        {preview.length > 1 ? (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polyline points={preview.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#dc2626" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {file.fileName} ({fileSizeLabel(file.fileSize)})
      </p>
    </li>
  );
}

/** Hội thoại phản hồi trên bài đã trả (học sinh ↔ giáo viên của bài đó). */
function FeedbackMessages({
  assignmentId,
  userId,
  messages,
  onPosted,
}: {
  assignmentId: string;
  userId: string;
  messages: { id: string; authorId: string; body: string; createdAt: string }[];
  onPosted: () => Promise<void>;
}) {
  const { t } = useTranslation('app');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/v1/assignments/${assignmentId}/submissions/${userId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: draft.trim() }),
      });
      setDraft('');
      await onPosted();
    } catch {
      setError(t('assignActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{t('assignMessagesTitle')}</h4>
      {messages.length === 0 ? <p className="text-sm text-muted-foreground">{t('assignNoMessages')}</p> : null}
      <ul className="space-y-2">
        {messages.map((m) => (
          <li key={m.id} className="rounded bg-muted p-2 text-sm">
            <p>{m.body}</p>
            <p className="text-xs text-muted-foreground">{dateLabel(m.createdAt)}</p>
          </li>
        ))}
      </ul>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <form onSubmit={(e) => void send(e)} className="flex gap-2">
        <Input
          aria-label={t('assignMessagesTitle')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('assignMessagePlaceholder')}
        />
        <Button type="submit" size="sm" disabled={busy}>
          {t('assignSendMessage')}
        </Button>
      </form>
    </div>
  );
}

/** Bảng tiêu chí công khai của bài (học sinh xem trước khi nộp; giáo viên xem lại khi chấm). */
function RubricView({ criteria }: { criteria: AssignRubricCriterionView[] }) {
  const { t } = useTranslation('app');
  return (
    <ul className="space-y-3">
      {criteria.map((c) => (
        <li key={c.id} className="rounded border p-3">
          <p className="font-medium">
            {c.name}
            {c.outcomeText ? <span className="ml-2 text-xs text-muted-foreground">{c.outcomeText}</span> : null}
          </p>
          {c.descriptionForStudent ? <p className="text-sm text-muted-foreground">{c.descriptionForStudent}</p> : null}
          {c.mode === 'levels' ? (
            <ul className="mt-1 flex flex-wrap gap-2">
              {c.levels.map((lv) => (
                <li key={lv.id}>
                  <Badge variant="secondary">
                    {lv.label} — {lv.score}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{t('assignRubricMaxScoreLine', { max: c.maxScore ?? 0 })}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Phía học sinh: xem trạng thái bài nộp, tải tệp/ảnh vào bản nháp, chốt
 * nộp (sau hạn vẫn nộp được — máy chủ đánh dấu trễ), mở lại khi chưa bị
 * trả bài; sau khi giáo viên TRẢ bài thì thấy điểm/mức + lời phê + dấu
 * chấm trên bài của mình + kết quả rubric + hội thoại phản hồi.
 */
function StudentPanel({ data, reload }: { data: AssignmentForUserView; reload: () => Promise<void> }) {
  const { t } = useTranslation('app');
  const { assignment, mySubmission: mine, rubric } = data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void apiJson<{ id: string }>('/api/v1/users/me')
      .then((me) => setMeId(me.id))
      .catch(() => undefined);
  }, []);

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
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    await act(async () => {
      await apiJson(`/api/v1/assignments/${assignment.id}/submission/files`, { method: 'POST', body: fd });
      if (fileInputRef.current) fileInputRef.current.value = '';
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
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
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
              <Input ref={fileInputRef} type="file" aria-label={t('assignUploadLabel')} className="max-w-xs" />
              <Button type="button" variant="outline" disabled={busy} onClick={() => void uploadChosen()}>
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
                        apiJson(`/api/v1/assignments/${assignment.id}/submission/files/${f.fileId}`, { method: 'DELETE' }),
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
              onClick={() => void act(() => apiJson(`/api/v1/assignments/${assignment.id}/submission/submit`, { method: 'POST' }))}
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
            onClick={() => void act(() => apiJson(`/api/v1/assignments/${assignment.id}/submission/reopen`, { method: 'POST' }))}
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

/** Bề mặt chấm một bài nộp: xem tệp + thả dấu vector + gói chấm nháp + trả bài. */
function GradingPanel({
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

  const loadDetail = useCallback(async () => {
    const fresh = await apiJson<AssignSubmissionDetail>(`/api/v1/assignments/${assignmentId}/submissions/${summary.userId}`);
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
  }, [assignmentId, summary.userId]);

  useEffect(() => {
    void loadDetail().catch(() => setError(t('assignLoadFailed')));
  }, [loadDetail, t]);

  useEffect(() => {
    void apiJson<TeacherCommentBankEntryView[]>('/api/v1/assign-comment-bank')
      .then(setBank)
      .catch(() => undefined);
  }, []);

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
        apiJson(`/api/v1/assignments/${assignmentId}/submissions/${summary.userId}/grade`, {
          method: 'POST',
          body: JSON.stringify({
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
          }),
        }),
      t('assignGradeSaved'),
    );
  }

  function placeAnnotation(fileId: string, point: { x: number; y: number }, points?: { x: number; y: number }[]) {
    const isDraw = points !== undefined;
    void act(() =>
      apiJson(`/api/v1/assignments/${assignmentId}/submissions/${summary.userId}/annotations`, {
        method: 'POST',
        body: JSON.stringify({
          fileId,
          page: 1,
          x: point.x,
          y: point.y,
          kind: isDraw ? 'draw' : annKind,
          text: !isDraw && annText.trim() ? annText.trim() : null,
          ...(isDraw ? { points } : {}),
        }),
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
                        apiJson(`/api/v1/assignments/${assignmentId}/submissions/${summary.userId}/annotations/${a.id}`, { method: 'DELETE' }),
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
                    const created = await apiJson<TeacherCommentBankEntryView>('/api/v1/assign-comment-bank', {
                      method: 'POST',
                      body: JSON.stringify({ category: bankCategory, text: bankDraft.trim() }),
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
                  () => apiJson(`/api/v1/assignments/${assignmentId}/submissions/${summary.userId}/release`, { method: 'POST' }),
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

/** Phía giáo viên: danh sách bài nộp cả lớp + trả bài theo đợt + mở bề mặt chấm từng em. */
function TeacherPanel({ data }: { data: AssignmentForUserView }) {
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

interface CriterionDraft {
  name: string;
  descriptionForStudent: string;
  descriptionForGrader: string;
  mode: 'levels' | 'score';
  maxScore: string;
  outcomeText: string;
  levels: { label: string; score: string }[];
}

/** Phía quản lý bài: sửa cài đặt (PATCH), dựng/cập nhật bảng tiêu chí (PUT rubric), xoá bài. */
function ManagePanel({ data, courseId, reload }: { data: AssignmentForUserView; courseId: string; reload: () => Promise<void> }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const { assignment, rubric } = data;
  const [name, setName] = useState(assignment.name);
  const [intro, setIntro] = useState(assignment.intro);
  const [due, setDue] = useState(toLocalInput(assignment.dueDate));
  const [maxFiles, setMaxFiles] = useState(String(assignment.maxFiles));
  const [acceptedTypes, setAcceptedTypes] = useState(assignment.acceptedFileTypes ?? '');
  const [gradeMax, setGradeMax] = useState(String(assignment.grade));
  const [resultMode, setResultMode] = useState(assignment.resultMode);
  const [rubricTitle, setRubricTitle] = useState(rubric?.title ?? '');
  const [criteria, setCriteria] = useState<CriterionDraft[]>(
    (rubric?.criteria ?? []).map((c) => ({
      name: c.name,
      descriptionForStudent: c.descriptionForStudent ?? '',
      descriptionForGrader: c.descriptionForGrader ?? '',
      mode: c.mode,
      maxScore: c.maxScore !== null ? String(c.maxScore) : '',
      outcomeText: c.outcomeText ?? '',
      levels: c.levels.map((lv) => ({ label: lv.label, score: String(lv.score) })),
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      await reload();
      setNotice(t('assignSavedNotice'));
    } catch {
      setError(t('assignActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    await act(() =>
      apiJson(`/api/v1/assignments/${assignment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          intro,
          dueDate: due ? new Date(due).toISOString() : null,
          maxFiles: Math.max(1, Math.trunc(Number(maxFiles) || 1)),
          acceptedFileTypes: acceptedTypes.trim() ? acceptedTypes.trim() : null,
          grade: Number(gradeMax) || assignment.grade,
          resultMode,
        }),
      }),
    );
  }

  async function saveRubric(event: FormEvent) {
    event.preventDefault();
    await act(() =>
      apiJson(`/api/v1/assignments/${assignment.id}/rubric`, {
        method: 'PUT',
        body: JSON.stringify({
          title: rubricTitle.trim() ? rubricTitle.trim() : null,
          criteria: criteria.map((c) => ({
            name: c.name.trim(),
            descriptionForStudent: c.descriptionForStudent || null,
            descriptionForGrader: c.descriptionForGrader || null,
            mode: c.mode,
            maxScore: c.mode === 'score' ? Number(c.maxScore) || null : null,
            outcomeText: c.outcomeText || null,
            ...(c.mode === 'levels'
              ? { levels: c.levels.map((lv) => ({ label: lv.label, score: Number(lv.score) || 0 })) }
              : {}),
          })),
        }),
      }),
    );
  }

  async function deleteAssignment() {
    if (!window.confirm(t('assignConfirmDelete', { name: assignment.name }))) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/v1/assignments/${assignment.id}`, { method: 'DELETE' });
      await navigate(`/courses/${courseId}`);
    } catch {
      setError(t('assignActionFailed'));
      setBusy(false);
    }
  }

  const setCriterion = (index: number, patch: Partial<CriterionDraft>) =>
    setCriteria((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  return (
    <Card data-testid="assign-manage-panel">
      <CardHeader>
        <CardTitle>{t('assignSettingsTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
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
        <form onSubmit={(e) => void saveSettings(e)} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="assign-name">{t('assignNameLabel')}</Label>
            <Input id="assign-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-intro">{t('assignIntroLabel')}</Label>
            <Textarea id="assign-intro" value={intro} onChange={(e) => setIntro(e.target.value)} />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="assign-due">{t('assignDueLabel')}</Label>
              <Input id="assign-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="assign-mode">{t('assignResultModeLabel')}</Label>
              <select id="assign-mode" className={selectClass} value={resultMode} onChange={(e) => setResultMode(e.target.value as typeof resultMode)}>
                <option value="score">{t('assignResultMode_score')}</option>
                <option value="level">{t('assignResultMode_level')}</option>
                <option value="score_feedback">{t('assignResultMode_score_feedback')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="assign-maxfiles">{t('assignMaxFilesLabel')}</Label>
              <Input id="assign-maxfiles" type="number" min={1} max={50} value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="assign-grademax">{t('assignGradeLabel')}</Label>
              <Input id="assign-grademax" type="number" min={1} step="0.5" value={gradeMax} onChange={(e) => setGradeMax(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-types">{t('assignAcceptedTypesLabel')}</Label>
            <Input id="assign-types" value={acceptedTypes} onChange={(e) => setAcceptedTypes(e.target.value)} placeholder="jpg,png,pdf" />
          </div>
          <Button type="submit" disabled={busy}>
            {t('assignSaveSettings')}
          </Button>
        </form>

        <form onSubmit={(e) => void saveRubric(e)} className="space-y-3">
          <h3 className="font-medium">{t('assignRubricEditTitle')}</h3>
          <div className="space-y-1">
            <Label htmlFor="rubric-title">{t('assignRubricTitleLabel')}</Label>
            <Input id="rubric-title" value={rubricTitle} onChange={(e) => setRubricTitle(e.target.value)} />
          </div>
          {criteria.map((c, ci) => (
            <div key={ci} className="space-y-2 rounded border p-3" data-testid={`rubric-criterion-${ci}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={t('assignRubricCriterionName')}
                  value={c.name}
                  onChange={(e) => setCriterion(ci, { name: e.target.value })}
                  placeholder={t('assignRubricCriterionName')}
                  className="max-w-sm"
                />
                <select
                  aria-label={t('assignRubricModeLabel')}
                  className={selectClass}
                  value={c.mode}
                  onChange={(e) => setCriterion(ci, { mode: e.target.value as CriterionDraft['mode'] })}
                >
                  <option value="levels">{t('assignRubricMode_levels')}</option>
                  <option value="score">{t('assignRubricMode_score')}</option>
                </select>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => setCriteria((prev) => prev.filter((_, i) => i !== ci))}
                >
                  {t('assignRubricRemoveCriterion')}
                </Button>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <Textarea
                  aria-label={t('assignRubricDescStudent')}
                  value={c.descriptionForStudent}
                  onChange={(e) => setCriterion(ci, { descriptionForStudent: e.target.value })}
                  placeholder={t('assignRubricDescStudent')}
                />
                <Textarea
                  aria-label={t('assignRubricDescGrader')}
                  value={c.descriptionForGrader}
                  onChange={(e) => setCriterion(ci, { descriptionForGrader: e.target.value })}
                  placeholder={t('assignRubricDescGrader')}
                />
              </div>
              <Input
                aria-label={t('assignRubricOutcomeLabel')}
                value={c.outcomeText}
                onChange={(e) => setCriterion(ci, { outcomeText: e.target.value })}
                placeholder={t('assignRubricOutcomeLabel')}
              />
              {c.mode === 'score' ? (
                <Input
                  aria-label={t('assignRubricMaxScoreLabel')}
                  type="number"
                  min={0}
                  step="0.25"
                  value={c.maxScore}
                  onChange={(e) => setCriterion(ci, { maxScore: e.target.value })}
                  placeholder={t('assignRubricMaxScoreLabel')}
                  className="max-w-40"
                />
              ) : (
                <div className="space-y-2">
                  {c.levels.map((lv, li) => (
                    <div key={li} className="flex items-center gap-2">
                      <Input
                        aria-label={t('assignRubricLevelLabel')}
                        value={lv.label}
                        onChange={(e) =>
                          setCriterion(ci, { levels: c.levels.map((x, xi) => (xi === li ? { ...x, label: e.target.value } : x)) })
                        }
                        placeholder={t('assignRubricLevelLabel')}
                        className="max-w-52"
                      />
                      <Input
                        aria-label={t('assignRubricLevelScore')}
                        type="number"
                        min={0}
                        step="0.25"
                        value={lv.score}
                        onChange={(e) =>
                          setCriterion(ci, { levels: c.levels.map((x, xi) => (xi === li ? { ...x, score: e.target.value } : x)) })
                        }
                        className="max-w-28"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setCriterion(ci, { levels: c.levels.filter((_, xi) => xi !== li) })}
                      >
                        {t('assignRemoveFile')}
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCriterion(ci, { levels: [...c.levels, { label: '', score: '0' }] })}
                  >
                    {t('assignRubricAddLevel')}
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setCriteria((prev) => [
                  ...prev,
                  { name: '', descriptionForStudent: '', descriptionForGrader: '', mode: 'levels', maxScore: '', outcomeText: '', levels: [{ label: '', score: '0' }] },
                ])
              }
            >
              {t('assignRubricAddCriterion')}
            </Button>
            <Button type="submit" disabled={busy || criteria.length === 0}>
              {t('assignRubricSave')}
            </Button>
          </div>
        </form>

        <div>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void deleteAssignment()}>
            {t('assignDeleteButton')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Trang hoạt động Bài tập nộp tệp/ảnh (mod_assign): một trang dùng
 * chung theo cờ quyền mà API đã phân giải — học sinh nộp bài và xem
 * kết quả sau khi trả bài; giáo viên xem danh sách bài nộp, chấm +
 * thả dấu vector + trả bài (từng em/theo đợt); người quản lý sửa cài
 * đặt và dựng bảng tiêu chí ngay tại trang.
 */
export function AssignmentPage() {
  const { t } = useTranslation('app');
  const { id: courseId, assignmentId } = useParams();
  const [data, setData] = useState<AssignmentForUserView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const fresh = await apiJson<AssignmentForUserView>(`/api/v1/assignments/${assignmentId}`);
    setData(fresh);
  }, [assignmentId]);

  useEffect(() => {
    void reload().catch(() => setError(t('assignLoadFailed')));
  }, [reload, t]);

  if (error) {
    return (
      <PageShell width="wide">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <p className="mt-3 text-sm">
          <Link to={`/courses/${courseId}`} className="underline">
            {t('assignBackToCourse')}
          </Link>
        </p>
      </PageShell>
    );
  }
  if (!data) {
    return (
      <PageShell width="wide">
        <div className="space-y-3" aria-label={t('assignLoading')}>
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </PageShell>
    );
  }

  const { assignment, rubric } = data;
  return (
    <PageShell width="wide">
      <PageHeader
        title={assignment.name}
        description={
          assignment.dueDate
            ? `${t('assignDueLine', { date: dateLabel(assignment.dueDate) })} · ${t('assignGradeScaleLine', { grade: assignment.grade })} · ${t(`assignResultMode_${assignment.resultMode}`)}`
            : `${t('assignNoDue')} · ${t('assignGradeScaleLine', { grade: assignment.grade })} · ${t(`assignResultMode_${assignment.resultMode}`)}`
        }
      />
      <p className="text-sm">
        <Link to={`/courses/${courseId}`} className="underline">
          {t('assignBackToCourse')}
        </Link>
      </p>
      {assignment.intro ? (
        <Card>
          <CardContent className="whitespace-pre-wrap text-sm">{assignment.intro}</CardContent>
        </Card>
      ) : null}
      {rubric && rubric.criteria.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{rubric.title ?? t('assignRubricTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <RubricView criteria={rubric.criteria} />
          </CardContent>
        </Card>
      ) : null}
      {data.canSubmit ? <StudentPanel data={data} reload={reload} /> : null}
      {data.canViewAllSubmissions || data.canGrade ? <TeacherPanel data={data} /> : null}
      {data.canManage ? <ManagePanel data={data} courseId={courseId!} reload={reload} /> : null}
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AssignmentPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('contentType_mod_assign');
}
