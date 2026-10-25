import { isRouteErrorResponse, useRevalidator } from 'react-router';
import { Button } from '@lms/ui/components/button';

/**
 * Biên lỗi DÙNG CHUNG cho mọi route lá (F-07 của rà soát #133, việc
 * #146): trước đây chỉ root có ErrorBoundary nên lỗi render/loader của
 * một trang con thổi bay cả khung (sidebar + header) về trang lỗi toàn
 * màn hình. Nay mỗi route module xuất biên này nên lỗi được chứa ngay
 * trong vùng nội dung của trang đó — khung vẫn render bình thường —
 * và biên gốc ở root chỉ còn là lớp cuối cho lỗi của chính khung/root.
 *
 * Nội dung theo đúng khuôn biên gốc: lỗi route (404…) hiện
 * status/statusText, lỗi thường hiện câu chung (không lộ chi tiết lỗi),
 * kèm nút Thử lại (revalidate — chạy lại loader và dựng lại route) và
 * đường về trang chủ.
 */
export function RouteErrorBoundary({ error }: { error: unknown }) {
  const revalidator = useRevalidator();
  const message = isRouteErrorResponse(error)
    ? `${error.status} — ${error.statusText}`
    : 'Đã xảy ra lỗi không mong muốn.';
  return (
    <main className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <h1 className="text-xl font-semibold">Không tải được trang này</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex items-center gap-4">
        <Button type="button" onClick={() => revalidator.revalidate()}>
          Thử lại
        </Button>
        <a href="/" className="text-sm underline underline-offset-4">
          Về trang chủ
        </a>
      </div>
    </main>
  );
}
