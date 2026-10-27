import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  extractRichTextPlainText,
  type CourseGroup,
  type CourseRosterMember,
  type PinRegradeLogEntry,
  type PinRegradeResult,
  type PinVersionUpdatePreview,
  type QuestionView,
  type QuizAttemptSummary,
  type ExamPinOverrideView as QuizOverrideView,
  type QuizView,
  type RichTextDocument,
} from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiJson, ApiError } from '#lib/api';
import {
  examPinQueryOptions,
  useCourseRoster,
  useExamPin,
  useExamPinOverrides,
  useExamSource,
} from '#lib/quiz-data';
import { courseGroupsQueryOptions } from '#lib/progress-report-data';
import { queryClient } from '#lib/query-client';

function plainText(doc: RichTextDocument | null | undefined): string {
  return doc ? extractRichTextPlainText(doc) : '';
}

/** Chuyển giá trị Date của API sang giá trị cho input datetime-local. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Trang LẦN GHIM đề (sau gộp Đề #226, route /courses/:id/exams/:pinId):
 * thông tin lần tổ chức cho mọi người xem được; học sinh bắt đầu/tiếp
 * tục lượt làm và xem điểm của mình; giáo viên có quyền manage thì sửa
 * CẤU HÌNH TỔ CHỨC của lần ghim tại trang — nội dung đề (slots) thuộc
 * về ĐỀ ở ngân hàng, tại đây chỉ xem bản đã ghim + nâng version đề.
 */
