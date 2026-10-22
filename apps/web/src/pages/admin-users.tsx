import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { UserListResponse } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';

export function AdminUsersPage() {
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
      setError('Could not load users — you may lack the moodle/user:viewdetails capability.');
    }
  }, [search]);

  useEffect(() => { void load(); }, [load]);

  async function createUser(event: FormEvent) {
    event.preventDefault();
    await apiJson('/api/v1/users', { method: 'POST', body: JSON.stringify(draft) });
    setDraft({ username: '', email: '', password: '' });
    await load();
  }
  async function suspend(id: number, suspended: boolean) {
    await apiJson(`/api/v1/users/${id}/${suspended ? 'suspend' : 'unsuspend'}`, { method: 'POST' });
    await load();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>Administer accounts (requires user capabilities; the API enforces them, this page only renders the result).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input aria-label="Search users" placeholder="Search username or email" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button type="button" onClick={() => void load()}>Search</Button>
          </div>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <ul className="divide-y">
            {data?.users.map((u) => (
              <li key={u.id} className="flex items-center justify-between py-2">
                <span>
                  <strong>{u.username}</strong> — {u.firstname} {u.lastname}
                  {u.email ? ` <${u.email}>` : ''}
                  {u.suspended ? ' (suspended)' : ''}{u.deleted ? ' (deleted)' : ''}
                </span>
                <Button type="button" variant="outline" onClick={() => void suspend(u.id, !u.suspended)}>
                  {u.suspended ? 'Unsuspend' : 'Suspend'}
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">Total: {data?.total ?? 0}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Create user</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={createUser} className="space-y-3">
            <div className="space-y-1"><Label htmlFor="new-username">Username</Label>
              <Input id="new-username" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} required /></div>
            <div className="space-y-1"><Label htmlFor="new-email">Email</Label>
              <Input id="new-email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} required /></div>
            <div className="space-y-1"><Label htmlFor="new-password">Password</Label>
              <Input id="new-password" type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} required /></div>
            <Button type="submit">Create</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
