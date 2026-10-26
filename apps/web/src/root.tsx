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
import { SidebarDefaultOpenContext } from './lib/sidebar-default-open';
import { fetchApiJson } from './lib/server-api';
import { AppShellSkeleton } from './components/app-shell-skeleton';
import './i18n';
import '@lms/ui/globals.css';
// CSS của KaTeX cho công thức toán trong rich text (@lms/editor): editor
// không tự nạp CSS nên app nạp tại điểm CSS toàn cục này (bàn giao QE-1).
import 'katex/dist/katex.min.css';

/**
 * Đọc cookie `sidebar_state` (ui/sidebar ghi mỗi lần bật/tắt) từ một
 * chuỗi Cookie: dùng cho loader phía server (Cookie của request) và
 * cho fallback phía client (document.cookie) khi cây render không có
 * dữ liệu loader. Không có cookie thì mặc định mở như block gốc.
 */
function parseSidebarState(cookie: string): boolean {
  const match = cookie.match(/(?:^|;\s*)sidebar_state=(true|false)/);
  return match ? match[1] === 'true' : true;
}

/**
 * Loader gốc (SSR, Giai đoạn 3–4 của issue #7): chỉ lấy DANH TÍNH TỐI
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
 *
 * Loader còn trả `sidebarDefaultOpen`: trạng thái thu/mở sidebar đọc
 * từ cookie `sidebar_state` CỦA CHÍNH REQUEST (F-11 của #133, việc
 * #146) — chỉ đọc cookie, không gọi API thêm, nên nguyên tắc cách ly
 * ở trên không đổi; shell khởi tạo sidebar từ giá trị này thay vì tự
 * đọc cookie phía client, để SSR và hydrate đầu khớp nhau.
 */
export async function loader({
  request,
}: {
  request: Request;
}): Promise<{ initialUser: UserProfile | null; sidebarDefaultOpen: boolean }> {
  const cookie = request.headers.get('Cookie') ?? '';
  const sidebarDefaultOpen = parseSidebarState(cookie);
  if (!/(?:^|;\s*)lms_session=/.test(cookie)) return { initialUser: null, sidebarDefaultOpen };
  const body = await fetchApiJson('/api/v1/auth/session/me', { Cookie: cookie });
  const parsed = userProfileSchema.safeParse(body);
  return { initialUser: parsed.success ? parsed.data : null, sidebarDefaultOpen };
}

/**
 * Tiêu đề mặc định của toàn app (F-08 của #133, việc #146): route lá
 * có meta() riêng thì tiêu đề của route đó thay thế; Layout không còn
 * gắn cứng <title> nữa.
 */
export function meta(): { title: string }[] {
  return [{ title: 'LMS' }];
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
  // Cây render ngoài route gốc (test nhúng, bản nhúng từng phần) có
  // thể không có dữ liệu loader: khi đó initialUser là undefined và
  // AuthProvider giữ hành vi resolve phía client như trước SSR.
  const loaderData = useLoaderData<typeof loader>() as
    | { initialUser: UserProfile | null; sidebarDefaultOpen?: boolean }
    | undefined;
  const initialUser = loaderData?.initialUser;
  // Trạng thái sidebar khởi tạo: ưu tiên giá trị loader (đọc từ cookie
  // của request phía server — SSR và hydrate đầu khớp nhau). Cây render
  // không có dữ liệu loader (test nhúng) thì giữ fallback đọc cookie
  // phía client như hành vi trước #146.
  const sidebarDefaultOpen =
    loaderData?.sidebarDefaultOpen ??
    (typeof document === 'undefined' ? true : parseSidebarState(document.cookie));
  // QueryClient phía server phải là instance THEO TỪNG REQUEST (cache
  // dùng chung giữa các request trên cùng tiến trình SSR sẽ rò dữ liệu
  // giữa người dùng); phía client giữ singleton như trước để tầng phiên
  // xoá cache khi đổi danh tính. useState bảo đảm mỗi cây render — tức
  // mỗi request phía server — có đúng một instance riêng.
  const [requestQueryClient] = useState(() => (typeof window === 'undefined' ? createQueryClient() : null));
  return (
    <SidebarDefaultOpenContext.Provider value={sidebarDefaultOpen}>
      <QueryClientProvider client={requestQueryClient ?? queryClient}>
        <AuthProvider initialUser={initialUser}>
          <PermissionsProvider>
            <Outlet />
          </PermissionsProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SidebarDefaultOpenContext.Provider>
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
