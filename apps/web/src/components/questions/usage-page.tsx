/**
 * Màn lượt dùng của một câu hỏi (route /questions/:questionId/usage): tách
 * khỏi trang ngân hàng câu hỏi để mỗi module một màn; hành vi giữ nguyên
 * như khi còn nằm trong trang — xem TSDoc của component bên dưới.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import type { QuestionUsage, RichTextDocument } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Skeleton } from '@lms/ui/components/skeleton';
import { ErrorAlert } from '#components/error-alert';

import { useQueryClient } from '@tanstack/react-query';

import { usePermissions } from '#lib/permissions';
import {
  pinnedQuestionVersionsQueryOptions,
  stimulusDetailQueryOptions,
  useFinishQuestionUsage,
  useFinishUsageAttempt,
  useQuestionUsage,
  useStartQuestionUsage,
  useStartUsageAttempt,
  useSubmitUsageAttempt,
} from '#lib/questions-data';
import { PageHeader, PageShell } from '../page-shell';
import { plainText } from './shared';

/** Một phiên bản câu hỏi như endpoint versions trả về (có stimulusId để tra ngữ liệu đã gắn). */
interface PinnedVersion {
  id: string;
  version: number;
  questionText: RichTextDocument;
  stimulusId: string | null;
}

/** Nội dung hiển thị của một attempt: đề của phiên bản đã pin + ngữ liệu gắn kèm (nếu có). */
interface PinnedContent {
  questionText: string;
  stimulusText: string | null;
}

/**
 * Lượt làm bài câu hỏi: thao tác theo trạng thái của usage và từng attempt
 * (bắt đầu usage/attempt, nộp câu trả lời, kết thúc attempt/usage). Sau mỗi
 * thao tác trang nạp lại usage từ API để hiển thị state/fraction mới nhất.
 * Behaviour mặc định là deferredfeedback: nộp chỉ ghi đáp án thành step,
 * điểm (fraction) chỉ chốt khi kết thúc attempt hoặc toàn bộ usage.
 */
