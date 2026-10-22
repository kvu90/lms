import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';

interface NotificationView { id: number; subject: string; fullmessage: string; eventtype: string; timeread: string | null; timecreated: string }
interface PreferenceView { provider: string; channel: string; loggedin: boolean; loggedoff: boolean }

/**
 * Notification centre + preferences. A notification only exists when
 * the (provider × channel × login-state) preference allowed the popup
 * channel; the toggles below write straight through to the API and take
 * effect on the very next dispatch.
 */
export function NotificationsPage() {
  const { t } = useTranslation('app');
  const [items, setItems] = useState<NotificationView[]>([]);
  const [prefs, setPrefs] = useState<PreferenceView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [list, p] = await Promise.all([
      apiJson<NotificationView[]>('/api/v1/notifications'),
      apiJson<PreferenceView[]>('/api/v1/notifications/preferences'),
    ]);
    setItems(list);
    setPrefs(p);
  }, []);

  useEffect(() => { void reload().catch(() => setError(t('notificationsLoadFailed'))); }, [reload]);

  async function toggle(pref: PreferenceView, field: 'loggedin' | 'loggedoff') {
    const next = { ...pref, [field]: !pref[field] };
    await apiJson('/api/v1/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify({
        preferences: prefs.map((p) => (p.provider === pref.provider && p.channel === pref.channel ? next : p)),
      }),
    });
    await reload();
  }

  async function markAllRead() {
    await apiJson('/api/v1/notifications/read-all', { method: 'POST', body: '{}' });
    await reload();
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('notifications')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? <p role="alert">{error}</p> : null}
          <Button type="button" variant="outline" onClick={() => void markAllRead()}>{t('markAllRead')}</Button>
          <ul className="space-y-2" aria-label={t('notificationsListLabel')}>
            {items.map((n) => (
              <li key={n.id} className={`rounded border p-2 ${n.timeread ? 'opacity-60' : ''}`}>
                <p className="font-medium">{n.subject}</p>
                <p className="text-sm">{n.fullmessage}</p>
                <p className="text-xs text-muted-foreground">{n.eventtype} · {new Date(n.timecreated).toLocaleString()}{n.timeread ? ` · ${t('readSuffix')}` : ` · ${t('unreadStateSuffix')}`}</p>
              </li>
            ))}
            {items.length === 0 ? <li>{t('noNotifications')}</li> : null}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('notificationPreferences')}</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr><th className="text-left">{t('provider')}</th><th className="text-left">{t('channel')}</th><th>{t('loggedIn')}</th><th>{t('loggedOff')}</th></tr>
            </thead>
            <tbody>
              {prefs.map((p) => (
                <tr key={`${p.provider}-${p.channel}`}>
                  <td>{p.provider}</td>
                  <td>{p.channel}</td>
                  <td>
                    <input aria-label={`${p.provider} ${p.channel} ${t('prefLoggedIn')}`} type="checkbox" checked={p.loggedin}
                      onChange={() => void toggle(p, 'loggedin')} />
                  </td>
                  <td>
                    <input aria-label={`${p.provider} ${p.channel} ${t('prefLoggedOff')}`} type="checkbox" checked={p.loggedoff}
                      onChange={() => void toggle(p, 'loggedoff')} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </main>
  );
}
