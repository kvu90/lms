import { UAParser } from 'ua-parser-js';

/** Độ dài tối đa của chuỗi user-agent gốc khi phải hiện nguyên dạng dự phòng. */
const MAX_RAW_USER_AGENT_LENGTH = 48;

/**
 * Hàm dịch mẫu mô tả thiết bị khi phân tích được cả trình duyệt lẫn hệ
 * điều hành: nhận tên trình duyệt và tên hệ điều hành, trả về chuỗi hiển
 * thị hoàn chỉnh (mẫu câu nằm ở catalog i18n, ví dụ "{{browser}} trên
 * {{os}}"). Tách thành tham số để module này không phụ thuộc i18next —
 * nơi gọi (component) truyền bản dịch vào.
 */
export type DeviceDescriptionFormatter = (browser: string, os: string) => string;

/**
 * Mô tả thiết bị dễ hiểu từ chuỗi user-agent thô, dùng cho cột thiết bị
 * của bảng phiên đăng nhập thay vì hiện chuỗi thô khó đọc.
 *
 * Thứ tự dự phòng (fallback):
 * 1. `userAgent` rỗng (null, chuỗi trống hoặc chỉ khoảng trắng) → trả
 *    `unknownLabel` do nơi gọi truyền vào (nhãn "không rõ" của i18n).
 * 2. Phân tích được cả trình duyệt và hệ điều hành → trả chuỗi qua
 *    `formatDescription` (mẫu i18n "{{browser}} trên {{os}}").
 * 3. Chỉ phân tích được một trong hai → trả riêng phần đó (tên trình
 *    duyệt hoặc tên hệ điều hành).
 * 4. Không phân tích được gì (user-agent lạ, ví dụ ứng dụng di động tự
 *    đặt tên) → trả chuỗi gốc rút gọn tối đa 48 ký tự kèm dấu "…" khi
 *    bị cắt, giữ đúng hành vi hiển thị cũ để vẫn nhận diện được phiên.
 *
 * @param userAgent Chuỗi user-agent thô của phiên, có thể null khi máy khách không gửi.
 * @param unknownLabel Nhãn hiển thị khi không có user-agent (lấy từ catalog i18n).
 * @param formatDescription Hàm dịch mẫu "{{browser}} trên {{os}}" từ catalog i18n.
 * @returns Chuỗi mô tả thiết bị sẵn sàng để hiển thị.
 */
export function describeUserAgent(
  userAgent: string | null,
  unknownLabel: string,
  formatDescription: DeviceDescriptionFormatter,
): string {
  if (!userAgent || userAgent.trim() === '') return unknownLabel;

  const { browser, os } = UAParser(userAgent);
  if (browser.name && os.name) return formatDescription(browser.name, os.name);
  if (browser.name) return browser.name;
  if (os.name) return os.name;

  return userAgent.length > MAX_RAW_USER_AGENT_LENGTH ? `${userAgent.slice(0, MAX_RAW_USER_AGENT_LENGTH)}…` : userAgent;
}
