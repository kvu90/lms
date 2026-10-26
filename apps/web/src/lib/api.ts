import type { ProblemDetails } from '@lms/contracts';
import { problemDetailsSchema } from '@lms/contracts';

/**
 * Tầng gọi API nghiệp vụ của web (issue #7, Giai đoạn 2 — cutover
 * phiên cookie): từ cutover, web KHÔNG còn giữ credential nào ở
 * localStorage. Mọi request đi cùng nguồn và trình duyệt tự mang
 * cookie phiên Better Auth (xem `lib/auth-client.ts`); phía API, guard
 * phiên dịch cookie thành danh tính cho mọi endpoint như trước đây
 * Bearer JWT từng làm. Hệ quả trực tiếp: không còn vòng refresh token
 * phía client — phiên hết hạn thì API trả 401 và tầng phiên
 * (AuthProvider) resolve về ẩn danh, khung đưa người dùng về đăng
 * nhập.
 */

/**
 * Chuyển hướng toàn trang tới một URL ngoài hệ thống (trang authorize
 * của nhà cung cấp OAuth). Gói thành hàm riêng có tên để các luồng
 * đăng nhập ngoài dùng chung một biên điều hướng — và để test thay
 * được biên này, vì jsdom khoá cứng `window.location` (không mock
 * trực tiếp được thuộc tính href).
 */
export function redirectToExternalUrl(url: string): void {
  window.location.href = url;
}

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
  }
}

/**
 * Lỗi kiểu riêng cho bước thách thức hai lớp: khi sign-in bằng mật
 * khẩu trả `twoFactorRedirect`, phía server CHƯA tạo phiên nào — trang
 * login phải chuyển sang bước nhập mã TOTP/mã dự phòng rồi hoàn tất
 * qua client twoFactor. Tách thành class riêng để tầng giao diện phân
 * biệt bằng `instanceof` thay vì dò hình dạng đáp ứng.
 */
export class TwoFactorRedirectError extends Error {
  constructor() {
    super('Two-factor authentication is required to finish signing in');
    this.name = 'TwoFactorRedirectError';
  }
}

async function parseProblem(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const parsed = problemDetailsSchema.safeParse(body);
  return new ApiError(
    parsed.success
      ? parsed.data
      : { type: 'about:blank', title: res.statusText, status: res.status, code: 'http.unknown' },
  );
}

/**
 * Chuẩn hoá lỗi từ client Better Auth (hình `{ status, code, message }`
 * của better-fetch) về ApiError/Problem Details để các bề mặt hiển thị
 * lỗi dùng chung một đường như lỗi của API nghiệp vụ. `detail` mang
 * message gốc của server (ví dụ "Invalid username or password") — đó
 * là thông điệp đã được phía auth kiểm soát cho người dùng cuối.
 */
export function apiErrorFromAuthClient(error: { status?: number; code?: string; message?: string }): ApiError {
  const status = error.status ?? 400;
  const message = error.message ?? 'Yêu cầu thất bại';
  return new ApiError({
    type: 'about:blank',
    title: message,
    status,
    detail: message,
    code: error.code ?? 'auth.request_failed',
  });
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  // FormData phải để trình duyệt tự đặt Content-Type multipart kèm boundary — ép JSON sẽ làm hỏng mọi tải lên.
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  // Cookie phiên đi kèm tường minh: cùng nguồn trình duyệt vốn đã gửi,
  // khai rõ để các môi trường nhúng (test, iframe cùng nguồn) giữ đúng
  // một hành vi.
  return fetch(path, { ...init, headers, credentials: 'same-origin' });
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) throw await parseProblem(res);
  return (await res.json()) as T;
}
