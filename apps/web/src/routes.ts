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
    route('admin/users', 'pages/admin-users.tsx'),
    route('admin/users/new', 'routes/admin-user-new.tsx'),
    route('admin/users/:userId/edit', 'routes/admin-user-edit.tsx'),
    route('admin/roles', 'pages/admin-roles.tsx'),
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
    route('courses', 'pages/courses.tsx'),
    route('courses/new', 'pages/course-new.tsx'),
    route('courses/:id', 'pages/course.tsx'),
    route('courses/:id/builder', 'pages/course-builder.tsx'),
    route('courses/:id/learn/:cmId', 'pages/player.tsx'),
    route('courses/:id/progress', 'pages/progress-report.tsx'),
    route('courses/:id/admin', 'pages/course-admin.tsx'),
    route('courses/:id/grades', 'pages/grades.tsx'),
    route('courses/:id/quizzes/:quizId', 'pages/quiz.tsx'),
    route('courses/:id/assignments/:assignmentId', 'pages/assignment.tsx'),
    route('courses/:id/quizzes/:quizId/results', 'pages/quiz-results.tsx'),
    route('courses/:id/quizzes/:quizId/paper', 'pages/quiz-paper.tsx'),
    route('quiz-attempts/:attemptId', 'pages/quiz-attempt.tsx'),
    route('questions', 'routes/questions.tsx'),
    route('questions/categories/new', 'routes/question-category-new.tsx'),
    route('questions/new', 'routes/question-new.tsx'),
    route('questions/:questionId/edit', 'routes/question-edit.tsx'),
    route('questions/matrices/new', 'routes/question-matrix-new.tsx'),
    route('questions/matrices/:matrixId/edit', 'routes/question-matrix-edit.tsx'),
    route('question-usages/:id', 'routes/question-usage.tsx'),
    route('exam-papers/new', 'routes/exam-paper-new.tsx'),
    route('exam-papers/:paperId/edit', 'routes/exam-paper-edit.tsx'),
    route('messages', 'pages/messages.tsx'),
    route('notifications', 'pages/notifications.tsx'),
    route('guardian', 'pages/guardian.tsx'),
    route('calendar', 'pages/calendar.tsx'),
    route('badges', 'pages/badges.tsx'),
    route('learning-plan', 'pages/learning-plan.tsx'),
    route('blog', 'pages/blog.tsx'),
    route('search', 'routes/search.tsx'),
    route('tokens', 'routes/tokens.tsx'),
    route('backup', 'routes/backup.tsx'),
    route('insights', 'routes/insights.tsx'),
    route('reports', 'routes/reports.tsx'),
    route('contentbank', 'routes/contentbank.tsx'),
    route('contentbank/new', 'routes/contentbank-new.tsx'),
    route('contentbank/:id/edit', 'routes/contentbank-edit.tsx'),
    route('privacy', 'routes/privacy.tsx'),
  ]),
  // Hai trang mỏng của luồng uỷ quyền MCP (lát MCP-1, issue #163):
  // nằm NGOÀI shell layout — chúng là loginPage/consentPage mà máy
  // chủ OAuth chuyển trình duyệt tới giữa luồng authorize, phải hiển
  // thị trần (không khung app, không bị guard của shell đá về /login).
  route('mcp-login', 'pages/mcp-login.tsx'),
  route('mcp-consent', 'pages/mcp-consent.tsx'),
] satisfies RouteConfig;
