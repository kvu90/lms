/**
 * Trang làm bài + xem lại lượt làm quiz (bề mặt học sinh).
 *
 * Flow tổng thể của module:
 * 1. Nạp view lượt làm từ `GET /quiz-attempts/:id` — view mang nội
 *    dung của các version câu hỏi ĐÃ PIN trong lần ghim (câu hỏi,
 *    stimulus, các lựa chọn) kèm hai trường phía đáp án theo mô hình
 *    giaokhoa (đợt port #248, lát P3 cấp dữ liệu, lát P7 hiển thị):
 *    `guidance` (hướng dẫn — hiện kèm câu hỏi ngay trong lúc làm,
 *    điểm quyết D-4) và `solution` (đáp án đúng dạng cấu trúc — API
 *    chỉ trả khi cổng xem lại `reviewRightAnswer` của lần ghim mở;
 *    cổng đóng thì trường là `null` và web không tự suy diễn đáp án
 *    từ bất kỳ nguồn nào khác).
 * 2. Khi lượt đang chạy: học sinh trả lời theo từng qtype, lưu từng
 *    câu qua engine (`POST /responses`), nộp bài (`POST /submit`) để
 *    chốt điểm; hết giờ thì server tự chốt ở tương tác kế tiếp.
 * 3. Khi lượt đã nộp, trang chuyển thành màn XEM LẠI: điểm từng câu,
 *    đáp án đúng được đánh dấu ngay trên lựa chọn/mệnh đề, khối "Lời
 *    giải" gồm đáp án đúng dạng chữ (`rightAnswer`, cùng cổng với
 *    `solution`) + feedback của đáp án đã chọn (cổng
 *    reviewSpecificFeedback) + generalFeedback (cổng
 *    reviewGeneralFeedback) + đáp án được chấp nhận của shortanswer /
 *    lời giải mẫu của essay (từ `solution`). Guidance vẫn hiện ở màn
 *    xem lại, cùng vị trí như lúc làm.
 *
 * Bất biến hiển thị: câu hỏi không có trường tên — nhãn của câu là
 * TRÍCH ĐOẠN nội dung (`questionExcerpt`); multichoice luôn là radio
 * chọn một (mô hình giaokhoa khoá đúng một đáp án đúng — quyết
 * 12:04 ngày 26/10/2026), không còn nhánh checkbox chọn-nhiều.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  extractRichTextPlainText,
  getTrueFalseStatements,
  type RichTextDocument,
} from '@lms/contracts';
import { RichTextView } from '@lms/editor';
// CSS của KaTeX nạp tại route module này (issue #503): trang làm bài
// hiển thị nội dung câu hỏi qua RichTextView — HTML công thức do KaTeX
// sinh cần bộ CSS này mới dựng đúng; nạp tại đây để CSS chỉ đi theo
// route làm bài thay vì mọi route như khi nạp ở root.
import 'katex/dist/katex.min.css';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Spinner } from '@lms/ui/components/spinner';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import {
  quizAttemptPageClientLoader,
  useQuizAttempt,
  useSaveQuizResponse,
  useSubmitQuizAttempt,
  type AttemptQuestion,
} from '#lib/quiz-data';

function plainText(doc: RichTextDocument | null | undefined): string {
  return doc ? extractRichTextPlainText(doc) : '';
}

/**
 * Tài liệu rich text có nội dung thật hay không: có chữ khác rỗng ở
 * bất kỳ mức lồng nào, hoặc chứa node mang nội dung phi văn bản (ảnh,
 * công thức). Dùng để quyết định có dựng khối "Hướng dẫn" hay không —
 * một tài liệu chỉ gồm paragraph rỗng (kiểu tài liệu trắng của
 * editor) không được dựng thành khối trống trên bề mặt học sinh.
 *
 * @param doc - Tài liệu cần kiểm (null/undefined = không có nội dung).
 * @returns `true` khi tài liệu có nội dung hiển thị được.
 */
function hasRichTextContent(doc: RichTextDocument | null | undefined): boolean {
  if (!doc) return false;
  const visit = (node: { type: string; text?: string; content?: unknown[] }): boolean => {
    if (typeof node.text === 'string' && node.text.trim() !== '') return true;
    if (node.type === 'image' || node.type === 'inlineMath' || node.type === 'blockMath') return true;
    return (node.content ?? []).some((child) =>
      visit(child as { type: string; text?: string; content?: unknown[] }),
    );
  };
  return visit(doc as { type: string; text?: string; content?: unknown[] });
}

