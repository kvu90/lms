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
  useNotificationCourseOverrides,
  useNotificationGroups,
  useReadNotificationGroup,
  useSetMessagePreference,
  useSetNotificationCourseOverride,
  type EmailFrequency,
  type NotificationCourseOverrideView,
  type NotificationGroupFilter,
  type NotificationGroupView,
  type NotificationItemView,
  type NotificationPreferenceView,
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
 * Preferences below are the v2 model (NB-2, issue #174): one row per
 * provider with labels/descriptions served by the API registry (no
 * raw keys anywhere), an in-app on/off switch and an email frequency
 * (immediate / daily digest / off). The old logged-in/logged-off
 * matrix is gone; each change PUTs exactly one provider's patch
 * through to the API and takes effect on the very next dispatch.
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
  const { t, i18n } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [groupFilter, setGroupFilter] = useState<GroupFilterSelection>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [expandedItems, setExpandedItems] = useState<ReadonlyMap<string, NotificationItemView[]>>(new Map());
  const [expanding, setExpanding] = useState<ReadonlySet<string>>(new Set());
  const [savingPrefs, setSavingPrefs] = useState<ReadonlySet<string>>(new Set());
  const [savingOverrides, setSavingOverrides] = useState<ReadonlySet<string>>(new Set());
  const [expandError, setExpandError] = useState(false);
  const [prefError, setPrefError] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const groupsQuery = useNotificationGroups(groupFilter, unreadOnly);
  const prefsQuery = useMessagePreferences();
  const overridesQuery = useNotificationCourseOverrides();
  const markReadMutation = useMarkNotificationRead();
  const readGroupMutation = useReadNotificationGroup();
  const deleteMutation = useDeleteNotification();
  const markAllMutation = useMarkAllNotificationsRead();
  const clearReadMutation = useClearReadNotifications();
  const preferenceMutation = useSetMessagePreference();
  const overrideMutation = useSetNotificationCourseOverride();

  const groups = flattenNotificationGroups(groupsQuery.data);
  const prefs = prefsQuery.data ?? [];
  const overrideCourses = overridesQuery.data ?? [];
  const error =
    groupsQuery.isError || prefsQuery.isError || overridesQuery.isError || expandError ? t('notificationsLoadFailed') : null;

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

  /** Lưu một patch tuỳ chọn của một provider; cờ đang-lưu theo (provider, trường). */
  function savePreference(row: NotificationPreferenceView, field: 'popup' | 'email', patch: { popupEnabled?: boolean; emailFrequency?: EmailFrequency }) {
    const key = `${preferenceKey(row)}|${field}`;
    if (savingPrefs.has(key)) return;
    setPrefError(null);
    setSavingPrefs((prev) => new Set(prev).add(key));
    // Cập nhật lạc quan + hoàn lại khi lỗi nằm trong mutation ở
    // lib/notifications.ts; ở đây chỉ lo cờ đang-lưu và lỗi riêng
    // của khu vực tuỳ chọn.
    preferenceMutation.mutate(
      { provider: row.provider, patch },
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

  function togglePopup(row: NotificationPreferenceView) {
    savePreference(row, 'popup', { popupEnabled: !row.popupEnabled });
  }

  function changeEmailFrequency(row: NotificationPreferenceView, frequency: EmailFrequency) {
    savePreference(row, 'email', { emailFrequency: frequency });
  }

  /**
   * Bật/tắt tắt tiếng một khoá (NB-4): cập nhật lạc quan + hoàn lại
   * khi lỗi nằm trong mutation ở lib/notifications.ts; ở đây chỉ lo
   * cờ đang-lưu và thông báo lỗi riêng của khu vực ngoại lệ.
   */
  function toggleCourseMute(course: NotificationCourseOverrideView) {
    if (savingOverrides.has(course.courseId)) return;
    setOverrideError(null);
    setSavingOverrides((prev) => new Set(prev).add(course.courseId));
    overrideMutation.mutate(
      { courseId: course.courseId, mode: course.mode === 'mute' ? 'all' : 'mute' },
      {
        onError: () => setOverrideError(t('courseOverrideSaveFailed')),
        onSettled: () =>
          setSavingOverrides((prev) => {
            const next = new Set(prev);
            next.delete(course.courseId);
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

  // Trang cài đặt v2 (NB-2): các dòng tuỳ chọn đã là một dòng cho mỗi
  // provider — chỉ cần chia theo 3 nhóm có sẵn để trình bày; nhãn/mô
  // tả hiển thị lấy nguyên văn từ registry ở API theo ngôn ngữ hiện
  // tại của giao diện.
  const prefSections = (['learning', 'people', 'system'] as NotificationGroupFilter[])
    .map((group) => ({ group, rows: prefs.filter((p) => p.group === group) }))
    .filter((section) => section.rows.length > 0);
  const localized = (row: NotificationPreferenceView) =>
    i18n.language?.startsWith('en')
      ? { label: row.label.en, description: row.description.en }
      : { label: row.label.vi, description: row.description.vi };

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
        <CardContent className="space-y-6">
          {prefError ? (
            <Alert variant="destructive">
              <AlertDescription>{prefError}</AlertDescription>
            </Alert>
          ) : null}
          {prefSections.map((section) => (
            <section key={section.group} aria-label={groupLabel[section.group]} className="space-y-3">
              <h3 className="text-sm font-semibold">{groupLabel[section.group]}</h3>
              <div className="grid grid-cols-[1fr_auto_auto] items-start gap-x-4 gap-y-1 text-sm">
                <span className="text-xs font-medium uppercase text-muted-foreground">{t('prefType')}</span>
                <span className="text-xs font-medium uppercase text-muted-foreground">{t('prefInApp')}</span>
                <span className="text-xs font-medium uppercase text-muted-foreground">{t('prefEmail')}</span>
                {section.rows.map((row) => {
                  const text = localized(row);
                  const emailSaving = savingPrefs.has(`${preferenceKey(row)}|email`);
                  return [
                    <div key={`${row.provider}-label`} className="min-w-0 border-t pt-2">
                      <p className="font-medium">
                        {text.label}
                        {row.teacherOnly ? (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">{t('prefTeacherOnly')}</span>
                        ) : null}
                        {row.mandatoryInApp ? (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">{t('prefMandatory')}</span>
                        ) : null}
                      </p>
                      <p className="text-muted-foreground">{text.description}</p>
                      {row.mandatoryInApp ? <p className="text-xs text-muted-foreground">{t('prefMandatoryNote')}</p> : null}
                    </div>,
                    <div key={`${row.provider}-popup`} className="border-t pt-2">
                      <input
                        aria-label={`${text.label} — ${t('prefInApp')}`}
                        type="checkbox"
                        checked={row.popupEnabled}
                        disabled={row.mandatoryInApp || savingPrefs.has(`${preferenceKey(row)}|popup`)}
                        onChange={() => togglePopup(row)}
                      />
                    </div>,
                    <div key={`${row.provider}-email`} className="border-t pt-2">
                      {row.emailFrequency !== null ? (
                        <>
                          <select
                            aria-label={`${text.label} — ${t('prefEmail')}`}
                            value={row.emailFrequency}
                            disabled={emailSaving}
                            onChange={(e) => changeEmailFrequency(row, e.target.value as EmailFrequency)}
                          >
                            <option value="immediate">{t('prefEmailImmediate')}</option>
                            <option value="daily">{t('prefEmailDaily')}</option>
                            <option value="off">{t('prefEmailOff')}</option>
                          </select>
                          {!row.emailAvailable ? (
                            <p className="mt-1 max-w-56 text-xs text-muted-foreground">{t('prefChannelUnavailable')}</p>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>,
                  ];
                })}
              </div>
            </section>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('courseExceptionsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('courseExceptionsDescription')}</p>
          {overrideError ? (
            <Alert variant="destructive">
              <AlertDescription>{overrideError}</AlertDescription>
            </Alert>
          ) : null}
          {overrideCourses.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('courseExceptionsEmpty')}</p>
          ) : (
            <ul className="space-y-2">
              {overrideCourses.map((course) => (
                <li key={course.courseId} className="flex items-center gap-3 border-t pt-2 text-sm">
                  <span className="min-w-0 flex-1 font-medium">
                    {course.courseName}
                    {course.mode === 'mute' ? (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">{t('courseMutedBadge')}</span>
                    ) : null}
                  </span>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`${t('courseMuteLabel')}: ${course.courseName}`}
                      checked={course.mode === 'mute'}
                      disabled={savingOverrides.has(course.courseId)}
                      onChange={() => toggleCourseMute(course)}
                    />
                    {t('courseMuteLabel')}
                  </label>
                </li>
              ))}
            </ul>
          )}
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
