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

/** Thân đáp ứng get-session khi đã có phiên (đúng hình BA trả). */
export function baSessionBody(user: { id: string; username?: string; email?: string; name?: string }) {
  return {
    session: {
      id: '01900000-0000-7000-8000-000000000101',
      userId: user.id,
      token: 'session-token',
      expiresAt: '2027-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    user: {
      id: user.id,
      username: user.username ?? 'user',
      name: user.name ?? 'Test User',
      email: user.email ?? 'user@example.com',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
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
