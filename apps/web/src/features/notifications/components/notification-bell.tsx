import { IconBell } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@lms/ui/components/dropdown-menu';
import { apiJson } from '#lib/api';
import { formatDateTime } from '#utils/date-format';
import { flattenNotificationGroups, updateNotificationGroupsCache, useMarkNotificationRead, useNotificationGroups, useNotificationUnreadCount, useReadNotificationGroup } from '../queries/notifications';
import { notificationGroupKey } from '../utils/notifications';
import type { NotificationGroupFilter, NotificationGroupView } from '../types/notifications';
import { queryKeys } from '#lib/query-keys';
import '#config/i18n';

/** Số dòng gộp tối đa trong dropdown xem nhanh (audit NB-3, issue #174: 5–10 dòng mới nhất). */
const QUICK_VIEW_LIMIT = 8;

/** Thời gian tương đối cho dòng mới nhất — cùng khoá i18n và cùng luật với trang thông báo. */
function relativeTime(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return t('justNow');
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return t('minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('daysAgo', { count: days });
  return formatDateTime(iso);
}

/**
 * Chuông thông báo ở header + dropdown xem nhanh (lát NB-3, issue
 * #174 — xử khoảng trống G6 của hồ sơ audit thông báo). Số chưa đọc
 * dùng CHUNG khoá `notificationUnreadCount` với huy hiệu ở mục Thông
 * báo trên sidebar: REST cho số ngay khi mở trang, stream SSE (gắn ở
 * app-sidebar) giữ số đó luôn mới trong cache — đọc ở đây hay ở trang
 * thông báo thì số ở mọi bề mặt đều khớp, không cần tải lại trang.
 *
 * Dropdown liệt kê tối đa 8 dòng GỘP mới nhất lấy từ cùng API list
 * nhóm của trung tâm (dùng chung cache `notificationGroups`) — không
 * có endpoint riêng. Bấm một dòng xử đúng như bấm ở trung tâm: dòng
 * đơn thì đánh dấu đã đọc mục đó rồi đi tới ngữ cảnh; dòng gộp có
 * ngữ cảnh thì đánh dấu đã đọc cả nhóm rồi đi; dòng gộp không có ngữ
 * cảnh (trung tâm sẽ mở rộng tại chỗ — dropdown không mở rộng được)
 * thì đi thẳng tới /notifications. Chân dropdown mở trang thông báo
 * đầy đủ. Huy hiệu Tin nhắn ở sidebar thuộc lát M1 (#204), không
 * thuộc bề mặt này.
 */
export function NotificationBell() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Cùng truy vấn hệt sidebar (options dùng chung của
  // lib/notifications, cùng khoá nhà máy): TanStack gộp thành một
  // lần gọi và một mục cache cho cả hai bề mặt.
  const unreadQuery = useNotificationUnreadCount();
  const unread = unreadQuery.data?.unread ?? 0;

  const groupsQuery = useNotificationGroups('all', false);
  const groups = flattenNotificationGroups(groupsQuery.data).slice(0, QUICK_VIEW_LIMIT);
  const markReadMutation = useMarkNotificationRead();
  const readGroupMutation = useReadNotificationGroup();

  const groupLabel: Record<NotificationGroupFilter, string> = {
    learning: t('notificationsGroupLearning'),
    people: t('notificationsGroupPeople'),
    system: t('notificationsGroupSystem'),
  };

  /** Bấm một dòng gộp: cùng ngữ nghĩa với openGroup ở trang thông báo (xem docblock). */
  function openGroup(group: NotificationGroupView) {
    const key = notificationGroupKey(group);
    if (group.count === 1) {
      if (!group.latest.timeRead) {
        markReadMutation.mutate(group.latest.id, {
          onSettled: () => {
            updateNotificationGroupsCache(queryClient, (prev) =>
              prev.map((g) =>
                notificationGroupKey(g) === key && g.unreadCount > 0
                  ? {
                      ...g,
                      unreadCount: g.unreadCount - 1,
                      latest: { ...g.latest, timeRead: new Date().toISOString() },
                    }
                  : g,
              ),
            );
            if (group.contextUrl) navigate(group.contextUrl);
          },
        });
        return;
      }
      if (group.contextUrl) navigate(group.contextUrl);
      return;
    }
    if (!group.contextUrl) {
      navigate('/notifications');
      return;
    }
    if (group.unreadCount > 0) {
      readGroupMutation.mutate(group, {
        onSettled: () => {
          updateNotificationGroupsCache(queryClient, (prev) =>
            prev.map((g) => (notificationGroupKey(g) === key ? { ...g, unreadCount: 0 } : g)),
          );
          navigate(group.contextUrl!);
        },
      });
      return;
    }
    navigate(group.contextUrl);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="ghost" size="icon" className="relative" aria-label={t('notifications')} />
        }
      >
        <IconBell className="size-5" />
        {unread > 0 ? (
          <Badge
            variant="destructive"
            className="absolute -top-1 -right-1 h-4 min-w-4 rounded-full px-1 text-[10px]"
          >
            {unread}
          </Badge>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-96 max-w-[calc(100vw-2rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('notifications')}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {groupsQuery.isPending ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t('notificationsLoading')}</p>
        ) : groupsQuery.isError ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t('notificationsLoadFailed')}</p>
        ) : groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t('noNotifications')}</p>
        ) : (
          groups.map((group) => (
            <DropdownMenuItem
              key={notificationGroupKey(group)}
              onClick={() => openGroup(group)}
              className={`flex-col items-start gap-0.5 py-2 ${group.unreadCount > 0 ? '' : 'opacity-60'}`}
            >
              <span className="flex w-full items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{group.latest.subject}</span>
                  {group.latest.smallMessage ? (
                    <span className="block truncate text-muted-foreground">{group.latest.smallMessage}</span>
                  ) : null}
                  <span className="block text-xs text-muted-foreground">
                    {groupLabel[group.group]}
                    {group.count > 1 ? ` · ${t('notificationGroupCount', { count: group.count })}` : ''}
                    {` · ${relativeTime(group.latest.createdAt, t)}`}
                    {group.unreadCount > 0
                      ? ` · ${t('notificationGroupUnread', { count: group.unreadCount })}`
                      : ` · ${t('readSuffix')}`}
                  </span>
                </span>
                {group.unreadCount > 0 ? (
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
                ) : null}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate('/notifications')}>
          {t('viewAllNotifications')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
