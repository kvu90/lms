import { useEffect, useState, type FormEvent } from 'react';
import type { UserProfile } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export function ProfilePage() {
  const { user, reload } = useAuth();
  const [form, setForm] = useState<{ firstname: string; lastname: string; email: string; customFields: Record<string, string> } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setForm({
        firstname: user.firstname, lastname: user.lastname, email: user.email ?? '',
        customFields: Object.fromEntries(user.customFields.map((f) => [f.shortname, f.value ?? ''])),
      });
    }
  }, [user]);

  if (!user || !form) return <main className="p-8">Loading profile…</main>;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      const updated = await apiJson<UserProfile>(`/api/v1/users/${user!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ firstname: form!.firstname, lastname: form!.lastname, email: form!.email || undefined, customFields: form!.customFields }),
      });
      void updated;
      await reload();
      setMessage('Profile saved');
    } catch {
      setMessage('Could not save profile (validation or permission error)');
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <Card>
        <CardHeader>
          <CardTitle>Profile — {user.username}</CardTitle>
          <CardDescription>
            {user.email ? `Email: ${user.email}` : 'Email is hidden unless you hold the view-identity capability.'}
            {user.forcePasswordChange ? ' You must change your password.' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="firstname">First name</Label>
              <Input id="firstname" value={form.firstname} onChange={(e) => setForm({ ...form, firstname: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastname">Last name</Label>
              <Input id="lastname" value={form.lastname} onChange={(e) => setForm({ ...form, lastname: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            {user.customFields.map((field) => (
              <div className="space-y-2" key={field.shortname}>
                <Label htmlFor={`cf-${field.shortname}`}>{field.name} ({field.type})</Label>
                <Input
                  id={`cf-${field.shortname}`}
                  value={form.customFields[field.shortname] ?? ''}
                  onChange={(e) => setForm({ ...form, customFields: { ...form.customFields, [field.shortname]: e.target.value } })}
                />
              </div>
            ))}
            {message && <p role="status" className="text-sm">{message}</p>}
            <Button type="submit">Save profile</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
