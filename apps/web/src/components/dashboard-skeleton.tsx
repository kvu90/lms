import { Skeleton } from '@/components/ui/skeleton';

/**
 * Khung giữ chỗ cho nội dung trang tổng quan trong lúc chunk trang hoặc
 * dữ liệu phân loại vai trò đang tải: giữ đúng nhịp của trang thật —
 * main là container "main" như trang thật, tiêu đề chào, tiêu đề khối,
 * lưới thẻ thống kê (ô cao 158px như thẻ thật, cùng lớp lưới với
 * SectionCards), thẻ biểu đồ (~388px) và khối bảng — để nội dung thế
 * vào không đẩy bố cục.
 */
export function DashboardSkeleton() {
  return (
    <main className="@container/main flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6" aria-hidden="true">
      <Skeleton className="mx-4 h-8 w-72 lg:mx-6" />
      <Skeleton className="mx-4 h-7 w-48 lg:mx-6" />
      <div className="grid grid-cols-1 gap-4 px-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 lg:px-6">
        <Skeleton className="h-[158px]" />
        <Skeleton className="h-[158px]" />
        <Skeleton className="h-[158px]" />
        <Skeleton className="h-[158px]" />
      </div>
      <Skeleton className="mx-4 h-[388px] lg:mx-6" />
      <Skeleton className="mx-4 h-[300px] lg:mx-6" />
    </main>
  );
}
