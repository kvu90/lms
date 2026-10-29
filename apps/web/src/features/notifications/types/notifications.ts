/**
 * Kiểu dữ liệu của trung tâm thông báo thuộc feature notifications.
 * Tách từ module phẳng `src/lib/notifications.ts` khi tổ chức lại
 * apps/web theo mô hình features/ (issue #500): kiểu nằm ở tầng
 * types/, hàm thuần ở tầng utils/, lời gọi API thuần ở tầng api/,
 * options/hook và thao tác cache ở tầng queries/.
 */

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
 * `emailAvailable` false = kênh email chưa gửi thật —
 * trang hiện ghi chú trung thực, cài đặt vẫn lưu và áp dụng khi mở.
 * `siteEnabled` false = admin đã tắt loại này ở cấp site (NB-7):
 * trang Cài đặt thông báo hiển thị khoá "Admin đã tắt ở cấp site" và
 * vô hiệu hoá điều khiển của dòng đó, vì server không phát loại này
 * bất kể tuỳ chọn cá nhân.
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
  siteEnabled: boolean;
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
