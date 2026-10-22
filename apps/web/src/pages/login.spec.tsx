import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { LoginPage } from './login';
import { ProfilePage } from './profile';

const PROFILE = {
  id: 7, username: 'learner', firstname: 'Learn', lastname: 'Er', email: 'learner@example.com',
  suspended: false, deleted: false, isGuest: false, forcePasswordChange: false,
  lastlogin: null, timecreated: '2026-01-01T00:00:00.000Z',
  customFields: [{ shortname: 'department', name: 'Department', type: 'select', value: 'Sales' }],
};

function renderApp() {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage /> },
      { path: '/profile', element: <ProfilePage /> },
    ],
    { initialEntries: ['/login'] },
  );
  return render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
}

describe('Login flow (real API contract shapes, fetch mocked at the boundary)', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('signs in, stores tokens, navigates to the profile and renders custom fields', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/token') {
        return new Response(JSON.stringify({
          accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 900,
          user: { id: 7, username: 'learner', forcePasswordChange: false },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Invalid username or password', code: 'auth.invalid_credentials',
    }), { status: 401, headers: { 'Content-Type': 'application/problem+json' } })));
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
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/v1/auth/refresh') {
        return new Response(JSON.stringify({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/v1/users/me') {
        const auth = calls.filter((c) => c === '/api/v1/users/me').length;
        if (auth === 1) return new Response(JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401, code: 'auth.unauthenticated' }), { status: 401 });
        return new Response(JSON.stringify(PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }));
    renderApp();
    await waitFor(() => expect(localStorage.getItem('lms.accessToken')).toBe('access-2'));
    expect(calls.filter((c) => c === '/api/v1/auth/refresh')).toHaveLength(1);
  });
});
