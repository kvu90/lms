import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Skeleton } from '@lms/ui/components/skeleton';
import { Textarea } from '@lms/ui/components/textarea';
import { ErrorAlert } from '#components/error-alert';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { PageHeader, PageShell } from '#components/page-shell';
import '#config/i18n';
import { fetchClass, updateClass } from '../api/classes';
import { queryKeys } from '#lib/query-keys';
import { queryKeys as classesQueryKeys } from '../queries/keys';

const SELECT_CLASS = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';

/**
 * Màn sửa lớp riêng (CLASS-1, issue #184) — ngoài thông tin cơ bản, màn
 * này giữ các cài đặt vòng đời của lớp: luật rời lớp (đình chỉ giữ điểm
 * là mặc định / rút hẳn), tự báo danh + mã tham gia + xoay mã, tự duyệt
 * yêu cầu. CLASS-3 bổ sung khối HỌC PHÍ gói lớp (số tiền + đơn vị tiền +
 * tài khoản nhận chỉ định riêng). Mọi thay đổi đi qua PATCH
 * /classes/:id; API gác quyền tại context lớp nên web không tự giấu
 * theo vai (AGENTS.md web: giấu UI không phải là gác).
 */
export function ClassEditPage() {
  const { t } = useTranslation('app');
  const { id } = useParams<{ id: string }>();
  const classId = id ?? '';
  const queryClient = useQueryClient();
  const classQuery = useQuery({ queryKey: classesQueryKeys.classDetail(classId), queryFn: () => fetchClass(classId), enabled: Boolean(classId) });

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [schoolYear, setSchoolYear] = useState('');
  const [description, setDescription] = useState('');
  const [onLeave, setOnLeave] = useState<'suspend' | 'unenrol'>('suspend');
  const [allowSelfReport, setAllowSelfReport] = useState(false);
  const [joinAutoApprove, setJoinAutoApprove] = useState(false);
  // CLASS-3: học phí gói lớp — số tiền giữ dạng chuỗi trong form (để
  // trống = tắt thu phí), chuyển số nguyên khi lưu.
  const [feeCost, setFeeCost] = useState('');
  const [feeCurrency, setFeeCurrency] = useState('VND');
  const [feePaymentAccountId, setFeePaymentAccountId] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const cls = classQuery.data;
    if (!cls) return;
    setName(cls.name);
    setCode(cls.code ?? '');
    setSchoolYear(cls.schoolYear ?? '');
    setDescription(cls.description ?? '');
    setOnLeave(cls.onLeave);
    setAllowSelfReport(cls.allowSelfReport);
    setJoinAutoApprove(cls.joinAutoApprove);
    setFeeCost(cls.feeCost === null ? '' : String(cls.feeCost));
    setFeeCurrency(cls.feeCurrency);
    setFeePaymentAccountId(cls.feePaymentAccountId ?? '');
  }, [classQuery.data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: classesQueryKeys.classRoot(classId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.classes });
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      updateClass(classId, {
        name: name.trim(),
        code: code.trim() ? code.trim() : null,
        schoolYear: schoolYear.trim() ? schoolYear.trim() : null,
        description: description.trim(),
        onLeave,
        allowSelfReport,
        joinAutoApprove,
        // CLASS-3: chuỗi rỗng ở ô học phí = tắt thu qua hệ (gửi null);
        // tài khoản nhận để trống = tài khoản mặc định của tenant.
        feeCost: feeCost.trim() === '' ? null : Number(feeCost.trim()),
        feeCurrency: feeCurrency.trim().toUpperCase() || 'VND',
        feePaymentAccountId: feePaymentAccountId.trim() ? feePaymentAccountId.trim() : null,
      }),
    onSuccess: () => {
      setMessage(null);
      refresh();
    },
    onError: () => setMessage(t('classSaveFailed')),
  });

  const rotateMutation = useMutation({
    mutationFn: () => updateClass(classId, { rotateJoinCode: true }),
    onSuccess: () => {
      setMessage(t('classJoinCodeRotated'));
      refresh();
    },
    onError: () => setMessage(t('classSaveFailed')),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    saveMutation.mutate();
  }

  const cls = classQuery.data;
  const joinLink = cls?.joinCode ? `${window.location.origin}/classes/join?code=${cls.joinCode}` : null;

  return (
    <PageShell width="narrow">
      <PageHeader title={t('classEditTitle')} />
      {message ? (
        <ErrorAlert>
          {message}
        </ErrorAlert>
      ) : null}
      {classQuery.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : classQuery.isError || !cls ? (
        <ErrorAlert variant="destructive">
          {t('classDetailLoadFailed')}
        </ErrorAlert>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardContent className="pt-6">
              <form onSubmit={onSubmit}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="class-name">{t('className')}</FieldLabel>
                    <Input id="class-name" value={name} onChange={(e) => setName(e.target.value)} required />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="class-code">{t('classCode')}</FieldLabel>
                    <Input id="class-code" value={code} onChange={(e) => setCode(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="class-year">{t('classSchoolYear')}</FieldLabel>
                    <Input id="class-year" value={schoolYear} onChange={(e) => setSchoolYear(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="class-description">{t('classDescriptionLabel')}</FieldLabel>
                    <Textarea id="class-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="class-onleave">{t('classOnLeave')}</FieldLabel>
                    <select id="class-onleave" className={SELECT_CLASS} value={onLeave} onChange={(e) => setOnLeave(e.target.value as 'suspend' | 'unenrol')}>
                      <option value="suspend">{t('classOnLeaveSuspend')}</option>
                      <option value="unenrol">{t('classOnLeaveUnenrol')}</option>
                    </select>
                  </Field>
                  <Button type="submit" disabled={saveMutation.isPending || !name.trim()}>
                    {t('classSave')}
                  </Button>
                </FieldGroup>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('classSelfReport')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">{t('classSelfReportHint')}</p>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={allowSelfReport} onCheckedChange={(v) => setAllowSelfReport(v === true)} />
                {t('classAllowSelfReport')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={joinAutoApprove} onCheckedChange={(v) => setJoinAutoApprove(v === true)} />
                {t('classJoinAutoApprove')}
              </label>
              <Button type="button" onClick={onSubmit} disabled={saveMutation.isPending}>
                {t('classSave')}
              </Button>
              {allowSelfReport && cls.joinCode ? (
                <div className="flex flex-col gap-1 text-sm">
                  <p>
                    {t('classJoinCode')}: <strong>{cls.joinCode}</strong>
                  </p>
                  {joinLink ? (
                    <p className="break-all text-muted-foreground">
                      {t('classJoinLink')}: {joinLink}
                    </p>
                  ) : null}
                  <div>
                    <Button type="button" variant="outline" size="sm" disabled={rotateMutation.isPending} onClick={() => rotateMutation.mutate()}>
                      {t('classRotateJoinCode')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('classFee')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">{t('classFeeHint')}</p>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="class-fee-cost">{t('classFeeCost')}</FieldLabel>
                  <Input
                    id="class-fee-cost"
                    inputMode="numeric"
                    value={feeCost}
                    onChange={(e) => setFeeCost(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="class-fee-currency">{t('classFeeCurrency')}</FieldLabel>
                  <Input id="class-fee-currency" value={feeCurrency} onChange={(e) => setFeeCurrency(e.target.value)} maxLength={3} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="class-fee-account">{t('classFeeAccountId')}</FieldLabel>
                  <Input id="class-fee-account" value={feePaymentAccountId} onChange={(e) => setFeePaymentAccountId(e.target.value)} />
                </Field>
              </FieldGroup>
              <div>
                <Button type="button" onClick={onSubmit} disabled={saveMutation.isPending}>
                  {t('classSave')}
                </Button>
              </div>
              {cls.feeCost !== null && cls.feeCost > 0 ? (
                <p className="text-sm">
                  {t('classPublicFeeLabel')}:{' '}
                  <strong>
                    {cls.feeCost.toLocaleString()} {cls.feeCurrency}
                  </strong>{' '}
                  — {`${window.location.origin}/classes/${cls.id}/public`}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}
    </PageShell>
  );
}

export default ClassEditPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';
import { appKeyMeta } from '#lib/route-meta';
export function meta() {
  return appKeyMeta('classEditTitle');
}
