import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LoginResponse, UserProfile } from '@lms/contracts';
import { userProfileSchema } from '@lms/contracts';
import {
  apiFetch,
  loginWithOAuthHandoff,
  loginWithPassword,
  logoutSession,
  tokenStore,
  verifyMfaChallenge,
} from './api';
import { queryClient } from './query-client';

interface AuthState {
  user: UserProfile | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<UserProfile>;
  completeMfaLogin: (challengeToken: string, code: string) => Promise<UserProfile>;
  loginWithHandoff: (code: string) => Promise<UserProfile>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * `initialUser` do loader gốc (root.tsx) cấp khi SSR: trạng thái phiên
 * khởi tạo của server và của lần render đầu phía client PHẢI giống hệt
 * nhau để hydrate không lệch. Không truyền prop này (test, nhúng ngoài
 * cây route) thì giữ hành vi cũ: bắt đầu ở pha đang tải rồi resolve
 * phía client. Truyền vào (kể cả null) nghĩa là phiên đã được xác định
 * phía server — không hiện khung chờ nữa.
 */
export function AuthProvider({ children, initialUser }: { children: ReactNode; initialUser?: UserProfile | null }) {
  const [user, setUser] = useState<UserProfile | null>(initialUser ?? null);
  const [loading, setLoading] = useState(initialUser === undefined);

  const reload = useCallback(async () => {
    if (!tokenStore.access) {
      // Không có token ở client storage: thử phiên cookie (luồng
      // session của API, cũng là phiên loader gốc đã đọc phía server)
      // trước khi kết luận ẩn danh — nếu không, người dùng phiên
      // cookie sẽ bị đá về ẩn danh ngay sau hydrate dù server vừa
      // render đúng danh tính của họ.
      try {
        const res = await apiFetch('/api/v1/auth/session/me');
        if (res.ok) {
          setUser(userProfileSchema.parse(await res.json()));
          setLoading(false);
          return;
        }
      } catch {
        // Mạng lỗi → coi như ẩn danh, đúng suy biến mềm của luồng cũ.
      }
      setUser(null);
      setLoading(false);
      return;
    }
    const res = await apiFetch('/api/v1/users/me');
    if (res.ok) setUser(userProfileSchema.parse(await res.json()));
    else {
      setUser(null);
      tokenStore.clear();
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Khâu chung của mọi đường đăng nhập sau khi đã có cặp token được
   * lưu: đổi phiên = đổi danh tính nên bỏ toàn bộ cache truy vấn của
   * phiên cũ (không để dữ liệu/quyền của người trước lọt sang người
   * mới), rồi nạp hồ sơ của người vừa đăng nhập.
   */
  const establishSession = useCallback(async (exchange: () => Promise<LoginResponse>) => {
    await exchange();
    queryClient.clear();
    const res = await apiFetch('/api/v1/users/me');
    const profile = userProfileSchema.parse(await res.json());
    setUser(profile);
    return profile;
  }, []);

  /**
   * Đăng nhập bằng mật khẩu: khi tài khoản đã bật MFA, tầng API ném
   * `MfaChallengeError` mang challengeToken — lỗi này truyền nguyên
   * vẹn lên trang login để trang chuyển sang bước nhập mã TOTP.
   */
  const login = useCallback(
    (username: string, password: string) => establishSession(() => loginWithPassword(username, password)),
    [establishSession],
  );

  /** Hoàn tất đăng nhập sau bước thách thức MFA bằng mã TOTP. */
  const completeMfaLogin = useCallback(
    (challengeToken: string, code: string) => establishSession(() => verifyMfaChallenge(challengeToken, code)),
    [establishSession],
  );

  /** Đăng nhập bằng mã bàn giao một lần từ callback OAuth. */
  const loginWithHandoff = useCallback(
    (code: string) => establishSession(() => loginWithOAuthHandoff(code)),
    [establishSession],
  );

  const logout = useCallback(async () => {
    await logoutSession();
    queryClient.clear();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, completeMfaLogin, loginWithHandoff, logout, reload }),
    [user, loading, login, completeMfaLogin, loginWithHandoff, logout, reload],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
