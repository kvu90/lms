import { createAuthClient } from 'better-auth/react';
import { emailOTPClient, twoFactorClient, usernameClient } from 'better-auth/client/plugins';

/**
 * Client Better Auth của web (issue #7, Giai đoạn 2 — cutover phiên
 * cookie): điểm chạm DUY NHẤT của web với các endpoint phiên của
 * Better Auth. Handler phía API được mount tại `/api/v1/auth` (xem
 * `BETTER_AUTH_BASE_PATH` phía api) nên client khai `basePath` tương
 * ứng và `baseURL` là origin hiện tại — web và API cùng nguồn (tiến
 * trình SSR proxy /api về API nội bộ), cookie phiên do trình duyệt tự
 * mang theo mọi request cùng nguồn.
 *
 * Bộ plugin client phải khớp bộ plugin phía server mà các bề mặt web
 * dùng: `usernameClient` (đăng nhập bằng tên đăng nhập),
 * `twoFactorClient` (bước hai TOTP/mã dự phòng sau khi sign-in trả
 * `twoFactorRedirect`), `emailOTPClient` (đăng nhập bằng mã OTP gửi
 * qua email — endpoint do đội BA-2 bật phía server).
 *
 * Module này được import cả khi render phía server (cây provider bọc
 * ở root): việc tạo client chỉ là dựng cấu hình + bộ nhớ đệm phiên,
 * không gọi mạng lúc khởi tạo; các lời gọi thật (fetch phiên) chỉ chạy
 * trong effect phía client nên SSR không cần origin — `baseURL` để
 * undefined ở phía server.
 */
export const authClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? undefined : window.location.origin,
  basePath: '/api/v1/auth',
  plugins: [usernameClient(), twoFactorClient(), emailOTPClient()],
  fetchOptions: {
    /**
     * Better Auth tự ghim `customFetchImpl: fetch` tại thời điểm tạo
     * client (xem getClientConfig của package) — tức bắt cứng tham
     * chiếu fetch lúc import module. Uỷ thác qua `globalThis.fetch`
     * khôi phục ngữ nghĩa mặc định của better-fetch (tra fetch tại
     * thời điểm gọi): trên trình duyệt hành vi không đổi, còn test
     * stub được fetch ở biên như mọi lời gọi khác của web.
     */
    customFetchImpl: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  },
});

/** Hook phiên dùng chung: AuthProvider là nơi duy nhất tiêu thụ trực tiếp. */
export const { useSession } = authClient;