export function QuestionUsagePage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const perms = usePermissions();
  const queryClient = useQueryClient();
  // Usage đọc qua TanStack Query (F-01 của rà soát #133): cổng vai
  // của trang là điều kiện bật query; lỗi tải hiện qua trạng thái
  // lỗi của query, thao tác làm bài là đột biến tự làm mới usage.
  const usageQuery = useQuestionUsage(id ?? '', perms.ready && perms.canUseQuestionBank);
  const usage = usageQuery.data ?? null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pinned, setPinned] = useState<Record<string, PinnedContent>>({});
  const startUsageMutation = useStartQuestionUsage();
  const finishUsageMutation = useFinishQuestionUsage();
  const startAttemptMutation = useStartUsageAttempt();
  const submitAttemptMutation = useSubmitUsageAttempt();
  const finishAttemptMutation = useFinishUsageAttempt();

  /**
   * Nạp nội dung của phiên bản ĐÃ PIN cho từng attempt đã bắt đầu: usage chỉ
   * mang questionId/questionVersionId, nên đề và ngữ liệu phải tra qua
   * endpoint versions (đúng phiên bản đã pin, không phải bản mới nhất) rồi
   * endpoint stimuli. Lỗi ở bước phụ này không chặn thao tác làm bài.
   */
  const loadPinned = useCallback(async (fresh: QuestionUsage) => {
    const entries = await Promise.all(
      fresh.attempts
        .filter((a) => a.questionVersionId)
        .map(async (a) => {
          try {
            const versions = await queryClient.fetchQuery(pinnedQuestionVersionsQueryOptions(a.questionId));
            const version = versions.find((v) => v.id === a.questionVersionId);
            if (!version) return null;
            let stimulusText: string | null = null;
            if (version.stimulusId) {
              const stimulus = await queryClient.fetchQuery(stimulusDetailQueryOptions(version.stimulusId));
              stimulusText = plainText(stimulus.content);
            }
            return [a.id, { questionText: plainText(version.questionText), stimulusText }] as const;
          } catch {
            return null;
          }
        }),
    );
    setPinned((prev) => {
      const next = { ...prev };
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      return next;
    });
  }, []);

  // Mỗi khi usage (lại) tải về thì nạp nội dung đã ghim cho các
  // attempt đã bắt đầu — đúng nhịp loadPinned sau mỗi reload() thủ
  // công trước đây (mở trang và sau mỗi thao tác).
  useEffect(() => {
    if (usageQuery.data) void loadPinned(usageQuery.data);
  }, [usageQuery.data, loadPinned]);

  /** Chạy một thao tác làm bài (đột biến tự làm mới usage); lỗi hiện thân thiện qua i18n. */
  async function act(run: () => Promise<unknown>) {
    setActionError(null);
    try {
      await run();
    } catch {
      setActionError(t('usageActionFailed'));
    }
  }

  if (!perms.ready)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        {t('loading')}
      </main>
    );
  if (!perms.canUseQuestionBank)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('questionBank')}</CardTitle>
            <CardDescription>{t('questionBankForbidden')}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  if (usageQuery.isError)
    return (
      <PageShell width="medium">
        <PageHeader title={t('questionAttemptTitle', { component: '' })} />
        <ErrorAlert variant="destructive">
          {t('attemptLoadFailed')}
        </ErrorAlert>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void usageQuery.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </div>
      </PageShell>
    );
  if (!usage)
    return (
      <PageShell width="medium">
        <div className="space-y-2" aria-label={t('attemptLoading')}>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </PageShell>
    );
  const usageId = usage.usage.id;
  const gradedStates = ['gradedright', 'gradedpartial', 'gradedwrong', 'gaveup'];
  return (
    <PageShell width="medium">
      <PageHeader
        title={t('questionAttemptTitle', { component: usage.usage.component })}
        description={t('usageState', { state: usage.state })}
      />
      <Card>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('deferredFeedbackNote')}</p>
          {actionError ? (
            <ErrorAlert variant="destructive">
              {actionError}
            </ErrorAlert>
          ) : null}
          <div className="flex gap-2">
            {usage.state === 'notstarted' ? (
              <Button
                type="button"
                onClick={() =>
                  void act(() => startUsageMutation.mutateAsync({ usageId }))
                }
              >
                {t('usageStart')}
              </Button>
            ) : null}
            {usage.state === 'inprogress' ? (
              <Button
                type="button"
                onClick={() =>
                  void act(() => finishUsageMutation.mutateAsync({ usageId }))
                }
              >
                {t('usageFinish')}
              </Button>
            ) : null}
          </div>
          <ul className="space-y-4">
            {usage.attempts.map((a) => {
              const started = a.state !== 'notstarted';
              const finishedAttempt = gradedStates.includes(a.state);
              const lastAnswer = [...a.steps].reverse().find((s) => s.data.answer)?.data.answer ?? '';
              const content = pinned[a.id];
              return (
                <li key={a.id} data-testid={`attempt-${a.id}`} className="space-y-2">
                  <div>
                    {t('slotLine', { slot: a.slot })} <strong>{a.state}</strong>
                    {a.fraction !== null ? ` ${t('fractionSuffix', { fraction: a.fraction })}` : ''}
                    {a.questionVersionId ? ` ${t('pinnedVersionSuffix', { versionId: a.questionVersionId })}` : ''}
                    <span className="block text-sm text-muted-foreground">
                      {t('stepsLine', { steps: a.steps.map((s) => s.state).join(' → ') || t('stepsNone') })}
                    </span>
                  </div>
                  {content ? (
                    <div className="space-y-2">
                      {content.stimulusText ? (
                        <div data-testid={`attempt-stimulus-${a.id}`} className="rounded-md border p-3">
                          <h4 className="text-sm font-medium">{t('stimulusHeading')}</h4>
                          <p className="text-sm whitespace-pre-wrap">{content.stimulusText}</p>
                        </div>
                      ) : null}
                      <p className="text-sm whitespace-pre-wrap">{content.questionText}</p>
                    </div>
                  ) : null}
                  {!started ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void act(() => startAttemptMutation.mutateAsync({ usageId, attemptId: a.id }))
                      }
                    >
                      {t('attemptStart')}
                    </Button>
                  ) : null}
                  {started && !finishedAttempt ? (
                    <div className="space-y-2">
                      <Field>
                        <FieldLabel htmlFor={`answer-${a.id}`}>{t('answerForSlot', { slot: a.slot })}</FieldLabel>
                        <Input
                          id={`answer-${a.id}`}
                          value={answers[a.id] ?? lastAnswer}
                          onChange={(e) => setAnswers((prev) => ({ ...prev, [a.id]: e.target.value }))}
                        />
                      </Field>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          onClick={() =>
                            void act(() =>
                              submitAttemptMutation.mutateAsync({
                                usageId,
                                attemptId: a.id,
                                response: (answers[a.id] ?? lastAnswer).trim() ? (answers[a.id] ?? lastAnswer) : null,
                              }),
                            )
                          }
                        >
                          {t('attemptSubmit')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            void act(() => finishAttemptMutation.mutateAsync({ usageId, attemptId: a.id }))
                          }
                        >
                          {t('attemptFinish')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-4 text-sm">
            <Link to="/questions">{t('backToQuestionBank')}</Link>
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}
