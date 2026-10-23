import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { createQueryClient } from '@/lib/query-client';
import { OAuthCallbackPage } from './oauth-callback';
import { ProfilePage } from './profile';

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

describe('OAuth callback page (handoff exchange, fetch mocked at the boundary)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    // Dự án không bật auto-cleanup của Testing Library nên phải dọn
    // DOM tường minh, tránh cây render của test trước sót sang test sau.
    cleanup();
    vi.unstubAllGlobals();
  });

  it('exchanges the handoff code for tokens and lands on the profile', async () => {
    const handoffBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/v1/auth/oauth/handoff') {
          handoffBodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({
            accessToken: 'access-oauth',
            refreshToken: 'refresh-oauth',
            expiresIn: 900,
            user: { id: PROFILE.id, username: 'learner', forcePasswordChange: false },
          });
        }
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        if (url === '/api/v1/auth/oauth/links') return jsonResponse({ links: [], hasPassword: true });
        if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
        if (url === '/api/v1/auth/sessions') return jsonResponse({ sessions: [] });
        return jsonResponse({}, 404);
      }),
    );
    renderApp('/oauth/callback?handoff=code-123');
    await waitFor(() => expect(screen.getByText(/Hồ sơ — learner/)).toBeInTheDocument());
    expect(handoffBodies).toEqual([{ code: 'code-123' }]);
    expect(localStorage.getItem('lms.accessToken')).toBe('access-oauth');
  });

  it('shows an error and a way back to login when the handoff code is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/auth/oauth/handoff') {
          return jsonResponse(
            {
              type: 'about:blank',
              title: 'Bad Request',
              status: 400,
              detail: 'Handoff code is invalid or expired',
              code: 'auth.oauth_handoff_invalid',
            },
            400,
          );
        }
        return jsonResponse({}, 404);
      }),
    );
    renderApp('/oauth/callback?handoff=stale-code');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Không thể hoàn tất đăng nhập'));
    expect(screen.getByRole('button', { name: 'Về trang đăng nhập' })).toBeInTheDocument();
    expect(localStorage.getItem('lms.accessToken')).toBeNull();
  });

  it('shows the same error when the handoff code is missing from the URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 404)),
    );
    renderApp('/oauth/callback');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Không thể hoàn tất đăng nhập'));
  });
});
