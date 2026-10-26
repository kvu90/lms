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

/**
 * Múi giờ nghiệp vụ của ứng dụng (trường học Việt Nam): mọi khoảng
 * ngày "tháng hiện tại" / "N ngày tới" mà query key phụ thuộc vào đều
 * tính theo múi giờ này ở CẢ hai phía server và client.
 *
 * Lý do phải ghim một múi giờ thay vì múi giờ máy chạy (lát SL-1 của
 * #7): query key của sự kiện lịch chứa đúng chuỗi from/to, nên loader
 * phía server chỉ dehydrate trúng key khi nó tính ra ĐÚNG chuỗi mà
 * phía client sẽ tính. Tiến trình SSR chạy múi giờ UTC còn trình
 * duyệt của người dùng ở Việt Nam — tính theo giờ máy là hai phía
 * lệch nhau và dữ liệu hydrate không bao giờ khớp key. Ghim
 * Asia/Ho_Chi_Minh (không có giờ mùa, lệch UTC cố định) làm hai phía
 * tất định như nhau; người dùng ngoài Việt Nam cũng xem lịch theo
 * ngày Việt Nam, đúng bối cảnh nghiệp vụ của hệ.
 */
export const APP_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const zonedDayPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const zonedClockPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Đọc một trường số từ kết quả formatToParts (thiếu trường thì 0 — không xảy ra với các formatter ở đây). */
function partNumber(parts: Intl.DateTimeFormatPart[], type: string): number {
  return Number(parts.find((p) => p.type === type)?.value ?? '0');
}

/** Ngày lịch (năm/tháng/ngày) của một mốc thời gian theo múi giờ ứng dụng. */
function zonedDateParts(instant: Date): { year: number; month: number; day: number } {
  const parts = zonedDayPartsFormatter.formatToParts(instant);
  return { year: partNumber(parts, 'year'), month: partNumber(parts, 'month'), day: partNumber(parts, 'day') };
}

/** Độ lệch của múi giờ ứng dụng so với UTC tại một mốc (ms): format ngược mốc đó theo giờ địa phương rồi trừ. */
function zonedOffsetMs(instant: Date): number {
  const parts = zonedClockPartsFormatter.formatToParts(instant);
  const asUtcMs = Date.UTC(
    partNumber(parts, 'year'),
    partNumber(parts, 'month') - 1,
    partNumber(parts, 'day'),
    partNumber(parts, 'hour'),
    partNumber(parts, 'minute'),
    partNumber(parts, 'second'),
  );
  return asUtcMs - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Mốc UTC của 00:00:00.000 một ngày lịch theo múi giờ ứng dụng: đoán
 * nửa đêm UTC của ngày đó, trừ độ lệch múi giờ đo tại mốc đoán (độ
 * lệch không đổi trong một ngày nên một lượt hiệu chỉnh là đủ).
 */
function zonedMidnightUtcMs(year: number, month: number, day: number): number {
  const guessUtcMs = Date.UTC(year, month - 1, day);
  return guessUtcMs - zonedOffsetMs(new Date(guessUtcMs));
}

/**
 * Khoảng sự kiện của THÁNG HIỆN TẠI theo múi giờ ứng dụng, dạng ISO
 * (from = 00:00 ngày 1, to = 23:59:59.999 ngày cuối tháng). Trang
 * lịch và loader SL-1 của nó dùng CHUNG hàm này nên query key
 * `calendarEvents(from, to)` khớp tuyệt đối giữa hai phía.
 *
 * @param now - Mốc "hiện tại" (mặc định lúc gọi); truyền tường minh khi test.
 * @returns `{ from, to }` là chuỗi ISO của hai đầu khoảng.
 */
export function currentMonthRangeIso(now: Date = new Date()): { from: string; to: string } {
  const { year, month } = zonedDateParts(now);
  const fromMs = zonedMidnightUtcMs(year, month, 1);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const toMs = zonedMidnightUtcMs(nextYear, nextMonth, 1) - 1;
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

/**
 * Khoảng sự kiện `days` ngày tính từ ĐẦU NGÀY HÔM NAY theo múi giờ
 * ứng dụng (from = 00:00 hôm nay, to = from + đúng `days` ngày) —
 * khối học viên của dashboard dùng cho biểu đồ hoạt động: cửa sổ lấy
 * sự kiện phủ đúng các ô ngày mà biểu đồ dựng (ô đầu là hôm nay
 * 00:00 theo giờ ứng dụng), và loader SL-1 tính lại cùng một khoảng
 * nên key khớp.
 *
 * @param days - Số ngày của cửa sổ (dashboard dùng 30).
 * @param now - Mốc "hiện tại" (mặc định lúc gọi); truyền tường minh khi test.
 * @returns `{ from, to }` là chuỗi ISO của hai đầu khoảng.
 */
export function upcomingDaysRangeIso(days: number, now: Date = new Date()): { from: string; to: string } {
  const { year, month, day } = zonedDateParts(now);
  const fromMs = zonedMidnightUtcMs(year, month, day);
  return { from: new Date(fromMs).toISOString(), to: new Date(fromMs + days * 86_400_000).toISOString() };
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
