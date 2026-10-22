import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, Outlet, RouterProvider } from 'react-router';
import { Button } from './components/ui/button';
import { useTranslation } from 'react-i18next';
import './i18n';
import { AuthProvider, useAuth } from './lib/auth';
import { AdminRolesPage } from './pages/admin-roles';
import { AdminUsersPage } from './pages/admin-users';
import { BadgesPage } from './pages/badges';
import { BlogPage } from './pages/blog';
import { CalendarPage } from './pages/calendar';
import { LearningPlanPage } from './pages/learning-plan';
import { MessagesPage } from './pages/messages';
import { NotificationsPage } from './pages/notifications';
import { CoursePage } from './pages/course';
import { CourseAdminPage } from './pages/course-admin';
import { CoursesPage } from './pages/courses';
import { GradebookPage } from './pages/grades';
import { HealthPage } from './pages/health';
import { QuestionsPage, QuestionUsagePage } from './pages/questions';
import { HomePage } from './pages/home';
import { LoginPage } from './pages/login';
import { ProfilePage } from './pages/profile';
import { BackupPage, ContentBankPage, InsightsPage, PrivacyPage, ReportsPage, SearchPage, TokensPage } from './pages/platform';
import './index.css';

function Shell() {
  const { user, logout } = useAuth();
  const { t, i18n } = useTranslation('app');
  return (
    <div>
      <header className="flex items-center gap-4 border-b px-8 py-3">
        <Link to="/" className="font-semibold">LMS</Link>
        <nav className="flex gap-3 text-sm">
          <Link to="/profile">{t('navProfile')}</Link>
          <Link to="/courses">{t('navCourses')}</Link>
          <Link to="/questions">{t('navQuestions')}</Link>
          <Link to="/messages">{t('navMessages')}</Link>
          <Link to="/notifications">{t('navNotifications')}</Link>
          <Link to="/calendar">{t('navCalendar')}</Link>
          <Link to="/badges">{t('navBadges')}</Link>
          <Link to="/learning-plan">{t('navLearningPlan')}</Link>
          <Link to="/blog">{t('navBlog')}</Link>
          <Link to="/search">{t('navSearch')}</Link>
          <Link to="/tokens">{t('navTokens')}</Link>
          <Link to="/backup">{t('navBackup')}</Link>
          <Link to="/insights">{t('navInsights')}</Link>
          <Link to="/reports">{t('navReports')}</Link>
          <Link to="/contentbank">{t('navContentBank')}</Link>
          <Link to="/privacy">{t('navPrivacy')}</Link>
          <Link to="/admin/users">{t('navUsers')}</Link>
          <Link to="/admin/roles">{t('navRoles')}</Link>
          <Link to="/health">{t('navHealth')}</Link>
        </nav>
        <label className="ml-auto flex items-center gap-2 text-sm">
          {t('language')}
          <select aria-label={t('language')} value={i18n.language} onChange={(e) => void i18n.changeLanguage(e.target.value)} className="border px-1 py-0.5">
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
        </label>
        <span className="flex items-center gap-3 text-sm">
          {user ? (
            <>
              <span>{user.username}</span>
              <Button type="button" variant="outline" onClick={() => void logout()}>{t('logout')}</Button>
            </>
          ) : (
            <Link to="/login">{t('signIn')}</Link>
          )}
        </span>
      </header>
      <Outlet />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/health', element: <HealthPage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/profile', element: <ProfilePage /> },
      { path: '/admin/users', element: <AdminUsersPage /> },
      { path: '/admin/roles', element: <AdminRolesPage /> },
      { path: '/courses', element: <CoursesPage /> },
      { path: '/courses/:id', element: <CoursePage /> },
      { path: '/courses/:id/admin', element: <CourseAdminPage /> },
      { path: '/courses/:id/grades', element: <GradebookPage /> },
      { path: '/questions', element: <QuestionsPage /> },
      { path: '/question-usages/:id', element: <QuestionUsagePage /> },
      { path: '/messages', element: <MessagesPage /> },
      { path: '/notifications', element: <NotificationsPage /> },
      { path: '/calendar', element: <CalendarPage /> },
      { path: '/badges', element: <BadgesPage /> },
      { path: '/learning-plan', element: <LearningPlanPage /> },
      { path: '/blog', element: <BlogPage /> },
      { path: '/search', element: <SearchPage /> },
      { path: '/tokens', element: <TokensPage /> },
      { path: '/backup', element: <BackupPage /> },
      { path: '/insights', element: <InsightsPage /> },
      { path: '/reports', element: <ReportsPage /> },
      { path: '/contentbank', element: <ContentBankPage /> },
      { path: '/privacy', element: <PrivacyPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
