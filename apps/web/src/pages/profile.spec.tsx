import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '#lib/auth';
import { baSessionBody, isGetSessionUrl } from '#test/ba-session';
import { createQueryClient } from '#lib/query-client';
import { ProfilePage } from './profile';

/**
 * Trang Hồ sơ sau issue #288: CHỈ còn form thông tin user. Ba thẻ cài
 * đặt từng xếp chồng ở đây (liên kết OAuth, 2FA, phiên) đã chuyển sang
 * khu Cài đặt — spec này gác hai phía của quyết định: form vẫn lưu
 * được như cũ, và trang không còn dựng (cũng không còn GỌI API cho)
 * bất kỳ khối cài đặt nào.
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderProfile() {
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

describe('Profile page — info form only after the Settings split (#288)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders only the user info form — no settings cards, no settings API calls', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (isGetSessionUrl(url)) return jsonResponse(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
        return jsonResponse({}, 404);
      }),
    );
    renderProfile();

    // Form thông tin vẫn là bề mặt duy nhất của trang.
    await waitFor(() => expect(screen.getByLabelText('Tên')).toHaveValue('Learn'));
    expect(screen.getByLabelText('Họ')).toHaveValue('Er');
    expect(screen.getByLabelText('Email')).toHaveValue('learner@example.com');
    expect(screen.getByRole('button', { name: 'Lưu hồ sơ' })).toBeInTheDocument();
    // Ba khối cài đặt đã rời trang: không tiêu đề thẻ nào còn xuất hiện.
    expect(screen.queryByText('Tài khoản liên kết')).not.toBeInTheDocument();
    expect(screen.queryByText('Xác thực hai lớp')).not.toBeInTheDocument();
    expect(screen.queryByText('Phiên đăng nhập')).not.toBeInTheDocument();
    // Và trang không hề gọi các endpoint của những khối đó nữa.
    expect(calls.some((u) => u.includes('/auth/oauth/'))).toBe(false);
    expect(calls.some((u) => u.includes('/auth/mfa/'))).toBe(false);
    expect(calls.some((u) => u.includes('/auth/sessions'))).toBe(false);
  });

  it('still saves edited info through PATCH /users/:id and confirms', async () => {
    let saved: Record<string, unknown> | null = null;
    let current = PROFILE;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (isGetSessionUrl(url)) return jsonResponse(baSessionBody({ id: PROFILE.id, username: PROFILE.username, email: PROFILE.email }));
        if (url === '/api/v1/users/me') return jsonResponse(current);
        if (url === `/api/v1/users/${PROFILE.id}` && init?.method === 'PATCH') {
          saved = JSON.parse(String(init.body)) as Record<string, unknown>;
          // Hồ sơ trả về giữ nguyên dạng thật của API (customFields là
          // MẢNG) — chỉ họ/tên/email đổi theo body vừa lưu.
          current = { ...PROFILE, firstName: saved.firstName as string, lastName: saved.lastName as string, email: saved.email as string };
          return jsonResponse(current);
        }
        return jsonResponse({}, 404);
      }),
    );
    renderProfile();

    const firstName = await screen.findByLabelText('Tên');
    await userEvent.clear(firstName);
    await userEvent.type(firstName, 'Minh');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu hồ sơ' }));

    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved).toMatchObject({ firstName: 'Minh', lastName: 'Er', email: 'learner@example.com' });
    expect(await screen.findByText('Đã lưu hồ sơ')).toBeInTheDocument();
  });
});
