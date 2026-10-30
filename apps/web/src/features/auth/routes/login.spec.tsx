import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '#lib/auth';
import { createQueryClient } from '#lib/query-client';
import { baSessionBody } from '#test/ba-session';
import { LoginPage } from './login';
import { ProfilePage } from '#features/profile/routes/profile';

/**
 * Bộ test luồng đăng nhập sau cutover phiên cookie (issue #7, GĐ2):
 * mọi lời gọi đi qua fetch thật bị stub ở biên, theo ĐÚNG hợp đồng
 * REST của Better Auth — client BA dựng URL tuyệt đối từ origin
 * (`http://localhost:3000` của jsdom) với basePath `/api/v1/auth`.
 * Phiên sống trong cookie do trình duyệt giữ — web KHÔNG còn token
 * nào ở localStorage, các assertion kiểm đúng điều đó. Stub
 * `get-session` là stateful: trước đăng nhập trả null, sau khi một
 * đường đăng nhập thành công thì trả phiên, mô phỏng cookie đã được
 * server đặt.
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
  customFields: [{ shortName: 'department', name: 'Department', type: 'select', value: 'Sales' }],
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Phân loại URL mà các stub dùng chung quan tâm; URL của client BA là tuyệt đối, URL của apiFetch là tương đối. */
function urlOf(input: unknown): string {
  return String(input);
}

function renderApp(initialEntry = '/login') {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage /> },
      { path: '/profile', element: <ProfilePage /> },
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

