import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  clearReadNotifications, deleteNotification, fetchMessagePreferences, fetchNotificationCourseOverrides,
  fetchNotificationGroupItems as fetchNotificationGroupItemsApi, fetchNotificationGroupsPage,
  fetchNotificationUnreadCount,
  markAllNotificationsRead, markNotificationRead, readNotificationGroup, setMessagePreference,
  setNotificationCourseOverride,
} from '../api/notifications';
import type {
  NotificationCourseOverrideView,
  NotificationGroupView,
  NotificationGroupsPage,
  NotificationItemView,
  NotificationPreferenceView,
  PreferencePatch,
} from '../types/notifications';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu TanStack Query của trung tâm thông báo thuộc
 * feature notifications: options/hook, phân trang vô hạn và các
 * thao tác vá cache. Tầng này bọc các hàm gọi API thuần ở
 * `../api/notifications` (tách khỏi module phẳng
 * `src/lib/notifications.ts` khi tổ chức lại apps/web theo mô
 * hình features/, issue #500).
 */

/**
 * Số thông báo chưa đọc cho huy hiệu (GET /notifications/unread-count):
 * options dùng chung cho chuông thông báo và sidebar — cùng khoá nhà
 * máy nên TanStack gộp thành một lần gọi và một mục cache cho cả hai
 * bề mặt (F-01 của rà soát #133).
 */
export function notificationUnreadCountQueryOptions() {
  return queryOptions({
    queryKey: sharedQueryKeys.notificationUnreadCount,
    queryFn: () => fetchNotificationUnreadCount(),
  });
}

/** Hook đọc số thông báo chưa đọc qua options dùng chung. */
export function useNotificationUnreadCount() {
  return useQuery(notificationUnreadCountQueryOptions());
}

/**
 * Danh sách nhóm thông báo v2 theo bộ lọc — phân trang con trỏ bằng
 * useInfiniteQuery (F-01): các trang nằm trong cache theo khoá factory,
 * đổi bộ lọc là một khoá mới, "tải thêm" nối trang vào cùng cache.
 */
export function useNotificationGroups(group: string, unreadOnly: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.notificationGroups(group, unreadOnly),
    queryFn: ({ pageParam }) => fetchNotificationGroupsPage(group, unreadOnly, pageParam as string | undefined),
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
  return queryClient.fetchQuery({
    queryKey: queryKeys.notificationGroupItems(group.eventType, group.contextUrl ?? '', group.day),
    queryFn: () => fetchNotificationGroupItemsApi(group.eventType, group.contextUrl ?? '', group.day),
  });
}

/** Làm mới số chưa đọc trên huy hiệu (sidebar/header) — bề mặt dùng chung khoá notificationUnreadCount. */
function useInvalidateUnreadCount() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: sharedQueryKeys.notificationUnreadCount });
}

/**
 * Đánh dấu một mục đã đọc (POST /notifications/:id/read). Lỗi mạng bị
 * nuốt như hành vi cũ (UI vẫn cập nhật tại chỗ); thành công hay không,
 * số chưa đọc của huy hiệu đều được làm mới để khớp server.
 */
export function useMarkNotificationRead() {
  const invalidateUnread = useInvalidateUnreadCount();
  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSettled: invalidateUnread,
  });
}

/** Đánh dấu đã đọc cả một dòng gộp (POST /notifications/read-group) — cùng quy ước nuốt lỗi + làm mới huy hiệu. */
export function useReadNotificationGroup() {
  const invalidateUnread = useInvalidateUnreadCount();
  return useMutation({
    mutationFn: (group: Pick<NotificationGroupView, 'eventType' | 'contextUrl' | 'day'>) =>
      readNotificationGroup(group),
    onSettled: invalidateUnread,
  });
}

/** Xoá một mục thông báo (DELETE /notifications/:id) — nuốt lỗi như cũ, làm mới huy hiệu vì mục xoá có thể đang chưa đọc. */
export function useDeleteNotification() {
  const invalidateUnread = useInvalidateUnreadCount();
  return useMutation({
    mutationFn: (id: string) => deleteNotification(id),
    onSettled: invalidateUnread,
  });
}

/** Đánh dấu tất cả đã đọc (POST /notifications/mark-read với thân yêu cầu `{"scope": "all"}`): làm mới mọi danh sách nhóm + huy hiệu. */
export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notificationGroupsRoot });
      void queryClient.invalidateQueries({ queryKey: sharedQueryKeys.notificationUnreadCount });
    },
  });
}

/** Dọn các thông báo đã đọc (POST /notifications/clear-read): làm mới mọi danh sách nhóm. */
export function useClearReadNotifications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => clearReadNotifications(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notificationGroupsRoot }),
  });
}

/** Toàn bộ dòng tuỳ chọn v2 của chính người dùng (GET /messages/preferences). */
export function useMessagePreferences() {
  return useQuery({
    queryKey: queryKeys.messagePreferences,
    queryFn: () => fetchMessagePreferences(),
  });
}

/** Mọi khoá tôi thuộc về kèm chế độ ghi đè hiệu lực — dữ liệu của mục "Ngoại lệ" trong cài đặt. */
export function useNotificationCourseOverrides() {
  return useQuery({
    queryKey: queryKeys.messageCourseOverrides,
    queryFn: () => fetchNotificationCourseOverrides(),
  });
}

/**
 * Đặt ghi đè cho đúng một khoá (PUT /messages/preferences/courses)
 * với cập nhật lạc quan trên cache như tuỳ chọn theo provider: áp
 * ngay chế độ mới lên dòng khoá đó, lỗi thì hoàn lại.
 */
export function useSetNotificationCourseOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { courseId: string; mode: NotificationCourseOverrideView['mode'] }) =>
      setNotificationCourseOverride(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.messageCourseOverrides });
      const previous = queryClient.getQueryData<NotificationCourseOverrideView[]>(queryKeys.messageCourseOverrides);
      queryClient.setQueryData<NotificationCourseOverrideView[]>(queryKeys.messageCourseOverrides, (old) =>
        old?.map((c) => (c.courseId === input.courseId ? { ...c, mode: input.mode } : c)),
      );
      return { previous };
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<NotificationCourseOverrideView[]>(queryKeys.messageCourseOverrides, (old) =>
        old?.map((c) => (c.courseId === saved.courseId ? saved : c)),
      );
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.messageCourseOverrides, context.previous);
      }
    },
  });
}

/**
 * Đặt tuỳ chọn v2 cho đúng một provider (PUT /messages/preferences)
 * với cập nhật lạc quan trên cache: áp patch ngay lên dòng đó, server
 * trả về dòng đầy đủ thì chốt theo bản server, lỗi thì hoàn lại toàn
 * bộ danh sách trước đó — cùng hành vi trang cũ, nay theo mô hình v2.
 */
export function useSetMessagePreference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider: string; patch: PreferencePatch }) => setMessagePreference(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.messagePreferences });
      const previous = queryClient.getQueryData<NotificationPreferenceView[]>(queryKeys.messagePreferences);
      queryClient.setQueryData<NotificationPreferenceView[]>(queryKeys.messagePreferences, (old) =>
        old?.map((p) => (p.provider === input.provider ? { ...p, ...input.patch } : p)),
      );
      return { previous };
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<NotificationPreferenceView[]>(queryKeys.messagePreferences, (old) =>
        old?.map((p) => (p.provider === saved.provider ? saved : p)),
      );
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.messagePreferences, context.previous);
      }
    },
  });
}
