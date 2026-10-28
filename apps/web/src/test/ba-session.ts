/**
 * Hỗ trợ stub phiên Better Auth cho các spec sau cutover phiên cookie
 * (issue #7, GĐ2). Client BA gọi `GET {origin}/api/v1/auth/get-session`
 * bằng URL TUYỆT ĐỐI (origin jsdom là `http://localhost:3000`) trong
 * khi `apiFetch` của web gọi bằng URL tương đối — stub fetch của spec
 * nhận diện lời gọi phiên bằng hậu tố đường dẫn này.
 *
 * `user.id` trong thân phiên phải KHỚP id của hồ sơ mà stub
 * `/api/v1/users/me` của chính spec đó trả: AuthProvider đồng bộ hồ
 * sơ hiển thị theo id người dùng của phiên rồi mới nạp `/users/me`.
 */
export function isGetSessionUrl(url: unknown): boolean {
  return String(url).endsWith('/api/v1/auth/get-session');
}

/**
 * Thân đáp ứng get-session khi đã có phiên (đúng hình BA trả).
 *
 * Mọi mốc thời gian tính TƯƠNG ĐỐI theo thời điểm chạy: `expiresAt`
 * luôn ở tương lai đủ xa (30 ngày) và `createdAt`/`updatedAt` là hiện
 * tại. Fixture dùng chung này từng ghim ngày hết hạn cứng theo lịch —
 * tới ngày đó toàn bộ spec dùng chung đỏ đồng loạt dù code không đổi —
 * nên mốc tuyệt đối bị cấm ở đây: phiên stub không được hết hạn theo
 * lịch bao giờ nữa.
 */
export function baSessionBody(user: { id: string; username?: string; email?: string; name?: string }) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    session: {
      id: '01900000-0000-7000-8000-000000000101',
      userId: user.id,
      token: 'session-token',
      expiresAt,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    user: {
      id: user.id,
      username: user.username ?? 'user',
      name: user.name ?? 'Test User',
      email: user.email ?? 'user@example.com',
      emailVerified: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  };
}

export function baSessionResponse(user: { id: string; username?: string; email?: string; name?: string }): Response {
  return new Response(JSON.stringify(baSessionBody(user)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Đáp ứng get-session khi chưa có phiên: BA trả 200 với thân `null`. */
export function baNoSessionResponse(): Response {
  return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
}
