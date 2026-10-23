import { useEffect, useState, type FormEvent } from 'react';
import type { UserProfile } from '@lms/contracts';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@lms/ui/components/ui/card';
import { Input } from '@lms/ui/components/ui/input';
import { Label } from '@lms/ui/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';
import { useAuth } from '@/lib/auth';

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

  if (!user || !form) return <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">{t('profileLoading')}</main>;

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
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default ProfilePage;
