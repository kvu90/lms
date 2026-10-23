import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Badge } from '@lms/ui/components/ui/badge';
import { Button } from '@lms/ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@lms/ui/components/ui/dropdown-menu';
import { apiJson } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import '../i18n';

/** Hình dạng một thông báo như GET /notifications trả về (khớp trang thông báo đầy đủ). */
interface NotificationView {
  id: string;
  subject: string;
  fullmessage: string;
  eventtype: string;
  timeread: string | null;
  timecreated: string;
}

/** Số thông báo tối đa hiện trong panel xổ xuống; xem hết thì sang trang thông báo. */
const PANEL_LIMIT = 10;

/**
 * Chuông thông báo ở góc phải site-header (mẫu ngăn thông báo của
 * Moodle / chuông của Facebook), thay đúng vị trí bộ chọn ngôn ngữ đã
 * gỡ — site chỉ dùng tiếng Việt nên header không còn control chọn
 * ngôn ngữ. Huy hiệu đỏ là số chưa đọc từ GET
 * /notifications/unread-count, làm mới nền mỗi 60 giây trên nền
 * staleTime chung của queryClient; panel xổ xuống (DropdownMenu của
 * @lms/ui) liệt kê các thông báo mới nhất lấy từ GET /notifications
 * khi mở panel, mục chưa đọc đậm và nền nổi hơn mục đã đọc. Bấm một
 * thông báo: đánh dấu đã đọc (POST /notifications/:id/read) rồi điều
 * hướng sang trang thông báo đầy đủ; chân panel có "đánh dấu đã đọc
 * tất cả" (POST /notifications/read-all) và lối sang trang thông báo.
 * Mọi đột biến đều vô hiệu hoá cả hai khoá thông báo để huy hiệu và
 * danh sách luôn khớp nhau.
 */
export function NotificationBell() {
  const { t, i18n } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const unreadQuery = useQuery({
    queryKey: queryKeys.notificationUnreadCount,
    queryFn: () => apiJson<{ unread: number }>('/api/v1/notifications/unread-count'),
    refetchInterval: 60_000,
  });
  const listQuery = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => apiJson<NotificationView[]>('/api/v1/notifications'),
    enabled: open,
  });

  /** Làm mới đồng thời danh sách và số chưa đọc sau mỗi đột biến. */
  const refreshNotifications = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationUnreadCount }),
    ]);

  const markAllRead = useMutation({
    mutationFn: () => apiJson('/api/v1/notifications/read-all', { method: 'POST', body: '{}' }),
    onSuccess: () => void refreshNotifications(),
  });
  const markOneRead = useMutation({
    mutationFn: (id: string) => apiJson(`/api/v1/notifications/${id}/read`, { method: 'POST', body: '{}' }),
    onSuccess: () => void refreshNotifications(),
  });

  const unread = unreadQuery.data?.unread ?? 0;
  const items = (listQuery.data ?? []).slice(0, PANEL_LIMIT);

  /** Mở một thông báo: đánh dấu đã đọc nếu chưa, rồi sang trang thông báo đầy đủ. */
  function openNotification(item: NotificationView) {
    if (!item.timeread) markOneRead.mutate(item.id);
    setOpen(false);
    navigate('/notifications');
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="ghost" size="icon" className="relative" aria-label={t('notifications')} />
        }
      >
        <Bell />
        {unread > 0 ? (
          <Badge variant="destructive" className="absolute -top-1 -right-1 h-5 min-w-5 rounded-full px-1">
            {unread}
          </Badge>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        {/* Nhãn nhóm phải nằm trong DropdownMenuGroup (Base UI đòi
            MenuGroupContext), cùng bài học với menu tài khoản. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('notifications')}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="max-h-80 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {listQuery.isPending ? t('notificationsLoading') : t('noNotifications')}
            </p>
          ) : (
            items.map((item) => (
              <DropdownMenuItem
                key={item.id}
                onClick={() => openNotification(item)}
                className={cn(!item.timeread && 'bg-accent/60')}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className={cn('truncate', !item.timeread && 'font-semibold')}>{item.subject}</span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{item.fullmessage}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(item.timecreated).toLocaleString(i18n.language)}
                  </span>
                </div>
              </DropdownMenuItem>
            ))
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={unread === 0} onClick={() => markAllRead.mutate()}>
          {t('markAllRead')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setOpen(false);
            navigate('/notifications');
          }}
        >
          {t('viewAllNotifications')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
