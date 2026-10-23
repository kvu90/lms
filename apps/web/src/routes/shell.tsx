import { useState, type CSSProperties } from 'react';
import { Link, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@lms/ui/components/ui/button';
import { useAuth } from '../lib/auth';
import { PermissionsProvider } from '../lib/permissions';
import { AppSidebar } from '../components/app-sidebar';
import { AppShellSkeleton } from '../components/app-shell-skeleton';
import { SiteHeader } from '../components/site-header';
import { SidebarInset, SidebarProvider } from '@lms/ui/components/ui/sidebar';

/**
 * Đọc trạng thái thu/mở sidebar người dùng đã chọn từ cookie
 * `sidebar_state` mà ui/sidebar ghi mỗi lần bật/tắt: bản SPA không có
 * layout phía server để đọc cookie như bản Next.js của block gốc, nên
 * nếu không khôi phục ở đây thì mỗi lần F5 sidebar lại bung về mặc định
 * và bề ngang vùng nội dung co giãn một nhịp. Chỉ đọc ở lần dựng khung
 * đầu tiên (defaultOpen), các lần bật/tắt sau do ui/sidebar tự ghi lại.
 */
function readSidebarDefaultOpen(): boolean {
  if (typeof document === 'undefined') return true;
  const match = document.cookie.match(/(?:^|;\s*)sidebar_state=(true|false)/);
  return match ? match[1] === 'true' : true;
}

/**
 * Khung của khu vực ĐÃ đăng nhập, theo block dashboard-01: sidebar điều
 * hướng (đã lọc theo quyền trong AppSidebar) + header trên cùng + vùng nội
 * dung. PermissionsProvider bọc ngoài để sidebar và trang tổng quan dùng
 * chung một ảnh chụp quyền.
 */
function AuthenticatedShell() {
  const [sidebarDefaultOpen] = useState(readSidebarDefaultOpen);
  return (
    <PermissionsProvider>
      <SidebarProvider
        defaultOpen={sidebarDefaultOpen}
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
 * Khung công khai (chưa đăng nhập): header ngang đơn giản, dùng cho trang
 * chủ giới thiệu, đăng nhập và kiểm tra trạng thái — các luồng này không
 * đổi hành vi khi khu vực đăng nhập chuyển sang khung sidebar.
 */
function PublicShell() {
  const { user, logout } = useAuth();
  const { t, i18n } = useTranslation('app');
  return (
    <div>
      <header className="flex items-center gap-4 border-b px-8 py-3">
        <Link to="/" className="font-semibold">
          LMS
        </Link>
        <label className="ml-auto flex items-center gap-2 text-sm">
          {t('language')}
          <select
            aria-label={t('language')}
            value={i18n.language}
            onChange={(e) => void i18n.changeLanguage(e.target.value)}
            className="border px-1 py-0.5"
          >
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
        </label>
        <span className="flex items-center gap-3 text-sm">
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
