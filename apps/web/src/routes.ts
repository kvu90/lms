import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

/**
 * Bản đồ route của app (React Router framework mode): mọi trang đều nằm
 * dưới một layout không đường dẫn (routes/shell.tsx) tự chọn khung công
 * khai hay khung đã đăng nhập theo phiên — giữ đúng hành vi của router
 * cũ. Mỗi trang là một route module riêng để framework tự chia chunk
 * theo route; các trang nằm chung file nguồn (platform.tsx,
 * questions.tsx) được nối qua route module mỏng trong thư mục routes/.
 */
export default [
  layout('routes/shell.tsx', [
    index('routes/home-index.tsx'),
    route('health', 'pages/health.tsx'),
    route('login', 'pages/login.tsx'),
    route('oauth/callback', 'pages/oauth-callback.tsx'),
    route('profile', 'pages/profile.tsx'),
    // Khu Cài đặt cá nhân (issue #288): gốc chuyển hướng về mục đầu
    // (Bảo mật); ba mục có path riêng, điều hướng bằng menu trái
    // trong khung settings-shell — không dùng query định danh khu vực.
    route('settings', 'pages/settings-index.tsx'),
    route('settings/security', 'pages/settings-security.tsx'),
    route('settings/linked-accounts', 'pages/settings-linked-accounts.tsx'),
    route('settings/notifications', 'pages/settings-notifications.tsx'),
    route('admin/users', 'pages/admin-users.tsx'),
    route('admin/users/new', 'routes/admin-user-new.tsx'),
    route('admin/users/:userId/edit', 'routes/admin-user-edit.tsx'),
    route('admin/tenants', 'pages/admin-tenants.tsx'),
    route('admin/roles', 'pages/admin-roles.tsx'),
    // Quản lý liên kết giám hộ phụ huynh–học viên (gói kích hoạt phụ
    // huynh): trang chỉ dành cho người có capability guardian:manage
    // — mục điều hướng gác bằng cờ quyền phía web, mọi endpoint quản
    // lý tự gác lại ở API.
    route('admin/guardian-links', 'pages/admin-guardian-links.tsx'),
    route('admin/site-config', 'pages/admin-site-config.tsx'),
    route('admin/curriculum', 'routes/admin-curriculum.tsx'),
    route('admin/curriculum/subjects/new', 'routes/admin-curriculum-subject-new.tsx'),
    route('admin/curriculum/subjects/:subjectId/edit', 'routes/admin-curriculum-subject-edit.tsx'),
    route('admin/curriculum/subjects/:subjectId/curricula/new', 'routes/admin-curriculum-new.tsx'),
    route('admin/curriculum/curricula/:curriculumId', 'routes/admin-curriculum-tree.tsx'),
    route('admin/curriculum/curricula/:curriculumId/edit', 'routes/admin-curriculum-edit.tsx'),
    route('admin/curriculum/curricula/:curriculumId/nodes/new', 'routes/admin-curriculum-node-new.tsx'),
    route('admin/curriculum/nodes/:nodeId/edit', 'routes/admin-curriculum-node-edit.tsx'),
    route('admin/curriculum/nodes/:nodeId/outcomes/new', 'routes/admin-curriculum-outcome-new.tsx'),
    route('admin/curriculum/outcomes/:outcomeId/edit', 'routes/admin-curriculum-outcome-edit.tsx'),
    // Trang xem bảng chương trình GDPT theo mẫu Bộ cho GIÁO VIÊN
    // (issue #161, lát T2): chỉ xem, đọc qua ngữ cảnh khoá giáo viên dạy.
    route('curriculum', 'routes/teacher-curriculum.tsx'),
    route('courses', 'pages/courses.tsx'),
    route('courses/new', 'pages/course-new.tsx'),
    // Lớp học (CLASS-1, issue #184): danh sách/tạo màn riêng, tự báo
    // danh, chi tiết lớp (roster) và sửa lớp — 'new'/'join' khai trước
    // ':id' để không bị nuốt.
    route('classes', 'pages/classes.tsx'),
    route('classes/new', 'pages/class-new.tsx'),
    route('classes/join', 'pages/class-join.tsx'),
    route('classes/:id', 'pages/class-detail.tsx'),
    route('classes/:id/edit', 'pages/class-edit.tsx'),
    // Trang công khai mua gói học phí của lớp (CLASS-3, issue #184).
    route('classes/:id/public', 'pages/class-public.tsx'),
    route('courses/:id', 'pages/course.tsx'),
    route('courses/:id/builder', 'pages/course-builder.tsx'),
    route('courses/:id/learn/:cmId', 'pages/player.tsx'),
    route('courses/:id/progress', 'pages/progress-report.tsx'),
    route('courses/:id/admin', 'pages/course-admin.tsx'),
    route('courses/:id/grades', 'pages/grades.tsx'),
    route('courses/:id/exams/:pinId', 'pages/quiz.tsx'),
    route('courses/:id/assignments/:assignmentId', 'pages/assignment.tsx'),
    route('courses/:id/exams/:pinId/results', 'pages/quiz-results.tsx'),
    route('courses/:id/exams/:pinId/paper', 'pages/quiz-paper.tsx'),
    route('courses/:id/quizzes/:quizId', 'routes/legacy-quiz.tsx'),
    route('courses/:id/quizzes/:quizId/results', 'routes/legacy-quiz-results.tsx'),
    route('courses/:id/quizzes/:quizId/paper', 'routes/legacy-quiz-paper.tsx'),
    route('quiz-attempts/:attemptId', 'pages/quiz-attempt.tsx'),
    route('questions', 'routes/questions.tsx'),
    route('questions/stimuli', 'routes/question-stimuli.tsx'),
    route('questions/categories/new', 'routes/question-category-new.tsx'),
    route('questions/new', 'routes/question-new.tsx'),
    route('questions/:questionId/edit', 'routes/question-edit.tsx'),
    // Cụm ma trận đã tách khỏi cây /questions (chuẩn đường dẫn #221,
    // lát R1): path chính ở /matrices/*; hai path cũ giữ làm lớp
    // tương thích chuyển hướng thay thế (mục 3.5 của hồ sơ chuẩn).
    route('matrices', 'routes/matrices.tsx'),
    route('matrices/new', 'routes/question-matrix-new.tsx'),
    route('matrices/import', 'routes/matrix-import.tsx'),
    route('matrices/:matrixId/edit', 'routes/question-matrix-edit.tsx'),
    route('questions/matrices/new', 'routes/legacy-matrix-new.tsx'),
    route('questions/matrices/:matrixId/edit', 'routes/legacy-matrix-edit.tsx'),
    route('question-usages/:id', 'routes/question-usage.tsx'),
    // Cây Đề: tên tài nguyên chốt là "exams" (Lão gia chốt tối
    // 25/10/2026 — bỏ hậu tố "papers"); cây cũ /exam-papers* giữ làm
    // lớp tương thích chuyển hướng thay thế.
    route('exams', 'routes/exams.tsx'),
    route('exams/new', 'routes/exam-paper-new.tsx'),
    route('exams/:paperId/edit', 'routes/exam-paper-edit.tsx'),
    route('exam-papers', 'routes/legacy-exam-papers.tsx'),
    route('exam-papers/new', 'routes/legacy-exam-paper-new.tsx'),
    route('exam-papers/:paperId/edit', 'routes/legacy-exam-paper-edit.tsx'),
    // Ngân hàng hệ thống (chuẩn đường dẫn #221, lát R1): gốc chỉ
    // chuyển hướng tới Câu hỏi hệ thống; ba khu vực có path riêng.
    route('system-bank', 'routes/system-bank.tsx'),
    route('system-bank/questions', 'routes/system-bank-questions.tsx'),
    route('system-bank/exams', 'routes/system-bank-exams.tsx'),
    route('system-bank/papers', 'routes/legacy-system-bank-papers.tsx'),
    route('system-bank/matrices', 'routes/system-bank-matrices.tsx'),    route('messages', 'pages/messages.tsx'),
    route('notifications', 'pages/notifications.tsx'),
    route('guardian', 'pages/guardian.tsx'),
    // Khu vực phụ huynh theo từng con (chuẩn đường dẫn #221, lát
    // R2): đối tượng chính của khu vực (đứa con đang xem) nằm trong
    // path, không còn định danh bằng ?student=; link cũ dạng
    // /guardian?student=<id> được chính trang guardian chuyển hướng
    // thay thế sang path này (id không thuộc các con đang liên kết
    // thì về gốc /guardian).
    route('guardian/students/:studentId', 'routes/guardian-student.tsx'),
    route('calendar', 'pages/calendar.tsx'),
    route('badges', 'pages/badges.tsx'),
    route('learning-plan', 'pages/learning-plan.tsx'),
    route('search', 'routes/search.tsx'),
    route('tokens', 'routes/tokens.tsx'),
    route('backup', 'routes/backup.tsx'),
    route('insights', 'routes/insights.tsx'),
    route('reports', 'routes/reports.tsx'),
    // Kho học liệu (chuẩn đường dẫn #221, lát R3): tên tài nguyên
    // viết tách là /content-bank; cả ba path cũ viết dính giữ làm
    // lớp tương thích chuyển hướng thay thế sang path mới.
    route('content-bank', 'routes/contentbank.tsx'),
    route('content-bank/new', 'routes/contentbank-new.tsx'),
    route('content-bank/:id/edit', 'routes/contentbank-edit.tsx'),
    route('contentbank', 'routes/legacy-contentbank.tsx'),
    route('contentbank/new', 'routes/legacy-contentbank-new.tsx'),
    route('contentbank/:id/edit', 'routes/legacy-contentbank-edit.tsx'),
    route('privacy', 'routes/privacy.tsx'),
  ]),
  // Hai trang mỏng của luồng uỷ quyền MCP (lát MCP-1, issue #163):
  // nằm NGOÀI shell layout — chúng là loginPage/consentPage mà máy
  // chủ OAuth chuyển trình duyệt tới giữa luồng authorize, phải hiển
  // thị trần (không khung app, không bị guard của shell đá về /login).
  route('mcp-login', 'pages/mcp-login.tsx'),
  route('mcp-consent', 'pages/mcp-consent.tsx'),
] satisfies RouteConfig;
