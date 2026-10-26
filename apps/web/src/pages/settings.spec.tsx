import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '#lib/query-client';
import { SettingsIndexPage } from './settings-index';
import { SettingsLinkedAccountsPage } from './settings-linked-accounts';
import { SettingsNotificationsPage } from './settings-notifications';
import { SettingsSecurityPage } from './settings-security';

/**
 * Khu Cài đặt (issue #288): khung dùng chung có MENU TRÁI theo mục,
 * `/settings` redirect về mục đầu (Bảo mật), bấm mục nào thì nội dung
 * mục đó hiện ở cột phải và dấu chọn (aria-current) đi theo. Spec này
 * dựng đúng bốn route module của khu và đi lại như người dùng.
 */
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/v1/auth/mfa/status') return jsonResponse({ enabled: false });
      if (url === '/api/v1/auth/sessions') return jsonResponse({ sessions: [] });
      if (url === '/api/v1/auth/oauth/links') return jsonResponse({ links: [], hasPassword: true });
      if (url === '/api/v1/auth/oauth/providers') return jsonResponse({ providers: [] });
      if (url === '/api/v1/messages/preferences') return jsonResponse([]);
      if (url === '/api/v1/messages/preferences/courses') return jsonResponse({ courses: [] });
      return jsonResponse({}, 404);
    }),
  );
}

function renderSettings(initialEntry: string) {
  const router = createMemoryRouter(
    [
      { path: '/settings', element: <SettingsIndexPage /> },
      { path: '/settings/security', element: <SettingsSecurityPage /> },
      { path: '/settings/linked-accounts', element: <SettingsLinkedAccountsPage /> },
      { path: '/settings/notifications', element: <SettingsNotificationsPage /> },
    ],
    { initialEntries: [initialEntry] },
  );
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Settings area — left menu, section routes, root redirect (#288)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('/settings redirects to the first section (Security) with the menu marking it current', async () => {
    stubFetch();
    renderSettings('/settings');

    // Đích redirect: thẻ 2FA của mục Bảo mật hiện ra.
    expect(await screen.findByText('Xác thực hai lớp')).toBeInTheDocument();
    const securityLink = screen.getByRole('link', { name: /Bảo mật & đăng nhập/ });
    expect(securityLink).toHaveAttribute('aria-current', 'page');
    expect(securityLink).toHaveAttribute('href', '/settings/security');
  });

  it('left menu switches sections: content follows and aria-current moves', async () => {
    stubFetch();
    renderSettings('/settings/security');
    expect(await screen.findByText('Xác thực hai lớp')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: /Tài khoản liên kết/ }));
    expect(await screen.findByText('Chưa có tài khoản ngoài nào được liên kết.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Tài khoản liên kết/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('Xác thực hai lớp')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: /^Thông báo$/ }));
    expect(await screen.findByText('Tuỳ chọn thông báo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Thông báo$/ })).toHaveAttribute('aria-current', 'page');
  });
});
