import { useState, type ReactNode } from 'react';
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useRouteError,
} from 'react-router';
import type { UserProfile } from '@lms/contracts';
import { userProfileSchema } from '@lms/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './lib/auth';
import { PermissionsProvider } from './lib/permissions';
import { createQueryClient, queryClient } from './lib/query-client';
import { fetchApiJson } from './lib/server-api';
import { AppShellSkeleton } from './components/app-shell-skeleton';
import './i18n';
import '@lms/ui/globals.css';

/**
 * Loader gốc (SSR, Giai đoạn 3 của issue #7): chỉ lấy DANH TÍNH TỐI
 * THIỂU cho vỏ trang. Khi request mang cookie phiên `lms_session` (luồng
 * phiên cookie sẵn có của API), loader chuyển nguyên Cookie sang API
 * nội bộ gọi GET /auth/session/me; không có cookie thì mặc định ẩn danh
 * và KHÔNG gọi API. Nhờ vậy HTML phía server và lần render đầu phía
 * client dùng chung một trạng thái phiên khởi tạo (không lệch hydrate),
 * và hai tài khoản khác nhau không bao giờ nhận HTML của nhau: HTML
 * chứa dữ liệu riêng chỉ sinh khi request mang đúng cookie của chủ
 * phiên. Token ở localStorage (luồng chính hiện tại) không đọc được
 * phía server — người dùng luồng đó vẫn được client resolve như trước
 * ngay sau hydrate; chuyển hẳn sang phiên cookie là Giai đoạn 2.
 */
export async function loader({ request }: { request: Request }): Promise<{ initialUser: UserProfile | null }> {
  const cookie = request.headers.get('Cookie') ?? '';
  if (!/(?:^|;\s*)lms_session=/.test(cookie)) return { initialUser: null };
  const body = await fetchApiJson('/api/v1/auth/session/me', { Cookie: cookie });
  const parsed = userProfileSchema.safeParse(body);
  return { initialUser: parsed.success ? parsed.data : null };
}

/**
 * Mọi tài liệu HTML và dữ liệu loader đều có thể chứa dữ liệu theo
 * phiên → cấm cache công khai ở mọi tầng trung gian; chỉ asset có hash
 * nội dung (phục vụ bởi tiến trình SSR) mới cache dài hạn.
 */
export function headers(): Record<string, string> {
  return { 'Cache-Control': 'private, no-cache' };
}

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
 * Gốc ứng dụng: MỌI provider toàn cục bọc tại đây theo đúng vị trí
 * framework mode quy định cho root route — QueryClientProvider (một
 * QueryClient duy nhất cho cả app), AuthProvider (phiên đăng nhập) và
 * PermissionsProvider (ảnh chụp quyền) bao phủ TOÀN BỘ cây route vô
 * điều kiện, không phụ thuộc khung nào đang hiển thị. Nhờ vậy không
 * trang nào có thể mount ngoài provider nó cần: lỗi "usePermissions
 * must be used inside PermissionsProvider" khi vào thẳng/F5 một trang
 * cần quyền bị loại ở mức kiến trúc, thay vì trông vào cổng chờ phiên
 * của từng khung. PermissionsProvider chỉ bật các query khi đã có
 * người dùng; khi chưa đăng nhập nó trả ảnh chụp rỗng ở trạng thái sẵn
 * sàng nên các trang công khai vẫn đọc quyền an toàn. Cổng chờ phiên
 * (chặn mount trang con cho tới khi phiên resolve) nằm ở layout Shell.
 */
export default function App() {
  const { initialUser } = useLoaderData<typeof loader>();
  // QueryClient phía server phải là instance THEO TỪNG REQUEST (cache
  // dùng chung giữa các request trên cùng tiến trình SSR sẽ rò dữ liệu
  // giữa người dùng); phía client giữ singleton như trước để tầng phiên
  // xoá cache khi đổi danh tính. useState bảo đảm mỗi cây render — tức
  // mỗi request phía server — có đúng một instance riêng.
  const [requestQueryClient] = useState(() => (typeof window === 'undefined' ? createQueryClient() : null));
  return (
    <QueryClientProvider client={requestQueryClient ?? queryClient}>
      <AuthProvider initialUser={initialUser}>
        <PermissionsProvider>
          <Outlet />
        </PermissionsProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * Khung giữ chỗ khi lần tải đầu chưa có HTML phía server để hydrate
 * (ví dụ điều hướng phía client trước khi loader gốc kịp trả): giữ
 * khung giữ chỗ đúng hình học của khung đã đăng nhập thay vì trang
 * trắng. Với SSR bật, request tài liệu thông thường đã có HTML thật
 * từ server nên khung này ít khi xuất hiện.
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
