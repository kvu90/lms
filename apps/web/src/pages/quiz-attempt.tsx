import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  extractRichTextPlainText,
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

/** Một câu trong lượt làm như GET /quiz-attempts/:id trả về (nội dung của version đã pin). */
interface AttemptQuestion {
  slot: number;
  page: number;
  questionAttemptId: string;
  questionId: string;
  qtype: string;
  name: string;
  questionText: RichTextDocument;
  stimulus: { id: string; content: RichTextDocument } | null;
  answers: { id: string; text: RichTextDocument }[];
  options: Record<string, unknown> | null;
  maxMark: number;
  state: string;
  response: string | null;
  fraction: number | null;
  mark: number | null;
  rightAnswer: string | null;
}

/** Hình dạng trả về của các endpoint lượt làm quiz. */
interface AttemptView {
  attempt: {
    id: string; quizId: string; userId: string; attemptNumber: number; state: string;
    preview: boolean; timeStart: string; timeFinish: string | null;
    sumGrades: number | null; grade: number | null;
  };
  quiz: QuizView;
  questions: AttemptQuestion[];
  totalMax: number;
  pendingManualCount: number;
  closedDueToTimeLimit: boolean;
}

function plainText(doc: RichTextDocument | null | undefined): string {
  return doc ? extractRichTextPlainText(doc) : '';
}

