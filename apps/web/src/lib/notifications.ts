import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/** Một mục thông báo đầy đủ như API danh sách phẳng của trung tâm v2 trả về. */
export interface NotificationItemView {
  id: string;
  subject: string;
  fullMessage: string;
  smallMessage: string;
  eventType: string;
  contextUrl: string | null;
  contextUrlName: string | null;
  timeRead: string | null;
  createdAt: string;
}

export type NotificationGroupFilter = 'learning' | 'people' | 'system';

/**
 * Một dòng GỘP của trung tâm thông báo v2 (issue #51): khoá gộp
 * (loại × nguồn × ngày), `latest` là mục mới nhất đại diện.
 */
export interface NotificationGroupView {
  eventType: string;
  component: string;
  group: NotificationGroupFilter;
  contextUrl: string | null;
  day: string;
  count: number;
  unreadCount: number;
  latest: {
    id: string;
    subject: string;
    smallMessage: string;
    contextUrlName: string | null;
    createdAt: string;
    timeRead: string | null;
  };
}

/** Một trang của danh sách nhóm (phân trang con trỏ phía server). */
export interface NotificationGroupsPage {
  items: NotificationGroupView[];
  nextCursor: string | null;
}

export type PreferenceChannel = 'popup' | 'email' | 'push';
export type PreferenceState = 'loggedin' | 'loggedoff';

/**
 * Một dòng tuỳ chọn đúng như API trả: mỗi (provider × channel × state)
 * là một bản ghi độc lập kèm cờ `enabled` của chính nó.
 */
export interface PreferenceRow {
  provider: string;
  component: string;
  channel: PreferenceChannel;
  state: PreferenceState;
  enabled: boolean;
}

/** Khoá định danh một dòng gộp trong cache/trạng thái hiển thị. */
export function notificationGroupKey(g: Pick<NotificationGroupView, 'eventType' | 'contextUrl' | 'day'>): string {
  return `${g.eventType}|${g.contextUrl ?? ''}|${g.day}`;
}

/** Khoá định danh một dòng tuỳ chọn. */
export function preferenceKey(row: Pick<PreferenceRow, 'provider' | 'channel' | 'state'>): string {
  return `${row.provider}|${row.channel}|${row.state}`;
}

function groupsUrl(group: string, unreadOnly: boolean, cursor?: string): string {
  const params = new URLSearchParams({ limit: '20' });
  if (group !== 'all') params.set('group', group);
  if (unreadOnly) params.set('unreadOnly', 'true');
  if (cursor) params.set('cursor', cursor);
  return `/api/v1/notifications?${params.toString()}`;
}

/**
 * Danh sách nhóm thông báo v2 theo bộ lọc — phân trang con trỏ bằng
 * useInfiniteQuery (F-01): các trang nằm trong cache theo khoá factory,
 * đổi bộ lọc là một khoá mới, "tải thêm" nối trang vào cùng cache.
 */
export function useNotificationGroups(group: string, unreadOnly: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.notificationGroups(group, unreadOnly),
    queryFn: ({ pageParam }) =>
      apiJson<NotificationGroupsPage>(groupsUrl(group, unreadOnly, pageParam as string | undefined)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/** Gộp các trang đã tải thành danh sách phẳng theo thứ tự hiển thị. */
export function flattenNotificationGroups(
  data: InfiniteData<NotificationGroupsPage> | undefined,
): NotificationGroupView[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

/**
 * Áp một phép biến đổi lên MỌI danh sách nhóm đang có trong cache (mọi
 * biến thể lọc): trang thông báo cập nhật đếm/đã-đọc tại chỗ qua đây thay
 * cho state cục bộ như trước — hiển thị đổi ngay, dữ liệu vẫn là của
 * cache dùng chung.
 */
export function updateNotificationGroupsCache(
  queryClient: QueryClient,
  updater: (groups: NotificationGroupView[]) => NotificationGroupView[],
) {
  queryClient.setQueriesData<InfiniteData<NotificationGroupsPage>>(
    { queryKey: queryKeys.notificationGroupsRoot },
    (old) =>
      old
        ? { ...old, pages: old.pages.map((page) => ({ ...page, items: updater(page.items) })) }
        : old,
  );
}

/**
 * Tải các mục phẳng của một dòng gộp qua cache TanStack (fetchQuery:
 * có cache + dedupe theo khoá factory, không cần hook theo từng dòng).
 */
export function fetchNotificationGroupItems(
  queryClient: QueryClient,
  group: NotificationGroupView,
): Promise<NotificationItemView[]> {
  const params = new URLSearchParams({
    eventType: group.eventType,
    contextUrl: group.contextUrl ?? '',
    day: group.day,
    limit: '100',
  });
  return queryClient.fetchQuery({
    queryKey: queryKeys.notificationGroupItems(group.eventType, group.contextUrl ?? '', group.day),
    queryFn: async () => {
      const page = await apiJson<{ items: NotificationItemView[]; nextCursor: string | null }>(
        `/api/v1/notifications/items?${params.toString()}`,
      );
      return page.items;
    },
  });
}

/** Làm mới số chưa đọc trên huy hiệu (sidebar/header) — bề mặt dùng chung khoá notificationUnreadCount. */
function useInvalidateUnreadCount() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.notificationUnreadCount });
}

