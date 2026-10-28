/**
 * Thẻ chấm lại theo version câu hỏi (tách cấu trúc từ
 * `pages/quiz.tsx` theo đợt A của issue #223): chọn câu và
 * version đích, chạy xem trước (dry-run) hoặc áp chấm lại, xem
 * danh sách điểm đổi và nhật ký các lần chấm lại đã áp. Trạng
 * thái chọn và các handler chạy chấm lại do trang giữ và truyền
 * xuống.
 *
 * @param props.quiz - Phần lần ghim của view (danh sách slot để chọn câu).
 * @param props.slotNames - Tên hiển thị của từng slot theo id.
 * @param props.roster - Danh sách thành viên khoá (hiện tên học sinh ở dòng điểm đổi).
 * @param props.regradeError - Lỗi chấm lại hiện tại.
 * @param props.regradeQuestionId - Câu đang chọn để chấm lại.
 * @param props.regradeVersions - Các version của câu đang chọn.
 * @param props.regradeVersionId - Version đích đang chọn.
 * @param props.regradePreview - Kết quả xem trước/áp gần nhất (null khi chưa chạy).
 * @param props.regradeLog - Nhật ký chấm lại của lần ghim (null khi chưa tải).
 * @param props.busy - Đang có thao tác ghi chạy (khoá nút).
 * @param props.onRegradeQuestionChange - Handler đổi câu chấm lại của trang.
 * @param props.setRegradeVersionId - Setter của version đích.
 * @param props.runRegrade - Handler chạy chấm lại (dryRun = chỉ xem trước).
 */
import type { CourseRosterMember, PinRegradeLogEntry, PinRegradeResult, QuizView } from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { useTranslation } from 'react-i18next';

import { formatDateTime } from '#lib/date-format';

interface RegradePanelProps {
  quiz: QuizView;
  slotNames: Record<string, string>;
  roster: CourseRosterMember[];
  regradeError: string | null;
  regradeQuestionId: string;
  regradeVersions: { id: string; version: number; status: string }[];
  regradeVersionId: string;
  regradePreview: PinRegradeResult | null;
  regradeLog: PinRegradeLogEntry[] | null;
  busy: boolean;
  onRegradeQuestionChange: (value: string | null) => void;
  setRegradeVersionId: (value: string) => void;
  runRegrade: (dryRun: boolean) => Promise<void>;
}

export function RegradePanel({
  quiz,
  slotNames,
  roster,
  regradeError,
  regradeQuestionId,
  regradeVersions,
  regradeVersionId,
  regradePreview,
  regradeLog,
  busy,
  onRegradeQuestionChange,
  setRegradeVersionId,
  runRegrade,
}: RegradePanelProps) {
  const { t } = useTranslation('app');

  return (
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
            onValueChange={onRegradeQuestionChange}
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
          <Button
            type="button"
            variant="outline"
            disabled={busy || !regradeQuestionId || !regradeVersionId}
            onClick={() => void runRegrade(true)}
          >
            {t('regradeDryRun')}
          </Button>
          <Button
            type="button"
            disabled={busy || !regradeQuestionId || !regradeVersionId}
            onClick={() => void runRegrade(false)}
          >
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
                  {t('regradeLogLine', { date: formatDateTime(entry.createdAt), count: entry.items.length })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
