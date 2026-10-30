import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '#lib/auth';
import { createQueryClient } from '#lib/query-client';
import { baSessionBody } from '#test/ba-session';
import { OAuthCallbackPage } from './oauth-callback';
import { ProfilePage } from '#features/profile/routes/profile';

/**
 * Trang đích sau callback OAuth của Better Auth (issue #7, GĐ2):
 * KHÔNG còn mã bàn giao trong URL — callback phía server đã đặt
 * cookie phiên, trang chỉ resolve lại phiên từ cookie qua
 * `get-session` (URL tuyệt đối của client BA) rồi sang hồ sơ.
 */

const PROFILE = {
  id: '01900000-0000-7000-8000-000000000007',
  username: 'learner',
  firstName: 'Learn',
  lastName: 'Er',
  email: 'learner@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

// Thân phiên lấy từ fixture dùng chung `baSessionBody`: mốc hết hạn
// tính tương đối theo thời điểm chạy nên không hết hạn theo lịch
// (bản tự khai trước đây ghim ngày cứng và suýt nổ cả bộ spec).
const SESSION_BODY = baSessionBody({
  id: PROFILE.id,
  username: 'learner',
  name: 'Learn Er',
  email: 'learner@example.com',
});

function renderApp(initialEntry: string) {
  const router = createMemoryRouter(
    [
      { path: '/oauth/callback', element: <OAuthCallbackPage /> },
      { path: '/profile', element: <ProfilePage /> },
      { path: '/login', element: <div>Trang đăng nhập</div> },
    ],
    { initialEntries: [initialEntry] },
  );
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Trang callback OAuth (phân giải phiên cookie, fetch mock tại biên)', () => {
  afterEach(() => {
    // Dự án không bật auto-cleanup của Testing Library nên phải dọn
    // DOM tường minh, tránh cây render của test trước sót sang test sau.
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('phân giải phiên cookie và tới hồ sơ mà không cần trao đổi handoff nào', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith('/api/v1/auth/get-session')) return jsonResponse(SESSION_BODY);
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        if (url === '/api/v1/auth/oauth/links') return jsonResponse({ links: [], hasPassword: true });
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        if (url === '/api/v1/auth/sessions') return jsonResponse({ sessions: [] });
        return jsonResponse({}, 404);
      }),
    );
    renderApp('/oauth/callback');
    await waitFor(() => expect(screen.getByText(/Hồ sơ — learner/)).toBeInTheDocument());
    expect(requestedUrls.some((u) => u.includes('oauth/handoff'))).toBe(false);
    expect(localStorage.getItem('lms.accessToken')).toBeNull();
  });

  it('hiện lỗi và đường về trang đăng nhập khi không có cookie phiên', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/api/v1/auth/get-session')) return jsonResponse(null);
        return jsonResponse({}, 404);
      }),
    );
    renderApp('/oauth/callback');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Không thể hoàn tất đăng nhập'));
    expect(screen.getByRole('button', { name: 'Về trang đăng nhập' })).toBeInTheDocument();
    expect(localStorage.getItem('lms.accessToken')).toBeNull();
  });

  it('hiện lỗi khi phiên tồn tại nhưng không tải được hồ sơ', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/api/v1/auth/get-session')) return jsonResponse(SESSION_BODY);
        if (url === '/api/v1/users/me') {
          return jsonResponse(
            { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'auth.unauthenticated' },
            401,
          );
        }
        return jsonResponse({}, 404);
      }),
    );
    renderApp('/oauth/callback');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Không thể hoàn tất đăng nhập'));
  });
});
