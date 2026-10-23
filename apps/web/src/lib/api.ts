import type { LoginResponse, MfaChallengeResponse, ProblemDetails, TokenPair } from '@lms/contracts';
import { loginResponseSchema, mfaChallengeResponseSchema, problemDetailsSchema, tokenPairSchema } from '@lms/contracts';

const ACCESS_KEY = 'lms.accessToken';
const REFRESH_KEY = 'lms.refreshToken';

export const tokenStore = {
  get access(): string | null {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh(): string | null {
    return localStorage.getItem(REFRESH_KEY);
  },
  save(pair: TokenPair): void {
    localStorage.setItem(ACCESS_KEY, pair.accessToken);
    localStorage.setItem(REFRESH_KEY, pair.refreshToken);
  },
  clear(): void {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

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
 * Lỗi kiểu riêng cho bước thách thức MFA: đáp ứng của POST /auth/token
 * khi tài khoản đã bật xác thực hai lớp KHÔNG phải lỗi HTTP mà cũng
 * chưa phải phiên đăng nhập — nó mang `challengeToken` ngắn hạn để
 * trang login chuyển sang bước nhập mã TOTP rồi gọi
 * `completeMfaLogin`. Tách thành class riêng để tầng giao diện phân
 * biệt bằng `instanceof` thay vì dò hình dạng đáp ứng.
 */
export class MfaChallengeError extends Error {
  constructor(public readonly challenge: MfaChallengeResponse) {
    super('Multi-factor authentication is required to finish signing in');
    this.name = 'MfaChallengeError';
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

let refreshing: Promise<boolean> | null = null;
/** Single-flight refresh: concurrent 401s share one rotation (rotation invalidates the old token, so parallel refreshes would self-revoke). */
export function refreshTokens(): Promise<boolean> {
  refreshing ??= (async () => {
    const refreshToken = tokenStore.refresh;
    if (!refreshToken) return false;
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      tokenStore.clear();
      return false;
    }
    tokenStore.save(tokenPairSchema.parse(await res.json()));
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function apiFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  const access = tokenStore.access;
  if (access) headers.set('Authorization', `Bearer ${access}`);
  // FormData phải để trình duyệt tự đặt Content-Type multipart kèm boundary — ép JSON sẽ làm hỏng mọi tải lên.
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && retry && tokenStore.refresh) {
    if (await refreshTokens()) return apiFetch(path, init, false);
  }
  return res;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) throw await parseProblem(res);
  return (await res.json()) as T;
}

/**
 * Đăng nhập bằng mật khẩu: đáp ứng thành công có HAI hình dạng theo
 * hợp đồng — cặp token (đăng nhập xong ngay) hoặc thách thức MFA khi
 * tài khoản đã bật hai lớp. Thách thức được nhận diện bằng schema
 * riêng của contracts TRƯỚC khi thử parse cặp token, và được ném ra
 * dưới dạng `MfaChallengeError` (không lưu token nào ở bước này).
 */
export async function loginWithPassword(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch('/api/v1/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await parseProblem(res);
  const body: unknown = await res.json();
  const challenge = mfaChallengeResponseSchema.safeParse(body);
  if (challenge.success) throw new MfaChallengeError(challenge.data);
  const parsed = loginResponseSchema.parse(body);
  tokenStore.save(parsed);
  return parsed;
}

/**
 * Hoàn tất bước MFA: đổi `challengeToken` + mã TOTP 6 số lấy cặp token
 * như đăng nhập thường (POST /auth/mfa/verify). Mã sai hoặc challenge
 * hết hạn được API trả về dạng Problem Details như mọi lỗi khác.
 */
export async function verifyMfaChallenge(challengeToken: string, code: string): Promise<LoginResponse> {
  const res = await fetch('/api/v1/auth/mfa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken, code }),
  });
  if (!res.ok) throw await parseProblem(res);
  const parsed = loginResponseSchema.parse(await res.json());
  tokenStore.save(parsed);
  return parsed;
}

/**
 * Đổi mã bàn giao một lần (handoff) sau callback OAuth lấy cặp token
 * như đăng nhập thường (POST /auth/oauth/handoff): callback của nhà
 * cung cấp chỉ chuyển hướng về SPA kèm mã này, token không bao giờ đi
 * qua URL.
 */
export async function loginWithOAuthHandoff(code: string): Promise<LoginResponse> {
  const res = await fetch('/api/v1/auth/oauth/handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw await parseProblem(res);
  const parsed = loginResponseSchema.parse(await res.json());
  tokenStore.save(parsed);
  return parsed;
}

export async function logoutSession(): Promise<void> {
  const refreshToken = tokenStore.refresh;
  tokenStore.clear();
  if (refreshToken) {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => undefined);
  }
}
