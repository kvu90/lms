import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/** Một sự kiện lịch như trang lịch hiển thị. */
export interface CalendarEventView {
  id: string;
  name: string;
  description: string;
  eventType: string;
  timeStart: string;
  timeDuration: number;
  repeatId: string;
  isException: boolean;
}

/** Một đăng ký lịch ngoài (hàng của GET /calendar/subscriptions phía server). */
export interface CalendarSubscriptionView {
  id: string;
  name: string;
  url: string | null;
  eventType: string;
  pollInterval: number;
}

/** Đường dẫn đăng ký xuất lịch của chính user; null = chưa tạo. */
export interface CalendarExportTokenView {
  token: string;
  url: string;
}

/** Sự kiện trong một khoảng ngày — khoá factory calendarEvents(from, to) đã có sẵn. */
export function useCalendarEvents(fromIso: string, toIso: string) {
  return useQuery({
    queryKey: queryKeys.calendarEvents(fromIso, toIso),
    queryFn: () => apiJson<CalendarEventView[]>(`/api/v1/calendar/events?from=${fromIso}&to=${toIso}`),
  });
}

/**
 * Đăng ký lịch ngoài. Lỗi tải lại giữ dữ liệu cũ (keepPreviousData + không
 * phơi lỗi ra trang) — đúng hành vi cũ: subscription lỗi thì danh sách cũ
 * đứng yên, trang không sập.
 */
export function useCalendarSubscriptions() {
  return useQuery({
    queryKey: queryKeys.calendarSubscriptions,
    queryFn: () => apiJson<CalendarSubscriptionView[]>('/api/v1/calendar/subscriptions'),
    placeholderData: keepPreviousData,
  });
}

/** Đường dẫn xuất lịch hiện tại; lỗi tải giữ giá trị cũ như hành vi cũ. */
export function useCalendarExportToken() {
  return useQuery({
    queryKey: queryKeys.calendarExportToken,
    queryFn: () => apiJson<CalendarExportTokenView | null>('/api/v1/calendar/export-token'),
    placeholderData: keepPreviousData,
  });
}

/** Làm mới mọi truy vấn lịch (sự kiện + đăng ký + token) sau một đột biến. */
function useInvalidateCalendar() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.calendar });
}

/** Tạo sự kiện lịch (POST /calendar/events) theo đúng DTO phía trang dựng. */
export function useCreateCalendarEvent() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiJson('/api/v1/calendar/events', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

/** Xoá một sự kiện của mình (DELETE /calendar/events/:id). */
export function useDeleteCalendarEvent() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (id: string) => apiJson(`/api/v1/calendar/events/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

/** Đặt nhắc trước sự kiện (POST /calendar/events/:id/remind) — không đổi dữ liệu hiển thị nên không làm mới truy vấn. */
export function useRemindCalendarEvent() {
  return useMutation({
    mutationFn: (id: string) =>
      apiJson(`/api/v1/calendar/events/${id}/remind`, {
        method: 'POST',
        body: JSON.stringify({ minutesBefore: 60 }),
      }),
  });
}

/** Thêm đăng ký lịch ngoài từ URL ICS (POST /calendar/subscriptions). */
export function useCreateCalendarSubscription() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (input: { name: string; url: string }) =>
      apiJson('/api/v1/calendar/subscriptions', {
        method: 'POST',
        body: JSON.stringify({ name: input.name, url: input.url, eventType: 'user' }),
      }),
    onSuccess: invalidate,
  });
}

/** Yêu cầu nhập ngay một đăng ký (POST /calendar/subscriptions/:id/import). */
export function useImportCalendarSubscription() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (id: string) =>
      apiJson(`/api/v1/calendar/subscriptions/${id}/import`, { method: 'POST', body: '{}' }),
    onSuccess: invalidate,
  });
}

/**
 * Tạo/tạo lại đường dẫn xuất lịch (POST /calendar/export-token): kết quả
 * ghi thẳng vào cache (đúng hành vi cũ là đặt ngay giá trị vừa tạo), token
 * cũ hết hiệu lực phía server.
 */
export function useCreateCalendarExportToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiJson<CalendarExportTokenView>('/api/v1/calendar/export-token', { method: 'POST' }),
    onSuccess: (created) => queryClient.setQueryData(queryKeys.calendarExportToken, created),
  });
}

/** Thu hồi đường dẫn xuất lịch (DELETE /calendar/export-token) — cache về null ngay. */
export function useRevokeCalendarExportToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiJson('/api/v1/calendar/export-token', { method: 'DELETE' }),
    onSuccess: () => queryClient.setQueryData(queryKeys.calendarExportToken, null),
  });
}
