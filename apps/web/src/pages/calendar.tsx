import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';

interface EventView {
  id: string; name: string; description: string; eventtype: string;
  timestart: string; timeduration: number; repeatid: string; isexception: boolean;
}

const TYPES = ['all', 'site', 'category', 'course', 'group', 'user'] as const;

/**
 * Calendar: current-month view with an event-type filter. The API
 * already applies the visibility law (site for all, course for enrolled,
 * group for members, user for the owner), so the page only groups what it
 * receives by day.
 */
export function CalendarPage() {
  const { t } = useTranslation('app');
  const [events, setEvents] = useState<EventView[]>([]);
  const [typeFilter, setTypeFilter] = useState<(typeof TYPES)[number]>('all');
  const [error, setError] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);

  const reload = useCallback(async () => {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const list = await apiJson<EventView[]>(`/api/v1/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`);
    setEvents(list);
  }, [now]);

  useEffect(() => { void reload().catch(() => setError(t('calendarLoadFailed'))); }, [reload]);

  const visible = events.filter((e) => typeFilter === 'all' || e.eventtype === typeFilter);
  const byDay = new Map<string, EventView[]>();
  for (const e of visible) {
    const day = new Date(e.timestart).toDateString();
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('calendarTitle', { month: now.toLocaleString(undefined, { month: 'long', year: 'numeric' }) })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <p role="alert">{error}</p> : null}
          <div className="flex items-center gap-2">
            <Label htmlFor="type-filter">{t('eventType')}</Label>
            <select id="type-filter" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as (typeof TYPES)[number])}>
              {TYPES.map((type) => <option key={type} value={type}>{t(`eventType${type[0]!.toUpperCase()}${type.slice(1)}`)}</option>)}
            </select>
          </div>
          {[...byDay.entries()].map(([day, dayEvents]) => (
            <section key={day} aria-label={day}>
              <h3 className="font-medium">{day}</h3>
              <ul className="space-y-1">
                {dayEvents.map((e) => (
                  <li key={e.id} className="rounded border p-2 text-sm">
                    <span className="font-medium">{e.name}</span>
                    <span className="text-muted-foreground"> · {e.eventtype} · {new Date(e.timestart).toLocaleTimeString()}</span>
                    {e.isexception ? <span> {t('adjustedOccurrence')}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {visible.length === 0 ? <p>{t('noEventsThisMonth')}</p> : null}
        </CardContent>
      </Card>
    </main>
  );
}
