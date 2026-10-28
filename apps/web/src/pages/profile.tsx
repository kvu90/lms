import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { UserProfile } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Spinner } from '@lms/ui/components/spinner';
import { ErrorAlert } from '#components/error-alert';
import { PageHeader, PageShell } from '../components/page-shell';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { useAuth } from '#lib/auth';

/**
 * Trang HỒ SƠ (`/profile`) — từ issue #288 (quyết định 21:29 ngày
 * 26/10/2026 theo research chuẩn site lớn) trang này CHỈ còn thông tin
 * user: form họ/tên/email + các trường tuỳ biến, lưu qua
 * `PATCH /api/v1/users/:id` rồi nạp lại phiên (`reload`) để mọi bề mặt
 * dùng chung AuthContext thấy tên/email mới ngay.
 *
 * Mọi khối CÀI ĐẶT từng xếp chồng ở đây đã chuyển sang khu Cài đặt
 * riêng (menu trái): xác thực hai lớp + phiên đăng nhập ở
 * `/settings/security`, tài khoản liên kết ở
 * `/settings/linked-accounts` — các thẻ đó sống ở
 * `components/profile-cards.tsx` và chỉ được di chuyển nguyên trạng,
 * không đổi nghiệp vụ. Dòng nhắc `forcePasswordChange` giữ nguyên ở
 * đầu thẻ form như trước (khối đổi mật khẩu là lát riêng, chưa làm).
 */
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

  // Lưu hồ sơ qua đột biến TanStack Query (F-01 của #133): dữ liệu
  // đọc của trang vẫn là phiên ở AuthContext (không phải query), nên
  // đột biến không invalidate khoá nào — thành công thì nạp lại phiên
  // như trước để mọi bề mặt thấy tên/email mới ngay.
  const updateProfile = useMutation({
    mutationFn: (body: {
      firstName: string;
      lastName: string;
      email: string | undefined;
      customFields: Record<string, string>;
    }) =>
      apiJson<UserProfile>(`/api/v1/users/${user?.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  });

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
      const updated = await updateProfile.mutateAsync({
        firstName: form!.firstName,
        lastName: form!.lastName,
        email: form!.email || undefined,
        customFields: form!.customFields,
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
              <ErrorAlert>
                {message}
              </ErrorAlert>
            )}
            <Button type="submit">{t('saveProfile')}</Button>
          </form>
        </CardContent>
      </Card>
    </PageShell>
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
