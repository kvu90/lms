import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  extractRichTextPlainText,
  type QuestionCategory,
  type QuestionView,
  type QuizAttemptSummary,
  type QuizView,
  type RichTextDocument,
} from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';

/** Hình dạng trả về của GET /quizzes/:id (trang thông tin theo người xem). */
interface QuizForUser {
  quiz: QuizView;
  myAttempts: QuizAttemptSummary[];
  myGrade: number | null;
  canAttempt: boolean;
  attemptBlockedReason: string | null;
  inProgressAttemptId: string | null;
  permissions: { manage: boolean; grade: boolean; viewReports: boolean; preview: boolean; attempt: boolean };
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
      .catch(() => undefined);
  }, [data?.permissions.manage]);

  useEffect(() => {
    if (!pickCategoryId) { setBankQuestions([]); return; }
    void apiJson<QuestionView[]>(`/api/v1/questions/categories/${pickCategoryId}/questions`)
      .then(setBankQuestions)
      .catch(() => setBankQuestions([]));
  }, [pickCategoryId]);

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
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <p role="alert">{error}</p>
      </main>
    );
  if (!data)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">{t('quizLoading')}</main>
    );

  const { quiz, permissions } = data;
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
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{quiz.name}</CardTitle>
          <CardDescription>{t('quizIntroLine', { total: quiz.sumGrades, grade: quiz.grade })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {quiz.intro ? <p className="text-sm whitespace-pre-wrap">{quiz.intro}</p> : null}
          <ul className="text-sm text-muted-foreground">
            <li>{t('quizWindowLine', { open: quiz.timeOpen ? new Date(quiz.timeOpen).toLocaleString() : t('quizNoBound'), close: quiz.timeClose ? new Date(quiz.timeClose).toLocaleString() : t('quizNoBound') })}</li>
            <li>{t('quizTimeLimitLine', { minutes: quiz.timeLimitSeconds ? Math.round(quiz.timeLimitSeconds / 60) : t('quizNoTimeLimit') })}</li>
            <li>{t('quizAttemptsLine', { count: quiz.attemptsAllowed === 0 ? t('quizUnlimited') : quiz.attemptsAllowed })}</li>
            <li>{t('quizGradeMethodLine', { method: t(`quizGradeMethod_${quiz.gradeMethod}`) })}</li>
          </ul>
          {actionError ? <p role="alert">{actionError}</p> : null}
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
                    </span>
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

              <form onSubmit={(e) => void addFixedSlot(e)} className="space-y-2">
                <h4 className="text-sm font-medium">{t('quizAddFixedSlot')}</h4>
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label={t('quizPickCategory')}
                    value={pickCategoryId}
                    onChange={(e) => { setPickCategoryId(e.target.value); setPickQuestionId(''); }}
                  >
                    <option value="">{t('quizPickCategory')}</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <select
                    aria-label={t('quizPickQuestion')}
                    value={pickQuestionId}
                    onChange={(e) => setPickQuestionId(e.target.value)}
                  >
                    <option value="">{t('quizPickQuestion')}</option>
                    {bankQuestions.map((q) => (
                      <option key={q.question.id} value={q.question.id}>
                        {q.question.name} ({q.question.qtype})
                      </option>
                    ))}
                  </select>
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
              </form>

              <form onSubmit={(e) => void addRandomSlot(e)} className="space-y-2">
                <h4 className="text-sm font-medium">{t('quizAddRandomSlot')}</h4>
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label={t('quizPickCategory')}
                    value={randomCategoryId}
                    onChange={(e) => setRandomCategoryId(e.target.value)}
                  >
                    <option value="">{t('quizPickCategory')}</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
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
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('quizSettingsTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void saveSettings(e)} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="quiz-name">{t('quizSettingsName')}</Label>
                  <Input id="quiz-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="quiz-intro">{t('quizSettingsIntro')}</Label>
                  <Input id="quiz-intro" value={intro} onChange={(e) => setIntro(e.target.value)} />
                </div>
                <div className="flex flex-wrap gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="quiz-open">{t('quizSettingsOpen')}</Label>
                    <Input id="quiz-open" type="datetime-local" value={timeOpen} onChange={(e) => setTimeOpen(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="quiz-close">{t('quizSettingsClose')}</Label>
                    <Input id="quiz-close" type="datetime-local" value={timeClose} onChange={(e) => setTimeClose(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="quiz-limit">{t('quizSettingsTimeLimit')}</Label>
                    <Input id="quiz-limit" value={timeLimitMinutes} onChange={(e) => setTimeLimitMinutes(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="quiz-attempts">{t('quizSettingsAttempts')}</Label>
                    <Input id="quiz-attempts" value={attemptsAllowed} onChange={(e) => setAttemptsAllowed(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="quiz-grade">{t('quizSettingsGrade')}</Label>
                    <Input id="quiz-grade" value={grade} onChange={(e) => setGrade(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="quiz-method">{t('quizSettingsMethod')}</Label>
                    <select id="quiz-method" value={gradeMethod} onChange={(e) => setGradeMethod(e.target.value)}>
                      {(['highest', 'average', 'first', 'last'] as const).map((m) => (
                        <option key={m} value={m}>{t(`quizGradeMethod_${m}`)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end gap-2">
                    <input
                      id="quiz-shuffle"
                      type="checkbox"
                      checked={shuffleAnswers}
                      onChange={(e) => setShuffleAnswers(e.target.checked)}
                    />
                    <Label htmlFor="quiz-shuffle">{t('quizSettingsShuffle')}</Label>
                  </div>
                </div>
                <Button type="submit" disabled={busy}>{t('quizSettingsSave')}</Button>
              </form>
            </CardContent>
          </Card>
        </>
      ) : null}

      <p className="text-sm">
        <Link to={`/courses/${courseId}`}>{t('quizBackToCourse')}</Link>
      </p>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default function QuizRoute() {
  return <QuizPage />;
}
