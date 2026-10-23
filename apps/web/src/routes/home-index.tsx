import { Suspense, lazy } from 'react';
import { useAuth } from '../lib/auth';
import { HomePage } from '../pages/home';
import { DashboardSkeleton } from '../components/dashboard-skeleton';

/**
 * Trang tổng quan là chunk nặng (biểu đồ, bảng) nên nạp lười biếng: khách
 * chưa đăng nhập chỉ tải trang giới thiệu nhẹ; người đã đăng nhập thấy
 * khung giữ chỗ đúng hình học của trang tổng quan trong lúc chunk về.
 */
const DashboardPage = lazy(() => import('../pages/dashboard').then((m) => ({ default: m.DashboardPage })));

/**
 * Route gốc `/`: đã đăng nhập thì là trang tổng quan theo vai trò, chưa
 * thì là trang giới thiệu — đúng hành vi của RootPage ở router cũ. Pha
 * phiên đang tải không tới được đây: Shell đã chặn bằng khung giữ chỗ.
 */
export default function HomeIndexRoute() {
  const { user } = useAuth();
  if (!user) return <HomePage />;
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardPage />
    </Suspense>
  );
}
