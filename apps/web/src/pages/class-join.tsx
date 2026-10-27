import { useEffect, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button, buttonVariants } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { joinClassByCode, previewJoinClass, type ClassJoinPreview } from '#lib/classes';

/**
 * Trang tự báo danh (CLASS-1, issue #184): học sinh có tài khoản nhập mã
 * tham gia (hoặc mở link chứa ?code=) → xem trước lớp + chủ lớp → xin
 * vào. Kết quả theo luật API: lớp trống vào thẳng; lớp đã có HS vào hàng
 * chờ duyệt trừ khi chủ lớp bật tự duyệt; đã là thành viên thì báo rõ.
 * Lỗi mã được dịch thành một thông điệp duy nhất, không lộ lớp nào tồn
 * tại ngoài mã đúng.
 */
export function ClassJoinPage() {
  const { t } = useTranslation('app');
  const location = useLocation();
  const initialCode = new URLSearchParams(location.search).get('code') ?? '';
  const [code, setCode] = useState(initialCode);
  const [preview, setPreview] = useState<ClassJoinPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewMutation = useMutation({
    mutationFn: (value: string) => previewJoinClass(value),
    onSuccess: (data) => {
      setPreview(data);
      setError(null);
    },
    onError: () => {
      setPreview(null);
      setError(t('classJoinInvalid'));
    },
  });

  const joinMutation = useMutation({
    mutationFn: (value: string) => joinClassByCode(value),
    onSuccess: (result) => {
      setError(null);
      if (result.outcome === 'joined') setMessage(t('classJoinJoined', { name: result.class.name }));
      else if (result.outcome === 'pending') setMessage(t('classJoinPendingMsg', { name: result.class.name }));
      else setMessage(t('classJoinAlready', { name: result.class.name }));
    },
    onError: () => setError(t('classJoinInvalid')),
  });

  useEffect(() => {
    if (initialCode) previewMutation.mutate(initialCode);
    // Chỉ chạy cho mã có sẵn trong link lúc mở trang.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onPreview(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    if (code.trim()) previewMutation.mutate(code.trim());
  }

  return (
    <PageShell width="narrow">
      <PageHeader title={t('classJoinTitle')} description={t('classJoinDescription')} />
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('classJoinCodeInput')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={onPreview}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="join-code">{t('classJoinCodeInput')}</FieldLabel>
                <Input id="join-code" value={code} onChange={(e) => setCode(e.target.value)} required />
              </Field>
              <Button type="submit" disabled={previewMutation.isPending || !code.trim()}>
                {t('classJoinSubmit')}
              </Button>
            </FieldGroup>
          </form>
          {preview ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-base font-medium">{preview.name}</p>
              <p className="text-muted-foreground">{t('classJoinPreviewOwner', { name: preview.ownerName })}</p>
              <div>
                <Button type="button" disabled={joinMutation.isPending} onClick={() => joinMutation.mutate(code.trim())}>
                  {t('classJoinSubmit')}
                </Button>
              </div>
            </div>
          ) : null}
          {message ? (
            <div>
              <Link className={buttonVariants({ variant: 'outline' })} to="/classes">
                {t('classJoinGoToClasses')}
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </PageShell>
  );
}

export default ClassJoinPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('classJoinTitle');
}
