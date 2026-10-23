import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import type { OAuthIssuer } from '@lms/contracts';
import { oauthAuthorizeResponseSchema, oauthProvidersResponseSchema } from '@lms/contracts';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/ui/card';
import { Input } from '@lms/ui/components/ui/input';
import { Label } from '@lms/ui/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { ApiError, apiJson, MfaChallengeError, redirectToExternalUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { queryKeys } from '@/lib/query-keys';

/**
 * Map mã lỗi OAuth mà callback của backend gắn vào `?oauthError=` sang
 * khoá i18n tương ứng; mã lạ rơi về thông báo chung để không lộ chi
 * tiết kỹ thuật của nhà cung cấp lên giao diện.
 */
const OAUTH_ERROR_KEYS: Record<string, string> = {
  'auth.account_inactive': 'oauthErrorAccountInactive',
  'auth.oauth_email_unverified': 'oauthErrorEmailUnverified',
  'auth.oauth_email_missing': 'oauthErrorEmailMissing',
};

/** Nhãn nút đăng nhập theo issuer — chỉ các issuer trong hợp đồng mới có nút. */
const OAUTH_BUTTON_KEYS: Record<OAuthIssuer, string> = {
  google: 'signInWithGoogle',
  facebook: 'signInWithFacebook',
};

export function LoginPage() {
  const { t } = useTranslation('app');
  const { login, completeMfaLogin } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bước MFA: khi login trả thách thức thì giữ challengeToken tại đây
  // và chuyển form sang nhập mã TOTP; quay lại thì xoá hẳn challenge.
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);

  /**
   * Danh sách issuer đang bật lấy từ endpoint công khai: issuer chưa
   * được quản trị cấu hình (enabled=false) thì KHÔNG hiện nút — đúng
   * hành vi của Moodle với issuer chưa bật ở trang login.
   */
  const providersQuery = useQuery({
    queryKey: queryKeys.oauthProviders,
    queryFn: async () => oauthProvidersResponseSchema.parse(await apiJson('/api/v1/auth/oauth/providers')),
  });
  const enabledIssuers = (providersQuery.data?.providers ?? []).filter((p) => p.enabled).map((p) => p.issuer);

  const oauthErrorCode = searchParams.get('oauthError');
  const oauthError = oauthErrorCode ? t(OAUTH_ERROR_KEYS[oauthErrorCode] ?? 'oauthFailedGeneric') : null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate('/profile');
    } catch (err) {
      // Thách thức MFA không phải lỗi: chuyển bước, giữ nguyên phiên
      // đang dở bằng challengeToken để bước sau hoàn tất đăng nhập.
      if (err instanceof MfaChallengeError) {
        setChallengeToken(err.challenge.challengeToken);
        setMfaCode('');
        setMfaError(null);
      } else {
        setError(err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : t('loginFailed'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onMfaSubmit(event: FormEvent) {
    event.preventDefault();
    if (!challengeToken) return;
    setMfaBusy(true);
    setMfaError(null);
    try {
      await completeMfaLogin(challengeToken, mfaCode);
      navigate('/profile');
    } catch (err) {
      setMfaError(err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : t('mfaFailed'));
    } finally {
      setMfaBusy(false);
    }
  }

  /**
   * Bắt đầu luồng OAuth: xin URL authorize của backend rồi chuyển
   * hướng toàn trang tới nhà cung cấp (không mở popup — nhà cung cấp
   * sẽ redirect về callback của backend, backend mới đưa về SPA).
   */
  async function startOAuth(issuer: OAuthIssuer) {
    setError(null);
    try {
      const data = oauthAuthorizeResponseSchema.parse(await apiJson(`/api/v1/auth/oauth/${issuer}/authorize`));
      redirectToExternalUrl(data.authorizeUrl);
    } catch {
      setError(t('oauthFailedGeneric'));
    }
  }

  if (challengeToken) {
    return (
      <main className="mx-auto max-w-md p-8">
        <Card>
          <CardHeader>
            <CardTitle>{t('mfaTitle')}</CardTitle>
            <CardDescription>{t('mfaDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onMfaSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mfa-code">{t('mfaCode')}</Label>
                <Input
                  id="mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  required
                />
              </div>
              {mfaError && (
                <p role="alert" className="text-sm text-destructive">
                  {mfaError}
                </p>
              )}
              <Button type="submit" disabled={mfaBusy} className="w-full">
                {mfaBusy ? t('mfaVerifying') : t('mfaVerify')}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  setChallengeToken(null);
                  setMfaError(null);
                }}
              >
                {t('mfaBack')}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('loginTitle')}</CardTitle>
          <CardDescription>{t('loginDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">{t('username')}</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {oauthError && (
              <p role="alert" className="text-sm text-destructive">
                {oauthError}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? t('signingIn') : t('signIn')}
            </Button>
          </form>
          {enabledIssuers.length > 0 && (
            <div className="mt-6 space-y-3">
              <p className="text-center text-sm text-muted-foreground">{t('oauthOrContinueWith')}</p>
              {enabledIssuers.map((issuer) => (
                <Button
                  key={issuer}
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => void startOAuth(issuer)}
                >
                  {t(OAUTH_BUTTON_KEYS[issuer])}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default LoginPage;
