import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { createQueryClient } from '@/lib/query-client';
import { ProfilePage } from './profile';

const PROFILE = {
  id: '01900000-0000-7000-8000-000000000007',
  username: 'learner',
  firstname: 'Learn',
  lastname: 'Er',
  email: 'learner@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastlogin: null,
  timecreated: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

const GOOGLE_LINK = {
  id: '01900000-0000-7000-8000-000000000101',
  issuer: 'google',
  email: 'learner@gmail.example.com',
  createdAt: '2026-10-01T08:00:00.000Z',
};

const CURRENT_SESSION = {
  id: '01900000-0000-7000-8000-000000000201',
  kind: 'web',
  createdAt: '2026-10-23T01:00:00.000Z',
  lastActivityAt: '2026-10-23T06:00:00.000Z',
  ip: '203.0.113.10',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
  current: true,
};
const OTHER_SESSION = {
  id: '01900000-0000-7000-8000-000000000202',
  kind: 'api',
  createdAt: '2026-10-22T01:00:00.000Z',
  lastActivityAt: '2026-10-22T02:00:00.000Z',
  ip: '198.51.100.7',
  userAgent: 'LMS mobile app',
  current: false,
};
const THIRD_SESSION = {
  id: '01900000-0000-7000-8000-000000000203',
  kind: 'web',
  createdAt: '2026-10-21T01:00:00.000Z',
  lastActivityAt: '2026-10-21T02:00:00.000Z',
  ip: null,
  userAgent: null,
  current: false,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function problemResponse(code: string, detail: string, status = 400) {
  return jsonResponse({ type: 'about:blank', title: 'Error', status, detail, code }, status);
}

function renderProfile() {
  localStorage.setItem('lms.accessToken', 'access-1');
  localStorage.setItem('lms.refreshToken', 'refresh-1');
  const router = createMemoryRouter([{ path: '/profile', element: <ProfilePage /> }], {
    initialEntries: ['/profile'],
  });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('Profile page — linked logins and own sessions (fetch mocked at the boundary)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    // Dự án không bật auto-cleanup của Testing Library nên phải dọn
    // DOM tường minh, tránh cây render của test trước sót sang test sau.
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders linked accounts and unlinks one, refreshing the list', async () => {
    let links = [{ ...GOOGLE_LINK }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        if (url === '/api/v1/auth/oauth/links' && (!init?.method || init.method === 'GET')) {
          return jsonResponse({ links, hasPassword: true });
        }
        if (url === `/api/v1/auth/oauth/links/${GOOGLE_LINK.id}` && init?.method === 'DELETE') {
          links = [];
          return jsonResponse({ unlinked: true });
        }
        if (url === '/api/v1/auth/oauth/providers') {
          return jsonResponse({
            providers: [
              { issuer: 'google', enabled: true },
              { issuer: 'facebook', enabled: true },
            ],
          });
        }
        if (url === '/api/v1/auth/sessions') return jsonResponse({ sessions: [] });
        return jsonResponse({}, 404);
      }),
    );
    renderProfile();
    await waitFor(() => expect(screen.getByText('learner@gmail.example.com')).toBeInTheDocument());
    expect(screen.getByText('Google')).toBeInTheDocument();
    // Issuer đã liên kết thì không còn nút liên kết; issuer chưa liên kết thì có.
    expect(screen.queryByRole('button', { name: 'Liên kết Google' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Liên kết Facebook' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Gỡ liên kết' }));
    await waitFor(() => expect(screen.queryByText('learner@gmail.example.com')).not.toBeInTheDocument());
    expect(screen.getByText('Chưa có tài khoản ngoài nào được liên kết.')).toBeInTheDocument();
  });

  it('maps the last-login-method error to its localised message and hints at setting a password', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        if (url === '/api/v1/auth/oauth/links' && (!init?.method || init.method === 'GET')) {
          return jsonResponse({ links: [{ ...GOOGLE_LINK }], hasPassword: false });
        }
        if (url === `/api/v1/auth/oauth/links/${GOOGLE_LINK.id}` && init?.method === 'DELETE') {
          return problemResponse('auth.last_login_method', 'Cannot unlink the last login method');
        }
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        if (url === '/api/v1/auth/sessions') return jsonResponse({ sessions: [] });
        return jsonResponse({}, 404);
      }),
    );
    renderProfile();
    await waitFor(() => expect(screen.getByText('learner@gmail.example.com')).toBeInTheDocument());
    // Tài khoản chưa có mật khẩu: gợi ý đặt mật khẩu hiện sẵn trong thẻ.
    expect(screen.getByText(/chưa có mật khẩu/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Gỡ liên kết' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Đây là cách đăng nhập duy nhất của bạn'));
    // Liên kết vẫn còn vì API đã từ chối.
    expect(screen.getByText('learner@gmail.example.com')).toBeInTheDocument();
  });

  it('renders sessions with the current badge and revokes a single other session', async () => {
    let sessions = [{ ...CURRENT_SESSION }, { ...OTHER_SESSION }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        if (url === '/api/v1/auth/oauth/links') return jsonResponse({ links: [], hasPassword: true });
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        if (url === '/api/v1/auth/sessions' && (!init?.method || init.method === 'GET')) {
          return jsonResponse({ sessions });
        }
        if (url === `/api/v1/auth/sessions/${OTHER_SESSION.id}` && init?.method === 'DELETE') {
          sessions = sessions.filter((s) => s.id !== OTHER_SESSION.id);
          return jsonResponse({ revoked: 1 });
        }
        return jsonResponse({}, 404);
      }),
    );
    renderProfile();
    await waitFor(() => expect(screen.getByText('Hiện tại')).toBeInTheDocument());
    expect(screen.getByText('203.0.113.10')).toBeInTheDocument();
    expect(screen.getByText('198.51.100.7')).toBeInTheDocument();
    // Chỉ phiên khác mới có nút huỷ (phiên hiện tại dùng huy hiệu thay thế).
    const revokeButtons = screen.getAllByRole('button', { name: 'Huỷ phiên' });
    expect(revokeButtons).toHaveLength(1);
    await userEvent.click(revokeButtons[0]);
    await waitFor(() => expect(screen.queryByText('198.51.100.7')).not.toBeInTheDocument());
    expect(screen.getByText('203.0.113.10')).toBeInTheDocument();
  });

  it('revokes all other sessions in one action, keeping only the current one', async () => {
    let sessions = [{ ...CURRENT_SESSION }, { ...OTHER_SESSION }, { ...THIRD_SESSION }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        if (url === '/api/v1/auth/oauth/links') return jsonResponse({ links: [], hasPassword: true });
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        if (url === '/api/v1/auth/sessions' && (!init?.method || init.method === 'GET')) {
          return jsonResponse({ sessions });
        }
        if (url === '/api/v1/auth/sessions/others' && init?.method === 'DELETE') {
          const removed = sessions.filter((s) => !s.current).length;
          sessions = sessions.filter((s) => s.current);
          return jsonResponse({ revoked: removed });
        }
        return jsonResponse({}, 404);
      }),
    );
    renderProfile();
    await waitFor(() => expect(screen.getByText('Hiện tại')).toBeInTheDocument());
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3 phiên
    await userEvent.click(screen.getByRole('button', { name: 'Huỷ mọi phiên khác' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
    expect(screen.getByText('203.0.113.10')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Huỷ mọi phiên khác' })).not.toBeInTheDocument();
  });
});