/**
 * Id đáp án đúng của một câu từ `solution` dạng cấu trúc (chỉ
 * multichoice/truefalse một mệnh đề mới có biến thể này).
 *
 * @param q - Câu trong lượt làm.
 * @returns Id của dòng đáp án đúng, hoặc null khi cổng xem lại đóng /
 *   câu thuộc dạng có hình dạng solution khác.
 */
function solutionCorrectAnswerId(q: AttemptQuestion): string | null {
  return q.solution && 'correctAnswerId' in q.solution ? q.solution.correctAnswerId : null;
}

/**
 * Các đáp án được chấp nhận của câu shortanswer từ `solution` (màn
 * xem lại hiện nguyên danh sách này trong khối "Lời giải").
 *
 * @param q - Câu trong lượt làm.
 * @returns Mảng đáp án được chấp nhận, hoặc null khi không có.
 */
function solutionAcceptedAnswers(q: AttemptQuestion): string[] | null {
  return q.solution && 'acceptedAnswers' in q.solution ? q.solution.acceptedAnswers : null;
}

/**
 * Lời giải mẫu của câu essay từ `solution` (biến thể `{answer}` —
 * dạng nhiều ý theo partId thuộc điểm quyết D-6 đang hoãn, chưa có
 * ở đợt này).
 *
 * @param q - Câu trong lượt làm.
 * @returns Tài liệu lời giải mẫu, hoặc null khi không có.
 */
function solutionModelAnswer(q: AttemptQuestion): RichTextDocument | null {
  return q.solution && 'answer' in q.solution ? q.solution.answer : null;
}

/**
 * Đáp án Đ/S của từng mệnh đề trong câu truefalse TF-A từ
 * `solution.statements` (màn xem lại hiện đúng/sai TỪNG Ý).
 *
 * @param q - Câu truefalse trong lượt làm.
 * @returns Danh sách `{statementId, value}` theo thứ tự mệnh đề, hoặc
 *   null khi cổng xem lại đóng / câu không phải TF-A.
 */
function solutionTrueFalseStatements(
  q: AttemptQuestion,
): { statementId: string; value: boolean }[] | null {
  return q.solution && 'statements' in q.solution ? q.solution.statements : null;
}

/**
 * Giải mã response của câu TF-A: chuỗi JSON của bản đồ
 * `statementId → boolean` (ý chưa trả lời vắng mặt trong bản đồ).
 * Chuỗi không phải JSON/bản đồ thì coi như chưa trả lời ý nào — cùng
 * quy ước toàn phần với engine chấm phía API.
 *
 * @param value - Response đã lưu của lượt làm.
 * @returns Bản đồ đáp án theo mệnh đề (có thể rỗng).
 */
