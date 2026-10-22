import { StrictMode, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, Outlet, RouterProvider } from 'react-router';
import { Button } from './components/ui/button';
import { useTranslation } from 'react-i18next';
import './i18n';
import { AuthProvider, useAuth } from './lib/auth';
import { PermissionsProvider } from './lib/permissions';
import { AppSidebar } from './components/app-sidebar';
import { SiteHeader } from './components/site-header';
import { SidebarInset, SidebarProvider } from './components/ui/sidebar';
import { AdminRolesPage } from './pages/admin-roles';
import { AdminSiteConfigPage } from './pages/admin-site-config';
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
import { DashboardPage } from './pages/dashboard';
import { GradebookPage } from './pages/grades';
import { HealthPage } from './pages/health';
import { QuestionsPage, QuestionUsagePage } from './pages/questions';
import { HomePage } from './pages/home';
import { LoginPage } from './pages/login';
import { ProfilePage } from './pages/profile';
import { BackupPage, ContentBankPage, InsightsPage, PrivacyPage, ReportsPage, SearchPage, TokensPage } from './pages/platform';
import './index.css';

/**
 * Khung của khu vực ĐÃ đăng nhập, theo block dashboard-01: sidebar điều
 * hướng (đã lọc theo quyền trong AppSidebar) + header trên cùng + vùng nội
 * dung. PermissionsProvider bọc ngoài để sidebar và trang tổng quan dùng
 * chung một ảnh chụp quyền.
 */
function AuthenticatedShell() {
  return (
    <PermissionsProvider>
      <SidebarProvider
        style={
          {
            '--sidebar-width': 'calc(var(--spacing) * 72)',
            '--header-height': 'calc(var(--spacing) * 12)',
          } as CSSProperties
        }
      >
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </PermissionsProvider>
  );
}

/**
 * Khung công khai (chưa đăng nhập): header ngang đơn giản như trước, dùng
 * cho trang chủ giới thiệu, đăng nhập và kiểm tra trạng thái — các luồng
 * này không đổi hành vi khi khu vực đăng nhập chuyển sang khung sidebar.
 */
function PublicShell() {
  const { user, logout } = useAuth();
  const { t, i18n } = useTranslation('app');
  return (
    <div>
      <header className="flex items-center gap-4 border-b px-8 py-3">
        <Link to="/" className="font-semibold">LMS</Link>
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

/** Chọn khung theo trạng thái đăng nhập: có phiên thì vào khung sidebar. */
function Shell() {
  const { user } = useAuth();
  return user ? <AuthenticatedShell /> : <PublicShell />;
}

/** Trang gốc `/`: đã đăng nhập thì là trang tổng quan theo vai trò, chưa thì là trang giới thiệu. */
function RootPage() {
  const { user } = useAuth();
  return user ? <DashboardPage /> : <HomePage />;
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <RootPage /> },
      { path: '/health', element: <HealthPage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/profile', element: <ProfilePage /> },
      { path: '/admin/users', element: <AdminUsersPage /> },
      { path: '/admin/roles', element: <AdminRolesPage /> },
      { path: '/admin/site-config', element: <AdminSiteConfigPage /> },
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
