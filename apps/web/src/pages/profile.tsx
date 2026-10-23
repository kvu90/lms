import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OAuthIssuer, UserProfile } from '@lms/contracts';
import {
  mySessionsResponseSchema,
  oauthAuthorizeResponseSchema,
  oauthLinksResponseSchema,
  oauthProvidersResponseSchema,
} from '@lms/contracts';
import { Badge } from '@lms/ui/components/ui/badge';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@lms/ui/components/ui/card';
import { Input } from '@lms/ui/components/ui/input';
import { Label } from '@lms/ui/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@lms/ui/components/ui/table';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { ApiError, apiJson, redirectToExternalUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { queryKeys } from '@/lib/query-keys';

export function ProfilePage() {
  const { t } = useTranslation('app');
  const { user, reload } = useAuth();
  const [form, setForm] = useState<{
    firstname: string;
    lastname: string;
    email: string;
    customFields: Record<string, string>;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setForm({
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email ?? '',
        customFields: Object.fromEntries(user.customFields.map((f) => [f.shortname, f.value ?? ''])),
      });
    }
  }, [user]);

  if (!user || !form)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        {t('profileLoading')}
      </main>
    );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      const updated = await apiJson<UserProfile>(`/api/v1/users/${user!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstname: form!.firstname,
          lastname: form!.lastname,
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
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          {/* Tiêu đề thẻ là heading h2 thật như các trang khác, không
              phải chữ thường trong CardTitle; email không lặp lại ở đây
              vì form bên dưới đã có field Email để xem và sửa. */}
          <h2 className="text-base leading-normal font-medium">{t('profileTitle', { username: user.username })}</h2>
          {user.forcePasswordChange ? <CardDescription>{t('profileMustChangePassword')}</CardDescription> : null}
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="firstname">{t('firstName')}</Label>
              <Input
                id="firstname"
                value={form.firstname}
                onChange={(e) => setForm({ ...form, firstname: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastname">{t('lastName')}</Label>
              <Input
                id="lastname"
                value={form.lastname}
                onChange={(e) => setForm({ ...form, lastname: e.target.value })}
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
              <div className="space-y-2" key={field.shortname}>
                <Label htmlFor={`cf-${field.shortname}`}>
                  {field.name} ({field.type})
                </Label>
                <Input
                  id={`cf-${field.shortname}`}
                  value={form.customFields[field.shortname] ?? ''}
                  onChange={(e) =>
                    setForm({ ...form, customFields: { ...form.customFields, [field.shortname]: e.target.value } })
                  }
                />
              </div>
            ))}
            {message && (
              <p role="status" className="text-sm">
                {message}
              </p>
            )}
            <Button type="submit">{t('saveProfile')}</Button>
          </form>
        </CardContent>
      </Card>
      <LinkedAccountsCard />
      <SessionsCard />
    </main>
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
          <p role="alert" className="text-sm text-destructive">
            {t('linkedAccountsLoadFailed')}
          </p>
        ) : links.length === 0 ? (
          <p className="text-sm">{t('noLinkedAccounts')}</p>
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
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
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
 * Rút gọn user-agent cho cột thiết bị: chuỗi gốc rất dài và phần hữu
 * ích cho người dùng nhận diện phiên nằm ở đầu chuỗi, nên bảng chỉ
 * hiện tối đa 48 ký tự đầu kèm dấu ba chấm khi bị cắt.
 */
function shortenUserAgent(userAgent: string | null, unknownLabel: string): string {
  if (!userAgent) return unknownLabel;
  return userAgent.length > 48 ? `${userAgent.slice(0, 48)}…` : userAgent;
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
          <p role="alert" className="text-sm text-destructive">
            {t('sessionsLoadFailed')}
          </p>
        ) : sessions.length === 0 ? (
          <p className="text-sm">{t('noSessions')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('sessionKind')}</TableHead>
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
                  <TableCell>{session.kind === 'web' ? t('sessionKindWeb') : t('sessionKindApi')}</TableCell>
                  <TableCell>{formatDateTime(session.createdAt)}</TableCell>
                  <TableCell>{formatDateTime(session.lastActivityAt)}</TableCell>
                  <TableCell>{session.ip ?? t('sessionUnknown')}</TableCell>
                  <TableCell>{shortenUserAgent(session.userAgent, t('sessionUnknown'))}</TableCell>
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
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
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