/** Xáo trộn ổn định trong phiên (seeded theo id) để thứ tự đáp án không nhảy mỗi lần render. */
function shuffled<T>(items: T[], seedText: string): T[] {
  let seed = 0;
  for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Trang làm bài quiz: câu hỏi theo trang của đề, trả lời theo từng qtype
 * (multichoice một/nhiều lựa chọn, truefalse, shortanswer, essay), lưu
 * từng câu qua question engine, nộp bài để chốt điểm. Khi lượt đã nộp,
 * trang chuyển thành màn hình kết quả: điểm từng câu, đáp án đúng và
 * trạng thái chờ chấm tay của essay. Hết giờ làm bài thì server tự chốt
 * ở tương tác kế tiếp — đồng hồ trên trang chỉ để học sinh theo dõi.
 */
export function QuizAttemptPage() {
  const { t } = useTranslation('app');
  const { attemptId } = useParams();
  const [view, setView] = useState<AttemptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const reload = useCallback(async () => {
    const fresh = await apiJson<AttemptView>(`/api/v1/quiz-attempts/${attemptId}`);
    setView(fresh);
    setResponses((prev) => {
      const next = { ...prev };
      for (const q of fresh.questions) {
        if (next[q.questionAttemptId] === undefined && q.response !== null) next[q.questionAttemptId] = q.response;
      }
      return next;
    });
  }, [attemptId]);

  useEffect(() => {
    void reload().catch(() => setError(t('quizAttemptLoadFailed')));
  }, [reload, t]);

  const inProgress = view?.attempt.state === 'inprogress';
  const deadline = useMemo(() => {
    if (!view?.quiz.timeLimitSeconds || !inProgress) return null;
    return new Date(view.attempt.timeStart).getTime() + view.quiz.timeLimitSeconds * 1000;
  }, [view, inProgress]);

  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const remainingSeconds = deadline ? Math.max(0, Math.floor((deadline - nowTick) / 1000)) : null;
  useEffect(() => {
    if (remainingSeconds === 0 && inProgress) void reload().catch(() => undefined);
  }, [remainingSeconds, inProgress, reload]);

  const pages = useMemo(() => {
    if (!view) return [1];
    return [...new Set(view.questions.map((q) => q.page))].sort((a, b) => a - b);
  }, [view]);
  const currentPage = pages.includes(page) ? page : (pages[0] ?? 1);

  async function act(run: () => Promise<unknown>) {
    setActionError(null);
    setBusy(true);
    try {
      await run();
      await reload();
    } catch {
      setActionError(t('quizAttemptActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function saveResponse(q: AttemptQuestion) {
    await act(() =>
      apiJson(`/api/v1/quiz-attempts/${attemptId}/responses`, {
        method: 'POST',
        body: JSON.stringify({
          questionAttemptId: q.questionAttemptId,
          response: (responses[q.questionAttemptId] ?? '').trim() ? responses[q.questionAttemptId] : null,
        }),
      }),
    );
  }

  async function submitAll() {
    await act(() => apiJson(`/api/v1/quiz-attempts/${attemptId}/submit`, { method: 'POST', body: '{}' }));
  }

  if (error)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <p role="alert">{error}</p>
      </main>
    );
  if (!view)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">{t('quizAttemptLoading')}</main>
    );

  const { quiz, attempt } = view;
  const submitted = attempt.state !== 'inprogress';
  const pageQuestions = view.questions.filter((q) => q.page === currentPage);

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{quiz.name}</CardTitle>
          <CardDescription>
            {t('quizAttemptHeaderLine', { number: attempt.attemptNumber, state: t(`quizAttemptState_${attempt.state}`) })}
            {attempt.preview ? ` (${t('quizPreviewBadge')})` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {remainingSeconds !== null ? (
            <p className="text-sm font-medium" data-testid="quiz-countdown">
              {t('quizTimeRemaining', { minutes: Math.floor(remainingSeconds / 60), seconds: remainingSeconds % 60 })}
            </p>
          ) : null}
          {view.closedDueToTimeLimit ? <p role="alert">{t('quizClosedByTimeLimit')}</p> : null}
          {submitted ? (
            <div className="text-sm">
              <p>
                {t('quizResultSummary', {
                  sum: attempt.sumGrades ?? 0,
                  total: view.totalMax,
                  grade: attempt.grade ?? 0,
                  max: quiz.grade,
                })}
              </p>
              {attempt.state === 'needsgrading' ? <p>{t('quizWaitingManualGrade', { count: view.pendingManualCount })}</p> : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('quizAttemptInstructions')}</p>
          )}
          {actionError ? <p role="alert">{actionError}</p> : null}
          {pages.length > 1 ? (
            <div className="flex gap-2">
              {pages.map((p) => (
                <Button key={p} type="button" variant={p === currentPage ? 'default' : 'outline'} size="sm" onClick={() => setPage(p)}>
                  {t('quizPageLabel', { page: p })}
                </Button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {pageQuestions.map((q) => (
        <Card key={q.questionAttemptId} data-testid={`quiz-question-${q.slot}`}>
          <CardHeader>
            <CardTitle className="text-base">{t('quizQuestionLine', { slot: q.slot, max: q.maxMark })}</CardTitle>
            <CardDescription>{q.name}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {q.stimulus ? (
              <div className="rounded-md border p-3">
                <h4 className="text-sm font-medium">{t('stimulusHeading')}</h4>
                <p className="text-sm whitespace-pre-wrap">{plainText(q.stimulus.content)}</p>
              </div>
            ) : null}
            <p className="text-sm whitespace-pre-wrap">{plainText(q.questionText)}</p>
            <QuestionAnswerInput
              q={q}
              quizShuffle={quiz.shuffleAnswers}
              disabled={!inProgress || busy}
              value={responses[q.questionAttemptId] ?? q.response ?? ''}
              onChange={(value) => setResponses((prev) => ({ ...prev, [q.questionAttemptId]: value }))}
            />
            {inProgress ? (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void saveResponse(q)}>
                {t('quizSaveAnswer')}
              </Button>
            ) : null}
            {submitted ? (
              <div className="text-sm">
                <p>
                  {q.state === 'needsgrading'
                    ? t('quizQuestionWaitingGrade')
                    : t('quizQuestionMark', { mark: q.mark ?? 0, max: q.maxMark })}
                </p>
                {q.rightAnswer ? <p className="text-muted-foreground">{t('quizRightAnswer', { answer: q.rightAnswer })}</p> : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}

      {inProgress ? (
        <div>
          <Button type="button" disabled={busy} onClick={() => void submitAll()}>
            {t('quizSubmitAttempt')}
          </Button>
        </div>
      ) : null}
      <p className="text-sm">
        <Link to={`/courses/${quiz.courseId}/quizzes/${quiz.id}`}>{t('quizBackToQuiz')}</Link>
      </p>
    </main>
  );
}

/** Bộ nhập câu trả lời theo qtype — response luôn là chuỗi theo quy ước của question engine. */
function QuestionAnswerInput(props: {
  q: AttemptQuestion;
  quizShuffle: boolean;
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('app');
  const { q, disabled, value, onChange } = props;
  const optionShuffle = q.options?.shuffleAnswers === true;
  const answers = useMemo(
    () => (props.quizShuffle || optionShuffle ? shuffled(q.answers, q.questionAttemptId) : q.answers),
    [props.quizShuffle, optionShuffle, q.answers, q.questionAttemptId],
  );

  if (q.qtype === 'multichoice') {
    const single = q.options?.single !== false;
    const selected = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
    return (
      <div className="space-y-2">
        {answers.map((a) => {
          const label = plainText(a.text);
          const checked = single ? value === a.id : selected.has(a.id);
          return (
            <label key={a.id} className="flex items-center gap-2 text-sm">
              <input
                type={single ? 'radio' : 'checkbox'}
                name={`q-${q.questionAttemptId}`}
                checked={checked}
                disabled={disabled}
                onChange={() => {
                  if (single) onChange(a.id);
                  else {
                    const next = new Set(selected);
                    if (next.has(a.id)) next.delete(a.id);
                    else next.add(a.id);
                    onChange([...next].join(','));
                  }
                }}
              />
              {label}
            </label>
          );
        })}
      </div>
    );
  }
  if (q.qtype === 'truefalse') {
    return (
      <div className="space-y-2">
        {(['true', 'false'] as const).map((side) => (
          <label key={side} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`q-${q.questionAttemptId}`}
              checked={value === side}
              disabled={disabled}
              onChange={() => onChange(side)}
            />
            {side === 'true' ? t('quizTrueLabel') : t('quizFalseLabel')}
          </label>
        ))}
      </div>
    );
  }
  if (q.qtype === 'essay') {
    return (
      <div className="space-y-2">
        <Label htmlFor={`answer-${q.questionAttemptId}`}>{t('quizEssayLabel')}</Label>
        <textarea
          id={`answer-${q.questionAttemptId}`}
          className="w-full rounded-md border p-2 text-sm"
          rows={Number(q.options?.responseFieldLines ?? 10)}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Label htmlFor={`answer-${q.questionAttemptId}`}>{t('quizShortAnswerLabel')}</Label>
      <Input
        id={`answer-${q.questionAttemptId}`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default function QuizAttemptRoute() {
  return <QuizAttemptPage />;
}
