import { Suspense, lazy } from 'react';
import type {
  Course,
  CourseActivityGrid,
  CourseCategoryTreeNode,
  DashboardOverviewView,
  MyAccessView,
  MyActivityGrades,
  Role,
  UserListResponse,
} from '@lms/contracts';
import { useAuth } from '../lib/auth';
import { HomePage } from '../pages/home';
import { DashboardSkeleton } from '../components/dashboard-skeleton';
import { queryKeys } from '../lib/query-keys';
import { buildSsrLoaderData, serverProbe, serverQueryFn, type SsrLoaderData } from '../lib/ssr-data';
import { upcomingDaysRangeIso, type CalendarEventView } from '../lib/calendar';
import { hasCourseAssignment, systemCapabilities } from '../lib/permissions';
import type { CourseGradeData } from '../lib/course-grade-data';
import type { MyBadgeView } from '../lib/badges';

/**
 * Loader phía server cho route `/` (tầng SL-1 của #7).
 *
 * Hai mặt của route theo phiên:
 *   - CHƯA đăng nhập (không cookie phiên Better Auth): loader không
 *     gọi API nghiệp vụ nào, trả dehydrated state rỗng — mặt công
 *     khai giữ nguyên và là bản được prerender lúc build.
 *   - ĐÃ đăng nhập: prefetch bằng cookie của chính request (xem
 *     `lib/ssr-data.ts`) rồi dehydrate cho root.tsx hydrate:
 *     lượt 1 gồm hai query gốc của PermissionsProvider (ảnh chụp
 *     quyền `capabilities` + danh sách khoá `courses` — có chúng thì
 *     provider phân loại vai ngay từ lần render đầu, dashboard hết
 *     hiện khung giữ chỗ chờ phân loại) và các query key cố định của
 *     các khối (tổng hợp `dashboardOverview`, huy hiệu của tôi
 *     `myBadges`, số chưa đọc `notifications`, sự kiện 30 ngày tới
 *     `calendarEvents` với khoảng ngày từ `upcomingDaysRangeIso`
 *     dùng chung hai phía); lượt 2 — chỉ khi lượt 1 có đủ ảnh chụp
 *     quyền + danh sách khoá — prefetch dữ liệu điểm theo khoá
 *     (`courseAccess`) cho đúng tập khoá người dùng THUỘC về (dạy ∪
 *     học, phân loại bằng chính các hàm thuần của `lib/permissions`)
 *     và, khi người dùng có quyền quản trị theo đúng công thức
 *     `canAdminister` của provider, ba query của khối quản trị
 *     (`adminUsers(1, 100)`, `categoryTree`, `roles`).
 *
 * Phần CHƯA lên loader (khai rõ): pref thẻ khoá (key `courseCards`)
 * — dữ liệu của query đó là một `Map` do `fetchCourseCardPrefs` dựng
 * phía client, không serialize qua dehydrate được (sẽ thành object
 * rỗng và làm hỏng lời gọi `.get()` của các khối); khối GV/HS vẫn
 * fetch query này phía client như trước SL-1.
 *
 * @param request - Request đang phục vụ (nguồn cookie phiên).
 * @returns Dehydrated state cho HydrationBoundary ở root.
 */
export async function loader({ request }: { request: Request }): Promise<SsrLoaderData> {
  return buildSsrLoaderData(request, async (queryClient, req) => {
    const range = upcomingDaysRangeIso(30);
    await Promise.all([
      queryClient.prefetchQuery({
        queryKey: queryKeys.capabilities,
        queryFn: serverQueryFn<MyAccessView>(req, '/api/v1/users/me/capabilities'),
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.courses,
        queryFn: serverQueryFn<Course[]>(req, '/api/v1/courses'),
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.dashboardOverview,
        queryFn: serverQueryFn<DashboardOverviewView>(req, '/api/v1/dashboard/overview?days=7'),
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.myBadges,
        queryFn: serverQueryFn<MyBadgeView[]>(req, '/api/v1/badges/mine'),
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.notifications,
        queryFn: serverQueryFn<{ unread: number }>(req, '/api/v1/notifications/unread-count'),
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.calendarEvents(range.from, range.to),
        queryFn: serverQueryFn<CalendarEventView[]>(
          req,
          `/api/v1/calendar/events?from=${range.from}&to=${range.to}`,
        ),
      }),
    ]);

    // Lượt 2 cần kết quả lượt 1: thiếu ảnh chụp quyền hoặc danh sách
    // khoá (API lỗi phía server) thì dừng — phía client tự phân loại
    // và tải như trước, loader không đoán tập khoá thay nó.
    const access = queryClient.getQueryData<MyAccessView>(queryKeys.capabilities);
    const courses = queryClient.getQueryData<Course[]>(queryKeys.courses);
    if (!access || !courses) return;

    const memberCourses = courses.filter((course) => hasCourseAssignment(access, course));
    // Dữ liệu điểm theo khoá: cùng hình dạng + cùng ngữ nghĩa dò
    // (endpoint lỗi độc lập thì phần đó null) với `fetchCourseGradeData`
    // phía client — chỉ khác kênh gọi (cookie của request qua API nội bộ).
    const gradePrefetches = memberCourses.map((course) =>
      queryClient.prefetchQuery({
        queryKey: queryKeys.courseAccess(course.id),
        queryFn: async (): Promise<CourseGradeData> => {
          const [report, gradebook] = await Promise.all([
            serverProbe<CourseActivityGrid>(req, `/api/v1/courses/${course.id}/grades/report`),
            serverProbe<MyActivityGrades>(req, `/api/v1/courses/${course.id}/gradebook`),
          ]);
          return { report, gradebook };
        },
      }),
    );

    // Khối quản trị chỉ hiện với canAdminister — prefetch đúng ba
    // query của khối theo cùng công thức của PermissionsProvider
    // (site admin, hoặc role:manage / site:config tại context hệ thống).
    const sysCaps = systemCapabilities(access);
    const canAdminister =
      access.isSiteAdmin || sysCaps.includes('role:manage') || sysCaps.includes('site:config');
    const adminPrefetches = canAdminister
      ? [
          queryClient.prefetchQuery({
            queryKey: queryKeys.adminUsers(1, 100),
            queryFn: serverQueryFn<UserListResponse>(req, '/api/v1/users?page=1&pageSize=100'),
          }),
          queryClient.prefetchQuery({
            queryKey: queryKeys.categoryTree,
            queryFn: serverQueryFn<CourseCategoryTreeNode[]>(req, '/api/v1/courses/categories/tree'),
          }),
          queryClient.prefetchQuery({
            queryKey: queryKeys.roles,
            queryFn: serverQueryFn<Role[]>(req, '/api/v1/access/roles'),
          }),
        ]
      : [];

    await Promise.all([...gradePrefetches, ...adminPrefetches]);
  });
}

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

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
export function meta() {
  return [{ title: 'LMS' }];
}
