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
  /** Kết quả + hàng đợi chấm tay của một quiz (trang quiz-results). */
  quizResults: (quizId: string) => ['quizzes', quizId, 'results'] as const,
  /** Gói dữ liệu trang một khoá học (thông tin/instance/ghi danh/nội dung/tiến độ — trang course). */
  coursePage: (courseId: string) => ['courses', courseId, 'page'] as const,
  playerView: (courseId: string, cmId: string) => ['courses', courseId, 'player', cmId] as const,
  /** Cây danh mục câu hỏi (GET /questions/categories — trang questions). */
  questionCategories: ['questions', 'categories'] as const,
  /** Câu hỏi của một danh mục (GET /questions/categories/:id/questions — trang questions). */
  categoryQuestions: (categoryId: string) => ['questions', 'categories', categoryId, 'questions'] as const,
  /** Ngữ liệu của một danh mục (GET /stimuli?categoryId= — trang questions). */
  categoryStimuli: (categoryId: string) => ['stimuli', 'by-category', categoryId] as const,
  /** Dòng ghi công của một câu copy (GET /questions/:id/attribution — trang questions). */
  questionAttribution: (questionId: string) => ['questions', questionId, 'attribution'] as const,
  /** Các phiên bản của một câu (GET /questions/:id/versions — trang questions). */
  questionVersions: (questionId: string) => ['questions', questionId, 'versions'] as const,
  /** Chi tiết một câu (GET /questions/:id — xem trước ở trang questions). */
  questionDetail: (questionId: string) => ['questions', questionId, 'detail'] as const,
  /** Kết quả khám phá ngân hàng chung (GET /questions/discovery — trang questions). */
  questionDiscovery: (params: string) => ['questions', 'discovery', params] as const,
  /** Danh sách bank theo loại (GET /question-banks[?kind=] — trang questions; kind: 'question' | 'matrix' | 'exam'). */
  questionBanks: (kind: string) => ['question-banks', kind] as const,
  /** Mọi câu hỏi trong bank cá nhân, gộp theo từng danh mục của bank (trang questions). */
  myBankQuestions: (bankId: string) => ['question-banks', bankId, 'all-questions'] as const,
  /** Ma trận của một bank (GET /question-banks/:id/matrices — trang questions). */
  bankMatrices: (bankId: string) => ['question-banks', bankId, 'matrices'] as const,
  /** Hàng chờ đóng góp ma trận của một bank (trang questions). */
  bankMatrixContributions: (bankId: string) => ['question-banks', bankId, 'matrix-contributions'] as const,
  /** Hàng chờ đóng góp câu hỏi của một bank (trang questions). */
  bankQuestionContributions: (bankId: string) => ['question-banks', bankId, 'contributions'] as const,
  /** Đề của một bank đề (GET /exams/banks/:id/exams — trang questions). */
  bankExams: (bankId: string) => ['exam-banks', bankId, 'exams'] as const,
  /** Hàng chờ đóng góp đề của một bank đề (trang questions). */
  bankExamContributions: (bankId: string) => ['exam-banks', bankId, 'contributions'] as const,
  /** Hàng chờ bộ hồ sơ của một bank đề (trang questions). */
  bankDossiers: (bankId: string) => ['exam-banks', bankId, 'dossiers'] as const,
  /** Mọi bộ hồ sơ của chính giáo viên (GET /exams/dossiers/mine — trang questions). */
  myDossiers: ['exams', 'dossiers', 'mine'] as const,
  /** Trang lần ghim đề (GET /exam-pins/:id + tên câu của các slot — trang quiz). */
  examPin: (pinId: string) => ['exam-pins', pinId] as const,
  /** Ghi đè của lần ghim (GET /exam-pins/:id/overrides — trang quiz). */
  examPinOverrides: (pinId: string) => ['exam-pins', pinId, 'overrides'] as const,
  /** Thông tin đề nguồn của lần ghim (GET /exams/:id — trang quiz). */
  examSource: (examId: string) => ['exams', examId] as const,
  /** Danh sách thành viên khoá cho bộ chọn đích ghi đè (GET /messages/courses/:id/members — trang quiz). */
  courseRosterMembers: (courseId: string) => ['courses', courseId, 'roster-members'] as const,
  /** Gói dữ liệu trang xây dựng khoá học (thông tin/nội dung/điểm mục/tiêu chí/nhóm — trang course-builder). */
  courseBuilder: (courseId: string) => ['courses', courseId, 'builder'] as const,
  /** Nội dung (outline) của một khoá (GET /courses/:id/content) — khối dùng lại nội dung ở trang builder. */
  courseContent: (courseId: string) => ['courses', courseId, 'content'] as const,
  /** Thanh toán của chính người dùng (GET /payments/me). */
  myPayments: ['payments', 'me'] as const,
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
  /** Gói tổng quan dashboard theo lớp (GET /classes/:id/overview) — CLASS-2, issue #184. */
  classOverview: (classId: string) => ['classes', classId, 'overview'] as const,
  /** Gói công khai của lớp cho người chưa ghi danh (GET /classes/:id/public) — CLASS-3, issue #184. */
  classPublic: (classId: string) => ['classes', classId, 'public'] as const,
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
  /** Danh sách ngân hàng theo loại (GET /question-banks?kind=…) — trang ma trận dùng kind=matrix. */
  questionBanksByKind: (kind: string) => ['question-banks', kind] as const,
  /** Danh sách môn học chương trình (GET /curriculum/subjects). */
  curriculumSubjects: ['curriculum', 'subjects'] as const,
  /** Các chương trình của một môn (GET /curriculum/curricula?subjectId=…). */
  curriculaBySubject: (subjectId: string) => ['curriculum', 'curricula', subjectId] as const,
  /** Cây chương trình của một chương trình (GET /curriculum/curricula/:id/tree). */
  curriculumTree: (curriculumId: string) => ['curriculum', 'tree', curriculumId] as const,
  /** Chi tiết một ma trận đề (GET /exam-matrices/:id). */
  matrixDetail: (matrixId: string) => ['exam-matrices', matrixId] as const,
  /** Khả dụng kho câu cho các ô của một ma trận (GET /exam-matrices/:id/availability). */
  matrixAvailability: (matrixId: string) => ['exam-matrices', matrixId, 'availability'] as const,
  /** Bản đặc tả SUY RA của một ma trận (GET /exam-matrices/:id/specification) — SPEC-1, issue #233. */
  matrixSpecification: (matrixId: string) => ['exam-matrices', matrixId, 'specification'] as const,
  /** Cấu hình site (GET /site-config) — gốc khoá, kiêm tiền tố làm mới cả audit sau đột biến. */
  siteConfig: ['site-config'] as const,
  /** Vết thay đổi cấu hình site gần nhất (GET /site-config/audit). */
  siteConfigAudit: ['site-config', 'audit'] as const,
  /** Insight phân tích của chính người dùng (GET /analytics/insights/me) — trang insights nền tảng. */
  myInsights: ['analytics', 'insights', 'me'] as const,
  /** Yêu cầu quyền riêng tư (GET /privacy/requests) — trang privacy nền tảng. */
  privacyRequests: ['privacy', 'requests'] as const,
  /** Việc sao lưu/khôi phục (GET /backup/jobs) — trang backup nền tảng. */
  backupJobs: ['backup', 'jobs'] as const,
  /** Các bước của một việc sao lưu (GET /backup/jobs/:id/steps) — trang backup nền tảng. */
  backupSteps: (jobId: string) => ['backup', 'jobs', jobId, 'steps'] as const,
  /** Dịch vụ webservice (GET /webservice/services) — trang tokens nền tảng. */
  webserviceServices: ['webservice', 'services'] as const,
  /** Token tích hợp (GET /webservice/tokens) — trang tokens nền tảng. */
  webserviceTokens: ['webservice', 'tokens'] as const,
  /** Báo cáo tự dựng (GET /reports) — trang reports nền tảng. */
  platformReports: ['reports'] as const,
  /** Kết quả chạy một báo cáo (GET /reports/:id/run) — trang reports nền tảng. */
  reportRun: (reportId: string) => ['reports', reportId, 'run'] as const,
  /** Kế hoạch học tập của một người dùng (GET /competencies/plans/user/:userId) — trang learning-plan. */
  userLearningPlans: (userId: string) => ['competencies', 'plans', 'user', userId] as const,
  /** Chi tiết một kế hoạch học tập (GET /competencies/plans/:id) — trang learning-plan. */
  learningPlanDetail: (planId: string) => ['competencies', 'plans', planId] as const,
  /** Lô in phiếu của một lần ghim (GET /exam-batches?pinId=) — trang chấm bài giấy. */
  examBatches: (pinId: string) => ['exam-batches', pinId] as const,
  /** Phiếu đã quét của một lần ghim (GET /exam-scans?pinId=) — trang chấm bài giấy. */
  examScans: (pinId: string) => ['exam-scans', pinId] as const,
  /** View một lượt làm quiz (GET /quiz-attempts/:id) — trang làm bài/xem lại. */
  quizAttempt: (attemptId: string) => ['quiz-attempts', attemptId] as const,
  /** Danh sách mẫu khoá học (GET /courses/templates) — wizard tạo khoá. */
  courseTemplates: ['courses', 'templates'] as const,
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
  examPaperDetail: (paperId: string) => ['exam-papers', paperId] as const,
  /** Các lần ghim của một đề (GET /exams/:id/pins) — màn soạn đề. */
  examPaperPins: (paperId: string) => ['exam-papers', paperId, 'pins'] as const,
  /** Trạng thái các dataset chương trình chuẩn (GET /curriculum/program-import) — trang quản trị chương trình. */
  programDatasetStatus: ['curriculum', 'program-import'] as const,
  /** Trạng thái các dataset SGK (GET /books/dataset-import) — trang quản trị chương trình. */
  bookDatasetStatus: ['books', 'dataset-import'] as const,
  /** Danh sách SGK đã nạp (GET /books) — trang quản trị chương trình. */
  books: ['books'] as const,
  /** Cây của một cuốn SGK (GET /books/:id/tree) — trang quản trị chương trình. */
  bookTree: (bookId: string) => ['books', bookId, 'tree'] as const,
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
  courseGroupings: (courseId: string) => ['courses', courseId, 'groupings'] as const,
  /** Các nhóm trong một grouping (GET /courses/:id/groupings/:id/groups) — trang quản trị khoá. */
  courseGroupingGroups: (courseId: string, groupingId: string) =>
    ['courses', courseId, 'groupings', groupingId, 'groups'] as const,
  /** Thành viên của một nhóm khoá (GET /courses/:id/groups/:id/members) — trang quản trị khoá. */
  courseGroupMembers: (courseId: string, groupId: string) =>
    ['courses', courseId, 'groups', groupId, 'members'] as const,
  /** Danh sách cohort (GET /cohorts) — trang quản trị khoá. */
  cohorts: ['cohorts'] as const,
  /** Thành viên của một cohort (GET /cohorts/:id/members) — trang quản trị khoá. */
  cohortMembers: (cohortId: string) => ['cohorts', cohortId, 'members'] as const,
  /** Các instance ghi danh của một khoá (GET /courses/:id/enrol/instances) — trang quản trị khoá. */
  courseEnrolInstances: (courseId: string) => ['courses', courseId, 'enrol-instances'] as const,
  /** Các ghi danh của một khoá (GET /courses/:id/enrolments) — trang quản trị khoá. */
  courseEnrolments: (courseId: string) => ['courses', courseId, 'enrolments'] as const,
  /** Tiến độ hoàn thành của một khoá (GET /courses/:id/completion) — trang quản trị khoá. */
  courseCompletions: (courseId: string) => ['courses', courseId, 'completion'] as const,
  /** Hội thoại chat toàn lớp của một khoá (GET /messages/courses/:id/conversation) — trang quản trị khoá. */
  courseConversation: (courseId: string) => ['messages', 'courses', courseId, 'conversation'] as const,
  /** Lịch sử điểm của một học viên trên một mục điểm (GET /courses/grades/items/:id/users/:userId/history) — trang bảng điểm. */
  gradeItemHistory: (itemId: string, userId: string) =>
    ['grades', 'items', itemId, 'users', userId, 'history'] as const,
  /** Nhật ký chấm lại của một lần ghim (GET /exam-pins/:id/regrades) — trang lần ghim. */
  examPinRegrades: (pinId: string) => ['exam-pins', pinId, 'regrades'] as const,
  /** Lịch sử chấm lại của chính người xem trên một lần ghim (GET /exam-pins/:id/my-regrades) — trang lần ghim. */
  examPinMyRegrades: (pinId: string) => ['exam-pins', pinId, 'my-regrades'] as const,
  /** Xem trước cập nhật version của một lần ghim (GET /exam-pins/:id/version-update) — trang lần ghim. */
  examPinVersionUpdate: (pinId: string) => ['exam-pins', pinId, 'version-update'] as const,
  /** Gắn kết chương trình của một câu hỏi (GET /questions/:id/curriculum-links) — trình soạn câu hỏi. */
  questionCurriculumLinks: (questionId: string) => ['questions', questionId, 'curriculum-links'] as const,
  /** Bản đặc tả đã chụp của một bộ hồ sơ đề (GET /exams/dossiers/:id/specification) — trang ngân hàng. */
  examDossierSpec: (dossierId: string) => ['exams', 'dossiers', dossierId, 'specification'] as const,
  /** Một lượt dùng câu hỏi (GET /question-usages/:id) — trang làm thử câu hỏi. */
  questionUsage: (usageId: string) => ['question-usages', usageId] as const,
  /** Một ngữ liệu theo id (GET /stimuli/:id) — trang làm thử (nội dung của phiên bản đã ghim). */
  stimulusDetail: (stimulusId: string) => ['stimuli', stimulusId] as const,
};
