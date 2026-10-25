import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  extractRichTextPlainText,
  type CourseGroup,
  type CourseRosterMember,
  type QuestionCategory,
  type QuestionView,
  type QuizAttemptSummary,
  type QuizOverrideView,
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
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiJson, ApiError } from '#lib/api';

/** Hình dạng trả về của GET /quizzes/:id (trang thông tin theo người xem). */
interface QuizForUser {
  quiz: QuizView;
  myAttempts: QuizAttemptSummary[];
  myGrade: number | null;
  canAttempt: boolean;
  attemptBlockedReason: string | null;
  inProgressAttemptId: string | null;
  /** Cài đặt hiệu lực của chính người xem sau khi hợp nhất ghi đè (API trả sẵn). */
  effective: {
    timeOpen: string | null;
    timeClose: string | null;
    timeLimitSeconds: number | null;
    attemptsAllowed: number;
    passwordRequired: boolean;
    nextAttemptAt: string | null;
  };
  permissions: { manage: boolean; manageOverrides: boolean; grade: boolean; viewReports: boolean; preview: boolean; attempt: boolean };
}

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
 * Trang hoạt động Quiz: thông tin đề cho mọi người xem được; học sinh
 * bắt đầu/tiếp tục lượt làm và xem điểm của mình; giáo viên có quyền
 * manage thì cài đặt đề và dựng đề (slots) ngay tại trang; giáo viên có
 * viewreports đi tiếp sang trang kết quả lớp.
 */
