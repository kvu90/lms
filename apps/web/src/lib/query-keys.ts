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
  /** Kết quả + hàng đợi chấm tay của một quiz (trang quiz-results). */
  /** Gói dữ liệu trang một khoá học (thông tin/instance/ghi danh/nội dung/tiến độ — trang course). */
  /** Cây danh mục câu hỏi (GET /questions/categories — trang questions). */
  /** Câu hỏi của một danh mục (GET /questions/categories/:id/questions — trang questions). */
  /** Ngữ liệu của một danh mục (GET /stimuli?categoryId= — trang questions). */
  /** Dòng ghi công của một câu copy (GET /questions/:id/attribution — trang questions). */
  /** Các phiên bản của một câu (GET /questions/:id/versions — trang questions). */
  questionVersions: (questionId: string) => ['questions', questionId, 'versions'] as const,
  /** Chi tiết một câu (GET /questions/:id — xem trước ở trang questions). */
  /** Kết quả khám phá ngân hàng chung (GET /questions/discovery — trang questions). */
  questionDiscovery: (params: string) => ['questions', 'discovery', params] as const,
  /** Danh sách bank theo loại (GET /question-banks[?kind=] — trang questions; kind: 'question' | 'matrix' | 'exam'). */
  questionBanks: (kind: string) => ['question-banks', kind] as const,
  /** Gốc khoá bank câu hỏi — tiền tố để xoá/làm mới mọi danh sách bank ba loại. */
  /** Mọi câu hỏi trong bank cá nhân, gộp theo từng danh mục của bank (trang questions). */
  /** Ma trận của một bank (GET /question-banks/:id/matrices — trang questions). */
  bankMatrices: (bankId: string) => ['question-banks', bankId, 'matrices'] as const,
  /** Hàng chờ đóng góp ma trận của một bank (trang questions). */
  /** Hàng chờ đóng góp câu hỏi của một bank (trang questions). */
  /** Đề của một bank đề (GET /exams/banks/:id/exams — trang questions). */
  /** Hàng chờ đóng góp đề của một bank đề (trang questions). */
  /** Hàng chờ bộ hồ sơ của một bank đề (trang questions). */
  /** Mọi bộ hồ sơ của chính giáo viên (GET /exams/dossiers/mine — trang questions). */
  /** Trang lần ghim đề (GET /exam-pins/:id + tên câu của các slot — trang quiz). */
  /** Ghi đè của lần ghim (GET /exam-pins/:id/overrides — trang quiz). */
  /** Thông tin đề nguồn của lần ghim (GET /exams/:id — trang quiz). */
  /** Danh sách thành viên khoá cho bộ chọn đích ghi đè (GET /messages/courses/:id/members — trang quiz). */
  /** Gói dữ liệu trang xây dựng khoá học (thông tin/nội dung/điểm mục/tiêu chí/nhóm — trang course-builder). */
  courseBuilder: (courseId: string) => ['courses', courseId, 'builder'] as const,
  /** Nội dung (outline) của một khoá (GET /courses/:id/content) — khối dùng lại nội dung ở trang builder. */
  courseContent: (courseId: string) => ['courses', courseId, 'content'] as const,
  /** Thanh toán của chính người dùng (GET /payments/me). */
  /** Chi tiết một thanh toán theo id (GET /payments/:id) — trang lớp công khai poll trạng thái. */
  /** Chi tiết một bài tập nộp tệp (trang assignment). */
  /** Dữ liệu điểm hiển thị theo từng khoá (báo cáo điểm + điểm theo bài của tôi) — tải lười tại bề mặt tiêu thụ qua hook dùng chung `src/hooks/use-courses-grade-data.ts`. */
  courseAccess: (courseId: string) => ['course-access', courseId] as const,
  /** Danh sách người dùng cho khối quản trị (phân trang + tìm kiếm phía server). */
  /** Gốc khu người dùng quản trị — tiền tố invalidate cho mọi query con (danh sách + chi tiết). */
  adminUsers: (page: number, pageSize: number, search = '') => ['admin', 'users', page, pageSize, search] as const,
  /** Chi tiết một người dùng ở khu quản trị (F-05, rà soát #133). */
  /** Gốc khu quản trị tenant — tiền tố làm mới mọi truy vấn tenant sau đột biến. */
  /** Danh sách tenant toàn hệ thống cho chế độ platform (GET /tenants). */
  /** Tenant hiệu lực cho chế độ chủ trung tâm (GET /tenants/current). */
  /** Membership của một tenant (GET /tenants/:tenantId/members). */
  /** Hồ sơ người dùng thuộc một tenant (GET /tenants/:tenantId/users). */
  /** Cây danh mục khoá học cho khối quản trị. */
  categoryTree: ['courses', 'categories', 'tree'] as const,
  /** Tiến độ học của chính người dùng trong một khoá (% hoàn thành; probe lỗi → null). */
  /** Báo cáo tiến độ lớp của một khoá theo nhóm lọc (trang progress-report; probe lỗi → null = không có quyền). */
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
  /** Toàn bộ huy hiệu (GET /badges) — panel quản trị + tra tên dự phòng. */
  /** Danh sách đã cấp của một huy hiệu (GET /badges/:id/issued). */
  /** Thông báo của chính người dùng. */
  notifications: ['notifications'] as const,
  /** Số thông báo chưa đọc của chính người dùng (huy hiệu trên chuông ở header). */
  notificationUnreadCount: ['notifications', 'unread-count'] as const,
  /** Gốc khoá danh sách nhóm thông báo — tiền tố cho setQueriesData/invalidate mọi biến thể lọc. */
  /** Một trang danh sách nhóm thông báo v2 theo bộ lọc (nhóm + chỉ chưa đọc). */
  /** Các mục phẳng của một dòng gộp thông báo (khi mở rộng dòng). */
  /** Tuỳ chọn nhận tin nhắn/thông báo của chính người dùng (GET /messages/preferences). */
  /** Ghi đè thông báo theo khoá học của chính người dùng (GET /messages/preferences/courses, NB-4). */
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
  /** Đường dẫn đăng ký xuất lịch của chính người dùng (GET /calendar/export-token). */
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
  /** Khối tổng hợp dashboard việc cần làm (GET /dashboard/overview) — DASH1. */
  /** Pref thẻ khoá của chính người dùng (GET /dashboard/course-cards) — DASH1. */
  courseCards: ['dashboard', 'course-cards'] as const,
  /** Các con đang liên kết giám hộ với chính người dùng (GET /guardian-links/mine/students) — PH-1. */
  guardianMyStudents: ['guardian', 'my-students'] as const,
  /** Danh sách liên kết giám hộ cho bề mặt quản lý của người có guardian:manage (GET /guardian-links). */
  /** Danh sách lớp mà người gọi có liên hệ (GET /classes) — CLASS-1, issue #184. */
  classes: ['classes'] as const,
  /** Gốc khoá lớp — tiền tố làm mới mọi truy vấn của một lớp sau đột biến. */
  /** Chi tiết một lớp (GET /classes/:id). */
  /** Gói tổng quan dashboard theo lớp (GET /classes/:id/overview) — CLASS-2, issue #184. */
  /** Gói công khai của lớp cho người chưa ghi danh (GET /classes/:id/public) — CLASS-3, issue #184. */
  /** Roster của lớp (GET /classes/:id/roster). */
  /** Học sinh đã đình chỉ của lớp (GET /classes/:id/roster/suspended). */
  /** Khoá học trong lớp (GET /classes/:id/courses). */
  classCourses: (classId: string) => ['classes', classId, 'courses'] as const,
  /** Phân quyền tại lớp (GET /classes/:id/staff). */
  /** Hàng chờ duyệt tự báo danh (GET /classes/:id/join-requests). */
  /** Tổng quan phụ huynh cho một con (GET /guardian/students/:id/overview) — PH-1. */
  /** Kết quả đã công bố của một con (GET /guardian/students/:id/results) — PH-1. */
  /** Tuỳ chọn tần suất digest của phụ huynh cho một con (GET/PUT /guardian/students/:id/digest-preference) — PH-2. */
  /** Danh sách ngân hàng theo loại (GET /question-banks?kind=…) — trang ma trận dùng kind=matrix. */
  /** Danh sách môn học chương trình (GET /curriculum/subjects). */
  curriculumSubjects: ['curriculum', 'subjects'] as const,
  /** Các chương trình của một môn (GET /curriculum/curricula?subjectId=…). */
  /** Gốc khoá chương trình — tiền tố làm mới mọi truy vấn chương trình sau đột biến quản trị. */
  curriculaRoot: ['curriculum', 'curricula'] as const,
  /** Gốc khoá cây chương trình — tiền tố làm mới mọi cây sau đột biến node/YCCĐ. */
  curriculumTreeRoot: ['curriculum', 'tree'] as const,
  /** Cây chương trình của một chương trình (GET /curriculum/curricula/:id/tree). */
  curriculumTree: (curriculumId: string) => ['curriculum', 'tree', curriculumId] as const,
  /** Chi tiết một ma trận đề (GET /exam-matrices/:id). */
  /** Khả dụng kho câu cho các ô của một ma trận (GET /exam-matrices/:id/availability). */
  /** Bản đặc tả SUY RA của một ma trận (GET /exam-matrices/:id/specification) — SPEC-1, issue #233. */
  /** Cấu hình site (GET /site-config) — gốc khoá, kiêm tiền tố làm mới cả audit sau đột biến. */
  /** Vết thay đổi cấu hình site gần nhất (GET /site-config/audit). */
  /** Insight phân tích của chính người dùng (GET /analytics/insights/me) — trang insights nền tảng. */
  /** Yêu cầu quyền riêng tư (GET /privacy/requests) — trang privacy nền tảng. */
  /** Việc sao lưu/khôi phục (GET /backup/jobs) — trang backup nền tảng. */
  /** Các bước của một việc sao lưu (GET /backup/jobs/:id/steps) — trang backup nền tảng. */
  /** Dịch vụ webservice (GET /webservice/services) — trang tokens nền tảng. */
  /** Token tích hợp (GET /webservice/tokens) — trang tokens nền tảng. */
  /** Báo cáo tự dựng (GET /reports) — trang reports nền tảng. */
  /** Kết quả chạy một báo cáo (GET /reports/:id/run) — trang reports nền tảng. */
  /** Kế hoạch học tập của một người dùng (GET /competencies/plans/user/:userId) — trang learning-plan. */
  /** Chi tiết một kế hoạch học tập (GET /competencies/plans/:id) — trang learning-plan. */
  /** Danh sách framework năng lực (GET /competencies/frameworks) — khu quản trị năng lực của trang learning-plan. */
  /** Danh sách mẫu kế hoạch học tập (GET /competencies/templates) — khu quản trị năng lực. */
  /** Cây năng lực của một framework (GET /competencies/frameworks/:id/competencies) — khu quản trị năng lực. */
  /** Tài liệu xuất của một framework (GET /competencies/frameworks/:id/export) — khu quản trị năng lực. */
  /** Năng lực của một người dùng (GET /competencies/usercomp/user/:userId) — hàng đợi duyệt của khu quản trị năng lực. */
  /** Danh sách người dùng rút gọn cho ô chọn của hàng đợi duyệt (GET /users?page=1&pageSize=50). */
  /** Lô in phiếu của một lần ghim (GET /exam-batches?pinId=) — trang chấm bài giấy. */
  /** Phiếu đã quét của một lần ghim (GET /exam-scans?pinId=) — trang chấm bài giấy. */
  /** View một lượt làm quiz (GET /quiz-attempts/:id) — trang làm bài/xem lại. */
  /** Danh sách mẫu khoá học (GET /courses/templates) — wizard tạo khoá. */
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
  /**
   * Chi tiết trọn vẹn một đề cho màn soạn (GET /exams/:id) — khác
   * khoá `examSource` của trang lần ghim (cùng endpoint nhưng chỉ
   * lấy phần thông tin nguồn, hình dạng cache khác hẳn).
   */
  /** Các lần ghim của một đề (GET /exams/:id/pins) — màn soạn đề. */
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
  /** Các grouping của một khoá (GET /courses/:id/groupings) — trang quản trị khoá. */
  /** Các nhóm trong một grouping (GET /courses/:id/groupings/:id/groups) — trang quản trị khoá. */
  /** Thành viên của một nhóm khoá (GET /courses/:id/groups/:id/members) — trang quản trị khoá. */
  /** Danh sách cohort (GET /cohorts) — trang quản trị khoá. */
  /** Thành viên của một cohort (GET /cohorts/:id/members) — trang quản trị khoá. */
  /** Các instance ghi danh của một khoá (GET /courses/:id/enrol/instances) — trang quản trị khoá. */
  /** Các ghi danh của một khoá (GET /courses/:id/enrolments) — trang quản trị khoá. */
  /** Tiến độ hoàn thành của một khoá (GET /courses/:id/completion) — trang quản trị khoá. */
  /** Hội thoại chat toàn lớp của một khoá (GET /messages/courses/:id/conversation) — trang quản trị khoá. */
  courseConversation: (courseId: string) => ['messages', 'courses', courseId, 'conversation'] as const,
  /** Lịch sử điểm của một học viên trên một mục điểm (GET /grade-items/:id/users/:userId/history) — trang bảng điểm. */
  /** Nhật ký chấm lại của một lần ghim (GET /exam-pins/:id/regrades) — trang lần ghim. */
  /** Lịch sử chấm lại của chính người xem trên một lần ghim (GET /exam-pins/:id/my-regrades) — trang lần ghim. */
  /** Xem trước cập nhật version của một lần ghim (GET /exam-pins/:id/version-update) — trang lần ghim. */
  /** Gắn kết chương trình của một câu hỏi (GET /questions/:id/curriculum-links) — trình soạn câu hỏi. */
  /** Bản đặc tả đã chụp của một bộ hồ sơ đề (GET /exams/dossiers/:id/specification) — trang ngân hàng. */
  /** Một lượt dùng câu hỏi (GET /question-usages/:id) — trang làm thử câu hỏi. */
  /** Một ngữ liệu theo id (GET /stimuli/:id) — trang làm thử (nội dung của phiên bản đã ghim). */
  /** URL hiển thị đã ký của một tệp câu hỏi theo định danh bền (màn soạn câu hỏi). */
  /** Cây nhóm của tab Nhóm (GET /messages/group-tree) — trang tin nhắn. */
  /** Danh sách hội thoại chính (GET /messages/conversations) — trang tin nhắn. */
  /** Danh sách hội thoại đã lưu (GET /messages/conversations?archived=true) — trang tin nhắn. */
  /** Danh sách người đã chặn (GET /messages/contacts/blocked) — trang tin nhắn. */
  /** Danh bạ đã duyệt (GET /messages/contacts) — trang tin nhắn. */
  /** Hàng chờ kết bạn (GET /messages/contacts/requests) — trang tin nhắn. */
  /** Các khoá của người xem (GET /messages/courses) — trang tin nhắn. */
  /** Chi tiết một hội thoại (GET /messages/conversations/:id) — trang tin nhắn. */
  /** Một cửa sổ tin theo mốc seq (GET /messages/conversations/:id/messages?beforeSeq=) — trang tin nhắn. */
  /** Kết quả tìm nội dung trong một hội thoại (GET /messages/conversations/:id/search) — trang tin nhắn. */
  /** Một trang roster lớp/khoá theo URL đầy đủ — trang tin nhắn (panel thành viên + bộ chọn người). */
  /** Chat cấp lớp được ensure (GET /messages/classes/:id/conversation) — trang tin nhắn. */
  /** Danh sách bài nộp của một bài tập (GET /assignments/:id/submissions) — panel giáo viên. */
  /** Chi tiết một bài nộp (GET /assignments/:id/submissions/:userId) — panel chấm. */
  /** Ngân hàng câu nhận xét mẫu của giáo viên (GET /assign-comment-bank) — panel chấm. */
  /** Người dùng hiện tại rút gọn (GET /users/me) — panel học sinh của bài tập. */
  /** Không gian kho học liệu (GET /contentbank/spaces) — trang kho học liệu + màn tạo/sửa học liệu. */
  /** Toàn bộ học liệu thuộc các không gian người xem thấy (GET /contentbank) — trang kho học liệu. */
  /** Chi tiết một học liệu (GET /contentbank/:id) — màn sửa học liệu. */
  /** URL tải tệp đã ký của một học liệu (GET /contentbank/:id/file-url) — trang kho học liệu. */
  /** Môn học trong context hệ thống cho bộ lọc của kho học liệu (chuỗi GET /access/contexts → GET /curriculum/subjects) — trang kho + màn tạo/sửa. */
  /** Danh mục câu hỏi trong context hệ thống (chuỗi GET /access/contexts → GET /questions/categories?contextId=) — màn tạo/sửa học liệu loại bộ câu hỏi. */
  /** Node chương trình đã phẳng hoá theo môn + khối (chuỗi GET /curriculum/curricula → GET /curriculum/curricula/:id/tree) — màn tạo/sửa học liệu. */





















};
