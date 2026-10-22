import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';

interface BadgeView { id: number; name: string; description: string; type: number; courseid: number; status: number }
interface IssuedView { id: number; badgeid: number; uniquehash: string; dateissued: string; dateexpire: string | null; revoked: boolean }

/** Nhãn trạng thái huy hiệu dịch qua catalog ở thời điểm render (xem hook trong component). */

/**
 * Badges: "my badges" (immutable assertions, revoked ones stay
 * visible) plus a staff panel to create site badges, attach a
 * course-completion criterion and activate them. Criteria of an active
 * badge are frozen server-side; the panel surfaces that refusal.
 */
export function BadgesPage() {
  const { t } = useTranslation('app');
  const STATUS_LABEL: Record<number, string> = {
    0: t('badgeStatusInactive'), 1: t('badgeStatusActive'), 2: t('badgeStatusRetired'), 3: t('badgeStatusArchived'), 4: t('badgeStatusDisabled'),
  };
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

  useEffect(() => { void reload().catch(() => setError(t('badgesLoadFailed'))); }, [reload]);

  const badgeName = (id: number) => all.find((b) => b.id === id)?.name ?? t('badgeFallback', { id });

  async function createBadge(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson('/api/v1/badges', { method: 'POST', body: JSON.stringify({ name, type: 1 }) });
      setName('');
      setMessage(t('badgeCreated'));
      await reload();
    } catch { setMessage(t('badgeCreateFailed')); }
  }

  async function setCriteria(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson(`/api/v1/badges/${criteriaBadgeId}/criteria`, {
        method: 'PUT',
        body: JSON.stringify({ method: 1, leaves: [{ criteriatype: 'coursecompletion', params: { courseId: Number(criteriaCourseId) } }] }),
      });
      setMessage(t('criteriaSaved'));
      await reload();
    } catch { setMessage(t('criteriaRefused')); }
  }

  async function activate(id: number) {
    try {
      await apiJson(`/api/v1/badges/${id}/activate`, { method: 'POST', body: '{}' });
      setMessage(t('badgeActivated'));
      await reload();
    } catch { setMessage(t('badgeActivationRefused')); }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      {error ? <p role="alert">{error}</p> : null}
      <Card>
        <CardHeader><CardTitle>{t('myBadges')}</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-2" aria-label={t('myBadgesLabel')}>
            {mine.map((i) => (
              <li key={i.id} className="rounded border p-2">
                <p className="font-medium">{badgeName(i.badgeid)}{i.revoked ? ` ${t('revokedSuffix')}` : ''}</p>
                <p className="text-xs text-muted-foreground">
                  {t('issuedLine', { date: new Date(i.dateissued).toLocaleDateString(), hash: i.uniquehash.slice(0, 12) })}
                  {i.dateexpire ? ` ${t('expiresSuffix', { date: new Date(i.dateexpire).toLocaleDateString() })}` : ''}
                </p>
              </li>
            ))}
            {mine.length === 0 ? <li>{t('noBadgesYet')}</li> : null}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('badgeAdministration')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {message ? <p>{message}</p> : null}
          <ul className="space-y-1" aria-label={t('allBadgesLabel')}>
            {all.map((b) => (
              <li key={b.id} className="flex items-center gap-3 text-sm">
                <span className="font-medium">{b.name}</span>
                <span>{STATUS_LABEL[b.status] ?? b.status}</span>
                {b.status === 0 ? <Button type="button" variant="outline" onClick={() => void activate(b.id)}>{t('activate')}</Button> : null}
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => void createBadge(e)} className="flex gap-2">
            <Label htmlFor="badge-name">{t('badgeName')}</Label>
            <Input id="badge-name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit">{t('createBadge')}</Button>
          </form>
          <form onSubmit={(e) => void setCriteria(e)} className="flex flex-wrap gap-2">
            <Label htmlFor="criteria-badge">{t('badgeId')}</Label>
            <Input id="criteria-badge" value={criteriaBadgeId} onChange={(e) => setCriteriaBadgeId(e.target.value)} />
            <Label htmlFor="criteria-course">{t('criteriaCourseId')}</Label>
            <Input id="criteria-course" value={criteriaCourseId} onChange={(e) => setCriteriaCourseId(e.target.value)} />
            <Button type="submit">{t('setCriteriaAll')}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