export function QuizPage() {
  const { t } = useTranslation('app');
  const { id: courseId, quizId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<QuizForUser | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  // Dựng đề: ngân hàng câu hỏi + lựa chọn đang soạn.
  const [categories, setCategories] = useState<QuestionCategory[]>([]);
  /** Danh mục đã tải xong hay chưa — hai form dựng đề chỉ render khi đã có danh sách, để ô chọn danh mục không bao giờ mở ra rỗng rồi đua với lượt tải (điểm chặn 5, PR #83). */
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [bankQuestions, setBankQuestions] = useState<QuestionView[]>([]);
  const [pickCategoryId, setPickCategoryId] = useState('');
  const [pickQuestionId, setPickQuestionId] = useState('');
  const [pickMaxMark, setPickMaxMark] = useState('');
  const [randomCategoryId, setRandomCategoryId] = useState('');
  const [randomMaxMark, setRandomMaxMark] = useState('1');
  /** Tên câu/category của các slot hiện có (tra từ ngân hàng để hiển thị). */
  const [slotNames, setSlotNames] = useState<Record<string, string>>({});
  /** Giá trị điểm đang sửa theo slot id. */
  const [slotMarks, setSlotMarks] = useState<Record<string, string>>({});

  // Ghi đè (chỉ người có quiz:manageoverrides dùng): danh sách + dữ liệu chọn đích + form tạo/sửa dùng chung.
  const [overrides, setOverrides] = useState<QuizOverrideView[]>([]);
  const [overridesLoaded, setOverridesLoaded] = useState(false);
  const [roster, setRoster] = useState<CourseRosterMember[]>([]);
  const [groups, setGroups] = useState<CourseGroup[]>([]);
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

  const reload = useCallback(async () => {
    const fresh = await apiJson<QuizForUser>(`/api/v1/quizzes/${quizId}`);
    setData(fresh);
    setName(fresh.quiz.name);
    setIntro(fresh.quiz.intro);
    setTimeOpen(toLocalInput(fresh.quiz.timeOpen));
    setTimeClose(toLocalInput(fresh.quiz.timeClose));
    setTimeLimitMinutes(fresh.quiz.timeLimitSeconds ? String(Math.round(fresh.quiz.timeLimitSeconds / 60)) : '');
    setAttemptsAllowed(String(fresh.quiz.attemptsAllowed));
    setGradeMethod(fresh.quiz.gradeMethod);
    setGrade(String(fresh.quiz.grade));
    setShuffleAnswers(fresh.quiz.shuffleAnswers);
    setSlotMarks(Object.fromEntries(fresh.quiz.slots.map((s) => [s.id, String(s.maxMark)])));
    // Tra tên cho slot cố định/slot ngẫu nhiên để bảng dựng đề đọc được.
    const names: Record<string, string> = {};
    await Promise.all(
      fresh.quiz.slots.map(async (s) => {
        try {
          if (s.questionId) {
            const q = await apiJson<QuestionView>(`/api/v1/questions/${s.questionId}`);
            names[s.id] = q.question.name;
          }
        } catch { /* tên chỉ để hiển thị */ }
      }),
    );
    setSlotNames(names);
  }, [quizId]);

  useEffect(() => {
    void reload().catch(() => setError(t('quizLoadFailed')));
  }, [reload, t]);

  useEffect(() => {
    if (!data?.permissions.manage) return;
    void apiJson<QuestionCategory[]>('/api/v1/questions/categories')
      .then(setCategories)
      .catch(() => undefined)
      .finally(() => setCategoriesLoaded(true));
  }, [data?.permissions.manage]);

  useEffect(() => {
    if (!pickCategoryId) { setBankQuestions([]); return; }
    void apiJson<QuestionView[]>(`/api/v1/questions/categories/${pickCategoryId}/questions`)
      .then(setBankQuestions)
      .catch(() => setBankQuestions([]));
  }, [pickCategoryId]);

  const reloadOverrides = useCallback(async () => {
    const rows = await apiJson<QuizOverrideView[]>(`/api/v1/quizzes/${quizId}/overrides`);
    setOverrides(rows);
  }, [quizId]);

  useEffect(() => {
    if (!data?.permissions.manageOverrides) return;
    void reloadOverrides()
      .catch(() => setOvError(t('quizOverridesLoadFailed')))
      .finally(() => setOverridesLoaded(true));
    void apiJson<{ members: CourseRosterMember[] }>(`/api/v1/messages/courses/${courseId}/members?limit=100`)
      .then((res) => setRoster(res.members))
      .catch(() => undefined);
    void apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`)
      .then(setGroups)
      .catch(() => undefined);
  }, [data?.permissions.manageOverrides, reloadOverrides, courseId, t]);

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
        apiJson(`/api/v1/quizzes/${quizId}/overrides/${target.id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
      );
    } else {
      await actOverride(() =>
        apiJson(`/api/v1/quizzes/${quizId}/overrides`, {
          method: 'POST',
          body: JSON.stringify({ ...(ovTargetKind === 'user' ? { userId: ovUserId } : { groupId: ovGroupId }), ...fields }),
        }),
      );
    }
  }

  async function removeOverride(ov: QuizOverrideView) {
    if (editingOverride?.id === ov.id) resetOverrideForm();
    await actOverride(() => apiJson(`/api/v1/quizzes/${quizId}/overrides/${ov.id}`, { method: 'DELETE' }));
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
    await act(() =>
      apiJson(`/api/v1/quizzes/${quizId}`, {
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
        }),
      }),
    );
  }

  async function addFixedSlot(event: FormEvent) {
    event.preventDefault();
    if (!pickQuestionId) return;
    await act(() =>
      apiJson(`/api/v1/quizzes/${quizId}/slots`, {
        method: 'POST',
        body: JSON.stringify({
          questionId: pickQuestionId,
          ...(pickMaxMark.trim() ? { maxMark: Number(pickMaxMark) } : {}),
        }),
      }),
    );
    setPickMaxMark('');
  }

  async function addRandomSlot(event: FormEvent) {
    event.preventDefault();
    if (!randomCategoryId) return;
    await act(() =>
      apiJson(`/api/v1/quizzes/${quizId}/slots`, {
        method: 'POST',
        body: JSON.stringify({ categoryId: randomCategoryId, maxMark: Number(randomMaxMark) || 1 }),
      }),
    );
  }

  async function startAttempt(preview: boolean) {
    setActionError(null);
    try {
      const view = await apiJson<{ attempt: { id: string } }>(`/api/v1/quizzes/${quizId}/attempts`, {
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
              <Button type="button" variant="outline" render={<Link to={`/courses/${courseId}/quizzes/${quizId}/results`} />}>
                {t('quizViewResults')}
              </Button>
            ) : null}
            {permissions.grade ? (
              <Button type="button" variant="outline" render={<Link to={`/courses/${courseId}/quizzes/${quizId}/paper`} />}>
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
        </CardContent>
      </Card>

      {permissions.manage ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('quizBuildTitle')}</CardTitle>
              <CardDescription>{t('quizBuildDescription', { total: quiz.sumGrades })}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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
                    {s.hasNewerVersion && s.latestVersion !== null ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            apiJson(`/api/v1/quizzes/${quizId}/slots/${s.id}/upgrade-version`, { method: 'POST', body: '{}' }),
                          )
                        }
                      >
                        {t('slotUpgradeVersion', { version: s.latestVersion })}
                      </Button>
                    ) : null}
                    <Label htmlFor={`slot-mark-${s.id}`}>{t('quizSlotMark')}</Label>
                    <Input
                      id={`slot-mark-${s.id}`}
                      className="w-24"
                      value={slotMarks[s.id] ?? ''}
                      onChange={(e) => setSlotMarks((prev) => ({ ...prev, [s.id]: e.target.value }))}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          apiJson(`/api/v1/quizzes/${quizId}/slots/${s.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ maxMark: Number(slotMarks[s.id]) || s.maxMark }),
                          }),
                        )
                      }
                    >
                      {t('quizSlotSaveMark')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || s.slot === 1}
                      onClick={() =>
                        void act(() =>
                          apiJson(`/api/v1/quizzes/${quizId}/slots/${s.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ slot: s.slot - 1 }),
                          }),
                        )
                      }
                    >
                      {t('quizSlotMoveUp')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || s.slot === quiz.slots.length}
                      onClick={() =>
                        void act(() =>
                          apiJson(`/api/v1/quizzes/${quizId}/slots/${s.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ slot: s.slot + 1 }),
                          }),
                        )
                      }
                    >
                      {t('quizSlotMoveDown')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void act(() => apiJson(`/api/v1/quizzes/${quizId}/slots/${s.id}`, { method: 'DELETE' }))
                      }
                    >
                      {t('quizSlotRemove')}
                    </Button>
                  </li>
                ))}
                {quiz.slots.length === 0 ? <li className="text-sm text-muted-foreground">{t('quizNoQuestions')}</li> : null}
              </ul>

              {categoriesLoaded && (<form onSubmit={(e) => void addFixedSlot(e)} className="space-y-2">
                <h4 className="text-sm font-medium">{t('quizAddFixedSlot')}</h4>
                <div className="flex flex-wrap gap-2">
                  <Select
                    items={Object.fromEntries(categories.map((c) => [c.id, c.name]))}
                    value={pickCategoryId === '' ? null : pickCategoryId}
                    onValueChange={(v) => { setPickCategoryId(v ?? ''); setPickQuestionId(''); }}
                  >
                    <SelectTrigger aria-label={t('quizPickCategory')} className="w-52">
                      <SelectValue placeholder={t('quizPickCategory')} />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    items={Object.fromEntries(
                      bankQuestions.map((q) => [q.question.id, `${q.question.name} (${q.question.qtype})`]),
                    )}
                    value={pickQuestionId === '' ? null : pickQuestionId}
                    onValueChange={(v) => setPickQuestionId(v ?? '')}
                  >
                    <SelectTrigger aria-label={t('quizPickQuestion')} className="w-52">
                      <SelectValue placeholder={t('quizPickQuestion')} />
                    </SelectTrigger>
                    <SelectContent>
                      {bankQuestions.map((q) => (
                        <SelectItem key={q.question.id} value={q.question.id}>
                          {q.question.name} ({q.question.qtype})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label={t('quizSlotMark')}
                    className="w-24"
                    placeholder={t('quizSlotMarkPlaceholder')}
                    value={pickMaxMark}
                    onChange={(e) => setPickMaxMark(e.target.value)}
                  />
                  <Button type="submit" variant="outline" disabled={busy || !pickQuestionId}>
                    {t('quizAddSlot')}
                  </Button>
                </div>
              </form>)}

              {categoriesLoaded && (<form onSubmit={(e) => void addRandomSlot(e)} className="space-y-2">
                <h4 className="text-sm font-medium">{t('quizAddRandomSlot')}</h4>
                <div className="flex flex-wrap gap-2">
                  <Select
                    items={Object.fromEntries(categories.map((c) => [c.id, c.name]))}
                    value={randomCategoryId === '' ? null : randomCategoryId}
                    onValueChange={(v) => setRandomCategoryId(v ?? '')}
                  >
                    <SelectTrigger aria-label={t('quizPickCategory')} className="w-52">
                      <SelectValue placeholder={t('quizPickCategory')} />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label={t('quizSlotMark')}
                    className="w-24"
                    value={randomMaxMark}
                    onChange={(e) => setRandomMaxMark(e.target.value)}
                  />
                  <Button type="submit" variant="outline" disabled={busy || !randomCategoryId}>
                    {t('quizAddRandomSubmit')}
                  </Button>
                </div>
              </form>)}
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
                  </div>
                  <div className="flex justify-end">
                    <Button type="submit" disabled={busy}>{t('quizSettingsSave')}</Button>
                  </div>
                </FieldGroup>
              </form>
            </CardContent>
          </Card>
        </>
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

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Bài kiểm tra');
}