function parseTrueFalseResponse(value: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
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
 * Trang làm bài quiz: câu hỏi theo trang của đề kèm khối "Hướng dẫn"
 * (guidance của version đã pin — hiện ngay trong lúc làm theo D-4),
 * trả lời theo từng qtype (multichoice luôn chọn một, truefalse,
 * shortanswer, essay), lưu từng câu qua question engine, nộp bài để
 * chốt điểm. Khi lượt đã nộp, trang chuyển thành màn xem lại: điểm
 * từng câu, đáp án đúng được đánh dấu trên lựa chọn, khối "Lời giải"
 * theo các cổng xem lại của lần ghim và trạng thái chờ chấm tay của
 * essay. Hết giờ làm bài thì server tự chốt ở tương tác kế tiếp —
 * đồng hồ trên trang chỉ để học sinh theo dõi.
 */
export function QuizAttemptPage() {
  const { t } = useTranslation('app');
  const { attemptId } = useParams();
  // View lượt làm qua TanStack Query (F-01 của #133,
  // `lib/quiz-data.ts`): clientLoader của route nạp trước đúng khoá;
  // tải hỏng khi chưa có dữ liệu thì trang báo lỗi tải như bản thủ
  // công, lỗi ở lần nạp lại sau đó giữ nguyên view đang hiện.
  const attemptQuery = useQuizAttempt(attemptId);
  const view = attemptQuery.data ?? null;
  const error = attemptQuery.isError && !attemptQuery.data ? t('quizAttemptLoadFailed') : null;
  const saveResponseMutation = useSaveQuizResponse();
  const submitMutation = useSubmitQuizAttempt();
  const [actionError, setActionError] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Mỗi khi view mới về (tải đầu, nạp lại sau lưu/nộp, hết giờ tự
  // chốt): lấp các ô trả lời cục bộ còn trống bằng response phía
  // server — đúng nhịp gộp của reload thủ công trước đây, không bao
  // giờ đè lên chữ người dùng đang gõ.
  useEffect(() => {
    const fresh = attemptQuery.data;
    if (!fresh) return;
    setResponses((prev) => {
      const next = { ...prev };
      for (const q of fresh.questions) {
        if (next[q.questionAttemptId] === undefined && q.response !== null) next[q.questionAttemptId] = q.response;
      }
      return next;
    });
  }, [attemptQuery.data]);

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
  // Hết giờ: nạp lại view đúng một lần ở nhịp đồng hồ chạm 0 (server
  // tự chốt lượt ở tương tác này) — ref giữ hàm refetch mới nhất để
  // effect chỉ chạy theo hai điều kiện dưới đây như bản thủ công.
  const refetchRef = useRef(attemptQuery.refetch);
  refetchRef.current = attemptQuery.refetch;
  useEffect(() => {
    if (remainingSeconds === 0 && inProgress) void refetchRef.current().catch(() => undefined);
  }, [remainingSeconds, inProgress]);

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
    } catch {
      setActionError(t('quizAttemptActionFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function saveResponse(q: AttemptQuestion) {
    if (!attemptId) return;
    await act(() =>
      saveResponseMutation.mutateAsync({
        attemptId,
        questionAttemptId: q.questionAttemptId,
        response: (responses[q.questionAttemptId] ?? '').trim() ? responses[q.questionAttemptId]! : null,
      }),
    );
  }

  async function submitAll() {
    if (!attemptId) return;
    await act(() => submitMutation.mutateAsync(attemptId));
  }

  if (error)
    return (
      <PageShell width="narrow">
        <ErrorAlert variant="destructive">
          {error}
        </ErrorAlert>
      </PageShell>
    );
  if (!view)
    return (
      <PageShell width="narrow">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t('quizAttemptLoading')}
        </div>
      </PageShell>
    );

  const { quiz, attempt } = view;
  const submitted = attempt.state !== 'inprogress';
  const pageQuestions = view.questions.filter((q) => q.page === currentPage);

  return (
    <PageShell width="narrow">
      <PageHeader
        title={quiz.name}
        description={
          <>
            {t('quizAttemptHeaderLine', { number: attempt.attemptNumber, state: t(`quizAttemptState_${attempt.state}`) })}
            {attempt.preview ? ` (${t('quizPreviewBadge')})` : ''}
          </>
        }
      />
      <Card>
        <CardContent className="space-y-3">
          {remainingSeconds !== null ? (
            <p className="text-sm font-medium" data-testid="quiz-countdown">
              {t('quizTimeRemaining', { minutes: Math.floor(remainingSeconds / 60), seconds: remainingSeconds % 60 })}
            </p>
          ) : null}
          {view.closedDueToTimeLimit ? (
            <ErrorAlert variant="destructive">
              {t('quizClosedByTimeLimit')}
            </ErrorAlert>
          ) : null}
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
              {view.overallFeedback ? (
                <p className="whitespace-pre-wrap">{t('quizOverallFeedback', { text: view.overallFeedback })}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('quizAttemptInstructions')}</p>
          )}
          {actionError ? (
            <ErrorAlert variant="destructive">
              {actionError}
            </ErrorAlert>
          ) : null}
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
            <CardDescription>{q.questionExcerpt}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {q.stimulus ? (
              <div className="rounded-md border p-3">
                <h4 className="text-sm font-medium">{t('stimulusHeading')}</h4>
                <p className="text-sm whitespace-pre-wrap">{plainText(q.stimulus.content)}</p>
              </div>
            ) : null}
            {q.qtype === 'truefalse' ? (
              // TF-A: chỉ hiện THÂN CHUNG ở đây; từng mệnh đề hiện
              // trong bộ nhập kèm cặp Đ/S của chính nó.
              <RichTextView
                value={
                  {
                    type: 'doc',
                    content: (q.questionText.content ?? []).slice(0, -1),
                  } as RichTextDocument
                }
              />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{plainText(q.questionText)}</p>
            )}
            {/* Hướng dẫn (guidance) hiện kèm câu hỏi ngay trong lúc làm — điểm quyết D-4;
                khối này giữ nguyên ở màn xem lại, cùng vị trí như lúc làm. */}
            {hasRichTextContent(q.guidance) ? (
              <div className="rounded-md border p-3" data-testid={`quiz-guidance-${q.slot}`}>
                <h4 className="text-sm font-medium">{t('guidanceHeading')}</h4>
                <RichTextView value={q.guidance} />
              </div>
            ) : null}
            <QuestionAnswerInput
              q={q}
              quizShuffle={quiz.shuffleAnswers}
              disabled={!inProgress || busy}
              value={responses[q.questionAttemptId] ?? q.response ?? ''}
              onChange={(value) => setResponses((prev) => ({ ...prev, [q.questionAttemptId]: value }))}
              correctAnswerId={submitted ? solutionCorrectAnswerId(q) : null}
              tfSolution={submitted ? solutionTrueFalseStatements(q) : null}
            />
            {inProgress ? (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void saveResponse(q)}>
                {t('quizSaveAnswer')}
              </Button>
            ) : null}
            {submitted ? (
              <div className="text-sm space-y-2">
                <p>
                  {q.state === 'needsgrading'
                    ? t('quizQuestionWaitingGrade')
                    : t('quizQuestionMark', { mark: q.mark ?? 0, max: q.maxMark })}
                </p>
                {/* Khối "Lời giải" của màn xem lại — chỉ dựng khi API trả ít nhất một
                    thành phần; từng thành phần đã qua đúng cổng xem lại của lần ghim ở
                    phía API (solution/rightAnswer: reviewRightAnswer, feedback của đáp
                    án đã chọn: reviewSpecificFeedback, generalFeedback:
                    reviewGeneralFeedback), web chỉ trình bày những gì nhận được. */}
                {q.solution || q.rightAnswer || q.feedback || q.generalFeedback ? (
                  <div className="rounded-md border p-3 space-y-2" data-testid={`quiz-solution-${q.slot}`}>
                    <h4 className="text-sm font-medium">{t('quizSolutionHeading')}</h4>
                    {q.rightAnswer ? <p>{t('quizRightAnswer', { answer: q.rightAnswer })}</p> : null}
                    {solutionAcceptedAnswers(q) ? (
                      <p>{t('quizAcceptedAnswers', { answers: solutionAcceptedAnswers(q)!.join(', ') })}</p>
                    ) : null}
                    {solutionModelAnswer(q) ? (
                      <div>
                        <h5 className="text-sm font-medium">{t('modelAnswerHeading')}</h5>
                        <RichTextView value={solutionModelAnswer(q)} />
                      </div>
                    ) : null}
                    {q.feedback ? (
                      <p className="whitespace-pre-wrap">{t('quizAnswerFeedback', { text: plainText(q.feedback) })}</p>
                    ) : null}
                    {q.generalFeedback ? (
                      <p className="whitespace-pre-wrap">{plainText(q.generalFeedback)}</p>
                    ) : null}
                  </div>
                ) : null}
                {q.manualComment ? (
                  <p className="whitespace-pre-wrap">{t('quizManualComment', { text: q.manualComment })}</p>
                ) : null}
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
        <Link to={`/courses/${quiz.courseId}/exams/${quiz.id}`}>{t('quizBackToQuiz')}</Link>
      </p>
    </PageShell>
  );
}

/**
 * Bộ nhập câu trả lời theo qtype — response luôn là chuỗi theo quy ước
 * của question engine (multichoice: id của đáp án được chọn; truefalse
 * TF-A: chuỗi JSON của bản đồ `statementId → boolean`; shortanswer/
 * essay: văn bản trả lời).
 *
 * Multichoice LUÔN là radio chọn một: mô hình giaokhoa khoá đúng một
 * đáp án đúng cho mỗi câu (quyết 12:04 ngày 26/10/2026) nên không còn
 * nhánh checkbox chọn-nhiều.
 *
 * Ở màn xem lại (lượt đã nộp), `correctAnswerId` (multichoice) /
 * `tfSolution` (truefalse) mang đáp án đúng suy từ `solution` — trang
 * cha chỉ truyền hai prop này khi lượt đã nộp và API đã trả solution
 * (cổng reviewRightAnswer ở phía API); phía đúng của từng ý được đánh
 * dấu trực tiếp bằng nhãn "Đáp án đúng" cạnh nội dung, và mỗi mệnh đề
 * mang phán quyết đúng/sai của chính nó.
 */
function QuestionAnswerInput(props: {
  q: AttemptQuestion;
  quizShuffle: boolean;
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
  /** Id đáp án đúng để đánh dấu ở màn xem lại; null = không đánh dấu. */
  correctAnswerId: string | null;
  /** Đáp án Đ/S từng mệnh đề của truefalse ở màn xem lại; null = không đánh dấu. */
  tfSolution: { statementId: string; value: boolean }[] | null;
}) {
  const { t } = useTranslation('app');
  const { q, disabled, value, onChange, correctAnswerId, tfSolution } = props;
  const optionShuffle = q.options?.shuffleAnswers === true;
  const answers = useMemo(
    () => (props.quizShuffle || optionShuffle ? shuffled(q.answers, q.questionAttemptId) : q.answers),
    [props.quizShuffle, optionShuffle, q.answers, q.questionAttemptId],
  );

  if (q.qtype === 'multichoice') {
    return (
      <div className="space-y-2">
        {answers.map((a) => {
          const label = plainText(a.text);
          const isCorrect = correctAnswerId !== null && correctAnswerId === a.id;
          return (
            <label
              key={a.id}
              className="flex items-center gap-2 text-sm"
              data-correct={isCorrect ? 'true' : undefined}
            >
              <input
                type="radio"
                name={`q-${q.questionAttemptId}`}
                checked={value === a.id}
                disabled={disabled}
                onChange={() => onChange(a.id)}
              />
              {label}
              {isCorrect ? (
                <span className="text-xs font-medium text-emerald-700">{t('quizCorrectAnswerBadge')}</span>
              ) : null}
            </label>
          );
        })}
      </div>
    );
  }
  if (q.qtype === 'truefalse') {
    // TF-A: mỗi mệnh đề một cặp radio Đ/S riêng; response là chuỗi
    // JSON của bản đồ statementId → boolean (ý chưa chọn vắng mặt).
    const statements = getTrueFalseStatements(q.questionText) ?? [];
    const chosen = parseTrueFalseResponse(value);
    const correctById = new Map((tfSolution ?? []).map((s) => [s.statementId, s.value]));
    return (
      <div className="space-y-3">
        {statements.map((statement, index) => {
          const correct = correctById.get(statement.id);
          const picked = chosen[statement.id];
          const verdict =
            correct === undefined
              ? undefined
              : picked === undefined
                ? 'unanswered'
                : picked === correct
                  ? 'correct'
                  : 'incorrect';
          return (
            <div
              key={statement.id}
              className="space-y-1"
              data-testid={`quiz-tf-statement-${q.slot}-${index}`}
              data-verdict={verdict}
            >
              <div className="flex items-start gap-2 text-sm">
                <span className="font-medium">{`${'abcd'[index] ?? index + 1})`}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{statement.text}</span>
              </div>
              <div className="flex gap-4">
                {([true, false] as const).map((side) => {
                  const isCorrectSide = correct !== undefined && correct === side;
                  return (
                    <label
                      key={String(side)}
                      className="flex items-center gap-2 text-sm"
                      data-correct={isCorrectSide ? 'true' : undefined}
                    >
                      <input
                        type="radio"
                        name={`q-${q.questionAttemptId}-${statement.id}`}
                        checked={picked === side}
                        disabled={disabled}
                        onChange={() =>
                          onChange(JSON.stringify({ ...chosen, [statement.id]: side }))
                        }
                      />
                      {side ? t('quizTrueLabel') : t('quizFalseLabel')}
                      {isCorrectSide ? (
                        <span className="text-xs font-medium text-emerald-700">
                          {t('quizCorrectAnswerBadge')}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
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

/**
 * clientLoader (F-01, rà soát #133): prefetch view lượt làm vào
 * QueryClient singleton dùng chung (đúng khoá factory) trước khi
 * component mount — điều hướng vào trang không còn thác nước
 * mount-rồi-fetch. prefetchQuery không ném lỗi: tải hỏng thì
 * component tự xử lý qua useQuery như trước.
 */
export async function clientLoader({ params }: { params: Record<string, string | undefined> }) {
  if (params.attemptId) {
    await quizAttemptPageClientLoader(params.attemptId);
  }
  return null;
}

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { titleMeta } from '../lib/route-meta';
export function meta() {
  return titleMeta('Làm bài kiểm tra');
}
