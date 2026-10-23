import { useCallback, useEffect, useState } from 'react';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';

interface NotificationView {
  id: string;
  subject: string;
  fullMessage: string;
  eventType: string;
  timeRead: string | null;
  createdAt: string;
}

type PreferenceChannel = 'popup' | 'email' | 'push';
type PreferenceState = 'loggedin' | 'loggedoff';

/**
 * Một dòng tuỳ chọn đúng như API trả: mỗi (provider × channel × state)
 * là một bản ghi độc lập kèm cờ `enabled` của chính nó. PUT cũng chỉ
 * nhận đúng một dòng như vậy (`setMessagePreferenceSchema`), không có
 * khái niệm lưu cả cục.
 */
interface PreferenceRow {
  provider: string;
  component: string;
  channel: PreferenceChannel;
  state: PreferenceState;
  enabled: boolean;
}

function preferenceKey(row: Pick<PreferenceRow, 'provider' | 'channel' | 'state'>): string {
  return `${row.provider}|${row.channel}|${row.state}`;
}

/**
 * Notification centre + preferences. A notification only exists when
 * the (provider × channel × login-state) preference allowed the popup
 * channel; each toggle PUTs exactly that one preference row through to
 * the API and takes effect on the very next dispatch.
 */
export function NotificationsPage() {
  const { t } = useTranslation('app');
  const [items, setItems] = useState<NotificationView[]>([]);
  const [prefs, setPrefs] = useState<PreferenceRow[]>([]);
  const [savingPrefs, setSavingPrefs] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [prefError, setPrefError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [list, p] = await Promise.all([
      apiJson<NotificationView[]>('/api/v1/notifications'),
      apiJson<PreferenceRow[]>('/api/v1/messages/preferences'),
    ]);
    setItems(list);
    setPrefs(p);
  }, []);

  useEffect(() => {
    void reload().catch(() => setError(t('notificationsLoadFailed')));
  }, [reload]);

  async function toggle(row: PreferenceRow) {
    const key = preferenceKey(row);
    if (savingPrefs.has(key)) return;
    const enabled = !row.enabled;
    setPrefError(null);
    setSavingPrefs((prev) => new Set(prev).add(key));
    // Cập nhật lạc quan đúng một dòng; PUT lỗi thì hoàn lại dòng đó và
    // báo lỗi riêng của khu vực tuỳ chọn, các dòng khác không bị đụng.
    setPrefs((prev) => prev.map((p) => (preferenceKey(p) === key ? { ...p, enabled } : p)));
    try {
      const saved = await apiJson<PreferenceRow>('/api/v1/messages/preferences', {
        method: 'PUT',
        body: JSON.stringify({ provider: row.provider, channel: row.channel, state: row.state, enabled }),
      });
      setPrefs((prev) =>
        prev.map((p) => (preferenceKey(p) === key ? { ...p, enabled: saved.enabled } : p)),
      );
    } catch {
      setPrefs((prev) => prev.map((p) => (preferenceKey(p) === key ? { ...p, enabled: row.enabled } : p)));
      setPrefError(t('preferenceSaveFailed'));
    } finally {
      setSavingPrefs((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function markAllRead() {
    await apiJson('/api/v1/notifications/read-all', { method: 'POST', body: '{}' });
    await reload();
  }

  // Gộp các dòng phẳng của API thành từng cặp (provider × channel) để
  // dựng hai cột đã đăng nhập / chưa đăng nhập như trước; mỗi ô vẫn là
  // một dòng preference độc lập khi ghi.
  const pairs: { provider: string; channel: PreferenceChannel; byState: Partial<Record<PreferenceState, PreferenceRow>> }[] = [];
  for (const row of prefs) {
    let pair = pairs.find((p) => p.provider === row.provider && p.channel === row.channel);
    if (!pair) {
      pair = { provider: row.provider, channel: row.channel, byState: {} };
      pairs.push(pair);
    }
    pair.byState[row.state] = row;
  }

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('notifications')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? <p role="alert">{error}</p> : null}
          <Button type="button" variant="outline" onClick={() => void markAllRead()}>
            {t('markAllRead')}
          </Button>
          <ul className="space-y-2" aria-label={t('notificationsListLabel')}>
            {items.map((n) => (
              <li key={n.id} className={`rounded border p-2 ${n.timeRead ? 'opacity-60' : ''}`}>
                <p className="font-medium">{n.subject}</p>
                <p className="text-sm">{n.fullMessage}</p>
                <p className="text-xs text-muted-foreground">
                  {n.eventType} · {new Date(n.createdAt).toLocaleString()}
                  {n.timeRead ? ` · ${t('readSuffix')}` : ` · ${t('unreadStateSuffix')}`}
                </p>
              </li>
            ))}
            {items.length === 0 ? <li>{t('noNotifications')}</li> : null}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('notificationPreferences')}</CardTitle>
        </CardHeader>
        <CardContent>
          {prefError ? <p role="alert">{prefError}</p> : null}
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left">{t('provider')}</th>
                <th className="text-left">{t('channel')}</th>
                <th>{t('loggedIn')}</th>
                <th>{t('loggedOff')}</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((pair) => (
                <tr key={`${pair.provider}-${pair.channel}`}>
                  <td>{pair.provider}</td>
                  <td>{pair.channel}</td>
                  {(['loggedin', 'loggedoff'] as PreferenceState[]).map((state) => {
                    const row = pair.byState[state];
                    return (
                      <td key={state}>
                        {row ? (
                          <input
                            aria-label={`${pair.provider} ${pair.channel} ${state === 'loggedin' ? t('prefLoggedIn') : t('prefLoggedOff')}`}
                            type="checkbox"
                            checked={row.enabled}
                            disabled={savingPrefs.has(preferenceKey(row))}
                            onChange={() => void toggle(row)}
                          />
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default NotificationsPage;