describe('Luồng đăng nhập (hợp đồng cookie Better Auth, fetch mock tại biên)', () => {
  afterEach(() => {
    // Dự án không bật auto-cleanup của Testing Library nên phải dọn
    // DOM tường minh, tránh cây render của test trước sót sang test sau.
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('đăng nhập qua endpoint username, không giữ token nào trong localStorage, và tới trang hồ sơ', async () => {
    let signedIn = false;
    const signInBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.endsWith('/api/v1/auth/get-session')) {
        return signedIn ? jsonResponse(SESSION_BODY) : jsonResponse(null);
      }
      if (url.endsWith('/api/v1/auth/sign-in/username')) {
        signInBodies.push(JSON.parse(String(init?.body)));
        signedIn = true;
        return jsonResponse({ redirect: false, token: 'session-token', user: SESSION_BODY.user });
      }
      if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
      if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'learner');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'Passw0rd!');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    await waitFor(() => expect(screen.getByText(/Hồ sơ — learner/)).toBeInTheDocument());
    expect(signInBodies).toEqual([{ username: 'learner', password: 'Passw0rd!' }]);
    expect(localStorage.getItem('lms.accessToken')).toBeNull();
    expect(localStorage.getItem('lms.refreshToken')).toBeNull();
    expect(screen.getByLabelText(/Department/)).toHaveValue('Sales');
  });

  it('hiện thông báo của server khi thông tin đăng nhập bị từ chối', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = urlOf(input);
        if (url.endsWith('/api/v1/auth/get-session')) return jsonResponse(null);
        if (url.endsWith('/api/v1/auth/sign-in/username')) {
          return jsonResponse({ code: 'INVALID_USERNAME_OR_PASSWORD', message: 'Invalid username or password' }, 401);
        }
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        return jsonResponse({}, 404);
      }),
    );
    renderApp();
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'learner');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid username or password'));
    expect(localStorage.getItem('lms.accessToken')).toBeNull();
  });

  it('phân giải phiên cookie sẵn có thẳng vào hồ sơ mà không cần vòng đăng nhập', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = urlOf(input);
        requestedUrls.push(url);
        if (url.endsWith('/api/v1/auth/get-session')) return jsonResponse(SESSION_BODY);
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        if (url === '/api/v1/auth/oauth/links') return jsonResponse({ links: [], hasPassword: true });
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        if (url === '/api/v1/auth/sessions') return jsonResponse({ sessions: [] });
        return jsonResponse({}, 404);
      }),
    );
    renderApp('/profile');
    await waitFor(() => expect(screen.getByText(/Hồ sơ — learner/)).toBeInTheDocument());
    expect(requestedUrls.some((u) => u.endsWith('/api/v1/auth/sign-in/username'))).toBe(false);
  });

  it('MFA: phản hồi twoFactorRedirect chuyển sang bước mã, và xác minh TOTP hoàn tất đăng nhập', async () => {
    let signedIn = false;
    const verifyBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith('/api/v1/auth/get-session')) {
          return signedIn ? jsonResponse(SESSION_BODY) : jsonResponse(null);
        }
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        if (url.endsWith('/api/v1/auth/sign-in/username')) {
          // Chưa có phiên nào: đáp ứng chỉ mang cờ chuyển bước hai lớp.
          return jsonResponse({ twoFactorRedirect: true });
        }
        if (url.endsWith('/api/v1/auth/two-factor/verify-totp')) {
          verifyBodies.push(JSON.parse(String(init?.body)));
          signedIn = true;
          return jsonResponse({ token: 'session-token', user: SESSION_BODY.user });
        }
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        return jsonResponse({}, 404);
      }),
    );
    renderApp();
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'learner');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'Passw0rd!');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    // Bước hai: form nhập mã hiện ra và vẫn chưa có phiên/token nào.
    await waitFor(() => expect(screen.getByLabelText('Mã xác thực')).toBeInTheDocument());
    expect(localStorage.getItem('lms.accessToken')).toBeNull();
    await userEvent.type(screen.getByLabelText('Mã xác thực'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Xác thực' }));
    await waitFor(() => expect(screen.getByText(/Hồ sơ — learner/)).toBeInTheDocument());
    // Hợp đồng BA: verify chỉ gửi mã — không còn challengeToken tự chế.
    expect(verifyBodies).toEqual([{ code: '123456' }]);
  });

  it('OTP email: yêu cầu mã rồi nhập mã sẽ hoàn tất đăng nhập', async () => {
    let signedIn = false;
    const sendBodies: unknown[] = [];
    const verifyBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith('/api/v1/auth/get-session')) {
          return signedIn ? jsonResponse(SESSION_BODY) : jsonResponse(null);
        }
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        if (url.endsWith('/api/v1/auth/email-otp/send-verification-otp')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({ success: true });
        }
        if (url.endsWith('/api/v1/auth/sign-in/email-otp')) {
          verifyBodies.push(JSON.parse(String(init?.body)));
          signedIn = true;
          return jsonResponse({ token: 'session-token', user: SESSION_BODY.user });
        }
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        return jsonResponse({}, 404);
      }),
    );
    renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập bằng mã qua email' }));
    await userEvent.type(screen.getByLabelText('Email'), 'learner@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi mã' }));
    await waitFor(() => expect(screen.getByLabelText('Mã OTP 6 số')).toBeInTheDocument());
    expect(screen.getByText(/Mã đã được gửi tới learner@example.com/)).toBeInTheDocument();
    expect(sendBodies).toEqual([{ email: 'learner@example.com', type: 'sign-in' }]);
    await userEvent.type(screen.getByLabelText('Mã OTP 6 số'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập bằng mã' }));
    await waitFor(() => expect(screen.getByText(/Hồ sơ — learner/)).toBeInTheDocument());
    expect(verifyBodies).toEqual([{ email: 'learner@example.com', otp: '654321' }]);
  });

  it('OAuth: chỉ issuer đã bật mới có nút, và bấm nút bắt đầu luồng social Better Auth', async () => {
    const socialBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith('/api/v1/auth/get-session')) return jsonResponse(null);
        if (url === '/api/v1/auth/oauth/providers') {
          return jsonResponse({
            providers: [
              { issuer: 'google', enabled: true },
              { issuer: 'facebook', enabled: false },
            ],
          });
        }
        if (url.endsWith('/api/v1/auth/sign-in/social')) {
          socialBodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({ redirect: true, url: 'https://accounts.example.test/oauth2/auth' });
        }
        return jsonResponse({}, 404);
      }),
    );
    renderApp();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Đăng nhập bằng Google' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Đăng nhập bằng Facebook' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập bằng Google' }));
    await waitFor(() => expect(socialBodies).toHaveLength(1));
    expect(socialBodies[0]).toMatchObject({ provider: 'google', callbackURL: '/oauth/callback' });
  });

  it('OAuth: mã oauthError trong URL hiện thành thông báo đã bản địa hoá', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = urlOf(input);
        if (url.endsWith('/api/v1/auth/get-session')) return jsonResponse(null);
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        return jsonResponse({}, 404);
      }),
    );
    renderApp('/login?oauthError=auth.oauth_email_missing');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Nhà cung cấp không trả về email'));
  });
});
