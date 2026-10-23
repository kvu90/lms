import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from '../root';
import Shell from '../routes/shell';
import { queryClient } from '../lib/query-client';

/**
 * Test cho số thông báo chưa đọc ở mục Thông báo trên sidebar (thay
 * chuông thông báo ở site-header đã gỡ theo lệnh Lão gia): số chưa đọc
 * lấy từ GET /notifications/unread-count — lớn hơn 0 thì hiện huy hiệu
 * số đếm cạnh nhãn mục Thông báo, bằng 0 thì không hiện; header không
 * còn nút chuông nào và vẫn không có bộ chọn ngôn ngữ. Dựng đúng cây
 * thật (App → Shell → AppSidebar + SiteHeader) như nav-user.spec, stub
 * fetch theo từng URL.
 */

const ADMIN_ID = '01900000-0000-7000-8000-0000000000a1';

const PROFILE = {
  id: ADMIN_ID,
  username: 'admin',
  firstname: 'Quản',
  lastname: 'Trị',
  email: 'admin@example.com',
  suspended: false,
  deleted: false,
  isGuest: false,
  forcePasswordChange: false,
  lastlogin: null,
  timecreated: '2026-01-01T00:00:00.000Z',
  customFields: [],
};

const ACCESS = { userId: ADMIN_ID, isSiteAdmin: true, assignments: [], contexts: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(unread: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/v1/users/me') return jsonResponse(PROFILE);
      if (url === '/api/v1/users/me/capabilities') return jsonResponse(ACCESS);
      if (url === '/api/v1/courses') return jsonResponse([]);
      if (url === '/api/v1/notifications/unread-count') return jsonResponse({ unread });
      if (url === '/api/v1/auth/refresh') return jsonResponse({}, 401);
      return jsonResponse({}, 404);
    }),
  );
}

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        element: <App />,
        children: [
          {
            element: <Shell />,
            children: [
              { index: true, element: <div data-testid="home-probe" /> },
              { path: 'notifications', element: <div data-testid="notifications-probe" /> },
            ],
          },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  queryClient.clear();
});

describe('số thông báo chưa đọc trên sidebar', () => {
  it('hiện huy hiệu đúng số chưa đọc cạnh mục Thông báo khi còn tin chưa đọc', async () => {
    localStorage.setItem('lms.accessToken', 'access-test');
    localStorage.setItem('lms.refreshToken', 'refresh-test');
    stubFetch(3);
    renderShell();

    const item = await screen.findByRole('link', { name: /Thông báo/ });
    // Huy hiệu nằm trong chính mục điều hướng và mang đúng số từ API.
    expect(await within(item).findByText('3')).toBeInTheDocument();
  });

  it('không hiện huy hiệu khi không còn thông báo chưa đọc', async () => {
    localStorage.setItem('lms.accessToken', 'access-test');
    localStorage.setItem('lms.refreshToken', 'refresh-test');
    stubFetch(0);
    renderShell();

    const item = await screen.findByRole('link', { name: 'Thông báo' });
    // Mục vẫn điều hướng bình thường, nhãn trơn không kèm số đếm nào.
    expect(item).toHaveAttribute('href', '/notifications');
    expect(item.textContent?.trim()).toBe('Thông báo');
  });

  it('header không còn nút chuông và không có bộ chọn ngôn ngữ', async () => {
    localStorage.setItem('lms.accessToken', 'access-test');
    localStorage.setItem('lms.refreshToken', 'refresh-test');
    stubFetch(3);
    renderShell();

    // Sidebar đã vẽ (mục Thông báo kèm số) nhưng không tồn tại nút
    // chuông nào — trước đây chuông là button mang nhãn "Thông báo".
    await screen.findByRole('link', { name: /Thông báo/ });
    expect(screen.queryByRole('button', { name: 'Thông báo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
