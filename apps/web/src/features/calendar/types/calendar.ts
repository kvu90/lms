/**
 * Kiểu dữ liệu của trang lịch thuộc feature calendar. Tách từ
 * module phẳng `src/lib/calendar.ts` khi tổ chức lại apps/web
 * theo mô hình features/ (issue #500): kiểu nằm ở tầng types/,
 * hàm thuần về múi giờ nằm ở tầng utils/, lời gọi API thuần ở
 * tầng api/, hook ở tầng queries/.
 */

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
