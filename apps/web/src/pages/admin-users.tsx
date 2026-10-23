import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { UserListResponse } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';

export function AdminUsersPage() {
  const { t } = useTranslation('app');
  const [data, setData] = useState<UserListResponse | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ username: '', email: '', password: '' });

  const load = useCallback(async () => {
    try {
      const res = await apiJson<UserListResponse>(`/api/v1/users?search=${encodeURIComponent(search)}&page=1&pageSize=20`);
      setData(res);
      setError(null);
    } catch {
      setError(t('usersLoadFailed'));
    }
  }, [search]);

  useEffect(() => { void load(); }, [load]);

  async function createUser(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/users', { method: 'POST', body: JSON.stringify(draft) });
    setDraft({ username: '', email: '', password: '' });
    await load();
  }
  async function suspend(id: string, suspended: boolean) {
    await apiJson(`/api/v1/users/${id}/${suspended ? 'suspend' : 'unsuspend'}`, { method: 'POST' });
    await load();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('usersTitle')}</CardTitle>
          <CardDescription>{t('usersDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input aria-label={t('searchUsers')} placeholder={t('searchUsersPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button type="button" onClick={() => void load()}>{t('search')}</Button>
          </div>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <ul className="divide-y">
            {data?.users.map((u) => (
              <li key={u.id} className="flex items-center justify-between py-2">
                <span>
                  <strong>{u.username}</strong> — {u.firstname} {u.lastname}
                  {u.email ? ` <${u.email}>` : ''}
                  {u.suspended ? ` ${t('suspendedSuffix')}` : ''}{u.deleted ? ` ${t('deletedSuffix')}` : ''}
                </span>
                <Button type="button" variant="outline" onClick={() => void suspend(u.id, !u.suspended)}>
                  {u.suspended ? t('unsuspend') : t('suspend')}
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{t('total', { total: data?.total ?? 0 })}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('createUser')}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={createUser} className="space-y-3">
            <div className="space-y-1"><Label htmlFor="new-username">{t('username')}</Label>
              <Input id="new-username" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} required /></div>
            <div className="space-y-1"><Label htmlFor="new-email">{t('email')}</Label>
              <Input id="new-email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} required /></div>
            <div className="space-y-1"><Label htmlFor="new-password">{t('password')}</Label>
              <Input id="new-password" type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} required /></div>
            <Button type="submit">{t('create')}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default AdminUsersPage;
