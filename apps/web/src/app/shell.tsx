import type { CSSProperties } from 'react';
import { Link, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@lms/ui/components/button';
import { useAuth } from '#lib/auth';
import { useSidebarDefaultOpen } from '#lib/sidebar-default-open';
import { AppSidebar } from '#components/app-sidebar';
import { AppShellSkeleton } from '#components/app-shell-skeleton';
import { NavigationProgressBar, useNavigationPending } from '#components/navigation-progress';
import { SiteHeader } from '#components/site-header';
import { SidebarInset, SidebarProvider } from '@lms/ui/components/sidebar';

export { RouteErrorBoundary as ErrorBoundary } from '#components/route-error-boundary';

/**
 * Khung của khu vực ĐÃ đăng nhập, theo block dashboard-01: sidebar điều
 * hướng (đã lọc theo quyền trong AppSidebar) + header trên cùng + vùng
 * nội dung. Khung này CHỈ lo trình bày: PermissionsProvider đã bọc ở
 * root (root.tsx) cho toàn bộ cây route nên sidebar và mọi trang con
 * dùng chung một ảnh chụp quyền mà không cần bọc lại tại đây — và
 * trang nào cũng ở trong provider kể cả khi khung thay đổi.
 */
function AuthenticatedShell() {
  // Trạng thái thu/mở khởi tạo lấy từ root loader qua context (F-11
  // của #133, việc #146): loader đã đọc cookie `sidebar_state` từ
  // request phía server nên giá trị này khớp giữa HTML SSR và lần
  // render hydrate đầu — không còn lệch hydrate khi cookie là false.
  // Chỉ là giá trị khởi tạo (defaultOpen); các lần bật/tắt sau do
  // ui/sidebar tự ghi lại cookie.
  const sidebarDefaultOpen = useSidebarDefaultOpen();
  // Chỉ báo chờ điều hướng toàn cục (F-14): router đang tải trang đích
  // (clientLoader của trang đích đang nạp dữ liệu) thì thanh tiến
  // trình mảnh hiện ở đỉnh và vùng nội dung mờ nhẹ — người dùng thấy
  // ngay hệ đang chuyển trang thay vì tưởng bấm mà không ăn.
  const navigationPending = useNavigationPending();
  return (
    <SidebarProvider
      defaultOpen={sidebarDefaultOpen}
      style={
        {
          '--sidebar-width': 'calc(var(--spacing) * 72)',
          '--header-height': 'calc(var(--spacing) * 12)',
        } as CSSProperties
      }
    >
      <NavigationProgressBar active={navigationPending} />
      <AppSidebar variant="inset" />
      <SidebarInset
        aria-busy={navigationPending || undefined}
        className={`transition-opacity duration-200 ${navigationPending ? 'opacity-60' : ''}`}
      >
        <SiteHeader />
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * Khung công khai (chưa đăng nhập): header ngang đơn giản, dùng cho trang
 * chủ giới thiệu, đăng nhập và kiểm tra trạng thái — các luồng này không
 * đổi hành vi khi khu vực đăng nhập chuyển sang khung sidebar.
 */
function PublicShell() {
  const { user, logout } = useAuth();
  const { t } = useTranslation('app');
  return (
    <div>
      <header className="flex items-center gap-4 border-b px-8 py-3">
        <Link to="/" className="font-semibold">
          LMS
        </Link>
        {/* Không có bộ chọn ngôn ngữ: site chỉ dành cho người Việt,
            i18n chỉ quản lý chuỗi tập trung với locale cố định vi. */}
        <span className="ml-auto flex items-center gap-3 text-sm">
          {user ? (
            <>
              <span>{user.username}</span>
              <Button type="button" variant="outline" onClick={() => void logout()}>
                {t('logout')}
              </Button>
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

/**
 * Chọn khung theo trạng thái phiên — và tôn trọng pha đang tải: khi đã
 * có token mà GET /users/me chưa trả về, hiện khung giữ chỗ đúng hình
 * học của khu vực đã đăng nhập. Trước đây Shell bỏ qua cờ `loading` nên
 * mỗi lần F5 lại vẽ khung công khai trước rồi thay toàn bộ bằng khung
 * sidebar — pha "nhảy" lớn nhất mà audit hiệu năng ghi nhận.
 */
export default function Shell() {
  const { user, loading } = useAuth();
  if (loading) return <AppShellSkeleton />;
  return user ? <AuthenticatedShell /> : <PublicShell />;
}
