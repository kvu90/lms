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

/** Tần suất gửi email của một loại thông báo (mô hình tuỳ chọn v2, NB-2 issue #174). */
export type EmailFrequency = 'immediate' | 'daily' | 'off';

/**
 * Một dòng tuỳ chọn v2 đúng như API trả: MỘT dòng cho mỗi provider.
 * Nhãn + mô tả vi/en đến từ registry ở API (nguồn sự thật duy nhất) —
 * web chọn theo ngôn ngữ giao diện, không tự chế bảng nhãn.
 * `emailFrequency` null = provider không có kênh email;
 * `emailAvailable` false = kênh email chưa gửi thật (chưa có SMTP) —
 * trang hiện ghi chú trung thực, cài đặt vẫn lưu và áp dụng khi mở.
 * Kênh push không có ở đây: ẩn hẳn cho tới khi có app native.
 */
export interface NotificationPreferenceView {
  provider: string;
  component: string;
  group: NotificationGroupFilter;
  label: { vi: string; en: string };
  description: { vi: string; en: string };
  teacherOnly: boolean;
  mandatoryInApp: boolean;
  popupEnabled: boolean;
  emailFrequency: EmailFrequency | null;
  emailAvailable: boolean;
}

/** Khoá định danh một dòng gộp trong cache/trạng thái hiển thị. */
export function notificationGroupKey(g: Pick<NotificationGroupView, 'eventType' | 'contextUrl' | 'day'>): string {
  return `${g.eventType}|${g.contextUrl ?? ''}|${g.day}`;
}

/** Khoá định danh một dòng tuỳ chọn v2 (một dòng cho mỗi provider). */
export function preferenceKey(row: Pick<NotificationPreferenceView, 'provider'>): string {
  return row.provider;
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

/** Toàn bộ dòng tuỳ chọn v2 của chính người dùng (GET /messages/preferences). */
export function useMessagePreferences() {
  return useQuery({
    queryKey: queryKeys.messagePreferences,
    queryFn: () => apiJson<NotificationPreferenceView[]>('/api/v1/messages/preferences'),
  });
}

/** Một thay đổi tuỳ chọn v2 cho một provider: popup và/hoặc tần suất email. */
export interface PreferencePatch {
  popupEnabled?: boolean;
  emailFrequency?: EmailFrequency;
}

/**
 * Chế độ ghi đè thông báo theo khoá (NB-4, issue #174): 'all' = nhận
 * như mặc định toàn cục; 'mute' = tắt tiếng khoá đó (thông báo thường
 * của khoá không được sinh ở kênh nào; điểm mới + sắp hết hạn ghi
 * danh vẫn tới theo chính sách P3 đã chốt).
 */
export type NotificationCourseOverrideMode = 'all' | 'mute';

/** Một dòng ghi đè theo khoá đúng như API trả (GET /messages/preferences/courses). */
export interface NotificationCourseOverrideView {
  courseId: string;
  courseName: string;
  mode: NotificationCourseOverrideMode;
}

/** Mọi khoá tôi thuộc về kèm chế độ ghi đè hiệu lực — dữ liệu của mục "Ngoại lệ" trong cài đặt. */
export function useNotificationCourseOverrides() {
  return useQuery({
    queryKey: queryKeys.messageCourseOverrides,
    queryFn: async () => {
      const res = await apiJson<{ courses: NotificationCourseOverrideView[] }>('/api/v1/messages/preferences/courses');
      return res.courses;
    },
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
    mutationFn: (input: { courseId: string; mode: NotificationCourseOverrideMode }) =>
      apiJson<NotificationCourseOverrideView>('/api/v1/messages/preferences/courses', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
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
    mutationFn: (input: { provider: string; patch: PreferencePatch }) =>
      apiJson<NotificationPreferenceView>('/api/v1/messages/preferences', {
        method: 'PUT',
        body: JSON.stringify({ provider: input.provider, ...input.patch }),
      }),
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