export function QuizPage() {
  const { t } = useTranslation('app');
  const { id: courseId, pinId: quizId } = useParams();
  const navigate = useNavigate();
  // Dữ liệu trang qua TanStack (F-01 đợt 1): lần ghim là một query
  // (clientLoader đã prefetch cùng khoá); lỗi tải đầu hiển thị qua
  // trạng thái lỗi của query như reload() thủ công trước đây (F-14).
  const pinQuery = useExamPin(quizId ?? '');
  const data = pinQuery.data?.view ?? null;
  const slotNames = pinQuery.data?.slotNames ?? {};
  const { refetch } = pinQuery;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pinQuery.isError) setError(t('quizLoadFailed'));
  }, [pinQuery.isError, pinQuery.errorUpdatedAt, t]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Form cài đặt (chỉ giáo viên manage dùng).
  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [timeOpen, setTimeOpen] = useState('');
  const [timeClose, setTimeClose] = useState('');
  const [timeLimitMinutes, setTimeLimitMinutes] = useState('');
  const [attemptsAllowed, setAttemptsAllowed] = useState('0');
  const [gradeMethod, setGradeMethod] = useState('highest');
  const [grade, setGrade] = useState('10');
  const [shuffleAnswers, setShuffleAnswers] = useState(false);
  const [versionMode, setVersionMode] = useState<'pinned' | 'float_latest_ready'>('pinned');

  // Cập nhật version của pin (issue #254): xem trước diff rồi mới áp —
  // preview là dữ kiện của API, áp dùng đúng exam version đã xem trước.
  const [updatePreview, setUpdatePreview] = useState<PinVersionUpdatePreview | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // Chấm lại theo đáp án (issue #254): chọn câu + version đúng →
  // dry-run xem điểm đổi → áp → nhật ký các lần đã áp.
  const [regradeQuestionId, setRegradeQuestionId] = useState('');
  const [regradeVersions, setRegradeVersions] = useState<{ id: string; version: number; status: string }[]>([]);
  const [regradeVersionId, setRegradeVersionId] = useState('');
  const [regradePreview, setRegradePreview] = useState<PinRegradeResult | null>(null);
  const [regradeLog, setRegradeLog] = useState<PinRegradeLogEntry[] | null>(null);
  const [regradeError, setRegradeError] = useState<string | null>(null);

  // Lịch sử sửa điểm của chính người xem (API tự gác cổng công bố:
  // chưa công bố thì trả rỗng, mục này tự ẩn).
  const myRegradesQuery = useQuery({
    queryKey: ['exam-pin-my-regrades', quizId],
    queryFn: () => apiJson<PinRegradeLogEntry[]>(`/api/v1/exam-pins/${quizId}/my-regrades`),
    enabled: !!quizId,
  });
  const myRegrades = myRegradesQuery.data ?? [];

  // Thông tin ĐỀ nguồn của lần ghim (tên + version hiện hành ở bank) — chỉ tải khi có quyền manage.
  const examInfo = useExamSource(data?.quiz.examId, !!data?.permissions.manage).data ?? null;

  // Ghi đè (chỉ người có quiz:manageoverrides dùng): danh sách + dữ liệu chọn đích + form tạo/sửa dùng chung.
  // Ghi đè + danh sách thành viên đích: chỉ tải khi có quyền quản ghi
  // đè. Nhóm của khoá dùng chung khoá factory courseGroups (F-03).
  const overridesQuery = useExamPinOverrides(quizId ?? '', !!data?.permissions.manageOverrides);
  const overrides = overridesQuery.data ?? [];
  const overridesLoaded = overridesQuery.isSuccess || overridesQuery.isError;
  const { refetch: refetchOverrides } = overridesQuery;
  const roster = useCourseRoster(courseId ?? '', !!(data?.permissions.manageOverrides || data?.permissions.grade)).data ?? [];
  const groups = useQuery({
    ...courseGroupsQueryOptions(courseId ?? ''),
    enabled: !!courseId && !!(data?.permissions.manage || data?.permissions.manageOverrides),
  }).data ?? [];

  useEffect(() => {
    if (overridesQuery.isError) setOvError(t('quizOverridesLoadFailed'));
  }, [overridesQuery.isError, overridesQuery.errorUpdatedAt, t]);

  // Nhật ký chấm lại nạp một lần khi người xem có quyền chấm (panel chấm lại dùng chung dữ kiện này).
  useEffect(() => {
    if (data?.permissions.grade) void loadRegradeLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.permissions.grade]);
  const [editingOverride, setEditingOverride] = useState<QuizOverrideView | null>(null);
  const [ovTargetKind, setOvTargetKind] = useState<'user' | 'group'>('user');
  const [ovUserId, setOvUserId] = useState('');
  const [ovGroupId, setOvGroupId] = useState('');
  const [ovTimeOpen, setOvTimeOpen] = useState('');
  const [ovTimeClose, setOvTimeClose] = useState('');
  const [ovLimitMinutes, setOvLimitMinutes] = useState('');
  const [ovAttempts, setOvAttempts] = useState('');
  const [ovPassword, setOvPassword] = useState('');
  const [ovReason, setOvReason] = useState('');
  const [ovError, setOvError] = useState<string | null>(null);

  // Khởi tạo form cài đặt từ dữ liệu lần ghim mỗi khi dữ liệu (lại)
  // tải về — đúng phần khởi tạo của reload() thủ công trước đây.
  useEffect(() => {
    if (!data) return;
    setName(data.quiz.name);
    setIntro(data.quiz.intro);
    setTimeOpen(toLocalInput(data.quiz.timeOpen));
    setTimeClose(toLocalInput(data.quiz.timeClose));
    setTimeLimitMinutes(data.quiz.timeLimitSeconds ? String(Math.round(data.quiz.timeLimitSeconds / 60)) : '');
    setAttemptsAllowed(String(data.quiz.attemptsAllowed));
    setGradeMethod(data.quiz.gradeMethod);
    setGrade(String(data.quiz.grade));
    setShuffleAnswers(data.quiz.shuffleAnswers);
    setVersionMode(data.quiz.versionMode);
  }, [data]);

  // Các thao tác ghi gọi reload()/reloadOverrides() như cũ — nay là
  // refetch của query tương ứng; lỗi refetch vẫn ném ra để các nhánh
  // bắt lỗi cũ chạy nguyên trạng.
  const reload = useCallback(async () => {
    const result = await refetch();
    if (result.error) throw result.error;
  }, [refetch]);

  const reloadOverrides = useCallback(async () => {
    const result = await refetchOverrides();
    if (result.error) throw result.error;
  }, [refetchOverrides]);

  function resetOverrideForm() {
    setEditingOverride(null);
    setOvTargetKind('user');
    setOvUserId('');
    setOvGroupId('');
    setOvTimeOpen('');
    setOvTimeClose('');
    setOvLimitMinutes('');
    setOvAttempts('');
    setOvPassword('');
    setOvReason('');
    setOvError(null);
  }

  function startEditOverride(ov: QuizOverrideView) {
    setEditingOverride(ov);
    setOvTargetKind(ov.groupId ? 'group' : 'user');
    setOvUserId(ov.userId ?? '');
    setOvGroupId(ov.groupId ?? '');
    setOvTimeOpen(toLocalInput(ov.timeOpen));
    setOvTimeClose(toLocalInput(ov.timeClose));
    setOvLimitMinutes(ov.timeLimitSeconds ? String(Math.round(ov.timeLimitSeconds / 60)) : '');
    setOvAttempts(ov.attempts === null ? '' : String(ov.attempts));
    setOvPassword('');
    setOvReason(ov.reason ?? '');
    setOvError(null);
  }

  /** Chạy một thao tác ghi đè rồi nạp lại danh sách; mã lỗi của API được dịch riêng cho luật lý do. */
  async function actOverride(run: () => Promise<unknown>) {
    setOvError(null);
    setBusy(true);
    try {
      await run();
      await reloadOverrides();
      resetOverrideForm();
    } catch (err) {
      setOvError(
        err instanceof ApiError && err.problem.code === 'quiz.override_reason_required'
          ? t('quizOverrideReasonRequired')
          : t('quizOverrideActionFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitOverride(event: FormEvent) {
    event.preventDefault();
    // Cùng điều kiện bắt buộc lý do như API: ghi đè cho HỌC SINH mà cộng giờ hoặc mở cửa sổ riêng.
    const isUserTarget = editingOverride ? editingOverride.userId !== null : ovTargetKind === 'user';
    const needsReason = isUserTarget && (ovTimeOpen !== '' || ovLimitMinutes.trim() !== '');
    if (needsReason && !ovReason.trim()) {
      setOvError(t('quizOverrideReasonRequired'));
      return;
    }
    if (!editingOverride) {
      if (ovTargetKind === 'user' && !ovUserId) { setOvError(t('quizOverrideTargetRequired')); return; }
      if (ovTargetKind === 'group' && !ovGroupId) { setOvError(t('quizOverrideTargetRequired')); return; }
    }
    const fields = {
      timeOpen: ovTimeOpen ? new Date(ovTimeOpen).toISOString() : null,
      timeClose: ovTimeClose ? new Date(ovTimeClose).toISOString() : null,
      timeLimitSeconds: ovLimitMinutes.trim() ? Math.max(1, Math.round(Number(ovLimitMinutes))) * 60 : null,
      attempts: ovAttempts.trim() ? Math.max(0, Math.trunc(Number(ovAttempts))) : null,
      ...(ovPassword ? { password: ovPassword } : {}),
      ...(ovReason.trim() ? { reason: ovReason.trim() } : {}),
    };
    if (editingOverride) {
      const target = editingOverride;
      await actOverride(() =>
        apiJson(`/api/v1/exam-pin-overrides/${target.id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
      );
    } else {
      await actOverride(() =>
        apiJson(`/api/v1/exam-pins/${quizId}/overrides`, {
          method: 'POST',
          body: JSON.stringify({ ...(ovTargetKind === 'user' ? { userId: ovUserId } : { groupId: ovGroupId }), ...fields }),
        }),
      );
    }
  }

  async function removeOverride(ov: QuizOverrideView) {
    if (editingOverride?.id === ov.id) resetOverrideForm();
    await actOverride(() => apiJson(`/api/v1/exam-pin-overrides/${ov.id}`, { method: 'DELETE' }));
  }

  /** Chạy một thao tác rồi nạp lại trang; lỗi hiện qua i18n. */
  async function act(run: () => Promise<unknown>) {
    setActionError(null);
    setBusy(true);
    try {
      await run();
      await reload();
    } catch {
      setActionError(t('quizActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    // Lỗi chế độ version phải hiện đúng lý do nghiệp vụ (chỉ luyện tập
    // mới được trôi) thay vì thông báo lỗi chung — API là nơi gác, ở
    // đây chỉ dịch mã lỗi của nó.
    setActionError(null);
    setBusy(true);
    try {
      await apiJson(`/api/v1/exam-pins/${quizId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          intro,
          timeOpen: timeOpen ? new Date(timeOpen).toISOString() : null,
          timeClose: timeClose ? new Date(timeClose).toISOString() : null,
          timeLimitSeconds: timeLimitMinutes.trim() ? Math.max(1, Math.round(Number(timeLimitMinutes))) * 60 : null,
          attemptsAllowed: Math.max(0, Math.trunc(Number(attemptsAllowed) || 0)),
          gradeMethod,
          grade: Number(grade) || 10,
          shuffleAnswers,
          versionMode,
        }),
      });
      await reload();
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.problem.code === 'exam.version_mode_not_allowed'
          ? t('pinVersionModeNotAllowed')
          : t('quizActionFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  /** Tải xem trước cập nhật version (diff từng slot) cho lần ghim này. */
  async function loadUpdatePreview() {
    setUpdateError(null);
    setBusy(true);
    try {
      setUpdatePreview(await apiJson<PinVersionUpdatePreview>(`/api/v1/exam-pins/${quizId}/version-update`));
    } catch {
      setUpdateError(t('pinVersionUpdateFailed'));
    } finally {
      setBusy(false);
    }
  }

  /** Áp cập nhật lên đúng exam version đã xem trước; bị khoá bởi lượt làm thật thì hiện lý do của API. */
  async function applyUpdate() {
    if (!updatePreview?.toExamVersionId) return;
    setUpdateError(null);
    setBusy(true);
    try {
      await apiJson(`/api/v1/exam-pins/${quizId}/version-update`, {
        method: 'POST',
        body: JSON.stringify({ toExamVersionId: updatePreview.toExamVersionId }),
      });
      setUpdatePreview(null);
      await reload();
    } catch (err) {
      setUpdateError(
        err instanceof ApiError && err.problem.code === 'exam.pin_locked'
          ? t('pinVersionLocked')
          : t('pinVersionUpdateFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  /** Tải các version của câu được chọn cho panel chấm lại, mặc định chọn bản ready mới nhất. */
  async function loadRegradeVersions(questionId: string) {
    setRegradePreview(null);
    setRegradeError(null);
    if (!questionId) {
      setRegradeVersions([]);
      setRegradeVersionId('');
      return;
    }
    try {
      const versions = await apiJson<{ id: string; version: number; status: string }[]>(`/api/v1/questions/${questionId}/versions`);
      setRegradeVersions(versions);
      const ready = versions.filter((v) => v.status === 'ready');
      setRegradeVersionId((ready.length ? ready[ready.length - 1]! : versions[versions.length - 1])?.id ?? '');
    } catch {
      setRegradeVersions([]);
      setRegradeVersionId('');
      setRegradeError(t('regradeFailed'));
    }
  }

  /** Chạy chấm lại (dryRun = chỉ xem trước điểm đổi, không ghi). */
  async function runRegrade(dryRun: boolean) {
    if (!regradeQuestionId || !regradeVersionId) return;
    setRegradeError(null);
    setBusy(true);
    try {
      const result = await apiJson<PinRegradeResult>(`/api/v1/exam-pins/${quizId}/regrades`, {
        method: 'POST',
        body: JSON.stringify({ questionId: regradeQuestionId, toVersionId: regradeVersionId, dryRun }),
      });
      setRegradePreview(result);
      if (!dryRun) {
        setRegradeLog(await apiJson<PinRegradeLogEntry[]>(`/api/v1/exam-pins/${quizId}/regrades`));
        await reload();
        void myRegradesQuery.refetch();
      }
    } catch {
      setRegradeError(t('regradeFailed'));
    } finally {
      setBusy(false);
    }
  }

  /** Tải nhật ký chấm lại của pin (chỉ người có quyền xem báo cáo mới gọi được — panel chỉ hiện cho vai chấm). */
  async function loadRegradeLog() {
    try {
      setRegradeLog(await apiJson<PinRegradeLogEntry[]>(`/api/v1/exam-pins/${quizId}/regrades`));
    } catch {
      setRegradeLog([]);
    }
  }

  async function startAttempt(preview: boolean) {
    setActionError(null);
    try {
      const view = await apiJson<{ attempt: { id: string } }>(`/api/v1/exam-pins/${quizId}/attempts`, {
        method: 'POST',
        body: JSON.stringify({ preview }),
      });
      await navigate(`/quiz-attempts/${view.attempt.id}`);
    } catch {
      setActionError(t('quizActionFailed'));
    }
  }

  if (error)
    return (
      <PageShell width="medium">
        <PageHeader title={t('quizHeading')} />
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setError(null);
              void reload().catch(() => setError(t('quizLoadFailed')));
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
        <PageHeader title={t('quizHeading')} />
        <div className="space-y-2" aria-label={t('quizLoading')}>
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="h-4 w-64" />
        </div>
      </PageShell>
    );

  const { quiz, permissions } = data;
  // Cửa sổ/giới hạn hiện theo cài đặt HIỆU LỰC của chính người xem (API đã hợp nhất ghi đè) — học sinh thuộc diện ghi đè thấy đúng giờ của mình, không phải giờ chung của đề.
  const eff = data.effective;
  const hasOwnOverride =
    eff.timeOpen !== quiz.timeOpen ||
    eff.timeClose !== quiz.timeClose ||
    eff.timeLimitSeconds !== quiz.timeLimitSeconds ||
    eff.attemptsAllowed !== quiz.attemptsAllowed;
  const blockedKey =
    data.attemptBlockedReason === 'not_yet_open'
      ? 'quizNotYetOpen'
      : data.attemptBlockedReason === 'closed'
        ? 'quizClosed'
        : data.attemptBlockedReason === 'no_more_attempts'
          ? 'quizNoMoreAttempts'
          : data.attemptBlockedReason === 'no_questions'
            ? 'quizNoQuestions'
            : null;

  return (
    <PageShell width="medium">
      <PageHeader title={quiz.name} description={t('quizIntroLine', { total: quiz.sumGrades, grade: quiz.grade })} />
      <Card>
        <CardContent className="space-y-3">
          {quiz.intro ? <p className="text-sm whitespace-pre-wrap">{quiz.intro}</p> : null}
          <ul className="text-sm text-muted-foreground">
            <li>{t('quizWindowLine', { open: eff.timeOpen ? new Date(eff.timeOpen).toLocaleString() : t('quizNoBound'), close: eff.timeClose ? new Date(eff.timeClose).toLocaleString() : t('quizNoBound') })}</li>
            <li>{t('quizTimeLimitLine', { minutes: eff.timeLimitSeconds ? Math.round(eff.timeLimitSeconds / 60) : t('quizNoTimeLimit') })}</li>
            <li>{t('quizAttemptsLine', { count: eff.attemptsAllowed === 0 ? t('quizUnlimited') : eff.attemptsAllowed })}</li>
            <li>{t('quizGradeMethodLine', { method: t(`quizGradeMethod_${quiz.gradeMethod}`) })}</li>
          </ul>
          {hasOwnOverride ? <p className="text-sm font-medium">{t('quizEffectiveNote')}</p> : null}
          {actionError ? (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {permissions.attempt && data.inProgressAttemptId ? (
              <Button type="button" onClick={() => void navigate(`/quiz-attempts/${data.inProgressAttemptId}`)}>
                {t('quizContinueAttempt')}
              </Button>
            ) : permissions.attempt && data.canAttempt ? (
              <Button type="button" onClick={() => void startAttempt(false)}>
                {t('quizStartAttempt')}
              </Button>
            ) : null}
            {permissions.attempt && blockedKey ? <p className="text-sm text-muted-foreground">{t(blockedKey)}</p> : null}
            {permissions.preview ? (
              <Button type="button" variant="outline" onClick={() => void startAttempt(true)}>
                {t('quizPreview')}
              </Button>
            ) : null}
            {permissions.viewReports ? (
              <Button type="button" variant="outline" render={<Link to={`/courses/${courseId}/exams/${quizId}/results`} />}>
                {t('quizViewResults')}
              </Button>
            ) : null}
            {permissions.grade ? (
              <Button type="button" variant="outline" render={<Link to={`/courses/${courseId}/exams/${quizId}/paper`} />}>
                {t('paperTitle')}
              </Button>
            ) : null}
          </div>
          {data.myGrade !== null ? (
            <p className="text-sm font-medium">{t('quizMyGrade', { grade: data.myGrade, max: quiz.grade })}</p>
          ) : null}
          {data.myAttempts.length ? (
            <div>
              <h3 className="text-sm font-medium">{t('quizMyAttempts')}</h3>
              <ul className="text-sm">
                {data.myAttempts.map((a) => (
                  <li key={a.id} data-testid={`my-attempt-${a.id}`}>
                    {t('quizAttemptLine', { number: a.attemptNumber, state: t(`quizAttemptState_${a.state}`) })}
                    {a.grade !== null ? ` — ${a.grade}/${quiz.grade}` : ''}
                    {a.preview ? ` (${t('quizPreviewBadge')})` : ''}{' '}
                    <Link to={`/quiz-attempts/${a.id}`}>{t('quizViewAttempt')}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {myRegrades.length ? (
            <div>
              <h3 className="text-sm font-medium">{t('myRegradesTitle')}</h3>
              <ul className="text-sm">
                {myRegrades.flatMap((entry) =>
                  entry.items.map((item) => (
                    <li key={`${entry.id}-${item.examAttemptId}`}>
                      {t('myRegradeLine', {
                        date: new Date(entry.createdAt).toLocaleString(),
                        number: item.attemptNumber,
                        from: item.oldSumGrades ?? 0,
                        to: item.newSumGrades ?? 0,
                      })}
                    </li>
                  )),
                )}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {permissions.manage ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('pinExamTitle')}</CardTitle>
              <CardDescription>{t('pinExamDescription', { total: quiz.sumGrades })}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1 text-sm">
                <p>
                  {t('pinExamSourceLine')}:{' '}
                  <span className="font-medium">{examInfo?.name ?? quiz.name}</span>
                  {quiz.targetGroupId ? (
                    <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">
                      {t('pinExamGroupLine', { group: groups.find((g) => g.id === quiz.targetGroupId)?.name ?? '' })}
                    </span>
                  ) : (
                    <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t('pinExamWholeCourse')}</span>
                  )}
                </p>
                <p className="text-muted-foreground">{t('pinExamFrozenNote')}</p>
                <p>
                  {t('pinExamVersionLine', { version: quiz.examVersionNumber })}
                  {quiz.hasNewerExamVersion ? (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                      {t('pinHasNewerVersion', { version: quiz.latestExamVersionNumber })}
                    </span>
                  ) : null}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button type="button" variant="outline" render={<Link to={`/exams/${quiz.examId}/edit`} />}>
                    {t('pinExamOpenEditor')}
                  </Button>
                  {quiz.hasNewerExamVersion ? (
                    <Button type="button" variant="outline" disabled={busy} onClick={() => void loadUpdatePreview()}>
                      {t('pinVersionUpdateReview')}
                    </Button>
                  ) : null}
                </div>
                {updateError ? (
                  <Alert variant="destructive">
                    <AlertDescription>{updateError}</AlertDescription>
                  </Alert>
                ) : null}
                {updatePreview ? (
                  <div className="space-y-2 rounded-md border p-3">
                    <p className="font-medium">{t('pinVersionUpdateTitle')}</p>
                    <p>
                      {t('pinVersionUpdateFromTo', {
                        from: updatePreview.fromVersionNumber,
                        to: updatePreview.toVersionNumber ?? updatePreview.fromVersionNumber,
                      })}
                    </p>
                    {updatePreview.blockedByAttempts ? (
                      <p className="text-amber-900">{t('pinVersionUpdateBlocked')}</p>
                    ) : updatePreview.slotDiffs.length === 0 ? (
                      <p className="text-muted-foreground">{t('pinVersionUpdateEmpty')}</p>
                    ) : (
                      <ul className="space-y-1">
                        {updatePreview.slotDiffs.map((d) => (
                          <li key={d.position}>
                            {t('diffSlotLine', { position: d.position })} —{' '}
                            {d.change === 'question_version_changed'
                              ? t('diffChange_question_version_changed', { from: d.fromPinnedVersionNumber ?? 0, to: d.toPinnedVersionNumber ?? 0 })
                              : d.change === 'mark_changed'
                                ? t('diffChange_mark_changed', { from: d.fromMaxMark ?? 0, to: d.toMaxMark ?? 0 })
                                : t(`diffChange_${d.change}`)}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        disabled={busy || updatePreview.blockedByAttempts || !updatePreview.toExamVersionId}
                        onClick={() => void applyUpdate()}
                      >
                        {t('pinVersionUpdateApply')}
                      </Button>
                      <Button type="button" variant="outline" disabled={busy} onClick={() => setUpdatePreview(null)}>
                        {t('pinVersionUpdateCancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
              <ul className="space-y-2">
                {quiz.slots.map((s) => (
                  <li key={s.id} data-testid={`slot-${s.id}`} className="flex flex-wrap items-center gap-2 text-sm">
                    <span>
                      {t('quizSlotLine', { slot: s.slot, page: s.page })}{' '}
                      {s.questionId ? (slotNames[s.id] ?? t('quizSlotFixed')) : t('quizSlotRandom')}
                      {s.bankName ? (
                        <span className="block text-xs text-muted-foreground">
                          {t('slotBankLine', { bank: s.bankName })}
                          {s.versionMode === 'pinned' && s.pinnedVersion !== null
                            ? ` · ${t('slotPinnedLine', { version: s.pinnedVersion })}`
                            : ` · ${t('slotFollowLatest')}`}
                          {s.hasNewerVersion && s.latestVersion !== null ? ` · ${t('slotHasNewerLine', { version: s.latestVersion })}` : ''}
                          {s.questionStatus === 'hidden' ? ` · ${t('slotQuestionWithdrawn')}` : ''}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground">{t('pinExamSlotMark', { mark: s.maxMark })}</span>
                  </li>
                ))}
                {quiz.slots.length === 0 ? <li className="text-sm text-muted-foreground">{t('quizNoQuestions')}</li> : null}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('quizSettingsTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void saveSettings(e)}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="quiz-name">{t('quizSettingsName')}</FieldLabel>
                    <Input id="quiz-name" value={name} onChange={(e) => setName(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="quiz-intro">{t('quizSettingsIntro')}</FieldLabel>
                    <Input id="quiz-intro" value={intro} onChange={(e) => setIntro(e.target.value)} />
                  </Field>
                  <div className="flex flex-wrap gap-3">
                    <Field className="w-auto">
                      <FieldLabel htmlFor="quiz-open">{t('quizSettingsOpen')}</FieldLabel>
                      <Input id="quiz-open" type="datetime-local" value={timeOpen} onChange={(e) => setTimeOpen(e.target.value)} />
                    </Field>
                    <Field className="w-auto">
                      <FieldLabel htmlFor="quiz-close">{t('quizSettingsClose')}</FieldLabel>
                      <Input id="quiz-close" type="datetime-local" value={timeClose} onChange={(e) => setTimeClose(e.target.value)} />
                    </Field>
                    <Field className="w-auto">
                      <FieldLabel htmlFor="quiz-limit">{t('quizSettingsTimeLimit')}</FieldLabel>
                      <Input id="quiz-limit" value={timeLimitMinutes} onChange={(e) => setTimeLimitMinutes(e.target.value)} />
                    </Field>
                    <Field className="w-auto">
                      <FieldLabel htmlFor="quiz-attempts">{t('quizSettingsAttempts')}</FieldLabel>
                      <Input id="quiz-attempts" value={attemptsAllowed} onChange={(e) => setAttemptsAllowed(e.target.value)} />
                    </Field>
                    <Field className="w-auto">
                      <FieldLabel htmlFor="quiz-grade">{t('quizSettingsGrade')}</FieldLabel>
                      <Input id="quiz-grade" value={grade} onChange={(e) => setGrade(e.target.value)} />
                    </Field>
                    <Field className="w-auto">
                      <FieldLabel id="quiz-method-label">{t('quizSettingsMethod')}</FieldLabel>
                      <Select
                        items={Object.fromEntries(
                          (['highest', 'average', 'first', 'last'] as const).map((m) => [m, t(`quizGradeMethod_${m}`)]),
                        )}
                        value={gradeMethod}
                        onValueChange={(v) => setGradeMethod(v ?? 'highest')}
                      >
                        <SelectTrigger aria-labelledby="quiz-method-label" className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(['highest', 'average', 'first', 'last'] as const).map((m) => (
                            <SelectItem key={m} value={m}>{t(`quizGradeMethod_${m}`)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <div className="flex items-end gap-2 pb-1">
                      <Checkbox
                        id="quiz-shuffle"
                        checked={shuffleAnswers}
                        onCheckedChange={(checked) => setShuffleAnswers(checked === true)}
                      />
                      <Label htmlFor="quiz-shuffle">{t('quizSettingsShuffle')}</Label>
                    </div>
                    <Field className="w-auto">
                      <FieldLabel id="quiz-version-mode-label">{t('pinVersionModeLabel')}</FieldLabel>
                      <Select
                        items={{
                          pinned: t('pinVersionMode_pinned'),
                          float_latest_ready: t('pinVersionMode_float_latest_ready'),
                        }}
                        value={versionMode}
                        onValueChange={(v) => setVersionMode(v === 'float_latest_ready' ? 'float_latest_ready' : 'pinned')}
                      >
                        <SelectTrigger aria-labelledby="quiz-version-mode-label" className="w-64">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pinned">{t('pinVersionMode_pinned')}</SelectItem>
                          <SelectItem value="float_latest_ready">{t('pinVersionMode_float_latest_ready')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('pinVersionModeHint')}</p>
                  <div className="flex justify-end">
                    <Button type="submit" disabled={busy}>{t('quizSettingsSave')}</Button>
                  </div>
                </FieldGroup>
              </form>
            </CardContent>
          </Card>
        </>
      ) : null}

      {permissions.grade ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('regradeTitle')}</CardTitle>
            <CardDescription>{t('regradeDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {regradeError ? (
              <Alert variant="destructive">
                <AlertDescription>{regradeError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Select
                items={Object.fromEntries(
                  quiz.slots
                    .filter((s) => s.questionId)
                    .map((s) => [s.questionId!, slotNames[s.id] ?? t('quizSlotLine', { slot: s.slot, page: s.page })]),
                )}
                value={regradeQuestionId === '' ? null : regradeQuestionId}
                onValueChange={(v) => {
                  setRegradeQuestionId(v ?? '');
                  void loadRegradeVersions(v ?? '');
                }}
              >
                <SelectTrigger aria-label={t('regradeQuestionLabel')} className="w-72">
                  <SelectValue placeholder={t('regradeQuestionLabel')} />
                </SelectTrigger>
                <SelectContent>
                  {quiz.slots
                    .filter((s) => s.questionId)
                    .map((s) => (
                      <SelectItem key={s.questionId!} value={s.questionId!}>
                        {slotNames[s.id] ?? t('quizSlotLine', { slot: s.slot, page: s.page })}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Select
                items={Object.fromEntries(regradeVersions.map((v) => [v.id, `v${v.version} (${v.status})`]))}
                value={regradeVersionId === '' ? null : regradeVersionId}
                onValueChange={(v) => setRegradeVersionId(v ?? '')}
              >
                <SelectTrigger aria-label={t('regradeVersionLabel')} className="w-44">
                  <SelectValue placeholder={t('regradeVersionLabel')} />
                </SelectTrigger>
                <SelectContent>
                  {regradeVersions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{`v${v.version} (${v.status})`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" disabled={busy || !regradeQuestionId || !regradeVersionId} onClick={() => void runRegrade(true)}>
                {t('regradeDryRun')}
              </Button>
              <Button type="button" disabled={busy || !regradeQuestionId || !regradeVersionId} onClick={() => void runRegrade(false)}>
                {t('regradeApply')}
              </Button>
            </div>
            {regradePreview ? (
              regradePreview.changes.filter((c) => c.changed).length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('regradeNoChanges')}</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {regradePreview.changes
                    .filter((c) => c.changed)
                    .map((c) => (
                      <li key={c.examAttemptId}>
                        {t('regradeChangeLine', {
                          number: c.attemptNumber,
                          student: roster.find((m) => m.userId === c.userId)?.displayName ?? c.userId,
                          from: c.oldSumGrades ?? 0,
                          to: c.newSumGrades ?? 0,
                        })}
                      </li>
                    ))}
                </ul>
              )
            ) : null}
            {regradeLog && regradeLog.length ? (
              <div>
                <h3 className="text-sm font-medium">{t('regradeLogTitle')}</h3>
                <ul className="text-sm">
                  {regradeLog.map((entry) => (
                    <li key={entry.id}>
                      {t('regradeLogLine', { date: new Date(entry.createdAt).toLocaleString(), count: entry.items.length })}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {permissions.manageOverrides ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('quizOverridesTitle')}</CardTitle>
            <CardDescription>{t('quizOverridesDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {ovError ? (
              <Alert variant="destructive">
                <AlertDescription>{ovError}</AlertDescription>
              </Alert>
            ) : null}
            <ul className="space-y-2">
              {overrides.map((ov) => (
                <li key={ov.id} data-testid={`override-${ov.id}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>
                    <span className="font-medium">{ov.groupName ?? ov.userName ?? ov.groupId ?? ov.userId}</span>
                    {ov.userId && ov.timeOpen ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">{t('quizMakeupBadge')}</span>
                    ) : null}
                    <span className="block text-xs text-muted-foreground">
                      {[
                        `${t('quizOverrideWindowLabel')}: ${ov.timeOpen ? new Date(ov.timeOpen).toLocaleString() : t('quizOverrideInherit')} → ${ov.timeClose ? new Date(ov.timeClose).toLocaleString() : t('quizOverrideInherit')}`,
                        ov.timeLimitSeconds ? t('quizOverrideLimitLabel', { minutes: Math.round(ov.timeLimitSeconds / 60) }) : null,
                        ov.attempts !== null ? t('quizOverrideAttemptsLabel', { count: ov.attempts === 0 ? t('quizUnlimited') : ov.attempts }) : null,
                        ov.hasPassword ? t('quizOverrideHasPassword') : null,
                        ov.reason ? t('quizOverrideReasonLabel', { reason: ov.reason }) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => startEditOverride(ov)}>
                    {t('quizOverrideEdit')}
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void removeOverride(ov)}>
                    {t('quizOverrideRemove')}
                  </Button>
                </li>
              ))}
              {overridesLoaded && overrides.length === 0 ? (
                <li className="text-sm text-muted-foreground">{t('quizOverridesEmpty')}</li>
              ) : null}
            </ul>

            <form onSubmit={(e) => void submitOverride(e)} className="space-y-3">
              {editingOverride ? (
                <p className="text-sm font-medium">
                  {editingOverride.groupName ?? editingOverride.userName ?? editingOverride.groupId ?? editingOverride.userId}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Select
                    items={{ user: t('quizOverrideTargetUser'), group: t('quizOverrideTargetGroup') }}
                    value={ovTargetKind}
                    onValueChange={(v) => setOvTargetKind(v === 'group' ? 'group' : 'user')}
                  >
                    <SelectTrigger aria-label={t('quizOverrideTargetUser')} className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">{t('quizOverrideTargetUser')}</SelectItem>
                      <SelectItem value="group">{t('quizOverrideTargetGroup')}</SelectItem>
                    </SelectContent>
                  </Select>
                  {ovTargetKind === 'user' ? (
                    <Select
                      items={Object.fromEntries(
                        roster.filter((m) => m.role === 'student').map((m) => [m.userId, m.displayName]),
                      )}
                      value={ovUserId === '' ? null : ovUserId}
                      onValueChange={(v) => setOvUserId(v ?? '')}
                    >
                      <SelectTrigger aria-label={t('quizOverridePickStudent')} className="w-64">
                        <SelectValue placeholder={t('quizOverridePickStudent')} />
                      </SelectTrigger>
                      <SelectContent>
                        {roster
                          .filter((m) => m.role === 'student')
                          .map((m) => (
                            <SelectItem key={m.userId} value={m.userId}>{m.displayName}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Select
                      items={Object.fromEntries(groups.map((g) => [g.id, g.name]))}
                      value={ovGroupId === '' ? null : ovGroupId}
                      onValueChange={(v) => setOvGroupId(v ?? '')}
                    >
                      <SelectTrigger aria-label={t('quizOverridePickGroup')} className="w-64">
                        <SelectValue placeholder={t('quizOverridePickGroup')} />
                      </SelectTrigger>
                      <SelectContent>
                        {groups.map((g) => (
                          <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                <Field className="w-auto">
                  <FieldLabel htmlFor="ov-open">{t('quizOverrideWindowOpen')}</FieldLabel>
                  <Input id="ov-open" type="datetime-local" value={ovTimeOpen} onChange={(e) => setOvTimeOpen(e.target.value)} />
                </Field>
                <Field className="w-auto">
                  <FieldLabel htmlFor="ov-close">{t('quizOverrideWindowClose')}</FieldLabel>
                  <Input id="ov-close" type="datetime-local" value={ovTimeClose} onChange={(e) => setOvTimeClose(e.target.value)} />
                </Field>
                <Field className="w-auto">
                  <FieldLabel htmlFor="ov-limit">{t('quizOverrideLimit')}</FieldLabel>
                  <Input id="ov-limit" value={ovLimitMinutes} onChange={(e) => setOvLimitMinutes(e.target.value)} />
                </Field>
                <Field className="w-auto">
                  <FieldLabel htmlFor="ov-attempts">{t('quizOverrideAttempts')}</FieldLabel>
                  <Input id="ov-attempts" value={ovAttempts} onChange={(e) => setOvAttempts(e.target.value)} />
                </Field>
                <Field className="w-auto">
                  <FieldLabel htmlFor="ov-password">{t('quizOverridePassword')}</FieldLabel>
                  <Input id="ov-password" placeholder={t('quizOverridePasswordPlaceholder')} value={ovPassword} onChange={(e) => setOvPassword(e.target.value)} />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="ov-reason">{t('quizOverrideReason')}</FieldLabel>
                <Input id="ov-reason" value={ovReason} onChange={(e) => setOvReason(e.target.value)} />
                <p className="text-xs text-muted-foreground">{t('quizOverrideReasonHint')}</p>
              </Field>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {editingOverride ? t('quizOverrideUpdate') : t('quizOverrideCreate')}
                </Button>
                {editingOverride ? (
                  <Button type="button" variant="outline" disabled={busy} onClick={resetOverrideForm}>
                    {t('quizOverrideCancelEdit')}
                  </Button>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-sm">
        <Link to={`/courses/${courseId}`}>{t('quizBackToCourse')}</Link>
      </p>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default function QuizRoute() {
  return <QuizPage />;
}

/**
 * clientLoader (F-01 đợt 1 + bổ sung clientLoader, rà soát #133):
 * prefetch lần ghim (kèm tên slot) vào QueryClient singleton (đúng
 * khoá factory) trước khi component mount. prefetchQuery không ném
 * lỗi: tải hỏng thì component tự xử lý qua useQuery.
 */
export async function clientLoader({ params }: { params: Record<string, string | undefined> }) {
  if (params.pinId) {
    await queryClient.prefetchQuery(examPinQueryOptions(params.pinId));
  }
  return null;
}

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Bài kiểm tra');
}
