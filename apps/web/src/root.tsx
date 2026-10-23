import type { ReactNode } from 'react';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './lib/auth';
import { queryClient } from './lib/query-client';
import { AppShellSkeleton } from './components/app-shell-skeleton';
import './i18n';
import '@lms/ui/globals.css';

/**
 * Vỏ tài liệu HTML của toàn app (React Router framework mode): root route
 * là nơi duy nhất dựng <html>/<head>/<body>; các provider toàn cục bọc ở
 * component App bên dưới. `lang="vi"` khớp ngôn ngữ giao diện mặc định.
 */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>LMS</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Gốc ứng dụng: QueryClientProvider (một QueryClient duy nhất cho cả
 * app) bọc ngoài AuthProvider để mọi trang dùng chung một phiên đăng
 * nhập (useAuth) và một cache dữ liệu máy chủ. Provider quyền nằm trong
 * khung route đã đăng nhập, gần nơi dùng.
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * Khung hiển thị trong lúc chờ hydrate ở lần tải đầu (chế độ SPA): HTML
 * dựng sẵn lúc build chính là khung này, nên paint đầu tiên đã có đúng
 * hình học của khung đã đăng nhập thay vì trang trắng hay khung công
 * khai bị thay thế sau đó.
 */
export function HydrateFallback() {
  return <AppShellSkeleton />;
}

/** Biên lỗi toàn cục: lỗi route (404/…) và lỗi render đều về đây. */
export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} — ${error.statusText}`
    : 'Đã xảy ra lỗi không mong muốn.';
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-semibold">LMS</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      <a href="/" className="text-sm underline underline-offset-4">
        Về trang chủ
      </a>
    </main>
  );
}
