import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Spinner } from '@lms/ui/components/spinner';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { PageShell } from '../components/page-shell';
import { useAuth } from '#lib/auth';

/**
 * Trang đích sau callback đăng nhập ngoài (issue #7, GĐ2): callback
 * của Better Auth đã đặt cookie phiên rồi chuyển hướng trình duyệt về
 * đây (callbackURL của signIn.social) — KHÔNG còn mã bàn giao đi qua
 * URL như luồng OAuth tự viết trước đây. Việc của trang chỉ là buộc
 * tầng phiên resolve lại từ cookie: có phiên thì sang hồ sơ, không có
 * (luồng ngoài thất bại ở phía nhà cung cấp/server) thì hiện lỗi và
 * đường về trang đăng nhập. `reload` chỉ chạy một lần (ref chặn
 * StrictMode mount hai lần) và trạng thái lỗi chỉ chốt sau khi lần
 * resolve đó kết thúc — tránh báo lỗi oan trong lúc phiên đang nạp.
 */
export function OAuthCallbackPage() {
  const { t } = useTranslation('app');
  const { user, reload } = useAuth();
  const navigate = useNavigate();
  const [settled, setSettled] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let alive = true;
    void reload().finally(() => {
      if (alive) setSettled(true);
    });
    return () => {
      alive = false;
    };
  }, [reload]);

  useEffect(() => {
    if (settled && user) navigate('/profile', { replace: true });
  }, [settled, user, navigate]);

  const failed = settled && !user;

  return (
    <PageShell width="narrow" contentClassName="mx-auto w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{t('oauthCallbackTitle')}</CardTitle>
          <CardDescription>{t('oauthCallbackDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!failed && (
            <div className="flex justify-center py-2">
              <Spinner className="size-6" />
            </div>
          )}
          {failed && (
            <>
              <ErrorAlert variant="destructive">
                {t('oauthCallbackFailed')}
              </ErrorAlert>
              <Button type="button" variant="outline" className="w-full" onClick={() => navigate('/login')}>
                {t('backToLogin')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default OAuthCallbackPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('signIn');
}
