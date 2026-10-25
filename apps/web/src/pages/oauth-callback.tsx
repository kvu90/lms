import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Spinner } from '@lms/ui/components/spinner';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { PageShell } from '../components/page-shell';
import { useAuth } from '#lib/auth';

/**
 * Trang đích sau callback OAuth: backend chuyển hướng về đây kèm mã
 * bàn giao một lần trong query `handoff` (token không đi qua URL).
 * Trang đổi mã lấy phiên đăng nhập qua `loginWithHandoff` rồi sang
 * hồ sơ; mã chỉ dùng được MỘT lần nên phải chặn việc effect chạy lại
 * đổi mã lần hai (StrictMode/development mount hai lần) bằng ref ghi
 * mã đã thử — lần chạy lại với cùng mã sẽ bị bỏ qua thay vì báo lỗi
 * oan "mã đã dùng".
 */
export function OAuthCallbackPage() {
  const { t } = useTranslation('app');
  const { loginWithHandoff } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [failed, setFailed] = useState(false);
  const attemptedCode = useRef<string | null>(null);

  const code = searchParams.get('handoff');

  useEffect(() => {
    if (!code) {
      setFailed(true);
      return;
    }
    if (attemptedCode.current === code) return;
    attemptedCode.current = code;
    loginWithHandoff(code)
      .then(() => navigate('/profile', { replace: true }))
      .catch(() => setFailed(true));
  }, [code, loginWithHandoff, navigate]);

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
              <Alert variant="destructive">
                <AlertDescription>{t('oauthCallbackFailed')}</AlertDescription>
              </Alert>
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
