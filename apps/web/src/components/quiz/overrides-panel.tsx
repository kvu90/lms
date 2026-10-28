/**
 * Thẻ ghi đè theo người dùng/nhóm của lần ghim đề (tách cấu
 * trúc từ `pages/quiz.tsx` theo đợt A của issue #223): danh
 * sách ghi đè hiện có kèm sửa/xoá và form tạo/sửa ghi đè dùng
 * chung. Trạng thái form ghi đè là trạng thái cục bộ của riêng
 * khối này nên panel tự giữ (theo tiền lệ đợt 1: component con
 * tự giữ trạng thái cục bộ của khối mình), kèm các đột biến ghi
 * đè qua lớp hooks dữ liệu hiện hữu; trang chỉ truyền dữ liệu
 * đã nạp (danh sách ghi đè, roster, nhóm) và cờ bận dùng chung.
 *
 * @param props.pinId - Id lần ghim (khoá của các đột biến ghi đè).
 * @param props.overrides - Danh sách ghi đè của lần ghim.
 * @param props.overridesLoaded - Danh sách đã tải xong (để hiện trạng thái rỗng).
 * @param props.overridesIsError - Lượt tải danh sách ghi đè có lỗi hay không.
 * @param props.overridesErrorUpdatedAt - Mốc cập nhật lỗi của query ghi đè (kích hoạt thông báo lỗi tải).
 * @param props.roster - Danh sách thành viên khoá (chọn học sinh đích).
 * @param props.groups - Nhóm của khoá (chọn nhóm đích).
 * @param props.busy - Đang có thao tác ghi chạy ở trang (khoá nút).
 * @param props.setBusy - Setter của cờ bận dùng chung.
 */
import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import type { CourseRosterMember, ExamPinOverrideView as QuizOverrideView } from '@lms/contracts';
import type { CourseGroup } from '#lib/progress-report-data';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { ApiError } from '#lib/api';
import { formatDateTime } from '#lib/date-format';
import { useCreateExamPinOverride, useDeleteExamPinOverride, useUpdateExamPinOverride } from '#lib/quiz-data';
import { toLocalInput } from './utils';

interface OverridesPanelProps {
  pinId: string;
  overrides: QuizOverrideView[];
  overridesLoaded: boolean;
  overridesIsError: boolean;
  overridesErrorUpdatedAt: number;
  roster: CourseRosterMember[];
  groups: CourseGroup[];
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
}

export function OverridesPanel({
  pinId,
  overrides,
  overridesLoaded,
  overridesIsError,
  overridesErrorUpdatedAt,
  roster,
  groups,
  busy,
  setBusy,
}: OverridesPanelProps) {
  const { t } = useTranslation('app');

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

  useEffect(() => {
    if (overridesIsError) setOvError(t('quizOverridesLoadFailed'));
  }, [overridesIsError, overridesErrorUpdatedAt, t]);

  // Các đột biến ghi đè của lần ghim (F-01 của rà soát #133):
  // đột biến tự làm mới danh sách ghi đè sau mỗi thao tác.
  const createOverrideMutation = useCreateExamPinOverride(pinId);
  const updateOverrideMutation = useUpdateExamPinOverride(pinId);
  const deleteOverrideMutation = useDeleteExamPinOverride(pinId);

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

  /** Chạy một thao tác ghi đè (đột biến tự làm mới danh sách); mã lỗi của API được dịch riêng cho luật lý do. */
  async function actOverride(run: () => Promise<unknown>) {
    setOvError(null);
    setBusy(true);
    try {
      await run();
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
      if (ovTargetKind === 'user' && !ovUserId) {
        setOvError(t('quizOverrideTargetRequired'));
        return;
      }
      if (ovTargetKind === 'group' && !ovGroupId) {
        setOvError(t('quizOverrideTargetRequired'));
        return;
      }
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
      await actOverride(() => updateOverrideMutation.mutateAsync({ overrideId: target.id, fields }));
    } else {
      await actOverride(() =>
        createOverrideMutation.mutateAsync({
          ...(ovTargetKind === 'user' ? { userId: ovUserId } : { groupId: ovGroupId }),
          ...fields,
        }),
      );
    }
  }

  async function removeOverride(ov: QuizOverrideView) {
    if (editingOverride?.id === ov.id) resetOverrideForm();
    await actOverride(() => deleteOverrideMutation.mutateAsync(ov.id));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('quizOverridesTitle')}</CardTitle>
        <CardDescription>{t('quizOverridesDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {ovError ? (
          <ErrorAlert variant="destructive">
            {ovError}
          </ErrorAlert>
        ) : null}
        <ul className="space-y-2">
          {overrides.map((ov) => (
            <li key={ov.id} data-testid={`override-${ov.id}`} className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                <span className="font-medium">{ov.groupName ?? ov.userName ?? ov.groupId ?? ov.userId}</span>
                {ov.userId && ov.timeOpen ? (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                    {t('quizMakeupBadge')}
                  </span>
                ) : null}
                <span className="block text-xs text-muted-foreground">
                  {[
                    `${t('quizOverrideWindowLabel')}: ${ov.timeOpen ? formatDateTime(ov.timeOpen) : t('quizOverrideInherit')} → ${ov.timeClose ? formatDateTime(ov.timeClose) : t('quizOverrideInherit')}`,
                    ov.timeLimitSeconds
                      ? t('quizOverrideLimitLabel', { minutes: Math.round(ov.timeLimitSeconds / 60) })
                      : null,
                    ov.attempts !== null
                      ? t('quizOverrideAttemptsLabel', { count: ov.attempts === 0 ? t('quizUnlimited') : ov.attempts })
                      : null,
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
              {editingOverride.groupName ??
                editingOverride.userName ??
                editingOverride.groupId ??
                editingOverride.userId}
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
                        <SelectItem key={m.userId} value={m.userId}>
                          {m.displayName}
                        </SelectItem>
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
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Field className="w-auto">
              <FieldLabel htmlFor="ov-open">{t('quizOverrideWindowOpen')}</FieldLabel>
              <Input
                id="ov-open"
                type="datetime-local"
                value={ovTimeOpen}
                onChange={(e) => setOvTimeOpen(e.target.value)}
              />
            </Field>
            <Field className="w-auto">
              <FieldLabel htmlFor="ov-close">{t('quizOverrideWindowClose')}</FieldLabel>
              <Input
                id="ov-close"
                type="datetime-local"
                value={ovTimeClose}
                onChange={(e) => setOvTimeClose(e.target.value)}
              />
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
              <Input
                id="ov-password"
                placeholder={t('quizOverridePasswordPlaceholder')}
                value={ovPassword}
                onChange={(e) => setOvPassword(e.target.value)}
              />
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
  );
}
