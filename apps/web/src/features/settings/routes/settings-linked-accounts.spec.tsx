import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { createQueryClient } from '#lib/query-client';
import { SettingsLinkedAccountsPage } from './settings-linked-accounts';

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

function renderPage() {
  const router = createMemoryRouter([{ path: '/settings/linked-accounts', element: <SettingsLinkedAccountsPage /> }], {
    initialEntries: ['/settings/linked-accounts'],
  });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Cài đặt — trang tài khoản liên kết (thẻ chuyển từ Hồ sơ, issue #288)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    // Dự án không bật auto-cleanup của Testing Library nên phải dọn
    // DOM tường minh, tránh cây render của test trước sót sang test sau.
    cleanup();
    vi.unstubAllGlobals();
  });

  it('render tài khoản liên kết và huỷ liên kết một tài khoản, làm mới danh sách', async () => {
    let links = [{ ...GOOGLE_LINK }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (isGetSessionUrl(url)) return jsonResponse(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
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
        if (url === '/api/v1/auth/mfa/status') return jsonResponse({ enabled: false });
        if (url === '/api/v1/auth/sessions') return jsonResponse({ sessions: [] });
        return jsonResponse({}, 404);
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText('learner@gmail.example.com')).toBeInTheDocument());
    expect(screen.getByText('Google')).toBeInTheDocument();
    // Issuer đã liên kết thì không còn nút liên kết; issuer chưa liên kết thì có.
    expect(screen.queryByRole('button', { name: 'Liên kết Google' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Liên kết Facebook' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Gỡ liên kết' }));
    await waitFor(() => expect(screen.queryByText('learner@gmail.example.com')).not.toBeInTheDocument());
    expect(screen.getByText('Chưa có tài khoản ngoài nào được liên kết.')).toBeInTheDocument();
  });

  it('ánh xạ lỗi phương thức đăng nhập cuối sang thông báo đã bản địa hoá và gợi ý đặt mật khẩu', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (isGetSessionUrl(url)) return jsonResponse(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        if (url === '/api/v1/auth/oauth/links' && (!init?.method || init.method === 'GET')) {
          return jsonResponse({ links: [{ ...GOOGLE_LINK }], hasPassword: false });
        }
        if (url === `/api/v1/auth/oauth/links/${GOOGLE_LINK.id}` && init?.method === 'DELETE') {
          return problemResponse('auth.last_login_method', 'Cannot unlink the last login method');
        }
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        if (url === '/api/v1/auth/mfa/status') return jsonResponse({ enabled: false });
        if (url === '/api/v1/auth/sessions') return jsonResponse({ sessions: [] });
        return jsonResponse({}, 404);
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText('learner@gmail.example.com')).toBeInTheDocument());
    // Tài khoản chưa có mật khẩu: gợi ý đặt mật khẩu hiện sẵn trong thẻ.
    expect(screen.getByText(/chưa có mật khẩu/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Gỡ liên kết' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Đây là cách đăng nhập duy nhất của bạn'));
    // Liên kết vẫn còn vì API đã từ chối.
    expect(screen.getByText('learner@gmail.example.com')).toBeInTheDocument();
  });
});
