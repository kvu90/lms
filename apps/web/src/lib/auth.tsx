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
  /** Nạp lại phiên từ cookie; true khi đã áp được một kết luận phiên. */
  reload: () => Promise<boolean>;
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

  /**
   * Lần nạp hồ sơ đang bay (theo id phiên). Hai đường resolve phiên —
   * effect theo atom của Better Auth và `reload` chủ động lúc mount —
   * có thể chạy chồng nhau; một id phiên chỉ được có MỘT lần gọi
   * `/users/me` tại một thời điểm, các đường còn lại chờ chung kết
   * quả, tránh gọi trùng (và tránh đọc hai lần cùng một đáp ứng ở
   * các biên dùng đáp ứng chia sẻ).
   */
  const profileFlightRef = useRef<{ id: string; promise: Promise<void> } | null>(null);

  /**
   * Đồng bộ hồ sơ hiển thị theo id người dùng của phiên BA hiện tại.
   * Không bao giờ ném lỗi ra ngoài: nạp hồ sơ thất bại (mạng, đáp ứng
   * hỏng) thì kết luận ẩn danh — fail-closed như nhánh đáp ứng lỗi,
   * và các effect gọi kiểu fire-and-forget không sinh rejection chưa
   * xử lý. `force` (đường `reload`) bỏ qua dấu đã-đồng-bộ để nạp lại
   * hồ sơ, nhưng vẫn dùng chung chuyến bay đang chạy của cùng id —
   * chuyến bay đó tự nó đã là một lần đọc mới.
   */
  const applySession = useCallback(async (sessionUserId: string | null, force = false) => {
    if (sessionUserId === null) {
      profileFlightRef.current = null;
      if (syncedForRef.current !== null) {
        syncedForRef.current = null;
        setUser(null);
      }
      setLoading(false);
      return;
    }
    const flight = profileFlightRef.current;
    if (flight && flight.id === sessionUserId) {
      await flight.promise;
      return;
    }
    if (!force && syncedForRef.current === sessionUserId) {
      setLoading(false);
      return;
    }
    syncedForRef.current = sessionUserId;
    // Bản ghi chuyến bay được đặt vào ref TRƯỚC khi thân bất đồng bộ
    // chạy: thân tự nhận biết mình còn là chuyến bay hiện hành hay đã
    // bị một lần resolve mới hơn thay thế bằng cách so chính bản ghi.
    const record: { id: string; promise: Promise<void> } = {
      id: sessionUserId,
      promise: Promise.resolve(),
    };
    profileFlightRef.current = record;
    record.promise = (async () => {
      try {
        const res = await apiFetch('/api/v1/users/me');
        // Đã có lần resolve mới hơn thay thế chuyến bay này (đăng
        // nhập/đăng xuất/xoá phiên chen vào): không áp kết quả cũ,
        // cũng không đọc thân đáp ứng nữa.
        if (profileFlightRef.current !== record) return;
        if (res.ok) setUser(userProfileSchema.parse(await res.json()));
        else setUser(null);
      } catch {
        if (profileFlightRef.current === record) setUser(null);
      }
      if (profileFlightRef.current === record) setLoading(false);
    })();
    try {
      await record.promise;
    } finally {
      if (profileFlightRef.current === record) profileFlightRef.current = null;
    }
  }, []);

  /**
   * Cổng chốt lần resolve lúc mount ở chế độ resolve phía client:
   * atom phiên của BA giữ giá trị của lần fetch gần nhất qua các vòng
   * đời mount (dedupe của nanostores), nên ngay khi provider mới mount
   * nó có thể đang mang phiên của vòng đời TRƯỚC — giá trị đó không
   * được áp trước khi lần `reload` lúc mount chốt, kẻo danh tính bị
   * kết luận theo dữ liệu cũ (kể cả bị kết luận ẩn danh oan trong lúc
   * hồ sơ của phiên thật còn đang nạp). Khi reload đã áp kết luận,
   * giá trị atom tại thời điểm chốt được ghi làm mốc đã-tiêu-thụ và
   * effect chỉ áp các giá trị atom có danh tính MỚI sau mốc đó (kết
   * quả fetch thật của atom, đăng nhập/đăng xuất qua client…).
   */
  const mountSettledRef = useRef(initialUser !== undefined);
  const consumedAtomDataRef = useRef<unknown>(undefined);
  const sessionDataRef = useRef(session.data);
  sessionDataRef.current = session.data;
  const [mountTick, setMountTick] = useState(0);

  useEffect(() => {
    // Phiên còn đang resolve phía client thì không đụng trạng thái đã
    // seed từ loader — tránh việc SSR vừa render đúng danh tính lại bị
    // pha chờ của client xoá mất trước khi get-session trả về.
    if (session.isPending) return;
    if (!mountSettledRef.current) return;
    if (consumedAtomDataRef.current === session.data) return;
    consumedAtomDataRef.current = session.data;
    void applySession(session.data?.user?.id ?? null);
  }, [session.data, session.isPending, applySession, mountTick]);

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
  const reload = useCallback(async (): Promise<boolean> => {
    let sessionUserId: string | null;
    try {
      const { data } = await authClient.getSession();
      sessionUserId = data?.user?.id ?? null;
    } catch {
      // Không đọc được phiên (lỗi mạng/phía client): giữ nguyên trạng
      // thái hiện tại thay vì kết luận vội — atom phiên vẫn là đường
      // resolve nền và sẽ áp kết quả của nó qua effect ở trên.
      return false;
    }
    // Buộc nạp lại hồ sơ kể cả khi id không đổi (phiên được gia hạn /
    // hồ sơ vừa bị sửa ở nơi khác).
    await applySession(sessionUserId, true);
    return true;
  }, [applySession]);

  const mountReloadedRef = useRef(false);
  useEffect(() => {
    if (initialUser !== undefined || mountReloadedRef.current) return;
    mountReloadedRef.current = true;
    let alive = true;
    void reload().then((applied) => {
      if (!alive) return;
      // Reload đã áp kết luận dứt khoát: giá trị atom hiện tại (có
      // thể là dư âm của vòng đời trước) coi như đã tiêu thụ — chỉ
      // các giá trị atom mới sau đây mới được effect áp tiếp.
      if (applied) consumedAtomDataRef.current = sessionDataRef.current;
      mountSettledRef.current = true;
      setMountTick((t) => t + 1);
    });
    return () => {
      alive = false;
    };
  }, [initialUser, reload]);

  /**
   * Khâu chung sau khi một đường đăng nhập của Better Auth đã tạo
   * phiên thành công: đổi phiên = đổi danh tính nên bỏ toàn bộ cache
   * truy vấn của phiên cũ (không để dữ liệu/quyền của người trước lọt
   * sang người mới), rồi nạp hồ sơ của người vừa đăng nhập.
   */
  const establishSession = useCallback(async (): Promise<UserProfile> => {
    queryClient.clear();
    // Đăng nhập mới thay thế mọi lần resolve hồ sơ đang bay của phiên cũ.
    profileFlightRef.current = null;
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
   * ứng dụng xác thực; mã dài hơn được gửi sang đường mã dự phòng —
   * phía API kiểm cả hai vào nguồn trạng thái MFA duy nhất
   * `user_totp` (sản phẩm hiện không phát mã dự phòng nên đường đó
   * luôn từ chối, giữ nguyên hợp đồng client).
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

  /**
   * Đăng nhập bằng mã OTP đã gửi tới email — bước 2 của luồng OTP.
   * Tài khoản đã bật MFA thì đáp ứng mang `twoFactorRedirect` và
   * chưa có phiên (cổng MFA phía API gác cả đường này) — dịch thành
   * `TwoFactorRedirectError` như luồng mật khẩu để trang login
   * chuyển sang bước nhập mã TOTP.
   */
  const loginWithEmailOtp = useCallback(
    async (email: string, otp: string): Promise<UserProfile> => {
      const { data, error } = await authClient.signIn.emailOtp({ email, otp });
      if (error) throw apiErrorFromAuthClient(error);
      const redirect = (data as { twoFactorRedirect?: unknown } | null)?.twoFactorRedirect;
      if (redirect) throw new TwoFactorRedirectError();
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
    profileFlightRef.current = null;
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
