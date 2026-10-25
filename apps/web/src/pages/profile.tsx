import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MfaTotpSetupResponse, OAuthIssuer, UserProfile } from '@lms/contracts';
import {
  mfaStatusResponseSchema,
  mfaTotpSetupResponseSchema,
  mySessionsResponseSchema,
  oauthAuthorizeResponseSchema,
  oauthLinksResponseSchema,
  oauthProvidersResponseSchema,
} from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Spinner } from '@lms/ui/components/spinner';
import { PageHeader, PageShell } from '../components/page-shell';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@lms/ui/components/table';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { ApiError, apiJson, redirectToExternalUrl } from '#lib/api';
import { useAuth } from '#lib/auth';
import { describeUserAgent } from '#lib/user-agent';
import { queryKeys } from '#lib/query-keys';

export function ProfilePage() {
  const { t } = useTranslation('app');
  const { user, reload } = useAuth();
  const [form, setForm] = useState<{
    firstName: string;
    lastName: string;
    email: string;
    customFields: Record<string, string>;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setForm({
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email ?? '',
        customFields: Object.fromEntries(user.customFields.map((f) => [f.shortName, f.value ?? ''])),
      });
    }
  }, [user]);

  if (!user || !form)
    return (
      <PageShell width="narrow">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t('profileLoading')}
        </div>
      </PageShell>
    );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      const updated = await apiJson<UserProfile>(`/api/v1/users/${user!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: form!.firstName,
          lastName: form!.lastName,
          email: form!.email || undefined,
          customFields: form!.customFields,
        }),
      });
      void updated;
      await reload();
      setMessage(t('profileSaved'));
    } catch {
      setMessage(t('profileSaveFailed'));
    }
  }

  return (
    <PageShell width="narrow">
      <PageHeader title={t('profileTitle', { username: user.username })} />
      <Card>
        {user.forcePasswordChange ? (
          <CardHeader>
            <CardDescription>{t('profileMustChangePassword')}</CardDescription>
          </CardHeader>
        ) : null}
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="firstname">{t('firstName')}</Label>
              <Input
                id="firstname"
                value={form.firstName}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastname">{t('lastName')}</Label>
              <Input
                id="lastname"
                value={form.lastName}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">{t('email')}</Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            {user.customFields.map((field) => (
              <div className="space-y-2" key={field.shortName}>
                <Label htmlFor={`cf-${field.shortName}`}>
                  {field.name} ({field.type})
                </Label>
                <Input
                  id={`cf-${field.shortName}`}
                  value={form.customFields[field.shortName] ?? ''}
                  onChange={(e) =>
                    setForm({ ...form, customFields: { ...form.customFields, [field.shortName]: e.target.value } })
                  }
                />
              </div>
            ))}
            {message && (
              <Alert>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}
            <Button type="submit">{t('saveProfile')}</Button>
          </form>
        </CardContent>
      </Card>
      <LinkedAccountsCard />
      <TwoFactorCard />
      <SessionsCard />
    </PageShell>
  );
}

/** Nhãn hiển thị của issuer lấy từ catalog i18n theo khoá riêng từng nhà cung cấp. */
function issuerLabel(t: (key: string) => string, issuer: OAuthIssuer): string {
  return issuer === 'google' ? t('oauthProviderGoogle') : t('oauthProviderFacebook');
}

/**
 * Thẻ "Tài khoản liên kết" (trang Linked logins của Moodle): liệt kê
 * các liên kết đăng nhập ngoài của chính người dùng, cho gỡ từng liên
 * kết và cho liên kết thêm issuer đang bật mà chưa có liên kết (đi qua
 * endpoint link của backend rồi chuyển hướng toàn trang tới nhà cung
 * cấp). Ràng buộc nghiệp vụ phía API — tài khoản không mật khẩu không
 * được gỡ liên kết cuối cùng — trả về mã `auth.last_login_method` và
 * được dịch sang thông báo i18n riêng thay vì hiện chi tiết kỹ thuật;
 * khi `hasPassword=false` thẻ cũng hiện sẵn gợi ý đặt mật khẩu trước.
 */
function LinkedAccountsCard() {
  const { t, i18n } = useTranslation('app');
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const linksQuery = useQuery({
    queryKey: queryKeys.oauthLinks,
    queryFn: async () => oauthLinksResponseSchema.parse(await apiJson('/api/v1/auth/oauth/links')),
  });
  const providersQuery = useQuery({
    queryKey: queryKeys.oauthProviders,
    queryFn: async () => oauthProvidersResponseSchema.parse(await apiJson('/api/v1/auth/oauth/providers')),
  });

  const unlinkMutation = useMutation({
    mutationFn: (id: string) => apiJson(`/api/v1/auth/oauth/links/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.oauthLinks });
    },
    onError: (err) =>
      setActionError(
        err instanceof ApiError && err.problem.code === 'auth.last_login_method'
          ? t('unlinkLastLoginMethod')
          : t('unlinkFailed'),
      ),
  });

  /** Bắt đầu liên kết một issuer: backend trả URL authorize kèm phiên đăng nhập hiện tại, trình duyệt chuyển hướng toàn trang tới nhà cung cấp. */
  async function startLink(issuer: OAuthIssuer) {
    setActionError(null);
    try {
      const data = oauthAuthorizeResponseSchema.parse(await apiJson(`/api/v1/auth/oauth/${issuer}/link`));
      redirectToExternalUrl(data.authorizeUrl);
    } catch {
      setActionError(t('oauthFailedGeneric'));
    }
  }

  const links = linksQuery.data?.links ?? [];
  const linkedIssuers = new Set(links.map((link) => link.issuer));
  const linkableIssuers = (providersQuery.data?.providers ?? [])
    .filter((p) => p.enabled && !linkedIssuers.has(p.issuer))
    .map((p) => p.issuer);

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base leading-normal font-medium">{t('linkedAccountsTitle')}</h2>
        <CardDescription>{t('linkedAccountsDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {linksQuery.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{t('linkedAccountsLoadFailed')}</AlertDescription>
          </Alert>
        ) : links.length === 0 ? (
          <Empty className="p-6">
            <EmptyHeader>
              <EmptyTitle>{t('noLinkedAccounts')}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="space-y-3">
            {links.map((link) => (
              <li key={link.id} className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{issuerLabel(t, link.issuer)}</span>
                <span className="text-sm">{link.email}</span>
                <span className="text-sm text-muted-foreground">
                  {t('linkedOn', { date: new Date(link.createdAt).toLocaleDateString(i18n.language) })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={unlinkMutation.isPending}
                  onClick={() => unlinkMutation.mutate(link.id)}
                >
                  {t('unlinkAccount')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {linksQuery.data && !linksQuery.data.hasPassword && (
          <p className="text-sm text-muted-foreground">{t('setPasswordBeforeUnlinkHint')}</p>
        )}
        {actionError && (
          <Alert variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}
        {linkableIssuers.map((issuer) => (
          <Button key={issuer} type="button" variant="outline" onClick={() => void startLink(issuer)}>
            {t('linkAccountWith', { provider: issuerLabel(t, issuer) })}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Thẻ "Xác thực hai lớp" (factor TOTP của tool_mfa trong Moodle): MFA
 * mặc định TẮT và chỉ bật khi chính người dùng đi hết luồng tại đây —
 * gọi setup lấy secret + otpauth URL (chỉ lộ ở bước này), vẽ QR cho
 * ứng dụng xác thực quét (hoặc nhập tay khoá bí mật), rồi confirm bằng
 * mã 6 số hiện tại. Trạng thái hiển thị đọc từ GET /auth/mfa/status
 * nên setup chưa confirm vẫn hiện là chưa bật. Tắt cũng phải có mã
 * hiện tại; mã sai trả `auth.mfa_invalid_code` và được dịch sang
 * thông báo riêng, giữ nguyên bước để người dùng nhập lại.
 */
function TwoFactorCard() {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'idle' | 'setup' | 'disable'>('idle');
  const [setupData, setSetupData] = useState<MfaTotpSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const statusQuery = useQuery({
    queryKey: queryKeys.mfaStatus,
    queryFn: async () => mfaStatusResponseSchema.parse(await apiJson('/api/v1/auth/mfa/status')),
  });
  const enabled = statusQuery.data?.enabled ?? false;

  /** Kết thúc một luồng con (bật hoặc tắt): dọn mã đã nhập và nạp lại trạng thái thật từ API. */
  function finishFlow(successMessage: string) {
    setStep('idle');
    setSetupData(null);
    setCode('');
    setActionError(null);
    setFeedback(successMessage);
    void queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus });
  }

  /** Map lỗi API sang thông báo: mã sai có thông báo riêng để người dùng nhập lại, còn lại dùng thông báo chung. */
  function showActionError(err: unknown) {
    setActionError(
      err instanceof ApiError && err.problem.code === 'auth.mfa_invalid_code'
        ? t('twoFactorInvalidCode')
        : t('twoFactorActionFailed'),
    );
  }

  const setupMutation = useMutation({
    mutationFn: async () =>
      mfaTotpSetupResponseSchema.parse(await apiJson('/api/v1/auth/mfa/totp/setup', { method: 'POST' })),
    onSuccess: (data) => {
      setSetupData(data);
      setStep('setup');
      setCode('');
      setCopied(false);
      setActionError(null);
      setFeedback(null);
    },
    onError: () => setActionError(t('twoFactorSetupFailed')),
  });
  const confirmMutation = useMutation({
    mutationFn: (value: string) =>
      apiJson('/api/v1/auth/mfa/totp/confirm', { method: 'POST', body: JSON.stringify({ code: value }) }),
    onSuccess: () => finishFlow(t('twoFactorEnabledSuccess')),
    onError: showActionError,
  });
  const disableMutation = useMutation({
    mutationFn: (value: string) =>
      apiJson('/api/v1/auth/mfa/totp/disable', { method: 'POST', body: JSON.stringify({ code: value }) }),
    onSuccess: () => finishFlow(t('twoFactorDisabledSuccess')),
    onError: showActionError,
  });

  /** Sao chép khoá bí mật cho người dùng không quét được QR; clipboard không khả dụng thì bỏ qua lặng lẽ (khoá vẫn hiện dạng chữ). */
  async function copySecret() {
    if (!setupData) return;
    try {
      await navigator.clipboard.writeText(setupData.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base leading-normal font-medium">{t('twoFactorTitle')}</h2>
        <CardDescription>{t('twoFactorDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Huy hiệu trạng thái chỉ hiện khi đã có dữ liệu thật: lúc
            đang tải mà hiện "Chưa bật" là khẳng định sai về tài khoản. */}
        {statusQuery.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{t('twoFactorLoadFailed')}</AlertDescription>
          </Alert>
        ) : statusQuery.data ? (
          <p>
            <Badge variant={enabled ? 'default' : 'outline'}>
              {enabled ? t('twoFactorEnabledStatus') : t('twoFactorDisabledStatus')}
            </Badge>
          </p>
        ) : null}
        {feedback && (
          <Alert>
            <AlertDescription>{feedback}</AlertDescription>
          </Alert>
        )}
        {actionError && (
          <Alert variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}
        {step === 'idle' &&
          statusQuery.data &&
          (enabled ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setStep('disable');
                setCode('');
                setActionError(null);
                setFeedback(null);
              }}
            >
              {t('disableTwoFactor')}
            </Button>
          ) : (
            <Button type="button" disabled={setupMutation.isPending} onClick={() => setupMutation.mutate()}>
              {t('enableTwoFactor')}
            </Button>
          ))}
        {step === 'setup' && setupData && (
          <div className="space-y-4">
            <p className="text-sm">{t('twoFactorSetupInstruction')}</p>
            <div className="bg-white p-3 w-fit">
              <QRCodeSVG value={setupData.otpauthUrl} size={192} role="img" aria-label={t('twoFactorTitle')} />
            </div>
            <div className="space-y-2">
              <Label>{t('twoFactorSecretLabel')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-sm break-all">{setupData.secret}</code>
                <Button type="button" variant="outline" size="sm" onClick={() => void copySecret()}>
                  {t('copySecret')}
                </Button>
              </div>
              {copied && (
                <p role="status" className="text-sm">
                  {t('secretCopied')}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mfa-setup-code">{t('twoFactorCodeLabel')}</Label>
              <Input
                id="mfa-setup-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={code.length !== 6 || confirmMutation.isPending}
                onClick={() => confirmMutation.mutate(code)}
              >
                {t('confirmEnableTwoFactor')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStep('idle');
                  setSetupData(null);
                  setCode('');
                  setActionError(null);
                }}
              >
                {t('cancelTwoFactorSetup')}
              </Button>
            </div>
          </div>
        )}
        {step === 'disable' && (
          <div className="space-y-4">
            <p className="text-sm">{t('twoFactorDisableInstruction')}</p>
            <div className="space-y-2">
              <Label htmlFor="mfa-disable-code">{t('twoFactorCodeLabel')}</Label>
              <Input
                id="mfa-disable-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={code.length !== 6 || disableMutation.isPending}
                onClick={() => disableMutation.mutate(code)}
              >
                {t('confirmDisableTwoFactor')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStep('idle');
                  setCode('');
                  setActionError(null);
                }}
              >
                {t('cancelTwoFactorSetup')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Thẻ "Phiên đăng nhập" (trang quản lý phiên của chính người dùng,
 * report_usersessions của Moodle): bảng mọi phiên đang hoạt động —
 * phiên web (cookie) và phiên API (họ refresh token) — kèm IP và
 * thiết bị; phiên hiện tại mang huy hiệu riêng và không có nút huỷ
 * (huỷ chính mình thì dùng đăng xuất), các phiên khác huỷ được từng
 * phiên hoặc huỷ tất cả trong một thao tác. Sau mỗi đột biến, danh
 * sách được vô hiệu hoá để tải lại trạng thái thật từ API.
 */
function SessionsCard() {
  const { t, i18n } = useTranslation('app');
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: queryKeys.mySessions,
    queryFn: async () => mySessionsResponseSchema.parse(await apiJson('/api/v1/auth/sessions')),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiJson(`/api/v1/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.mySessions });
    },
    onError: () => setActionError(t('revokeSessionFailed')),
  });
  const revokeOthersMutation = useMutation({
    mutationFn: () => apiJson('/api/v1/auth/sessions/others', { method: 'DELETE' }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.mySessions });
    },
    onError: () => setActionError(t('revokeOtherSessionsFailed')),
  });

  const sessions = sessionsQuery.data?.sessions ?? [];
  const hasOtherSessions = sessions.some((s) => !s.current);
  const formatDateTime = (iso: string) => new Date(iso).toLocaleString(i18n.language);

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base leading-normal font-medium">{t('sessionsTitle')}</h2>
        <CardDescription>{t('sessionsDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sessionsQuery.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{t('sessionsLoadFailed')}</AlertDescription>
          </Alert>
        ) : sessions.length === 0 ? (
          <Empty className="p-6">
            <EmptyHeader>
              <EmptyTitle>{t('noSessions')}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('sessionCreatedAt')}</TableHead>
                <TableHead>{t('sessionLastActivityAt')}</TableHead>
                <TableHead>{t('sessionIp')}</TableHead>
                <TableHead>{t('sessionDevice')}</TableHead>
                <TableHead>{t('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>{formatDateTime(session.createdAt)}</TableCell>
                  <TableCell>{formatDateTime(session.lastActivityAt)}</TableCell>
                  <TableCell>{session.ip ?? t('sessionUnknown')}</TableCell>
                  <TableCell>
                    {describeUserAgent(session.userAgent, t('sessionUnknown'), (browser, os) =>
                      t('sessionDeviceDescription', { browser, os }),
                    )}
                  </TableCell>
                  <TableCell>
                    {session.current ? (
                      <Badge>{t('sessionCurrent')}</Badge>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={revokeMutation.isPending}
                        onClick={() => revokeMutation.mutate(session.id)}
                      >
                        {t('revokeSession')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {actionError && (
          <Alert variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}
        {hasOtherSessions && (
          <Button
            type="button"
            variant="destructive"
            disabled={revokeOthersMutation.isPending}
            onClick={() => revokeOthersMutation.mutate()}
          >
            {t('revokeOtherSessions')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default ProfilePage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navProfile');
}
