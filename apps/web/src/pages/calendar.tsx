import { useMemo, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@lms/ui/components/sheet';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { apiFetch } from '#lib/api';
import {
  currentMonthRangeIso,
  useCalendarEvents,
  useCalendarExportToken,
  useCalendarSubscriptions,
  useCreateCalendarEvent,
  useCreateCalendarExportToken,
  useCreateCalendarSubscription,
  useDeleteCalendarEvent,
  useImportCalendarSubscription,
  useRemindCalendarEvent,
  useRevokeCalendarExportToken,
  type CalendarEventView as EventView,
  type CalendarExportTokenView,
  type CalendarSubscriptionView,
} from '#lib/calendar';
import { queryKeys } from '#lib/query-keys';
import { buildSsrLoaderData, serverQueryFn, type SsrLoaderData } from '#lib/ssr-data';

const TYPES = ['all', 'site', 'category', 'course', 'group', 'user'] as const;
const EVENT_TYPES = ['user', 'site', 'category', 'course', 'group'] as const;

/**
 * Loader phía server (tầng SL-1 của #7): prefetch cả ba query của
 * trang bằng cookie của chính request — sự kiện tháng hiện tại (key
 * `calendarEvents(from, to)` với khoảng tháng từ `currentMonthRangeIso`
 * dùng chung hai phía), đăng ký lịch ngoài và đường dẫn xuất lịch —
 * rồi dehydrate cho root.tsx hydrate vào cache (xem `lib/ssr-data.ts`).
 * Không có cookie phiên thì không gọi API nào (trang tải phía client
 * như trước SL-1). Lỗi ở một endpoint chỉ làm query đó vắng mặt trong
 * state, trang tự fetch lại đúng key đó.
 *
 * @param request - Request đang phục vụ (nguồn cookie phiên).
 * @returns Dehydrated state cho HydrationBoundary ở root.
 */
export async function loader({ request }: { request: Request }): Promise<SsrLoaderData> {
  const range = currentMonthRangeIso();
  return buildSsrLoaderData(request, async (queryClient, req) => {
    await Promise.all([
      queryClient.prefetchQuery({
        queryKey: queryKeys.calendarEvents(range.from, range.to),
        queryFn: serverQueryFn<EventView[]>(req, `/api/v1/calendar/events?from=${range.from}&to=${range.to}`),
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.calendarSubscriptions,
        queryFn: serverQueryFn<CalendarSubscriptionView[]>(req, '/api/v1/calendar/subscriptions'),
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.calendarExportToken,
        queryFn: serverQueryFn<CalendarExportTokenView | null>(req, '/api/v1/calendar/export-token'),
      }),
    ]);
  });
}

/**
 * Lịch: xem sự kiện tháng hiện tại (lọc theo loại), tạo/xoá sự kiện, đặt
 * nhắc, và quản lý subscription lịch ngoài kèm nhập ngay. API áp dụng luật
 * hiển thị (site cho mọi người, course cho người đã ghi danh, group cho
 * thành viên, user chỉ cho chủ sở hữu) — vì vậy nút xoá chỉ hiện ở sự kiện
 * loại `user`, tức sự kiện của chính người đang xem; nhắc thì API cho phép
 * với mọi sự kiện người dùng nhìn thấy được.
 *
 * Dữ liệu qua TanStack Query (lib/calendar.ts, F-01): sự kiện tháng dùng
 * đúng khoá factory `calendarEvents(from, to)` đã có sẵn; subscription và
 * token xuất lịch là hai query riêng (lỗi tải giữ dữ liệu cũ như trước);
 * mọi đột biến làm mới các truy vấn lịch qua tiền tố khoá thay vì nạp lại
 * thủ công. Từ lát SL-1 (#7), loader của route prefetch cả ba query phía
 * server (khi có cookie phiên) và trang hydrate từ cache — khoảng tháng
 * lấy từ `currentMonthRangeIso` (múi giờ ứng dụng) để key của trang khớp
 * tuyệt đối với key loader đã prefetch.
 */
export function CalendarPage() {
  const { t, i18n } = useTranslation('app');
  const [typeFilter, setTypeFilter] = useState<(typeof TYPES)[number]>('all');
  const [message, setMessage] = useState<string | null>(null);
  const [eventSheetOpen, setEventSheetOpen] = useState(false);
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
  // Khoảng tháng cho query sự kiện: tính theo múi giờ ứng dụng qua
  // helper dùng chung với loader SL-1 (trước đây tính theo giờ máy
  // của trình duyệt — hai phía lệch múi giờ là key không bao giờ
  // khớp để hydrate; xem `currentMonthRangeIso` ở lib/calendar.ts).
  const range = useMemo(() => currentMonthRangeIso(), []);

  const eventsQuery = useCalendarEvents(range.from, range.to);
  const subscriptionsQuery = useCalendarSubscriptions();
  const exportTokenQuery = useCalendarExportToken();
  const createEventMutation = useCreateCalendarEvent();
  const deleteEventMutation = useDeleteCalendarEvent();
  const remindMutation = useRemindCalendarEvent();
  const createSubscriptionMutation = useCreateCalendarSubscription();
  const importSubscriptionMutation = useImportCalendarSubscription();
  const createTokenMutation = useCreateCalendarExportToken();
  const revokeTokenMutation = useRevokeCalendarExportToken();

  const events = eventsQuery.data ?? [];
  const subscriptions = subscriptionsQuery.data ?? [];
  const exportToken = exportTokenQuery.data ?? null;
  const loading = eventsQuery.isPending;
  const loadFailed = eventsQuery.isError;

  /** Tạo sự kiện theo đúng DTO: loại sự kiện quyết định id phạm vi đi kèm. */
  function createEvent(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    createEventMutation.mutate(
      {
        name: evName,
        ...(evDescription ? { description: evDescription } : {}),
        eventType: evType,
        timeStart: new Date(evStart).toISOString(),
        ...(evDuration ? { timeDuration: Number(evDuration) } : {}),
        ...(evLocation ? { location: evLocation } : {}),
        ...(evType === 'course' || evType === 'group' ? { courseId: evCourseId } : {}),
        ...(evType === 'group' ? { groupId: evGroupId } : {}),
        ...(evType === 'category' ? { categoryId: evCategoryId } : {}),
      },
      {
        onSuccess: () => {
          setEvName('');
          setEvDescription('');
          setEvLocation('');
          setMessage(t('eventCreated'));
          setEventSheetOpen(false);
        },
        onError: () => setMessage(t('eventCreateFailed')),
      },
    );
  }

  /** Xoá một sự kiện của mình; danh sách tháng được làm mới qua invalidation. */
  function deleteEvent(id: string) {
    setMessage(null);
    deleteEventMutation.mutate(id, {
      onSuccess: () => setMessage(t('eventDeleted')),
      onError: () => setMessage(t('eventDeleteFailed')),
    });
  }

  /** Đặt nhắc trước sự kiện 60 phút (DTO nhắc chỉ gồm `minutesBefore`). */
  function remind(id: string) {
    setMessage(null);
    remindMutation.mutate(id, {
      onSuccess: () => setMessage(t('reminderSet')),
      onError: () => setMessage(t('reminderFailed')),
    });
  }

  /**
   * Thêm subscription lịch ngoài từ URL ICS. Mặc định gắn loại `user`
   * (lịch cá nhân): loại `site` phía server đòi capability quản lý
   * subscription cấp hệ thống, không phù hợp cho subscription cá nhân.
   */
  function createSubscription(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    createSubscriptionMutation.mutate(
      { name: subName, url: subUrl },
      {
        onSuccess: () => {
          setSubName('');
          setSubUrl('');
          setMessage(t('subscriptionCreated'));
        },
        onError: () => setMessage(t('subscriptionCreateFailed')),
      },
    );
  }

  /** Yêu cầu nhập ngay một subscription (server đưa vào hàng đợi worker). */
  function importSubscription(id: string) {
    setMessage(null);
    importSubscriptionMutation.mutate(id, {
      onSuccess: () => setMessage(t('importQueued')),
      onError: () => setMessage(t('importFailed')),
    });
  }

  /** Tải tệp ICS của chính user qua GET /calendar/exports?format=ics (endpoint đòi đăng nhập nên phải fetch kèm token rồi tải blob, không dùng link trực tiếp). */
  async function downloadIcs() {
    setMessage(null);
    try {
      const response = await apiFetch('/api/v1/calendar/exports?format=ics');
      if (!response.ok) throw new Error('export failed');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'calendar.ics';
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      setMessage(t('downloadIcsFailed'));
    }
  }

  /** Tạo hoặc tạo lại đường dẫn đăng ký xuất lịch (POST /calendar/export-token thay token cũ). */
  function createExportToken() {
    setMessage(null);
    createTokenMutation.mutate(undefined, {
      onSuccess: () => setMessage(t('exportTokenCreated')),
      onError: () => setMessage(t('exportTokenCreateFailed')),
    });
  }

  /** Thu hồi đường dẫn đăng ký xuất lịch (DELETE /calendar/export-token) — đường dẫn cũ lập tức hết hiệu lực. */
  function revokeExportToken() {
    setMessage(null);
    revokeTokenMutation.mutate(undefined, {
      onSuccess: () => setMessage(t('exportTokenRevoked')),
      onError: () => setMessage(t('exportTokenRevokeFailed')),
    });
  }

  const visible = events.filter((e) => typeFilter === 'all' || e.eventType === typeFilter);
  // Gom sự kiện theo ngày địa phương; tiêu đề ngày và giờ sự kiện luôn
  // định dạng theo ngôn ngữ giao diện (i18n.language) thay vì mặc định
  // trình duyệt, để trang không lẫn định dạng tiếng Anh khi locale là vi.
  const byDay = new Map<string, { date: Date; events: EventView[] }>();
  for (const e of visible) {
    const start = new Date(e.timeStart);
    const key = `${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`;
    const group = byDay.get(key) ?? { date: start, events: [] };
    group.events.push(e);
    byDay.set(key, group);
  }
  const dayLabel = (date: Date) =>
    date.toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeLabel = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });

  return (
    <PageShell width="full">
      <PageHeader
        title={t('calendarTitle', { month: now.toLocaleString(i18n.language, { month: 'long', year: 'numeric' }) })}
        actions={
          <Sheet open={eventSheetOpen} onOpenChange={setEventSheetOpen}>
            <SheetTrigger render={<Button type="button" />}>{t('newEvent')}</SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>{t('createEventTitle')}</SheetTitle>
              </SheetHeader>
              {/* §5.6: form sự kiện nằm trong Sheet — danh sách sự kiện là
                  nội dung chính của trang, form không chiếm chỗ cố định. */}
              <form onSubmit={(e) => createEvent(e)} className="px-4">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="ev-name">{t('eventName')}</FieldLabel>
                    <Input id="ev-name" value={evName} onChange={(e) => setEvName(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="ev-description">{t('eventDescription')}</FieldLabel>
                    <Input
                      id="ev-description"
                      value={evDescription}
                      onChange={(e) => setEvDescription(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel id="ev-type-label">{t('eventType')}</FieldLabel>
                    <Select
                      items={Object.fromEntries(
                        EVENT_TYPES.map((type) => [type, t(`eventType${type[0]!.toUpperCase()}${type.slice(1)}`)]),
                      )}
                      value={evType}
                      onValueChange={(v) => setEvType((v ?? 'user') as (typeof EVENT_TYPES)[number])}
                    >
                      <SelectTrigger aria-labelledby="ev-type-label" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EVENT_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {t(`eventType${type[0]!.toUpperCase()}${type.slice(1)}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="ev-start">{t('eventStart')}</FieldLabel>
                    <Input
                      id="ev-start"
                      type="datetime-local"
                      value={evStart}
                      onChange={(e) => setEvStart(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="ev-duration">{t('eventDurationSeconds')}</FieldLabel>
                    <Input
                      id="ev-duration"
                      type="number"
                      value={evDuration}
                      onChange={(e) => setEvDuration(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="ev-location">{t('eventLocation')}</FieldLabel>
                    <Input id="ev-location" value={evLocation} onChange={(e) => setEvLocation(e.target.value)} />
                  </Field>
                  {evType === 'course' || evType === 'group' ? (
                    <Field>
                      <FieldLabel htmlFor="ev-course">{t('eventCourseId')}</FieldLabel>
                      <Input id="ev-course" value={evCourseId} onChange={(e) => setEvCourseId(e.target.value)} />
                    </Field>
                  ) : null}
                  {evType === 'group' ? (
                    <Field>
                      <FieldLabel htmlFor="ev-group">{t('eventGroupId')}</FieldLabel>
                      <Input id="ev-group" value={evGroupId} onChange={(e) => setEvGroupId(e.target.value)} />
                    </Field>
                  ) : null}
                  {evType === 'category' ? (
                    <Field>
                      <FieldLabel htmlFor="ev-category">{t('eventCategoryId')}</FieldLabel>
                      <Input
                        id="ev-category"
                        value={evCategoryId}
                        onChange={(e) => setEvCategoryId(e.target.value)}
                      />
                    </Field>
                  ) : null}
                  <div className="flex justify-end">
                    <Button type="submit">{t('createEvent')}</Button>
                  </div>
                </FieldGroup>
              </form>
            </SheetContent>
          </Sheet>
        }
      />
      {loadFailed ? (
        <>
          <Alert variant="destructive">
            <AlertDescription>{t('calendarLoadFailed')}</AlertDescription>
          </Alert>
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void eventsQuery.refetch();
                void subscriptionsQuery.refetch();
                void exportTokenQuery.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </div>
        </>
      ) : null}
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-2">
            <Field>
              <FieldLabel id="type-filter-label">{t('eventType')}</FieldLabel>
              <Select
                items={Object.fromEntries(
                  TYPES.map((type) => [type, t(`eventType${type[0]!.toUpperCase()}${type.slice(1)}`)]),
                )}
                value={typeFilter}
                onValueChange={(v) => setTypeFilter((v ?? 'all') as (typeof TYPES)[number])}
              >
                <SelectTrigger aria-labelledby="type-filter-label" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`eventType${type[0]!.toUpperCase()}${type.slice(1)}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {loading ? (
            <div className="space-y-2" aria-label={t('loading')}>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <>
              {[...byDay.entries()].map(([key, group]) => (
                <section key={key} aria-label={dayLabel(group.date)}>
                  <h3 className="font-medium">{dayLabel(group.date)}</h3>
                  <ul className="space-y-1">
                    {group.events.map((e) => (
                      <li key={e.id} className="flex items-center gap-2 rounded border p-2 text-sm">
                        <span className="font-medium">{e.name}</span>
                        <span className="text-muted-foreground">
                          {' '}
                          · {e.eventType} · {timeLabel(e.timeStart)}
                        </span>
                        {e.isException ? <span> {t('adjustedOccurrence')}</span> : null}
                        <Button type="button" variant="outline" onClick={() => remind(e.id)}>
                          {t('remindOneHour')}
                        </Button>
                        {e.eventType === 'user' ? (
                          <Button type="button" variant="outline" onClick={() => deleteEvent(e.id)}>
                            {t('deleteEvent')}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {visible.length === 0 ? (
                <Empty className="p-6">
                  <EmptyHeader>
                    <EmptyTitle>{t('noEventsThisMonth')}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('calendarExportTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('calendarExportDescription')}</p>
          <Button type="button" variant="outline" onClick={() => void downloadIcs()}>
            {t('downloadIcs')}
          </Button>
          <Field>
            <FieldLabel htmlFor="export-token-url">{t('exportToken')}</FieldLabel>
            {exportToken ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input id="export-token-url" readOnly value={exportToken.url} className="max-w-xl" />
                <Button type="button" variant="destructive" onClick={() => revokeExportToken()}>
                  {t('revokeExportToken')}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">{t('noExportToken')}</p>
                <Button type="button" onClick={() => createExportToken()}>
                  {t('createExportToken')}
                </Button>
              </div>
            )}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('subscriptionsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {subscriptions.map((s) => (
              <li key={s.id} data-testid={`subscription-${s.id}`} className="flex items-center gap-3">
                <span>{s.name}</span>
                <span className="text-sm text-muted-foreground">{s.url ?? ''}</span>
                <Button type="button" variant="outline" onClick={() => importSubscription(s.id)}>
                  {t('importSubscription')}
                </Button>
              </li>
            ))}
          </ul>
          {subscriptions.length === 0 ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{t('noSubscriptions')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null}
          <form onSubmit={(e) => createSubscription(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="sub-name">{t('subscriptionName')}</FieldLabel>
                <Input id="sub-name" value={subName} onChange={(e) => setSubName(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="sub-url">{t('subscriptionUrl')}</FieldLabel>
                <Input id="sub-url" value={subUrl} onChange={(e) => setSubUrl(e.target.value)} />
              </Field>
              <div className="flex justify-end">
                <Button type="submit">{t('addSubscription')}</Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CalendarPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navCalendar');
}