/**
 * Đánh dấu một mục đã đọc (POST /notifications/:id/read). Lỗi mạng bị
 * nuốt như hành vi cũ (UI vẫn cập nhật tại chỗ); thành công hay không,
 * số chưa đọc của huy hiệu đều được làm mới để khớp server.
 */
export function useMarkNotificationRead() {
  const invalidateUnread = useInvalidateUnreadCount();
  return useMutation({
    mutationFn: (id: string) =>
      apiJson(`/api/v1/notifications/${id}/read`, { method: 'POST', body: '{}' }).catch(() => undefined),
    onSettled: invalidateUnread,
  });
}

/** Đánh dấu đã đọc cả một dòng gộp (POST /notifications/read-group) — cùng quy ước nuốt lỗi + làm mới huy hiệu. */
export function useReadNotificationGroup() {
  const invalidateUnread = useInvalidateUnreadCount();
  return useMutation({
    mutationFn: (group: Pick<NotificationGroupView, 'eventType' | 'contextUrl' | 'day'>) =>
      apiJson('/api/v1/notifications/read-group', {
        method: 'POST',
        body: JSON.stringify({ eventType: group.eventType, contextUrl: group.contextUrl, day: group.day }),
      }).catch(() => undefined),
    onSettled: invalidateUnread,
  });
}

/** Xoá một mục thông báo (DELETE /notifications/:id) — nuốt lỗi như cũ, làm mới huy hiệu vì mục xoá có thể đang chưa đọc. */
export function useDeleteNotification() {
  const invalidateUnread = useInvalidateUnreadCount();
  return useMutation({
    mutationFn: (id: string) => apiJson(`/api/v1/notifications/${id}`, { method: 'DELETE' }).catch(() => undefined),
    onSettled: invalidateUnread,
  });
}

/** Đánh dấu tất cả đã đọc (POST /notifications/read-all): làm mới mọi danh sách nhóm + huy hiệu. */
export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiJson('/api/v1/notifications/read-all', { method: 'POST', body: '{}' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notificationGroupsRoot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notificationUnreadCount });
    },
  });
}

/** Dọn các thông báo đã đọc (POST /notifications/clear-read): làm mới mọi danh sách nhóm. */
export function useClearReadNotifications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiJson('/api/v1/notifications/clear-read', { method: 'POST', body: '{}' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notificationGroupsRoot }),
  });
}

/** Toàn bộ dòng tuỳ chọn nhận tin của chính người dùng (GET /messages/preferences). */
export function useMessagePreferences() {
  return useQuery({
    queryKey: queryKeys.messagePreferences,
    queryFn: () => apiJson<PreferenceRow[]>('/api/v1/messages/preferences'),
  });
}

/**
 * Bật/tắt đúng một dòng tuỳ chọn (PUT /messages/preferences) với cập nhật
 * lạc quan trên cache: đổi ngay dòng đó, server trả về thì chốt theo bản
 * server, lỗi thì hoàn lại đúng dòng đó (các dòng khác không bị đụng) —
 * cùng hành vi trang cũ tự chế, nay nằm trong tầng dữ liệu dùng chung.
 */
export function useSetMessagePreference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { row: PreferenceRow; enabled: boolean }) =>
      apiJson<PreferenceRow>('/api/v1/messages/preferences', {
        method: 'PUT',
        body: JSON.stringify({
          provider: input.row.provider,
          channel: input.row.channel,
          state: input.row.state,
          enabled: input.enabled,
        }),
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.messagePreferences });
      const previous = queryClient.getQueryData<PreferenceRow[]>(queryKeys.messagePreferences);
      const key = preferenceKey(input.row);
      queryClient.setQueryData<PreferenceRow[]>(queryKeys.messagePreferences, (old) =>
        old?.map((p) => (preferenceKey(p) === key ? { ...p, enabled: input.enabled } : p)),
      );
      return { previous, key };
    },
    onSuccess: (saved, _input, context) => {
      queryClient.setQueryData<PreferenceRow[]>(queryKeys.messagePreferences, (old) =>
        old?.map((p) => (preferenceKey(p) === context.key ? { ...p, enabled: saved.enabled } : p)),
      );
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.messagePreferences, context.previous);
      }
    },
  });
}
