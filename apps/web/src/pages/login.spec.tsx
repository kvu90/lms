import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redirectToExternalUrl } from '#lib/api';
import { AuthProvider } from '#lib/auth';
import { createQueryClient } from '#lib/query-client';
import { LoginPage } from './login';
import { ProfilePage } from './profile';

// Chỉ thay biên điều hướng ra ngoài (jsdom khoá cứng window.location
// nên không quan sát được việc gán href); mọi hàm API còn lại giữ
// nguyên bản thật để test vẫn đi qua hợp đồng fetch như thường.
vi.mock('#lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('#lib/api')>();
  return { ...original, redirectToExternalUrl: vi.fn() };
});

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

describe('Login flow (real API contract shapes, fetch mocked at the boundary)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    // Dự án không bật auto-cleanup của Testing Library nên phải dọn
    // DOM tường minh, tránh cây render của test trước sót sang test sau.
    cleanup();
    vi.unstubAllGlobals();
  });

  it('signs in, stores tokens, navigates to the profile and renders custom fields', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/token') {
        return new Response(
          JSON.stringify({
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            expiresIn: 900,
            user: { id: '01900000-0000-7000-8000-000000000007', username: 'learner', forcePasswordChange: false },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/api/v1/users/me') {
        return new Response(JSON.stringify(PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
      void init;
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'learner');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'Passw0rd!');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    await waitFor(() => expect(screen.getByText(/Hồ sơ — learner/)).toBeInTheDocument());
    expect(localStorage.getItem('lms.accessToken')).toBe('access-1');
    expect(localStorage.getItem('lms.refreshToken')).toBe('refresh-1');
    expect(screen.getByLabelText(/Department/)).toHaveValue('Sales');
  });

  it('shows the Problem Details message when credentials are rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'about:blank',
              title: 'Unauthorized',
              status: 401,
              detail: 'Invalid username or password',
              code: 'auth.invalid_credentials',
            }),
            { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
          ),
      ),
    );
    renderApp();
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'learner');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid username or password'));
    expect(localStorage.getItem('lms.accessToken')).toBeNull();
  });

  it('refresh: an expired access token is transparently refreshed once and the request retried', async () => {
    localStorage.setItem('lms.accessToken', 'expired');
    localStorage.setItem('lms.refreshToken', 'refresh-old');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === '/api/v1/auth/refresh') {
          return new Response(JSON.stringify({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === '/api/v1/users/me') {
          const auth = calls.filter((c) => c === '/api/v1/users/me').length;
          if (auth === 1)
            return new Response(
              JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401, code: 'auth.unauthenticated' }),
              { status: 401 },
            );
          return new Response(JSON.stringify(PROFILE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    renderApp();
    await waitFor(() => expect(localStorage.getItem('lms.accessToken')).toBe('access-2'));
    expect(calls.filter((c) => c === '/api/v1/auth/refresh')).toHaveLength(1);
  });

  it('MFA: a challenge response switches to the TOTP step, and verifying the code completes sign-in', async () => {
    const verifyBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/v1/auth/oauth/providers') {
          return new Response(JSON.stringify({ providers: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === '/api/v1/auth/token') {
          return new Response(
            JSON.stringify({
              mfaRequired: true,
              challengeToken: 'challenge-1',
              user: { id: '01900000-0000-7000-8000-000000000007', username: 'learner' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === '/api/v1/auth/mfa/verify') {
          verifyBodies.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({
              accessToken: 'access-mfa',
              refreshToken: 'refresh-mfa',
              expiresIn: 900,
              user: { id: '01900000-0000-7000-8000-000000000007', username: 'learner', forcePasswordChange: false },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === '/api/v1/users/me') {
          return new Response(JSON.stringify(PROFILE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    renderApp();
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'learner');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'Passw0rd!');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    // Bước thách thức: chưa có token nào được lưu, form nhập mã hiện ra.
    await waitFor(() => expect(screen.getByLabelText('Mã xác thực')).toBeInTheDocument());
    expect(localStorage.getItem('lms.accessToken')).toBeNull();
    await userEvent.type(screen.getByLabelText('Mã xác thực'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Xác thực' }));
    await waitFor(() => expect(screen.getByText(/Hồ sơ — learner/)).toBeInTheDocument());
    expect(verifyBodies).toEqual([{ challengeToken: 'challenge-1', code: '123456' }]);
    expect(localStorage.getItem('lms.accessToken')).toBe('access-mfa');
  });

  it('OAuth: only enabled issuers get a button, and clicking it navigates to the authorize URL', async () => {
    vi.mocked(redirectToExternalUrl).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/auth/oauth/providers') {
          return new Response(
            JSON.stringify({
              providers: [
                { issuer: 'google', enabled: true },
                { issuer: 'facebook', enabled: false },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url === '/api/v1/auth/oauth/google/authorize') {
          return new Response(JSON.stringify({ authorizeUrl: 'https://accounts.example.test/oauth2/auth' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    renderApp();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Đăng nhập bằng Google' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Đăng nhập bằng Facebook' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập bằng Google' }));
    await waitFor(() =>
      expect(redirectToExternalUrl).toHaveBeenCalledWith('https://accounts.example.test/oauth2/auth'),
    );
  });

  it('OAuth: an oauthError code in the URL is shown as a localised message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/auth/oauth/providers') {
          return new Response(JSON.stringify({ providers: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    renderApp('/login?oauthError=auth.oauth_email_missing');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Nhà cung cấp không trả về email'));
  });
});
