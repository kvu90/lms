import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UserProfile } from '@lms/contracts';
import { userProfileSchema } from '@lms/contracts';
import { apiErrorFromAuthClient, apiFetch, TwoFactorRedirectError } from './api';
import { authClient, useSession } from './auth-client';
import { queryClient } from './query-client';

interface AuthState {
  user: UserProfile | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<UserProfile>;
  completeMfaLogin: (code: string) => Promise<UserProfile>;
  requestEmailOtp: (email: string) => Promise<void>;
  loginWithEmailOtp: (email: string, otp: string) => Promise<UserProfile>;
  loginWithSocial: (provider: 'google' | 'facebook') => Promise<void>;
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
 *
 * Nguồn sự thật của phiên (issue #7, GĐ2): cookie phiên Better Auth mà
 * client ở `lib/auth-client.ts` đọc qua `useSession`/`getSession`.
 * Provider này chỉ giữ HỒ SƠ hiển thị (UserProfile của contracts) —
 * nạp qua `GET /users/me` bằng chính cookie đó (guard phía API dịch
 * cookie thành danh tính) mỗi khi id người dùng của phiên thay đổi.
 */
export function AuthProvider({ children, initialUser }: { children: ReactNode; initialUser?: UserProfile | null }) {
  const [user, setUser] = useState<UserProfile | null>(initialUser ?? null);
  const [loading, setLoading] = useState(initialUser === undefined);
  const session = useSession();
  /**
   * Id người dùng của phiên mà hồ sơ hiện tại đã đồng bộ theo
   * (undefined = chưa đồng bộ lần nào, null = đã đồng bộ về ẩn danh).
   * Chặn việc nạp lại hồ sơ mỗi lần atom phiên phát cùng một giá trị.
   */
  const syncedForRef = useRef<string | null | undefined>(undefined);

  /** Đồng bộ hồ sơ hiển thị theo id người dùng của phiên BA hiện tại. */
  const applySession = useCallback(async (sessionUserId: string | null) => {
    if (sessionUserId === null) {
      if (syncedForRef.current !== null) {
        syncedForRef.current = null;
        setUser(null);
      }
      setLoading(false);
      return;
    }
    if (syncedForRef.current === sessionUserId) {
      setLoading(false);
      return;
    }
    syncedForRef.current = sessionUserId;
    const res = await apiFetch('/api/v1/users/me');
    if (res.ok) setUser(userProfileSchema.parse(await res.json()));
    else setUser(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Phiên còn đang resolve phía client thì không đụng trạng thái đã
    // seed từ loader — tránh việc SSR vừa render đúng danh tính lại bị
    // pha chờ của client xoá mất trước khi get-session trả về.
    if (session.isPending) return;
    void applySession(session.data?.user?.id ?? null);
  }, [session.data, session.isPending, applySession]);

  /**
   * Khi KHÔNG có initialUser (resolve hoàn toàn phía client — test,
   * nhúng ngoài cây route), chủ động nạp lại phiên một lần lúc mount:
   * atom phiên của Better Auth có nhịp dedupe riêng theo vòng đời
   * mount của nó (giữ trạng thái lần fetch gần nhất trong một khoảng
   * ngắn sau khi mất subscriber), nên chỉ dựa vào atom thì một
   * provider mới mount có thể kẹt ở trạng thái phiên cũ/đang dở.
   * `getSession` gọi thẳng endpoint nên lần resolve này là dứt khoát
   * theo cookie hiện tại. Có initialUser (đường SSR thật) thì loader
   * đã xác thực cookie phía server rồi — không gọi thêm.
   */
  const reload = useCallback(async () => {
    const { data } = await authClient.getSession();
    // Buộc nạp lại hồ sơ kể cả khi id không đổi (phiên được gia hạn /
    // hồ sơ vừa bị sửa ở nơi khác).
    syncedForRef.current = undefined;
    await applySession(data?.user?.id ?? null);
  }, [applySession]);

  const mountReloadedRef = useRef(false);
  useEffect(() => {
    if (initialUser !== undefined || mountReloadedRef.current) return;
    mountReloadedRef.current = true;
    void reload();
  }, [initialUser, reload]);

  /**
   * Khâu chung sau khi một đường đăng nhập của Better Auth đã tạo
   * phiên thành công: đổi phiên = đổi danh tính nên bỏ toàn bộ cache
   * truy vấn của phiên cũ (không để dữ liệu/quyền của người trước lọt
   * sang người mới), rồi nạp hồ sơ của người vừa đăng nhập.
   */
  const establishSession = useCallback(async (): Promise<UserProfile> => {
    queryClient.clear();
    const res = await apiFetch('/api/v1/users/me');
    const profile = userProfileSchema.parse(await res.json());
    syncedForRef.current = profile.id;
    setUser(profile);
    setLoading(false);
    return profile;
  }, []);

  /**
   * Đăng nhập bằng tên đăng nhập + mật khẩu qua endpoint username của
   * Better Auth. Khi tài khoản đã bật xác thực hai lớp, đáp ứng mang
   * `twoFactorRedirect` và CHƯA có phiên nào — dịch thành
   * `TwoFactorRedirectError` để trang login chuyển sang bước nhập mã.
   */
  const login = useCallback(
    async (username: string, password: string): Promise<UserProfile> => {
      const { data, error } = await authClient.signIn.username({ username, password });
      if (error) throw apiErrorFromAuthClient(error);
      const redirect = (data as { twoFactorRedirect?: unknown } | null)?.twoFactorRedirect;
      if (redirect) throw new TwoFactorRedirectError();
      return establishSession();
    },
    [establishSession],
  );

  /**
   * Hoàn tất đăng nhập sau `twoFactorRedirect`: mã 6 số là TOTP từ
   * ứng dụng xác thực; mã dài hơn là mã dự phòng (backup code) dùng
   * một lần — hai đường verify khác nhau của plugin twoFactor.
   */
  const completeMfaLogin = useCallback(
    async (code: string): Promise<UserProfile> => {
      const trimmed = code.trim();
      const { error } = /^\d{6}$/.test(trimmed)
        ? await authClient.twoFactor.verifyTotp({ code: trimmed })
        : await authClient.twoFactor.verifyBackupCode({ code: trimmed });
      if (error) throw apiErrorFromAuthClient(error);
      return establishSession();
    },
    [establishSession],
  );

  /** Xin gửi mã OTP đăng nhập (6 số) tới email — bước 1 của luồng OTP. */
  const requestEmailOtp = useCallback(async (email: string): Promise<void> => {
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
    if (error) throw apiErrorFromAuthClient(error);
  }, []);

  /** Đăng nhập bằng mã OTP đã gửi tới email — bước 2 của luồng OTP. */
  const loginWithEmailOtp = useCallback(
    async (email: string, otp: string): Promise<UserProfile> => {
      const { error } = await authClient.signIn.emailOtp({ email, otp });
      if (error) throw apiErrorFromAuthClient(error);
      return establishSession();
    },
    [establishSession],
  );

  /**
   * Đăng nhập bằng nhà cung cấp ngoài (Google/Facebook): client xin
   * URL authorize rồi TỰ chuyển hướng toàn trang tới nhà cung cấp;
   * callback của Better Auth đặt cookie phiên rồi đưa trình duyệt về
   * `/oauth/callback` để SPA resolve phiên. Lỗi cấu hình (provider
   * chưa bật phía server) trả về qua `error` trước khi rời trang.
   */
  const loginWithSocial = useCallback(async (provider: 'google' | 'facebook'): Promise<void> => {
    const { error } = await authClient.signIn.social({ provider, callbackURL: '/oauth/callback' });
    if (error) throw apiErrorFromAuthClient(error);
  }, []);

  const logout = useCallback(async () => {
    await authClient.signOut().catch(() => undefined);
    queryClient.clear();
    syncedForRef.current = null;
    setUser(null);
    setLoading(false);
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      completeMfaLogin,
      requestEmailOtp,
      loginWithEmailOtp,
      loginWithSocial,
      logout,
      reload,
    }),
    [user, loading, login, completeMfaLogin, requestEmailOtp, loginWithEmailOtp, loginWithSocial, logout, reload],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
