import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { type PinRegradeLogEntry, type PinRegradeResult, type PinVersionUpdatePreview } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { PageHeader, PageShell } from '../components/page-shell';
import { AttemptsPanel } from '../components/quiz/attempts-panel';
import { OverridesPanel } from '../components/quiz/overrides-panel';
import { PinPanel } from '../components/quiz/pin-panel';
import { RegradePanel } from '../components/quiz/regrade-panel';
import { SettingsForm } from '../components/quiz/settings-form';
import { toLocalInput } from '../components/quiz/utils';
import '../i18n';
import { ApiError } from '#lib/api';
import {
  examPinQueryOptions,
  examPinVersionUpdateQueryOptions,
  regradeQuestionVersionsQueryOptions,
  useApplyExamPinVersionUpdate,
  useCourseRoster,
  useExamPin,
  useExamPinMyRegrades,
  useExamPinOverrides,
  useExamPinRegrades,
  useExamSource,
  useRunExamPinRegrade,
  useStartExamPinAttempt,
  useUpdateExamPinSettings,
} from '#lib/quiz-data';
import { courseGroupsQueryOptions } from '#lib/progress-report-data';
import { queryClient } from '#lib/query-client';

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
  const [regradeError, setRegradeError] = useState<string | null>(null);

  // Lịch sử sửa điểm của chính người xem (API tự gác cổng công bố:
  // chưa công bố thì trả rỗng, mục này tự ẩn).
  const myRegradesQuery = useExamPinMyRegrades(quizId ?? '');
  const myRegrades = myRegradesQuery.data ?? [];

  // Nhật ký chấm lại của pin: query bật khi người xem có quyền chấm
  // (panel chấm lại dùng chung dữ kiện này); lỗi tải thì coi như
  // nhật ký rỗng như bản thủ công.
  const regradeLogQuery = useExamPinRegrades(quizId ?? '', !!data?.permissions.grade);
  const regradeLog: PinRegradeLogEntry[] | null = regradeLogQuery.isError ? [] : (regradeLogQuery.data ?? null);

  // Thông tin ĐỀ nguồn của lần ghim (tên + version hiện hành ở bank) — chỉ tải khi có quyền manage.
  const examInfo = useExamSource(data?.quiz.examId, !!data?.permissions.manage).data ?? null;

  // Ghi đè (chỉ người có quiz:manageoverrides dùng): danh sách + dữ liệu chọn đích + form tạo/sửa dùng chung.
  // Ghi đè + danh sách thành viên đích: chỉ tải khi có quyền quản ghi
  // đè. Nhóm của khoá dùng chung khoá factory courseGroups (F-03).
  const overridesQuery = useExamPinOverrides(quizId ?? '', !!data?.permissions.manageOverrides);
  const overrides = overridesQuery.data ?? [];
  const overridesLoaded = overridesQuery.isSuccess || overridesQuery.isError;
  const roster =
    useCourseRoster(courseId ?? '', !!(data?.permissions.manageOverrides || data?.permissions.grade)).data ?? [];
  const groups =
    useQuery({
      ...courseGroupsQueryOptions(courseId ?? ''),
      enabled: !!courseId && !!(data?.permissions.manage || data?.permissions.manageOverrides),
    }).data ?? [];

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

  // Nạp lại view lần ghim sau các thao tác ghi không qua đột biến
  // tự làm mới (chấm lại áp thật): refetch của query; lỗi refetch vẫn
  // ném ra để các nhánh bắt lỗi cũ chạy nguyên trạng.
  const reload = useCallback(async () => {
    const result = await refetch();
    if (result.error) throw result.error;
  }, [refetch]);

  // Các đột biến của trang lần ghim (F-01 của rà soát #133): cài
  // đặt, cập nhật version, chấm lại, bắt đầu lượt làm. (Đột biến
  // ghi đè nằm ở OverridesPanel cùng trạng thái form của khối đó.)
  const settingsMutation = useUpdateExamPinSettings(quizId ?? '');
  const versionUpdateMutation = useApplyExamPinVersionUpdate(quizId ?? '');
  const regradeMutation = useRunExamPinRegrade(quizId ?? '');
  const startAttemptMutation = useStartExamPinAttempt(quizId ?? '');

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    // Lỗi chế độ version phải hiện đúng lý do nghiệp vụ (chỉ luyện tập
    // mới được trôi) thay vì thông báo lỗi chung — API là nơi gác, ở
    // đây chỉ dịch mã lỗi của nó.
    setActionError(null);
    setBusy(true);
    try {
      await settingsMutation.mutateAsync({
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

  /** Tải xem trước cập nhật version (diff từng slot) cho lần ghim này — đọc theo yêu cầu qua fetchQuery. */
  async function loadUpdatePreview() {
    setUpdateError(null);
    setBusy(true);
    try {
      setUpdatePreview(await queryClient.fetchQuery(examPinVersionUpdateQueryOptions(quizId ?? '')));
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
      await versionUpdateMutation.mutateAsync(updatePreview.toExamVersionId);
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
      const versions = await queryClient.fetchQuery(regradeQuestionVersionsQueryOptions(questionId));
      setRegradeVersions(versions);
      const ready = versions.filter((v) => v.status === 'ready');
      setRegradeVersionId((ready.length ? ready[ready.length - 1]! : versions[versions.length - 1])?.id ?? '');
    } catch {
      setRegradeVersions([]);
      setRegradeVersionId('');
      setRegradeError(t('regradeFailed'));
    }
  }

  /** Đổi câu hỏi chấm lại: chốt câu được chọn và nạp các version của câu đó. */
  function handleRegradeQuestionChange(v: string | null) {
    setRegradeQuestionId(v ?? '');
    void loadRegradeVersions(v ?? '');
  }

  /** Chạy chấm lại (dryRun = chỉ xem trước điểm đổi, không ghi). */
  async function runRegrade(dryRun: boolean) {
    if (!regradeQuestionId || !regradeVersionId) return;
    setRegradeError(null);
    setBusy(true);
    try {
      const result = await regradeMutation.mutateAsync({
        questionId: regradeQuestionId,
        toVersionId: regradeVersionId,
        dryRun,
      });
      setRegradePreview(result);
      if (!dryRun) {
        await regradeLogQuery.refetch();
        await reload();
        void myRegradesQuery.refetch();
      }
    } catch {
      setRegradeError(t('regradeFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function startAttempt(preview: boolean) {
    setActionError(null);
    try {
      const view = await startAttemptMutation.mutateAsync(preview);
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
  return (
    <PageShell width="medium">
      <PageHeader title={quiz.name} description={t('quizIntroLine', { total: quiz.sumGrades, grade: quiz.grade })} />
      <AttemptsPanel
        courseId={courseId}
        quizId={quizId}
        data={data}
        myRegrades={myRegrades}
        actionError={actionError}
        startAttempt={startAttempt}
      />

      {permissions.manage ? (
        <>
          <PinPanel
            quiz={quiz}
            slotNames={slotNames}
            examInfo={examInfo}
            groups={groups}
            updatePreview={updatePreview}
            updateError={updateError}
            busy={busy}
            loadUpdatePreview={loadUpdatePreview}
            applyUpdate={applyUpdate}
            setUpdatePreview={setUpdatePreview}
          />
          <SettingsForm
            name={name}
            intro={intro}
            timeOpen={timeOpen}
            timeClose={timeClose}
            timeLimitMinutes={timeLimitMinutes}
            attemptsAllowed={attemptsAllowed}
            gradeMethod={gradeMethod}
            grade={grade}
            shuffleAnswers={shuffleAnswers}
            versionMode={versionMode}
            busy={busy}
            saveSettings={saveSettings}
            setName={setName}
            setIntro={setIntro}
            setTimeOpen={setTimeOpen}
            setTimeClose={setTimeClose}
            setTimeLimitMinutes={setTimeLimitMinutes}
            setAttemptsAllowed={setAttemptsAllowed}
            setGradeMethod={setGradeMethod}
            setGrade={setGrade}
            setShuffleAnswers={setShuffleAnswers}
            setVersionMode={setVersionMode}
          />
        </>
      ) : null}

      {permissions.grade ? (
        <RegradePanel
          quiz={quiz}
          slotNames={slotNames}
          roster={roster}
          regradeError={regradeError}
          regradeQuestionId={regradeQuestionId}
          regradeVersions={regradeVersions}
          regradeVersionId={regradeVersionId}
          regradePreview={regradePreview}
          regradeLog={regradeLog}
          busy={busy}
          onRegradeQuestionChange={handleRegradeQuestionChange}
          setRegradeVersionId={setRegradeVersionId}
          runRegrade={runRegrade}
        />
      ) : null}

      {permissions.manageOverrides ? (
        <OverridesPanel
          pinId={quizId ?? ''}
          overrides={overrides}
          overridesLoaded={overridesLoaded}
          overridesIsError={overridesQuery.isError}
          overridesErrorUpdatedAt={overridesQuery.errorUpdatedAt}
          roster={roster}
          groups={groups}
          busy={busy}
          setBusy={setBusy}
        />
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
