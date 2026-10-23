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
    route('admin/roles', 'pages/admin-roles.tsx'),
    route('admin/site-config', 'pages/admin-site-config.tsx'),
    route('courses', 'pages/courses.tsx'),
    route('courses/:id', 'pages/course.tsx'),
    route('courses/:id/admin', 'pages/course-admin.tsx'),
    route('courses/:id/grades', 'pages/grades.tsx'),
    route('courses/:id/quizzes/:quizId', 'pages/quiz.tsx'),
    route('courses/:id/quizzes/:quizId/results', 'pages/quiz-results.tsx'),
    route('quiz-attempts/:attemptId', 'pages/quiz-attempt.tsx'),
    route('questions', 'pages/questions.tsx'),
    route('question-usages/:id', 'routes/question-usage.tsx'),
    route('messages', 'pages/messages.tsx'),
    route('notifications', 'pages/notifications.tsx'),
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
    route('privacy', 'routes/privacy.tsx'),
  ]),
] satisfies RouteConfig;
