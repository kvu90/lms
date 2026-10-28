/**
 * Điểm chạm phía SERVER của các loader (SSR, Giai đoạn 3–4 của issue #7).
 *
 * Loader chạy trong tiến trình SSR và gọi API qua địa chỉ nội bộ
 * (topology C: API ở cùng một máy, địa chỉ mặc định 127.0.0.1:3000,
 * ghi đè bằng biến môi trường `LMS_API_INTERNAL_URL`) — KHÔNG vòng qua
 * URL công khai của chính app. Module này chỉ được loader import;
 * React Router tự loại loader khỏi bản build phía client nên mã này
 * không chạy trên trình duyệt.
 *
 * Hai hợp đồng gọi API sống cạnh nhau, chọn theo nhu cầu của caller:
 *
 *   1. Hợp đồng MỀM (`fetchApiJson`, `fetchApiJsonForRequest`): mọi
 *      lỗi (mạng, HTTP status) đều suy biến thành null để loader của
 *      các bề mặt công khai (root, health, login) tự rơi về hành vi
 *      tải phía client thay vì làm sập trang. Caller của hợp đồng này
 *      không cần biết status.
 *   2. Hợp đồng NGHIÊM (`fetchApiJsonOrThrow`,
 *      `fetchApiJsonForRequestOrThrow`): HTTP lỗi thì NÉM `ApiError`
 *      mang ĐÚNG status của đáp ứng (dựng từ thân Problem Details của
 *      API khi parse được), lỗi mạng thì lan truyền nguyên lỗi gốc.
 *      Đường prefetch của TanStack Query (`serverQueryFn` ở
 *      `lib/ssr-data.ts`) dùng hợp đồng này để chính sách retry của
 *      QueryClient nhận diện được `ApiError` và KHÔNG thử lại các
 *      status 401/403/404 — trước đây hợp đồng mềm nuốt status thành
 *      null rồi tầng trên ném Error chung, nên một đáp ứng 403 vẫn bị
 *      QueryClient gọi lại đủ 3 lượt trong lúc SSR.
 *
 * Mọi lượt gọi phía server đều mang timeout {@link SSR_FETCH_TIMEOUT_MS}:
 * API nội bộ treo không được phép treo theo cả lượt render SSR; caller
 * có signal riêng (signal hủy của TanStack Query) thì hai signal được
 * gộp bằng `AbortSignal.any` — hủy bên nào cũng dừng lượt gọi.
 */
import { problemDetailsSchema } from '@lms/contracts';
import { ApiError } from './api';

/** Trần thời gian cho MỘT lượt gọi API nội bộ phía server (mili giây). */
export const SSR_FETCH_TIMEOUT_MS = 10_000;

export function apiInternalBase(): string {
  return process.env.LMS_API_INTERNAL_URL ?? 'http://127.0.0.1:3000';
}

/**
 * Dựng signal hiệu lực cho một lượt gọi phía server: timeout cố định
 * {@link SSR_FETCH_TIMEOUT_MS} gộp với signal của caller (nếu có).
 *
 * @param callerSignal - Signal hủy của caller, ví dụ signal của TanStack Query.
 * @returns Signal đã gộp; hủy khi caller hủy HOẶC hết timeout.
 */
function internalSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SSR_FETCH_TIMEOUT_MS);
  return callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
}

/**
 * Dựng `ApiError` từ một đáp ứng HTTP lỗi của API nội bộ — cùng khuôn
 * với `parseProblem` phía client (`lib/api.ts`): thân đáp ứng parse
 * được bằng schema Problem Details thì dùng nguyên, không parse được
 * thì dựng Problem Details tối thiểu mang ĐÚNG status thật và mã
 * `http.unknown`. Điểm cốt yếu là status không bao giờ bị mất.
 *
 * @param res - Đáp ứng HTTP lỗi từ API nội bộ.
 * @returns ApiError mang status thật của đáp ứng.
 */
async function toApiError(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const parsed = problemDetailsSchema.safeParse(body);
  return new ApiError(
    parsed.success
      ? parsed.data
      : { type: 'about:blank', title: res.statusText, status: res.status, code: 'http.unknown' },
  );
}

/** Gọi API nội bộ và parse JSON; mọi lỗi (mạng, status) đều trả null để loader suy biến mềm thay vì làm sập trang. */
export async function fetchApiJson(path: string, headers?: Record<string, string>): Promise<unknown> {
  try {
    const res = await fetch(`${apiInternalBase()}${path}`, { headers, signal: internalSignal() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Bản NGHIÊM của {@link fetchApiJson}: thành công (HTTP 2xx) thì trả
 * thân JSON đã parse; HTTP lỗi thì ném {@link ApiError} mang đúng
 * status; lỗi mạng/timeout/hủy thì lan truyền nguyên lỗi gốc (không
 * nuốt thành null, không gói lại) để tầng trên phân biệt được "API từ
 * chối" với "không gọi được API".
 *
 * @param path - Đường dẫn API đầy đủ, gồm cả `/api/v1`.
 * @param headers - Header kèm theo, ví dụ Cookie của request đang phục vụ.
 * @param callerSignal - Signal hủy của caller, được gộp với timeout phía server.
 * @returns Thân JSON của đáp ứng thành công.
 */
export async function fetchApiJsonOrThrow(
  path: string,
  headers?: Record<string, string>,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(`${apiInternalBase()}${path}`, {
    headers,
    signal: internalSignal(callerSignal),
  });
  if (!res.ok) throw await toApiError(res);
  return await res.json();
}

/**
 * Cơ chế loader dữ liệu theo danh tính cookie (Giai đoạn 4): chuyển
 * NGUYÊN header Cookie của chính request đang phục vụ sang API nội bộ —
 * loader của một route chỉ bao giờ lấy được dữ liệu mà đúng cookie đó
 * được phép thấy, không có đường nào lấy dữ liệu của người khác. Không
 * có cookie thì không gọi API và trả null (trang suy biến về hành vi tải
 * phía client như trước). Từ Giai đoạn 2 (cutover hoàn tất): phiên là
 * cookie Better Auth và guard phía API dịch cookie đó thành danh tính
 * cho mọi endpoint, nên helper này lấy được dữ liệu thật phía server
 * cho mọi loader dùng cookie của request.
 */
export async function fetchApiJsonForRequest(request: Request, path: string): Promise<unknown> {
  const cookie = request.headers.get('Cookie') ?? '';
  if (!cookie) return null;
  return fetchApiJson(path, { Cookie: cookie });
}

/**
 * Bản NGHIÊM của {@link fetchApiJsonForRequest} cho đường prefetch của
 * TanStack Query: không có cookie thì vẫn trả null như hợp đồng mềm
 * (ẩn danh là trạng thái hợp lệ, không phải lỗi); có cookie thì gọi
 * theo hợp đồng nghiêm — HTTP lỗi ném `ApiError` đúng status để chính
 * sách retry tôn trọng 401/403/404.
 *
 * @param request - Request đang được loader phục vụ (nguồn cookie).
 * @param path - Đường dẫn API đầy đủ, gồm cả `/api/v1`.
 * @param callerSignal - Signal hủy của TanStack Query cho lượt prefetch này.
 * @returns Thân JSON của đáp ứng thành công, hoặc null khi request không có cookie.
 */
export async function fetchApiJsonForRequestOrThrow(
  request: Request,
  path: string,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  const cookie = request.headers.get('Cookie') ?? '';
  if (!cookie) return null;
  return fetchApiJsonOrThrow(path, { Cookie: cookie }, callerSignal);
}
