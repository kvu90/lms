import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '@/lib/api';

interface EventView {
  id: string; name: string; description: string; eventtype: string;
  timestart: string; timeduration: number; repeatid: string; isexception: boolean;
}

/** Một đăng ký lịch ngoài (hàng của GET /calendar/subscriptions phía server). */
interface SubscriptionView {
  id: string; name: string; url: string | null; eventtype: string; pollinterval: number;
}

const TYPES = ['all', 'site', 'category', 'course', 'group', 'user'] as const;
const EVENT_TYPES = ['user', 'site', 'category', 'course', 'group'] as const;

/**
 * Lịch: xem sự kiện tháng hiện tại (lọc theo loại), tạo/xoá sự kiện, đặt
 * nhắc, và quản lý subscription lịch ngoài kèm nhập ngay. API áp dụng luật
 * hiển thị (site cho mọi người, course cho người đã ghi danh, group cho
 * thành viên, user chỉ cho chủ sở hữu) — vì vậy nút xoá chỉ hiện ở sự kiện
 * loại `user`, tức sự kiện của chính người đang xem; nhắc thì API cho phép
 * với mọi sự kiện người dùng nhìn thấy được.
 */
export function CalendarPage() {
  const { t } = useTranslation('app');
  const [events, setEvents] = useState<EventView[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionView[]>([]);
  const [typeFilter, setTypeFilter] = useState<(typeof TYPES)[number]>('all');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [evName, setEvName] = useState('');
  const [evDescription, setEvDescription] = useState('');
  const [evType, setEvType] = useState<(typeof EVENT_TYPES)[number]>('user');
  const [evStart, setEvStart] = useState('');
  const [evDuration, setEvDuration] = useState('3600');
  const [evLocation, setEvLocation] = useState('');
  const [evCourseId, setEvCourseId] = useState('');
  const [evGroupId, setEvGroupId] = useState('');
  const [evCategoryId, setEvCategoryId] = useState('');
  const [subName, setSubName] = useState('');
  const [subUrl, setSubUrl] = useState('');
  const now = useMemo(() => new Date(), []);

  /** Nạp sự kiện của tháng hiện tại và danh sách subscription. */
  const reload = useCallback(async () => {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const list = await apiJson<EventView[]>(`/api/v1/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`);
    setEvents(list);
    const subs = await apiJson<SubscriptionView[]>('/api/v1/calendar/subscriptions').catch(() => null);
    if (subs) setSubscriptions(subs);
  }, [now]);

  useEffect(() => { void reload().catch(() => setError(t('calendarLoadFailed'))); }, [reload, t]);

  /** Tạo sự kiện theo đúng DTO: loại sự kiện quyết định id phạm vi đi kèm. */
  async function createEvent(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson('/api/v1/calendar/events', {
        method: 'POST',
        body: JSON.stringify({
          name: evName,
          ...(evDescription ? { description: evDescription } : {}),
          eventtype: evType,
          timestart: new Date(evStart).toISOString(),
          ...(evDuration ? { timeduration: Number(evDuration) } : {}),
          ...(evLocation ? { location: evLocation } : {}),
          ...(evType === 'course' || evType === 'group' ? { courseid: evCourseId } : {}),
          ...(evType === 'group' ? { groupid: evGroupId } : {}),
          ...(evType === 'category' ? { categoryid: evCategoryId } : {}),
        }),
      });
      setEvName(''); setEvDescription(''); setEvLocation('');
      setMessage(t('eventCreated'));
      await reload();
    } catch { setMessage(t('eventCreateFailed')); }
  }

  /** Xoá một sự kiện của mình rồi nạp lại danh sách tháng. */
  async function deleteEvent(id: string) {
    setMessage(null);
    try {
      await apiJson(`/api/v1/calendar/events/${id}`, { method: 'DELETE' });
      setMessage(t('eventDeleted'));
      await reload();
    } catch { setMessage(t('eventDeleteFailed')); }
  }

  /** Đặt nhắc trước sự kiện 60 phút (DTO nhắc chỉ gồm `minutesBefore`). */
  async function remind(id: string) {
    setMessage(null);
    try {
      await apiJson(`/api/v1/calendar/events/${id}/remind`, {
        method: 'POST', body: JSON.stringify({ minutesBefore: 60 }),
      });
      setMessage(t('reminderSet'));
    } catch { setMessage(t('reminderFailed')); }
  }

  /**
   * Thêm subscription lịch ngoài từ URL ICS. Mặc định gắn loại `user`
   * (lịch cá nhân): loại `site` phía server đòi capability quản lý
   * subscription cấp hệ thống, không phù hợp cho subscription cá nhân.
   */
  async function createSubscription(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson('/api/v1/calendar/subscriptions', {
        method: 'POST',
        body: JSON.stringify({ name: subName, url: subUrl, eventtype: 'user' }),
      });
      setSubName(''); setSubUrl('');
      setMessage(t('subscriptionCreated'));
      await reload();
    } catch { setMessage(t('subscriptionCreateFailed')); }
  }

  /** Yêu cầu nhập ngay một subscription (server đưa vào hàng đợi worker). */
  async function importSubscription(id: string) {
    setMessage(null);
    try {
      await apiJson(`/api/v1/calendar/subscriptions/${id}/import`, { method: 'POST', body: '{}' });
      setMessage(t('importQueued'));
      await reload();
    } catch { setMessage(t('importFailed')); }
  }

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
          {message ? <p role="status">{message}</p> : null}
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
                  <li key={e.id} className="flex items-center gap-2 rounded border p-2 text-sm">
                    <span className="font-medium">{e.name}</span>
                    <span className="text-muted-foreground"> · {e.eventtype} · {new Date(e.timestart).toLocaleTimeString()}</span>
                    {e.isexception ? <span> {t('adjustedOccurrence')}</span> : null}
                    <Button type="button" variant="outline" onClick={() => void remind(e.id)}>{t('remindOneHour')}</Button>
                    {e.eventtype === 'user' ? (
                      <Button type="button" variant="outline" onClick={() => void deleteEvent(e.id)}>{t('deleteEvent')}</Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {visible.length === 0 ? <p>{t('noEventsThisMonth')}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('createEventTitle')}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={(e) => void createEvent(e)} className="space-y-3">
            <div>
              <Label htmlFor="ev-name">{t('eventName')}</Label>
              <Input id="ev-name" value={evName} onChange={(e) => setEvName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ev-description">{t('eventDescription')}</Label>
              <Input id="ev-description" value={evDescription} onChange={(e) => setEvDescription(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ev-type">{t('eventType')}</Label>
              <select id="ev-type" value={evType} onChange={(e) => setEvType(e.target.value as (typeof EVENT_TYPES)[number])}>
                {EVENT_TYPES.map((type) => <option key={type} value={type}>{t(`eventType${type[0]!.toUpperCase()}${type.slice(1)}`)}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="ev-start">{t('eventStart')}</Label>
              <Input id="ev-start" type="datetime-local" value={evStart} onChange={(e) => setEvStart(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ev-duration">{t('eventDurationSeconds')}</Label>
              <Input id="ev-duration" type="number" value={evDuration} onChange={(e) => setEvDuration(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ev-location">{t('eventLocation')}</Label>
              <Input id="ev-location" value={evLocation} onChange={(e) => setEvLocation(e.target.value)} />
            </div>
            {evType === 'course' || evType === 'group' ? (
              <div>
                <Label htmlFor="ev-course">{t('eventCourseId')}</Label>
                <Input id="ev-course" value={evCourseId} onChange={(e) => setEvCourseId(e.target.value)} />
              </div>
            ) : null}
            {evType === 'group' ? (
              <div>
                <Label htmlFor="ev-group">{t('eventGroupId')}</Label>
                <Input id="ev-group" value={evGroupId} onChange={(e) => setEvGroupId(e.target.value)} />
              </div>
            ) : null}
            {evType === 'category' ? (
              <div>
                <Label htmlFor="ev-category">{t('eventCategoryId')}</Label>
                <Input id="ev-category" value={evCategoryId} onChange={(e) => setEvCategoryId(e.target.value)} />
              </div>
            ) : null}
            <Button type="submit">{t('createEvent')}</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('subscriptionsTitle')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {subscriptions.map((s) => (
              <li key={s.id} data-testid={`subscription-${s.id}`} className="flex items-center gap-3">
                <span>{s.name}</span>
                <span className="text-sm text-muted-foreground">{s.url ?? ''}</span>
                <Button type="button" variant="outline" onClick={() => void importSubscription(s.id)}>{t('importSubscription')}</Button>
              </li>
            ))}
          </ul>
          {subscriptions.length === 0 ? <p>{t('noSubscriptions')}</p> : null}
          <form onSubmit={(e) => void createSubscription(e)} className="space-y-3">
            <div>
              <Label htmlFor="sub-name">{t('subscriptionName')}</Label>
              <Input id="sub-name" value={subName} onChange={(e) => setSubName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="sub-url">{t('subscriptionUrl')}</Label>
              <Input id="sub-url" value={subUrl} onChange={(e) => setSubUrl(e.target.value)} />
            </div>
            <Button type="submit">{t('addSubscription')}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
