import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import {
  fetchNotificationGroupItems,
  flattenNotificationGroups,
  notificationGroupKey,
  preferenceKey,
  updateNotificationGroupsCache,
  useClearReadNotifications,
  useDeleteNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useMessagePreferences,
  useNotificationGroups,
  useReadNotificationGroup,
  useSetMessagePreference,
  type NotificationGroupFilter,
  type NotificationGroupView,
  type NotificationItemView,
  type PreferenceChannel,
  type PreferenceRow,
  type PreferenceState,
} from '#lib/notifications';

type GroupFilterSelection = NotificationGroupFilter | 'all';

function groupKey(g: Pick<NotificationGroupView, 'eventType' | 'contextUrl' | 'day'>): string {
  return notificationGroupKey(g);
}

/** Nhãn đầu mục ngày: Hôm nay / Hôm qua theo ngày lịch của trình duyệt, còn lại in ngày cụ thể. */
function dayLabel(day: string, t: (key: string) => string): string {
  const localDay = (d: Date) => {
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const dd = `${d.getDate()}`.padStart(2, '0');
    return `${d.getFullYear()}-${m}-${dd}`;
  };
  const now = new Date();
  if (day === localDay(now)) return t('todayLabel');
  if (day === localDay(new Date(now.getTime() - 86_400_000))) return t('yesterdayLabel');
  return new Date(`${day}T00:00:00`).toLocaleDateString();
}

