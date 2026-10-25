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
  /** Chi tiết một bài tập nộp tệp (trang assignment). */
  assignmentDetail: (assignmentId: string) => ['assignments', assignmentId] as const,
  /** Dữ liệu điểm hiển thị theo từng khoá (báo cáo điểm + điểm theo bài của tôi) — tải lười tại bề mặt tiêu thụ qua lib/course-grade-data.ts. */
  courseAccess: (courseId: string) => ['course-access', courseId] as const,
  /** Danh sách người dùng cho khối quản trị (phân trang + tìm kiếm phía server). */
  /** Gốc khu người dùng quản trị — tiền tố invalidate cho mọi query con (danh sách + chi tiết). */
  adminUsersRoot: ['admin', 'users'] as const,
  adminUsers: (page: number, pageSize: number, search = '') => ['admin', 'users', page, pageSize, search] as const,
  /** Chi tiết một người dùng ở khu quản trị (F-05, rà soát #133). */
  adminUserDetail: (userId: string) => ['admin', 'users', 'detail', userId] as const,
  /** Cây danh mục khoá học cho khối quản trị. */
  categoryTree: ['courses', 'categories', 'tree'] as const,
  /** Tiến độ học của chính người dùng trong một khoá (% hoàn thành; probe lỗi → null). */
  courseMyProgress: (courseId: string) => ['courses', courseId, 'progress', 'me'] as const,
  /** Báo cáo tiến độ lớp của một khoá theo nhóm lọc (trang progress-report; probe lỗi → null = không có quyền). */
  courseProgressReport: (courseId: string, groupId: string) =>
    ['courses', courseId, 'progress', 'report', groupId] as const,
  /** Các nhóm (lớp) của một khoá — bộ lọc của báo cáo tiến độ. */
  courseGroups: (courseId: string) => ['courses', courseId, 'groups'] as const,
  /** Danh sách vai trò cho khối quản trị. */
  roles: ['access', 'roles'] as const,
  /** Gốc khoá phân quyền — tiền tố làm mới mọi truy vấn access sau đột biến gán vai. */
  access: ['access'] as const,
  /** Danh mục capability của hệ (GET /access/capabilities). */
  accessCapabilities: ['access', 'capabilities'] as const,
  /** Cây context phân quyền (GET /access/contexts). */
  accessContexts: ['access', 'contexts'] as const,
  /** Ma trận capability của một vai (GET /access/roles/:id/capabilities). */
  roleCapabilities: (roleId: string) => ['access', 'roles', roleId, 'capabilities'] as const,
  /** Huy hiệu đã cấp cho chính người dùng. */
  myBadges: ['badges', 'mine'] as const,
  /** Gốc khoá huy hiệu — tiền tố để làm mới mọi truy vấn huy hiệu sau đột biến. */
  badges: ['badges'] as const,
  /** Toàn bộ huy hiệu (GET /badges) — panel quản trị + tra tên dự phòng. */
  badgesAll: ['badges', 'all'] as const,
  /** Danh sách đã cấp của một huy hiệu (GET /badges/:id/issued). */
  badgeIssued: (badgeId: string) => ['badges', badgeId, 'issued'] as const,
  /** Thông báo của chính người dùng. */
  notifications: ['notifications'] as const,
  /** Số thông báo chưa đọc của chính người dùng (huy hiệu trên chuông ở header). */
  notificationUnreadCount: ['notifications', 'unread-count'] as const,
  /** Gốc khoá danh sách nhóm thông báo — tiền tố cho setQueriesData/invalidate mọi biến thể lọc. */
  notificationGroupsRoot: ['notifications', 'groups'] as const,
  /** Một trang danh sách nhóm thông báo v2 theo bộ lọc (nhóm + chỉ chưa đọc). */
  notificationGroups: (group: string, unreadOnly: boolean) =>
    ['notifications', 'groups', group, unreadOnly] as const,
  /** Các mục phẳng của một dòng gộp thông báo (khi mở rộng dòng). */
  notificationGroupItems: (eventType: string, contextUrl: string, day: string) =>
    ['notifications', 'items', eventType, contextUrl, day] as const,
  /** Tuỳ chọn nhận tin nhắn/thông báo của chính người dùng (GET /messages/preferences). */
  messagePreferences: ['messages', 'preferences'] as const,
  /** Ghi đè thông báo theo khoá học của chính người dùng (GET /messages/preferences/courses, NB-4). */
  messageCourseOverrides: ['messages', 'preferences', 'courses'] as const,
  /**
   * Số conversation tin nhắn chưa đọc của chính người dùng (GET
   * /messages/unread-count) — nguồn của huy hiệu trên mục Tin nhắn ở
   * sidebar (lát M1, issue #204). Trang tin nhắn làm mới khoá này mỗi
   * lần tự đếm lại số chưa đọc từ kênh realtime của chính trang.
   */
  messageUnreadCount: ['messages', 'unread-count'] as const,
  /** Sự kiện lịch trong một khoảng ngày (ISO string đầu/cuối khoảng). */
  calendarEvents: (from: string, to: string) => ['calendar', 'events', from, to] as const,
  /** Gốc khoá lịch — tiền tố làm mới mọi truy vấn lịch sau đột biến. */
  calendar: ['calendar'] as const,
  /** Các đăng ký lịch ngoài của người dùng (GET /calendar/subscriptions). */
  calendarSubscriptions: ['calendar', 'subscriptions'] as const,
  /** Đường dẫn đăng ký xuất lịch của chính người dùng (GET /calendar/export-token). */
  calendarExportToken: ['calendar', 'export-token'] as const,
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
  /** Các con đang liên kết giám hộ với chính người dùng (GET /guardian-links/mine/students) — PH-1. */
  guardianMyStudents: ['guardian', 'my-students'] as const,
  /** Danh sách lớp mà người gọi có liên hệ (GET /classes) — CLASS-1, issue #184. */
  classes: ['classes'] as const,
  /** Gốc khoá lớp — tiền tố làm mới mọi truy vấn của một lớp sau đột biến. */
  classRoot: (classId: string) => ['classes', classId] as const,
  /** Chi tiết một lớp (GET /classes/:id). */
  classDetail: (classId: string) => ['classes', classId, 'detail'] as const,
  /** Roster của lớp (GET /classes/:id/roster). */
  classRoster: (classId: string) => ['classes', classId, 'roster'] as const,
  /** Học sinh đã đình chỉ của lớp (GET /classes/:id/roster/suspended). */
  classSuspended: (classId: string) => ['classes', classId, 'suspended'] as const,
  /** Khoá học trong lớp (GET /classes/:id/courses). */
  classCourses: (classId: string) => ['classes', classId, 'courses'] as const,
  /** Phân quyền tại lớp (GET /classes/:id/staff). */
  classStaff: (classId: string) => ['classes', classId, 'staff'] as const,
  /** Hàng chờ duyệt tự báo danh (GET /classes/:id/join-requests). */
  classJoinRequests: (classId: string) => ['classes', classId, 'join-requests'] as const,
  /** Tổng quan phụ huynh cho một con (GET /guardian/students/:id/overview) — PH-1. */
  guardianOverview: (studentId: string) => ['guardian', 'overview', studentId] as const,
  /** Kết quả đã công bố của một con (GET /guardian/students/:id/results) — PH-1. */
  guardianResults: (studentId: string) => ['guardian', 'results', studentId] as const,
  /** Tuỳ chọn tần suất digest của phụ huynh cho một con (GET/PUT /guardian/students/:id/digest-preference) — PH-2. */
  guardianDigestPreference: (studentId: string) => ['guardian', 'digest-preference', studentId] as const,
  /** Cấu hình site (GET /site-config) — gốc khoá, kiêm tiền tố làm mới cả audit sau đột biến. */
  siteConfig: ['site-config'] as const,
  /** Vết thay đổi cấu hình site gần nhất (GET /site-config/audit). */
  siteConfigAudit: ['site-config', 'audit'] as const,
};
