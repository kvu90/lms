import { Skeleton } from '@/components/ui/skeleton';

/**
 * Vỏ giữ chỗ của khung đã đăng nhập, dùng ở hai thời điểm: HydrateFallback
 * của root route (HTML dựng sẵn lúc build — paint đầu tiên của mọi lần F5)
 * và cổng chờ phiên trong Shell (trong lúc GET /users/me chưa về). Hình
 * học bám khung thật của block dashboard-01: cột sidebar rộng 72 đơn vị
 * spacing (18rem) + thanh header cao 12 đơn vị (3rem) + vùng nội dung có
 * tiêu đề, lưới 4 thẻ thống kê và khối biểu đồ — để khi nội dung thật thế
 * vào, bố cục không xê dịch.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex min-h-svh w-full" aria-hidden="true">
      <div className="hidden w-72 shrink-0 flex-col gap-6 border-r p-4 md:flex">
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
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <Skeleton className="h-5 w-44" />
        </header>
        <main className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
          <Skeleton className="mx-4 h-8 w-64 lg:mx-6" />
          <div className="grid grid-cols-1 gap-4 px-4 sm:grid-cols-2 lg:px-6 xl:grid-cols-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
          <Skeleton className="mx-4 h-72 lg:mx-6" />
        </main>
      </div>
    </div>
  );
}
