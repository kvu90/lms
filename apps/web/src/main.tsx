import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Link, Outlet, RouterProvider } from 'react-router';
import { Button } from './components/ui/button';
import { AuthProvider, useAuth } from './lib/auth';
import { AdminRolesPage } from './pages/admin-roles';
import { AdminUsersPage } from './pages/admin-users';
import { CoursePage } from './pages/course';
import { CourseAdminPage } from './pages/course-admin';
import { CoursesPage } from './pages/courses';
import { GradebookPage } from './pages/grades';
import { HealthPage } from './pages/health';
import { QuestionsPage, QuestionUsagePage } from './pages/questions';
import { HomePage } from './pages/home';
import { LoginPage } from './pages/login';
import { ProfilePage } from './pages/profile';
import './index.css';

function Shell() {
  const { user, logout } = useAuth();
  return (
    <div>
      <header className="flex items-center gap-4 border-b px-8 py-3">
        <Link to="/" className="font-semibold">LMS</Link>
        <nav className="flex gap-3 text-sm">
          <Link to="/profile">Profile</Link>
          <Link to="/courses">Courses</Link>
          <Link to="/questions">Questions</Link>
          <Link to="/admin/users">Users</Link>
          <Link to="/admin/roles">Roles</Link>
          <Link to="/health">Health</Link>
        </nav>
        <span className="ml-auto flex items-center gap-3 text-sm">
          {user ? (
            <>
              <span>{user.username}</span>
              <Button type="button" variant="outline" onClick={() => void logout()}>Log out</Button>
            </>
          ) : (
            <Link to="/login">Sign in</Link>
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
