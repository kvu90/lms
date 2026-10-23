import type { LoginResponse, ProblemDetails, TokenPair } from '@lms/contracts';
import { loginResponseSchema, problemDetailsSchema, tokenPairSchema } from '@lms/contracts';

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

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
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
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
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

export async function loginWithPassword(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch('/api/v1/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
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