/** Thời gian tương đối cho mục mới nhất ("vừa xong", "3 giờ trước"…); quá một tuần thì in ngày giờ cụ thể. */
function relativeTime(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return t('justNow');
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return t('minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('daysAgo', { count: days });
  return new Date(iso).toLocaleString();
}

/**
 * Notification centre + preferences. The centre is the v2 grouped
 * list (issue #51): rows are grouped by (type × source × day) with
 * cursor pagination, group/unread filters, expandable detail, deep
 * links via context_url that mark items read, and per-row delete.
 * Preferences below are unchanged here (the v2 preference model is a
 * later slice): a notification only exists when the (provider ×
 * channel × login-state) preference allowed the popup channel; each
 * toggle PUTs exactly that one preference row through to the API and
 * takes effect on the very next dispatch.
 *
 * Dữ liệu qua TanStack Query (lib/notifications.ts, F-01): danh sách
 * nhóm là infinite query theo khoá bộ lọc, các mục mở rộng tải qua
 * fetchQuery vào cùng cache, tuỳ chọn là một query + mutation lạc quan
 * trên cache. Điểm khác hành vi cũ quan trọng nhất: mọi thao tác
 * đọc/đọc-nhóm/đọc-hết/xoá đều LÀM MỚI khoá `notificationUnreadCount`
 * — huy hiệu chuông ở sidebar/header dùng chung khoá đó (trước đây
 * trang này không hề invalidate nên huy hiệu giữ số cũ sau khi đã
 * đọc ở đây). Các cập nhật đếm tại chỗ vẫn giữ nguyên, nay áp thẳng
 * lên cache qua setQueriesData thay cho state cục bộ.
 */
export function NotificationsPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [groupFilter, setGroupFilter] = useState<GroupFilterSelection>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [expandedItems, setExpandedItems] = useState<ReadonlyMap<string, NotificationItemView[]>>(new Map());
  const [expanding, setExpanding] = useState<ReadonlySet<string>>(new Set());
  const [savingPrefs, setSavingPrefs] = useState<ReadonlySet<string>>(new Set());
  const [expandError, setExpandError] = useState(false);
  const [prefError, setPrefError] = useState<string | null>(null);

  const groupsQuery = useNotificationGroups(groupFilter, unreadOnly);
  const prefsQuery = useMessagePreferences();
  const markReadMutation = useMarkNotificationRead();
  const readGroupMutation = useReadNotificationGroup();
  const deleteMutation = useDeleteNotification();
  const markAllMutation = useMarkAllNotificationsRead();
  const clearReadMutation = useClearReadNotifications();
  const preferenceMutation = useSetMessagePreference();

  const groups = flattenNotificationGroups(groupsQuery.data);
  const prefs = prefsQuery.data ?? [];
  const error =
    groupsQuery.isError || prefsQuery.isError || expandError ? t('notificationsLoadFailed') : null;

  // Đổi bộ lọc = danh sách mới: thu gọn mọi dòng đang mở như hành vi cũ
  // (loadFirstPage trước đây luôn xoá bản đồ mở rộng).
  useEffect(() => {
    setExpandedItems(new Map());
  }, [groupFilter, unreadOnly]);

  function loadMore() {
    if (groupsQuery.hasNextPage) void groupsQuery.fetchNextPage();
  }

  async function toggleExpand(group: NotificationGroupView) {
    const key = groupKey(group);
    if (expandedItems.has(key)) {
      setExpandedItems((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpanding((prev) => new Set(prev).add(key));
    try {
      const items = await fetchNotificationGroupItems(queryClient, group);
      setExpandedItems((prev) => new Map(prev).set(key, items));
    } catch {
      setExpandError(true);
    } finally {
      setExpanding((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  /** Đánh dấu một mục đã đọc ở trạng thái hiển thị (cache nhóm + mục đang mở rộng). */
  function applyItemRead(group: NotificationGroupView, itemId: string) {
    const key = groupKey(group);
    updateNotificationGroupsCache(queryClient, (prev) =>
      prev.map((g) => (groupKey(g) === key && g.unreadCount > 0
        ? { ...g, unreadCount: g.unreadCount - 1, latest: g.latest.id === itemId ? { ...g.latest, timeRead: new Date().toISOString() } : g.latest }
        : g)),
    );
    setExpandedItems((prev) => {
      const items = prev.get(key);
      if (!items) return prev;
      const next = new Map(prev);
      next.set(key, items.map((n) => (n.id === itemId ? { ...n, timeRead: n.timeRead ?? new Date().toISOString() } : n)));
      return next;
    });
  }

  /** Bấm vào một mục: đánh dấu đã đọc rồi đi tới đúng ngữ cảnh của mục đó. */
  function openItem(group: NotificationGroupView, item: Pick<NotificationItemView, 'id' | 'contextUrl' | 'timeRead'>) {
    const target = item.contextUrl ?? group.contextUrl;
    if (!item.timeRead) {
      markReadMutation.mutate(item.id, {
        onSettled: () => {
          applyItemRead(group, item.id);
          if (target) navigate(target);
        },
      });
      return;
    }
    if (target) navigate(target);
  }

  /** Bấm vào thân dòng gộp: đi tới ngữ cảnh của nguồn và đánh dấu đã đọc cả nhóm. */
  function openGroup(group: NotificationGroupView) {
    if (group.count === 1) {
      openItem(group, { id: group.latest.id, contextUrl: group.contextUrl, timeRead: group.latest.timeRead });
      return;
    }
    if (!group.contextUrl) {
      void toggleExpand(group);
      return;
    }
    if (group.unreadCount > 0) {
      readGroupMutation.mutate(group, {
        onSettled: () => {
          const key = groupKey(group);
          updateNotificationGroupsCache(queryClient, (prev) =>
            prev.map((g) => (groupKey(g) === key ? { ...g, unreadCount: 0 } : g)),
          );
          navigate(group.contextUrl!);
        },
      });
      return;
    }
    navigate(group.contextUrl);
  }

  /** Xoá một mục ngay tại dòng (§9): cập nhật đếm của dòng gộp, dòng rỗng thì biến mất. */
  function deleteItem(group: NotificationGroupView, item: NotificationItemView) {
    deleteMutation.mutate(item.id, {
      onSettled: () => {
        const key = groupKey(group);
        setExpandedItems((prev) => {
          const items = prev.get(key);
          if (!items) return prev;
          const next = new Map(prev);
          next.set(key, items.filter((n) => n.id !== item.id));
          return next;
        });
        updateNotificationGroupsCache(queryClient, (prev) =>
          prev.flatMap((g) => {
            if (groupKey(g) !== key) return [g];
            const count = g.count - 1;
            if (count <= 0) return [];
            const remaining = expandedItems.get(key)?.filter((n) => n.id !== item.id) ?? [];
            const latest = g.latest.id === item.id && remaining.length > 0
              ? {
                  id: remaining[0]!.id, subject: remaining[0]!.subject, smallMessage: remaining[0]!.smallMessage,
                  contextUrlName: remaining[0]!.contextUrlName, createdAt: remaining[0]!.createdAt, timeRead: remaining[0]!.timeRead,
                }
              : g.latest;
            return [{ ...g, count, unreadCount: item.timeRead ? g.unreadCount : Math.max(0, g.unreadCount - 1), latest }];
          }),
        );
      },
    });
  }

  function toggle(row: PreferenceRow) {
    const key = preferenceKey(row);
    if (savingPrefs.has(key)) return;
    const enabled = !row.enabled;
    setPrefError(null);
    setSavingPrefs((prev) => new Set(prev).add(key));
    // Cập nhật lạc quan + hoàn lại khi lỗi nằm trong mutation ở
    // lib/notifications.ts; ở đây chỉ lo cờ đang-lưu theo dòng và lỗi
    // riêng của khu vực tuỳ chọn.
    preferenceMutation.mutate(
      { row, enabled },
      {
        onError: () => setPrefError(t('preferenceSaveFailed')),
        onSettled: () =>
          setSavingPrefs((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          }),
      },
    );
  }

  function markAllRead() {
    markAllMutation.mutate(undefined, {
      onSuccess: () => setExpandedItems(new Map()),
    });
  }

  function clearRead() {
    clearReadMutation.mutate(undefined, {
      onSuccess: () => setExpandedItems(new Map()),
    });
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

  const groupLabel: Record<NotificationGroupFilter, string> = {
    learning: t('notificationsGroupLearning'),
    people: t('notificationsGroupPeople'),
    system: t('notificationsGroupSystem'),
  };
  const filterOptions: { value: GroupFilterSelection; label: string }[] = [
    { value: 'all', label: t('notificationsFilterAll') },
    { value: 'learning', label: groupLabel.learning },
    { value: 'people', label: groupLabel.people },
    { value: 'system', label: groupLabel.system },
  ];

  // Các dòng gộp đã sắp theo hoạt động mới nhất nên ngày chỉ lùi dần:
  // chèn đầu mục ngày mỗi khi ngày đổi so với dòng trước.
  const rows: { dayHeader: string | null; group: NotificationGroupView }[] = [];
  let lastDay: string | null = null;
  for (const group of groups) {
    rows.push({ dayHeader: group.day !== lastDay ? dayLabel(group.day, t) : null, group });
    lastDay = group.day;
  }

  return (
    <PageShell width="narrow">
      <PageHeader
        title={t('notifications')}
        actions={
          <>
            <Button type="button" variant="outline" onClick={() => markAllRead()}>
              {t('markAllRead')}
            </Button>
            <Button type="button" variant="outline" onClick={() => clearRead()}>
              {t('clearReadNotifications')}
            </Button>
          </>
        }
      />
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {filterOptions.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={groupFilter === option.value ? 'default' : 'outline'}
                aria-pressed={groupFilter === option.value}
                onClick={() => setGroupFilter(option.value)}
              >
                {option.label}
              </Button>
            ))}
            <label className="ml-auto flex items-center gap-2 text-sm">
              <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              {t('unreadOnlyLabel')}
            </label>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {groups.length === 0 && !error ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>{t('noNotifications')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="space-y-2" aria-label={t('notificationsListLabel')}>
              {rows.map(({ dayHeader, group }) => {
                const key = groupKey(group);
                const items = expandedItems.get(key);
                return (
                  <li key={key} className="space-y-2">
                    {dayHeader ? <p className="pt-2 text-xs font-semibold uppercase text-muted-foreground">{dayHeader}</p> : null}
                    <div className={`rounded border p-2 ${group.unreadCount > 0 ? '' : 'opacity-60'}`}>
                      <div className="flex items-start gap-2">
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openGroup(group)}>
                          <p className="font-medium">{group.latest.subject}</p>
                          {group.latest.smallMessage ? <p className="truncate text-sm">{group.latest.smallMessage}</p> : null}
                          <p className="text-xs text-muted-foreground">
                            {groupLabel[group.group]}
                            {group.count > 1 ? ` · ${t('notificationGroupCount', { count: group.count })}` : ''}
                            {` · ${relativeTime(group.latest.createdAt, t)}`}
                            {group.unreadCount > 0 ? ` · ${t('notificationGroupUnread', { count: group.unreadCount })}` : ` · ${t('readSuffix')}`}
                          </p>
                        </button>
                        {group.count > 1 ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-expanded={items !== undefined}
                            aria-label={`${items !== undefined ? t('collapseGroup') : t('expandGroup')}: ${group.latest.subject}`}
                            onClick={() => void toggleExpand(group)}
                          >
                            {items !== undefined ? t('collapseGroup') : t('expandGroup')}
                          </Button>
                        ) : null}
                        {group.count === 1 ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`${t('deleteNotification')}: ${group.latest.subject}`}
                            onClick={() => deleteItem(group, {
                              id: group.latest.id, subject: group.latest.subject, fullMessage: '', smallMessage: group.latest.smallMessage,
                              eventType: group.eventType, contextUrl: group.contextUrl, contextUrlName: group.latest.contextUrlName,
                              timeRead: group.latest.timeRead, createdAt: group.latest.createdAt,
                            })}
                          >
                            {t('deleteNotification')}
                          </Button>
                        ) : null}
                      </div>
                      {items !== undefined ? (
                        <ul className="mt-2 space-y-1 border-t pt-2">
                          {items.map((item) => (
                            <li key={item.id} className={`flex items-start gap-2 rounded p-1 ${item.timeRead ? 'opacity-60' : ''}`}>
                              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openItem(group, item)}>
                                <p className="text-sm font-medium">{item.subject}</p>
                                <p className="text-sm">{item.fullMessage}</p>
                                <p className="text-xs text-muted-foreground">
                                  {`${relativeTime(item.createdAt, t)} · ${item.timeRead ? t('readSuffix') : t('unreadStateSuffix')}`}
                                </p>
                              </button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-label={`${t('deleteNotification')}: ${item.subject}`}
                                onClick={() => deleteItem(group, item)}
                              >
                                {t('deleteNotification')}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {expanding.has(key) ? <p className="mt-2 text-xs text-muted-foreground">{t('notificationsLoading')}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {groupsQuery.hasNextPage ? (
            <Button type="button" variant="outline" onClick={() => loadMore()}>
              {t('loadMoreNotifications')}
            </Button>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('notificationPreferences')}</CardTitle>
        </CardHeader>
        <CardContent>
          {prefError ? (
            <Alert variant="destructive">
              <AlertDescription>{prefError}</AlertDescription>
            </Alert>
          ) : null}
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
                            onChange={() => toggle(row)}
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
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default NotificationsPage;

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { appKeyMeta } from '../lib/route-meta';
export function meta() {
  return appKeyMeta('navNotifications');
}
