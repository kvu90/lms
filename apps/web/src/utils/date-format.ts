/**
 * Helper định dạng ngày giờ HIỂN THỊ dùng chung cho toàn bộ giao diện web.
 *
 * Trước đây mỗi trang tự gọi `toLocaleDateString` / `toLocaleString` /
 * `toLocaleTimeString` / `Intl.DateTimeFormat` ngay tại chỗ (vài trang còn
 * tự khai hàm cục bộ như `dayLabel` / `dateTimeLabel` / `formatDateTime`),
 * nên cùng một khuôn hiển thị bị lặp ở nhiều nơi. Module này là nơi duy
 * nhất gói các lời gọi đó: mỗi hàm tương ứng đúng một khuôn hiển thị đang
 * có trong hệ và cho ra chuỗi GIỐNG HỆT lời gọi gốc mà nó thay thế — đợt
 * hợp nhất chỉ đổi nơi đặt mã, không đổi một ký tự nào của chuỗi hiển thị.
 *
 * Ranh giới phạm vi:
 * - Chỉ phục vụ định dạng ngày giờ hiển thị. Định dạng SỐ (học phí, số
 *   tiền, điểm) vẫn dùng `toLocaleString` / `Intl.NumberFormat` tại chỗ,
 *   không đi qua module này.
 * - Các hàm nội bộ của `lib/calendar.ts` (trích thành phần múi giờ cho
 *   lưới lịch) không thuộc module này và không đổi.
 */

/** Giá trị thời gian đầu vào: đối tượng Date sẵn có hoặc chuỗi ISO. */
export type DateInput = Date | string;

/**
 * Chuẩn hoá đầu vào về Date: chuỗi ISO được parse bằng `new Date(...)`
 * đúng như các vị trí gọi gốc vẫn làm trước khi định dạng.
 *
 * @param value - Date sẵn có hoặc chuỗi ISO.
 * @returns Đối tượng Date tương ứng.
 */
function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Khuôn NGÀY mặc định của trình duyệt: `toLocaleDateString(locale)`
 * không tùy chọn — dùng cho ngày cấp/hết hạn huy hiệu, ngày thêm thành
 * viên lớp, đầu mục ngày trong thông báo và ngăn cách ngày trong tin nhắn.
 *
 * @param value - Thời điểm cần hiển thị.
 * @param locale - Ngôn ngữ hiển thị; bỏ qua thì theo mặc định của trình duyệt, như lời gọi gốc tại các vị trí không truyền locale.
 * @returns Chuỗi ngày đã định dạng, giống hệt `toLocaleDateString` tại vị trí gốc.
 */
export function formatDate(value: DateInput, locale?: string): string {
  return toDate(value).toLocaleDateString(locale);
}

/**
 * Khuôn NGÀY + GIỜ mặc định của trình duyệt: `toLocaleString(locale)`
 * không tùy chọn — dùng cho mốc ghim đề, thời điểm truy cập gần nhất,
 * thời điểm tin nhắn và các dòng thời gian trong các panel quiz.
 *
 * @param value - Thời điểm cần hiển thị.
 * @param locale - Ngôn ngữ hiển thị; bỏ qua thì theo mặc định của trình duyệt, như lời gọi gốc.
 * @returns Chuỗi ngày giờ đã định dạng, giống hệt `toLocaleString` tại vị trí gốc.
 */
export function formatDateTime(value: DateInput, locale?: string): string {
  return toDate(value).toLocaleString(locale);
}

/**
 * Khuôn GIỜ của trang lịch: `toLocaleTimeString(locale, { hour: '2-digit',
 * minute: '2-digit' })` — giờ hai chữ số kèm phút.
 *
 * @param value - Thời điểm cần hiển thị.
 * @param locale - Ngôn ngữ hiển thị; bỏ qua thì theo mặc định của trình duyệt, như lời gọi gốc.
 * @returns Chuỗi giờ đã định dạng, giống hệt lời gọi gốc trong trang lịch.
 */
export function formatTime(value: DateInput, locale?: string): string {
  return toDate(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Khuôn ngày giờ TÙY CHỌN qua `Intl.DateTimeFormat`: bao phủ mọi khuôn
 * hiển thị có truyền bộ tùy chọn tường minh đang có trong hệ — nhãn ngày
 * dd/MM và nhãn ngày giờ ngắn của trang tổng quan và bề mặt phụ huynh,
 * nhãn ngày dài và tiêu đề tháng của trang lịch, và khuôn
 * `dateStyle`/`timeStyle` của khối assignment. `Intl.DateTimeFormat` là
 * cơ chế mà chính các phương thức `toLocale*` dùng bên dưới, nên chuỗi
 * kết quả giống hệt lời gọi gốc tương ứng.
 *
 * @param value - Thời điểm cần hiển thị.
 * @param locale - Ngôn ngữ hiển thị (có thể `undefined` khi vị trí gốc để trình duyệt tự quyết).
 * @param options - Bộ tùy chọn định dạng đúng như vị trí gốc đang dùng.
 * @returns Chuỗi đã định dạng theo bộ tùy chọn.
 */
export function formatWithOptions(
  value: DateInput,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options).format(toDate(value));
}
