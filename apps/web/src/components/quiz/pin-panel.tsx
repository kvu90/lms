/**
 * Thẻ thông tin đề đã ghim (tách cấu trúc từ `pages/quiz.tsx`
 * theo đợt A của issue #223): nguồn đề, version đang ghim, xem
 * trước và áp cập nhật version, danh sách slot đã ghim. Chỉ
 * trình bày dữ liệu qua props; việc tải xem trước và áp cập
 * nhật do trang giữ và truyền xuống.
 *
 * @param props.quiz - Phần lần ghim của view (chứa slots và version).
 * @param props.slotNames - Tên hiển thị của từng slot theo id.
 * @param props.examInfo - Thông tin đề nguồn ở ngân hàng (tên + version hiện hành).
 * @param props.groups - Nhóm của khoá (hiện tên nhóm đích của lần ghim).
 * @param props.updatePreview - Bản xem trước cập nhật version (null khi chưa tải).
 * @param props.updateError - Lỗi cập nhật version hiện tại.
 * @param props.busy - Đang có thao tác ghi chạy (khoá nút).
 * @param props.loadUpdatePreview - Handler tải xem trước cập nhật version.
 * @param props.applyUpdate - Handler áp cập nhật lên version đã xem trước.
 * @param props.setUpdatePreview - Setter của bản xem trước (nút huỷ đặt null).
 */
import type { PinVersionUpdatePreview, QuizView } from '@lms/contracts';
import type { CourseGroup } from '#lib/progress-report-data';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { ExamSourceInfo } from '#lib/quiz-data';

interface PinPanelProps {
  quiz: QuizView;
  slotNames: Record<string, string>;
  examInfo: ExamSourceInfo | null;
  groups: CourseGroup[];
  updatePreview: PinVersionUpdatePreview | null;
  updateError: string | null;
  busy: boolean;
  loadUpdatePreview: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  setUpdatePreview: (preview: PinVersionUpdatePreview | null) => void;
}

export function PinPanel({
  quiz,
  slotNames,
  examInfo,
  groups,
  updatePreview,
  updateError,
  busy,
  loadUpdatePreview,
  applyUpdate,
  setUpdatePreview,
}: PinPanelProps) {
  const { t } = useTranslation('app');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pinExamTitle')}</CardTitle>
        <CardDescription>{t('pinExamDescription', { total: quiz.sumGrades })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1 text-sm">
          <p>
            {t('pinExamSourceLine')}: <span className="font-medium">{examInfo?.name ?? quiz.name}</span>
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
                        ? t('diffChange_question_version_changed', {
                            from: d.fromPinnedVersionNumber ?? 0,
                            to: d.toPinnedVersionNumber ?? 0,
                          })
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
                    {s.hasNewerVersion && s.latestVersion !== null
                      ? ` · ${t('slotHasNewerLine', { version: s.latestVersion })}`
                      : ''}
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
  );
}
