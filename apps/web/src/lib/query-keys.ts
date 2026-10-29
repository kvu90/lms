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
  /** Kết quả tìm kiếm toàn cục theo từ khoá (GET /search — nhóm Nội dung của bề mặt tìm kiếm hợp nhất ở header). */
  globalSearch: (keyword: string) => ['global-search', keyword] as const,
  /** Danh sách toàn bộ khoá học (GET /courses). */
  courses: ['courses'] as const,
  /** Các phiên bản của một câu (GET /questions/:id/versions — trang questions). */
  questionVersions: (questionId: string) => ['questions', questionId, 'versions'] as const,
  /** Kết quả khám phá ngân hàng chung (GET /questions/discovery — trang questions). */
  questionDiscovery: (params: string) => ['questions', 'discovery', params] as const,
  /** Danh sách bank theo loại (GET /question-banks[?kind=] — trang questions; kind: 'question' | 'matrix' | 'exam'). */
  questionBanks: (kind: string) => ['question-banks', kind] as const,
  /** Ma trận của một bank (GET /question-banks/:id/matrices — trang questions). */
  bankMatrices: (bankId: string) => ['question-banks', bankId, 'matrices'] as const,
  /** Gói dữ liệu trang xây dựng khoá học (thông tin/nội dung/điểm mục/tiêu chí/nhóm — trang course-builder). */
  courseBuilder: (courseId: string) => ['courses', courseId, 'builder'] as const,
  /** Nội dung (outline) của một khoá (GET /courses/:id/content) — khối dùng lại nội dung ở trang builder. */
  courseContent: (courseId: string) => ['courses', courseId, 'content'] as const,
  /** Dữ liệu điểm hiển thị theo từng khoá (báo cáo điểm + điểm theo bài của tôi) — tải lười tại bề mặt tiêu thụ qua hook dùng chung `src/hooks/use-courses-grade-data.ts`. */
  courseAccess: (courseId: string) => ['course-access', courseId] as const,
  /** Gốc khu người dùng quản trị — tiền tố invalidate cho mọi query con (danh sách + chi tiết). */
  adminUsers: (page: number, pageSize: number, search = '') => ['admin', 'users', page, pageSize, search] as const,
  /** Cây danh mục khoá học cho khối quản trị. */
  categoryTree: ['courses', 'categories', 'tree'] as const,
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
  /** Thông báo của chính người dùng. */
  notifications: ['notifications'] as const,
  /** Số thông báo chưa đọc của chính người dùng (huy hiệu trên chuông ở header). */
  notificationUnreadCount: ['notifications', 'unread-count'] as const,
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
  /** Các tenant người dùng là thành viên (GET /auth/tenants) — mục chuyển không gian làm việc. */
  myTenants: ['auth', 'tenants'] as const,
  /** Các nhà cung cấp đăng nhập ngoài đang bật (GET /auth/oauth/providers) — dùng chung cho trang login và thẻ liên kết ở hồ sơ. */
  oauthProviders: ['auth', 'oauth', 'providers'] as const,
  /** Các liên kết đăng nhập ngoài của chính người dùng (GET /auth/oauth/links). */
  oauthLinks: ['auth', 'oauth', 'links'] as const,
  /** Các phiên đang hoạt động của chính người dùng (GET /auth/sessions). */
  mySessions: ['auth', 'sessions'] as const,
  /** Trạng thái MFA TOTP của chính người dùng (GET /auth/mfa/status). */
  mfaStatus: ['auth', 'mfa', 'status'] as const,
  /** Pref thẻ khoá của chính người dùng (GET /dashboard/course-cards) — DASH1. */
  courseCards: ['dashboard', 'course-cards'] as const,
  /** Các con đang liên kết giám hộ với chính người dùng (GET /guardian-links/mine/students) — PH-1. */
  guardianMyStudents: ['guardian', 'my-students'] as const,
  /** Danh sách lớp mà người gọi có liên hệ (GET /classes) — CLASS-1, issue #184. */
  classes: ['classes'] as const,
  /** Khoá học trong lớp (GET /classes/:id/courses). */
  classCourses: (classId: string) => ['classes', classId, 'courses'] as const,
  /** Danh sách môn học chương trình (GET /curriculum/subjects). */
  curriculumSubjects: ['curriculum', 'subjects'] as const,
  /** Gốc khoá chương trình — tiền tố làm mới mọi truy vấn chương trình sau đột biến quản trị. */
  curriculaRoot: ['curriculum', 'curricula'] as const,
  /** Gốc khoá cây chương trình — tiền tố làm mới mọi cây sau đột biến node/YCCĐ. */
  curriculumTreeRoot: ['curriculum', 'tree'] as const,
  /** Cây chương trình của một chương trình (GET /curriculum/curricula/:id/tree). */
  curriculumTree: (curriculumId: string) => ['curriculum', 'tree', curriculumId] as const,
  /**
   * Môn chương trình trong một context, kèm ngữ cảnh khoá mở quyền
   * đọc cho giáo viên (GET /curriculum/subjects?contextId=&forCourseId=)
   * — khác khoá `curriculumSubjects` của màn ma trận (không tham số).
   */
  curriculumSubjectsScoped: (contextId: string, forCourseId: string | null) =>
    ['curriculum', 'subjects', 'scoped', contextId, forCourseId] as const,
  /** Các chương trình của một môn kèm ngữ cảnh khoá (GET /curriculum/curricula?subjectId=&forCourseId=). */
  curriculumCurriculaScoped: (subjectId: string, forCourseId: string | null) =>
    ['curriculum', 'curricula', 'scoped', subjectId, forCourseId] as const,
  /** Cây chương trình kèm ngữ cảnh khoá (GET /curriculum/curricula/:id/tree?forCourseId=). */
  curriculumTreeScoped: (curriculumId: string, forCourseId: string | null) =>
    ['curriculum', 'tree', 'scoped', curriculumId, forCourseId] as const,
  /** Đơn vị khung chọn được của cặp (môn, khối) — suy từ curricula + cây qua tầng curriculum. */
  curriculumFrameUnits: (subjectId: string, grade: number, forCourseId: string | null) =>
    ['curriculum', 'frame-units', subjectId, grade, forCourseId] as const,
  /** Trạng thái các dataset chương trình chuẩn (GET /curriculum/program-import) — trang quản trị chương trình. */
  programDatasetStatus: ['curriculum', 'program-import'] as const,
  /** Trạng thái các dataset SGK (GET /books/dataset-import) — trang quản trị chương trình. */
  bookDatasetStatus: ['books', 'dataset-import'] as const,
  /** Danh sách SGK đã nạp (GET /books) — trang quản trị chương trình. */
  books: ['books'] as const,
  /** Gốc khoá SGK — tiền tố làm mới mọi truy vấn sách (danh sách + cây) sau đột biến nạp dataset. */
  booksRoot: ['books'] as const,
  /** Cây của một cuốn SGK (GET /books/:id/tree) — trang quản trị chương trình. */
  bookTree: (bookId: string) => ['books', bookId, 'tree'] as const,
  /** Đơn vị khung SGK chọn được của cặp (môn, khối) kèm ngữ cảnh khoá — panel nạp khung SGK. */
  bookFrameChapters: (subjectId: string, grade: number, forCourseId: string | null) =>
    ['books', 'frame-chapters', subjectId, grade, forCourseId] as const,
  /** Một môn chương trình theo id (GET /curriculum/subjects/:id) — màn sửa môn. */
  curriculumSubjectRow: (subjectId: string) => ['curriculum', 'subjects', 'row', subjectId] as const,
  /** Một chương trình theo id (GET /curriculum/curricula/:id) — màn sửa chương trình. */
  curriculumRow: (curriculumId: string) => ['curriculum', 'curricula', 'row', curriculumId] as const,
  /** Một node chương trình theo id (GET /curriculum/nodes/:id) — màn sửa node/YCCĐ. */
  curriculumNode: (nodeId: string) => ['curriculum', 'nodes', nodeId] as const,
  /** Một YCCĐ theo id (GET /curriculum/outcomes/:id) — màn sửa YCCĐ. */
  curriculumOutcome: (outcomeId: string) => ['curriculum', 'outcomes', outcomeId] as const,
  /** Chi tiết một khoá học (GET /courses/:id) — trang quản trị khoá (chế độ nhóm). */
  courseDetail: (courseId: string) => ['courses', courseId, 'detail'] as const,
  /** Hội thoại chat toàn lớp của một khoá (GET /messages/courses/:id/conversation) — trang quản trị khoá. */
  courseConversation: (courseId: string) => ['messages', 'courses', courseId, 'conversation'] as const,
};
