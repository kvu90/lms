import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  createCalendarEvent, createCalendarExportToken, createCalendarSubscription, deleteCalendarEvent,
  fetchCalendarEvents, fetchCalendarExportToken, fetchCalendarSubscriptions, importCalendarSubscription,
  remindCalendarEvent, revokeCalendarExportToken,
} from '../api/calendar';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu TanStack Query của trang lịch thuộc feature
 * calendar: các hook đọc/ghi bọc tầng `../api/calendar` (tách
 * khỏi module phẳng `src/lib/calendar.ts` khi tổ chức lại
 * apps/web theo mô hình features/, issue #500).
 */

/** Sự kiện trong một khoảng ngày — khoá factory calendarEvents(from, to) đã có sẵn. */
export function useCalendarEvents(fromIso: string, toIso: string) {
  return useQuery({
    queryKey: sharedQueryKeys.calendarEvents(fromIso, toIso),
    queryFn: () => fetchCalendarEvents(fromIso, toIso),
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
    queryFn: () => fetchCalendarSubscriptions(),
    placeholderData: keepPreviousData,
  });
}

/** Đường dẫn xuất lịch hiện tại; lỗi tải giữ giá trị cũ như hành vi cũ. */
export function useCalendarExportToken() {
  return useQuery({
    queryKey: queryKeys.calendarExportToken,
    queryFn: () => fetchCalendarExportToken(),
    placeholderData: keepPreviousData,
  });
}

/** Làm mới mọi truy vấn lịch (sự kiện + đăng ký + token) sau một đột biến. */
function useInvalidateCalendar() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: sharedQueryKeys.calendar });
}

/** Tạo sự kiện lịch (POST /calendar/events) theo đúng DTO phía trang dựng. */
export function useCreateCalendarEvent() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => createCalendarEvent(body),
    onSuccess: invalidate,
  });
}

/** Xoá một sự kiện của mình (DELETE /calendar/events/:id). */
export function useDeleteCalendarEvent() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (id: string) => deleteCalendarEvent(id),
    onSuccess: invalidate,
  });
}

/** Đặt nhắc trước sự kiện (POST /calendar/events/:id/remind) — không đổi dữ liệu hiển thị nên không làm mới truy vấn. */
export function useRemindCalendarEvent() {
  return useMutation({
    mutationFn: (id: string) => remindCalendarEvent(id),
  });
}

/** Thêm đăng ký lịch ngoài từ URL ICS (POST /calendar/subscriptions). */
export function useCreateCalendarSubscription() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (input: { name: string; url: string }) => createCalendarSubscription(input),
    onSuccess: invalidate,
  });
}

/** Yêu cầu nhập ngay một đăng ký (POST /calendar/subscriptions/:id/import). */
export function useImportCalendarSubscription() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (id: string) => importCalendarSubscription(id),
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
    mutationFn: () => createCalendarExportToken(),
    onSuccess: (created) => queryClient.setQueryData(queryKeys.calendarExportToken, created),
  });
}

/** Thu hồi đường dẫn xuất lịch (DELETE /calendar/export-token) — cache về null ngay. */
export function useRevokeCalendarExportToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => revokeCalendarExportToken(),
    onSuccess: () => queryClient.setQueryData(queryKeys.calendarExportToken, null),
  });
}
