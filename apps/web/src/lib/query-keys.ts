/**
 * Khoá truy vấn tập trung (query key factory theo khuyến nghị của tài
 * liệu TanStack Query): mọi useQuery/useQueries trong app lấy khoá từ
 * đây để việc vô hiệu hoá cache sau đột biến (invalidateQueries) khớp
 * đúng khoá đã đọc, tránh lệch chuỗi khoá viết tay từng nơi. Cấu trúc
 * phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  /** Ảnh chụp quyền của người đang đăng nhập (GET /users/me/capabilities). */
  capabilities: ['capabilities'] as const,
  /** Danh sách toàn bộ khoá học (GET /courses). */
  courses: ['courses'] as const,
  /** Dữ liệu hiển thị theo từng khoá: ghi danh của tôi + báo cáo điểm + sổ điểm của tôi. */
  courseAccess: (courseId: string) => ['course-access', courseId] as const,
  /** Danh sách người dùng cho khối quản trị (phân trang + tìm kiếm phía server). */
  adminUsers: (page: number, pageSize: number, search = '') => ['admin', 'users', page, pageSize, search] as const,
  /** Cây danh mục khoá học cho khối quản trị. */
  categoryTree: ['courses', 'categories', 'tree'] as const,
  /** Danh sách vai trò cho khối quản trị. */
  roles: ['access', 'roles'] as const,
  /** Huy hiệu đã cấp cho chính người dùng. */
  myBadges: ['badges', 'mine'] as const,
  /** Thông báo của chính người dùng. */
  notifications: ['notifications'] as const,
  /** Số thông báo chưa đọc của chính người dùng (huy hiệu trên chuông ở header). */
  notificationUnreadCount: ['notifications', 'unread-count'] as const,
  /** Sự kiện lịch trong một khoảng ngày (ISO string đầu/cuối khoảng). */
  calendarEvents: (from: string, to: string) => ['calendar', 'events', from, to] as const,
  /** Các nhà cung cấp đăng nhập ngoài đang bật (GET /auth/oauth/providers) — dùng chung cho trang login và thẻ liên kết ở hồ sơ. */
  oauthProviders: ['auth', 'oauth', 'providers'] as const,
  /** Các liên kết đăng nhập ngoài của chính người dùng (GET /auth/oauth/links). */
  oauthLinks: ['auth', 'oauth', 'links'] as const,
  /** Các phiên đang hoạt động của chính người dùng (GET /auth/sessions). */
  mySessions: ['auth', 'sessions'] as const,
  /** Trạng thái MFA TOTP của chính người dùng (GET /auth/mfa/status). */
  mfaStatus: ['auth', 'mfa', 'status'] as const,
  /** Khối tổng hợp dashboard việc cần làm (GET /dashboard/overview) — DASH1. */
  dashboardOverview: ['dashboard', 'overview'] as const,
  /** Pref thẻ khoá của chính người dùng (GET /dashboard/course-cards) — DASH1. */
  courseCards: ['dashboard', 'course-cards'] as const,
};
