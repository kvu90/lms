import { Skeleton } from '@lms/ui/components/ui/skeleton';

/**
 * Vỏ giữ chỗ của khung đã đăng nhập, dùng ở hai thời điểm: HydrateFallback
 * của root route (HTML dựng sẵn lúc build — paint đầu tiên của mọi lần F5)
 * và cổng chờ phiên trong Shell (trong lúc GET /users/me chưa về).
 *
 * Hình học bám ĐÚNG khung thật của block dashboard-01 (ui/sidebar
 * variant inset): nền --sidebar bao quanh, khe sidebar rộng 72 đơn vị
 * spacing (18rem) với panel nổi đệm p-2, vùng nội dung là thẻ inset
 * (m-2, ml-0, bo góc xl, đổ bóng) chứa header cao 12 đơn vị (3rem) và
 * phần thân theo nhịp của trang tổng quan (tiêu đề, lưới 4 thẻ cao
 * 158px, thẻ biểu đồ ~388px) — để khi khung thật thế vào, bố cục không
 * xê dịch.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex min-h-svh w-full bg-sidebar" aria-hidden="true">
      <div className="hidden w-72 shrink-0 p-2 md:block">
        <div className="flex h-full flex-col gap-6 px-2 py-2">
          <Skeleton className="h-9 w-32" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
          <div className="mt-auto flex items-center gap-2">
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      </div>
      <div className="@container/main relative flex min-w-0 flex-1 flex-col bg-background md:m-2 md:ml-0 md:rounded-xl md:shadow-sm">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 lg:px-6">
          <Skeleton className="h-5 w-44" />
        </header>
        <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
          <Skeleton className="mx-4 h-8 w-72 lg:mx-6" />
          <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
            <Skeleton className="h-39.5" />
            <Skeleton className="h-39.5" />
            <Skeleton className="h-39.5" />
            <Skeleton className="h-39.5" />
          </div>
          <Skeleton className="mx-4 h-97 lg:mx-6" />
        </div>
      </div>
    </div>
  );
}
