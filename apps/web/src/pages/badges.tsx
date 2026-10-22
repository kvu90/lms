import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { apiJson } from '@/lib/api';

interface BadgeView { id: number; name: string; description: string; type: number; courseid: number; status: number }
interface IssuedView { id: number; badgeid: number; uniquehash: string; dateissued: string; dateexpire: string | null; revoked: boolean }

const STATUS_LABEL: Record<number, string> = { 0: 'inactive', 1: 'active', 2: 'retired', 3: 'archived', 4: 'disabled' };

/**
 * Badges: "my badges" (immutable assertions, revoked ones stay
 * visible) plus a staff panel to create site badges, attach a
 * course-completion criterion and activate them. Criteria of an active
 * badge are frozen server-side; the panel surfaces that refusal.
 */
export function BadgesPage() {
  const { user } = useAuth();
  const [mine, setMine] = useState<IssuedView[]>([]);
  const [all, setAll] = useState<BadgeView[]>([]);
  const [name, setName] = useState('');
  const [criteriaBadgeId, setCriteriaBadgeId] = useState('');
  const [criteriaCourseId, setCriteriaCourseId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const badges = await apiJson<BadgeView[]>('/api/v1/badges');
    setAll(badges);
    if (user) {
      const issued = await apiJson<IssuedView[]>(`/api/v1/badges/users/${user.id}/issued`);
      setMine(issued);
    }
  }, [user]);

  useEffect(() => { void reload().catch(() => setError('Could not load badges')); }, [reload]);

  const badgeName = (id: number) => all.find((b) => b.id === id)?.name ?? `Badge ${id}`;

  async function createBadge(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson('/api/v1/badges', { method: 'POST', body: JSON.stringify({ name, type: 1 }) });
      setName('');
      setMessage('Badge created (inactive until criteria are set and it is activated).');
      await reload();
    } catch { setMessage('Could not create the badge (badges:createbadge capability required).'); }
  }

  async function setCriteria(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson(`/api/v1/badges/${criteriaBadgeId}/criteria`, {
        method: 'PUT',
        body: JSON.stringify({ method: 1, leaves: [{ criteriatype: 'coursecompletion', params: { courseId: Number(criteriaCourseId) } }] }),
      });
      setMessage('Criteria saved.');
      await reload();
    } catch { setMessage('Criteria refused — an active or already-issued badge is frozen; duplicate it to edit.'); }
  }

  async function activate(id: number) {
    try {
      await apiJson(`/api/v1/badges/${id}/activate`, { method: 'POST', body: '{}' });
      setMessage('Badge activated; eligible learners are awarded automatically.');
      await reload();
    } catch { setMessage('Activation refused — a badge needs criteria first.'); }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      {error ? <p role="alert">{error}</p> : null}
      <Card>
        <CardHeader><CardTitle>My badges</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-2" aria-label="My badges">
            {mine.map((i) => (
              <li key={i.id} className="rounded border p-2">
                <p className="font-medium">{badgeName(i.badgeid)}{i.revoked ? ' (revoked)' : ''}</p>
                <p className="text-xs text-muted-foreground">
                  Issued {new Date(i.dateissued).toLocaleDateString()} · assertion {i.uniquehash.slice(0, 12)}…
                  {i.dateexpire ? ` · expires ${new Date(i.dateexpire).toLocaleDateString()}` : ''}
                </p>
              </li>
            ))}
            {mine.length === 0 ? <li>No badges yet — complete courses to earn them.</li> : null}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Badge administration</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {message ? <p>{message}</p> : null}
          <ul className="space-y-1" aria-label="All badges">
            {all.map((b) => (
              <li key={b.id} className="flex items-center gap-3 text-sm">
                <span className="font-medium">{b.name}</span>
                <span>{STATUS_LABEL[b.status] ?? b.status}</span>
                {b.status === 0 ? <Button type="button" variant="outline" onClick={() => void activate(b.id)}>Activate</Button> : null}
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => void createBadge(e)} className="flex gap-2">
            <Label htmlFor="badge-name">Badge name</Label>
            <Input id="badge-name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit">Create badge</Button>
          </form>
          <form onSubmit={(e) => void setCriteria(e)} className="flex flex-wrap gap-2">
            <Label htmlFor="criteria-badge">Badge id</Label>
            <Input id="criteria-badge" value={criteriaBadgeId} onChange={(e) => setCriteriaBadgeId(e.target.value)} />
            <Label htmlFor="criteria-course">Course-completion course id</Label>
            <Input id="criteria-course" value={criteriaCourseId} onChange={(e) => setCriteriaCourseId(e.target.value)} />
            <Button type="submit">Set criteria (ALL)</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
