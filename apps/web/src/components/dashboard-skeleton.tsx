import { Skeleton } from '@/components/ui/skeleton';

/**
 * Khung giữ chỗ cho nội dung trang tổng quan trong lúc chunk trang hoặc
 * dữ liệu của trang đang tải: giữ đúng nhịp của trang thật (tiêu đề chào
 * + lưới thẻ thống kê + khối biểu đồ + bảng) để nội dung thế vào không
 * đẩy bố cục. Dùng cho Suspense fallback ở route gốc và các pha chờ dữ
 * liệu bên trong trang tổng quan.
 */
export function DashboardSkeleton() {
  return (
    <main className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6" aria-hidden="true">
      <Skeleton className="mx-4 h-8 w-72 lg:mx-6" />
      <div className="grid grid-cols-1 gap-4 px-4 sm:grid-cols-2 lg:px-6 xl:grid-cols-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <Skeleton className="mx-4 h-72 lg:mx-6" />
      <Skeleton className="mx-4 h-64 lg:mx-6" />
    </main>
  );
}
