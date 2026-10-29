/**
 * Khuôn SSR-data dùng chung cho các route tầng SL (server loader +
 * dehydrate) — lát SL-1 của chương trình #7, theo bảng phân tầng route
 * (hồ sơ `route-tiering-table-2026-10-26.md` mục 2/3/6).
 *
 * Flow tổng thể của một route SL:
 *   1. Loader của route chạy PHÍA SERVER với request thật; nếu request
 *      không mang cookie phiên Better Auth thì KHÔNG gọi API nghiệp vụ
 *      nào — trả dehydrated state rỗng (mặt công khai/khách ẩn danh giữ
 *      nguyên hành vi, trang tự tải phía client như trước SL).
 *   2. Có cookie phiên → loader tạo MỘT QueryClient riêng của lượt
 *      (không dùng chung giữa các request — cache dùng chung trên tiến
 *      trình SSR sẽ rò dữ liệu giữa người dùng), prefetch đúng các
 *      query key hiện hữu của trang bằng cookie CỦA CHÍNH request đó
 *      (qua `fetchApiJsonForRequest` ở `lib/server-api.ts`: API vẫn là
 *      nơi quyết quyền bằng capability, loader không tự suy quyền).
 *   3. Loader trả `{ dehydratedState }`; root.tsx gom state này từ dữ
 *      liệu loader của route con và bọc cây bằng `HydrationBoundary`
 *      → các `useQuery` của trang đọc ngay dữ liệu đã hydrate, không
 *      fetch trùng trong cửa sổ tươi (staleTime) khi vào trang. Đột
 *      biến phía client vẫn invalidate/refetch như trước SL — loader
 *      chỉ thay lượt tải ĐẦU TIÊN.
 *
 * Bất biến an toàn: query nào prefetch THẤT BẠI phía server (API lỗi,
 * 403 do quyền vừa đổi…) thì KHÔNG được dehydrate ở trạng thái thành
 * công — `serverQueryFn` ném lỗi để trạng thái query là lỗi, mà
 * `dehydrate` mặc định chỉ mang query thành công; phía client khi đó
 * fetch lại theo đúng hành vi cũ. Nhờ vậy một lượt SSR lỗi không bao
 * giờ "đóng băng" dữ liệu rỗng/null giả vào cache của trang.
 */
import { dehydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';
import { createQueryClient } from '#lib/query-client';
import { fetchApiJsonForRequest, fetchApiJsonForRequestOrThrow } from '#lib/server-api';

/** Hình dạng dữ liệu loader mà mọi route tầng SL trả về cho root.tsx gom qua HydrationBoundary. */
export interface SsrLoaderData {
  dehydratedState: DehydratedState;
}

/**
 * Request có mang cookie phiên Better Auth hay không — cùng mẫu nhận
 * diện với loader gốc ở root.tsx (bản https có tiền tố `__Secure-`).
 * Đây là cổng duy nhất quyết định loader SL có được gọi API nghiệp vụ
 * hay không: không cookie = chắc chắn ẩn danh.
 *
 * @param request - Request đang được loader phục vụ.
 * @returns true khi header Cookie chứa cookie phiên Better Auth.
 */
export function hasSessionCookie(request: Request): boolean {
  const cookie = request.headers.get('Cookie') ?? '';
  return /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(cookie);
}

/**
 * queryFn phía server cho một endpoint đọc: gọi API nội bộ bằng cookie
 * của chính request qua hợp đồng NGHIÊM (`fetchApiJsonForRequestOrThrow`
 * ở `lib/server-api.ts`) và TRẢ dữ liệu đã parse. HTTP lỗi thì
 * `ApiError` mang đúng status được ném nguyên ra — query mang trạng
 * thái lỗi và bị loại khỏi dehydrated state (xem bất biến an toàn ở
 * đầu file), ĐỒNG THỜI chính sách retry của QueryClient nhận diện
 * được status nên không thử lại 401/403/404 (trước đây status bị nuốt
 * thành null rồi ném Error chung, một đáp ứng 403 vẫn bị gọi 3 lượt).
 * Signal hủy của TanStack Query được chuyển tiếp xuống lượt fetch để
 * lượt prefetch bị hủy thì request nội bộ cũng dừng. Riêng thân đáp
 * ứng 200 là `null` vẫn coi là lỗi như trước (có endpoint trả null khi
 * không có dữ liệu — ví dụ token xuất lịch — và phía client cũng
 * không coi null là dữ liệu hợp lệ của query đó).
 *
 * @param request - Request đang được loader phục vụ (nguồn cookie).
 * @param path - Đường dẫn API đầy đủ, gồm cả `/api/v1` và query string.
 * @returns Hàm queryFn dùng cho prefetchQuery/prefetchInfiniteQuery.
 */
export function serverQueryFn<T>(
  request: Request,
  path: string,
): (context?: { signal?: AbortSignal }) => Promise<T> {
  return async (context) => {
    const body = await fetchApiJsonForRequestOrThrow(request, path, context?.signal);
    if (body === null) throw new Error(`SSR prefetch failed: ${path}`);
    return body as T;
  };
}

/**
 * Biến thể "dò" (probe) cho các endpoint mà phía client vốn nuốt lỗi
 * thành null (mẫu `fetchCourseGradeData`): trả dữ liệu khi gọi được,
 * null khi lỗi — KHÔNG ném, vì null ở đây là một kết quả hợp lệ mà
 * phía client cũng tự suy ra khi endpoint lỗi độc lập.
 *
 * @param request - Request đang được loader phục vụ (nguồn cookie).
 * @param path - Đường dẫn API đầy đủ.
 * @returns Dữ liệu đã parse, hoặc null khi không gọi được.
 */
export async function serverProbe<T>(request: Request, path: string): Promise<T | null> {
  const body = await fetchApiJsonForRequest(request, path);
  return (body as T | null) ?? null;
}

/**
 * Dựng dữ liệu loader cho một route tầng SL theo đúng flow ở đầu file:
 * tạo QueryClient riêng của lượt, chỉ prefetch khi request có cookie
 * phiên, rồi dehydrate. Hàm `prefetch` nhận client + request để tự
 * khai các query của trang; mọi prefetch bên trong đều nuốt lỗi vào
 * trạng thái query (prefetchQuery không ném) nên một endpoint hỏng
 * không làm sập loader của cả trang.
 *
 * @param request - Request đang được loader phục vụ.
 * @param prefetch - Callback khai các lượt prefetch của trang.
 * @returns `{ dehydratedState }` — rỗng khi ẩn danh hoặc mọi prefetch đều lỗi.
 */
export async function buildSsrLoaderData(
  request: Request,
  prefetch: (queryClient: QueryClient, request: Request) => Promise<void>,
): Promise<SsrLoaderData> {
  const queryClient = createQueryClient();
  if (hasSessionCookie(request)) {
    await prefetch(queryClient, request);
  }
  return { dehydratedState: dehydrate(queryClient) };
}
