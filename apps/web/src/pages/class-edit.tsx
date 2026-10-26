import { useEffect, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Skeleton } from '@lms/ui/components/skeleton';
import { Textarea } from '@lms/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { fetchClass, updateClass } from '#lib/classes';
import { queryKeys } from '#lib/query-keys';

const SELECT_CLASS = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';

/**
 * Màn sửa lớp riêng (CLASS-1, issue #184) — ngoài thông tin cơ bản, màn
 * này giữ các cài đặt vòng đời của lớp: luật rời lớp (đình chỉ giữ điểm
 * là mặc định / rút hẳn), tự báo danh + mã tham gia + xoay mã, tự duyệt
 * yêu cầu. Mọi thay đổi đi qua PATCH /classes/:id; API gác quyền tại
 * context lớp nên web không tự giấu theo vai (AGENTS.md web: giấu UI
 * không phải là gác).
 */
export function ClassEditPage() {
  const { t } = useTranslation('app');
  const { id } = useParams<{ id: string }>();
  const classId = id ?? '';
  const queryClient = useQueryClient();
  const classQuery = useQuery({ queryKey: queryKeys.classDetail(classId), queryFn: () => fetchClass(classId), enabled: Boolean(classId) });

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [schoolYear, setSchoolYear] = useState('');
  const [description, setDescription] = useState('');
  const [onLeave, setOnLeave] = useState<'suspend' | 'unenrol'>('suspend');
  const [allowSelfReport, setAllowSelfReport] = useState(false);
  const [joinAutoApprove, setJoinAutoApprove] = useState(false);
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
  }, [classQuery.data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.classRoot(classId) });
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
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      {classQuery.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : classQuery.isError || !cls ? (
        <Alert variant="destructive">
          <AlertDescription>{t('classDetailLoadFailed')}</AlertDescription>
        </Alert>
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
        </div>
      )}
    </PageShell>
  );
}

export default ClassEditPage;
