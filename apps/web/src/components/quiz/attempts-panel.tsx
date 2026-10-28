/**
 * Thẻ thông tin lần ghim đề (tách cấu trúc từ `pages/quiz.tsx`
 * theo đợt A của issue #223): thông tin tổ chức theo cài đặt hiệu
 * lực của chính người xem, các nút bắt đầu/tiếp tục/xem trước,
 * điểm của tôi, danh sách lượt làm của tôi và các lần chấm lại
 * của tôi. Dữ liệu lần ghim được truyền trọn qua props; thao tác
 * bắt đầu lượt làm do trang giữ và truyền xuống.
 *
 * @param props.courseId - Id khoá học trên route (đích các liên kết giáo viên).
 * @param props.quizId - Id lần ghim trên route (đích các liên kết giáo viên).
 * @param props.data - View lần ghim đã nạp.
 * @param props.myRegrades - Các lần chấm lại đã áp lên lượt làm của người xem.
 * @param props.actionError - Lỗi thao tác hiện tại (trang giữ).
 * @param props.startAttempt - Handler bắt đầu lượt làm (preview = xem trước).
 */
import type { PinRegradeLogEntry } from '@lms/contracts';
import { formatDateTime } from '#lib/date-format';
import type { QuizForUser } from '#lib/quiz-data';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent } from '@lms/ui/components/card';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

interface AttemptsPanelProps {
  courseId: string | undefined;
  quizId: string | undefined;
  data: QuizForUser;
  myRegrades: PinRegradeLogEntry[];
  actionError: string | null;
  startAttempt: (preview: boolean) => Promise<void>;
}

export function AttemptsPanel({ courseId, quizId, data, myRegrades, actionError, startAttempt }: AttemptsPanelProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
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
    <Card>
      <CardContent className="space-y-3">
        {quiz.intro ? <p className="text-sm whitespace-pre-wrap">{quiz.intro}</p> : null}
        <ul className="text-sm text-muted-foreground">
          <li>
            {t('quizWindowLine', {
              open: eff.timeOpen ? formatDateTime(eff.timeOpen) : t('quizNoBound'),
              close: eff.timeClose ? formatDateTime(eff.timeClose) : t('quizNoBound'),
            })}
          </li>
          <li>
            {t('quizTimeLimitLine', {
              minutes: eff.timeLimitSeconds ? Math.round(eff.timeLimitSeconds / 60) : t('quizNoTimeLimit'),
            })}
          </li>
          <li>
            {t('quizAttemptsLine', { count: eff.attemptsAllowed === 0 ? t('quizUnlimited') : eff.attemptsAllowed })}
          </li>
          <li>{t('quizGradeMethodLine', { method: t(`quizGradeMethod_${quiz.gradeMethod}`) })}</li>
        </ul>
        {hasOwnOverride ? <p className="text-sm font-medium">{t('quizEffectiveNote')}</p> : null}
        {actionError ? (
          <ErrorAlert variant="destructive">
            {actionError}
          </ErrorAlert>
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
            <Button
              type="button"
              variant="outline"
              render={<Link to={`/courses/${courseId}/exams/${quizId}/results`} />}
            >
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
                      date: formatDateTime(entry.createdAt),
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
  );
}
