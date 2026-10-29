/**
 * Thẻ cài đặt tổ chức của lần ghim đề (tách cấu trúc từ
 * `pages/quiz.tsx` theo đợt A của issue #223): form sửa tên, mô
 * tả, cửa sổ mở/đóng, giới hạn giờ, số lượt, cách tính điểm,
 * thang điểm, xáo trộn đáp án và chế độ version. Giá trị form và
 * các setter do trang giữ và truyền xuống; việc lưu do handler
 * của trang xử lý.
 *
 * @param props.busy - Đang có thao tác ghi chạy (khoá nút lưu).
 * @param props.saveSettings - Handler submit form cài đặt của trang.
 */
import type { FormEvent } from 'react';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { useTranslation } from 'react-i18next';

interface SettingsFormProps {
  name: string;
  intro: string;
  timeOpen: string;
  timeClose: string;
  timeLimitMinutes: string;
  attemptsAllowed: string;
  gradeMethod: string;
  grade: string;
  shuffleAnswers: boolean;
  versionMode: 'pinned' | 'float_latest_ready';
  busy: boolean;
  saveSettings: (event: FormEvent) => Promise<void>;
  setName: (value: string) => void;
  setIntro: (value: string) => void;
  setTimeOpen: (value: string) => void;
  setTimeClose: (value: string) => void;
  setTimeLimitMinutes: (value: string) => void;
  setAttemptsAllowed: (value: string) => void;
  setGradeMethod: (value: string) => void;
  setGrade: (value: string) => void;
  setShuffleAnswers: (value: boolean) => void;
  setVersionMode: (value: 'pinned' | 'float_latest_ready') => void;
}

export function SettingsForm({
  name,
  intro,
  timeOpen,
  timeClose,
  timeLimitMinutes,
  attemptsAllowed,
  gradeMethod,
  grade,
  shuffleAnswers,
  versionMode,
  busy,
  saveSettings,
  setName,
  setIntro,
  setTimeOpen,
  setTimeClose,
  setTimeLimitMinutes,
  setAttemptsAllowed,
  setGradeMethod,
  setGrade,
  setShuffleAnswers,
  setVersionMode,
}: SettingsFormProps) {
  const { t } = useTranslation('app');

  return (
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
                <Input
                  id="quiz-open"
                  type="datetime-local"
                  value={timeOpen}
                  onChange={(e) => setTimeOpen(e.target.value)}
                />
              </Field>
              <Field className="w-auto">
                <FieldLabel htmlFor="quiz-close">{t('quizSettingsClose')}</FieldLabel>
                <Input
                  id="quiz-close"
                  type="datetime-local"
                  value={timeClose}
                  onChange={(e) => setTimeClose(e.target.value)}
                />
              </Field>
              <Field className="w-auto">
                <FieldLabel htmlFor="quiz-limit">{t('quizSettingsTimeLimit')}</FieldLabel>
                <Input id="quiz-limit" value={timeLimitMinutes} onChange={(e) => setTimeLimitMinutes(e.target.value)} />
              </Field>
              <Field className="w-auto">
                <FieldLabel htmlFor="quiz-attempts">{t('quizSettingsAttempts')}</FieldLabel>
                <Input
                  id="quiz-attempts"
                  value={attemptsAllowed}
                  onChange={(e) => setAttemptsAllowed(e.target.value)}
                />
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
                      <SelectItem key={m} value={m}>
                        {t(`quizGradeMethod_${m}`)}
                      </SelectItem>
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
              <Button type="submit" disabled={busy}>
                {t('quizSettingsSave')}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
